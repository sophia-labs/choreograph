import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { mirrorAgentSessionEvent } from "../agent-runtime/session-event-mirror.js";
import { DEFAULT_BILLING_MARKUP_BPS, parseRateCard, rateCardVersion } from "../billing-rate-card.js";
import {
	admitWorkspaceChatInference,
	assessChatModelRow,
	CHAT_MODEL_CATALOGUE_SCHEMA,
	type ChatModelRefusalCode,
	catalogueIsUsable,
	chatModelRefusalStatus,
	isChatModelDenied,
	parseChatModelDenylist,
	projectChatModelCatalogue,
} from "../chat-models.js";
import type { BusEvent } from "../event-bus.js";
import { OpenRouterModelCatalog } from "../model-catalog.js";
import {
	mergeOpenRouterModelCatalogs,
	normalizeRawPricing,
	type OpenRouterModelRow,
	type PiCatalogModel,
} from "../openrouter.js";
import { routeRequest } from "../orchestrator.js";
import { compileWorkflow } from "../workflow/harness.js";
import { InvocationFault } from "../workflow/invocation.js";
import { listWorkflows } from "../workflow/registry.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import {
	parseWorkspaceChatRequest,
	resolveWorkspaceChatInference,
	stampWorkspaceChatSpec,
	WORKSPACE_CHAT_SCRIPT,
	WORKSPACE_CHAT_WORKFLOW_NAME,
	type WorkspaceChatHostContextV1,
	workspaceChatHostFacts,
} from "../workflow/workspace-chat.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";
import { recorder, request } from "./chat-runtime-fixture.js";
import { FULL_CATALOGUE_FETCHED_AT, fullRow, fullRows } from "./fixtures/openrouter-catalogue.fixture.js";
import { REAL_OPENROUTER_ROWS, realCatalogue } from "./fixtures/openrouter-real-rows.fixture.js";

/**
 * Voices (Sobremesa sub-tasks 4 and 5): the model a chat speaks with is chosen from a big, programmatic selection
 * of the LIVE OpenRouter catalogue: tool-capable and priced models only, the House default pinned, every price the
 * catalogue's own. Every fixture row below is a real row of that catalogue as it stood on 2026-09-29, run through the
 * host's own merge code. The whole catalogue, row for row, is `chat-catalogue-partition.test.ts`.
 */

const rows = realCatalogue().models;
const rowOf = (id: string): OpenRouterModelRow => {
	const row = rows.find((candidate) => candidate.id === id);
	assert.ok(row, `${id} is in the real fixture`);
	return row;
};

const CATALOGUE = { digest: "d".repeat(64), fetchedAt: "2026-09-29T20:00:00.000Z" };
const assess = (row: OpenRouterModelRow, denylist: readonly string[] = [], markupBps = DEFAULT_BILLING_MARKUP_BPS) =>
	assessChatModelRow(row, { denylist, catalogue: CATALOGUE, markupBps });

const HOUSE = { provider: "openrouter" as const, model: "google/gemini-2.5-flash" };
const ADMISSIBLE = [
	"anthropic/claude-haiku-4.5",
	"anthropic/claude-sonnet-4.5",
	"deepseek/deepseek-chat",
	"google/gemini-2.5-flash",
	"moonshotai/kimi-k2",
	"moonshotai/kimi-k2.5",
	"openai/gpt-5",
];

// ─── The rows ────────────────────────────────────────────────────────────────

describe("catalogue rows keep the price strings the live payload carries", () => {
	it("holds each model's pricing object verbatim: the strings, the cache prices, the overrides", () => {
		for (const id of Object.keys(REAL_OPENROUTER_ROWS)) {
			assert.deepEqual(rowOf(id).pricing_raw, REAL_OPENROUTER_ROWS[id].live.pricing, id);
		}
		assert.equal(rowOf("google/gemini-2.5-flash").pricing_raw?.input_cache_write, "0.0000000833333333333333");
		const overrides = rowOf("anthropic/claude-sonnet-4.5").pricing_raw?.overrides;
		assert.ok(Array.isArray(overrides));
		assert.equal(overrides[0].min_prompt_tokens, 200_000);
		assert.equal(overrides[0].prompt, "0.000006");
	});

	it("keeps the float prices it always had, for what reads them, and no price strings for a model the provider does not offer", () => {
		assert.equal(rowOf("google/gemini-2.5-flash").prompt_price, 0.0000003);
		assert.equal(rowOf("moonshotai/kimi-k2.5").cache_read_price, 0.00000007);
		assert.equal(rowOf("moonshotai/kimi-k2.5").cache_write_price, null);
		const staticOnly: PiCatalogModel = {
			id: "vendor/static-only",
			name: "Static Only",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 2_048,
		};
		const [row] = mergeOpenRouterModelCatalogs([staticOnly], []);
		assert.equal(row.pricing_raw, null, "the bundled catalogue states no live price strings");
	});

	it("normalizes a raw pricing object to strings, overrides and a marker for anything else, and does so idempotently", () => {
		assert.equal(normalizeRawPricing(undefined), null);
		assert.equal(normalizeRawPricing(null), null);
		assert.equal(normalizeRawPricing("0.1"), null);
		assert.equal(normalizeRawPricing([]), null);
		assert.deepEqual(normalizeRawPricing({}), {});
		const messy = {
			prompt: "0.1",
			weird: 5,
			nested: { a: 1 },
			overrides: [{ min_prompt_tokens: 10, prompt: "0.2", junk: null }, "nope"],
		};
		const once = normalizeRawPricing(messy);
		assert.deepEqual(once, {
			prompt: "0.1",
			weird: "?",
			nested: "?",
			overrides: [{ min_prompt_tokens: 10, prompt: "0.2", junk: "?" }, {}],
		});
		assert.deepEqual(normalizeRawPricing(once), once);
		const many = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`key_${index}`, "0.1"]));
		const bounded = normalizeRawPricing(many) as Record<string, unknown>;
		assert.ok(Object.keys(bounded).length <= 33);
		assert.equal(
			bounded["?truncated"],
			"?",
			"a pricing object too big to keep is marked, so it can never be read as complete",
		);
	});
});

// ─── Which rows may speak ────────────────────────────────────────────────────

