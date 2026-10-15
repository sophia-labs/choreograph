import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	buildRateCard,
	DEFAULT_BILLING_MARKUP_BPS,
	openRouterFallbackRouting,
	openRouterRoutingForRateCard,
	parseRateCard,
} from "../billing-rate-card.js";
import { admitWorkspaceChatInference, projectChatModelCatalogue } from "../chat-models.js";
import {
	type ChatVoiceMarket,
	FULL_PRECISION_QUANTIZATIONS,
	fullPrecisionEndpoint,
	type ModelEndpointsRow,
	normalizeEndpointsResponse,
	providersAtPrice,
} from "../chat-precision.js";
import { OpenRouterModelCatalog } from "../model-catalog.js";
import { routeRequest } from "../orchestrator.js";
import { InvocationFault } from "../workflow/invocation.js";
import {
	parseWorkspaceChatRequest,
	WORKSPACE_CHAT_SCRIPT,
	workspaceChatHostFacts,
} from "../workflow/workspace-chat.js";
import { recorder, request } from "./chat-runtime-fixture.js";
import { fullCatalogue } from "./fixtures/openrouter-catalogue.fixture.js";

/**
 * Precision, Vera's ruling of 2026-10-01 ("let people choose"): a voice is offered at `any` precision (today's card: the
 * model-level price OpenRouter lists, quantization allowed) and, where a provider publishes one, at `full` precision
 * (the cheapest live, tool-capable provider serving FP8 or better). The card a Session is pinned to names its precision,
 * and every call of that Session is routed to keep it. Named `precision`, not `tier`: `tiers` already means the
 * long-context price steps of a card. Real data: the endpoints of five voices as OpenRouter listed them on 2026-10-01.
 */

const ENDPOINTS = JSON.parse(
	readFileSync(new URL("./fixtures/openrouter-endpoints-20261001.json", import.meta.url), "utf8"),
) as { fetchedAt: string; models: Record<string, unknown> };

function endpointsOf(id: string): ModelEndpointsRow {
	const row = normalizeEndpointsResponse({ data: ENDPOINTS.models[id] }, ENDPOINTS.fetchedAt);
	assert.ok(row, `${id} has endpoints in the fixture`);
	return row;
}

const market = (overrides: Partial<ChatVoiceMarket> = {}): ChatVoiceMarket => ({
	endpoints: (id) => (ENDPOINTS.models[id] ? endpointsOf(id) : undefined),
	...overrides,
});

const CATALOGUE = { digest: "0123456789abcdef".repeat(4), fetchedAt: "2026-09-29T20:00:00.000Z" };

describe("which provider serves a voice at full precision", () => {
	it("counts FP8 or better as full, and never a provider that does not say", () => {
		assert.deepEqual([...FULL_PRECISION_QUANTIZATIONS], ["fp8", "fp16", "bf16", "fp32"]);
	});

	it("picks the cheapest live, tool-capable endpoint at FP8 or better (Kimi K2.6: StreamLake fp8, not Baidu fp4)", () => {
		const full = fullPrecisionEndpoint(endpointsOf("moonshotai/kimi-k2.6"));
		assert.ok(full);
		assert.equal(full.provider, "StreamLake");
		assert.equal(full.quantization, "fp8");
		assert.equal(full.pricing.prompt, "0.0000005985");
		assert.equal(full.pricing.completion, "0.00000252");
	});

	it("offers no full precision where every provider is quantized or does not publish its precision", () => {
		assert.equal(fullPrecisionEndpoint(endpointsOf("moonshotai/kimi-k2.5")), undefined, "int4 and unknown only");
		assert.equal(
			fullPrecisionEndpoint(endpointsOf("google/gemini-2.5-flash")),
			undefined,
			"the maker's own: unknown",
		);
	});

	it("names the providers a price belongs to, with their quantization", () => {
		const kimi = endpointsOf("moonshotai/kimi-k2.6");
		assert.deepEqual(providersAtPrice(kimi, { prompt: "0.00000043415", completion: "0.000001828" }), [
			{ name: "Baidu", quantization: "fp4" },
		]);
	});
});

