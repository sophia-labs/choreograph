/**
 * Billing from the live catalogue: the rate card a Session is priced by (Sobremesa).
 *
 * A chat admitted from the live OpenRouter catalogue carries, in its Session document, a RATE CARD: the model's own
 * price strings exactly as the catalogue states them, the tiers it lists, the markup in force, and the catalogue
 * snapshot they came from. One function, `priceInferenceCall`, turns a call's token counts into a cost from that
 * card, and the runtime reads it in exactly three places (the reservation of the worst case, the settlement of
 * what happened, and the store's deterministic re-derivation of the billing event), so they cannot disagree. A
 * Session with no card is a legacy Session and keeps the static table in `billing-pricing.ts`, byte for byte.
 *
 * Arithmetic. A price is a plain decimal string in USD per token (`"0.0000000833333333333333"`, 22 places). It is
 * read as an exact decimal (a BigInt in units of 10^-30 dollars), never a float. A call's exact cost is the sum of
 * its parts, times the markup; it is rounded UP to a whole micro-dollar ONCE. The itemized parts are allocated by
 * cumulative ceiling so they add up to the provider cost exactly. A call that used anything is therefore never
 * billed as nothing, and no rounding is compounded.
 *
 * Refusal. A model whose price cannot be read exactly (missing, negative "dynamic", malformed, a per-request fee,
 * a dimension this host does not bill, an override that depends on the clock) gets no card. There is no fallback
 * rate.
 *
 * Pure: no I/O, no clock. Nothing here reads the environment except `resolveBillingMarkupBps` (the fee in force, `BILLING_FEE_BPS`)
 * when it is handed one.
 */

import {
	type CostBreakdown,
	computeCost,
	DEFAULT_BILLING_FEE_BPS,
	MAX_BILLING_FEE_BPS,
	resolveBillingFeeBps,
} from "./billing-pricing.js";
import { FULL_PRECISION_QUANTIZATIONS } from "./chat-precision.js";

export const RATE_CARD_SCHEMA = "sophia.rate-card.v1" as const;

/**
 * The fee on the provider's cost, in basis points: today's 15% until the flip. It is the static table's default fee
 * (`billing-pricing.ts`), one number for both paths, so that they cannot drift apart. The fee in force is a boot-time
 * setting, `BILLING_FEE_BPS` (Vera, 2026-10-03: 20% arrives at the flip, with enforcement, not at the deploy), and
 * every card pins the fee it was admitted at: a chat begun before the flip keeps billing at the 15% its card pinned,
 * a chat begun after it at 20%; a legacy (static-table) Session moves with the fee in force.
 */
export const DEFAULT_BILLING_MARKUP_BPS = DEFAULT_BILLING_FEE_BPS;
/** The largest markup an operator may configure (1000%); anything above it is a typo, not a policy. */
export const MAX_BILLING_MARKUP_BPS = MAX_BILLING_FEE_BPS;
export const MAX_RATE_CARD_TIERS = 16;
export const MAX_RATE_CARD_MODEL_CHARS = 200;

/**
 * The smallest viable call: what a gate compares a balance against before it lets a turn start. 15,000 input
 * tokens (a workspace's orientation plus a question) and 256 output tokens, at the pinned rates and markup, but
 * never less than a thousandth of a dollar.
 */
export const MIN_VIABLE_CALL = Object.freeze({ inputTokens: 15_000, outputTokens: 256, floorMicroUsd: 1_000 });

export type RateCardErrorCode = "rate_card_invalid" | "tokens_invalid" | "cost_out_of_range";

export class RateCardError extends Error {
	constructor(
		readonly code: RateCardErrorCode,
		message: string,
	) {
		super(message);
		this.name = "RateCardError";
	}
}

// ─── Exact decimals ──────────────────────────────────────────────────────────

const PRICE_SCALE_DIGITS = 30;
const PRICE_SCALE = 10n ** 30n;
/** A plain non-negative decimal: no sign, no exponent, no whitespace, at most 30 places. */
const PRICE_TEXT = /^\d{1,20}(?:\.\d{1,30})?$/;
const NEGATIVE_PRICE_TEXT = /^-\d+(?:\.\d+)?$/;

/** A price text as a whole number of 10^-30 dollars, or undefined if it is not a plain non-negative decimal. */
export function parsePriceText(text: unknown): bigint | undefined {
	if (typeof text !== "string" || !PRICE_TEXT.test(text)) return undefined;
	const dot = text.indexOf(".");
	const whole = dot === -1 ? text : text.slice(0, dot);
	const fraction = dot === -1 ? "" : text.slice(dot + 1);
	return BigInt(whole) * PRICE_SCALE + BigInt(fraction.padEnd(PRICE_SCALE_DIGITS, "0"));
}

/**
 * The dearest price, in USD per token, this host will bill in any position: $0.01, or $10,000 per million tokens (the
 * dearest model on offer is under $200 per million). A provider that states more has made a mistake, and a price that
 * large would overflow the ledger's integers on a single token: refused at the door, not after a Session exists.
 */
const MAX_BILLED_PRICE_SCALED = 10n ** 28n;

/** A price text the host will bill: a plain decimal, nothing above the bound. Zero is a decimal; callers decide on it. */
function billablePriceText(text: unknown): bigint | undefined {
	const scaled = parsePriceText(text);
	return scaled !== undefined && scaled <= MAX_BILLED_PRICE_SCALED ? scaled : undefined;
}

export type PriceTextClass = "ok" | "missing" | "negative" | "malformed";