describe("which rows may speak in a chat", () => {
	it("admits a tool-capable, live, priced, text-only model and pins a card of its own price strings", () => {
		const assessment = assess(rowOf("google/gemini-2.5-flash"));
		assert.equal(assessment.ok, true);
		if (!assessment.ok) return;
		assert.equal(assessment.card.model, "google/gemini-2.5-flash");
		assert.equal(assessment.card.markupBps, 1500, "today's 15%: this release changes nobody's fee");
		assert.equal(assessment.card.version, rateCardVersion(CATALOGUE.digest, CATALOGUE.fetchedAt));
		assert.deepEqual(assessment.card.prices, {
			prompt: "0.0000003",
			completion: "0.0000025",
			inputCacheRead: "0.00000003",
			inputCacheWrite: "0.0000000833333333333333",
		});
		const fifteen = assess(rowOf("google/gemini-2.5-flash"), [], 1500);
		assert.ok(fifteen.ok);
		assert.equal(fifteen.card.markupBps, 1500);
	});

	it("leaves a cache price out of the card when the provider lists none, so the cache token is billed at the prompt price", () => {
		const older = assess(rowOf("moonshotai/kimi-k2"));
		assert.ok(older.ok);
		assert.deepEqual(older.card.prices, { prompt: "0.00000057", completion: "0.0000023" });
		assert.equal(older.card.cacheFallback, "prompt");
	});

	it("refuses a free model: priced at zero is not a price the ledger can bill", () => {
		const free = assess(rowOf("qwen/qwen3.8-27b:free"));
		assert.ok(!free.ok);
		assert.equal(free.code, "model_unpriced");
		assert.equal(free.reason, "zero_priced");
	});

	it("refuses each kind of unfit row with its own code and reason", () => {
		const refusal = (row: OpenRouterModelRow, denylist: readonly string[] = []): string => {
			const assessment = assess(row, denylist);
			return assessment.ok ? "admitted" : `${assessment.code}/${assessment.reason}`;
		};
		assert.equal(
			refusal(rowOf("openrouter/auto")),
			"model_unpriced/price_dynamic",
			"a router advertises tools but is priced -1",
		);
		assert.equal(refusal(rowOf("google/gemini-3.1-flash-image")), "model_unpriced/no_tools");
		assert.equal(refusal(rowOf("perplexity/sonar")), "model_unpriced/no_tools");
		assert.equal(refusal(rowOf("inference-net/schematron-v2-turbo")), "model_unpriced/no_tools");
		assert.equal(refusal(rowOf("openai/gpt-5"), ["openai/*"]), "model_denied/operator_denylist");
		assert.equal(refusal(rowOf("moonshotai/kimi-k2"), ["moonshotai/kimi-k2"]), "model_denied/operator_denylist");
		assert.equal(
			refusal(rowOf("moonshotai/kimi-k2.5"), ["moonshotai/kimi-k2"]),
			"admitted",
			"an exact entry is exact",
		);

		const staticOnly: PiCatalogModel = {
			id: "vendor/static-only",
			name: "Static Only",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 2_048,
		};
		const [staticRow] = mergeOpenRouterModelCatalogs([staticOnly], []);
		assert.equal(
			refusal(staticRow),
			"pricing_unavailable/model_not_live",
			"known to the bundled catalogue, not offered by the provider now",
		);

		const gemini = rowOf("google/gemini-2.5-flash");
		const flash = gemini.pricing_raw as Record<string, unknown>;
		const priced = (pricing: Record<string, unknown>) => ({ ...gemini, pricing_raw: pricing as never });
		assert.equal(refusal(priced({ ...flash, request: "0.005" })), "model_unpriced/per_request_fee");
		assert.equal(refusal(priced({ ...flash, request: "0" })), "admitted");
		assert.equal(
			refusal(priced({ ...flash, internal_reasoning: "0.00001" })),
			"model_unpriced/reasoning_priced_separately",
		);
		assert.equal(refusal(priced({ ...flash, video: "0.5" })), "model_unpriced/price_unmodelled");
		assert.equal(refusal(priced({ ...flash, prompt: "1e-7" })), "model_unpriced/price_malformed");
		const { completion: _completion, ...withoutCompletion } = flash;
		assert.equal(refusal(priced(withoutCompletion)), "model_unpriced/price_missing");
		assert.equal(refusal({ ...gemini, pricing_raw: null }), "model_unpriced/price_missing");
		assert.equal(refusal({ ...gemini, output_modalities: ["image"] }), "model_unpriced/output_not_text");
		assert.equal(refusal({ ...gemini, output_modalities: ["text", "image"] }), "model_unpriced/output_not_text");
		assert.equal(refusal({ ...gemini, input_modalities: ["image"] }), "model_unpriced/input_not_text");
		assert.equal(
			refusal({ ...gemini, output_modalities: null }),
			"model_unpriced/output_not_text",
			"a row that does not say what it gives is not proven to give text alone",
		);
		assert.equal(refusal({ ...gemini, output_modalities: [] }), "model_unpriced/output_not_text");
		assert.equal(
			refusal({ ...gemini, input_modalities: null }),
			"model_unpriced/input_not_text",
			"nor is one that does not say it takes text",
		);
		assert.equal(refusal({ ...gemini, input_modalities: [] }), "model_unpriced/input_not_text");
		assert.equal(
			refusal({ ...gemini, supports_tools: null }),
			"model_unpriced/no_tools",
			"unknown is not tool-capable",
		);
		assert.equal(
			refusal(priced({ ...flash, prompt: "0" })),
			"model_unpriced/zero_priced",
			"an input token priced at nothing: a call with no output would be billed at nothing",
		);
		assert.equal(refusal(priced({ ...flash, completion: "0" })), "model_unpriced/zero_priced");
		assert.equal(refusal(priced({ ...flash, input_cache_read: "0" })), "admitted", "free cache reads are a price");
		assert.equal(
			refusal(priced({ ...flash, overrides: [{ min_prompt_tokens: 100_000, prompt: "0" }] })),
			"model_unpriced/zero_priced",
			"nor may a tier replace the prompt price with nothing",
		);
		assert.equal(
			refusal(priced({ ...flash, prompt: "0.02" })),
			"model_unpriced/price_malformed",
			"above $10,000 per million is not a price the ledger carries",
		);
		assert.equal(refusal({ ...gemini, context_length: 16_000 }), "model_unpriced/context_too_small");
		assert.equal(refusal({ ...gemini, context_length: 32_000 }), "admitted", "32,000 is enough");
		assert.equal(
			refusal({ ...gemini, context_length: null }),
			"model_unpriced/context_too_small",
			"unknown is not proven large enough",
		);
		assert.equal(refusal({ ...gemini, id: "google/gemini-2.5-flash:batch" }), "model_unpriced/batch_variant");
		assert.equal(refusal({ ...gemini, id: "google/gemini-2.5-flash:free" }), "model_unpriced/zero_priced");
	});

	it("takes prices younger than a day, and neither one a day old nor one from the future", () => {
		const now = Date.parse("2026-09-29T20:00:00.000Z");
		const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();
		assert.equal(catalogueIsUsable(at(0), now), true);
		assert.equal(catalogueIsUsable(at(-86_400_000 + 1), now), true, "a millisecond short of a day");
		assert.equal(catalogueIsUsable(at(-86_400_000), now), false, "a day old is not younger than a day");
		assert.equal(catalogueIsUsable(at(-86_400_000 - 1), now), false);
		assert.equal(catalogueIsUsable(at(60_000), now), true, "a minute of clock skew is tolerated");
		assert.equal(
			catalogueIsUsable(at(3_600_000), now),
			false,
			"an hour into the future is a clock that jumped, not a fresh price",
		);
		assert.equal(catalogueIsUsable("not a date", now), false);
	});

	it("maps a refusal to an HTTP status: 403 for the operator's denylist, 404 for an unknown id, 422 unpriced, 503 unavailable", () => {
		const expected: Record<ChatModelRefusalCode, number> = {
			model_denied: 403,
			model_not_found: 404,
			model_unpriced: 422,
			pricing_unavailable: 503,
			model_unavailable: 503,
		};
		for (const [code, status] of Object.entries(expected)) {
			assert.equal(chatModelRefusalStatus(code as ChatModelRefusalCode), status, code);
		}
	});

	it("reads the operator's denylist from the environment: exact ids and vendor/* patterns, case-insensitive", () => {
		assert.deepEqual(parseChatModelDenylist({}), []);
		assert.deepEqual(parseChatModelDenylist({ CHOREOGRAPH_CHAT_MODEL_DENYLIST: " OpenAI/O1-Pro , x-ai/* ,, " }), [
			"openai/o1-pro",
			"x-ai/*",
		]);
		const list = ["openai/o1-pro", "x-ai/*"];
		assert.equal(isChatModelDenied("openai/o1-pro", list), true);
		assert.equal(isChatModelDenied("OpenAI/O1-Pro", list), true);
		assert.equal(isChatModelDenied("openai/o1", list), false);
		assert.equal(isChatModelDenied("x-ai/grok-4", list), true);
		assert.equal(isChatModelDenied("x-ai", list), false);
	});
});

