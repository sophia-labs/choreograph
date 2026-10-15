import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeCost, MARKUP_PERCENT } from "../billing-pricing.js";
import {
	billedMicroUsdPerMillion,
	buildRateCard,
	classifyPriceText,
	computeRateCardCost,
	DEFAULT_BILLING_MARKUP_BPS,
	MIN_VIABLE_CALL,
	minimumViableCallCostMicroUsd,
	parsePriceText,
	parseRateCard,
	priceInferenceCall,
	RATE_CARD_SCHEMA,
	RateCardError,
	type RateCardV1,
	type RawPricing,
	rateCardFromSessionDocumentJson,
	rateCardFromSessionSource,
	rateCardVersion,
	resolveBillingMarkupBps,
	resolveBillingMarkupPercent,
} from "../billing-rate-card.js";
import { FULL_CATALOGUE_FETCHED_AT, fullRow, GOLDENS } from "./fixtures/openrouter-catalogue.fixture.js";

/**
 * The rate card a Session is priced by (Sobremesa sub-task 5, `E-billing-enforce.md` 4.3 and Appendix B).
 *
 * Prices are the catalogue's own decimal strings, read as exact decimals; a call's cost is computed exactly and
 * rounded UP to a whole micro-USD once. Every expected number below comes from `pricing-oracle.mjs`, an independent
 * implementation (exact rational arithmetic, where the host uses fixed-point), run over the real 2026-09-29 catalogue.
 */

const CATALOGUE = { digest: "0123456789abcdef".repeat(4), fetchedAt: FULL_CATALOGUE_FETCHED_AT };

function cardFor(id: string, markupBps = DEFAULT_BILLING_MARKUP_BPS): RateCardV1 {
	const built = buildRateCard({ model: id, pricing: fullRow(id).pricing_raw, catalogue: CATALOGUE, markupBps });
	assert.ok(built.ok, `${id} builds a card${built.ok ? "" : `: ${built.reason}`}`);
	return built.card;
}

const BASE: RawPricing = { prompt: "0.000001", completion: "0.000002" };

function reasonOf(pricing: RawPricing | null | undefined): string {
	const built = buildRateCard({ model: "vendor/m", pricing, catalogue: CATALOGUE, markupBps: 2000 });
	return built.ok ? "priced" : built.reason;
}

// ─── Exact decimals ──────────────────────────────────────────────────────────

describe("price text is read as an exact decimal, never a float", () => {
	it("scales a plain decimal to whole units of 10^-30 dollars, up to thirty places", () => {
		assert.equal(parsePriceText("0"), 0n);
		assert.equal(parsePriceText("1"), 10n ** 30n);
		assert.equal(parsePriceText("12.5"), 125n * 10n ** 29n);
		assert.equal(parsePriceText("0.0000003"), 3n * 10n ** 23n, "3e-7 is exactly 3e23, not 2.9999999999999998e23");
		assert.equal(
			parsePriceText("0.0000000833333333333333"),
			833_333_333_333_333n * 10n ** 8n,
			"the 22-place cache-write price of the House default survives whole",
		);
		assert.equal(parsePriceText(`0.${"0".repeat(29)}1`), 1n);
		assert.equal(parsePriceText("007"), 7n * 10n ** 30n);
	});

	it("refuses everything that is not a plain non-negative decimal", () => {
		const bad: unknown[] = [
			"",
			" 1",
			"1 ",
			"1e-7",
			"1E3",
			"-1",
			"+1",
			".5",
			"1.",
			"0x10",
			"1,5",
			"abc",
			`0.${"0".repeat(30)}1`,
			"1".repeat(21),
			5,
			null,
			undefined,
			{},
		];
		for (const value of bad) assert.equal(parsePriceText(value), undefined, JSON.stringify(value));
	});

	it("tells a missing price, a dynamic (negative) one and a malformed one apart", () => {
		assert.equal(classifyPriceText("0.5"), "ok");
		assert.equal(classifyPriceText("0"), "ok");
		assert.equal(classifyPriceText(undefined), "missing");
		assert.equal(classifyPriceText(null), "missing");
		assert.equal(classifyPriceText("-1"), "negative", "openrouter/auto is priced -1");
		assert.equal(classifyPriceText("-0.5"), "negative");
		assert.equal(classifyPriceText("abc"), "malformed");
		assert.equal(classifyPriceText("1e-7"), "malformed");
		assert.equal(classifyPriceText(""), "malformed");
		assert.equal(classifyPriceText(5), "malformed");
	});
});

