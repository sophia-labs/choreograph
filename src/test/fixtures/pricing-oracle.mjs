#!/usr/bin/env node
/**
 * Independent reference for Sobremesa's catalogue pricing (the oracle behind the TypeScript tests).
 *
 * The host's rules live in src/billing-rate-card.ts and src/chat-models.ts. This script re-implements them
 * from `E-billing-enforce.md` section 4.3 with exact rational arithmetic (a BigInt numerator over a BigInt
 * denominator, reduced), where the host works in fixed-point BigInt (10^-30 dollars): two different
 * representations written separately, so a mistake made in one is unlikely to be made in both. It writes the
 * three fixtures the tests read; run it again to reproduce them:
 *
 *     node src/test/fixtures/pricing-oracle.mjs <catalogue.json>
 *
 * `<catalogue.json>` is either the public response of `GET https://openrouter.ai/api/v1/models` (no key;
 * `{ data: [...] }`), fetched on 2026-09-29: 464 models, or the trimmed fixture this script writes
 * (`openrouter-catalogue-20260929.json`, `{ models: [...] }`), which holds every field the rules read, so the
 * partition and the goldens reproduce from the repository alone. Public data, not hostile content.
 *
 * This oracle was first written in Python (`fractions.Fraction`). The release's Python boundary
 * (`deploy/check-python-boundary.mjs`) forbids Sophia-owned Python outside sandbox guest payloads, so it was
 * ported here; the port reproduces the Python original's three fixtures byte for byte.
 *
 * Outputs (next to this file):
 * - openrouter-catalogue-20260929.json   the rows, trimmed to the fields the host reads (descriptions dropped),
 *                                        pricing kept WHOLE and verbatim (strings, overrides and all).
 * - openrouter-catalogue-20260929.partition.json
 *                                        for every id: offered, or the first rule that refuses it.
 * - pricing-goldens.json                 named token cases with the exact cost the rules give, in integers.
 *
 * It can also be imported (`assess`, `eventCost`, `perMillionMicro`, `cardPrices`, `Rat`): the differential test
 * `billing-rate-card-differential.test.ts` holds the host's arithmetic to it over every offered model and tens of
 * thousands of token vectors. Importing it writes nothing; only running it as a script does.
 *
 * The rules, in the order the first failing one is reported:
 *   batch_variant, zero_priced (a free id, or a prompt or completion price of zero), price_missing / price_malformed
 *   (too large to bill: above $0.01 per token) / price_dynamic, no_tools, override_unmodelled (per override, key by
 *   key: price_malformed, then zero_priced for a tier's prompt or completion), override_time_window, price_malformed
 *   (a cache price), price_unmodelled, per_request_fee, reasoning_priced_separately, context_too_small,
 *   output_not_text and input_not_text (a row that does not say what it gives and takes is not shown to be text).
 * On the 2026-09-29 catalogue the first seven reproduce the billing map's counts (75 / 20 / 6 / 61 / 5 / 1 and 5
 * small-context) and the last group adds three refusals of its own: models whose output is not text alone.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const FETCHED_AT = "2026-09-29T20:00:00.000Z"; // fixed for determinism; the real fetch was on 2026-09-29

const PRICE_TEXT = /^\d{1,20}(\.\d{1,30})?$/;
const NEGATIVE_TEXT = /^-\d+(\.\d+)?$/;

const MODELLED_OVERRIDE_KEYS = new Set([
	"min_prompt_tokens",
	"prompt",
	"completion",
	"input_cache_read",
	"input_cache_write",
	"input_cache_write_1h",
]);
const BILLED_KEYS = ["prompt", "completion", "input_cache_read", "input_cache_write"];
const KNOWN_TOP_KEYS = new Set([
	"prompt",
	"completion",
	"request",
	"image",
	"audio",
	"web_search",
	"internal_reasoning",
	"input_cache_read",
	"input_cache_write",
	"input_cache_write_1h",
	"input_audio_cache",
	"image_output",
	"audio_output",
	"overrides",
]);
const MIN_CONTEXT = 32_000;
/** The dearest price, in USD per token, the host bills in any position: $0.01, or $10,000 per million tokens. */
const MAX_PRICE_TEXT = { numerator: 1n, denominator: 100n };

