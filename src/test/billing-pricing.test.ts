/**
 * Billing Phase 0 — pure cost computation, real arithmetic (NO MOCKS).
 *
 * The "organism" here is the pure `computeCost` fed real ProxyUsage-shaped token
 * counts; every assertion is a hand-computed integer-µUSD value reproducing the
 * Python `//` semantics of cloud-1's calculate_cost. Run via `tsx --test`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	computeCost,
	MARKUP_PERCENT,
	normalizeModelForPricing,
	PRICING_VERSION,
	providerModelForAccounting,
} from "../billing-pricing.js";

describe("billing-pricing: computeCost", () => {
	it("prices a known model with hand-computed integer µUSD (cross-check vs Python //)", () => {
		// google/gemini-2.5-flash rates (µUSD/1M): input 300_000, output 2_500_000,
		// cacheRead 75_000, cacheWrite 0.
		const c = computeCost("google/gemini-2.5-flash", { input: 1000, output: 500, cacheRead: 200, cacheWrite: 0 });
		// input:  1000 * 300_000  // 1e6 = 300
		// output:  500 * 2_500_000 // 1e6 = 1250
		// cacheR:  200 * 75_000    // 1e6 = 15  (15_000_000 // 1e6 = 15)
		// cacheW:  0
		assert.equal(c.inputCostMicroUsd, 300);
		assert.equal(c.outputCostMicroUsd, 1250);
		assert.equal(c.cacheReadCostMicroUsd, 15);
		assert.equal(c.cacheWriteCostMicroUsd, 0);
		assert.equal(c.providerCostMicroUsd, 1565);
		// markup = 1565 * 15 // 100 = 234 (234.75 truncated)
		assert.equal(c.markupMicroUsd, 234);
		assert.equal(c.totalCostMicroUsd, 1799);
		assert.equal(c.pricedDefault, false);
		assert.equal(c.modelPriced, "google/gemini-2.5-flash");
		// Identity the DB relies on: total === provider + markup.
		assert.equal(c.totalCostMicroUsd, c.providerCostMicroUsd + c.markupMicroUsd);
	});

	it("truncates (floors) like Python // on fractional µUSD — not rounds", () => {
		// 333 tokens * 300_000 // 1e6 = 99_900_000 // 1e6 = 99 (not 100).
		const c = computeCost("google/gemini-2.5-flash", { input: 333, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.equal(c.inputCostMicroUsd, 99);
		// provider 99, markup 99*15//100 = 14 (14.85 truncated), total 113.
		assert.equal(c.markupMicroUsd, 14);
		assert.equal(c.totalCostMicroUsd, 113);
	});

	it("unknown model → DEFAULT_PRICING (Sonnet rates), pricedDefault=true", () => {
		const c = computeCost("some/never-heard-of-model-9000", {
			input: 1000,
			output: 1000,
			cacheRead: 0,
			cacheWrite: 0,
		});
		assert.equal(c.pricedDefault, true);
		// Sonnet: input 3_000_000, output 15_000_000.
		// input 1000*3_000_000//1e6 = 3000; output 1000*15_000_000//1e6 = 15000.
		assert.equal(c.inputCostMicroUsd, 3000);
		assert.equal(c.outputCostMicroUsd, 15000);
		assert.equal(c.providerCostMicroUsd, 18000);
		assert.equal(c.markupMicroUsd, 2700); // 18000 * 15 // 100
		assert.equal(c.totalCostMicroUsd, 20700);
	});

	it("LM Studio usage is provider-qualified testimony with exact zero Sophia spend", () => {
		const c = computeCost("qwen3-8b", { input: 12_000, output: 4_000, cacheRead: 100, cacheWrite: 50 }, "lmstudio");
		assert.equal(providerModelForAccounting("lmstudio", "qwen3-8b"), "lmstudio/qwen3-8b");
		assert.equal(providerModelForAccounting("lmstudio", "lmstudio/qwen3-8b"), "lmstudio/qwen3-8b");
		assert.equal(c.modelPriced, "lmstudio/qwen3-8b");
		assert.equal(c.pricedDefault, false);
		assert.equal(c.inputCostMicroUsd, 0);
		assert.equal(c.outputCostMicroUsd, 0);
		assert.equal(c.cacheReadCostMicroUsd, 0);
		assert.equal(c.cacheWriteCostMicroUsd, 0);
		assert.equal(c.providerCostMicroUsd, 0);
		assert.equal(c.markupMicroUsd, 0);
		assert.equal(c.totalCostMicroUsd, 0);
	});

	it("host-internal mock inference remains exact zero spend even with token testimony", () => {
		const cost = computeCost("mock:done", { input: 500, output: 250, cacheRead: 20, cacheWrite: 10 });
		assert.equal(cost.modelPriced, "mock:done");
		assert.equal(cost.pricedDefault, false);
		assert.equal(cost.providerCostMicroUsd, 0);
		assert.equal(cost.markupMicroUsd, 0);
		assert.equal(cost.totalCostMicroUsd, 0);
	});

	it("prices the capped Luna live-validation model without the default-rate fallback", () => {
		const c = computeCost(
			"openai/gpt-5.6-luna",
			{ input: 1_000, output: 1_000, cacheRead: 0, cacheWrite: 0 },
			"openrouter",
		);
		assert.equal(c.pricedDefault, false);
		assert.equal(c.providerCostMicroUsd, 700);
		assert.equal(c.totalCostMicroUsd, 805);
	});

	it("tiered model: just below threshold = base rate, just above = 2x input / 1.5x output", () => {
		const model = "anthropic/claude-sonnet-4.5"; // base 3_000_000 in / 15_000_000 out, tier > 200k.
		// Below threshold (context = input = 200_000, NOT > 200_000): base rates.
		const below = computeCost(model, { input: 200_000, output: 1000, cacheRead: 0, cacheWrite: 0 });
		// input 200_000 * 3_000_000 // 1e6 = 600_000.
		assert.equal(below.inputCostMicroUsd, 600_000);
		// output 1000 * 15_000_000 // 1e6 = 15_000 (base output rate).
		assert.equal(below.outputCostMicroUsd, 15_000);

		// Above threshold (context = 200_001 > 200_000): input 2x, output 1.5x.
		const above = computeCost(model, { input: 200_001, output: 1000, cacheRead: 0, cacheWrite: 0 });
		// input rate doubled: 6_000_000; 200_001 * 6_000_000 // 1e6 = 1_200_006.
		assert.equal(above.inputCostMicroUsd, 1_200_006);
		// output rate *3//2 = 22_500_000; 1000 * 22_500_000 // 1e6 = 22_500.
		assert.equal(above.outputCostMicroUsd, 22_500);
	});

	it("normalization collapses :free / date-stamp / -thinking / -instruct variants", () => {
		const base = "anthropic/claude-3.5-sonnet";
		// :free (OpenRouter convention) → -free.
		assert.equal(normalizeModelForPricing("anthropic/claude-3.5-sonnet:free"), `${base}-free`);
		// :beta suffix dropped → base key (resolves to a priced row, not default).
		assert.equal(normalizeModelForPricing("anthropic/claude-3.5-sonnet:beta"), base);
		// date stamp stripped.
		assert.equal(normalizeModelForPricing("google/gemini-2.5-flash-20250101"), "google/gemini-2.5-flash");
		// -thinking with release stamp stripped.
		assert.equal(normalizeModelForPricing("deepseek/deepseek-r1-thinking-20260301"), "deepseek/deepseek-r1");
		// A :beta variant prices identically to the base model (alias resolves it).
		const beta = computeCost("anthropic/claude-3.5-sonnet:beta", {
			input: 1000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
		assert.equal(beta.pricedDefault, false);
		assert.equal(beta.modelPriced, base);
	});

	it("zero tokens → all-zero breakdown (the 'cost is currently 0' baseline, now explicit)", () => {
		const c = computeCost("google/gemini-2.5-flash", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.equal(c.inputCostMicroUsd, 0);
		assert.equal(c.outputCostMicroUsd, 0);
		assert.equal(c.cacheReadCostMicroUsd, 0);
		assert.equal(c.cacheWriteCostMicroUsd, 0);
		assert.equal(c.providerCostMicroUsd, 0);
		assert.equal(c.markupMicroUsd, 0);
		assert.equal(c.totalCostMicroUsd, 0);
	});

	it("exposes a stable PRICING_VERSION + MARKUP_PERCENT for audit stamping", () => {
		assert.equal(typeof PRICING_VERSION, "string");
		assert.ok(PRICING_VERSION.length > 0);
		assert.equal(MARKUP_PERCENT, 15);
	});
});