// ─── The card ────────────────────────────────────────────────────────────────

describe("a price the ledger could not carry is refused at the door, not after a Session exists", () => {
	it("bills up to $10,000 per million tokens in any position, and refuses a dearer one as malformed", () => {
		const base = { prompt: "0.000001", completion: "0.000002" };
		assert.equal(reasonOf({ prompt: "0.01", completion: "0.01" }), "priced", "the bound itself is billable");
		for (const [label, pricing] of [
			["a prompt price above the bound", { ...base, prompt: "0.010000000001" }],
			["an absurd prompt price", { ...base, prompt: "9007199255" }],
			["a completion price above the bound", { ...base, completion: "0.02" }],
			["a cache read price above the bound", { ...base, input_cache_read: "0.02" }],
			["a cache write price above the bound", { ...base, input_cache_write: "0.02" }],
			["a tier price above the bound", { ...base, overrides: [{ min_prompt_tokens: 1000, prompt: "0.02" }] }],
		] as const) {
			assert.equal(reasonOf(pricing as RawPricing), "price_malformed", label);
		}
	});

	it("refuses a tier that prices the prompt or the completion at nothing", () => {
		const base = { prompt: "0.000001", completion: "0.000002" };
		assert.equal(reasonOf({ ...base, overrides: [{ min_prompt_tokens: 1000, prompt: "0" }] }), "zero_priced");
		assert.equal(reasonOf({ ...base, overrides: [{ min_prompt_tokens: 1000, completion: "0" }] }), "zero_priced");
		assert.equal(
			reasonOf({ ...base, overrides: [{ min_prompt_tokens: 1000, input_cache_read: "0" }] }),
			"priced",
			"free cache reads are a price like any other",
		);
	});
});