export function classifyPriceText(text: unknown): PriceTextClass {
	if (text === undefined || text === null) return "missing";
	if (typeof text !== "string") return "malformed";
	if (parsePriceText(text) !== undefined) return "ok";
	return NEGATIVE_PRICE_TEXT.test(text) ? "negative" : "malformed";
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
	return (numerator + denominator - 1n) / denominator;
}

/** Scaled units (10^-30 dollars) per micro-dollar. */
const SCALED_PER_MICRO_USD = 10n ** 24n;

function safeNumber(value: bigint, what: string): number {
	const number = Number(value);
	if (!Number.isSafeInteger(number))
		throw new RateCardError("cost_out_of_range", `${what} exceeds the safe integer range`);
	return number;
}

// ─── The raw price object of a catalogue row ─────────────────────────────────

/** One entry of `pricing.overrides`, verbatim: strings (prices) and integers (thresholds, hours). */
export interface RawPriceOverride {
	readonly [key: string]: string | number;
}

/** A catalogue row's `pricing` object, verbatim: price strings, plus `overrides`. */
export interface RawPricing {
	readonly [key: string]: string | readonly RawPriceOverride[];
}

// ─── The card ────────────────────────────────────────────────────────────────

export interface RateCardPricesV1 {
	/** USD per input token: an exact decimal string, as the catalogue states it. */
	readonly prompt: string;
	/** USD per output token. Reasoning tokens are billed as output. */
	readonly completion: string;
	/** USD per cached prompt token read; absent when the provider lists none (billed at `prompt`, never at zero). */
	readonly inputCacheRead?: string;
	/** USD per prompt token written to the cache; absent when none is listed (billed at `prompt`). */
	readonly inputCacheWrite?: string;
}

export interface RateCardTierV1 {
	/** The tier applies once input + cache reads + cache writes reach this many tokens. */
	readonly minPromptTokens: number;
	/** The components the tier replaces; the rest stay as in the base prices. */
	readonly prices: Partial<RateCardPricesV1>;
}

export interface RateCardV1 {
	readonly schema: typeof RATE_CARD_SCHEMA;
	/** `cat:<12 hex of the catalogue digest>@<fetched at>`: stamped on every reservation and billing event. */
	readonly version: string;
	readonly provider: "openrouter";
	/** The catalogue id the provider is called with. */
	readonly model: string;
	readonly catalogue: { readonly digest: string; readonly fetchedAt: string };
	/** Markup on the provider's cost in basis points: 1500 is 15%. */
	readonly markupBps: number;
	readonly prices: RateCardPricesV1;
	readonly tiers: readonly RateCardTierV1[];
	/** The pinned reasoning rule: reasoning tokens are folded into the output count and billed as output. */
	readonly reasoning: "billed-as-completion";
	/** The pinned cache rule: a cache token without a listed price is billed at the prompt price. */
	readonly cacheFallback: "prompt";
	/**
	 * The precision this Session pays for (`chat-precision.ts`). Absent: `any`, the model-level price, which is every
	 * card admitted before precision existed. `full`: the price of the cheapest provider serving FP8 or better, named in
	 * `route`, and every call of the Session is routed to providers at that precision.
	 */
	readonly precision?: "any" | "full";
	/** A full-precision card's routing rule and the endpoint whose listed price it states. */
	readonly route?: RateCardRouteV1;
}

export interface RateCardRouteV1 {
	/** The quantizations a call may be served at (OpenRouter's `provider.quantizations`). */
	readonly quantizations: readonly string[];
	readonly endpoint: {
		readonly provider: string;
		readonly tag: string | null;
		readonly quantization: string;
		/** When the host read the provider listing the price came from (ISO instant). */
		readonly listedAt: string;
	};
}

export function rateCardVersion(digest: string, fetchedAt: string): string {
	return `cat:${digest.slice(0, 12)}@${fetchedAt}`;
}

export const RATE_CARD_VERSION_PATTERN = /^cat:[0-9a-f]{12}@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ─── Building a card from a catalogue row ────────────────────────────────────

/** Why a row's price cannot be read exactly enough to bill. A closed vocabulary, shared with the offer rule. */
export type PriceRefusalReason =
	| "price_missing"
	| "price_malformed"
	| "price_dynamic"
	| "zero_priced"
	| "price_unmodelled"
	| "override_unmodelled"
	| "override_time_window"
	| "per_request_fee"
	| "reasoning_priced_separately";

export interface PriceRefusal {
	readonly reason: PriceRefusalReason;
	readonly message: string;
}

export type RateCardBuild = { readonly ok: true; readonly card: RateCardV1 } | ({ readonly ok: false } & PriceRefusal);

/**
 * Price dimensions the catalogue lists that a text chat turn does not use (images, audio, web search) or that the
 * host handles by rule (`internal_reasoning`, `request`, `overrides`). A dimension not in this set is refused: a
 * new price the host has not read must not be billed around.
 */
