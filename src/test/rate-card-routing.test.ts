import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import {
	buildRateCard,
	openRouterFallbackRouting,
	openRouterRoutingForRateCard,
	type RateCardV1,
} from "../billing-rate-card.js";
import { proxyLlmRequest } from "../openrouter.js";
import { ZERO_USAGE } from "../wire-protocol.js";
import { type LlmProxy, runInference, seedPricedSession, withPricingHarness } from "./chat-pricing-fixture.js";
import { fullRow } from "./fixtures/openrouter-catalogue.fixture.js";

/**
 * A Session priced from the catalogue is billed by its rate card, the model-level price OpenRouter lists. OpenRouter's
 * default routing does not always serve that price: on 2026-10-01 one tiny call per catalogue voice (287 voices,
 * a price-gap study kept outside this repository) was charged exactly the card for 195 of 248 judged voices, MORE than
 * the card for 30 (median 1.48x at a realistic chat call, up to 3.68x) and less for 23. Kimi K2.6 itself went to Baidu
 * (the card) four times and once to Chutes at 1.26x. A charge above the card is a loss on every such turn.
 *
 * OpenRouter's own routing can promise the card: `max_price` (dollars per million tokens; witnessed live: at the card
 * the call was served by the card's provider at exactly the card; just under the cheapest provider the call was refused
 * with "No endpoints found that satisfy the max price") and `sort: "price"`, which tries the cheapest qualifying
 * provider first, so a chat's turns keep to one provider and its prompt cache stays warm. Pi forwards a model's
 * `compat.openRouterRouting` as the request's `provider`.
 */

const CATALOGUE = { digest: "0123456789abcdef".repeat(4), fetchedAt: "2026-09-29T20:00:00.000Z" };

function cardFor(id: string): RateCardV1 {
	const built = buildRateCard({ model: id, pricing: fullRow(id).pricing_raw, catalogue: CATALOGUE, markupBps: 1500 });
	assert.ok(built.ok, `${id} builds a card`);
	return built.card;
}

const perMillion = (price: string | undefined) => (price === undefined ? 0 : Number(price) * 1_000_000);

describe("the routing a rate card asks OpenRouter for", () => {
	it("caps the price at the card, cheapest qualifying provider first", () => {
		const card = cardFor("moonshotai/kimi-k2.5");
		const routing = openRouterRoutingForRateCard(card);
		assert.equal(routing.sort, "price");
		const cap = routing.max_price;
		assert.ok(cap.prompt >= perMillion(card.prices.prompt), "the card's own provider always qualifies");
		assert.ok(cap.completion >= perMillion(card.prices.completion));
		assert.ok(
			cap.prompt - perMillion(card.prices.prompt) < 1e-6,
			"and nothing dearer than the card by more than a rounding",
		);
		assert.ok(cap.completion - perMillion(card.prices.completion) < 1e-6);
	});

	it("caps a tiered card at its dearest tier, so a long prompt the card prices is never refused", () => {
		const card = cardFor("openai/gpt-5.6-luna");
		assert.equal(card.tiers.length, 1);
		const routing = openRouterRoutingForRateCard(card);
		const dearestPrompt = Math.max(
			perMillion(card.prices.prompt),
			...card.tiers.map((tier) => perMillion(tier.prices.prompt)),
		);
		const dearestCompletion = Math.max(
			perMillion(card.prices.completion),
			...card.tiers.map((tier) => perMillion(tier.prices.completion ?? card.prices.completion)),
		);
		assert.ok(routing.max_price.prompt >= dearestPrompt && routing.max_price.prompt - dearestPrompt < 1e-6);
		assert.ok(
			routing.max_price.completion >= dearestCompletion && routing.max_price.completion - dearestCompletion < 1e-6,
		);
	});
});

describe("a voice is routed only to endpoints that serve the tools the call sends (DESIGN-empowered-chat §11.3)", () => {
	/**
	 * Without `require_parameters` OpenRouter may route a call to an endpoint that does not support a parameter it
	 * carries, and that endpoint ignores it: a Writer chat sent to an endpoint without tool support silently has no
	 * tools. With it, only endpoints that support every parameter of the call qualify, and when none does the call is
	 * refused, which the person sees, instead of being answered without tools.
	 */
	it("asks for it on every routing the host sends: the card's, and the fallback's", () => {
		for (const id of ["moonshotai/kimi-k2.5", "openai/gpt-5.6-luna"]) {
			const card = cardFor(id);
			assert.equal(openRouterRoutingForRateCard(card).require_parameters, true, id);
			assert.equal(openRouterFallbackRouting(card).require_parameters, true, id);
		}
	});

	it("asks for it on a legacy Session's calls too, which carry no card", async () => {
		const seen: unknown[] = [];
		const capturing: LlmProxy = async function* (model) {
			seen.push(model);
			yield { type: "start" };
			yield { type: "done", reason: "stop", usage: { ...ZERO_USAGE, input: 100, output: 10, totalTokens: 110 } };
		};
		await withPricingHarness(
			async ({ runtime, spawner }) => {
				const session = await seedPricedSession(runtime, { suffix: "legacy-tools", model: "moonshotai/kimi-k2.5" });
				await runInference(spawner, session, "req-legacy-tools");
			},
			{ llmProxy: capturing },
		);
		assert.equal(seen.length, 1);
		const compat = (seen[0] as { compat?: { openRouterRouting?: unknown } }).compat;
		assert.deepEqual(compat?.openRouterRouting, { require_parameters: true });
	});
});