describe("building a card from a catalogue row's own price strings", () => {
	it("pins the model, the catalogue it came from, the markup, and the row's prices verbatim", () => {
		assert.deepEqual(cardFor("moonshotai/kimi-k2.5"), {
			schema: RATE_CARD_SCHEMA,
			version: "cat:0123456789ab@2026-09-29T20:00:00.000Z",
			provider: "openrouter",
			model: "moonshotai/kimi-k2.5",
			catalogue: { digest: CATALOGUE.digest, fetchedAt: CATALOGUE.fetchedAt },
			markupBps: 1500,
			prices: { prompt: "0.00000045", completion: "0.00000225", inputCacheRead: "0.00000007" },
			tiers: [],
			reasoning: "billed-as-completion",
			cacheFallback: "prompt",
		});
		assert.equal(rateCardVersion(CATALOGUE.digest, CATALOGUE.fetchedAt), "cat:0123456789ab@2026-09-29T20:00:00.000Z");
	});

	it("keeps the 22-place cache-write price whole and leaves out the dimensions a text chat never uses", () => {
		const flash = cardFor("google/gemini-2.5-flash");
		assert.deepEqual(flash.prices, {
			prompt: "0.0000003",
			completion: "0.0000025",
			inputCacheRead: "0.00000003",
			inputCacheWrite: "0.0000000833333333333333",
		});
		assert.deepEqual(flash.tiers, []);
		assert.equal(JSON.stringify(flash).includes("audio"), false);
		assert.equal(JSON.stringify(flash).includes("web_search"), false);
	});

	it("turns an override into a tier that replaces exactly the components it lists", () => {
		const sonnet = cardFor("anthropic/claude-sonnet-4.5");
		assert.deepEqual(sonnet.prices, {
			prompt: "0.000003",
			completion: "0.000015",
			inputCacheRead: "0.0000003",
			inputCacheWrite: "0.00000375",
		});
		assert.deepEqual(sonnet.tiers, [
			{
				minPromptTokens: 200_000,
				prices: {
					prompt: "0.000006",
					completion: "0.0000225",
					inputCacheRead: "0.0000006",
					inputCacheWrite: "0.0000075",
				},
			},
		]);
	});

	it("refuses to build a card, with a reason, when the row cannot be priced exactly", () => {
		assert.equal(reasonOf(undefined), "price_missing");
		assert.equal(reasonOf(null), "price_missing");
		assert.equal(reasonOf({ completion: "0.000002" }), "price_missing");
		assert.equal(reasonOf({ prompt: "0.000001" }), "price_missing");
		assert.equal(reasonOf({ prompt: "-1", completion: "-1" }), "price_dynamic");
		assert.equal(reasonOf({ prompt: "1e-7", completion: "0.000002" }), "price_malformed");
		assert.equal(reasonOf({ prompt: "0.000001", completion: `0.${"0".repeat(30)}1` }), "price_malformed");
		assert.equal(
			reasonOf({ ...BASE, video: "0.5" }),
			"price_unmodelled",
			"a new price dimension is refused until it is read",
		);
		assert.equal(reasonOf({ ...BASE, request: "0.005" }), "per_request_fee");
		assert.equal(reasonOf({ ...BASE, internal_reasoning: "0.000003" }), "reasoning_priced_separately");
		assert.equal(
			reasonOf({ ...BASE, overrides: [{ min_prompt_tokens: 1000, prompt: "0.000002", audio: "0.1" }] }),
			"override_unmodelled",
		);
		assert.equal(reasonOf({ ...BASE, overrides: [{ prompt: "0.000002" }] }), "override_unmodelled", "no threshold");
		assert.equal(
			reasonOf({ ...BASE, overrides: [{ min_prompt_tokens: 0, prompt: "0.000002" }] }),
			"override_unmodelled",
		);
		assert.equal(
			reasonOf({ ...BASE, overrides: [{ utc_start: 0, utc_end: 6, prompt: "0.000002" }] }),
			"override_time_window",
		);
		assert.equal(
			reasonOf({ ...BASE, overrides: [{ min_prompt_tokens: 1000, prompt: "abc" }] }),
			"price_malformed",
			"a tier's price is read as strictly as the base's",
		);
	});

	it("accepts what does not change the bill of a text turn", () => {
		assert.equal(reasonOf(BASE), "priced");
		assert.equal(reasonOf({ ...BASE, request: "0" }), "priced", "a zero per-request fee is no fee");
		assert.equal(reasonOf({ ...BASE, internal_reasoning: "0.000002" }), "priced", "reasoning billed as completion");
		for (const key of ["image", "audio", "web_search", "input_audio_cache", "image_output", "audio_output"]) {
			assert.equal(reasonOf({ ...BASE, [key]: "0.5" }), "priced", key);
		}
		assert.equal(reasonOf({ ...BASE, input_cache_write_1h: "0.000004" }), "priced");
	});

	it("reports the first failing rule when a row fails several", () => {
		assert.equal(reasonOf({ completion: "0.000002", request: "0.005", video: "1" }), "price_missing");
		assert.equal(
			reasonOf({ ...BASE, request: "0.005", overrides: [{ min_prompt_tokens: 1000, audio: "0.1" }] }),
			"override_unmodelled",
		);
		assert.equal(reasonOf({ ...BASE, video: "1", request: "0.005" }), "price_unmodelled");
		assert.equal(reasonOf({ ...BASE, request: "0.005", internal_reasoning: "0.000003" }), "per_request_fee");
	});
});