const KNOWN_PRICE_KEYS: ReadonlySet<string> = new Set([
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

/**
 * Does an inference context carry an image? A card prices tokens of text; the catalogue's `image` price (per image
 * in, on models that take them) is a dimension the card does not hold, so a Session priced from a card may not send
 * one: the host refuses the request rather than let a provider bill what the ledger cannot. Pi's content blocks are
 * `text`, `image`, `thinking` and `toolCall`; only `image` is input the card has no price for.
 */
export function inferenceContextHasImages(context: unknown): boolean {
	if (!isRecord(context) || !Array.isArray(context.messages)) return false;
	return context.messages.some(
		(message) =>
			isRecord(message) &&
			Array.isArray(message.content) &&
			message.content.some((block) => isRecord(block) && block.type === "image"),
	);
}

/** What an override may replace and still be billed exactly (`input_cache_write_1h` is listed, and not billed). */
const MODELLED_OVERRIDE_KEYS: ReadonlySet<string> = new Set([
	"min_prompt_tokens",
	"prompt",
	"completion",
	"input_cache_read",
	"input_cache_write",
	"input_cache_write_1h",
]);

const BILLED_KEYS: ReadonlyArray<readonly [keyof RateCardPricesV1, string]> = [
	["prompt", "prompt"],
	["completion", "completion"],
	["inputCacheRead", "input_cache_read"],
	["inputCacheWrite", "input_cache_write"],
];

function refusal(reason: PriceRefusalReason, message: string): PriceRefusal {
	return { reason, message };
}

/** The first problem with the two prices every call needs, or undefined if both are exact decimals. */
export function checkBasePrices(pricing: RawPricing | null | undefined): PriceRefusal | undefined {
	for (const key of ["prompt", "completion"] as const) {
		const kind = classifyPriceText(pricing?.[key]);
		if (kind === "ok") {
			if (billablePriceText(pricing?.[key]) === undefined) {
				return refusal(
					"price_malformed",
					`the ${key} price is above $10,000 per million tokens, which no provider states`,
				);
			}
			continue;
		}
		if (kind === "missing") return refusal("price_missing", `the ${key} price is not stated`);
		if (kind === "negative") {
			return refusal("price_dynamic", `the ${key} price is negative: a dynamic price, with no fixed rate to bill`);
		}
		return refusal("price_malformed", `the ${key} price is not a plain decimal`);
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Build the card for a catalogue row's price object. Refuses, with a reason, what cannot be billed exactly; never
 * falls back. The order of checks is fixed (and mirrored by `pricing-oracle.mjs`): the two base prices, each
 * override (unmodelled keys, threshold, price text), time windows, cache price text, unknown price dimensions, a
 * per-request fee, a separately priced reasoning. Throws `RateCardError` only for a programming error (a
 * malformed digest, time or markup), never for data.
 */
export function buildRateCard(input: {
	readonly model: string;
	readonly pricing: RawPricing | null | undefined;
	readonly catalogue: { readonly digest: string; readonly fetchedAt: string };
	readonly markupBps: number;
	/** `full` with its `route` for a full-precision card; `any` (or nothing) for today's card, which stays unmarked. */
	readonly precision?: "any" | "full";
	readonly route?: RateCardRouteV1;
}): RateCardBuild {
	const { model, pricing, catalogue, markupBps } = input;
	assertProvenance(model, catalogue, markupBps);
	if (input.precision === "full") {
		if (!input.route) throw new RateCardError("rate_card_invalid", "a full-precision card needs its route");
		parseRoute(input.route, "route");
	} else if (input.route) {
		throw new RateCardError("rate_card_invalid", "a route belongs only to a full-precision card");
	}

	const base = checkBasePrices(pricing);
	if (base) return { ok: false, ...base };
	const raw = pricing as RawPricing;

	let entries: readonly unknown[] = [];
	if (raw.overrides !== undefined) {
		if (!Array.isArray(raw.overrides)) {
			return { ok: false, ...refusal("override_unmodelled", "the overrides are not a list") };
		}
		entries = raw.overrides;
	}
	let windowed = false;
	for (const entry of entries) {
		if (!isRecord(entry)) return { ok: false, ...refusal("override_unmodelled", "an override is not an object") };
		const keys = Object.keys(entry);
		const hasWindow = keys.includes("utc_start") || keys.includes("utc_end");
		const unmodelled = keys.filter(
			(key) => !MODELLED_OVERRIDE_KEYS.has(key) && key !== "utc_start" && key !== "utc_end",
		);
		if (unmodelled.length > 0) {
			return {
				ok: false,
				...refusal(
					"override_unmodelled",
					`an override prices a dimension this host does not bill: ${unmodelled.join(", ")}`,
				),
			};
		}
		if (!hasWindow && !isPositiveSafeInteger(entry.min_prompt_tokens)) {
			return { ok: false, ...refusal("override_unmodelled", "an override states no prompt-token threshold") };
		}
		for (const [, key] of BILLED_KEYS) {
			if (!(key in entry)) continue;
			const tierPrice = billablePriceText(entry[key]);
			if (tierPrice === undefined) {
				return {
					ok: false,
					...refusal(
						"price_malformed",
						`an override's ${key} price is not a plain decimal, or is above $10,000 per million tokens`,
					),
				};
			}
			if (tierPrice === 0n && (key === "prompt" || key === "completion")) {
				return {
					ok: false,
					...refusal("zero_priced", `an override prices ${key} at zero, which the ledger cannot bill`),
				};
			}
		}
		if (hasWindow) windowed = true;
	}
	if (windowed) {
		return {
			ok: false,
			...refusal("override_time_window", "an override applies at certain hours, which a fixed card cannot state"),
		};
	}

	for (const key of ["input_cache_read", "input_cache_write"] as const) {
		if (raw[key] !== undefined && billablePriceText(raw[key]) === undefined) {
			return {
				ok: false,
				...refusal(
					"price_malformed",
					`the ${key} price is not a plain decimal, or is above $10,000 per million tokens`,
				),
			};
		}
	}
	const unknown = Object.keys(raw).filter((key) => !KNOWN_PRICE_KEYS.has(key));
	if (unknown.length > 0) {
		return {
			ok: false,
			...refusal("price_unmodelled", `a price dimension this host has not read: ${unknown.join(", ")}`),
		};
	}
	if (raw.request !== undefined) {
		const request = parsePriceText(raw.request);
		if (request === undefined || request > 0n) {
			return {
				ok: false,
				...refusal("per_request_fee", "the model charges per request, which cannot be billed per token"),
			};
		}
	}
	if (raw.internal_reasoning !== undefined) {
		if (parsePriceText(raw.internal_reasoning) !== parsePriceText(raw.completion)) {
			return {
				ok: false,
				...refusal(
					"reasoning_priced_separately",
					"reasoning tokens are priced apart from output, which this host bills as one",
				),
			};
		}
	}

	const prices: { -readonly [K in keyof RateCardPricesV1]: RateCardPricesV1[K] } = {
		prompt: raw.prompt as string,
		completion: raw.completion as string,
	};
	if (typeof raw.input_cache_read === "string") prices.inputCacheRead = raw.input_cache_read;
	if (typeof raw.input_cache_write === "string") prices.inputCacheWrite = raw.input_cache_write;

	const tiers: RateCardTierV1[] = [];
	for (const entry of entries as ReadonlyArray<Record<string, unknown>>) {
		const tierPrices: { -readonly [K in keyof RateCardPricesV1]?: string } = {};
		for (const [field, key] of BILLED_KEYS) {
			if (typeof entry[key] === "string") tierPrices[field] = entry[key] as string;
		}
		if (Object.keys(tierPrices).length > 0) {
			tiers.push({ minPromptTokens: entry.min_prompt_tokens as number, prices: tierPrices });
		}
	}
	tiers.sort((left, right) => left.minPromptTokens - right.minPromptTokens);
	if (
		tiers.length > MAX_RATE_CARD_TIERS ||
		tiers.some((tier, index) => index > 0 && tier.minPromptTokens === tiers[index - 1].minPromptTokens)
	) {
		return { ok: false, ...refusal("override_unmodelled", "the overrides do not form a clean ladder of thresholds") };
	}

	return {
		ok: true,
		card: {
			schema: RATE_CARD_SCHEMA,
			version: rateCardVersion(catalogue.digest, catalogue.fetchedAt),
			provider: "openrouter",
			model,
			catalogue: { digest: catalogue.digest, fetchedAt: catalogue.fetchedAt },
			markupBps,
			prices,
			tiers,
			reasoning: "billed-as-completion",
			cacheFallback: "prompt",
			...(input.precision === "full" && input.route
				? { precision: "full" as const, route: copyRoute(input.route) }
				: {}),
		},
	};
}

function assertProvenance(
	model: string,
	catalogue: { readonly digest: string; readonly fetchedAt: string },
	markupBps: number,
): void {
	if (typeof model !== "string" || model === "" || model.length > MAX_RATE_CARD_MODEL_CHARS) {
		throw new RateCardError("rate_card_invalid", "a rate card needs the model id it prices");
	}
	if (!DIGEST_PATTERN.test(catalogue.digest) || !INSTANT_PATTERN.test(catalogue.fetchedAt)) {
		throw new RateCardError(
			"rate_card_invalid",
			"a rate card needs the digest and the fetch time of its catalogue snapshot",
		);
	}
	if (!Number.isInteger(markupBps) || markupBps < 0 || markupBps > MAX_BILLING_MARKUP_BPS) {
		throw new RateCardError(
			"rate_card_invalid",
			`a rate card's markup must be whole basis points from 0 to ${MAX_BILLING_MARKUP_BPS}`,
		);
	}
}

// ─── Reading a card back ─────────────────────────────────────────────────────

function invalid(label: string, detail: string): never {
	throw new RateCardError("rate_card_invalid", `${label} is not a valid rate card: ${detail}`);
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const extra = Object.keys(record).filter((key) => !allowed.includes(key));
	if (extra.length > 0) invalid(label, `unknown fields: ${extra.sort().join(", ")}`);
}

function parsePrices(value: unknown, label: string, requireBase: boolean): Partial<RateCardPricesV1> {
	if (!isRecord(value)) invalid(label, "prices must be an object");
	exactKeys(value, ["prompt", "completion", "inputCacheRead", "inputCacheWrite"], label);
	const prices: { -readonly [K in keyof RateCardPricesV1]?: string } = {};
	for (const field of ["prompt", "completion", "inputCacheRead", "inputCacheWrite"] as const) {
		const text = value[field];
		if (text === undefined) {
			if (requireBase && (field === "prompt" || field === "completion")) invalid(label, `${field} is required`);
			continue;
		}
		if (parsePriceText(text) === undefined) invalid(label, `${field} must be a plain decimal string`);
		prices[field] = text as string;
	}
	return prices;
}

/**
 * Validate a card read from a Session document (or handed to one) and return it normalized. Strict: unknown keys,
 * a version that is not the catalogue's, a price that is not a plain decimal, tiers out of order, or a rule this
 * code does not implement are all refused, so a card is never trusted further than it was checked.
 */
export function parseRateCard(value: unknown, label = "pricing"): RateCardV1 {
	if (!isRecord(value)) invalid(label, "it must be an object");
	exactKeys(
		value,
		[
			"schema",
			"version",
			"provider",
			"model",
			"catalogue",
			"markupBps",
			"prices",
			"tiers",
			"reasoning",
			"cacheFallback",
			"precision",
			"route",
		],
		label,
	);
	for (const key of [
		"schema",
		"version",
		"provider",
		"model",
		"catalogue",
		"markupBps",
		"prices",
		"tiers",
		"reasoning",
		"cacheFallback",
	]) {
		if (!Object.hasOwn(value, key)) invalid(label, `${key} is required`);
	}
	if (value.schema !== RATE_CARD_SCHEMA) invalid(label, `schema must be ${RATE_CARD_SCHEMA}`);
	if (value.provider !== "openrouter") invalid(label, "provider must be openrouter");
	const model = value.model;
	if (typeof model !== "string" || model === "" || model.length > MAX_RATE_CARD_MODEL_CHARS) {
		invalid(label, "model must be a model id");
	}
	const catalogue = value.catalogue;
	if (!isRecord(catalogue)) invalid(label, "catalogue must be an object");
	exactKeys(catalogue, ["digest", "fetchedAt"], `${label}.catalogue`);
	const digest = catalogue.digest;
	const fetchedAt = catalogue.fetchedAt;
	if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest))
		invalid(label, "catalogue.digest must be sha256 hex");
	if (typeof fetchedAt !== "string" || !INSTANT_PATTERN.test(fetchedAt) || Number.isNaN(Date.parse(fetchedAt))) {
		invalid(label, "catalogue.fetchedAt must be an ISO instant");
	}
	if (value.version !== rateCardVersion(digest, fetchedAt)) invalid(label, "version is not the catalogue's");
	const markupBps = value.markupBps;
	if (
		typeof markupBps !== "number" ||
		!Number.isInteger(markupBps) ||
		markupBps < 0 ||
		markupBps > MAX_BILLING_MARKUP_BPS
	) {
		invalid(label, `markupBps must be whole basis points from 0 to ${MAX_BILLING_MARKUP_BPS}`);
	}
	const prices = parsePrices(value.prices, `${label}.prices`, true) as RateCardPricesV1;
	if (!Array.isArray(value.tiers) || value.tiers.length > MAX_RATE_CARD_TIERS) {
		invalid(label, `tiers must be a list of at most ${MAX_RATE_CARD_TIERS}`);
	}
	const tiers: RateCardTierV1[] = [];
	for (const tier of value.tiers as unknown[]) {
		if (!isRecord(tier)) invalid(label, "a tier must be an object");
		exactKeys(tier, ["minPromptTokens", "prices"], `${label}.tiers`);
		if (!isPositiveSafeInteger(tier.minPromptTokens))
			invalid(label, "a tier's minPromptTokens must be a positive integer");
		const tierPrices = parsePrices(tier.prices, `${label}.tiers.prices`, false);
		if (Object.keys(tierPrices).length === 0) invalid(label, "a tier must replace at least one price");
		if (tiers.length > 0 && tier.minPromptTokens <= tiers[tiers.length - 1].minPromptTokens) {
			invalid(label, "tiers must ascend strictly by minPromptTokens");
		}
		tiers.push({ minPromptTokens: tier.minPromptTokens, prices: tierPrices });
	}
	if (value.reasoning !== "billed-as-completion") invalid(label, "reasoning must be billed-as-completion");
	if (value.cacheFallback !== "prompt") invalid(label, "cacheFallback must be prompt");
	let precision: "any" | "full" | undefined;
	let route: RateCardRouteV1 | undefined;
	if (Object.hasOwn(value, "precision")) {
		if (value.precision !== "any" && value.precision !== "full") invalid(label, "precision must be any or full");
		precision = value.precision;
	}
	if (precision === "full") {
		if (!Object.hasOwn(value, "route")) invalid(label, "a full-precision card needs its route");
		route = parseRoute(value.route, `${label}.route`);
	} else if (Object.hasOwn(value, "route")) {
		invalid(label, "a route belongs only to a full-precision card");
	}
	return {
		schema: RATE_CARD_SCHEMA,
		version: rateCardVersion(digest, fetchedAt),
		provider: "openrouter",
		model,
		catalogue: { digest, fetchedAt },
		markupBps,
		prices,
		tiers,
		reasoning: "billed-as-completion",
		cacheFallback: "prompt",
		...(precision ? { precision } : {}),
		...(route ? { route } : {}),
	};
}

/** A full-precision card's route, checked: quantizations at FP8 or better only, and the endpoint its price came from. */
function parseRoute(value: unknown, label: string): RateCardRouteV1 {
	if (!isRecord(value)) invalid(label, "route must be an object");
	exactKeys(value, ["quantizations", "endpoint"], label);
	const full = new Set<string>(FULL_PRECISION_QUANTIZATIONS);
	const quantizations = value.quantizations;
	if (
		!Array.isArray(quantizations) ||
		quantizations.length === 0 ||
		quantizations.length > FULL_PRECISION_QUANTIZATIONS.length ||
		quantizations.some((q) => typeof q !== "string" || !full.has(q)) ||
		new Set(quantizations).size !== quantizations.length
	) {
		invalid(label, "route.quantizations must list FP8-or-better quantizations, each once");
	}
	const endpoint = value.endpoint;
	if (!isRecord(endpoint)) invalid(label, "route.endpoint must be an object");
	exactKeys(endpoint, ["provider", "tag", "quantization", "listedAt"], `${label}.endpoint`);
	if (typeof endpoint.provider !== "string" || endpoint.provider === "" || endpoint.provider.length > 200) {
		invalid(label, "route.endpoint.provider must be a provider name");
	}
	if (
		endpoint.tag !== null &&
		(typeof endpoint.tag !== "string" || endpoint.tag === "" || endpoint.tag.length > 200)
	) {
		invalid(label, "route.endpoint.tag must be a routing tag or null");
	}
	if (typeof endpoint.quantization !== "string" || !full.has(endpoint.quantization)) {
		invalid(label, "route.endpoint.quantization must be FP8 or better");
	}
	if (
		typeof endpoint.listedAt !== "string" ||
		!INSTANT_PATTERN.test(endpoint.listedAt) ||
		Number.isNaN(Date.parse(endpoint.listedAt))
	) {
		invalid(label, "route.endpoint.listedAt must be an ISO instant");
	}
	return copyRoute(value as unknown as RateCardRouteV1);
}

function copyRoute(route: RateCardRouteV1): RateCardRouteV1 {
	return {
		quantizations: [...route.quantizations],
		endpoint: {
			provider: route.endpoint.provider,
			tag: route.endpoint.tag,
			quantization: route.endpoint.quantization,
			listedAt: route.endpoint.listedAt,
		},
	};
}

/** The card pinned in a Session document's `source`, or undefined for a legacy Session. Throws on a malformed pin. */
export function rateCardFromSessionSource(source: unknown): RateCardV1 | undefined {
	if (!isRecord(source) || !Object.hasOwn(source, "pricing")) return undefined;
	return parseRateCard(source.pricing, "source.pricing");
}

export function rateCardFromSessionDocumentJson(documentJson: string): RateCardV1 | undefined {
	let document: unknown;
	try {
		document = JSON.parse(documentJson);
	} catch {
		throw new RateCardError(
			"rate_card_invalid",
			"the Session document is not valid JSON, so its pricing pin cannot be read",
		);
	}
	return rateCardFromSessionSource(isRecord(document) ? document.source : undefined);
}

// ─── The price of a call ─────────────────────────────────────────────────────

export interface TokenCounts {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

interface ScaledPrices {
	readonly prompt: bigint;
	readonly completion: bigint;
	readonly cacheRead?: bigint;
	readonly cacheWrite?: bigint;
}

interface ScaledTier {
	readonly minPromptTokens: number;
	readonly prices: Partial<ScaledPrices>;
}

interface ScaledCard {
	readonly base: ScaledPrices;
	readonly tiers: readonly ScaledTier[];
}

const SCALED = new WeakMap<RateCardV1, ScaledCard>();

function scaleOf(text: string | undefined, what: string): bigint | undefined {
	if (text === undefined) return undefined;
	const scaled = parsePriceText(text);
	if (scaled === undefined)
		throw new RateCardError("rate_card_invalid", `the rate card's ${what} price is not a plain decimal`);
	return scaled;
}

function scaledCard(card: RateCardV1): ScaledCard {
	const cached = SCALED.get(card);
	if (cached) return cached;
	const prompt = scaleOf(card.prices.prompt, "prompt");
	const completion = scaleOf(card.prices.completion, "completion");
	if (prompt === undefined || completion === undefined) {
		throw new RateCardError("rate_card_invalid", "the rate card has no prompt or completion price");
	}
	const scaled: ScaledCard = {
		base: {
			prompt,
			completion,
			cacheRead: scaleOf(card.prices.inputCacheRead, "cache read"),
			cacheWrite: scaleOf(card.prices.inputCacheWrite, "cache write"),
		},
		tiers: card.tiers.map((tier) => ({
			minPromptTokens: tier.minPromptTokens,
			prices: {
				prompt: scaleOf(tier.prices.prompt, "tier prompt"),
				completion: scaleOf(tier.prices.completion, "tier completion"),
				cacheRead: scaleOf(tier.prices.inputCacheRead, "tier cache read"),
				cacheWrite: scaleOf(tier.prices.inputCacheWrite, "tier cache write"),
			},
		})),
	};
	SCALED.set(card, scaled);
	return scaled;
}

/**
 * The cost of one call from a card, in whole micro-dollars, rounded up once. Tier: the last one whose threshold is
 * not above input + cache reads + cache writes, replacing exactly the components it lists. A cache token without a
 * listed price is billed at the (tier's) prompt price.
 */
export function computeRateCardCost(card: RateCardV1, tokens: TokenCounts): CostBreakdown {
	for (const [name, count] of [
		["input", tokens.input],
		["output", tokens.output],
		["cacheRead", tokens.cacheRead],
		["cacheWrite", tokens.cacheWrite],
	] as const) {
		if (!Number.isSafeInteger(count) || count < 0) {
			throw new RateCardError(
				"tokens_invalid",
				`${name} tokens must be a non-negative integer, got ${String(count)}`,
			);
		}
	}
	const scaled = scaledCard(card);
	const promptTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite;
	let tier: ScaledTier | undefined;
	for (const candidate of scaled.tiers) {
		if (candidate.minPromptTokens <= promptTokens) tier = candidate;
	}
	const prompt = tier?.prices.prompt ?? scaled.base.prompt;
	const completion = tier?.prices.completion ?? scaled.base.completion;
	const cacheRead = tier?.prices.cacheRead ?? scaled.base.cacheRead ?? prompt;
	const cacheWrite = tier?.prices.cacheWrite ?? scaled.base.cacheWrite ?? prompt;

	const parts = [
		BigInt(tokens.input) * prompt,
		BigInt(tokens.output) * completion,
		BigInt(tokens.cacheRead) * cacheRead,
		BigInt(tokens.cacheWrite) * cacheWrite,
	];
	const providerScaled = parts[0] + parts[1] + parts[2] + parts[3];
	const provider = ceilDiv(providerScaled, SCALED_PER_MICRO_USD);
	const total = ceilDiv(providerScaled * BigInt(10_000 + card.markupBps), SCALED_PER_MICRO_USD * 10_000n);

	// The parts by cumulative ceiling: each is a whole number of micro-dollars and together they are exactly `provider`.
	const items: bigint[] = [];
	let running = 0n;
	let previous = 0n;
	for (const part of parts) {
		running += part;
		const current = ceilDiv(running, SCALED_PER_MICRO_USD);
		items.push(current - previous);
		previous = current;
	}
	return {
		modelPriced: card.model,
		pricedDefault: false,
		inputCostMicroUsd: safeNumber(items[0], "input cost"),
		outputCostMicroUsd: safeNumber(items[1], "output cost"),
		cacheReadCostMicroUsd: safeNumber(items[2], "cache read cost"),
		cacheWriteCostMicroUsd: safeNumber(items[3], "cache write cost"),
		providerCostMicroUsd: safeNumber(provider, "provider cost"),
		markupMicroUsd: safeNumber(total - provider, "markup"),
		totalCostMicroUsd: safeNumber(total, "total cost"),
	};
}

/**
 * THE function that prices a call for a Session: from its pinned card if it has one, else (a legacy Session) from
 * the static table exactly as before. The reservation, the settlement, the store's verifier and the capture
 * testimony all call this, and nothing else, so no reader can price a call differently from another. A card that
 * belongs to another model or provider is refused rather than applied.
 */
export function priceInferenceCall(input: {
	readonly card: RateCardV1 | undefined;
	readonly model: string;
	readonly provider: string;
	readonly tokens: TokenCounts;
}): CostBreakdown {
	if (input.card) {
		if (input.card.model !== input.model || input.card.provider !== input.provider.trim().toLowerCase()) {
			throw new RateCardError(
				"rate_card_invalid",
				`the rate card prices ${input.card.provider}/${input.card.model}, not ${input.provider}/${input.model}`,
			);
		}
		return computeRateCardCost(input.card, input.tokens);
	}
	return computeCost(input.model, input.tokens, input.provider);
}

/**
 * What OpenRouter reports it charged, in whole micro-dollars rounded up, or null if it is not a charge. The report is a
 * JSON number of dollars; it is read through a fixed 12-decimal text (finer than any price) so the rounding is exact,
 * never a float multiplied up.
 */
export function providerChargeMicroUsd(costUsd: unknown): number | null {
	if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0 || costUsd > 1_000) return null;
	const [whole, fraction = ""] = costUsd.toFixed(12).split(".");
	const picoUsd = BigInt(whole) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, "0"));
	return safeNumber(ceilDiv(picoUsd, 1_000_000n), "provider charge");
}

