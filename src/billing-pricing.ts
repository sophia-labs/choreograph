/**
 * Billing Phase 0 (OBSERVE) — pure cost computation.
 *
 * A faithful TypeScript port of cloud-1's
 * `mnemosyne-platform/app/services/billing/pricing.py:calculate_cost`. The
 * algorithm is identical (integer µUSD per 1M tokens, integer division, tiered
 * high-context rules, a service fee on provider cost: 15% until the flip sets BILLING_FEE_BPS); only the PRICING table keys differ: cloud-1
 * is keyed by Zen model ids, choreograph runs OpenRouter ids, so the table here
 * is re-keyed to OpenRouter ids with the same rates, plus a Sonnet-rate DEFAULT
 * fallback flagged per row (`pricedDefault`).
 *
 * NO I/O, NO clock, INTEGER-ONLY. Every value that reaches the DB is an
 * integer — `Math.trunc` documents the Python `//` semantics (all token/rate
 * values are non-negative, so trunc === floor here, but trunc is safe if a
 * future rate goes negative). Deterministic: same tokens + fee + PRICING_VERSION ⇒
 * same output, so historical events stay re-derivable (the fee is in the stamp, `staticPricingVersion`).
 * The one ambient input is the fee, read from the environment when the caller does not pass one.
 */

// ─── Rate shapes (µUSD per 1M tokens) ──────────────────────────────────────

