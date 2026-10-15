/**
 * Billing Phase 2.5 (THE STRIPE SEAM) — money-IN fold proof, REAL libSQL, NO MOCKS.
 *
 * Proves recordGrantAndCredit (the inverse of recordUsageAndDebit) and the
 * customer_map ownership seam against a real `file:` libSQL db in os.tmpdir().
 * No Stripe SDK, no network, no live keys — synthetic grant inputs only. The
 * thing this guards is the DOUBLE-CREDIT class of bug, so the load-bearing tests
 * are the two idempotency layers:
 *   - same webhook redelivered (same evt_, same grant_id) → credit ONCE.
 *   - SAME payment under a DIFFERENT evt_ (new webhook row, same grant_id) →
 *     credit ONCE. This is the key insight: the MONEY idem key is grant_id
 *     (derived from pi_/cs_), NOT the webhook evt_ id.
 * Plus: livemode/currency gating, the amount>0 guard, the credit↔debit ledger
 * sharing, and a real N-way concurrency sweep through the substrate writeChain
 * (the same shape that caught the Phase-1 SQLITE_BUSY bug).
 *
 * RUN:  from the repository root
 *       npx tsx --test src/test/billing-grants.test.ts
 *   (or the whole suite: pnpm test  →  tsx --test src/test/*.test.ts)
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { FREE_TIER_BALANCE_MICRO_USD } from "../billing-pricing.js";
import {
	BillingStore,
	type CreditGrantInput,
	type StripeWebhookInput,
	type UsageEventInput,
} from "../billing-store.js";

// ─── Real substrate helpers ────────────────────────────────────────────────

function tmpDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Open a REAL file: libSQL BillingStore in a fresh tmpdir; auto-cleaned. */
async function freshStore(prefix: string): Promise<BillingStore> {
	const dir = tmpDir(prefix);
	after(() => rmSync(dir, { recursive: true, force: true }));
	const store = new BillingStore(join(dir, "billing.sqlite"));
	await store.init();
	after(() => store.close());
	return store;
}

/** A settled live USD payment-intent grant; override any field per test. */
function makeGrant(over: Partial<CreditGrantInput> & { grantId: string; userId: string }): CreditGrantInput {
	return {
		stripeCustomerId: over.stripeCustomerId ?? "cus_TEST",
		sourceEventId: over.sourceEventId ?? "evt_default",
		stripeObject: over.stripeObject ?? "payment_intent",
		amountMicroUsd: over.amountMicroUsd ?? 5_000_000, // $5.00
		currency: over.currency ?? "usd",
		livemode: over.livemode ?? 1,
		...over,
	};
}

/** The webhook envelope carrying a grant; eventId is the MESSAGE idem key. */
function makeWebhook(over: Partial<StripeWebhookInput> & { eventId: string }): StripeWebhookInput {
	return {
		eventType: over.eventType ?? "payment_intent.succeeded",
		stripeCreated: over.stripeCreated ?? 1_700_000_000,
		apiVersion: over.apiVersion ?? "2024-06-20",
		livemode: over.livemode ?? 1,
		stripeCustomerId: over.stripeCustomerId ?? "cus_TEST",
		payloadSha256: over.payloadSha256 ?? "deadbeef",
		...over,
	};
}

/** Minimal real usage event so a test can drive a genuine floored-CAS debit. */
function makeUsageEvent(over: Partial<UsageEventInput> & { eventId: string }): UsageEventInput {
	return {
		ts: over.ts ?? 1_700_000_000_000,
		userId: over.userId ?? null,
		graphId: null,
		sandboxId: null,
		template: null,
		provider: "openrouter",
		model: "google/gemini-2.5-flash",
		modelPriced: "google/gemini-2.5-flash",
		reason: null,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		inputCostMicroUsd: 0,
		outputCostMicroUsd: 0,
		cacheReadCostMicroUsd: 0,
		cacheWriteCostMicroUsd: 0,
		providerCostMicroUsd: over.costMicroUsd ?? 0,
		markupMicroUsd: 0,
		costMicroUsd: over.costMicroUsd ?? 0,
		pricingVersion: "test",
		pricedDefault: false,
		...over,
	};
}

async function balanceOf(store: BillingStore, userId: string): Promise<number | undefined> {
	return (await store.getCredit(userId))?.balanceMicroUsd;
}