/**
 * A call billed at the provider's report (the fallback, `openrouter-fallback.ts`): the provider's charge, the card's
 * markup on it (rounded up once, as the card's own total is), and the charge itemized in the proportions of the card's
 * parts for the same tokens (by cumulative ceiling, so the parts add up exactly). Deterministic from the card's figure,
 * the charge and the markup, so the runtime store re-derives it exactly as it re-derives a card-priced event.
 */
export function priceAtProviderReport(
	atCard: CostBreakdown,
	providerMicroUsd: number,
	markupBps: number,
): CostBreakdown {
	if (!Number.isSafeInteger(providerMicroUsd) || providerMicroUsd < 0) {
		throw new RateCardError("cost_out_of_range", "a provider charge must be a whole number of micro-dollars");
	}
	if (!Number.isInteger(markupBps) || markupBps < 0 || markupBps > MAX_BILLING_MARKUP_BPS) {
		throw new RateCardError("rate_card_invalid", "the markup must be whole basis points");
	}
	const provider = BigInt(providerMicroUsd);
	const markup = ceilDiv(provider * BigInt(markupBps), 10_000n);
	const parts = [
		atCard.inputCostMicroUsd,
		atCard.outputCostMicroUsd,
		atCard.cacheReadCostMicroUsd,
		atCard.cacheWriteCostMicroUsd,
	].map((part) => BigInt(part));
	const cardProvider = parts.reduce((sum, part) => sum + part, 0n);
	const items: bigint[] = [];
	if (cardProvider === 0n) {
		items.push(provider, 0n, 0n, 0n);
	} else {
		let running = 0n;
		let previous = 0n;
		for (const part of parts) {
			running += part;
			const current = ceilDiv(provider * running, cardProvider);
			items.push(current - previous);
			previous = current;
		}
	}
	return {
		modelPriced: atCard.modelPriced,
		pricedDefault: atCard.pricedDefault,
		inputCostMicroUsd: safeNumber(items[0], "input cost"),
		outputCostMicroUsd: safeNumber(items[1], "output cost"),
		cacheReadCostMicroUsd: safeNumber(items[2], "cache read cost"),
		cacheWriteCostMicroUsd: safeNumber(items[3], "cache write cost"),
		providerCostMicroUsd: safeNumber(provider, "provider cost"),
		markupMicroUsd: safeNumber(markup, "markup"),
		totalCostMicroUsd: safeNumber(provider + markup, "total cost"),
	};
}