// ─── The catalogue the SPA reads ─────────────────────────────────────────────

function snapshot(ids?: readonly string[]) {
	const payload = realCatalogue(ids, CATALOGUE.fetchedAt);
	return { rows: payload.models, digest: CATALOGUE.digest, fetchedAt: payload.fetched_at, stale: false };
}

describe("a ~vendor/name-latest alias belongs to its vendor", () => {
	const ALIAS = "~openai/gpt-sol-latest";

	it("is denied by the vendor's wildcard, in either spelling, while an exact entry stays exact", () => {
		for (const entry of ["openai/*", "~openai/*"]) {
			assert.equal(isChatModelDenied(ALIAS, [entry]), true, `${entry} denies the alias`);
			assert.equal(isChatModelDenied("openai/gpt-5", [entry]), true, `${entry} denies the vendor's ordinary ids`);
		}
		assert.equal(isChatModelDenied(ALIAS, ["openai/gpt-sol-latest"]), false, "an exact entry names one id");
		assert.equal(isChatModelDenied(ALIAS, ["~openai/gpt-sol-latest"]), true);
		assert.equal(isChatModelDenied("~anthropic/claude-opus-latest", ["openai/*"]), false, "another vendor's alias");
		assert.equal(isChatModelDenied("~openai", ["openai/*"]), false);
	});

	it("is refused by the one rule when its vendor is denied, and is listed under its vendor when it is not", () => {
		const refused = assessChatModelRow(fullRow(ALIAS), {
			denylist: ["openai/*"],
			catalogue: { digest: CATALOGUE.digest, fetchedAt: FULL_CATALOGUE_FETCHED_AT },
			markupBps: DEFAULT_BILLING_MARKUP_BPS,
		});
		assert.ok(!refused.ok);
		assert.equal(`${refused.code}/${refused.reason}`, "model_denied/operator_denylist");

		const everything = (denylist: readonly string[], query = {}) =>
			projectChatModelCatalogue({
				snapshot: {
					rows: fullRows(),
					digest: CATALOGUE.digest,
					fetchedAt: FULL_CATALOGUE_FETCHED_AT,
					stale: false,
				},
				houseDefault: HOUSE,
				markupBps: DEFAULT_BILLING_MARKUP_BPS,
				denylist,
				query,
			});
		const denied = everything(["openai/*"]);
		assert.equal(
			denied.models.filter((model) => model.id.replace(/^~/, "").startsWith("openai/")).length,
			0,
			"no voice of a denied vendor is offered, alias or not",
		);
		const listed = everything([], { vendor: "openai" });
		const alias = listed.models.find((model) => model.id === ALIAS);
		assert.ok(alias, "vendor=openai includes the vendor's aliases");
		assert.equal(alias.vendor, "openai", "the vendor is openai, not ~openai");
		assert.ok(listed.models.every((model) => model.vendor === "openai"));
	});
});

describe("the catalogue of voices never offers an id that admission would refuse", () => {
	it("leaves out a row whose id is not a model id, however well it is priced", () => {
		const good = rowOf("google/gemini-2.5-flash");
		const listing = projectChatModelCatalogue({
			snapshot: {
				rows: [good, { ...good, id: "has space/in it", canonical_id: null, name: "Bad" }],
				digest: CATALOGUE.digest,
				fetchedAt: CATALOGUE.fetchedAt,
				stale: false,
			},
			houseDefault: HOUSE,
			markupBps: DEFAULT_BILLING_MARKUP_BPS,
			denylist: [],
		});
		assert.deepEqual(
			listing.models.map((model) => model.id),
			["google/gemini-2.5-flash"],
		);
	});
});

