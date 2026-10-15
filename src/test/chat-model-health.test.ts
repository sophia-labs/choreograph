import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildRateCard, DEFAULT_BILLING_MARKUP_BPS } from "../billing-rate-card.js";
import {
	ChatModelHealth,
	classifyOpenRouterRefusal,
	composeChatVoiceMarket,
	noLiveEndpoint,
} from "../chat-model-health.js";
import { admitWorkspaceChatInference, projectChatModelCatalogue } from "../chat-models.js";
import { type ModelEndpointsRow, normalizeEndpointsResponse } from "../chat-precision.js";
import { OpenRouterModelCatalog } from "../model-catalog.js";
import { proxyLlmRequest } from "../openrouter.js";
import type { ProxyAssistantMessageEvent } from "../wire-protocol.js";
import { ZERO_USAGE } from "../wire-protocol.js";
import { InvocationFault } from "../workflow/invocation.js";
import { type LlmProxy, runInference, seedPricedSession, withPricingHarness } from "./chat-pricing-fixture.js";
import { fullCatalogue, fullRow } from "./fixtures/openrouter-catalogue.fixture.js";

/**
 * Vera's ruling of 2026-10-01: hide the voices that fail for everyone. Two signals, both derived, neither a list kept by
 * hand:
 *
 *   the listing   a voice no provider has served in a day (every endpoint OpenRouter lists for it has no uptime figure
 *                 for the last day, and it has been listed longer than that);
 *   a refusal     what OpenRouter answered a call made with the house's key, when the answer holds for every call of
 *                 every person: an account attestation, the account's data policy, end of life, BYOK-only endpoints.
 *
 * Real data: the listings of seven voices as OpenRouter gave them on 2026-10-01, and the answers it gave our calls.
 */

const HEALTH = JSON.parse(
	readFileSync(new URL("./fixtures/openrouter-endpoints-health-20261001.json", import.meta.url), "utf8"),
) as { fetchedAt: string; models: Record<string, Record<string, unknown>> };
const READ_AT = Date.parse(HEALTH.fetchedAt);

function listing(id: string, edit?: (data: Record<string, unknown>) => Record<string, unknown>): ModelEndpointsRow {
	const data = structuredClone(HEALTH.models[id]);
	const row = normalizeEndpointsResponse({ data: edit ? edit(data) : data }, HEALTH.fetchedAt);
	assert.ok(row, `${id} is in the fixture`);
	return row;
}

/** OpenRouter's answers to our calls on 2026-10-01, as Pi words them: the SDK's `${status} ${message}`, then `metadata.raw`. */
const ANSWERS = {
	attestation:
		"403 This model requires you to complete the following before use: 18+ age confirmation. Confirm at https://openrouter.ai/settings/preferences.",
	endOfLife:
		'404 Provider returned error\n{"message":"This model version has reached the end of its life. Please refer to the AWS documentation for more details."}',
	byokOnly:
		"404 No endpoints found for openai/gpt-5.2-chat. Every candidate endpoint was removed during routing: Add BYOK Endpoints removed azure (the Azure endpoint is BYOK-only and you have no Azure key that can serve openai/gpt-5.2-chat-20251211).",
	dataPolicy:
		"404 0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. We removed them for the following reasons (an endpoint may have matched multiple",
	rateLimited:
		"429 Provider returned error\nmistralai/mistral-large-2512 is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations",
	providerBadRequest:
		'400 Provider returned error\n{"code":400,"msg":"bad request","request_id":"72e75ea0-57f2-4ced-8e6c-6399195285ee"}',
	requestShape:
		'400 Provider returned error\n{"error":{"message":"Invalid \'max_output_tokens\': must be greater than or equal to 16.","type":"invalid_request_error"}}',
	maxPrice: "404 No endpoints found that satisfy the max price for this request",
	quantization:
		"404 No endpoints found for the request with quantization: fp8,fp16,bf16,fp32. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection",
} as const;