// ─── Exact rationals ─────────────────────────────────────────────────────────

function gcd(a, b) {
	let x = a < 0n ? -a : a;
	let y = b < 0n ? -b : b;
	while (y !== 0n) [x, y] = [y, x % y];
	return x;
}

/** A reduced fraction of two BigInts, never a float. Non-negative in every use below, so floor and truncation agree. */
class Rat {
	constructor(numerator, denominator = 1n) {
		if (denominator === 0n) throw new Error("zero denominator");
		let n = numerator;
		let d = denominator;
		if (d < 0n) {
			n = -n;
			d = -d;
		}
		const g = gcd(n, d) || 1n;
		this.n = n / g;
		this.d = d / g;
	}

	/** A decimal string already checked against PRICE_TEXT. */
	static decimal(text) {
		const [whole, fraction = ""] = text.split(".");
		return new Rat(BigInt(whole + fraction), 10n ** BigInt(fraction.length));
	}

	plus(other) {
		return new Rat(this.n * other.d + other.n * this.d, this.d * other.d);
	}

	times(other) {
		const o = other instanceof Rat ? other : new Rat(BigInt(other));
		return new Rat(this.n * o.n, this.d * o.d);
	}

	over(divisor) {
		return new Rat(this.n, this.d * BigInt(divisor));
	}

	equals(other) {
		return this.n === other.n && this.d === other.d;
	}

	compare(other) {
		const left = this.n * other.d;
		const right = other.n * this.d;
		return left < right ? -1 : left > right ? 1 : 0;
	}

	isZero() {
		return this.n === 0n;
	}

	/** Smallest integer not below this value. */
	ceil() {
		const quotient = this.n / this.d;
		return this.n % this.d === 0n ? quotient : quotient + 1n;
	}

	/** Python's `str(Fraction)`: `n` when whole, else `n/d` in lowest terms. */
	toString() {
		return this.d === 1n ? `${this.n}` : `${this.n}/${this.d}`;
	}
}

const ZERO = new Rat(0n);

function safeInteger(value) {
	const number = Number(value);
	if (!Number.isSafeInteger(number)) throw new Error(`${value} is not a safe integer`);
	return number;
}

// ─── The offer rule ──────────────────────────────────────────────────────────

/** A plain non-negative decimal, no dearer than the bound, as an exact Rat, or null. */
function parsePrice(text) {
	if (typeof text !== "string" || !PRICE_TEXT.test(text)) return null;
	const price = Rat.decimal(text);
	return price.compare(new Rat(MAX_PRICE_TEXT.numerator, MAX_PRICE_TEXT.denominator)) > 0 ? null : price;
}

function classifyPrice(text) {
	if (text === undefined || text === null) return "price_missing";
	if (typeof text !== "string") return "price_malformed";
	if (NEGATIVE_TEXT.test(text)) return "price_dynamic";
	if (parsePrice(text) === null) return "price_malformed";
	return null;
}

const has = (object, key) => Object.hasOwn(object, key);