// ─── 1. customer_map — the ownership seam ───────────────────────────────────
describe("billing-stripe: customer_map round-trips and enforces 1:1", () => {
	it("upsert then resolve both directions; a re-upsert is an idempotent bump", async () => {
		const store = await freshStore("grants-cmap-");
		await store.upsertCustomer("userA", "cus_A", "a@example.com");

		assert.equal(await store.getUserByCustomer("cus_A"), "userA", "cus_ → user_id");
		const rec = await store.getCustomer("userA");
		assert.equal(rec?.stripeCustomerId, "cus_A", "user_id → cus_");
		assert.equal(rec?.email, "a@example.com");

		// Re-upsert (same pair, new email) must not throw and must update.
		await store.upsertCustomer("userA", "cus_A", "a2@example.com");
		assert.equal((await store.getCustomer("userA"))?.email, "a2@example.com", "email bumped");
	});

	it("a cus_ already owned by another user FAILS HARD (UNIQUE) — no silent steal", async () => {
		const store = await freshStore("grants-cmap-collide-");
		await store.upsertCustomer("userA", "cus_SHARED");
		await assert.rejects(
			() => store.upsertCustomer("userB", "cus_SHARED"),
			/UNIQUE|constraint/i,
			"a second user claiming the same cus_ must reject, not overwrite",
		);
		assert.equal(await store.getUserByCustomer("cus_SHARED"), "userA", "original mapping intact");
	});
});

// ─── 2. The happy-path credit ───────────────────────────────────────────────
describe("billing-stripe: a live USD grant credits the ledger exactly once", () => {
	it("brand-new payer lands at FREE_TIER + top-up; grant + webhook recorded", async () => {
		const store = await freshStore("grants-happy-");
		const webhook = makeWebhook({ eventId: "evt_1" });
		const grant = makeGrant({
			grantId: "pi:pi_1",
			userId: "payer",
			sourceEventId: "evt_1",
			amountMicroUsd: 5_000_000,
		});

		const res = await store.recordGrantAndCredit(webhook, grant);
		assert.deepEqual(res, { isNewGrant: true, credited: true });

		assert.equal(await balanceOf(store, "payer"), FREE_TIER_BALANCE_MICRO_USD + 5_000_000, "free tier + the top-up");
		const g = await store.getGrant("pi:pi_1");
		assert.equal(g?.credited, true, "grant row marks credited");
		assert.equal(g?.amountMicroUsd, 5_000_000);
	});
});

// ─── 3 & 4. The two idempotency layers (the double-credit guard) ────────────
describe("billing-stripe: idempotency — one payment credits once", () => {
	it("redelivery of the SAME webhook (same evt_, same grant) credits once", async () => {
		const store = await freshStore("grants-redeliver-");
		const webhook = makeWebhook({ eventId: "evt_dup" });
		const grant = makeGrant({
			grantId: "pi:pi_dup",
			userId: "u",
			sourceEventId: "evt_dup",
			amountMicroUsd: 3_000_000,
		});

		const first = await store.recordGrantAndCredit(webhook, grant);
		const second = await store.recordGrantAndCredit(webhook, grant); // Stripe redelivers

		assert.deepEqual(first, { isNewGrant: true, credited: true });
		assert.deepEqual(second, { isNewGrant: false, credited: false }, "redelivery is a no-op for money");
		assert.equal(await balanceOf(store, "u"), FREE_TIER_BALANCE_MICRO_USD + 3_000_000, "credited ONCE");
	});

	it("the SAME payment under a DIFFERENT evt_ (new webhook row, same grant_id) credits once", async () => {
		const store = await freshStore("grants-multievt-");
		// Stripe emits one settled payment under multiple event ids. The MONEY idem
		// key is grant_id (pi_…), NOT the evt_ id — so this must NOT double-credit.
		const grant = makeGrant({ grantId: "pi:pi_same", userId: "u", amountMicroUsd: 4_000_000 });
		const r1 = await store.recordGrantAndCredit(makeWebhook({ eventId: "evt_a" }), {
			...grant,
			sourceEventId: "evt_a",
		});
		const r2 = await store.recordGrantAndCredit(makeWebhook({ eventId: "evt_b" }), {
			...grant,
			sourceEventId: "evt_b",
		});

		assert.deepEqual(r1, { isNewGrant: true, credited: true });
		assert.deepEqual(r2, { isNewGrant: false, credited: false }, "different evt_, same pi_ → no second credit");
		assert.equal(
			await balanceOf(store, "u"),
			FREE_TIER_BALANCE_MICRO_USD + 4_000_000,
			"credited ONCE across two evts",
		);
	});
});