/** The smallest viable call's cost on the pinned rates (or the static table for a legacy Session), floored. */
export function minimumViableCallCostMicroUsd(input: {
	readonly card?: RateCardV1;
	readonly model: string;
	readonly provider: string;
}): number {
	const cost = priceInferenceCall({
		card: input.card,
		model: input.model,
		provider: input.provider,
		tokens: {
			input: MIN_VIABLE_CALL.inputTokens,
			output: MIN_VIABLE_CALL.outputTokens,
			cacheRead: 0,
			cacheWrite: 0,
		},
	}).totalCostMicroUsd;
	return Math.max(MIN_VIABLE_CALL.floorMicroUsd, cost);
}

/**
 * The billed price per million tokens, in whole micro-dollars, rounded up so a person is never shown less than the
 * ledger will charge: the price string, times a million tokens, plus the markup.
 */
export function billedMicroUsdPerMillion(priceText: string, markupBps: number): number {
	const scaled = parsePriceText(priceText);
	if (scaled === undefined) throw new RateCardError("rate_card_invalid", "the price is not a plain decimal");
	// USD/token x 10^30 -> micro-dollars per million tokens: x 10^6 tokens x 10^6 micro-dollars / 10^30 = / 10^18.
	return safeNumber(ceilDiv(scaled * BigInt(10_000 + markupBps), 10n ** 18n * 10_000n), "price per million");
}