/** null if the host would offer the model, else the reason code of the first rule that refuses it. */
function assess(model) {
	const pricing = model.pricing ?? {};
	const modelId = model.id;
	if (modelId.endsWith(":batch")) return "batch_variant";
	const prompt = parsePrice(pricing.prompt);
	const completion = parsePrice(pricing.completion);
	if (modelId.endsWith(":free") || (prompt !== null && prompt.isZero()) || (completion !== null && completion.isZero())) {
		return "zero_priced";
	}
	for (const key of ["prompt", "completion"]) {
		const bad = classifyPrice(pricing[key]);
		if (bad) return bad;
	}
	if (!(model.supported_parameters ?? []).includes("tools")) return "no_tools";
	const overrides = pricing.overrides ?? [];
	for (const entry of overrides) {
		const keys = Object.keys(entry);
		const hasWindow = keys.includes("utc_start") || keys.includes("utc_end");
		if (keys.some((key) => !MODELLED_OVERRIDE_KEYS.has(key) && key !== "utc_start" && key !== "utc_end")) {
			return "override_unmodelled";
		}
		const minimum = entry.min_prompt_tokens;
		if (!hasWindow && (typeof minimum !== "number" || !Number.isInteger(minimum) || minimum < 1)) {
			return "override_unmodelled";
		}
		for (const key of BILLED_KEYS) {
			if (!has(entry, key)) continue;
			const price = parsePrice(entry[key]);
			if (price === null) return "price_malformed";
			if ((key === "prompt" || key === "completion") && price.isZero()) return "zero_priced";
		}
	}
	if (overrides.some((entry) => has(entry, "utc_start") || has(entry, "utc_end"))) return "override_time_window";
	for (const key of ["input_cache_read", "input_cache_write"]) {
		if (has(pricing, key) && parsePrice(pricing[key]) === null) return "price_malformed";
	}
	if (Object.keys(pricing).some((key) => !KNOWN_TOP_KEYS.has(key))) return "price_unmodelled";
	if (has(pricing, "request")) {
		const request = parsePrice(pricing.request);
		if (request === null || request.compare(ZERO) > 0) return "per_request_fee";
	}
	if (has(pricing, "internal_reasoning")) {
		const reasoning = parsePrice(pricing.internal_reasoning);
		if (reasoning === null || completion === null || !reasoning.equals(completion)) {
			return "reasoning_priced_separately";
		}
	}
	const context = model.context_length || (model.top_provider ?? {}).context_length;
	if (typeof context !== "number" || !Number.isInteger(context) || context < MIN_CONTEXT) return "context_too_small";
	const arch = model.architecture ?? {};
	const outputs = arch.output_modalities;
	if (outputs === undefined || outputs === null || outputs.length === 0 || outputs.some((o) => o !== "text")) {
		return "output_not_text";
	}
	const inputs = arch.input_modalities;
	if (inputs === undefined || inputs === null || !inputs.includes("text")) return "input_not_text";
	return null;
}

// ─── The cost of one event ───────────────────────────────────────────────────

/** The prices the card pins: base, and one tier per override, each as exact Rats. */
function cardPrices(model) {
	const pricing = model.pricing;
	const base = {};
	for (const key of BILLED_KEYS) {
		if (has(pricing, key)) base[key] = parsePrice(pricing[key]);
	}
	const tiers = [];
	for (const entry of pricing.overrides ?? []) {
		const prices = {};
		for (const key of BILLED_KEYS) {
			if (has(entry, key)) prices[key] = parsePrice(entry[key]);
		}
		if (Object.keys(prices).length > 0) tiers.push([entry.min_prompt_tokens, prices]);
	}
	tiers.sort((a, b) => a[0] - b[0]); // stable, like the original's sort by minimum
	return { base, tiers };
}