describe("the catalogue of voices", () => {
	const view = (extra: Partial<Parameters<typeof projectChatModelCatalogue>[0]> = {}) =>
		projectChatModelCatalogue({
			snapshot: snapshot(),
			houseDefault: HOUSE,
			markupBps: DEFAULT_BILLING_MARKUP_BPS,
			denylist: [],
			...extra,
		});

	it("lists every admissible model of the live catalogue and none of the others, House default marked", () => {
		const listing = view();
		assert.equal(listing.schema, CHAT_MODEL_CATALOGUE_SCHEMA);
		assert.equal(listing.provider, "openrouter");
		assert.equal(listing.catalogDigest, CATALOGUE.digest);
		assert.equal(listing.stale, false);
		assert.deepEqual(
			listing.models.map((model) => model.id),
			ADMISSIBLE,
		);
		assert.equal(listing.count, ADMISSIBLE.length);
		assert.deepEqual(listing.houseDefault, { provider: "openrouter", model: HOUSE.model, admissible: true });
		assert.deepEqual(listing.pricing, {
			currency: "USD",
			unit: "per-million-tokens",
			source: "openrouter-live-catalogue",
			markupPercent: 15,
			markupBps: 1500,
			precision: { values: ["any", "full"], default: "any", fullQuantizations: ["fp8", "fp16", "bf16", "fp32"] },
		});
		assert.deepEqual(
			listing.models.filter((model) => model.houseDefault).map((model) => model.id),
			[HOUSE.model],
		);
	});

	it("gives each model id, name, provider, vendor, context, the price a person pays per million, tools, tiers and houseDefault", () => {
		const listing = view();
		const gemini = listing.models.find((model) => model.id === "google/gemini-2.5-flash");
		assert.deepEqual(gemini, {
			id: "google/gemini-2.5-flash",
			name: "Google: Gemini 2.5 Flash",
			provider: "openrouter",
			vendor: "google",
			contextLength: 1_048_576,
			maxCompletionTokens: 65_535,
			promptPerMillionUsd: 0.345,
			completionPerMillionUsd: 2.875,
			tools: true,
			reasoning: true,
			inputModalities: ["file", "image", "text", "audio", "video"],
			houseDefault: true,
			tiered: false,
			// No provider listing on this host: `any` only, the entry's own prices, nobody named.
			precisions: [
				{ precision: "any", promptPerMillionUsd: 0.345, completionPerMillionUsd: 2.875, providers: null },
			],
		});
		const kimi = listing.models.find((model) => model.id === "moonshotai/kimi-k2.5");
		assert.equal(kimi?.vendor, "moonshotai");
		assert.equal(kimi?.contextLength, 262_144);
		assert.equal(kimi?.promptPerMillionUsd, 0.5175, "$0.45/M plus today's 15%");
		assert.equal(kimi?.completionPerMillionUsd, 2.5875, "$2.25/M plus today's 15%");
		assert.equal(kimi?.houseDefault, false);
		assert.equal(
			listing.models.find((model) => model.id === "anthropic/claude-sonnet-4.5")?.tiered,
			true,
			"its prices rise above 200,000 tokens",
		);
	});

	it("shows the price a person is charged: the provider's rate plus the operator's markup, rounded up to a micro-dollar", () => {
		const listing = view({ markupBps: 1500 });
		const gemini = listing.models.find((model) => model.id === "google/gemini-2.5-flash");
		assert.equal(gemini?.promptPerMillionUsd, 0.345);
		assert.equal(gemini?.completionPerMillionUsd, 2.875);
		assert.equal(listing.pricing.markupPercent, 15);
		assert.equal(listing.pricing.markupBps, 1500);
		const deepseek = view().models.find((model) => model.id === "deepseek/deepseek-chat");
		assert.equal(deepseek?.promptPerMillionUsd, 0.29601, "$0.2574/M plus today's 15%");
		assert.equal(deepseek?.completionPerMillionUsd, 1.183005, "$1.0287/M plus today's 15%");
		const dearer = view({ markupBps: 2000 }).models.find((model) => model.id === "deepseek/deepseek-chat");
		assert.equal(dearer?.promptPerMillionUsd, 0.30888, "$0.2574/M plus 20%");
		assert.equal(dearer?.completionPerMillionUsd, 1.23444, "$1.0287/M plus 20%");
	});

	it("says honestly when the House default is not one it would admit, with the reason", () => {
		const auto = view({ houseDefault: { provider: "openrouter", model: "openrouter/auto" } });
		assert.deepEqual(auto.houseDefault, {
			provider: "openrouter",
			model: "openrouter/auto",
			admissible: false,
			refusal: { code: "model_unpriced", reason: "price_dynamic" },
		});
		assert.equal(
			auto.models.some((model) => model.houseDefault),
			false,
		);
		const absent = view({ houseDefault: { provider: "openrouter", model: "vendor/not-a-model" } });
		assert.deepEqual(absent.houseDefault.refusal, { code: "model_not_found", reason: "not_in_catalogue" });
	});

	it("filters by search text and vendor, sorts, and limits, reporting how many matched", () => {
		assert.deepEqual(
			view({ query: { q: "KIMI" } }).models.map((model) => model.id),
			["moonshotai/kimi-k2", "moonshotai/kimi-k2.5"],
		);
		assert.deepEqual(
			view({ query: { vendor: "anthropic" } }).models.map((model) => model.id),
			["anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-4.5"],
		);
		const limited = view({ query: { limit: 3 } });
		assert.equal(limited.models.length, 3);
		assert.equal(limited.count, ADMISSIBLE.length, "count is what matched, not what was returned");
		const cheapest = view({ query: { sort: "price", limit: 2 } });
		assert.deepEqual(
			cheapest.models.map((model) => model.id),
			["deepseek/deepseek-chat", "google/gemini-2.5-flash"],
		);
	});

	it("leaves out what the operator has denied", () => {
		const listing = view({ denylist: ["openai/*", "moonshotai/kimi-k2"] });
		assert.equal(
			listing.models.some((model) => model.id === "openai/gpt-5"),
			false,
		);
		assert.equal(
			listing.models.some((model) => model.id === "moonshotai/kimi-k2"),
			false,
		);
		assert.equal(
			listing.models.some((model) => model.id === "moonshotai/kimi-k2.5"),
			true,
		);
	});
});

// ─── Admission, through the real catalogue ───────────────────────────────────