describe("a voice no provider has served in a day", () => {
	it("is the three voices that refused every call that day, and none of the four that answered", () => {
		for (const id of ["amazon/nova-premier-v1", "openai/gpt-5.2-chat", "kwaipilot/kat-coder-pro-v2.5"]) {
			assert.equal(noLiveEndpoint(listing(id))?.kind, "no_live_endpoint", id);
		}
		for (const id of [
			"meta/muse-spark-1.1",
			"sakana/sakana-namazu",
			"qwen/qwen-2.5-72b-instruct",
			"unbiased/pareto-26.10-preview",
		]) {
			assert.equal(noLiveEndpoint(listing(id)), undefined, id);
		}
	});

	it("does not read an endpoint's status: every endpoint of a voice that answered was marked negative", () => {
		const qwen = listing("qwen/qwen-2.5-72b-instruct");
		assert.ok(qwen.endpoints.length > 0 && qwen.endpoints.every((endpoint) => endpoint.status < 0));
		assert.equal(noLiveEndpoint(qwen), undefined);
	});

	it("gives a voice listed less than a day ago the benefit of the doubt", () => {
		const fresh = listing("unbiased/pareto-26.10-preview", (data) => ({
			...data,
			created: Math.floor(READ_AT / 1000) - 3_600,
			endpoints: (data.endpoints as Record<string, unknown>[]).map((endpoint) => ({
				...endpoint,
				uptime_last_1d: null,
			})),
		}));
		assert.equal(noLiveEndpoint(fresh), undefined, "an hour old, not yet counted");
	});

	it("refuses a voice OpenRouter lists with no provider at all", () => {
		const none = listing("amazon/nova-premier-v1", (data) => ({ ...data, endpoints: [] }));
		assert.equal(noLiveEndpoint(none)?.kind, "no_live_endpoint");
	});

	it("says nothing when the listing does not carry the figures (a listing kept before they were read)", () => {
		const row = listing("amazon/nova-premier-v1");
		const kept: ModelEndpointsRow = {
			modelId: row.modelId,
			fetchedAt: row.fetchedAt,
			endpoints: row.endpoints.map(({ uptimeLastDay: _uptime, ...endpoint }) => endpoint),
		};
		assert.equal(noLiveEndpoint(kept), undefined);
		assert.equal(noLiveEndpoint(undefined), undefined);
	});
});