/** Exact cost of one event in whole micro-USD, rounded up once (E section 4.3, rules 3, 5, 6, 8). */
function eventCost(model, tokens, markupBps) {
	const { base, tiers } = cardPrices(model);
	const promptTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite;
	const effective = { ...base };
	let chosen = null;
	for (const [minimum, prices] of tiers) {
		if (minimum <= promptTokens) chosen = prices;
	}
	if (chosen) Object.assign(effective, chosen);
	const promptPrice = effective.prompt;
	const parts = [
		promptPrice.times(tokens.input),
		effective.completion.times(tokens.output),
		(effective.input_cache_read ?? promptPrice).times(tokens.cacheRead),
		(effective.input_cache_write ?? promptPrice).times(tokens.cacheWrite),
	];
	// tokens x (USD per token) = USD; x 1e6 = micro-USD (exact)
	const micro = parts.map((part) => part.times(1_000_000));
	const providerExact = micro.reduce((sum, part) => sum.plus(part), ZERO);
	const provider = providerExact.ceil();
	const totalExact = providerExact.times(10_000 + markupBps).over(10_000);
	const total = totalExact.ceil();
	// Itemized parts by cumulative ceiling: they add up to `provider` exactly.
	let running = ZERO;
	let previous = 0n;
	const items = [];
	for (const part of micro) {
		running = running.plus(part);
		const current = running.ceil();
		items.push(current - previous);
		previous = current;
	}
	if (items.reduce((sum, item) => sum + item, 0n) !== provider) throw new Error("itemized parts do not sum to the provider cost");
	return {
		inputCostMicroUsd: safeInteger(items[0]),
		outputCostMicroUsd: safeInteger(items[1]),
		cacheReadCostMicroUsd: safeInteger(items[2]),
		cacheWriteCostMicroUsd: safeInteger(items[3]),
		providerCostMicroUsd: safeInteger(provider),
		markupMicroUsd: safeInteger(total - provider),
		costMicroUsd: safeInteger(total),
		exactProviderMicroUsd: providerExact.toString(),
		exactTotalMicroUsd: totalExact.toString(),
	};
}

/** Billed micro-USD per million tokens, rounded up: what the picker shows, never understated. */
function perMillionMicro(price, markupBps) {
	return safeInteger(price.times(1_000_000).times(1_000_000).times(10_000 + markupBps).over(10_000).ceil());
}

const CASES = [
	["flash-turn-one", "google/gemini-2.5-flash", 2000, [2228, 28, 0, 0]],
	["flash-turn-one-15pct", "google/gemini-2.5-flash", 1500, [2228, 28, 0, 0]],
	["flash-turn-one-no-markup", "google/gemini-2.5-flash", 0, [2228, 28, 0, 0]],
	["flash-turn-one-fractional-markup", "google/gemini-2.5-flash", 1750, [2228, 28, 0, 0]],
	["flash-cache-both-ways", "google/gemini-2.5-flash", 2000, [3000, 500, 42529, 46972]],
	["kimi-cache-read-listed", "moonshotai/kimi-k2.5", 2000, [3000, 400, 40000, 0]],
	["kimi-cache-write-not-listed", "moonshotai/kimi-k2.5", 2000, [3000, 400, 40000, 1000]],
	["sonnet45-below-tier", "anthropic/claude-sonnet-4.5", 2000, [150000, 900, 40000, 9999]],
	["sonnet45-at-tier", "anthropic/claude-sonnet-4.5", 2000, [150000, 900, 40000, 10000]],
	["sonnet45-above-tier", "anthropic/claude-sonnet-4.5", 2000, [200000, 2000, 30000, 20000]],
	["luna-tier", "openai/gpt-5.6-luna", 2000, [250000, 1200, 40000, 10000]],
	["nemo-under-a-micro-per-part", "mistralai/mistral-nemo", 0, [30, 10, 0, 0]],
	["nemo-under-a-micro-with-markup", "mistralai/mistral-nemo", 2000, [30, 10, 0, 0]],
	["nemo-large", "mistralai/mistral-nemo", 2000, [100000, 20000, 0, 0]],
	["opus45-heavy", "anthropic/claude-opus-4.5", 2000, [12000, 800, 90000, 4000]],
	["no-tokens", "google/gemini-2.5-flash", 2000, [0, 0, 0, 0]],
];

const VIABLE_INPUT = 15_000;
const VIABLE_OUTPUT = 256;
const VIABLE_FLOOR = 1_000;

// ─── Output, in the exact shape the tests read ───────────────────────────────

/** Python's `json.dumps(value, indent=0)`: one item per line, no indentation. */
function jsonIndentZero(value) {
	return JSON.stringify(value, null, 1).replace(/^ +/gm, "");
}