describe("parsing a card back is as strict as building one", () => {
	const card = cardFor("anthropic/claude-sonnet-4.5");

	it("round-trips a built card unchanged", () => {
		assert.deepEqual(parseRateCard(JSON.parse(JSON.stringify(card))), card);
	});

	it("refuses unknown keys, wrong constants, a version that is not the catalogue's, and bad prices or tiers", () => {
		const clone = () => JSON.parse(JSON.stringify(card)) as Record<string, any>;
		// [what is wrong, where, what to put there (undefined removes the key)]
		const broken: Array<[string, string[], unknown]> = [
			["an extra key", ["surcharge"], 1],
			["a missing key", ["tiers"], undefined],
			["another schema", ["schema"], "sophia.rate-card.v2"],
			["another provider", ["provider"], "openai"],
			["a version that is not the catalogue's", ["version"], "cat:ffffffffffff@2026-09-29T20:00:00.000Z"],
			["a digest that is not sha256 hex", ["catalogue", "digest"], "xyz"],
			["a fetch time that is not an ISO instant", ["catalogue", "fetchedAt"], "yesterday"],
			["a markup out of range", ["markupBps"], 100_001],
			["a fractional markup", ["markupBps"], 12.5],
			["a negative markup", ["markupBps"], -1],
			["no prompt price", ["prices", "prompt"], undefined],
			["a float price", ["prices", "completion"], 0.000015],
			["an exponent price", ["prices", "completion"], "1.5e-5"],
			["a negative price", ["prices", "inputCacheRead"], "-1"],
			["an extra price key", ["prices", "audio"], "0.1"],
			["a tier below one token", ["tiers", "0", "minPromptTokens"], 0],
			["a fractional tier threshold", ["tiers", "0", "minPromptTokens"], 1.5],
			["an empty tier", ["tiers", "0", "prices"], {}],
			["a tier with an extra key", ["tiers", "0", "note"], "x"],
			["tiers out of order", ["tiers"], [{ minPromptTokens: 300_000, prices: { prompt: "0.00001" } }]],
			["another reasoning rule", ["reasoning"], "free"],
			["another cache rule", ["cacheFallback"], "zero"],
			["a model that is not text", ["model"], 7],
			["a model of no name", ["model"], ""],
			["tiers that are not a list", ["tiers"], "none"],
		];
		for (const [label, path, replacement] of broken) {
			const value = clone();
			let node: Record<string, any> = value;
			for (const key of path.slice(0, -1)) node = node[key];
			const last = path[path.length - 1];
			if (label === "tiers out of order") node[last] = [...(replacement as unknown[]), ...node[last]];
			else if (replacement === undefined) delete node[last];
			else node[last] = replacement;
			assert.throws(
				() => parseRateCard(value),
				(error: unknown) => error instanceof RateCardError && error.code === "rate_card_invalid",
				label,
			);
		}
		assert.throws(() => parseRateCard(null), RateCardError);
		assert.throws(() => parseRateCard([]), RateCardError);
		assert.throws(() => parseRateCard("card"), RateCardError);
	});
});

// ─── The price of a call ─────────────────────────────────────────────────────