// ─── Routing ─────────────────────────────────────────────────────────────────

/**
 * OpenRouter's `provider.require_parameters`: route only to endpoints that support every parameter the call sends.
 * Without it an endpoint that does not support a parameter ignores it, so a chat routed to an endpoint without tool
 * support silently has no tools (DESIGN-empowered-chat §11.3). With it, the call is refused when no endpoint qualifies
 * ("No endpoints found that can handle the requested parameters"), which the person sees.
 */
export interface OpenRouterToolRouting {
	readonly require_parameters: true;
}

/** The routing of a call that has no card (a legacy Session): tool-capable endpoints only. */
export const OPENROUTER_TOOL_ROUTING: OpenRouterToolRouting = Object.freeze({ require_parameters: true });

/** OpenRouter provider preferences that make a card the ceiling of what a call costs (see the function below). */
export interface OpenRouterCardRouting extends OpenRouterToolRouting {
	readonly sort: "price";
	/** Dollars per million tokens, as OpenRouter's `provider.max_price` takes them. */
	readonly max_price: { readonly prompt: number; readonly completion: number };
	/** A full-precision card's quantization rule (OpenRouter's `provider.quantizations`). */
	readonly quantizations?: readonly string[];
}

/** The routing of a fallback call (`openrouter-fallback.ts`): the card's rule without its price ceiling. */
export interface OpenRouterFallbackRouting extends OpenRouterToolRouting {
	readonly sort: "price";
	readonly quantizations?: readonly string[];
}