describe("a card names its precision", () => {
	const fullCard = () => {
		const kimi = endpointsOf("moonshotai/kimi-k2.6");
		const endpoint = fullPrecisionEndpoint(kimi);
		assert.ok(endpoint);
		const built = buildRateCard({
			model: "moonshotai/kimi-k2.6",
			pricing: endpoint.pricing,
			catalogue: CATALOGUE,
			markupBps: 1500,
			precision: "full",
			route: {
				quantizations: [...FULL_PRECISION_QUANTIZATIONS],
				endpoint: {
					provider: endpoint.provider,
					tag: endpoint.tag,
					quantization: endpoint.quantization,
					listedAt: kimi.fetchedAt,
				},
			},
		});
		assert.ok(built.ok, built.ok ? "" : built.message);
		return built.card;
	};

	it("pins a full-precision card at the endpoint's own prices, and it reads back exactly", () => {
		const card = fullCard();
		assert.equal(card.precision, "full");
		assert.equal(card.prices.prompt, "0.0000005985");
		assert.equal(card.route?.endpoint.provider, "StreamLake");
		assert.deepEqual(parseRateCard(JSON.parse(JSON.stringify(card))), card);
	});

	it("reads a card admitted before precision existed as `any`, unchanged", () => {
		const built = buildRateCard({
			model: "moonshotai/kimi-k2.5",
			pricing: { prompt: "0.0000006", completion: "0.0000025" },
			catalogue: CATALOGUE,
			markupBps: 1500,
		});
		assert.ok(built.ok);
		assert.equal(built.card.precision, undefined);
		assert.deepEqual(parseRateCard(JSON.parse(JSON.stringify(built.card))), built.card);
	});

	it("refuses a card with a precision this host does not know, or a route on an `any` card", () => {
		const card = JSON.parse(JSON.stringify(fullCard()));
		assert.throws(() => parseRateCard({ ...card, precision: "ultra" }), /precision/);
		assert.throws(() => parseRateCard({ ...card, precision: "any" }), /route/);
		assert.throws(() => parseRateCard({ ...card, route: { ...card.route, quantizations: ["fp4"] } }), /quantization/);
	});

	it("routes a full card's calls to FP8 or better under its price, and its fallback without the price", () => {
		const card = fullCard();
		const routing = openRouterRoutingForRateCard(card);
		assert.deepEqual(routing.quantizations, ["fp8", "fp16", "bf16", "fp32"]);
		assert.equal(routing.sort, "price");
		assert.ok(routing.max_price.prompt >= 0.5985 && routing.max_price.prompt < 0.5986);
		const fallback = openRouterFallbackRouting(card);
		assert.deepEqual(fallback, {
			sort: "price",
			require_parameters: true,
			quantizations: ["fp8", "fp16", "bf16", "fp32"],
		});
	});

	it("routes an `any` card with no quantization rule, and its fallback with no rule at all", () => {
		const built = buildRateCard({
			model: "moonshotai/kimi-k2.5",
			pricing: { prompt: "0.0000006", completion: "0.0000025" },
			catalogue: CATALOGUE,
			markupBps: 1500,
		});
		assert.ok(built.ok);
		assert.equal(openRouterRoutingForRateCard(built.card).quantizations, undefined);
		assert.deepEqual(openRouterFallbackRouting(built.card), { sort: "price", require_parameters: true });
	});
});

describe("a chat asks for a precision", () => {
	const envelope = (inference: unknown) => ({
		trigger: { kind: "sophia-cluster.message", text: "hello" },
		inference,
	});

	it("accepts `any` and `full`, and refuses anything else", () => {
		assert.equal(
			parseWorkspaceChatRequest(envelope({ provider: "openrouter", model: "m/x", precision: "full" })).inference
				?.precision,
			"full",
		);
		assert.equal(
			parseWorkspaceChatRequest(envelope({ provider: "openrouter", model: "m/x", precision: "any" })).inference
				?.precision,
			"any",
		);
		assert.equal(
			parseWorkspaceChatRequest(envelope({ provider: "openrouter", model: "m/x" })).inference?.precision,
			undefined,
		);
		assert.throws(
			() => parseWorkspaceChatRequest(envelope({ provider: "openrouter", model: "m/x", precision: "ultra" })),
			(error: unknown) =>
				error instanceof InvocationFault && error.status === 400 && /precision/.test(error.message),
		);
	});

	it("is declared in the workflow's inputs, so the registry advertises it", () => {
		assert.match(WORKSPACE_CHAT_SCRIPT, /precision: \{ enum: \["any", "full"\] \}/);
	});

	it("is described on the registry's host block: the values, the default, what full means", () => {
		assert.deepEqual(workspaceChatHostFacts({}).precision, {
			values: ["any", "full"],
			default: "any",
			fullQuantizations: ["fp8", "fp16", "bf16", "fp32"],
		});
	});
});

async function withFullCatalogue(run: (catalogue: OpenRouterModelCatalog) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "chat-precision-"));
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

const HOUSE = { provider: "openrouter" as const, model: "google/gemini-2.5-flash" };

