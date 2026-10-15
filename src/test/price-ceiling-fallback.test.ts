import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { buildRateCard, computeRateCardCost, priceAtProviderReport, type RateCardV1 } from "../billing-rate-card.js";
import { proxyLlmRequest } from "../openrouter.js";
import { isPriceCeilingRefusal, withPriceCeilingFallback } from "../openrouter-fallback.js";
import { type ProxyAssistantMessageEvent, ZERO_USAGE } from "../wire-protocol.js";
import {
	inferenceOperationId,
	isTerminalResponse,
	type LlmProxy,
	runInference,
	seedPricedSession,
	waitForBillingEvent,
	withPricingHarness,
} from "./chat-pricing-fixture.js";
import { fullRow } from "./fixtures/openrouter-catalogue.fixture.js";

/**
 * Vera's ruling of 2026-10-01 for the call OpenRouter cannot serve at or under the card ("dearer one, bill actual"): the
 * call is retried once without the price ceiling (the card's quantization rule kept), and settled at what OpenRouter
 * reports it charged for that generation, with the card's figure kept beside it; a normal call is still settled at the
 * card. The chip a person sees is the debit in both cases ("what we charge"): it is read from the settlement.
 *
 * OpenRouter's refusal, as Pi words it: the SDK's "404 No endpoints found that satisfy the max price for this request"
 * (or "... with quantization: fp8,..." when a quantization rule is also in force), before any part of a reply. What it
 * charged: the final SSE chunk's `usage.cost`, which on 2026-10-01 equalled its own generation record's `total_cost`
 * for 276 of 276 calls (to a nanodollar). Pi discards that field, so the retry runs through a loopback tap that passes
 * every byte to Pi unchanged and keeps the last usage chunk.
 */

const CATALOGUE = { digest: "0123456789abcdef".repeat(4), fetchedAt: "2026-09-29T20:00:00.000Z" };
const NO_ENDPOINTS = "404 No endpoints found that satisfy the max price for this request";

function cardFor(id: string): RateCardV1 {
	const built = buildRateCard({ model: id, pricing: fullRow(id).pricing_raw, catalogue: CATALOGUE, markupBps: 1500 });
	assert.ok(built.ok, `${id} builds a card`);
	return built.card;
}