export interface Rate {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface TierRule {
	thresholdTokens: number;
	inputNum: number;
	inputDen: number;
	outputNum: number;
	outputDen: number;
}

export interface CostBreakdown {
	/** Normalized key actually used for the PRICING lookup. */
	modelPriced: string;
	/** true ⇒ DEFAULT_PRICING (Sonnet) fallback was used — mispricing is observable. */
	pricedDefault: boolean;
	inputCostMicroUsd: number;
	outputCostMicroUsd: number;
	cacheReadCostMicroUsd: number;
	cacheWriteCostMicroUsd: number;
	providerCostMicroUsd: number;
	markupMicroUsd: number;
	totalCostMicroUsd: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * The static table's revision, stamped onto every usage row it prices so a rate change ships a new version string.
 * This is the string the deployed build stamps, and it stays the stamp at the DEFAULT fee (15%): the observe-mode
 * deploy must price and stamp byte for byte as the deployed build does. At any other fee the stamp carries the fee
 * (`staticPricingVersion`), so every event stays re-derivable from its own stamp.
 */
export const PRICING_VERSION = "p0-2026-08-05-luna";

/**
 * The DEFAULT service fee on a model's price, in percent: today's, matching cloud-1. The fee in force is a boot-time
 * setting (`BILLING_FEE_BPS`, below): this is what it is until the flip sets it, and the one number its default is
 * derived from, so that the catalogue path and the static table cannot drift apart.
 */
export const MARKUP_PERCENT = 15;

// ─── The fee in force ───────────────────────────────────────────────────────

/**
 * The service fee is set the way the gate mode is (Vera, 2026-10-03): an SSM value, `/choreograph/BILLING_FEE_BPS`,
 * which `deploy/load-env.sh` writes into the service's environment; read at boot; changed only by a guarded
 * restart. Basis points: 1500 is 15%, 2000 is 20%. Unset means the default, so the observe-mode deploy changes
 * nobody's price; the flip sets it to 2000 together with `BILLING_GATE_MODE=enforce`, before ONE restart.
 */
export const BILLING_FEE_ENV = "BILLING_FEE_BPS";
/** The pricing release's percent knob. Retired: a leftover value is reported at boot and never obeyed. */
const RETIRED_FEE_ENV = "CHOREOGRAPH_BILLING_MARKUP_PERCENT";
export const DEFAULT_BILLING_FEE_BPS = MARKUP_PERCENT * 100;
/** The largest fee an operator may configure (1000%); anything above it is a typo, not a policy. */
export const MAX_BILLING_FEE_BPS = 100_000;
/** Outside 5% to 50% a fee is honoured but flagged: it is probably percent typed where basis points were meant. */
const USUAL_FEE_BPS = { min: 500, max: 5_000 } as const;

export interface BillingFeeReading {
	readonly bps: number;
	/** `default`: the setting is absent, blank or unreadable; `env`: it was read. */
	readonly source: "default" | "env";
	/** What the boot log says besides the fee: a typo that fell back, a retired knob, an unusual value. */
	readonly warnings: readonly string[];
}

/**
 * Read the fee. Anything that is not a whole number of basis points from 0 to 100000 falls back to the default,
 * never to zero and never to a guess: a typo must not quietly change a bill, either way. Blank is unset.
 */
export function readBillingFee(env: NodeJS.ProcessEnv = process.env): BillingFeeReading {
	const warnings: string[] = [];
	if (env[RETIRED_FEE_ENV]?.trim()) {
		warnings.push(
			`${RETIRED_FEE_ENV} is no longer read: the fee is set by ${BILLING_FEE_ENV}, in basis points (2000 is 20%)`,
		);
	}
	const raw = env[BILLING_FEE_ENV]?.trim();
	if (!raw) return { bps: DEFAULT_BILLING_FEE_BPS, source: "default", warnings };
	if (!/^[0-9]{1,6}$/.test(raw) || Number(raw) > MAX_BILLING_FEE_BPS) {
		warnings.push(
			`${BILLING_FEE_ENV}=${JSON.stringify(raw)} is not a whole number of basis points from 0 to ${MAX_BILLING_FEE_BPS}; using the default ${DEFAULT_BILLING_FEE_BPS}`,
		);
		return { bps: DEFAULT_BILLING_FEE_BPS, source: "default", warnings };
	}
	const bps = Number(raw);
	if (bps < USUAL_FEE_BPS.min || bps > USUAL_FEE_BPS.max) {
		warnings.push(
			`${BILLING_FEE_ENV}=${bps} is a fee of ${bps / 100}%: it is in basis points (2000 is 20%), is that what was meant?`,
		);
	}
	return { bps, source: "env", warnings };
}

/** The fee in force, in basis points. */
export function resolveBillingFeeBps(env: NodeJS.ProcessEnv = process.env): number {
	return readBillingFee(env).bps;
}

/**
 * The version a legacy (static-table) event is stamped with at `feeBps`: the deployed string at the default fee,
 * qualified by the fee at any other. The reservation, the settlement, the store's verifier and the Hoja evaluators
 * all ask this one function, so no two of them can stamp (or expect) different versions for one call.
 */
export function staticPricingVersion(feeBps: number = resolveBillingFeeBps()): string {
	return feeBps === DEFAULT_BILLING_FEE_BPS ? PRICING_VERSION : `${PRICING_VERSION}+fee${feeBps}`;
}

/**
 * Billing Phase 1 (DECREMENT) ledger constants. Ported VERBATIM from cloud-1
 * `mnemosyne-platform/app/services/billing/pricing.py`. Co-located here with the
 * other cloud-1-ported billing constants so the ledger store imports one module.
 */
/** Free-tier seed balance, µUSD. Verbatim from cloud-1 pricing.py:216. */
export const FREE_TIER_BALANCE_MICRO_USD = 1_000_000;
/** Overdraft floor, µUSD. Verbatim from cloud-1 pricing.py:213. */
export const MIN_ALLOWED_BALANCE_MICRO_USD = -500_000;

/**
 * OpenRouter-keyed µUSD-per-1M-token table. Rates are re-keyed from cloud-1's
 * Zen-keyed PRICING (same dollar figures). Cache rates follow Anthropic/OpenAI
 * conventions (cache_read ≈ 10% input, cache_write ≈ 125% input where the
 * provider charges one). Unknown ids fall back to DEFAULT_PRICING.
 */
const PRICING: Record<string, Rate> = {
	// ── Anthropic (via OpenRouter) ──────────────────────────────────────
	"anthropic/claude-opus-4.5": { input: 5_000_000, output: 25_000_000, cacheRead: 500_000, cacheWrite: 6_250_000 },
	"anthropic/claude-opus-4.1": {
		input: 15_000_000,
		output: 75_000_000,
		cacheRead: 1_500_000,
		cacheWrite: 18_750_000,
	},
	"anthropic/claude-opus-4": { input: 15_000_000, output: 75_000_000, cacheRead: 1_500_000, cacheWrite: 18_750_000 },
	"anthropic/claude-sonnet-4.5": { input: 3_000_000, output: 15_000_000, cacheRead: 300_000, cacheWrite: 3_750_000 },
	"anthropic/claude-sonnet-4": { input: 3_000_000, output: 15_000_000, cacheRead: 300_000, cacheWrite: 3_750_000 },
	"anthropic/claude-3.7-sonnet": { input: 3_000_000, output: 15_000_000, cacheRead: 300_000, cacheWrite: 3_750_000 },
	"anthropic/claude-3.5-sonnet": { input: 3_000_000, output: 15_000_000, cacheRead: 300_000, cacheWrite: 3_750_000 },
	"anthropic/claude-haiku-4.5": { input: 1_000_000, output: 5_000_000, cacheRead: 100_000, cacheWrite: 1_250_000 },
	"anthropic/claude-3.5-haiku": { input: 800_000, output: 4_000_000, cacheRead: 80_000, cacheWrite: 1_000_000 },
	// ── OpenAI (via OpenRouter) ─────────────────────────────────────────
	"openai/gpt-5": { input: 1_070_000, output: 8_500_000, cacheRead: 107_000, cacheWrite: 0 },
	"openai/gpt-5.6-luna": { input: 100_000, output: 600_000, cacheRead: 10_000, cacheWrite: 125_000 },
	"openai/gpt-5-mini": { input: 250_000, output: 2_000_000, cacheRead: 25_000, cacheWrite: 0 },
	"openai/gpt-5-nano": { input: 200_000, output: 1_250_000, cacheRead: 20_000, cacheWrite: 0 },
	"openai/gpt-4.1": { input: 2_000_000, output: 8_000_000, cacheRead: 500_000, cacheWrite: 0 },
	"openai/gpt-4.1-mini": { input: 400_000, output: 1_600_000, cacheRead: 100_000, cacheWrite: 0 },
	"openai/gpt-4o": { input: 2_500_000, output: 10_000_000, cacheRead: 1_250_000, cacheWrite: 0 },
	"openai/gpt-4o-mini": { input: 150_000, output: 600_000, cacheRead: 75_000, cacheWrite: 0 },
	// ── Google (via OpenRouter) ─────────────────────────────────────────
	"google/gemini-2.5-pro": { input: 2_000_000, output: 12_000_000, cacheRead: 200_000, cacheWrite: 0 },
	"google/gemini-2.5-flash": { input: 300_000, output: 2_500_000, cacheRead: 75_000, cacheWrite: 0 },
	"google/gemini-2.5-flash-lite": { input: 100_000, output: 400_000, cacheRead: 25_000, cacheWrite: 0 },
	"google/gemini-2.0-flash-001": { input: 100_000, output: 400_000, cacheRead: 25_000, cacheWrite: 0 },
	// ── Open-weight / other (via OpenRouter) ────────────────────────────
	"deepseek/deepseek-chat": { input: 270_000, output: 1_100_000, cacheRead: 70_000, cacheWrite: 0 },
	"deepseek/deepseek-r1": { input: 500_000, output: 2_180_000, cacheRead: 140_000, cacheWrite: 0 },
	"qwen/qwen3-coder": { input: 450_000, output: 1_500_000, cacheRead: 0, cacheWrite: 0 },
	"moonshotai/kimi-k2": { input: 400_000, output: 2_500_000, cacheRead: 0, cacheWrite: 0 },
	"z-ai/glm-4.6": { input: 600_000, output: 2_200_000, cacheRead: 100_000, cacheWrite: 0 },
	"minimax/minimax-m2": { input: 300_000, output: 1_200_000, cacheRead: 100_000, cacheWrite: 0 },
};

/** Sonnet rates — the safe fallback for unknown models (mirrors cloud-1). */
const DEFAULT_PRICING: Rate = { input: 3_000_000, output: 15_000_000, cacheRead: 300_000, cacheWrite: 3_750_000 };

/**
 * Tiered high-context rules. Rule semantics (verbatim from cloud-1): when
 * (input + cacheRead + cacheWrite) > thresholdTokens, multiply input/cache
 * rates by inputNum/inputDen and output by outputNum/outputDen — all integer.
 * Keyed by the NORMALIZED (post-lookup) model id.
 */
const TIERED: Record<string, TierRule> = {
	"anthropic/claude-sonnet-4": { thresholdTokens: 200_000, inputNum: 2, inputDen: 1, outputNum: 3, outputDen: 2 },
	"anthropic/claude-sonnet-4.5": { thresholdTokens: 200_000, inputNum: 2, inputDen: 1, outputNum: 3, outputDen: 2 },
	"google/gemini-2.5-pro": { thresholdTokens: 200_000, inputNum: 2, inputDen: 1, outputNum: 3, outputDen: 2 },
	"openai/gpt-5": { thresholdTokens: 272_000, inputNum: 2, inputDen: 1, outputNum: 3, outputDen: 2 },
	"openai/gpt-5.6-luna": {
		thresholdTokens: 272_000,
		inputNum: 2,
		inputDen: 1,
		outputNum: 3,
		outputDen: 2,
	},
};

/**
 * Explicit aliases for ids that the general normalization rules can't resolve
 * to a PRICING key. Maps normalized-lowercase id → PRICING key.
 */
const ALIASES: Record<string, string> = {
	// OpenRouter ':free' variants collapse to their paid base for pricing.
	"anthropic/claude-3.5-sonnet:beta": "anthropic/claude-3.5-sonnet",
	"anthropic/claude-3-5-sonnet": "anthropic/claude-3.5-sonnet",
};

// ─── Normalization (port of _normalize_model_for_pricing) ────────────────────

/**
 * Normalize a model id for pricing lookup. Mirrors cloud-1's
 * `_normalize_model_for_pricing` but PRESERVES the OpenRouter `provider/id`
 * shape (cloud-1 stripped the provider prefix because its keys were bare; ours
 * keep it). Steps: lowercase → `:free`/`:beta`→`-free`/strip → strip
 * `-instruct`/`-thinking`(+optional stamp) → strip trailing `-YYYYMMDD` date →
 * apply alias map.
 */
export function normalizeModelForPricing(model: string): string {
	let m = model.toLowerCase();
	// ':free' (OpenRouter) → '-free'; ':beta'/':nitro'/':thinking' suffixes dropped.
	m = m.replace(":free", "-free").replace(/:(beta|nitro|extended|thinking|online)$/, "");
	// Strip -Instruct/-Thinking with optional 4-8 digit release stamp.
	m = m.replace(/-(instruct|thinking)(-\d{4,8})?$/, "");
	// Strip trailing date version suffix (e.g. -20251001).
	m = m.replace(/-\d{8}$/, "");
	// Apply explicit aliases.
	return ALIASES[m] ?? m;
}

/**
 * Canonical provider-qualified identity used by billing and CaptureEvent.
 * OpenRouter model ids already name their upstream provider (`google/...`,
 * `anthropic/...`) and remain byte-identical. Direct/local providers are
 * qualified here so a bare LM Studio id can never masquerade as an unknown
 * paid OpenRouter model in testimony or accounting.
 */
export function providerModelForAccounting(provider: string, model: string): string {
	const normalizedProvider = provider.trim().toLowerCase() || "openrouter";
	const normalizedModel = model.trim();
	if (normalizedProvider === "openrouter") return normalizedModel;
	if (normalizedModel.toLowerCase().startsWith(`${normalizedProvider}/`)) return normalizedModel;
	return `${normalizedProvider}/${normalizedModel}`;
}

// ─── Cost computation (port of calculate_cost) ──────────────────────────────

/**
 * Compute the integer-µUSD cost breakdown for a set of token counts. Pure and
 * deterministic. Token counts come straight off `ProxyUsage` (non-negative
 * integers); negatives are clamped to 0 for the tier-threshold sum, matching
 * cloud-1's `max(0, …)`.
 */
export function computeCost(
	model: string,
	t: { input: number; output: number; cacheRead: number; cacheWrite: number },
	provider = "openrouter",
	/** The service fee in basis points; by default the fee in force (`BILLING_FEE_BPS`, 1500 until the flip). */
	feeBps: number = resolveBillingFeeBps(),
): CostBreakdown {
	const accountingModel = providerModelForAccounting(provider, model);
	// User-operated and host-internal mock inference incur
	// no Sophia provider spend, markup, or debit. Treating any of these through
	// DEFAULT_PRICING would fabricate a paid Sonnet-rate charge. Token testimony
	// and the independent runtime token ceiling remain intact.
	const normalizedProvider = provider.trim().toLowerCase();
	if (normalizedProvider === "lmstudio" || model.startsWith("mock:")) {
		return {
			modelPriced: accountingModel,
			pricedDefault: false,
			inputCostMicroUsd: 0,
			outputCostMicroUsd: 0,
			cacheReadCostMicroUsd: 0,
			cacheWriteCostMicroUsd: 0,
			providerCostMicroUsd: 0,
			markupMicroUsd: 0,
			totalCostMicroUsd: 0,
		};
	}
	const normalized = normalizeModelForPricing(accountingModel);
	const known = PRICING[normalized];
	const pricedDefault = known === undefined;
	const rate = known ?? DEFAULT_PRICING;

	let inputRate = rate.input;
	let outputRate = rate.output;
	let cacheReadRate = rate.cacheRead;
	let cacheWriteRate = rate.cacheWrite;

	const contextTokens = Math.max(0, t.input) + Math.max(0, t.cacheRead) + Math.max(0, t.cacheWrite);
	const tier = TIERED[normalized];
	if (tier && contextTokens > tier.thresholdTokens) {
		inputRate = Math.trunc((inputRate * tier.inputNum) / tier.inputDen);
		outputRate = Math.trunc((outputRate * tier.outputNum) / tier.outputDen);
		cacheReadRate = Math.trunc((cacheReadRate * tier.inputNum) / tier.inputDen);
		cacheWriteRate = Math.trunc((cacheWriteRate * tier.inputNum) / tier.inputDen);
	}

	// Integer division, EXACTLY like Python `//` (pricing is per 1M tokens).
	const inputCost = Math.trunc((t.input * inputRate) / 1_000_000);
	const outputCost = Math.trunc((t.output * outputRate) / 1_000_000);
	const cacheReadCost = Math.trunc((t.cacheRead * cacheReadRate) / 1_000_000);
	const cacheWriteCost = Math.trunc((t.cacheWrite * cacheWriteRate) / 1_000_000);

	const providerCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;
	const markup = Math.trunc((providerCost * feeBps) / 10_000);
	const totalCost = providerCost + markup;

	return {
		modelPriced: normalized,
		pricedDefault,
		inputCostMicroUsd: inputCost,
		outputCostMicroUsd: outputCost,
		cacheReadCostMicroUsd: cacheReadCost,
		cacheWriteCostMicroUsd: cacheWriteCost,
		providerCostMicroUsd: providerCost,
		markupMicroUsd: markup,
		totalCostMicroUsd: totalCost,
	};
}