function sortedObject(entries) {
	return Object.fromEntries([...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

function main(source) {
	const raw = JSON.parse(readFileSync(resolve(source), "utf8"));
	const models = raw.data ?? raw.models;
	if (!Array.isArray(models)) throw new Error("expected { data: [...] } or { models: [...] }");
	const byId = new Map(models.map((model) => [model.id, model]));

	const trimmed = models.map((model) => {
		const arch = model.architecture ?? {};
		const top = model.top_provider ?? {};
		const entry = {
			id: model.id,
			canonical_slug: model.canonical_slug,
			name: model.name,
			created: model.created,
			pricing: model.pricing,
			context_length: model.context_length,
			// Only the top level drops absent values; a nested absent value is written as null.
			architecture: { input_modalities: arch.input_modalities ?? null, output_modalities: arch.output_modalities ?? null },
			top_provider: {
				context_length: top.context_length ?? null,
				max_completion_tokens: top.max_completion_tokens ?? null,
			},
			supported_parameters: model.supported_parameters,
		};
		return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined && value !== null));
	});
	writeFileSync(
		resolve(HERE, "openrouter-catalogue-20260929.json"),
		`${jsonIndentZero({ fetchedAt: FETCHED_AT, count: trimmed.length, models: trimmed })}\n`,
	);

	const offered = [];
	const refused = new Map();
	for (const model of models) {
		const reason = assess(model);
		if (reason === null) offered.push(model.id);
		else refused.set(model.id, reason);
	}
	const counts = new Map();
	for (const reason of refused.values()) counts.set(reason, (counts.get(reason) ?? 0) + 1);
	writeFileSync(
		resolve(HERE, "openrouter-catalogue-20260929.partition.json"),
		`${JSON.stringify(
			{
				total: models.length,
				offered: [...offered].sort(),
				refused: sortedObject(refused),
				counts: sortedObject(counts),
			},
			null,
			1,
		)}\n`,
	);

	const goldens = CASES.map(([name, modelId, markupBps, [input, output, cacheRead, cacheWrite]]) => {
		const model = byId.get(modelId);
		if (assess(model) !== null) throw new Error(`${modelId} is not offered`);
		const tokens = { input, output, cacheRead, cacheWrite };
		return { name, model: modelId, markupBps, tokens, expect: eventCost(model, tokens, markupBps) };
	});
	const viable = [];
	for (const modelId of [
		"google/gemini-2.5-flash",
		"moonshotai/kimi-k2.5",
		"mistralai/mistral-nemo",
		"anthropic/claude-opus-4.5",
	]) {
		for (const markupBps of [1500, 2000]) {
			const tokens = { input: VIABLE_INPUT, output: VIABLE_OUTPUT, cacheRead: 0, cacheWrite: 0 };
			const { costMicroUsd } = eventCost(byId.get(modelId), tokens, markupBps);
			viable.push({ model: modelId, markupBps, costMicroUsd, afterFloor: Math.max(costMicroUsd, VIABLE_FLOOR) });
		}
	}
	const perMillion = [];
	for (const modelId of [
		"google/gemini-2.5-flash",
		"moonshotai/kimi-k2.5",
		"mistralai/mistral-nemo",
		"deepseek/deepseek-chat",
	]) {
		const { base } = cardPrices(byId.get(modelId));
		perMillion.push({
			model: modelId,
			markupBps: 2000,
			promptMicroUsdPerMillion: perMillionMicro(base.prompt, 2000),
			completionMicroUsdPerMillion: perMillionMicro(base.completion, 2000),
		});
	}
	writeFileSync(
		resolve(HERE, "pricing-goldens.json"),
		`${JSON.stringify({ cases: goldens, viableCall: viable, perMillion }, null, 1)}\n`,
	);
	console.log(JSON.stringify({ total: models.length, offered: offered.length, refused: Object.fromEntries(counts) }, null, 1));
}

export { assess, cardPrices, eventCost, perMillionMicro, Rat };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 3) {
		console.error("usage: node pricing-oracle.mjs <openrouter-models.json | openrouter-catalogue-20260929.json>");
		process.exit(2);
	}
	main(process.argv[2]);
}
