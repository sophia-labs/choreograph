/**
 * `credit_adjustments` (Sobremesa, E §4.4.4) — REAL libSQL, NO MOCKS.
 *
 * The ledger had no signed path: `credit_grants.amount_micro_usd > 0` is a CHECK, so goodwill,
 * forgiven overdrafts, refunds, chargebacks and operator funding of test accounts had nowhere to
 * go. An adjustment is signed, idempotent on its own key, names an actor and a reason, and moves
 * the balance in the SAME transaction that records it. It is not usage: `lifetime_usage` never
 * moves, and a debit still lands after it.
 *
 * RUN:  npx tsx --test src/test/billing-credit-adjustments.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createClient } from "@libsql/client";
import { FREE_TIER_BALANCE_MICRO_USD } from "../billing-pricing.js";
import {
	BillingStore,
	CREDIT_ADJUSTMENT_KINDS,
	type CreditAdjustmentInput,
	type CreditAdjustmentKind,
} from "../billing-store.js";
import { seedBalance, usageEvent } from "./billing-ledger-fixture.js";

async function freshStore(): Promise<{ store: BillingStore; dir: string }> {
	const dir = mkdtempSync(join(tmpdir(), "credit-adjustments-"));
	after(() => rmSync(dir, { recursive: true, force: true }));
	const store = new BillingStore(join(dir, "billing.sqlite"));
	await store.init();
	after(() => store.close());
	return { store, dir };
}

function adjustment(over: Partial<CreditAdjustmentInput> = {}): CreditAdjustmentInput {
	return {
		adjustmentId: "ops:credits-start-2026:user-a",
		userId: "user-a",
		amountMicroUsd: 250_000,
		kind: "goodwill",
		reason: "credits start",
		actor: "script:goodwill-lift",
		batchId: "credits-start-2026",
		sourceRef: null,
		...over,
	};
}

describe("credit_adjustments: a signed, idempotent, attributed ledger movement", () => {
	it("names the kinds the design uses", () => {
		assert.deepEqual(
			[...CREDIT_ADJUSTMENT_KINDS],
			["goodwill", "operator_funding", "correction", "refund", "dispute"],
		);
	});

	it("a positive adjustment raises the balance by exactly its amount and records who and why", async () => {
		const { store } = await freshStore();
		await seedBalance(store, "user-a", 400_000);
		const result = await store.recordCreditAdjustment(adjustment({ amountMicroUsd: 600_000 }));
		assert.deepEqual(result, { isNew: true, balanceMicroUsd: 1_000_000 });
		assert.equal((await store.getCredit("user-a"))?.balanceMicroUsd, 1_000_000);

		const row = await store.getCreditAdjustment("ops:credits-start-2026:user-a");
		assert.ok(row);
		assert.equal(row.userId, "user-a");
		assert.equal(row.amountMicroUsd, 600_000);
		assert.equal(row.kind, "goodwill");
		assert.equal(row.reason, "credits start");
		assert.equal(row.actor, "script:goodwill-lift");
		assert.equal(row.batchId, "credits-start-2026");
		assert.equal(row.sourceRef, null);
		assert.ok(row.createdAt > 0);
	});

	it("a negative adjustment lowers it, even below zero: a refund after the credit was spent", async () => {
		const { store } = await freshStore();
		await seedBalance(store, "user-a", 100_000);
		const result = await store.recordCreditAdjustment(
			adjustment({
				adjustmentId: "refund:pi_1:500",
				amountMicroUsd: -5_000_000,
				kind: "refund",
				reason: "Refund of a credit purchase",
				actor: "stripe:webhook",
				sourceRef: "pi_1",
			}),
		);
		assert.deepEqual(result, { isNew: true, balanceMicroUsd: 100_000 - 5_000_000 });
	});

	it("a fresh person is seeded with the $1.00 starter first, exactly as a first debit or top-up does", async () => {
		const { store } = await freshStore();
		assert.equal(await store.getCredit("newcomer"), undefined);
		const result = await store.recordCreditAdjustment(
			adjustment({ adjustmentId: "ops:fund:newcomer", userId: "newcomer", amountMicroUsd: 2_000_000 }),
		);
		assert.equal(result.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD + 2_000_000);
	});

	it("is idempotent on its key: a replay is a no-op that still reports the current balance", async () => {
		const { store } = await freshStore();
		await seedBalance(store, "user-a", 400_000);
		const first = await store.recordCreditAdjustment(adjustment({ amountMicroUsd: 100_000 }));
		assert.equal(first.isNew, true);
		const replay = await store.recordCreditAdjustment(adjustment({ amountMicroUsd: 100_000 }));
		assert.deepEqual(replay, { isNew: false, balanceMicroUsd: 500_000 });
		assert.equal((await store.getCredit("user-a"))?.balanceMicroUsd, 500_000, "credited once");
		assert.equal((await store.listCreditAdjustments({ userId: "user-a" })).length, 1);
	});

	it("refuses a key reused for a DIFFERENT movement instead of silently keeping the first", async () => {
		const { store } = await freshStore();
		await seedBalance(store, "user-a", 400_000);
		await store.recordCreditAdjustment(adjustment({ amountMicroUsd: 100_000 }));
		await assert.rejects(
			store.recordCreditAdjustment(adjustment({ amountMicroUsd: 999_999 })),
			/idempotency conflict/,
		);
		await assert.rejects(store.recordCreditAdjustment(adjustment({ userId: "user-b" })), /idempotency conflict/);
		await assert.rejects(store.recordCreditAdjustment(adjustment({ kind: "correction" })), /idempotency conflict/);
		assert.equal((await store.getCredit("user-a"))?.balanceMicroUsd, 500_000);
	});

	it("is not usage: lifetime usage never moves, and a later debit still lands", async () => {
		const { store } = await freshStore();
		await seedBalance(store, "user-a", 400_000);
		const before = await store.getCredit("user-a");
		await store.recordCreditAdjustment(adjustment({ amountMicroUsd: 600_000 }));
		assert.equal((await store.getCredit("user-a"))?.lifetimeUsageMicroUsd, before?.lifetimeUsageMicroUsd);
		await store.recordUsageAndDebit(usageEvent({ eventId: "after-adjust", userId: "user-a", costMicroUsd: 1_500 }));
		assert.equal((await store.getCredit("user-a"))?.balanceMicroUsd, 1_000_000 - 1_500);
	});

	it("concurrent identical adjustments credit exactly once", async () => {
		const { store } = await freshStore();
		await seedBalance(store, "user-a", 0);
		const results = await Promise.all(Array.from({ length: 12 }, () => store.recordCreditAdjustment(adjustment())));
		assert.equal(results.filter((r) => r.isNew).length, 1);
		assert.equal((await store.getCredit("user-a"))?.balanceMicroUsd, 250_000);
	});

	it("validates: a signed non-zero integer, a real kind, a reason and an actor", async () => {
		const { store } = await freshStore();
		for (const amountMicroUsd of [0, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
			await assert.rejects(store.recordCreditAdjustment(adjustment({ amountMicroUsd })), /amount/);
		}
		await assert.rejects(store.recordCreditAdjustment(adjustment({ kind: "gift" as CreditAdjustmentKind })), /kind/);
		await assert.rejects(store.recordCreditAdjustment(adjustment({ reason: "  " })), /reason/);
		await assert.rejects(store.recordCreditAdjustment(adjustment({ actor: "" })), /actor/);
		await assert.rejects(store.recordCreditAdjustment(adjustment({ adjustmentId: "" })), /adjustmentId/);
		await assert.rejects(store.recordCreditAdjustment(adjustment({ userId: "" })), /userId/);
		assert.deepEqual(await store.listCreditAdjustments({}), [], "nothing was written");
		assert.equal(await store.getCredit("user-a"), undefined, "and no ledger row was seeded by a refused call");
	});

	it("bounds the free text it stores", async () => {
		const { store } = await freshStore();
		await store.recordCreditAdjustment(adjustment({ reason: "r".repeat(2_000), actor: "a".repeat(2_000) }));
		const row = await store.getCreditAdjustment("ops:credits-start-2026:user-a");
		assert.equal(row?.reason.length, 500);
		assert.equal(row?.actor.length, 200);
	});

	it("lists by person and by batch, oldest first, for review before and after an apply", async () => {
		const { store } = await freshStore();
		for (const user of ["a", "b", "c"]) await seedBalance(store, user, 200_000);
		for (const user of ["a", "b"]) {
			await store.recordCreditAdjustment(
				adjustment({
					adjustmentId: `ops:batch-1:${user}`,
					userId: user,
					batchId: "batch-1",
					amountMicroUsd: 800_000,
				}),
			);
		}
		await store.recordCreditAdjustment(
			adjustment({ adjustmentId: "ops:batch-2:c", userId: "c", batchId: "batch-2", amountMicroUsd: 1 }),
		);
		assert.deepEqual(
			(await store.listCreditAdjustments({ batchId: "batch-1" })).map((r) => r.userId),
			["a", "b"],
		);
		assert.deepEqual(
			(await store.listCreditAdjustments({ userId: "c" })).map((r) => r.batchId),
			["batch-2"],
		);
		assert.equal((await store.listCreditAdjustments({})).length, 3);
	});

	it("a database with the ledger but no adjustments table gains it on open, and keeps every balance", async () => {
		const { dir } = await freshStore();
		const path = join(dir, "legacy.sqlite");
		const legacy = new BillingStore(path);
		await legacy.init();
		await seedBalance(legacy, "user-a", 400_000);
		legacy.close();
		const raw = createClient({ url: `file:${path}` });
		await raw.execute("DROP TABLE credit_adjustments");
		raw.close();
		const reopened = new BillingStore(path);
		await reopened.init();
		try {
			assert.equal((await reopened.getCredit("user-a"))?.balanceMicroUsd, 400_000);
			const result = await reopened.recordCreditAdjustment(adjustment({ amountMicroUsd: 100_000 }));
			assert.equal(result.balanceMicroUsd, 500_000);
		} finally {
			reopened.close();
		}
	});

	it("rides the snapshot: the adjustment rows are in the file the S3 snapshot ships", async () => {
		const { store, dir } = await freshStore();
		await seedBalance(store, "user-a", 400_000);
		await store.recordCreditAdjustment(adjustment({ amountMicroUsd: 100_000 }));
		const snapshotPath = join(dir, "snapshot.sqlite");
		await store.snapshotToFile(snapshotPath);
		const reader = createClient({ url: `file:${snapshotPath}` });
		try {
			const rows = await reader.execute("SELECT actor, reason, amount_micro_usd FROM credit_adjustments");
			assert.equal(rows.rows.length, 1);
			assert.equal(String(rows.rows[0].actor), "script:goodwill-lift");
			assert.equal(Number(rows.rows[0].amount_micro_usd), 100_000);
		} finally {
			reader.close();
		}
	});
});