/**
 * What a Session priced by `card` asks OpenRouter for on every call (price-gap, 2026-10-01). OpenRouter's default
 * routing served the card's price for most voices but sent some calls to dearer providers (30 of 248 voices, up to
 * 3.68x at a realistic chat call), each a loss. `max_price` caps the charge at the card: a provider dearer than the card
 * is never chosen, and when none at or under it is available the call is refused ("No endpoints found that satisfy the
 * max price"), never served dearer. `sort: "price"` tries the cheapest qualifying provider first, so a conversation's
 * turns keep to one provider and its prompt cache stays warm.
 *
 * The cap is the card's dearest price in any tier (a long prompt the card prices is never refused), per million
 * tokens, rounded up to a nano-dollar plus one more, so the card's own provider always qualifies however OpenRouter
 * compares the numbers. Cache prices have no cap of their own in OpenRouter's routing; the card bills them as listed.
 */
export function openRouterRoutingForRateCard(card: RateCardV1): OpenRouterCardRouting {
	const dearest = (field: "prompt" | "completion"): number => {
		let max = parsePriceText(card.prices[field]);
		if (max === undefined) throw new RateCardError("rate_card_invalid", `the card has no ${field} price`);
		for (const tier of card.tiers) {
			const tierPrice = parsePriceText(tier.prices[field] ?? card.prices[field]);
			if (tierPrice !== undefined && tierPrice > max) max = tierPrice;
		}
		// USD/token x 10^30 -> nano-dollars per million tokens: x 10^6 tokens x 10^9 / 10^30 = / 10^15.
		return safeNumber(ceilDiv(max, 10n ** 15n) + 1n, "price cap") / 1e9;
	};
	return {
		sort: "price",
		require_parameters: true,
		max_price: { prompt: dearest("prompt"), completion: dearest("completion") },
		...(card.precision === "full" && card.route ? { quantizations: [...card.route.quantizations] } : {}),
	};
}

/**
 * The routing of the one retry a call gets when OpenRouter answers that no provider serves it at or under the card's
 * price (Vera's ruling, 2026-10-01: "dearer one, bill actual"): the card's quantization rule is kept, only the ceiling
 * goes, and the call is settled at what OpenRouter reports it charged (`priceAtProviderReport`).
 */
export function openRouterFallbackRouting(card: RateCardV1): OpenRouterFallbackRouting {
	return {
		sort: "price",
		require_parameters: true,
		...(card.precision === "full" && card.route ? { quantizations: [...card.route.quantizations] } : {}),
	};
}

// ─── The markup ──────────────────────────────────────────────────────────────

/**
 * The fee in force, in basis points: `BILLING_FEE_BPS`, default 1500. The one reading (`resolveBillingFeeBps`), under
 * the card module's own name: anything that is not a whole number of basis points from 0 to 100000 falls back to the
 * default, never to zero and never to a guess, so a typo must not quietly change a bill either way.
 */
export function resolveBillingMarkupBps(env: NodeJS.ProcessEnv = process.env): number {
	return resolveBillingFeeBps(env);
}

export function resolveBillingMarkupPercent(env: NodeJS.ProcessEnv = process.env): number {
	return resolveBillingMarkupBps(env) / 100;
}
