/**
 * Billing Phase 1 (DECREMENT) — credit ledger, REAL libSQL (NO MOCKS).
 *
 * Every test opens a real `file:` libSQL db in os.tmpdir() and drives the real
 * BillingStore.recordUsageAndDebit + real computeCost against real
 * ProxyUsage-shaped inputs. No stubs, no fakes. Includes a REAL concurrency
 * test (Promise.all over N distinct events) proving no overspend — the final
 * balance is exact, not approximate. Run via `tsx --test`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createClient } from "@libsql/client";
import {
	computeCost,
	FREE_TIER_BALANCE_MICRO_USD,
	MIN_ALLOWED_BALANCE_MICRO_USD,
	PRICING_VERSION,
} from "../billing-pricing.js";
import { BillingStore, type UsageEventInput } from "../billing-store.js";

function tmpDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Open a fresh, real, initialized BillingStore over a `file:` db that auto-cleans. */
async function freshStore(): Promise<BillingStore> {
	const dir = tmpDir("billing-ledger-");
	after(() => rmSync(dir, { recursive: true, force: true }));
	const store = new BillingStore(join(dir, "billing.sqlite"));
	await store.init();
	return store;
}

/** Build a real usage-event payload from a model + token counts, priced for real. */
function makeEvent(over: Partial<UsageEventInput> & { eventId: string }): UsageEventInput {
	const provider = over.provider ?? "openrouter";
	const model = over.model ?? "google/gemini-2.5-flash";
	const input = over.inputTokens ?? 1000;
	const output = over.outputTokens ?? 500;
	const cacheRead = over.cacheReadTokens ?? 200;
	const cacheWrite = over.cacheWriteTokens ?? 0;
	const cost = computeCost(model, { input, output, cacheRead, cacheWrite }, provider);
	return {
		eventId: over.eventId,
		ts: over.ts ?? Date.now(),
		userId: over.userId ?? "cognito-sub-A",
		graphId: over.graphId ?? "choreograph-2",
		sandboxId: over.sandboxId ?? "sbx_abcdef",
		template: over.template ?? "agent",
		provider,
		model,
		modelPriced: cost.modelPriced,
		reason: over.reason ?? "stop",
		inputTokens: input,
		outputTokens: output,
		cacheReadTokens: cacheRead,
		cacheWriteTokens: cacheWrite,
		totalTokens: over.totalTokens ?? input + output + cacheRead + cacheWrite,
		inputCostMicroUsd: cost.inputCostMicroUsd,
		outputCostMicroUsd: cost.outputCostMicroUsd,
		cacheReadCostMicroUsd: cost.cacheReadCostMicroUsd,
		cacheWriteCostMicroUsd: cost.cacheWriteCostMicroUsd,
		providerCostMicroUsd: cost.providerCostMicroUsd,
		markupMicroUsd: cost.markupMicroUsd,
		costMicroUsd: cost.totalCostMicroUsd,
		pricingVersion: PRICING_VERSION,
		pricedDefault: cost.pricedDefault,
		...over,
	};
}

/** The integer-µUSD total cost the default makeEvent shape prices to (recomputed, not magic). */
function defaultCost(): number {
	return makeEvent({ eventId: "_probe_" }).costMicroUsd;
}