async function collect(stream: AsyncIterable<ProxyAssistantMessageEvent>): Promise<ProxyAssistantMessageEvent[]> {
	const events: ProxyAssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

async function* streamOf(events: ProxyAssistantMessageEvent[]): AsyncGenerator<ProxyAssistantMessageEvent> {
	for (const event of events) yield event;
}

const refusal = (message: string): ProxyAssistantMessageEvent => ({
	type: "error",
	reason: "error",
	errorMessage: message,
	usage: ZERO_USAGE,
});
const done = (extra: Record<string, unknown> = {}): ProxyAssistantMessageEvent =>
	({
		type: "done",
		reason: "stop",
		usage: { ...ZERO_USAGE, input: 100, output: 10, totalTokens: 110 },
		...extra,
	}) as ProxyAssistantMessageEvent;

describe("the refusal that earns a retry", () => {
	it("is OpenRouter's no-endpoint answer, with or without a quantization rule, and nothing else", () => {
		assert.equal(isPriceCeilingRefusal(refusal(NO_ENDPOINTS)), true);
		assert.equal(
			isPriceCeilingRefusal(
				refusal("404 No endpoints found for the request with quantization: fp8,fp16,bf16,fp32. To learn more"),
			),
			true,
		);
		// A call that asks for tool-capable endpoints only (require_parameters, DESIGN-empowered-chat §11.3) and finds none
		// is refused for its parameters, not its price: dropping the ceiling would not change the answer, so no retry.
		assert.equal(
			isPriceCeilingRefusal(
				refusal(
					"404 No endpoints found that can handle the requested parameters. To learn more about provider routing, visit: https://openrouter.ai/docs/provider-routing",
				),
			),
			false,
		);
		assert.equal(isPriceCeilingRefusal(refusal("429 Provider returned error")), false);
		assert.equal(isPriceCeilingRefusal(refusal("500 boom")), false);
		assert.equal(isPriceCeilingRefusal(done()), false);
	});
});

describe("withPriceCeilingFallback", () => {
	it("discards the refusal and yields the retry's events, once", async () => {
		let retries = 0;
		const events = await collect(
			withPriceCeilingFallback(streamOf([refusal(NO_ENDPOINTS)]), () => {
				retries++;
				return streamOf([
					{ type: "start" },
					done({ providerUsage: { costUsd: 0.000002, generationId: "gen-1", provider: "StreamLake" } }),
				]);
			}),
		);
		assert.equal(retries, 1);
		assert.deepEqual(
			events.map((event) => event.type),
			["start", "done"],
		);
	});

	it("passes a reply through untouched, and any other error as it came", async () => {
		let retries = 0;
		const retry = () => {
			retries++;
			return streamOf([done()]);
		};
		assert.deepEqual(
			(await collect(withPriceCeilingFallback(streamOf([{ type: "start" }, done()]), retry))).map((e) => e.type),
			["start", "done"],
		);
		const other = await collect(withPriceCeilingFallback(streamOf([refusal("500 boom")]), retry));
		assert.equal(other.length, 1);
		assert.equal((other[0] as { errorMessage?: string }).errorMessage, "500 boom");
		assert.equal(retries, 0);
	});

	it("never retries a retry: a second refusal is the call's answer", async () => {
		const events = await collect(
			withPriceCeilingFallback(streamOf([refusal(NO_ENDPOINTS)]), () => streamOf([refusal(NO_ENDPOINTS)])),
		);
		assert.equal(events.length, 1);
		assert.equal(events[0].type, "error");
	});
});

describe("the usage tap a fallback call runs through", () => {
	it("hands Pi every byte, and the host OpenRouter's own charge, generation id and provider", async () => {
		let body = "";
		let authorization = "";
		const server = createServer((request: IncomingMessage, response) => {
			authorization = String(request.headers.authorization ?? "");
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				body = Buffer.concat(chunks).toString("utf8");
				response.writeHead(200, {
					"content-type": "text/event-stream",
					"x-generation-id": "gen-1790900040-nKQ0OYSuM5DU0SGXzGsZ",
				});
				const send = (value: Record<string, unknown>) => response.write(`data: ${JSON.stringify(value)}\n\n`);
				const base = {
					id: "gen-1790900040-nKQ0OYSuM5DU0SGXzGsZ",
					provider: "StreamLake",
					model: "moonshotai/kimi-k2.6",
					object: "chat.completion.chunk",
					created: 1,
				};
				send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] });
				send({ ...base, choices: [{ index: 0, delta: { content: " there." } }] });
				send({
					...base,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: {
						prompt_tokens: 11,
						completion_tokens: 55,
						total_tokens: 66,
						cost: 0.0001451835,
						prompt_tokens_details: { cached_tokens: 0 },
					},
				});
				response.end("data: [DONE]\n\n");
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		try {
			const events = await collect(
				proxyLlmRequest(
					{
						id: "moonshotai/kimi-k2.6",
						name: "MoonshotAI: Kimi K2.6",
						api: "openai-completions",
						provider: "openrouter",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 262_144,
						maxTokens: 64,
						baseUrl: `http://127.0.0.1:${port}/api/v1`,
						compat: { openRouterRouting: { sort: "price", quantizations: ["fp8", "fp16", "bf16", "fp32"] } },
					},
					{
						systemPrompt: "You are a test.",
						messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
					},
					{ apiKey: "or-test-key", tapUsage: true },
				),
			);
			const text = events.flatMap((event) => (event.type === "text_delta" ? [event.delta] : [])).join("");
			assert.equal(text, "Hello there.", "Pi parsed the stream the tap passed through");
			const terminal = events.find((event) => event.type === "done") as
				| { providerUsage?: unknown; responseId?: string }
				| undefined;
			assert.ok(terminal);
			assert.deepEqual(terminal.providerUsage, {
				costUsd: 0.0001451835,
				generationId: "gen-1790900040-nKQ0OYSuM5DU0SGXzGsZ",
				provider: "StreamLake",
			});
			assert.equal(authorization, "Bearer or-test-key", "the request reached OpenRouter with its key");
			assert.deepEqual(
				JSON.parse(body).provider,
				{ sort: "price", quantizations: ["fp8", "fp16", "bf16", "fp32"] },
				"and its routing, unchanged",
			);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});

describe("billing what OpenRouter reports", () => {
	it("prices the provider's charge with the card's fee, itemized like the card, to the micro-dollar", () => {
		const card = cardFor("moonshotai/kimi-k2.5");
		const atCard = computeRateCardCost(card, { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 });
		const actual = priceAtProviderReport(atCard, 1235, 1500);
		assert.equal(actual.providerCostMicroUsd, 1235);
		assert.equal(actual.markupMicroUsd, 186, "15% of 1,235 is 185.25, rounded up");
		assert.equal(actual.totalCostMicroUsd, 1421);
		assert.equal(
			actual.inputCostMicroUsd +
				actual.outputCostMicroUsd +
				actual.cacheReadCostMicroUsd +
				actual.cacheWriteCostMicroUsd,
			1235,
			"the parts add up to what OpenRouter charged",
		);
		assert.ok(actual.inputCostMicroUsd > 0 && actual.outputCostMicroUsd > 0, "split in the card's proportions");
	});
});

/** The settled cost a person's chip shows: the SPA reads it from `budget.ledger_updated` (`inference_settled`). */
function settledCosts(events: ReadonlyArray<{ type: string; payload: unknown }>): number[] {
	return events.flatMap((event) => {
		if (event.type !== "budget.ledger_updated") return [];
		const payload = (event.payload ?? {}) as Record<string, unknown>;
		const source = (typeof payload.kind === "string" ? payload : (payload.value ?? {})) as Record<string, unknown>;
		if (source.kind !== "inference_settled") return [];
		const cost = ((source.spentDelta ?? {}) as Record<string, unknown>).costUsdMicros;
		return typeof cost === "number" ? [cost] : [];
	});
}

describe("a Session's call that falls back", () => {
	it("is retried once without the ceiling and settled at OpenRouter's charge plus the fee; the chip is that debit", async () => {
		const card = cardFor("moonshotai/kimi-k2.5");
		const seen: Array<{ routing: unknown; tap: boolean }> = [];
		const proxy: LlmProxy = async function* (model, _context, options) {
			const routing = (model as { compat?: { openRouterRouting?: unknown } }).compat?.openRouterRouting;
			seen.push({ routing, tap: (options as { tapUsage?: boolean } | undefined)?.tapUsage === true });
			if (seen.length === 1) {
				yield refusal(NO_ENDPOINTS);
				return;
			}
			yield { type: "start" };
			yield done({
				responseId: "gen-fallback-1",
				providerUsage: { costUsd: 0.0012345, generationId: "gen-fallback-1", provider: "Crusoe" },
			});
		};
		await withPricingHarness(
			async ({ runtime, billing, spawner }) => {
				const session = await seedPricedSession(runtime, {
					suffix: "fallback",
					model: "moonshotai/kimi-k2.5",
					pricing: card,
				});
				const responses = await runInference(spawner, session, "req-fallback");
				assert.equal(responses.some(isTerminalResponse), true, "the sandbox got the retry's reply");
				assert.equal(
					responses.some((response) => JSON.stringify(response).includes("No endpoints found")),
					false,
					"and never the refusal",
				);
				assert.equal(seen.length, 2);
				assert.ok((seen[0].routing as { max_price?: unknown }).max_price, "the first call carried the ceiling");
				assert.deepEqual(
					seen[1].routing,
					{ sort: "price", require_parameters: true },
					"the retry did not, and still asks for endpoints that serve its tools",
				);
				assert.equal(seen[1].tap, true, "and ran through the usage tap");

				const event = await waitForBillingEvent(billing, await inferenceOperationId(runtime, session.sessionId));
				const atCard = computeRateCardCost(card, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
				assert.equal(event.pricingBasis, "fallback-actual");
				assert.equal(event.providerReportedCostMicroUsd, 1235, "$0.0012345 rounded up to a micro-dollar");
				assert.equal(event.providerCostMicroUsd, 1235);
				assert.equal(event.markupMicroUsd, 186);
				assert.equal(event.costMicroUsd, 1421);
				assert.equal(event.cardCostMicroUsd, atCard.totalCostMicroUsd, "the card's figure is kept beside it");
				assert.equal(event.providerGenerationId, "gen-fallback-1");
				assert.deepEqual(
					settledCosts(await runtime.listAgentSessionEvents(session.sessionId)),
					[1421],
					"the chip is the debit",
				);
			},
			{ llmProxy: proxy },
		);
	});

	it("is settled at the card, and says so, when OpenRouter's charge did not come back", async () => {
		const card = cardFor("moonshotai/kimi-k2.5");
		let calls = 0;
		const proxy: LlmProxy = async function* () {
			calls++;
			if (calls === 1) {
				yield refusal(NO_ENDPOINTS);
				return;
			}
			yield done();
		};
		await withPricingHarness(
			async ({ runtime, billing, spawner }) => {
				const session = await seedPricedSession(runtime, {
					suffix: "fallback-blind",
					model: "moonshotai/kimi-k2.5",
					pricing: card,
				});
				await runInference(spawner, session, "req-fallback-blind");
				const event = await waitForBillingEvent(billing, await inferenceOperationId(runtime, session.sessionId));
				const atCard = computeRateCardCost(card, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
				assert.equal(event.pricingBasis, "fallback-card");
				assert.equal(event.costMicroUsd, atCard.totalCostMicroUsd);
				assert.equal(event.providerReportedCostMicroUsd, null);
				assert.deepEqual(settledCosts(await runtime.listAgentSessionEvents(session.sessionId)), [
					atCard.totalCostMicroUsd,
				]);
			},
			{ llmProxy: proxy },
		);
	});
});

describe("a Session's ordinary call", () => {
	it("is settled at the card, as before, and the chip is that debit", async () => {
		const card = cardFor("moonshotai/kimi-k2.5");
		const proxy: LlmProxy = async function* () {
			yield { type: "start" };
			yield done({ responseId: "gen-ordinary-1" });
		};
		await withPricingHarness(
			async ({ runtime, billing, spawner }) => {
				const session = await seedPricedSession(runtime, {
					suffix: "ordinary",
					model: "moonshotai/kimi-k2.5",
					pricing: card,
				});
				await runInference(spawner, session, "req-ordinary");
				const event = await waitForBillingEvent(billing, await inferenceOperationId(runtime, session.sessionId));
				const atCard = computeRateCardCost(card, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
				assert.equal(event.pricingBasis, "card");
				assert.equal(event.costMicroUsd, atCard.totalCostMicroUsd);
				assert.equal(event.cardCostMicroUsd, atCard.totalCostMicroUsd);
				assert.deepEqual(settledCosts(await runtime.listAgentSessionEvents(session.sessionId)), [
					atCard.totalCostMicroUsd,
				]);
			},
			{ llmProxy: proxy },
		);
	});
});

describe("the store re-derives a fallback event before it is billed", () => {
	it("refuses a fallback event whose debit does not follow from OpenRouter's reported charge, and takes the one that does", async () => {
		const card = cardFor("moonshotai/kimi-k2.5");
		const proxy: LlmProxy = async function* () {
			yield { type: "start" };
			throw new Error("the provider connection dropped");
		};
		await withPricingHarness(
			async ({ runtime, spawner }) => {
				const session = await seedPricedSession(runtime, {
					suffix: "fallback-verify",
					model: "moonshotai/kimi-k2.5",
					pricing: card,
				});
				await runInference(spawner, session, "req-fallback-verify");
				const operationId = await inferenceOperationId(runtime, session.sessionId);
				const reservation = await runtime.readAgentSessionInferenceReservation(operationId);
				assert.ok(reservation, "the call was reserved, then left indeterminate by the dropped connection");
				const atCard = computeRateCardCost(card, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
				const actual = priceAtProviderReport(atCard, 1235, card.markupBps);
				const event = {
					fundingSource: reservation.funding_source,
					eventId: operationId,
					ts: 10,
					userId: session.ownerUserId,
					graphId: session.graphId,
					sandboxId: reservation.sandbox_id,
					template: "agent",
					sessionId: session.sessionId,
					generation: reservation.generation,
					inferenceOperationId: operationId,
					requestId: reservation.request_id,
					childRunId: null,
					allocationId: null,
					provider: "openrouter",
					model: "moonshotai/kimi-k2.5",
					modelPriced: atCard.modelPriced,
					reason: "stop",
					inputTokens: 100,
					outputTokens: 10,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 110,
					inputCostMicroUsd: actual.inputCostMicroUsd,
					outputCostMicroUsd: actual.outputCostMicroUsd,
					cacheReadCostMicroUsd: actual.cacheReadCostMicroUsd,
					cacheWriteCostMicroUsd: actual.cacheWriteCostMicroUsd,
					providerCostMicroUsd: actual.providerCostMicroUsd,
					providerReportedCostMicroUsd: 1235,
					providerGenerationId: "gen-verify-1",
					pricingBasis: "fallback-actual" as const,
					cardCostMicroUsd: atCard.totalCostMicroUsd,
					cardProviderCostMicroUsd: atCard.providerCostMicroUsd,
					markupMicroUsd: actual.markupMicroUsd,
					costMicroUsd: actual.totalCostMicroUsd,
					pricingVersion: card.version,
					pricedDefault: false,
				};
				const settle = (billingEvent: typeof event) =>
					runtime.settleAgentSessionInferenceBudget(operationId, {
						generation: reservation.generation,
						activationId: reservation.activation_id,
						sandboxId: reservation.sandbox_id,
						requestId: reservation.request_id,
						requestDigest: reservation.request_digest,
						now: 10,
						usage: {
							turns: 1,
							wallTimeMs: 0,
							tokens: 110,
							costUsdMicros: billingEvent.costMicroUsd,
							artifactBytes: 0,
						},
						billingEvent: billingEvent as never,
					});
				await assert.rejects(
					settle({ ...event, markupMicroUsd: event.markupMicroUsd + 50, costMicroUsd: event.costMicroUsd + 50 }),
					/diverges from pinned deterministic pricing/,
					"a debit the reported charge does not explain",
				);
				await assert.rejects(
					settle({ ...event, cardCostMicroUsd: event.cardCostMicroUsd + 1 }),
					/card figures diverge/,
					"a card figure that is not the card's",
				);
				const settled = await settle(event);
				assert.equal(settled.applied, true);
			},
			{ llmProxy: proxy },
		);
	});
});