describe("a call's cost: exact, rounded up once", () => {
	it("reproduces every case of the independent oracle to the micro-dollar", () => {
		for (const example of GOLDENS.cases) {
			const cost = computeRateCardCost(cardFor(example.model, example.markupBps), example.tokens);
			assert.equal(cost.modelPriced, example.model, example.name);
			assert.equal(cost.pricedDefault, false, example.name);
			const { exactProviderMicroUsd: _p, exactTotalMicroUsd: _t, ...expected } = example.expect;
			assert.deepEqual(
				{
					inputCostMicroUsd: cost.inputCostMicroUsd,
					outputCostMicroUsd: cost.outputCostMicroUsd,
					cacheReadCostMicroUsd: cost.cacheReadCostMicroUsd,
					cacheWriteCostMicroUsd: cost.cacheWriteCostMicroUsd,
					providerCostMicroUsd: cost.providerCostMicroUsd,
					markupMicroUsd: cost.markupMicroUsd,
					costMicroUsd: cost.totalCostMicroUsd,
				},
				expected,
				example.name,
			);
		}
	});

	it("keeps the books in step: the parts add up to the provider cost, which plus the markup is the total", () => {
		for (const example of GOLDENS.cases) {
			const cost = computeRateCardCost(cardFor(example.model, example.markupBps), example.tokens);
			assert.equal(
				cost.inputCostMicroUsd + cost.outputCostMicroUsd + cost.cacheReadCostMicroUsd + cost.cacheWriteCostMicroUsd,
				cost.providerCostMicroUsd,
				example.name,
			);
			assert.equal(cost.providerCostMicroUsd + cost.markupMicroUsd, cost.totalCostMicroUsd, example.name);
			assert.ok(cost.markupMicroUsd >= 0, example.name);
		}
	});

	it("bills the House default's first live turn at 850 micro-dollars at today's 15%, where the static table said 848", () => {
		// 2,228 input tokens at $0.30/M = 668.4 and 28 output at $2.50/M = 70.0: 738.4 in all, +15% = 849.16, which rounds up.
		const tokens = { input: 2228, output: 28, cacheRead: 0, cacheWrite: 0 };
		const cost = computeRateCardCost(cardFor("google/gemini-2.5-flash"), tokens);
		assert.equal(cost.providerCostMicroUsd, 739);
		assert.equal(cost.markupMicroUsd, 111);
		assert.equal(cost.totalCostMicroUsd, 850);
		assert.equal(
			computeCost("google/gemini-2.5-flash", tokens).totalCostMicroUsd,
			848,
			"the static path, the same 15%, truncated: two micro-dollars under, never over",
		);
		assert.equal(
			computeRateCardCost(cardFor("google/gemini-2.5-flash", 2000), tokens).totalCostMicroUsd,
			887,
			"at 20%",
		);
		assert.equal(computeRateCardCost(cardFor("google/gemini-2.5-flash", 0), tokens).totalCostMicroUsd, 739);
	});

	it("rounds up once per call, not once per part: a cheap model's turn is never billed as nothing", () => {
		// mistral-nemo: 30 input tokens cost 0.57 micro-dollars and 10 output tokens 0.30. Truncating each part
		// bills 0 + 0; rounding each part up bills 1 + 1; the call as a whole is 0.87 and bills 1.
		const nemo = cardFor("mistralai/mistral-nemo", 0);
		const cost = computeRateCardCost(nemo, { input: 30, output: 10, cacheRead: 0, cacheWrite: 0 });
		assert.equal(cost.totalCostMicroUsd, 1);
		assert.equal(cost.inputCostMicroUsd + cost.outputCostMicroUsd, 1);
		for (const tokens of [
			{ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
			{ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 },
			{ input: 0, output: 0, cacheRead: 1, cacheWrite: 0 },
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 1 },
		]) {
			assert.ok(computeRateCardCost(nemo, tokens).totalCostMicroUsd >= 1, JSON.stringify(tokens));
		}
		assert.equal(
			computeRateCardCost(nemo, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }).totalCostMicroUsd,
			0,
			"no tokens, no charge",
		);
	});

	it("prices the 22-place cache-write price exactly", () => {
		// 46,972 tokens at $0.0000000833333333333333 = 3,914.3333333333317 micro-dollars, which bills as 3,915.
		const flash = cardFor("google/gemini-2.5-flash", 0);
		const cost = computeRateCardCost(flash, { input: 0, output: 0, cacheRead: 0, cacheWrite: 46_972 });
		assert.equal(cost.cacheWriteCostMicroUsd, 3915);
		assert.equal(cost.totalCostMicroUsd, 3915);
	});

	it("applies a tier from the threshold up, counting input, cache reads and cache writes together", () => {
		const at = (input: number) =>
			computeRateCardCost(cardFor("anthropic/claude-sonnet-4.5", 0), {
				input,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			}).totalCostMicroUsd;
		assert.equal(at(199_999), 599_997, "below the threshold: $3.00/M");
		assert.equal(at(200_000), 1_200_000, "at the threshold the tier applies: $6.00/M for every token");
		assert.equal(at(200_001), 1_200_006);
		const split = computeRateCardCost(cardFor("anthropic/claude-sonnet-4.5", 0), {
			input: 100_000,
			output: 0,
			cacheRead: 60_000,
			cacheWrite: 40_000,
		});
		assert.equal(split.inputCostMicroUsd, 600_000, "the tier's $6.00/M, reached only by the three counts together");
		assert.equal(split.cacheReadCostMicroUsd, 36_000, "cache reads at the tier's $0.60/M");
		assert.equal(split.cacheWriteCostMicroUsd, 300_000, "cache writes at the tier's $7.50/M");
	});

	it("bills a cache token with no listed cache price at the prompt price, never at zero", () => {
		// deepseek-chat lists no cache price at all.
		const deepseek = cardFor("deepseek/deepseek-chat", 0);
		assert.equal(deepseek.prices.inputCacheRead, undefined);
		const cost = computeRateCardCost(deepseek, { input: 0, output: 0, cacheRead: 1000, cacheWrite: 1000 });
		assert.equal(cost.cacheReadCostMicroUsd + cost.cacheWriteCostMicroUsd, 515, "2,000 tokens x $0.2574/M = 514.8");
		assert.ok(cost.cacheReadCostMicroUsd > 0 && cost.cacheWriteCostMicroUsd > 0);
	});

	it("never lets a dearer output make a call cheaper: cost is non-decreasing in every token count", () => {
		const card = cardFor("moonshotai/kimi-k2.5");
		let previous = -1;
		for (let output = 0; output <= 4000; output += 37) {
			const cost = computeRateCardCost(card, { input: 5000, output, cacheRead: 0, cacheWrite: 0 }).totalCostMicroUsd;
			assert.ok(cost >= previous, `output ${output}`);
			previous = cost;
		}
	});

	it("refuses token counts that are not non-negative integers", () => {
		const card = cardFor("google/gemini-2.5-flash");
		const good = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
		for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
			for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
				assert.throws(
					() => computeRateCardCost(card, { ...good, [field]: bad }),
					(error: unknown) => error instanceof RateCardError && error.code === "tokens_invalid",
					`${field}=${bad}`,
				);
			}
		}
	});
});

