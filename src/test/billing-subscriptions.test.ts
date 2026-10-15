/**
 * Billing Phase 1 (TIER) — subscription→tier fold proof, REAL libSQL, NO MOCKS.
 *
 * Proves subscriptionToTier (the fold) and recordSubscriptionAndFold (the write
 * side) against a real `file:` libSQL db. choreograph emits the tier LABEL; the
 * gateway folds the label → EntitlementSet. The load-bearing test is the
 * out-of-order guard: Stripe redelivers AND reorders, and a late-arriving OLDER
 * event must NEVER regress fresher subscription state — verified both serially
 * and under real concurrency through the substrate writeChain.
 *
 * RUN:  from the repository root
 *       npx tsx --test src/test/billing-subscriptions.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	BillingStore,
	defaultPlanTierMap,
	type StripeWebhookInput,
	type SubscriptionInput,
	subscriptionToTier,
	type Tier,
} from "../billing-store.js";

function tmpDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

async function freshStore(prefix: string): Promise<BillingStore> {
	const dir = tmpDir(prefix);
	after(() => rmSync(dir, { recursive: true, force: true }));
	const store = new BillingStore(join(dir, "billing.sqlite"));
	await store.init();
	after(() => store.close());
	return store;
}

const PLAN_MAP: Record<string, Tier> = { price_pro: "pro", price_vis: "visionary" };

function makeWebhook(over: Partial<StripeWebhookInput> & { eventId: string }): StripeWebhookInput {
	return {
		eventType: over.eventType ?? "customer.subscription.updated",
		stripeCreated: over.stripeCreated ?? 1_000,
		apiVersion: over.apiVersion ?? "2024-06-20",
		livemode: over.livemode ?? 1,
		stripeCustomerId: over.stripeCustomerId ?? "cus_S",
		payloadSha256: over.payloadSha256 ?? "sig",
		...over,
	};
}

function makeSub(over: Partial<SubscriptionInput> & { userId: string }): SubscriptionInput {
	return {
		stripeCustomerId: over.stripeCustomerId ?? "cus_S",
		stripeSubscriptionId: over.stripeSubscriptionId ?? "sub_1",
		plan: over.plan ?? "price_pro",
		status: over.status ?? "active",
		currentPeriodEnd: over.currentPeriodEnd ?? 2_000_000,
		livemode: over.livemode ?? 1,
		...over,
	};
}

// ─── 1. The fold (pure) ─────────────────────────────────────────────────────
describe("billing-subscriptions: subscriptionToTier fold", () => {
	it("active/trialing maps the plan; non-active downgrades; unknown plan → free", () => {
		assert.equal(subscriptionToTier("price_pro", "active", PLAN_MAP), "pro");
		assert.equal(subscriptionToTier("price_vis", "trialing", PLAN_MAP), "visionary");
		// unknown plan, active → free (conservative; never grant a tier we don't recognize).
		assert.equal(subscriptionToTier("price_mystery", "active", PLAN_MAP), "free");
		// non-active statuses downgrade regardless of plan.
		for (const status of ["canceled", "past_due", "incomplete", "unpaid", "paused"]) {
			assert.equal(subscriptionToTier("price_pro", status, PLAN_MAP), "free", `${status} → free`);
		}
		// empty default map → everything free.
		assert.equal(subscriptionToTier("price_pro", "active", {}), "free");
	});

	it("defaultPlanTierMap parses STRIPE_PLAN_TIER_MAP env (and tolerates garbage)", () => {
		const prev = process.env.STRIPE_PLAN_TIER_MAP;
		try {
			process.env.STRIPE_PLAN_TIER_MAP = JSON.stringify({ price_x: "pro" });
			assert.equal(defaultPlanTierMap().price_x, "pro");
			process.env.STRIPE_PLAN_TIER_MAP = "{not json";
			assert.deepEqual(defaultPlanTierMap(), {});
			delete process.env.STRIPE_PLAN_TIER_MAP;
			assert.deepEqual(defaultPlanTierMap(), {});
		} finally {
			if (prev === undefined) delete process.env.STRIPE_PLAN_TIER_MAP;
			else process.env.STRIPE_PLAN_TIER_MAP = prev;
		}
	});
});

// ─── 2. record + fold + the out-of-order guard ──────────────────────────────
describe("billing-subscriptions: recordSubscriptionAndFold", () => {
	it("an active pro subscription folds to pro and lands in subscription_state", async () => {
		const store = await freshStore("subs-happy-");
		const res = await store.recordSubscriptionAndFold(
			makeWebhook({ eventId: "evt_sub1", stripeCreated: 100 }),
			makeSub({ userId: "u", plan: "price_pro", status: "active" }),
			PLAN_MAP,
		);
		assert.deepEqual(res, { applied: true, tier: "pro" });
		const row = await store.getSubscription("u");
		assert.equal(row?.tier, "pro");
		assert.equal(row?.status, "active");
		assert.equal(row?.eventCreated, 100);
	});

	it("an out-of-order OLDER event NEVER regresses fresher state", async () => {
		const store = await freshStore("subs-ooo-");
		// newer event first: active pro at created=200.
		await store.recordSubscriptionAndFold(
			makeWebhook({ eventId: "evt_new", stripeCreated: 200 }),
			makeSub({ userId: "u", plan: "price_pro", status: "active" }),
			PLAN_MAP,
		);
		// then a LATE-arriving OLDER cancel at created=100 → must NOT apply.
		const late = await store.recordSubscriptionAndFold(
			makeWebhook({ eventId: "evt_old", stripeCreated: 100 }),
			makeSub({ userId: "u", plan: "price_pro", status: "canceled" }),
			PLAN_MAP,
		);
		assert.equal(late.applied, false, "older event is skipped");
		const row = await store.getSubscription("u");
		assert.equal(row?.tier, "pro", "still pro — not regressed by the stale cancel");
		assert.equal(row?.status, "active");
		assert.equal(row?.eventCreated, 200);
	});

	it("a NEWER cancel downgrades to free", async () => {
		const store = await freshStore("subs-downgrade-");
		await store.recordSubscriptionAndFold(
			makeWebhook({ eventId: "evt_a", stripeCreated: 100 }),
			makeSub({ userId: "u", plan: "price_pro", status: "active" }),
			PLAN_MAP,
		);
		const res = await store.recordSubscriptionAndFold(
			makeWebhook({ eventId: "evt_b", stripeCreated: 300 }),
			makeSub({ userId: "u", plan: "price_pro", status: "canceled" }),
			PLAN_MAP,
		);
		assert.deepEqual(res, { applied: true, tier: "free" });
		const row = await store.getSubscription("u");
		assert.equal(row?.tier, "free");
		assert.equal(row?.status, "canceled");
	});

	it("redelivery of the same event is idempotent (equal ts re-applies harmlessly)", async () => {
		const store = await freshStore("subs-idem-");
		const wh = makeWebhook({ eventId: "evt_x", stripeCreated: 150 });
		const sub = makeSub({ userId: "u", plan: "price_vis", status: "active" });
		const a = await store.recordSubscriptionAndFold(wh, sub, PLAN_MAP);
		const b = await store.recordSubscriptionAndFold(wh, sub, PLAN_MAP);
		assert.deepEqual(a, { applied: true, tier: "visionary" });
		assert.deepEqual(b, { applied: true, tier: "visionary" }, "equal-ts re-apply is harmless");
		assert.equal((await store.getSubscription("u"))?.tier, "visionary");
	});

	it("concurrent events for one user converge to the NEWEST (no lost newer)", async () => {
		const store = await freshStore("subs-conc-");
		const events = [
			{ id: "e1", ts: 100, status: "active", plan: "price_pro" },
			{ id: "e2", ts: 300, status: "canceled", plan: "price_pro" }, // newest → free
			{ id: "e3", ts: 200, status: "active", plan: "price_vis" },
		];
		await Promise.all(
			events.map((e) =>
				store.recordSubscriptionAndFold(
					makeWebhook({ eventId: e.id, stripeCreated: e.ts }),
					makeSub({ userId: "u", plan: e.plan, status: e.status }),
					PLAN_MAP,
				),
			),
		);
		const row = await store.getSubscription("u");
		assert.equal(row?.eventCreated, 300, "newest event wins regardless of arrival order");
		assert.equal(row?.tier, "free", "final tier = the newest event's fold (canceled → free)");
	});
});