describe("admitting a voice at a precision", () => {
	it("pins a full-precision card from the endpoint OpenRouter lists, when one exists", async () => {
		await withFullCatalogue(async (catalogue) => {
			const admission = await admitWorkspaceChatInference({
				requested: { provider: "openrouter", model: "moonshotai/kimi-k2.6", precision: "full" },
				houseDefault: HOUSE,
				catalog: catalogue,
				denylist: [],
				markupBps: DEFAULT_BILLING_MARKUP_BPS,
				market: market(),
			});
			const card = admission.pricing?.card;
			assert.ok(card);
			assert.equal(card.precision, "full");
			assert.equal(card.prices.prompt, "0.0000005985");
			assert.equal(card.route?.endpoint.provider, "StreamLake");
		});
	});

	it("keeps today's card for `any`, and for a chat that names no precision", async () => {
		await withFullCatalogue(async (catalogue) => {
			for (const precision of ["any", undefined] as const) {
				const admission = await admitWorkspaceChatInference({
					requested: {
						provider: "openrouter",
						model: "moonshotai/kimi-k2.6",
						...(precision ? { precision } : {}),
					},
					houseDefault: HOUSE,
					catalog: catalogue,
					denylist: [],
					markupBps: DEFAULT_BILLING_MARKUP_BPS,
					market: market(),
				});
				assert.equal(admission.pricing?.card.precision, undefined, "an `any` card is today's card, unmarked");
			}
		});
	});

	it("refuses full precision where no provider offers it, before any run exists", async () => {
		await withFullCatalogue(async (catalogue) => {
			for (const model of ["google/gemini-2.5-flash", "moonshotai/kimi-k2.5"]) {
				assert.equal(
					await refusalOf(() =>
						admitWorkspaceChatInference({
							requested: { provider: "openrouter", model, precision: "full" },
							houseDefault: HOUSE,
							catalog: catalogue,
							denylist: [],
							markupBps: DEFAULT_BILLING_MARKUP_BPS,
							market: market(),
						}),
					),
					"422 model_unpriced/precision_unavailable",
					model,
				);
			}
		});
	});

	it("refuses full precision on a host that has not read the providers, rather than guessing", async () => {
		await withFullCatalogue(async (catalogue) => {
			assert.equal(
				await refusalOf(() =>
					admitWorkspaceChatInference({
						requested: { provider: "openrouter", model: "moonshotai/kimi-k2.6", precision: "full" },
						houseDefault: HOUSE,
						catalog: catalogue,
						denylist: [],
						markupBps: DEFAULT_BILLING_MARKUP_BPS,
					}),
				),
				"422 model_unpriced/precision_unavailable",
			);
		});
	});
});

describe("the catalogue of voices lists each voice's precisions", () => {
	it("gives `any` (today's price, its providers and their quantization) and `full` where it exists", async () => {
		await withFullCatalogue(async (catalogue) => {
			const view = projectChatModelCatalogue({
				snapshot: await catalogue.snapshotRows(),
				houseDefault: HOUSE,
				markupBps: 1500,
				denylist: [],
				market: market(),
			});
			const kimi = view.models.find((model) => model.id === "moonshotai/kimi-k2.6");
			assert.ok(kimi);
			assert.deepEqual(
				kimi.precisions.map((p) => p.precision),
				["any", "full"],
			);
			const [anyP, full] = kimi.precisions;
			assert.equal(
				anyP.promptPerMillionUsd,
				kimi.promptPerMillionUsd,
				"`any` is the price the entry has always shown",
			);
			assert.equal(
				full.promptPerMillionUsd,
				0.688275,
				"StreamLake's $0.5985 plus 15%, rounded up to a micro-dollar",
			);
			assert.deepEqual(full.providers, [{ name: "StreamLake", quantization: "fp8" }]);
			const gemini = view.models.find((model) => model.id === "google/gemini-2.5-flash");
			assert.deepEqual(
				gemini?.precisions.map((p) => p.precision),
				["any"],
				"the maker's own model: nothing to choose",
			);
			assert.deepEqual(view.pricing.precision, {
				values: ["any", "full"],
				default: "any",
				fullQuantizations: ["fp8", "fp16", "bf16", "fp32"],
			});
		});
	});

	it("lists only `any`, with no providers named, when the host has not read the providers", async () => {
		await withFullCatalogue(async (catalogue) => {
			const view = projectChatModelCatalogue({
				snapshot: await catalogue.snapshotRows(),
				houseDefault: HOUSE,
				markupBps: 1500,
				denylist: [],
			});
			const kimi = view.models.find((model) => model.id === "moonshotai/kimi-k2.6");
			assert.deepEqual(kimi?.precisions, [
				{
					precision: "any",
					promptPerMillionUsd: kimi?.promptPerMillionUsd,
					completionPerMillionUsd: kimi?.completionPerMillionUsd,
					providers: null,
				},
			]);
		});
	});
});

describe("GET /api/models?view=chat lists the precisions the host can price", () => {
	it("offers `full` on the live route once the host has read the providers, and only `any` before", async () => {
		await withFullCatalogue(async (catalogue) => {
			const get = async (ctx: Record<string, unknown>) => {
				const response = recorder();
				await routeRequest(request("GET", "/api/models?view=chat&q=kimi-k2.6"), response, ctx as never);
				assert.equal(response.statusCode, 200, JSON.stringify(response.body).slice(0, 300));
				const kimi = response.body.models.find((model: { id: string }) => model.id === "moonshotai/kimi-k2.6");
				assert.ok(kimi, "Kimi K2.6 is a voice");
				return kimi.precisions as { precision: string; providers: unknown }[];
			};
			const read = await get({ modelCatalog: catalogue, chatVoiceMarket: market() });
			assert.deepEqual(
				read.map((p) => p.precision),
				["any", "full"],
				"the route reads the providers the host keeps",
			);
			assert.deepEqual(read[1].providers, [{ name: "StreamLake", quantization: "fp8" }]);
			const blind = await get({ modelCatalog: catalogue });
			assert.deepEqual(
				blind.map((p) => p.precision),
				["any"],
			);
		});
	});
});