// ─── One function prices a call: the pin, or the static table for a legacy Session ───────────────

describe("pricing a call for a Session, pinned or legacy", () => {
	const tokens = { input: 2228, output: 28, cacheRead: 0, cacheWrite: 0 };

	it("prices a pinned Session from its card, and a Session with no card exactly as before", () => {
		const card = cardFor("google/gemini-2.5-flash");
		assert.deepEqual(
			priceInferenceCall({ card, model: "google/gemini-2.5-flash", provider: "openrouter", tokens }),
			computeRateCardCost(card, tokens),
		);
		assert.deepEqual(
			priceInferenceCall({ card: undefined, model: "google/gemini-2.5-flash", provider: "openrouter", tokens }),
			computeCost("google/gemini-2.5-flash", tokens, "openrouter"),
		);
		const legacy = priceInferenceCall({ card: undefined, model: "vendor/unknown", provider: "openrouter", tokens });
		assert.equal(
			legacy.pricedDefault,
			true,
			"the legacy path keeps its flagged fallback: only pinned Sessions are refused-not-billed",
		);
		assert.equal(
			priceInferenceCall({ card: undefined, model: "mock:done", provider: "openrouter", tokens }).totalCostMicroUsd,
			0,
		);
	});

	it("refuses to price a call with a card that belongs to another model or provider", () => {
		const card = cardFor("google/gemini-2.5-flash");
		assert.throws(
			() => priceInferenceCall({ card, model: "moonshotai/kimi-k2.5", provider: "openrouter", tokens }),
			(error: unknown) => error instanceof RateCardError && error.code === "rate_card_invalid",
		);
		assert.throws(
			() => priceInferenceCall({ card, model: "google/gemini-2.5-flash", provider: "lmstudio", tokens }),
			RateCardError,
		);
	});
});

describe("reading the pin off a Session", () => {
	const card = cardFor("moonshotai/kimi-k2.5");

	it("finds it in the document's source, and finds none on a legacy Session", () => {
		assert.deepEqual(rateCardFromSessionSource({ pricing: card, model: "moonshotai/kimi-k2.5" }), card);
		assert.equal(rateCardFromSessionSource({ model: "google/gemini-2.5-flash" }), undefined);
		assert.equal(rateCardFromSessionSource(undefined), undefined);
		assert.deepEqual(
			rateCardFromSessionDocumentJson(
				JSON.stringify({ schema: "choreograph.agent-session-document.v1", source: { pricing: card } }),
			),
			card,
		);
		assert.equal(rateCardFromSessionDocumentJson(JSON.stringify({ source: {} })), undefined);
		assert.equal(rateCardFromSessionDocumentJson(JSON.stringify({})), undefined);
	});

	it("refuses a pin that is malformed rather than pricing around it", () => {
		assert.throws(() => rateCardFromSessionSource({ pricing: { ...card, surcharge: 1 } }), RateCardError);
		assert.throws(() => rateCardFromSessionSource({ pricing: null }), RateCardError);
		assert.throws(() => rateCardFromSessionDocumentJson("{not json"), RateCardError);
	});
});

// ─── What the picker and the gate need ───────────────────────────────────────

