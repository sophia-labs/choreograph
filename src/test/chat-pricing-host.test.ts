import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { computeCost, PRICING_VERSION } from "../billing-pricing.js";
import { buildRateCard, computeRateCardCost, type RateCardV1, resolveBillingMarkupBps } from "../billing-rate-card.js";
import type { UsageEventRecord } from "../billing-store.js";
import { admitWorkspaceChatInference } from "../chat-models.js";
import { OpenRouterModelCatalog } from "../model-catalog.js";
import type { ChoreographCaptureEvent } from "../observatory-capture.js";
import { mergeOpenRouterModelCatalogs } from "../openrouter.js";
import { AgentSessionBudgetFault, agentNodeSpecForCommandActivation } from "../workflow/runtime-store.js";
import {
	inferenceOperationId,
	isTerminalResponse,
	type PricedSession,
	proxyAnswering,
	runInference,
	seedPricedSession,
	waitForBillingEvent,
	withPricingHarness,
} from "./chat-pricing-fixture.js";
import { beginChat, withRuntime } from "./chat-runtime-fixture.js";
import { fullRow, golden } from "./fixtures/openrouter-catalogue.fixture.js";
import { REAL_OPENROUTER_ROWS, realCatalogue } from "./fixtures/openrouter-real-rows.fixture.js";

/**
 * The pinned rate card, read in three places (Sobremesa sub-task 5; `E-billing-enforce.md` 4.3.9 and Appendix B).
 *
 * A Session admitted from the live catalogue carries a rate card in its document. The host's reservation prices the
 * worst case from it, the host's settlement prices what happened from it, and the runtime store's deterministic
 * re-derivation of the billing event reads it too. If any one of the three still consulted the static table (or a
 * live row), the store's settlement would refuse the event as a conflict and no usage row would ever reach the
 * ledger: so every test here that sees a billing event in the ledger has also shown all three agree.
 *
 * Everything is real: the runtime and billing stores, the spawner and its own `inference.request` handler. Only the
 * provider's network is replaced (the spawner's `llmProxy` seam). Every number is from `pricing-oracle.mjs`.
 */

/**
 * The markup the oracle's goldens (the named cases below) were computed at. It is not the release's default, which is
 * today's 15%: the test after "House default's live turn" follows a Session admitted at the default all the way to the
 * ledger, and it is the same machinery, reading the card's own pinned markup rather than a constant.
 */
const MARKUP = 2000;
const CATALOGUE = { digest: "0123456789abcdef".repeat(4), fetchedAt: "2026-09-29T20:00:00.000Z" };

function cardFor(id: string, markupBps = MARKUP): RateCardV1 {
	const built = buildRateCard({ model: id, pricing: fullRow(id).pricing_raw, catalogue: CATALOGUE, markupBps });
	assert.ok(built.ok, `${id} builds a card`);
	return built.card;
}

/** The fields of a billing event that carry money, in the order the oracle lists them. */
function money(event: UsageEventRecord) {
	return {
		inputCostMicroUsd: event.inputCostMicroUsd,
		outputCostMicroUsd: event.outputCostMicroUsd,
		cacheReadCostMicroUsd: event.cacheReadCostMicroUsd,
		cacheWriteCostMicroUsd: event.cacheWriteCostMicroUsd,
		providerCostMicroUsd: event.providerCostMicroUsd,
		markupMicroUsd: event.markupMicroUsd,
		costMicroUsd: event.costMicroUsd,
	};
}

function expectedMoney(name: string) {
	const { exactProviderMicroUsd: _p, exactTotalMicroUsd: _t, ...expected } = golden(name).expect;
	return expected;
}