describe("the answers that hide a voice for everyone", () => {
	it("are an account attestation, the account's data policy, end of life, and BYOK-only endpoints", () => {
		assert.equal(classifyOpenRouterRefusal(ANSWERS.attestation)?.kind, "attestation_required");
		assert.equal(classifyOpenRouterRefusal(ANSWERS.dataPolicy)?.kind, "data_policy");
		assert.equal(classifyOpenRouterRefusal(ANSWERS.endOfLife)?.kind, "end_of_life");
		assert.equal(classifyOpenRouterRefusal(ANSWERS.byokOnly)?.kind, "byok_only");
	});

	it("are never a rate limit, a provider's 400, a request's own shape, or the card's price or quantization rule", () => {
		for (const answer of [
			ANSWERS.rateLimited,
			ANSWERS.providerBadRequest,
			ANSWERS.requestShape,
			ANSWERS.maxPrice,
			ANSWERS.quantization,
			"502 Provider returned error",
			"Connection error.",
			"Request was aborted.",
		]) {
			assert.equal(classifyOpenRouterRefusal(answer), undefined, answer.slice(0, 60));
		}
	});

	it("keep no part of OpenRouter's text: the reason shown is the host's own", () => {
		const refusal = classifyOpenRouterRefusal(ANSWERS.byokOnly);
		assert.ok(refusal);
		assert.equal(refusal.message.includes("azure"), false);
		assert.equal(refusal.message.includes("gpt-5.2"), false);
	});

	it("are read from the message Pi makes of OpenRouter's real answer", async () => {
		const server = createServer((_request, response) => {
			response.writeHead(403, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					error: {
						message:
							"This model requires you to complete the following before use: 18+ age confirmation. Confirm at https://openrouter.ai/settings/preferences.",
						code: 403,
					},
				}),
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		try {
			const events: ProxyAssistantMessageEvent[] = [];
			for await (const event of proxyLlmRequest(
				{
					id: "meta/muse-spark-1.1",
					name: "Meta: Muse Spark 1.1",
					api: "openai-completions",
					provider: "openrouter",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1_048_576,
					maxTokens: 64,
					baseUrl: `http://127.0.0.1:${port}/api/v1`,
				},
				{ systemPrompt: "You are a test.", messages: [{ role: "user", content: "Hi.", timestamp: Date.now() }] },
				{ apiKey: "or-test-key" },
			)) {
				events.push(event);
			}
			const error = events.find((event) => event.type === "error") as { errorMessage?: string } | undefined;
			assert.ok(error?.errorMessage, "Pi answered with an error");
			assert.equal(classifyOpenRouterRefusal(error.errorMessage)?.kind, "attestation_required");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});

describe("the record of refusals", () => {
	it("keeps a refusal on disk across a restart, and lets it lapse after a day", async () => {
		const dir = await mkdtemp(join(tmpdir(), "chat-health-"));
		let clock = READ_AT;
		try {
			const first = new ChatModelHealth({ snapshotPath: join(dir, "health.json"), now: () => clock });
			await first.initialize();
			const refusal = classifyOpenRouterRefusal(ANSWERS.attestation);
			assert.ok(refusal);
			await first.record("meta/muse-spark-1.1", refusal.kind);
			assert.equal(first.refusal("meta/muse-spark-1.1", clock)?.kind, "attestation_required");
			assert.equal(first.refusal("meta/muse-spark-1.2", clock), undefined);

			const second = new ChatModelHealth({ snapshotPath: join(dir, "health.json"), now: () => clock });
			await second.initialize();
			assert.equal(second.refusal("meta/muse-spark-1.1", clock)?.kind, "attestation_required", "after a restart");
			clock += 25 * 3_600_000;
			assert.equal(second.refusal("meta/muse-spark-1.1", clock), undefined, "a day later it is tried again");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("the host's view of each voice", () => {
	it("refuses a voice for what a call recorded, or for what its listing shows", async () => {
		const dir = await mkdtemp(join(tmpdir(), "chat-health-"));
		try {
			const health = new ChatModelHealth({ snapshotPath: join(dir, "health.json"), now: () => READ_AT });
			await health.initialize();
			await health.record("meta/muse-spark-1.1", "attestation_required");
			const market = composeChatVoiceMarket({
				endpoints: (id) => (HEALTH.models[id] ? listing(id) : undefined),
				health,
			});
			assert.equal(market.refusal?.("meta/muse-spark-1.1", READ_AT)?.kind, "attestation_required");
			assert.equal(market.refusal?.("kwaipilot/kat-coder-pro-v2.5", READ_AT)?.kind, "no_live_endpoint");
			assert.equal(market.refusal?.("unbiased/pareto-26.10-preview", READ_AT), undefined);
			assert.equal(market.refusal?.("vendor/unlisted", READ_AT), undefined);
			assert.equal(market.endpoints("qwen/qwen-2.5-72b-instruct")?.modelId, "qwen/qwen-2.5-72b-instruct");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

const CATALOGUE = { digest: "0123456789abcdef".repeat(4), fetchedAt: "2026-09-29T20:00:00.000Z" };
const refused = (message: string): ProxyAssistantMessageEvent => ({
	type: "error",
	reason: "error",
	errorMessage: message,
	usage: ZERO_USAGE,
});

async function withCatalogue(run: (catalogue: OpenRouterModelCatalog) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "chat-health-catalogue-"));
	const catalogue = new OpenRouterModelCatalog({
		snapshotPath: join(dir, "openrouter.json"),
		refreshOnInit: false,
		refreshIntervalMs: 0,
		authConfigured: true,
		loadCatalog: async () => fullCatalogue(),
	});
	try {
		await catalogue.initialize();
		await catalogue.refresh?.();
		await run(catalogue);
	} finally {
		catalogue.close();
		await rm(dir, { recursive: true, force: true });
	}
}

describe("a voice the provider refuses for everyone", () => {
	it("is recorded from the house's call, then neither listed nor admitted", async () => {
		const dir = await mkdtemp(join(tmpdir(), "chat-health-host-"));
		const model = "moonshotai/kimi-k2.5";
		const built = buildRateCard({
			model,
			pricing: fullRow(model).pricing_raw,
			catalogue: CATALOGUE,
			markupBps: 1500,
		});
		assert.ok(built.ok);
		const proxy: LlmProxy = async function* () {
			yield refused(ANSWERS.attestation);
		};
		try {
			const health = new ChatModelHealth({ snapshotPath: join(dir, "health.json") });
			await health.initialize();
			await withPricingHarness(
				async ({ runtime, spawner }) => {
					const session = await seedPricedSession(runtime, { suffix: "refused", model, pricing: built.card });
					await runInference(spawner, session, "req-refused");
				},
				{ llmProxy: proxy, chatModelHealth: health },
			);
			assert.equal(health.refusal(model, Date.now())?.kind, "attestation_required", "the call recorded it");
			const market = composeChatVoiceMarket({ endpoints: () => undefined, health });
			await withCatalogue(async (catalogue) => {
				const view = projectChatModelCatalogue({
					snapshot: await catalogue.snapshotRows(),
					houseDefault: { provider: "openrouter", model: "google/gemini-2.5-flash" },
					markupBps: DEFAULT_BILLING_MARKUP_BPS,
					denylist: [],
					market,
				});
				assert.equal(
					view.models.some((entry) => entry.id === model),
					false,
					"not listed",
				);
				assert.ok(view.models.some((entry) => entry.id === "google/gemini-2.5-flash"));
				await assert.rejects(
					admitWorkspaceChatInference({
						requested: { provider: "openrouter", model },
						houseDefault: { provider: "openrouter", model: "google/gemini-2.5-flash" },
						catalog: catalogue,
						denylist: [],
						markupBps: DEFAULT_BILLING_MARKUP_BPS,
						market,
					}),
					(error: unknown) =>
						error instanceof InvocationFault &&
						error.status === 503 &&
						error.code === "model_unavailable" &&
						(error.details as { reason?: string; kind?: string }).reason === "provider_refused" &&
						(error.details as { kind?: string }).kind === "attestation_required",
				);
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("is not recorded from a rate limit or a provider's 400", async () => {
		const dir = await mkdtemp(join(tmpdir(), "chat-health-host-"));
		const model = "moonshotai/kimi-k2.5";
		const built = buildRateCard({
			model,
			pricing: fullRow(model).pricing_raw,
			catalogue: CATALOGUE,
			markupBps: 1500,
		});
		assert.ok(built.ok);
		let calls = 0;
		const proxy: LlmProxy = async function* () {
			calls++;
			yield refused(calls === 1 ? ANSWERS.rateLimited : ANSWERS.providerBadRequest);
		};
		try {
			const health = new ChatModelHealth({ snapshotPath: join(dir, "health.json") });
			await health.initialize();
			await withPricingHarness(
				async ({ runtime, spawner }) => {
					for (const suffix of ["limited", "bad-request"]) {
						const session = await seedPricedSession(runtime, { suffix, model, pricing: built.card });
						await runInference(spawner, session, `req-${suffix}`);
					}
				},
				{ llmProxy: proxy, chatModelHealth: health },
			);
			assert.equal(calls, 2);
			assert.equal(health.refusal(model, Date.now()), undefined);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