describe("the smallest viable call, for a gate to compare a balance against", () => {
	it("is 15,000 input and 256 output tokens on the pinned rates, with a floor of a thousandth of a dollar", () => {
		assert.deepEqual({ ...MIN_VIABLE_CALL }, { inputTokens: 15_000, outputTokens: 256, floorMicroUsd: 1_000 });
		for (const example of GOLDENS.viableCall) {
			assert.equal(
				minimumViableCallCostMicroUsd({
					card: cardFor(example.model, example.markupBps),
					model: example.model,
					provider: "openrouter",
				}),
				example.afterFloor,
				`${example.model} at ${example.markupBps} bps`,
			);
		}
	});

	it("gives the House default $0.0059 at the old 15% and $0.0062 at 20%, and a legacy Session the static table's figure", () => {
		const house = (bps: number) =>
			minimumViableCallCostMicroUsd({
				card: cardFor("google/gemini-2.5-flash", bps),
				model: "google/gemini-2.5-flash",
				provider: "openrouter",
			});
		assert.equal(house(1500), 5911);
		assert.equal(house(2000), 6168);
		assert.equal(
			minimumViableCallCostMicroUsd({ model: "google/gemini-2.5-flash", provider: "openrouter" }),
			5911,
			"a legacy Session: the static table at its 15%",
		);
	});

	it("is never below the floor, however cheap the voice", () => {
		assert.equal(
			minimumViableCallCostMicroUsd({
				card: cardFor("mistralai/mistral-nemo"),
				model: "mistralai/mistral-nemo",
				provider: "openrouter",
			}),
			1_000,
		);
	});
});

describe("the price a person is shown per million tokens", () => {
	it("is the billed price in micro-dollars, rounded up so it is never understated", () => {
		for (const example of GOLDENS.perMillion) {
			const card = cardFor(example.model, example.markupBps);
			assert.equal(
				billedMicroUsdPerMillion(card.prices.prompt, example.markupBps),
				example.promptMicroUsdPerMillion,
				`${example.model} prompt`,
			);
			assert.equal(
				billedMicroUsdPerMillion(card.prices.completion, example.markupBps),
				example.completionMicroUsdPerMillion,
				`${example.model} completion`,
			);
		}
		assert.equal(
			billedMicroUsdPerMillion("0.0000000000000000000000000001", 2000),
			1,
			"a sliver rounds up, never to nothing",
		);
		assert.equal(billedMicroUsdPerMillion("0", 2000), 0);
	});
});

// ─── The markup ──────────────────────────────────────────────────────────────

describe("the operator's markup (BILLING_FEE_BPS, in basis points)", () => {
	it("is today's 15% unless the operator says otherwise: the observe deploy does not change what anyone is charged", () => {
		assert.equal(MARKUP_PERCENT, 15, "the deployed static table's fee, which a legacy Session keeps");
		assert.equal(
			DEFAULT_BILLING_MARKUP_BPS,
			MARKUP_PERCENT * 100,
			"one fee: the catalogue path is not a second constant",
		);
		assert.equal(DEFAULT_BILLING_MARKUP_BPS, 1500);
		assert.equal(resolveBillingMarkupBps({}), 1500);
		assert.equal(resolveBillingMarkupPercent({}), 15);
		assert.equal(
			resolveBillingMarkupBps({ BILLING_FEE_BPS: "2000" }),
			2000,
			"20% is the flip's word: BILLING_FEE_BPS=2000, set with BILLING_GATE_MODE=enforce",
		);
		assert.equal(resolveBillingMarkupBps({ BILLING_FEE_BPS: " 750 " }), 750);
		assert.equal(resolveBillingMarkupBps({ BILLING_FEE_BPS: "1725" }), 1725);
		assert.equal(resolveBillingMarkupBps({ BILLING_FEE_BPS: "0" }), 0, "zero is a choice");
		assert.equal(resolveBillingMarkupPercent({ BILLING_FEE_BPS: "750" }), 7.5);
	});

	it("falls back to the default on nonsense, never to zero and never to a guess", () => {
		for (const bad of ["-1", "abc", "", "  ", "Infinity", "NaN", "100001", "1e3", "12.5", "5%", "1,5"]) {
			assert.equal(resolveBillingMarkupBps({ BILLING_FEE_BPS: bad }), 1500, JSON.stringify(bad));
		}
		assert.equal(resolveBillingMarkupBps({ BILLING_FEE_BPS: "100000" }), 100_000, "the ceiling itself is allowed");
	});
});