describe("a Session pinned to a catalogue card is priced from it by the reservation, the settlement and the verifier", () => {
	it("settles a turn on a model the static table does not know at the card's price, and debits exactly that", async () => {
		const card = cardFor("moonshotai/kimi-k2.5");
		const example = golden("kimi-cache-read-listed");
		await withPricingHarness(
			async ({ runtime, billing, spawner }) => {
				const session = await seedPricedSession(runtime, {
					suffix: "kimi",
					model: "moonshotai/kimi-k2.5",
					pricing: card,
				});
				const responses = await runInference(spawner, session, "req-kimi");
				assert.equal(responses.some(isTerminalResponse), true);

				const operationId = await inferenceOperationId(runtime, session.sessionId);
				const reservation = await runtime.readAgentSessionInferenceReservation(operationId);
				assert.equal(reservation?.state, "settled");
				assert.equal(
					reservation?.pricing_version,
					card.version,
					"the reservation is stamped with the card's version",
				);
				const worstCase = computeRateCardCost(card, {
					input: reservation?.estimated_input_tokens ?? -1,
					output: reservation?.max_output_tokens ?? -1,
					cacheRead: 0,
					cacheWrite: 0,
				}).totalCostMicroUsd;
				assert.equal(
					reservation?.budget.costUsdMicros,
					worstCase,
					"the worst case is reserved at the card's price",
				);

				const event = await waitForBillingEvent(billing, operationId);
				assert.deepEqual(money(event), expectedMoney("kimi-cache-read-listed"));
				assert.equal(event.costMicroUsd, 6060);
				assert.equal(
					event.pricingVersion,
					card.version,
					"the version names the catalogue snapshot the price came from",
				);
				assert.equal(event.modelPriced, "moonshotai/kimi-k2.5");
				assert.equal(event.pricedDefault, false, "never billed at the Sonnet fallback");
				const credit = await billing.getCredit(session.ownerUserId);
				assert.equal(credit?.lifetimeUsageMicroUsd, 6060);
				assert.equal(credit?.balanceMicroUsd, 1_000_000 - 6060, "the lazy $1.00 seed less exactly the cost");
			},
			{ llmProxy: proxyAnswering(example.tokens) },
		);
	});

	it("bills a cache token with no listed price at the prompt price, through all three readers", async () => {
		const card = cardFor("moonshotai/kimi-k2.5");
		const example = golden("kimi-cache-write-not-listed");
		await withPricingHarness(
			async ({ runtime, billing, spawner }) => {
				const session = await seedPricedSession(runtime, {
					suffix: "kimi-write",
					model: "moonshotai/kimi-k2.5",
					pricing: card,
				});
				await runInference(spawner, session, "req-kimi-write");
				const event = await waitForBillingEvent(billing, await inferenceOperationId(runtime, session.sessionId));
				assert.deepEqual(money(event), expectedMoney("kimi-cache-write-not-listed"));
				assert.equal(event.cacheWriteCostMicroUsd, 450, "1,000 cache-write tokens at $0.45/M, not zero");
			},
			{ llmProxy: proxyAnswering(example.tokens) },
		);
	});

	it("bills the House default's live turn at 887 micro-dollars where the static table said 848", async () => {
		const card = cardFor("google/gemini-2.5-flash");
		const example = golden("flash-turn-one");
		await withPricingHarness(
			async ({ runtime, billing, spawner }) => {
				const session = await seedPricedSession(runtime, {
					suffix: "flash",
					model: "google/gemini-2.5-flash",
					pricing: card,
				});
				await runInference(spawner, session, "req-flash");
				const event = await waitForBillingEvent(billing, await inferenceOperationId(runtime, session.sessionId));
				assert.equal(event.costMicroUsd, 887);
				assert.equal(event.markupMicroUsd, 148);
				assert.equal(event.pricingVersion, card.version);
				assert.notEqual(
					event.costMicroUsd,
					computeCost("google/gemini-2.5-flash", example.tokens).totalCostMicroUsd,
				);
			},
			{ llmProxy: proxyAnswering(example.tokens) },
		);
	});

	it("bills the fee this release ships, today's 15%, end to end: admitted at the default, priced by all three readers", async () => {
		const dir = await mkdtemp(join(tmpdir(), "chat-pricing-default-fee-"));
		const catalogue = new OpenRouterModelCatalog({
			snapshotPath: join(dir, "openrouter.json"),
			refreshOnInit: false,
			refreshIntervalMs: 0,
			authConfigured: true,
			loadCatalog: async () => realCatalogue(["google/gemini-2.5-flash"]),
		});
		try {
			await catalogue.initialize();
			await catalogue.refresh();
			const admission = await admitWorkspaceChatInference({
				houseDefault: { provider: "openrouter", model: "google/gemini-2.5-flash" },
				catalog: catalogue,
				denylist: [],
				markupBps: resolveBillingMarkupBps({}),
			});
			const card = admission.pricing?.card;
			assert.ok(card);
			assert.equal(card.markupBps, 1500, "admitted at the host's default markup, which is what is charged today");
			const example = golden("flash-turn-one-15pct");
			await withPricingHarness(
				async ({ runtime, billing, spawner }) => {
					const session = await seedPricedSession(runtime, {
						suffix: "fifteen",
						model: "google/gemini-2.5-flash",
						pricing: card,
					});
					await runInference(spawner, session, "req-fifteen");
					const event = await waitForBillingEvent(billing, await inferenceOperationId(runtime, session.sessionId));
					assert.deepEqual(money(event), expectedMoney("flash-turn-one-15pct"));
					assert.equal(event.costMicroUsd, 850, "738.4 at 15% is 849.16, rounded up once");
					assert.equal(event.markupMicroUsd, 111);
					assert.equal(event.pricingVersion, card.version);
				},
				{ llmProxy: proxyAnswering(example.tokens) },
			);
		} finally {
			catalogue.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reports the billed price, and no other, in the testimony it emits for the same call", async () => {
		const events: ChoreographCaptureEvent[] = [];
		const capture = {
			emit(event: ChoreographCaptureEvent) {
				events.push(event);
			},
		};
		const card = cardFor("google/gemini-2.5-flash");
		const example = golden("flash-turn-one");
		await withPricingHarness(
			async ({ runtime, billing, spawner }) => {
				const session = await seedPricedSession(runtime, {
					suffix: "capture",
					model: "google/gemini-2.5-flash",
					pricing: card,
				});
				await runInference(spawner, session, "req-capture");
				const event = await waitForBillingEvent(billing, await inferenceOperationId(runtime, session.sessionId));
				const call = events.find((candidate) => candidate.kind === "llm.call");
				assert.ok(call && call.kind === "llm.call", "the call was testified");
				assert.equal(call.payload.costMicroUsd, event.costMicroUsd, "the testimony and the ledger agree");
				assert.equal(call.payload.costMicroUsd, 887);
			},
			{ llmProxy: proxyAnswering(example.tokens), capture },
		);
	});

	it("bills a turn that reached a tier at the tier's price, through all three readers", async () => {
		const card = cardFor("openai/gpt-5.6-luna");
		assert.equal(card.tiers.length, 1);
		const example = golden("luna-tier");
		await withPricingHarness(
			async ({ runtime, billing, spawner }) => {
				const session = await seedPricedSession(runtime, {
					suffix: "luna",
					model: "openai/gpt-5.6-luna",
					pricing: card,
				});
				await runInference(spawner, session, "req-luna");
				const event = await waitForBillingEvent(billing, await inferenceOperationId(runtime, session.sessionId));
				assert.deepEqual(money(event), expectedMoney("luna-tier"));
				assert.equal(event.costMicroUsd, 130_512, "300,000 prompt tokens: over 272,000, every rate is the tier's");
			},
			{ llmProxy: proxyAnswering(example.tokens) },
		);
	});

	it("is not moved by a catalogue refresh between the reservation and the settlement: the pin, not the live row, is read", async () => {
		const dir = await mkdtemp(join(tmpdir(), "chat-pricing-refresh-"));
		let liveLoads = 0;
		const dearer = () => {
			const live = structuredClone(REAL_OPENROUTER_ROWS["google/gemini-2.5-flash"].live);
			live.pricing = { ...live.pricing, prompt: "0.0000006", completion: "0.000005" };
			return {
				...realCatalogue(["google/gemini-2.5-flash"]),
				fetched_at: new Date(Date.now() + 1000).toISOString(),
				models: mergeOpenRouterModelCatalogs([], [live]),
			};
		};
		const catalogue = new OpenRouterModelCatalog({
			snapshotPath: join(dir, "openrouter.json"),
			refreshOnInit: false,
			refreshIntervalMs: 0,
			authConfigured: true,
			loadCatalog: async ({ includeLive }) => {
				if (!includeLive) return realCatalogue(["google/gemini-2.5-flash"]);
				liveLoads += 1;
				return liveLoads === 1 ? realCatalogue(["google/gemini-2.5-flash"]) : dearer();
			},
		});
		try {
			await catalogue.initialize();
			await catalogue.refresh();
			const admission = await admitWorkspaceChatInference({
				houseDefault: { provider: "openrouter", model: "google/gemini-2.5-flash" },
				catalog: catalogue,
				denylist: [],
				markupBps: MARKUP,
			});
			const card = admission.pricing?.card;
			assert.ok(card);
			const example = golden("flash-turn-one");
			await withPricingHarness(
				async ({ runtime, billing, spawner }) => {
					const session = await seedPricedSession(runtime, {
						suffix: "refresh",
						model: "google/gemini-2.5-flash",
						pricing: card,
					});
					await runInference(spawner, session, "req-refresh");
					const now = await catalogue.snapshotRows();
					assert.notEqual(now.digest, card.catalogue.digest, "the catalogue moved between reserve and settle");
					const event = await waitForBillingEvent(billing, await inferenceOperationId(runtime, session.sessionId));
					assert.equal(
						event.costMicroUsd,
						887,
						"at the pinned prices, not the doubled ones (which would be 1,773)",
					);
					assert.equal(event.pricingVersion, card.version);
				},
				{
					llmProxy: proxyAnswering(example.tokens, async () => {
						await catalogue.refresh();
					}),
				},
			);
			assert.ok(liveLoads >= 2, "the catalogue really was refreshed while the call was in flight");
		} finally {
			catalogue.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("the reservation is a bound on the cost, for a Session priced from the catalogue", () => {
	it("holds the dearer of pricing the estimated prompt as input and as cache writes (Anthropic writes cost more than input)", async () => {
		const card = cardFor("anthropic/claude-sonnet-4.5");
		const example = golden("sonnet45-below-tier");
		await withPricingHarness(
			async ({ runtime, spawner }) => {
				const session = await seedPricedSession(runtime, {
					suffix: "sonnet-bound",
					model: "anthropic/claude-sonnet-4.5",
					pricing: card,
				});
				await runInference(spawner, session, "req-sonnet-bound");
				const reservation = await runtime.readAgentSessionInferenceReservation(
					await inferenceOperationId(runtime, session.sessionId),
				);
				assert.ok(reservation);
				const estimated = reservation.estimated_input_tokens;
				const output = reservation.max_output_tokens;
				const asInput = computeRateCardCost(card, { input: estimated, output, cacheRead: 0, cacheWrite: 0 });
				const asWrites = computeRateCardCost(card, { input: 0, output, cacheRead: 0, cacheWrite: estimated });
				assert.ok(
					asWrites.totalCostMicroUsd > asInput.totalCostMicroUsd,
					"for this model a cache write is dearer than an input token, so a prompt of nothing but writes costs more",
				);
				assert.equal(
					reservation.budget.costUsdMicros,
					asWrites.totalCostMicroUsd,
					"what is held is what the dearest reading of the prompt could cost",
				);
				assert.ok(example.tokens.cacheWrite >= 0);
			},
			{ llmProxy: proxyAnswering(example.tokens) },
		);
	});
});

describe("a Session priced by text tokens refuses what it cannot price", () => {
	const withImage = {
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "what is in this picture?" },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
				],
			},
		],
	};
	const inFlight = async (
		runtime: { listAgentSessionBudgetEntries(id: string): Promise<Array<{ kind: string }>> },
		id: string,
	) => (await runtime.listAgentSessionBudgetEntries(id)).filter((entry) => entry.kind === "inference_reserved").length;

	it("refuses an image in the context before it reserves anything: the card has no price for one", async () => {
		const card = cardFor("google/gemini-2.5-flash");
		const example = golden("flash-turn-one");
		await withPricingHarness(
			async ({ runtime, spawner }) => {
				const session = await seedPricedSession(runtime, {
					suffix: "image",
					model: "google/gemini-2.5-flash",
					pricing: card,
				});
				const responses = await runInference(spawner, session, "req-image", 64, withImage);
				const refused = responses.find((response) => response.ok === false) as
					| { error: { message: string } }
					| undefined;
				assert.ok(refused, "the worker is told, not left waiting");
				assert.match(refused.error.message, /image/i);
				assert.equal(
					await inFlight(runtime, session.sessionId),
					0,
					"nothing was reserved, so nothing can be billed",
				);
			},
			{ llmProxy: proxyAnswering(example.tokens) },
		);
	});

	it("leaves a legacy Session exactly as it was: its images still go through", async () => {
		const example = golden("flash-turn-one");
		await withPricingHarness(
			async ({ runtime, spawner }) => {
				const session = await seedPricedSession(runtime, {
					suffix: "image-legacy",
					model: "google/gemini-2.5-flash",
				});
				await runInference(spawner, session, "req-image-legacy", 64, withImage);
				assert.equal(await inFlight(runtime, session.sessionId), 1);
			},
			{ llmProxy: proxyAnswering(example.tokens) },
		);
	});
});

describe("a Session with no pin keeps the static path, byte for byte", () => {
	it("prices a legacy Session on a model the static table knows exactly as before, stamped with the static version", async () => {
		const example = golden("flash-turn-one");
		await withPricingHarness(
			async ({ runtime, billing, spawner }) => {
				const session = await seedPricedSession(runtime, { suffix: "legacy", model: "google/gemini-2.5-flash" });
				await runInference(spawner, session, "req-legacy");
				const operationId = await inferenceOperationId(runtime, session.sessionId);
				const reservation = await runtime.readAgentSessionInferenceReservation(operationId);
				assert.equal(reservation?.pricing_version, PRICING_VERSION);
				const event = await waitForBillingEvent(billing, operationId);
				const expected = computeCost("google/gemini-2.5-flash", example.tokens);
				assert.equal(event.costMicroUsd, expected.totalCostMicroUsd);
				assert.equal(event.costMicroUsd, 848);
				assert.equal(event.pricingVersion, PRICING_VERSION);
				assert.equal(event.pricedDefault, false);
			},
			{ llmProxy: proxyAnswering(example.tokens) },
		);
	});

	it("still flags, and bills at the fallback rate, a legacy Session on a model the static table does not know", async () => {
		// Documented residual: only Sessions pinned from the catalogue are refused rather than billed by fallback.
		// A legacy Session on such a model predates the release; refusing it at its next command is an option in
		// the return's open questions.
		const example = golden("kimi-cache-read-listed");
		await withPricingHarness(
			async ({ runtime, billing, spawner }) => {
				const session = await seedPricedSession(runtime, { suffix: "legacy-kimi", model: "moonshotai/kimi-k2.5" });
				await runInference(spawner, session, "req-legacy-kimi");
				const event = await waitForBillingEvent(billing, await inferenceOperationId(runtime, session.sessionId));
				assert.equal(event.pricedDefault, true);
				assert.equal(event.pricingVersion, PRICING_VERSION);
				assert.equal(event.costMicroUsd, computeCost("moonshotai/kimi-k2.5", example.tokens).totalCostMicroUsd);
			},
			{ llmProxy: proxyAnswering(example.tokens) },
		);
	});
});

describe("the store holds the Session to its own pin", () => {
	const reserveInput = (session: PricedSession, pricingVersion: string, requestId: string) => ({
		generation: session.generation,
		activationId: session.activationId,
		sandboxId: session.sandboxId,
		requestId,
		requestDigest: `sha256:${requestId}`,
		causationId: `cause-${requestId}`,
		provider: "openrouter",
		model: session.model,
		estimatedInputTokens: 100,
		requestedOutputTokens: 64,
		pricingVersion,
		now: Date.now(),
	});
	const reasonOf = async (attempt: Promise<unknown>) => {
		try {
			await attempt;
		} catch (error) {
			if (error instanceof AgentSessionBudgetFault) return error.reason;
			throw error;
		}
		return "reserved";
	};

	it("reserves only at the version the Session was pinned to, and a legacy Session only at the static one", async () => {
		const card = cardFor("moonshotai/kimi-k2.5");
		await withPricingHarness(async ({ runtime }) => {
			const reserve = (session: PricedSession, version: string, requestId: string) =>
				runtime.reserveAgentSessionInferenceBudget(session.sessionId, reserveInput(session, version, requestId));
			const pinned = await seedPricedSession(runtime, {
				suffix: "v-pinned",
				model: "moonshotai/kimi-k2.5",
				pricing: card,
			});
			assert.equal(
				await reasonOf(reserve(pinned, PRICING_VERSION, "r1")),
				"request_conflict",
				"a pinned Session priced by the static table would settle as a conflict",
			);
			assert.equal(
				await reasonOf(reserve(pinned, "cat:ffffffffffff@2026-09-29T20:00:00.000Z", "r2")),
				"request_conflict",
				"another catalogue's version",
			);
			const reserved = await reserve(pinned, card.version, "r3");
			assert.equal(reserved.applied, true);
			assert.equal(reserved.reservation.pricing_version, card.version);
			assert.equal(
				reserved.reservation.budget.costUsdMicros,
				computeRateCardCost(card, { input: 100, output: reserved.maxOutputTokens, cacheRead: 0, cacheWrite: 0 })
					.totalCostMicroUsd,
			);

			const legacy = await seedPricedSession(runtime, { suffix: "v-legacy", model: "google/gemini-2.5-flash" });
			assert.equal(
				await reasonOf(reserve(legacy, card.version, "r4")),
				"request_conflict",
				"a legacy Session has no card to price by",
			);
			assert.equal(await reasonOf(reserve(legacy, "p0-not-a-version", "r5")), "request_invalid");
			assert.equal(await reasonOf(reserve(legacy, PRICING_VERSION, "r6")), "reserved");
		});
	});

	it("refuses a card that prices a different model from the one the Session speaks with, when written and when read", async () => {
		const wrong = cardFor("google/gemini-2.5-flash");
		const right = cardFor("moonshotai/kimi-k2.5");
		await withPricingHarness(async ({ runtime }) => {
			await assert.rejects(
				seedPricedSession(runtime, { suffix: "v-wrong-written", model: "moonshotai/kimi-k2.5", pricing: wrong }),
				/rate card|pricing/i,
			);
			const session = await seedPricedSession(runtime, {
				suffix: "v-wrong-read",
				model: "moonshotai/kimi-k2.5",
				pricing: right,
			});
			const stored = await runtime.readAgentSession(session.sessionId);
			const document = JSON.parse(stored?.document_json ?? "{}") as { source: { pricing: unknown } };
			document.source.pricing = wrong;
			await runtime.raw("UPDATE agent_sessions SET document_json = ? WHERE session_id = ?", [
				JSON.stringify(document),
				session.sessionId,
			]);
			assert.equal(
				await reasonOf(
					runtime.reserveAgentSessionInferenceBudget(
						session.sessionId,
						reserveInput(session, wrong.version, "r1"),
					),
				),
				"request_conflict",
				"a document that was altered after it was written prices nothing",
			);
		});
	});
});

describe("the pin travels with the Session", () => {
	it("is written to the Session document, validated, and refuses a card that is not one", async () => {
		const card = cardFor("moonshotai/kimi-k2.5");
		await withRuntime(async (runtime) => {
			const chat = await beginChat(runtime, { n: 1, model: "moonshotai/kimi-k2.5", spec: { pricing: card } });
			const session = await runtime.readAgentSession(chat.sessionId);
			const document = JSON.parse(session?.document_json ?? "{}") as { source: { pricing?: unknown } };
			assert.deepEqual(document.source.pricing, card);
			await assert.rejects(
				beginChat(runtime, { n: 2, model: "moonshotai/kimi-k2.5", spec: { pricing: { ...card, markupBps: -1 } } }),
				/rate card/i,
			);
			assert.equal(await runtime.readAgentSession("ags-chat-2"), null, "no Session with a malformed card exists");
		});
	});

	it("survives a regrow: the reconstructed activation spec carries the same card", async () => {
		const card = cardFor("moonshotai/kimi-k2.5");
		await withRuntime(async (runtime) => {
			const chat = await beginChat(runtime, { n: 1, model: "moonshotai/kimi-k2.5", spec: { pricing: card } });
			const session = await runtime.readAgentSession(chat.sessionId);
			assert.ok(session);
			const spec = agentNodeSpecForCommandActivation(session, {
				generation: 1,
				activationId: "aca_regrow-pricing-1",
			});
			assert.deepEqual(
				spec.pricing,
				card,
				"without this a regrown Session would be billed by the static table and refused at settlement",
			);
		});
	});

	it("refuses to regrow from a record whose card was tampered with into something that is not a card", async () => {
		const card = cardFor("moonshotai/kimi-k2.5");
		await withRuntime(async (runtime) => {
			const chat = await beginChat(runtime, { n: 1, model: "moonshotai/kimi-k2.5", spec: { pricing: card } });
			const session = await runtime.readAgentSession(chat.sessionId);
			const document = JSON.parse(session?.document_json ?? "{}") as {
				source: { pricing: { prices: Record<string, string> } };
			};
			document.source.pricing.prices.prompt = "1e-9";
			await runtime.raw("UPDATE agent_sessions SET document_json = ? WHERE session_id = ?", [
				JSON.stringify(document),
				chat.sessionId,
			]);
			const tampered = await runtime.readAgentSession(chat.sessionId);
			assert.ok(tampered);
			assert.throws(() =>
				agentNodeSpecForCommandActivation(tampered, { generation: 1, activationId: "aca_regrow-pricing-2" }),
			);
		});
	});

	it("is absent from a Session begun without one, which is how a legacy Session stays legacy", async () => {
		await withRuntime(async (runtime) => {
			const chat = await beginChat(runtime, { n: 1 });
			const session = await runtime.readAgentSession(chat.sessionId);
			assert.ok(session);
			const document = JSON.parse(session.document_json) as { source: Record<string, unknown> };
			assert.equal(Object.hasOwn(document.source, "pricing"), false);
			assert.equal(
				agentNodeSpecForCommandActivation(session, { generation: 1, activationId: "aca_legacy-1" }).pricing,
				undefined,
			);
		});
	});
});