describe("the host sends it with every call of a Session priced from the catalogue", () => {
	it("hands the provider call the card's routing", async () => {
		const card = cardFor("moonshotai/kimi-k2.5");
		const seen: unknown[] = [];
		const capturing: LlmProxy = async function* (model) {
			seen.push(model);
			yield { type: "start" };
			yield { type: "done", reason: "stop", usage: { ...ZERO_USAGE, input: 100, output: 10, totalTokens: 110 } };
		};
		await withPricingHarness(
			async ({ runtime, spawner }) => {
				const session = await seedPricedSession(runtime, {
					suffix: "routed",
					model: "moonshotai/kimi-k2.5",
					pricing: card,
				});
				await runInference(spawner, session, "req-routed");
			},
			{ llmProxy: capturing },
		);
		assert.equal(seen.length, 1);
		const compat = (seen[0] as { compat?: { openRouterRouting?: unknown } }).compat;
		assert.deepEqual(compat?.openRouterRouting, openRouterRoutingForRateCard(card));
	});
});

describe("Pi sends the routing to OpenRouter as the request's provider preferences", () => {
	it("puts it in the request body", async () => {
		let body = "";
		const server = createServer((request: IncomingMessage, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				body = Buffer.concat(chunks).toString("utf8");
				response.writeHead(400, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: "a test server that only listens", code: 400 } }));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		const routing = openRouterRoutingForRateCard(cardFor("moonshotai/kimi-k2.5"));
		try {
			for await (const _event of proxyLlmRequest(
				{
					id: "moonshotai/kimi-k2.5",
					name: "MoonshotAI: Kimi K2.5",
					api: "openai-completions",
					provider: "openrouter",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 262_144,
					maxTokens: 64,
					baseUrl: `http://127.0.0.1:${port}/api/v1`,
					compat: { openRouterRouting: routing },
				},
				{
					systemPrompt: "You are a test.",
					messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
					tools: [
						{
							name: "read_document",
							description: "Read a document by id.",
							parameters: {
								type: "object",
								properties: { documentId: { type: "string" } },
								required: ["documentId"],
							},
						},
					],
				} as never,
				{ apiKey: "test-key" },
			)) {
				// the server refuses; only the body it received matters
			}
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		const sent = JSON.parse(body);
		assert.deepEqual(sent.provider, routing);
		// The call carries its tools and asks OpenRouter to route only where they are supported.
		assert.equal(sent.provider.require_parameters, true);
		assert.equal(sent.tools?.[0]?.function?.name, "read_document");
	});
});

/**
 * Exam 1, finding 6: without an admitted descriptor the host accepted a worker-asserted `api: "anthropic-messages"` with
 * provider `openrouter` (`spawner.ts` resolveTrustedInferenceModel). Pi's Anthropic serializer does not carry
 * `compat.openRouterRouting`, so that call reached OpenRouter with no `provider.require_parameters`: a Writer chat could
 * be routed to an endpoint without tools. The host refuses the combination, and so does the egress itself.
 */
describe("exam 1: every OpenRouter call carries require_parameters, or is refused before it leaves", () => {
	it("refuses a worker-asserted anthropic-messages API for an OpenRouter Session, before any provider call", async () => {
		const seen: unknown[] = [];
		const capturing: LlmProxy = async function* (model) {
			seen.push(model);
			yield { type: "start" };
			yield { type: "done", reason: "stop", usage: { ...ZERO_USAGE, input: 100, output: 10, totalTokens: 110 } };
		};
		let responses: Record<string, unknown>[] = [];
		await withPricingHarness(
			async ({ runtime, spawner }) => {
				const session = await seedPricedSession(runtime, {
					suffix: "anthropic-api",
					model: "moonshotai/kimi-k2.5",
				});
				responses = await runInference(spawner, session, "req-anthropic-api", 64, undefined, {
					api: "anthropic-messages",
				});
			},
			{ llmProxy: capturing },
		);
		assert.equal(seen.length, 0, "no provider call was made");
		const text = JSON.stringify(responses);
		assert.match(text, /openai-completions/, text);
	});

	it("the egress refuses an OpenRouter model on any serializer that does not carry provider routing: nothing is sent", async () => {
		let received = 0;
		let body = "";
		const server = createServer((request: IncomingMessage, response) => {
			received += 1;
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				body = Buffer.concat(chunks).toString("utf8");
				response.writeHead(400, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: "a test server that only listens", code: 400 } }));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		let failure: unknown;
		try {
			for await (const _event of proxyLlmRequest(
				{
					id: "anthropic/claude-sonnet-4.5",
					name: "Claude",
					api: "anthropic-messages",
					provider: "openrouter",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200_000,
					maxTokens: 64,
					baseUrl: `http://127.0.0.1:${port}/api/v1`,
					compat: { openRouterRouting: { require_parameters: true } },
				},
				{
					systemPrompt: "You are a test.",
					messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
					tools: [{ name: "read_document", description: "Read.", parameters: { type: "object", properties: {} } }],
				} as never,
				{ apiKey: "test-key" },
			)) {
				// a refused call yields nothing
			}
		} catch (error) {
			failure = error;
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		// What r20261006a sent, for the record: a request with no provider preferences at all.
		assert.equal(received, 0, `the egress sent a request: ${body}`);
		assert.match(String(failure), /openai-completions/);
	});
});