const STATIC_BASELINE: PiCatalogModel = {
	id: "google/gemini-2.5-flash",
	name: "Gemini 2.5 Flash",
	api: "openai-completions",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
	contextWindow: 1_048_576,
	maxTokens: 65_536,
};

async function withCatalogue(
	run: (catalogue: OpenRouterModelCatalog) => Promise<void>,
	options: { live?: () => ReturnType<typeof realCatalogue>; failEverything?: boolean } = {},
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "chat-models-"));
	const staticOnly = mergeOpenRouterModelCatalogs([STATIC_BASELINE], []);
	const catalogue = new OpenRouterModelCatalog({
		snapshotPath: join(dir, "openrouter.json"),
		refreshOnInit: false,
		refreshIntervalMs: 0,
		authConfigured: true,
		loadCatalog: async ({ includeLive }) => {
			if (options.failEverything) throw new Error("the catalogue endpoint is down");
			return includeLive
				? (options.live ?? (() => realCatalogue()))()
				: {
						provider: "openrouter",
						fetched_at: new Date().toISOString(),
						auth_configured: true,
						catalog_count: 1,
						live_count: 0,
						models: staticOnly,
					};
		},
	});
	try {
		await catalogue.initialize();
		await run(catalogue);
	} finally {
		catalogue.close();
		await rm(dir, { recursive: true, force: true });
	}
}

async function refusalOf(run: () => Promise<unknown>): Promise<string> {
	try {
		await run();
	} catch (error) {
		if (error instanceof InvocationFault) {
			const reason = (error.details as { reason?: string } | undefined)?.reason;
			return `${error.status} ${error.code}${reason ? `/${reason}` : ""}`;
		}
		throw error;
	}
	return "admitted";
}

const admit = (
	catalogue: OpenRouterModelCatalog | undefined,
	input: { requested?: { provider: string; model: string }; denylist?: string[]; houseDefault?: typeof HOUSE } = {},
) =>
	admitWorkspaceChatInference({
		...(input.requested ? { requested: input.requested as never } : {}),
		houseDefault: input.houseDefault ?? HOUSE,
		catalog: catalogue,
		denylist: input.denylist ?? [],
		markupBps: DEFAULT_BILLING_MARKUP_BPS,
	});

const KIMI = { provider: "openrouter", model: "moonshotai/kimi-k2.5" };