describe("BillingStore credit ledger — Phase 1 DECREMENT (real file: libSQL)", () => {
	it("migrates historical usage to platform funding without replaying its debit", async () => {
		const directory = tmpDir("byok-billing-upgrade-");
		const path = join(directory, "billing.sqlite");
		let store = new BillingStore(path);
		try {
			await store.init();
			const event = makeEvent({ eventId: "old-funded", userId: "legacy-owner" });
			await store.recordUsageAndDebit(event);
			const credit = await store.getCredit("legacy-owner");
			store.close();
			const legacy = createClient({ url: `file:${path}` });
			try {
				await legacy.execute("ALTER TABLE usage_events DROP COLUMN funding_source");
			} finally {
				legacy.close();
			}
			store = new BillingStore(path);
			await store.init();
			assert.equal((await store.getEvent(event.eventId))?.fundingSource, "platform");
			assert.equal(await store.recordUsageAndDebit(event), false);
			assert.deepEqual(await store.getCredit("legacy-owner"), credit);
			await assert.rejects(store.recordUsageAndDebit({ ...event, fundingSource: "user" }), /funding conflict/);
		} finally {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("user-funded telemetry never seeds/debits credits and replay cannot change funding or owner", async () => {
		const store = await freshStore();
		const event = makeEvent({ eventId: "byok", userId: "byok-owner", fundingSource: "user" });
		assert.ok(event.providerCostMicroUsd > 0);
		assert.equal(await store.recordUsageAndDebit(event), true);
		assert.equal(await store.getCredit("byok-owner"), undefined);
		assert.equal((await store.getEvent(event.eventId))?.providerCostMicroUsd, event.providerCostMicroUsd);
		assert.equal((await store.getEvent(event.eventId))?.fundingSource, "user");
		assert.equal(await store.recordUsageAndDebit(event), false);
		await assert.rejects(store.recordUsageAndDebit({ ...event, fundingSource: "platform" }), /funding conflict/);
		await assert.rejects(store.recordUsageAndDebit({ ...event, userId: "other" }), /funding conflict/);
		const platform = makeEvent({ eventId: "legacy-platform", userId: "existing-owner" });
		await store.recordUsageAndDebit(platform);
		const before = await store.getCredit("existing-owner");
		await store.recordUsageAndDebit({ ...event, eventId: "byok-existing", userId: "existing-owner" });
		assert.deepEqual(await store.getCredit("existing-owner"), before);
		assert.equal((await store.getEvent(platform.eventId))?.fundingSource, "platform");
		await assert.rejects(store.recordUsageAndDebit({ ...platform, fundingSource: "user" }), /funding conflict/);
	});

	it("lazy-inits the free-tier row on first debit (fresh users are independent)", async () => {
		const store = await freshStore();

		// Before any usage, the user has no credit row at all.
		assert.equal(await store.getCredit("fresh-A"), undefined, "no row before first debit");

		const e = makeEvent({ eventId: "fa-1", userId: "fresh-A" });
		assert.equal(await store.recordUsageAndDebit(e), true, "first usage inserts");

		const credit = await store.getCredit("fresh-A");
		assert.ok(credit, "credit row lazily created");
		assert.equal(credit.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD - e.costMicroUsd, "seeded free tier minus cost");
		assert.equal(credit.lifetimeUsageMicroUsd, e.costMicroUsd, "lifetime == this event's cost");

		// A second, untouched user is fully independent (no leakage from A's row).
		assert.equal(await store.getCredit("fresh-B"), undefined, "user B unaffected by A's debit");
		store.close();
	});

	it("a single debit decrements balance + bumps lifetime by EXACTLY the priced cost", async () => {
		const store = await freshStore();
		// Known model + token counts → recompute the cost from the SAME computeCost,
		// so we cross-check the arithmetic, not a magic number.
		const model = "anthropic/claude-sonnet-4.5";
		const cost = computeCost(model, { input: 3000, output: 1500, cacheRead: 0, cacheWrite: 0 }).totalCostMicroUsd;

		const e = makeEvent({
			eventId: "single-1",
			userId: "u-single",
			model,
			inputTokens: 3000,
			outputTokens: 1500,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
		assert.equal(e.costMicroUsd, cost, "event prices to the recomputed cost");
		assert.equal(await store.recordUsageAndDebit(e), true);

		const credit = await store.getCredit("u-single");
		assert.ok(credit);
		assert.equal(credit.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD - cost);
		assert.equal(credit.lifetimeUsageMicroUsd, cost);
		store.close();
	});

	it("a duplicate request_id does NOT double-debit (idempotent both-or-neither)", async () => {
		const store = await freshStore();
		const cost = defaultCost();

		const first = makeEvent({ eventId: "dup-req", userId: "u-dup", inputTokens: 1000, outputTokens: 500 });
		// Same eventId, DIFFERENT numbers — proves the second is a pure no-op for
		// BOTH the usage row AND the debit.
		const second = makeEvent({ eventId: "dup-req", userId: "u-dup", inputTokens: 999_999, outputTokens: 999_999 });

		assert.equal(await store.recordUsageAndDebit(first), true, "first lands");
		assert.equal(await store.recordUsageAndDebit(second), false, "duplicate is a no-op");

		const credit = await store.getCredit("u-dup");
		assert.ok(credit);
		assert.equal(credit.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD - cost, "balance debited exactly ONCE");
		assert.equal(credit.lifetimeUsageMicroUsd, cost, "lifetime incremented exactly ONCE");

		// Exactly one usage row, and it is the FIRST payload (immutable).
		const sum = await store.sumByUser("u-dup", 0, Date.now() + 1);
		assert.equal(sum.n, 1, "duplicate created no second usage row");
		const got = await store.getEvent("dup-req");
		assert.ok(got);
		assert.equal(got.inputTokens, 1000, "stored usage row is the FIRST write");
		store.close();
	});

	it("CONCURRENCY: N parallel debits serialize → exact balance, overspend impossible", async () => {
		const store = await freshStore();
		const N = 50;
		// Fixed per-event cost so the final balance is an exact closed form.
		const events = Array.from({ length: N }, (_, i) =>
			makeEvent({ eventId: `conc-${i}`, userId: "u-conc", inputTokens: 1000, outputTokens: 500 }),
		);
		const cost = events[0].costMicroUsd;
		assert.ok(
			events.every((e) => e.costMicroUsd === cost),
			"all events priced identically",
		);

		// Drive REAL concurrent writers against the REAL file: db. libSQL
		// transaction("write") serializes writers on one file → no lost updates.
		const results = await Promise.all(events.map((e) => store.recordUsageAndDebit(e)));
		assert.equal(results.filter((r) => r).length, N, "every distinct event inserted exactly once (no spurious dup)");

		const credit = await store.getCredit("u-conc");
		assert.ok(credit);
		// EXACT — not "approximately". This is the overspend-impossible proof.
		assert.equal(credit.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD - N * cost, "final balance is exact");
		assert.equal(credit.lifetimeUsageMicroUsd, N * cost, "lifetime is the exact sum, no lost updates");

		// The ledger is reconstructible from the immutable usage truth.
		const sum = await store.sumByUser("u-conc", 0, Date.now() + 1);
		assert.equal(sum.n, N, "exactly N usage rows");
		assert.equal(credit.lifetimeUsageMicroUsd, sum.totalMicroUsd, "ledger == SUM(usage_events.cost)");
		store.close();
	});

	it("no silent floor: every platform cost is debited, the balance goes below zero by exactly the cost", async () => {
		// Sobremesa (E §4.4.1): the -$0.50 guard used to skip a debit silently while the
		// usage row was still written, so a person past the floor chatted for free and the
		// ledger stopped matching usage. The floor is now an ADMISSION rule (billing-gate),
		// never a reason to lose a cost that was already incurred.
		const store = await freshStore();
		const user = "u-no-floor";
		const cost = computeCost("anthropic/claude-opus-4.1", {
			input: 100_000,
			output: 5_000,
			cacheRead: 0,
			cacheWrite: 0,
		}).totalCostMicroUsd;
		assert.ok(cost > 0);

		// Far more debits than the seed can fund (and than the old -$0.50 floor allowed).
		const N = 8;
		for (let i = 0; i < N; i++) {
			assert.equal(
				await store.recordUsageAndDebit(
					makeEvent({
						eventId: `nofloor-${i}`,
						userId: user,
						model: "anthropic/claude-opus-4.1",
						inputTokens: 100_000,
						outputTokens: 5_000,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
					}),
				),
				true,
			);
		}
		const credit = await store.getCredit(user);
		assert.ok(credit);
		assert.equal(credit.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD - N * cost, "every cost debited, none skipped");
		assert.ok(credit.balanceMicroUsd < MIN_ALLOWED_BALANCE_MICRO_USD, "the balance is far below the old floor");
		assert.equal(credit.lifetimeUsageMicroUsd, N * cost, "lifetime counts every recorded event");
		const sum = await store.sumByUser(user, 0, Date.now() + 1);
		assert.equal(credit.lifetimeUsageMicroUsd, sum.totalMicroUsd, "ledger == SUM(usage_events.cost), no drift");
		store.close();
	});

	it("the order-dependent skip is gone (E L10: 900k, 2M, 550k, 100k against a $1.00 seed)", async () => {
		// Before: the first and third were debited, the second and fourth skipped; the row
		// ended at -450,000 with lifetime 1,450,000 while 3,550,000 had been recorded.
		const store = await freshStore();
		const user = "u-l10";
		for (const [i, cost] of [900_000, 2_000_000, 550_000, 100_000].entries()) {
			const event = makeEvent({ eventId: `l10-${i}`, userId: user, costMicroUsd: cost });
			assert.equal(await store.recordUsageAndDebit(event), true);
		}
		const credit = await store.getCredit(user);
		assert.ok(credit);
		assert.equal(credit.balanceMicroUsd, 1_000_000 - 3_550_000);
		assert.equal(credit.lifetimeUsageMicroUsd, 3_550_000);
		assert.equal((await store.sumByUser(user, 0, Date.now() + 1)).totalMicroUsd, 3_550_000);
		store.close();
	});

	it("the live frozen account (86 µUSD above the old floor) is debited again, not skipped forever", async () => {
		// The 09-29 snapshot held one account at -499,914: above the old -500,000 floor by less
		// than any cost it could pay, so every later event was recorded and never debited.
		const store = await freshStore();
		const user = "u-frozen";
		await store.recordUsageAndDebit(makeEvent({ eventId: "frozen-0", userId: user, costMicroUsd: 1_499_914 }));
		assert.equal((await store.getCredit(user))?.balanceMicroUsd, -499_914);
		await store.recordUsageAndDebit(makeEvent({ eventId: "frozen-1", userId: user, costMicroUsd: 1_775 }));
		const credit = await store.getCredit(user);
		assert.ok(credit);
		assert.equal(credit.balanceMicroUsd, -499_914 - 1_775, "the next cost lands even below the old floor");
		assert.equal(credit.lifetimeUsageMicroUsd, 1_499_914 + 1_775);
		store.close();
	});

	it("a NULL-user event is recorded but NOT debited (no credit row created)", async () => {
		const store = await freshStore();
		const e = makeEvent({ eventId: "anon-1", userId: null, inputTokens: 4000, outputTokens: 2000 });
		assert.equal(await store.recordUsageAndDebit(e), true, "usage row still lands for NULL user");

		// The usage row exists.
		const row = await store.getEvent("anon-1");
		assert.ok(row);
		assert.equal(row.userId, null);
		// But no credit ledger row was created for a NULL user.
		assert.equal(await store.getCredit("anon-1"), undefined, "no credit row for an unattributed event");
		store.close();
	});

	it("cost === 0 debit is a benign no-op on balance but still lazy-inits the row", async () => {
		const store = await freshStore();
		// Zero tokens → zero cost.
		const e = makeEvent({
			eventId: "zero-1",
			userId: "u-zero",
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
		assert.equal(e.costMicroUsd, 0, "zero tokens price to zero cost");
		assert.equal(await store.recordUsageAndDebit(e), true);

		const credit = await store.getCredit("u-zero");
		assert.ok(credit, "row lazy-inited even at zero cost");
		assert.equal(credit.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD, "balance unchanged at zero cost");
		assert.equal(credit.lifetimeUsageMicroUsd, 0);
		store.close();
	});

	it("projection: independent users; each balance == FREE_TIER - SUM(usage cost) (one billing.sqlite, two tables)", async () => {
		const store = await freshStore();
		const aEvents = [
			makeEvent({ eventId: "pa1", userId: "projA", inputTokens: 1000, outputTokens: 500 }),
			makeEvent({ eventId: "pa2", userId: "projA", inputTokens: 2000, outputTokens: 1000 }),
		];
		const bEvents = [
			makeEvent({ eventId: "pb1", userId: "projB", inputTokens: 5000, outputTokens: 2500 }),
			makeEvent({ eventId: "pb2", userId: "projB", inputTokens: 10, outputTokens: 5 }),
			makeEvent({ eventId: "pb3", userId: "projB", inputTokens: 30, outputTokens: 15 }),
		];
		for (const e of [...aEvents, ...bEvents]) {
			assert.equal(await store.recordUsageAndDebit(e), true);
		}

		const sumA = await store.sumByUser("projA", 0, Date.now() + 1);
		const sumB = await store.sumByUser("projB", 0, Date.now() + 1);
		const creditA = await store.getCredit("projA");
		const creditB = await store.getCredit("projB");
		assert.ok(creditA && creditB);

		// Cross-check the credit projection against the usage_events SUM — proves the
		// two tables (in ONE billing.sqlite) stay consistent + independent per user.
		assert.equal(creditA.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD - sumA.totalMicroUsd);
		assert.equal(creditA.lifetimeUsageMicroUsd, sumA.totalMicroUsd);
		assert.equal(creditB.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD - sumB.totalMicroUsd);
		assert.equal(creditB.lifetimeUsageMicroUsd, sumB.totalMicroUsd);
		assert.notEqual(sumA.totalMicroUsd, sumB.totalMicroUsd, "the two users have distinct usage");
		store.close();
	});

	it("snapshotToS3 no-ops when BILLING_DB_S3_URL is unset — credits ride the same single-file snapshot", async () => {
		const prev = process.env.BILLING_DB_S3_URL;
		delete process.env.BILLING_DB_S3_URL;
		try {
			const store = await freshStore();
			// Write a credit row, then confirm the snapshot path is a no-op (no new
			// config needed for `credits` — it lives in the same billing.sqlite).
			await store.recordUsageAndDebit(makeEvent({ eventId: "snap-1", userId: "u-snap" }));
			assert.ok(await store.getCredit("u-snap"));
			assert.equal(await store.snapshotToS3(), null, "no-op when S3 not configured");
			store.close();
		} finally {
			if (prev !== undefined) process.env.BILLING_DB_S3_URL = prev;
		}
	});
});