// ─── 5 & 6. Gating: test-mode and non-USD are recorded but never credit ─────
describe("billing-stripe: only livemode + USD grants move the live ledger", () => {
	it("a test-mode (livemode=0) grant is recorded with credited=0; ledger untouched", async () => {
		const store = await freshStore("grants-testmode-");
		const res = await store.recordGrantAndCredit(
			makeWebhook({ eventId: "evt_test", livemode: 0 }),
			makeGrant({ grantId: "pi:pi_test", userId: "u", livemode: 0, amountMicroUsd: 9_000_000 }),
		);
		assert.deepEqual(res, { isNewGrant: true, credited: false }, "recorded, not credited");
		assert.equal(await balanceOf(store, "u"), undefined, "no credits row — live ledger untouched");
		assert.equal((await store.getGrant("pi:pi_test"))?.credited, false, "grant marked not-credited");
	});

	it("a non-USD grant is recorded but does not credit (cents→µUSD assumes USD)", async () => {
		const store = await freshStore("grants-eur-");
		const res = await store.recordGrantAndCredit(
			makeWebhook({ eventId: "evt_eur" }),
			makeGrant({ grantId: "pi:pi_eur", userId: "u", currency: "eur", amountMicroUsd: 9_000_000 }),
		);
		assert.deepEqual(res, { isNewGrant: true, credited: false });
		assert.equal(await balanceOf(store, "u"), undefined, "non-USD never touches the ledger");
	});
});

// ─── 7. The amount>0 guard fails BEFORE any write ───────────────────────────
describe("billing-stripe: a non-positive amount throws before touching the db", () => {
	it("amount<=0 rejects and writes NO webhook, NO grant, NO credit", async () => {
		const store = await freshStore("grants-nonpos-");
		await assert.rejects(
			() =>
				store.recordGrantAndCredit(
					makeWebhook({ eventId: "evt_zero" }),
					makeGrant({ grantId: "pi:pi_zero", userId: "u", amountMicroUsd: 0 }),
				),
			/must be > 0/,
			"zero/negative are not credit_grants",
		);
		assert.equal(await store.getGrant("pi:pi_zero"), undefined, "no grant row");
		assert.equal(await balanceOf(store, "u"), undefined, "no ledger row");
	});
});

// ─── 8. Credit and debit share the one ledger coherently ────────────────────
describe("billing-stripe: money-IN and money-OUT compose on the same ledger", () => {
	it("a $5 top-up then a $2 debit leaves FREE_TIER + 5 - 2", async () => {
		const store = await freshStore("grants-compose-");
		await store.recordGrantAndCredit(
			makeWebhook({ eventId: "evt_c" }),
			makeGrant({ grantId: "pi:pi_c", userId: "u", amountMicroUsd: 5_000_000 }),
		);
		await store.recordUsageAndDebit(makeUsageEvent({ eventId: "req_c", userId: "u", costMicroUsd: 2_000_000 }));

		assert.equal(
			await balanceOf(store, "u"),
			FREE_TIER_BALANCE_MICRO_USD + 5_000_000 - 2_000_000,
			"one ledger, both folds",
		);
	});
});

// ─── 9. Real concurrency through the substrate writeChain (no SQLITE_BUSY) ──
describe("billing-stripe: concurrent grants serialize correctly (real libSQL)", () => {
	it("20 DISTINCT grants fired concurrently all credit once; balance is exact, zero SQLITE_BUSY", async () => {
		const store = await freshStore("grants-conc-distinct-");
		const N = 20;
		const each = 1_000_000; // $1 each
		const results = await Promise.all(
			Array.from({ length: N }, (_, i) =>
				store.recordGrantAndCredit(
					makeWebhook({ eventId: `evt_${i}` }),
					makeGrant({ grantId: `pi:pi_${i}`, userId: "whale", sourceEventId: `evt_${i}`, amountMicroUsd: each }),
				),
			),
		);
		assert.equal(results.filter((r) => r.credited).length, N, "all 20 credited (no dropped writes / SQLITE_BUSY)");
		assert.equal(
			await balanceOf(store, "whale"),
			FREE_TIER_BALANCE_MICRO_USD + N * each,
			"balance exact — serialized adds, none lost",
		);
	});

	it("10 concurrent copies of the SAME grant credit EXACTLY once", async () => {
		const store = await freshStore("grants-conc-same-");
		const webhook = makeWebhook({ eventId: "evt_race" });
		const grant = makeGrant({
			grantId: "pi:pi_race",
			userId: "u",
			sourceEventId: "evt_race",
			amountMicroUsd: 7_000_000,
		});
		const results = await Promise.all(Array.from({ length: 10 }, () => store.recordGrantAndCredit(webhook, grant)));

		assert.equal(results.filter((r) => r.isNewGrant).length, 1, "exactly one insert won the race");
		assert.equal(results.filter((r) => r.credited).length, 1, "exactly one credit");
		assert.equal(
			await balanceOf(store, "u"),
			FREE_TIER_BALANCE_MICRO_USD + 7_000_000,
			"credited once despite 10-way race",
		);
	});
});