describe("admitting a voice at invocation", () => {
	it("serves a live row for the House default even when the host has only booted its static catalogue", async () => {
		await withCatalogue(async (catalogue) => {
			const admission = await admit(catalogue);
			assert.equal(admission.source, "house-default");
			assert.deepEqual(admission.inference, HOUSE);
			assert.equal(admission.facts?.model, "google/gemini-2.5-flash");
			assert.equal(admission.facts?.contextLength, 1_048_576);
			assert.equal(admission.facts?.maxCompletionTokens, 65_535);
			assert.match(admission.facts?.catalogDigest ?? "", /^[0-9a-f]{64}$/);
			const card = admission.pricing?.card;
			assert.ok(card, "the House default is priced from the catalogue too");
			assert.equal(card.model, "google/gemini-2.5-flash");
			assert.equal(card.markupBps, 1500, "the House default is priced at today's fee");
			assert.equal(card.prices.prompt, "0.0000003");
			assert.equal(card.catalogue.digest, admission.facts?.catalogDigest);
			assert.deepEqual(parseRateCard(JSON.parse(JSON.stringify(card))), card);
		});
	});

	it("admits a requested model that resolves live with tools and prices, and pins what it was priced from", async () => {
		await withCatalogue(async (catalogue) => {
			const admission = await admit(catalogue, { requested: KIMI });
			assert.equal(admission.source, "requested");
			assert.deepEqual(admission.inference, { provider: "openrouter", model: "moonshotai/kimi-k2.5" });
			assert.deepEqual(admission.pricing?.card.prices, {
				prompt: "0.00000045",
				completion: "0.00000225",
				inputCacheRead: "0.00000007",
			});
			assert.equal(admission.facts?.contextLength, 262_144);
		});
	});

	it("hands back the exact snapshot bytes the card's catalogue digest names, so it can be archived", async () => {
		await withCatalogue(async (catalogue) => {
			const admission = await admit(catalogue, { requested: KIMI });
			const pricing = admission.pricing;
			assert.ok(pricing);
			const json = pricing.catalogueJson();
			assert.equal(createHash("sha256").update(json).digest("hex"), pricing.card.catalogue.digest);
			const core = JSON.parse(json) as {
				fetched_at: string;
				models: Array<{ id: string; pricing_raw: { prompt?: string } }>;
			};
			assert.equal(core.fetched_at, pricing.card.catalogue.fetchedAt);
			assert.equal(
				core.models.find((model) => model.id === "moonshotai/kimi-k2.5")?.pricing_raw.prompt,
				"0.00000045",
			);
		});
	});

	it("normalizes a canonical slug to the live route id the provider is called with", async () => {
		await withCatalogue(async (catalogue) => {
			const admission = await admit(catalogue, {
				requested: { provider: "openrouter", model: "moonshotai/kimi-k2.5-0127" },
			});
			assert.equal(admission.inference.model, "moonshotai/kimi-k2.5");
			assert.equal(admission.pricing?.card.model, "moonshotai/kimi-k2.5");
		});
	});

	it("refuses with a 4xx and a reason code: unknown, unpriced, no tools, free, denied, wrong provider, malformed", async () => {
		await withCatalogue(async (catalogue) => {
			const outcome = (provider: string, model: string, denylist: string[] = []) =>
				refusalOf(() => admit(catalogue, { requested: { provider, model }, denylist }));
			assert.equal(await outcome("openrouter", "vendor/not-a-model"), "404 model_not_found/not_in_catalogue");
			assert.equal(await outcome("openrouter", "openrouter/auto"), "422 model_unpriced/price_dynamic");
			assert.equal(await outcome("openrouter", "google/gemini-3.1-flash-image"), "422 model_unpriced/no_tools");
			assert.equal(await outcome("openrouter", "perplexity/sonar"), "422 model_unpriced/no_tools");
			assert.equal(await outcome("openrouter", "qwen/qwen3.8-27b:free"), "422 model_unpriced/zero_priced");
			assert.equal(await outcome("openrouter", "openai/gpt-5", ["openai/*"]), "403 model_denied/operator_denylist");
			assert.equal(await outcome("openai", "gpt-5"), "400 inference_provider_unsupported");
			assert.equal(await outcome("openrouter", "mock:done"), "400 inference_model_invalid");
			assert.equal(await outcome("openrouter", "has space/in it"), "400 inference_model_invalid");
			assert.equal(await outcome("openrouter", ""), "400 inference_model_invalid");
			assert.equal(await outcome("openrouter", "x".repeat(201)), "400 inference_model_invalid");
			assert.equal(await outcome("openrouter", "deepseek/deepseek-chat"), "admitted");
		});
	});

	it("refuses with 503 pricing_unavailable, retryable, when the host has no catalogue or cannot reach one", async () => {
		assert.equal(
			await refusalOf(() => admit(undefined, { requested: KIMI })),
			"503 pricing_unavailable/catalogue_missing",
		);
		await withCatalogue(
			async (catalogue) => {
				assert.equal(
					await refusalOf(() => admit(catalogue, { requested: KIMI })),
					"503 pricing_unavailable/catalogue_missing",
				);
				assert.equal(
					await refusalOf(() => admit(catalogue)),
					"503 model_house_default_unavailable/catalogue_missing",
				);
			},
			{ failEverything: true },
		);
	});

	it("refuses prices older than a day, and takes ones a little younger", async () => {
		const hours = (count: number) => new Date(Date.now() - count * 3_600_000).toISOString();
		await withCatalogue(
			async (catalogue) => {
				assert.equal(
					await refusalOf(() => admit(catalogue, { requested: KIMI })),
					"503 pricing_unavailable/catalogue_stale",
				);
				assert.equal(
					await refusalOf(() => admit(catalogue)),
					"503 model_house_default_unavailable/catalogue_stale",
				);
			},
			{ live: () => realCatalogue(undefined, hours(25)) },
		);
		await withCatalogue(
			async (catalogue) => {
				assert.equal(await refusalOf(() => admit(catalogue, { requested: KIMI })), "admitted");
			},
			{ live: () => realCatalogue(undefined, hours(23)) },
		);
	});

	it("asks the provider once more before saying a model is unknown, as resolveModel does", async () => {
		let calls = 0;
		await withCatalogue(
			async (catalogue) => {
				await catalogue.refresh();
				const admission = await admit(catalogue, { requested: KIMI });
				assert.equal(admission.inference.model, "moonshotai/kimi-k2.5");
				assert.ok(calls >= 2, "the second load carried the model the first lacked");
			},
			{
				live: () => {
					calls += 1;
					return realCatalogue(calls === 1 ? ["google/gemini-2.5-flash"] : undefined);
				},
			},
		);
	});

	it("says the catalogue is unavailable, not that the model is unknown, when the second ask of the provider fails", async () => {
		let calls = 0;
		await withCatalogue(
			async (catalogue) => {
				await catalogue.refresh();
				assert.equal(
					await refusalOf(() => admit(catalogue, { requested: KIMI })),
					"503 pricing_unavailable/catalogue_missing",
					"absence was never established: the provider could not be asked, and a retry may succeed",
				);
				assert.equal(
					await refusalOf(() =>
						admit(catalogue, { requested: { provider: "openrouter", model: "vendor/not-a-model" } }),
					),
					"503 pricing_unavailable/catalogue_missing",
				);
			},
			{
				live: () => {
					calls += 1;
					if (calls > 1) throw new Error("the provider is unreachable");
					return realCatalogue(["google/gemini-2.5-flash"]);
				},
			},
		);
	});

	it("does not bill or serve the House default when it is not one the host would admit, and says why", async () => {
		await withCatalogue(async (catalogue) => {
			const ask = (model: string) => admit(catalogue, { houseDefault: { provider: "openrouter", model } });
			await assert.rejects(ask("openrouter/auto"), (error: unknown) => {
				assert.ok(error instanceof InvocationFault);
				assert.equal(error.status, 503);
				assert.equal(error.code, "model_house_default_unavailable");
				assert.deepEqual(error.details, { reason: "price_dynamic", code: "model_unpriced" });
				return true;
			});
			assert.equal(
				await refusalOf(() => ask("vendor/not-a-model")),
				"503 model_house_default_unavailable/not_in_catalogue",
			);
		});
	});

	it("keeps a mock House default (development) and a host with no catalogue working, unpinned and unpriced", async () => {
		await withCatalogue(async (catalogue) => {
			const mock = await admit(catalogue, { houseDefault: { provider: "openrouter", model: "mock:text" } });
			assert.deepEqual(mock.inference, { provider: "openrouter", model: "mock:text" });
			assert.equal(mock.facts, undefined);
			assert.equal(mock.pricing, undefined);
		});
		const bare = await admit(undefined, { houseDefault: { provider: "openrouter", model: "test/workspace-model" } });
		assert.equal(bare.facts, undefined);
		assert.equal(bare.pricing, undefined);
		assert.equal(bare.source, "house-default");
	});
});

// ─── The input, the advertisement, the registry ──────────────────────────────

function chatBody(extra: Record<string, unknown>) {
	return {
		input: { trigger: { kind: "sophia-cluster.message", text: "hello" }, interactionMode: "headed", ...extra },
	};
}

describe("the inference input on workspace-chat-v1", () => {
	it("advertises inference in meta.inputs, so a client can tell this host offers a choice of voice", () => {
		const inputs = compileWorkflow(WORKSPACE_CHAT_SCRIPT).meta.inputs as {
			properties: Record<
				string,
				{ type?: string; required?: string[]; additionalProperties?: boolean; properties?: Record<string, any> }
			>;
		};
		const inference = inputs.properties.inference;
		assert.equal(inference.type, "object");
		assert.deepEqual([...(inference.required ?? [])].sort(), ["model", "provider"]);
		assert.equal(inference.additionalProperties, false);
		assert.deepEqual(inference.properties?.provider.enum, ["openrouter"]);
	});

	it("parses { provider, model } and refuses a malformed shape as 400 workspace_chat_input_invalid", () => {
		assert.deepEqual(
			parseWorkspaceChatRequest(chatBody({ inference: { provider: "openrouter", model: "moonshotai/kimi-k2.5" } }))
				.inference,
			{ provider: "openrouter", model: "moonshotai/kimi-k2.5" },
		);
		assert.equal(parseWorkspaceChatRequest(chatBody({})).inference, undefined);
		const bad: unknown[] = [
			"kimi",
			[],
			{ provider: "openrouter" },
			{ model: "x/y" },
			{ provider: 5, model: "x/y" },
			{ provider: "openrouter", model: 5 },
			{ provider: "openrouter", model: "x/y", temperature: 2 },
		];
		for (const inference of bad) {
			assert.throws(
				() => parseWorkspaceChatRequest(chatBody({ inference })),
				(error: unknown) =>
					error instanceof InvocationFault &&
					error.status === 400 &&
					error.code === "workspace_chat_input_invalid",
				JSON.stringify(inference),
			);
		}
	});
});

