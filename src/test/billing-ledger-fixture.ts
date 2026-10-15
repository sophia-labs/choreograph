/**
 * Real-ledger fixtures for the credit-enforcement tests (Sobremesa): a real `BillingStore`
 * on a real file, seeded only through the genuine lazy-seed + debit path. No mocks.
 */

import { join } from "node:path";
import { computeCost, FREE_TIER_BALANCE_MICRO_USD, PRICING_VERSION } from "../billing-pricing.js";
import { BillingStore, type UsageEventInput } from "../billing-store.js";

export async function openBilling(dir: string): Promise<BillingStore> {
	const store = new BillingStore(join(dir, "billing.sqlite"));
	await store.init();
	return store;
}

export function usageEvent(
	over: Partial<UsageEventInput> & { eventId: string; userId: string | null; costMicroUsd: number },
): UsageEventInput {
	const cost = computeCost("google/gemini-2.5-flash", { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 });
	return {
		ts: Date.now(),
		graphId: "g",
		sandboxId: "sbx",
		template: "agent",
		provider: "openrouter",
		model: "google/gemini-2.5-flash",
		modelPriced: cost.modelPriced,
		reason: "stop",
		inputTokens: 1000,
		outputTokens: 500,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 1500,
		inputCostMicroUsd: cost.inputCostMicroUsd,
		outputCostMicroUsd: cost.outputCostMicroUsd,
		cacheReadCostMicroUsd: 0,
		cacheWriteCostMicroUsd: 0,
		providerCostMicroUsd: cost.providerCostMicroUsd,
		markupMicroUsd: cost.markupMicroUsd,
		pricingVersion: PRICING_VERSION,
		pricedDefault: false,
		...over,
	};
}

/** Land a person on exactly `balance` µUSD through the genuine lazy-seed + debit path (balance <= $1.00). */
export async function seedBalance(store: BillingStore, userId: string, balance: number): Promise<void> {
	if (balance > FREE_TIER_BALANCE_MICRO_USD) throw new Error("seedBalance can only spend down from the seed");
	await store.recordUsageAndDebit(
		usageEvent({ eventId: `seed-${userId}-${balance}`, userId, costMicroUsd: FREE_TIER_BALANCE_MICRO_USD - balance }),
	);
}

/** Spend a person's balance down to `balance` from wherever it is (never up). */
export async function drainTo(store: BillingStore, userId: string, balance: number, tag: string): Promise<void> {
	const current = (await store.getCredit(userId))?.balanceMicroUsd ?? FREE_TIER_BALANCE_MICRO_USD;
	if (balance > current) throw new Error("drainTo can only lower a balance");
	await store.recordUsageAndDebit(
		usageEvent({ eventId: `drain-${userId}-${tag}`, userId, costMicroUsd: current - balance }),
	);
}