describe("the registry states this host's defaults, limits and markup", () => {
	it("gives workspace-chat-v1 a host block: the House default voice, the limits a client needs and the markup in force", () => {
		const entry = listWorkflows().find((workflow) => workflow.name === WORKSPACE_CHAT_WORKFLOW_NAME) as
			| ({
					host?: { defaults?: { inference?: unknown }; limits?: Record<string, number>; pricing?: unknown };
			  } & Record<string, unknown>)
			| undefined;
		assert.ok(entry?.host);
		assert.deepEqual(entry.host.defaults?.inference, resolveWorkspaceChatInference());
		assert.deepEqual(Object.keys(entry.host.limits ?? {}).sort(), [
			"seedMaxBytes",
			"seedRenderMaxChars",
			"seedTtlSeconds",
			"titleMaxChars",
			"triggerTextMaxChars",
		]);
		assert.equal(entry.host.limits?.seedTtlSeconds, 3_600);
		assert.equal(entry.host.limits?.triggerTextMaxChars, 32_000);
		assert.deepEqual(entry.host.pricing, workspaceChatHostFacts().pricing);
		assert.deepEqual(workspaceChatHostFacts({}).pricing, { currency: "USD", markupPercent: 15, markupBps: 1500 });
		assert.deepEqual(workspaceChatHostFacts({ BILLING_FEE_BPS: "1250" }).pricing, {
			currency: "USD",
			markupPercent: 12.5,
			markupBps: 1250,
		});
		assert.deepEqual(workspaceChatHostFacts({ BILLING_FEE_BPS: "2000" }).pricing, {
			currency: "USD",
			markupPercent: 20,
			markupBps: 2000,
		});
		for (const other of listWorkflows().filter((workflow) => workflow.name !== WORKSPACE_CHAT_WORKFLOW_NAME)) {
			assert.equal((other as { host?: unknown }).host, undefined, `${other.name} has no host block`);
		}
	});
});

describe("the price a chat is billed at is the host's to state, never a script's", () => {
	const semantic = makeTestAgentSemanticBinding({ graphId: "g1", kind: "prime", registeredName: "stamp" });

	function cardFor(id: string) {
		const assessment = assess(rowOf(id));
		assert.ok(assessment.ok);
		return assessment.card;
	}

	const genuine = cardFor("moonshotai/kimi-k2.5");
	const forged = { ...genuine, markupBps: 0 };
	const spec: AgentNodeSpec = {
		label: "pilot-headed",
		phaseIndex: 1,
		prompt: "hello",
		model: "moonshotai/kimi-k2.5",
		provider: "openrouter",
		graphId: "g1",
		...semantic,
		pricing: forged,
	};
	const host = (pricing?: typeof genuine): WorkspaceChatHostContextV1 => ({
		schema: "sophia.workspace-chat-host-context.v1",
		agentId: "agent",
		graphId: "g1",
		tools: [],
		mode: { mode: {} as never, digest: "sha256:mode" },
		...(pricing ? { pricing } : {}),
	});

	it("drops a card a script put on its spec and stamps the one the host admitted", () => {
		assert.equal(stampWorkspaceChatSpec(spec, host()).pricing, undefined, "no host card, no card");
		assert.deepEqual(stampWorkspaceChatSpec(spec, host(genuine)).pricing, genuine);
		assert.equal(
			stampWorkspaceChatSpec(spec, host(genuine)).pricing?.markupBps,
			1500,
			"the forged 0% never survives",
		);
	});
});

// ─── The model in the events ─────────────────────────────────────────────────

describe("each turn's events name the voice that spoke", () => {
	const semantic = makeTestAgentSemanticBinding({ graphId: "g1", kind: "prime", registeredName: "voices" });
	const spec: AgentNodeSpec = {
		label: "pilot-headed",
		phaseIndex: 1,
		prompt: "hello",
		model: "moonshotai/kimi-k2.5",
		provider: "openrouter",
		graphId: "g1",
		sessionId: "ags-voices",
		...semantic,
	};
	const agentEvent = (event: Record<string, unknown>): BusEvent =>
		({
			category: "agent",
			type: String(event.type),
			sandbox_id: "sb-1",
			ts: new Date(1000).toISOString(),
			event,
		}) as unknown as BusEvent;

	it("adds model and provider to a turn's start, its end and its completed message, and to nothing else", () => {
		const started = mirrorAgentSessionEvent(agentEvent({ type: "turn_start", turn: 1 }), spec);
		assert.deepEqual(started?.payload.value, { turn: 1, model: "moonshotai/kimi-k2.5", provider: "openrouter" });
		const ended = mirrorAgentSessionEvent(agentEvent({ type: "turn_end", turn: 1 }), spec);
		assert.deepEqual(ended?.payload.value, { turn: 1, model: "moonshotai/kimi-k2.5", provider: "openrouter" });
		const done = mirrorAgentSessionEvent(agentEvent({ type: "done", output: "the answer" }), spec);
		assert.deepEqual(done?.type, "message.completed");
		assert.deepEqual(done?.payload.value, {
			output: "the answer",
			model: "moonshotai/kimi-k2.5",
			provider: "openrouter",
		});
		const delta = mirrorAgentSessionEvent(agentEvent({ type: "text", content: "the" }), spec);
		assert.deepEqual(delta?.payload.value, { delta: "the" });
		const tool = mirrorAgentSessionEvent(agentEvent({ type: "tool_call", gate: "read_document", args: {} }), spec);
		assert.deepEqual(tool?.payload.value, { tool: "read_document" });
	});

	it("names only the model when the spec records no provider", () => {
		const { provider: _provider, ...withoutProvider } = spec;
		const started = mirrorAgentSessionEvent(agentEvent({ type: "turn_start", turn: 2 }), withoutProvider);
		assert.deepEqual(started?.payload.value, { turn: 2, model: "moonshotai/kimi-k2.5" });
	});
});

// ─── The route ───────────────────────────────────────────────────────────────

describe("GET /api/models?view=chat", () => {
	async function get(url: string, ctx: Record<string, unknown>) {
		const response = recorder();
		await routeRequest(request("GET", url), response, ctx as never);
		return response;
	}

	it("serves the catalogue of voices from the host's trusted catalogue, with the House default and the markup in force", async () => {
		await withCatalogue(async (catalogue) => {
			const saved = {
				model: process.env.CHOREOGRAPH_WORKSPACE_CHAT_MODEL,
				markup: process.env.BILLING_FEE_BPS,
			};
			process.env.CHOREOGRAPH_WORKSPACE_CHAT_MODEL = "google/gemini-2.5-flash";
			process.env.BILLING_FEE_BPS = "1000";
			try {
				const response = await get("/api/models?view=chat", { modelCatalog: catalogue });
				assert.equal(response.statusCode, 200, JSON.stringify(response.body));
				assert.equal(response.headers["cache-control"], "private, max-age=60");
				assert.equal(response.body.schema, CHAT_MODEL_CATALOGUE_SCHEMA);
				assert.deepEqual(
					response.body.models.map((model: { id: string }) => model.id),
					ADMISSIBLE,
				);
				assert.deepEqual(response.body.houseDefault, {
					provider: "openrouter",
					model: "google/gemini-2.5-flash",
					admissible: true,
				});
				assert.equal(response.body.pricing.markupPercent, 10);
				assert.equal(response.body.pricing.markupBps, 1000);
				const gemini = response.body.models.find((model: { id: string }) => model.id === "google/gemini-2.5-flash");
				assert.equal(gemini.promptPerMillionUsd, 0.33);
				assert.equal(gemini.completionPerMillionUsd, 2.75);
				const filtered = await get("/api/models?view=chat&q=kimi&limit=1", { modelCatalog: catalogue });
				assert.equal(filtered.body.models.length, 1);
				assert.equal(filtered.body.count, 2);
				delete process.env.BILLING_FEE_BPS;
				const byDefault = await get("/api/models?view=chat", { modelCatalog: catalogue });
				assert.equal(byDefault.body.pricing.markupPercent, 15, "unset means today's 15%: the observe deploy");
				assert.equal(byDefault.body.pricing.markupBps, 1500);
				const defaultGemini = byDefault.body.models.find(
					(model: { id: string }) => model.id === "google/gemini-2.5-flash",
				);
				assert.equal(defaultGemini.promptPerMillionUsd, 0.345, "$0.30/M plus 15%");
				assert.equal(defaultGemini.completionPerMillionUsd, 2.875, "$2.50/M plus 15%");
				process.env.BILLING_FEE_BPS = "2000";
				const flipped = await get("/api/models?view=chat", { modelCatalog: catalogue });
				assert.equal(flipped.body.pricing.markupPercent, 20, "the flip's value: the listing turns over with it");
				assert.equal(flipped.body.pricing.markupBps, 2000);
				const flippedGemini = flipped.body.models.find(
					(model: { id: string }) => model.id === "google/gemini-2.5-flash",
				);
				assert.equal(flippedGemini.promptPerMillionUsd, 0.36, "$0.30/M plus 20%");
				assert.equal(flippedGemini.completionPerMillionUsd, 3, "$2.50/M plus 20%");
			} finally {
				if (saved.model === undefined) delete process.env.CHOREOGRAPH_WORKSPACE_CHAT_MODEL;
				else process.env.CHOREOGRAPH_WORKSPACE_CHAT_MODEL = saved.model;
				if (saved.markup === undefined) delete process.env.BILLING_FEE_BPS;
				else process.env.BILLING_FEE_BPS = saved.markup;
			}
		});
	});

	it("says 503 without a catalogue, and 503 pricing_unavailable when its prices are older than a day", async () => {
		const none = await get("/api/models?view=chat", {});
		assert.equal(none.statusCode, 503);
		assert.equal(none.body.error.code, "model_catalogue_unavailable");
		await withCatalogue(
			async (catalogue) => {
				const stale = await get("/api/models?view=chat", { modelCatalog: catalogue });
				assert.equal(stale.statusCode, 503);
				assert.equal(stale.body.error.code, "pricing_unavailable");
				assert.equal(stale.body.error.details.reason, "catalogue_stale");
			},
			{ live: () => realCatalogue(undefined, new Date(Date.now() - 25 * 3_600_000).toISOString()) },
		);
	});

	it("says 503 model_catalogue_unavailable, not 200 and empty, when only the bundled catalogue could be had", async () => {
		await withCatalogue(
			async (catalogue) => {
				const offline = await get("/api/models?view=chat", { modelCatalog: catalogue });
				assert.equal(offline.statusCode, 503, JSON.stringify(offline.body).slice(0, 200));
				assert.equal(offline.body.error.code, "model_catalogue_unavailable");
			},
			{
				live: () => {
					throw new Error("the provider is unreachable");
				},
			},
		);
	});

	it("says 400 for a view it does not know or a bad limit or sort", async () => {
		await withCatalogue(async (catalogue) => {
			const unknown = await get("/api/models?view=nonsense", { modelCatalog: catalogue });
			assert.equal(unknown.statusCode, 400);
			assert.equal(unknown.body.error.code, "invalid_view");
			const limit = await get("/api/models?view=chat&limit=0", { modelCatalog: catalogue });
			assert.equal(limit.statusCode, 400);
			assert.equal(limit.body.error.code, "invalid_limit");
			const sort = await get("/api/models?view=chat&sort=cheapest", { modelCatalog: catalogue });
			assert.equal(sort.statusCode, 400);
			assert.equal(sort.body.error.code, "invalid_sort");
		});
	});

	it("leaves the existing unfiltered listing exactly as it was", async () => {
		await withCatalogue(async (catalogue) => {
			await catalogue.refresh();
			const response = await get("/api/models?sort=id&limit=500", { modelCatalog: catalogue });
			assert.equal(response.statusCode, 200);
			assert.equal(response.body.provider, "openrouter");
			assert.equal(response.body.models.length, Object.keys(REAL_OPENROUTER_ROWS).length);
			assert.equal(response.body.schema, undefined, "the gateway's projection still reads the same roster");
		});
	});
});
