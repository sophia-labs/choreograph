/**
 * Stripe webhook (Billing I&E P1b) — REAL libSQL + REAL HMAC signatures, NO MOCKS.
 *
 * Proves the dep-free signature verification (real crypto, not a stub) and the
 * full ingestion flow against a real BillingStore: customer.created maps cus_↔sub,
 * a subscription folds to a tier, a payment credits the ledger (once), an
 * unmapped customer 409s (Stripe retries), and an unhandled type is acked.
 *
 * RUN:  from the repository root
 *       npx tsx --test src/test/stripe-webhook.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { FREE_TIER_BALANCE_MICRO_USD } from "../billing-pricing.js";
import { BillingStore, type Tier } from "../billing-store.js";
import { processStripeWebhook, signStripePayload, verifyStripeSignature } from "../stripe-webhook.js";

const SECRET = "whsec_test_p1b";
const PLAN_MAP: Record<string, Tier> = { price_pro: "pro" };
const T = 1_700_000_000;

async function freshStore(prefix: string): Promise<BillingStore> {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	after(() => rmSync(dir, { recursive: true, force: true }));
	const store = new BillingStore(join(dir, "billing.sqlite"));
	await store.init();
	after(() => store.close());
	return store;
}

/** A paid Checkout top-up session event, as Stripe sends it (`mode: payment`, `metadata.kind: topup`). */
function topUpSession(eventId: string, sessionId: string, customer: string, cents: number) {
	return {
		id: eventId,
		type: "checkout.session.completed",
		created: T,
		livemode: true,
		data: {
			object: {
				id: sessionId,
				mode: "payment",
				payment_status: "paid",
				customer,
				metadata: { kind: "topup" },
				amount_subtotal: cents,
				amount_total: cents,
				currency: "usd",
				payment_intent: `pi_of_${sessionId}`,
			},
		},
	};
}

/** Build a signed event + process it (real HMAC, real store, no mocks). */
function post(
	store: BillingStore,
	event: object,
	opts?: { tSecs?: number; sigHeader?: string; pushTier?: (sub: string, tier: Tier) => Promise<void> },
) {
	const rawBody = JSON.stringify(event);
	const t = opts?.tSecs ?? T;
	const sig = opts?.sigHeader ?? signStripePayload(rawBody, SECRET, t);
	return processStripeWebhook(rawBody, sig, {
		billing: store,
		secret: SECRET,
		planTierMap: PLAN_MAP,
		nowSecs: t,
		pushTier: opts?.pushTier,
	});
}

// ─── 1. signature verification (real crypto) ────────────────────────────────
describe("stripe-webhook: signature verification", () => {
	it("accepts a correctly-signed body; rejects tamper, wrong secret, stale ts, missing", () => {
		const body = JSON.stringify({ id: "evt_1", type: "x" });
		const header = signStripePayload(body, SECRET, T);
		assert.equal(verifyStripeSignature(body, header, SECRET, { nowSecs: T }).ok, true);
		assert.equal(verifyStripeSignature(`${body} `, header, SECRET, { nowSecs: T }).ok, false, "tampered body");
		assert.equal(verifyStripeSignature(body, header, "whsec_wrong", { nowSecs: T }).ok, false, "wrong secret");
		assert.equal(
			verifyStripeSignature(body, header, SECRET, { nowSecs: T + 1000 }).reason,
			"timestamp_out_of_tolerance",
		);
		assert.equal(verifyStripeSignature(body, undefined, SECRET, { nowSecs: T }).reason, "no_signature_header");
		assert.equal(verifyStripeSignature(body, header, "", { nowSecs: T }).reason, "no_secret");
	});
});

// ─── 2. the full webhook flow ───────────────────────────────────────────────
describe("stripe-webhook: process flow (real store, real signatures)", () => {
	it("a bad signature is 400", async () => {
		const store = await freshStore("wh-badsig-");
		const res = await post(
			store,
			{ id: "evt_x", type: "customer.subscription.updated", data: {} },
			{ sigHeader: "t=1,v1=deadbeef" },
		);
		assert.equal(res.status, 400);
	});

	it("customer.created maps cus_→sub; then a subscription resolves + folds to pro", async () => {
		const store = await freshStore("wh-flow-");
		const c = await post(store, {
			id: "evt_cust",
			type: "customer.created",
			created: T,
			livemode: true,
			data: { object: { id: "cus_42", email: "x@y.z", metadata: { user_id: "sub_user42" } } },
		});
		assert.equal(c.status, 200);
		assert.equal(await store.getUserByCustomer("cus_42"), "sub_user42");

		const s = await post(store, {
			id: "evt_sub",
			type: "customer.subscription.created",
			created: T,
			livemode: true,
			data: {
				object: {
					id: "sub_1",
					customer: "cus_42",
					status: "active",
					current_period_end: 9_999,
					items: { data: [{ price: { id: "price_pro" } }] },
				},
			},
		});
		assert.deepEqual(s.body, { kind: "subscription", applied: true, tier: "pro" });
		assert.equal((await store.getSubscription("sub_user42"))?.tier, "pro");
	});

	it("a subscription.deleted folds to free (cancellation)", async () => {
		const store = await freshStore("wh-cancel-");
		await store.upsertCustomer("sub_c", "cus_c");
		const res = await post(store, {
			id: "evt_del",
			type: "customer.subscription.deleted",
			created: T,
			livemode: true,
			data: {
				object: {
					id: "sub_2",
					customer: "cus_c",
					status: "active",
					items: { data: [{ price: { id: "price_pro" } }] },
				},
			},
		});
		assert.deepEqual(res.body, { kind: "subscription", applied: true, tier: "free" });
	});

	it("checkout.session.completed credits the resolved user once (grant idempotency)", async () => {
		const store = await freshStore("wh-pay-");
		await store.upsertCustomer("sub_payer", "cus_pay");
		const ev = topUpSession("evt_cs", "cs_777", "cus_pay", 500); // 500 cents = $5
		const a = await post(store, ev);
		assert.deepEqual(a.body, { kind: "grant", credited: true, isNewGrant: true });
		// redelivery under a DIFFERENT evt id, same session → credited ONCE
		const b = await post(store, { ...ev, id: "evt_cs_redeliver" });
		assert.equal((b.body as { isNewGrant: boolean }).isNewGrant, false);
		const bal = (await store.getCredit("sub_payer"))?.balanceMicroUsd;
		assert.equal(bal, FREE_TIER_BALANCE_MICRO_USD + 5_000_000, "free tier + $5 (500c × 10000), credited once");
	});

	it("payment_intent.succeeded is acknowledged and never credits (the session is the money's identity)", async () => {
		const store = await freshStore("wh-pi-ignored-");
		await store.upsertCustomer("sub_payer", "cus_pay");
		const res = await post(store, {
			id: "evt_pi",
			type: "payment_intent.succeeded",
			created: T,
			livemode: true,
			data: { object: { id: "pi_777", customer: "cus_pay", amount: 500, currency: "usd" } },
		});
		assert.equal(res.status, 200);
		assert.deepEqual(res.body, { ignored: "payment_intent.succeeded", reason: "credited_from_checkout_session" });
		assert.equal(await store.getCredit("sub_payer"), undefined);
	});

	it("a subscription for an UNMAPPED customer is 409 (Stripe retries)", async () => {
		const store = await freshStore("wh-unmapped-");
		const res = await post(store, {
			id: "evt_u",
			type: "customer.subscription.updated",
			created: T,
			livemode: true,
			data: {
				object: {
					id: "sub_u",
					customer: "cus_unknown",
					status: "active",
					items: { data: [{ price: { id: "price_pro" } }] },
				},
			},
		});
		assert.equal(res.status, 409);
	});

	it("an unhandled event type is acknowledged (200 ignored)", async () => {
		const store = await freshStore("wh-ignore-");
		const res = await post(store, { id: "evt_i", type: "invoice.paid", created: T, data: {} });
		assert.deepEqual(res.body, { ignored: "invoice.paid" });
	});
});

// ─── 3. the tier-push wiring (P1c) ──────────────────────────────────────────
describe("stripe-webhook: tier push wiring", () => {
	it("calls pushTier(sub, tier) only on an APPLIED subscription, not grants", async () => {
		const store = await freshStore("wh-push-");
		const calls: Array<{ sub: string; tier: Tier }> = [];
		const pushTier = async (sub: string, tier: Tier) => {
			calls.push({ sub, tier });
		};
		// map the customer first so the subscription resolves.
		await post(
			store,
			{
				id: "evt_c",
				type: "customer.created",
				created: T,
				data: { object: { id: "cus_p", metadata: { user_id: "sub_p" } } },
			},
			{ pushTier },
		);
		// an APPLIED subscription pushes its tier.
		await post(
			store,
			{
				id: "evt_s",
				type: "customer.subscription.created",
				created: T,
				livemode: true,
				data: {
					object: {
						id: "sub_x",
						customer: "cus_p",
						status: "active",
						items: { data: [{ price: { id: "price_pro" } }] },
					},
				},
			},
			{ pushTier },
		);
		assert.deepEqual(calls, [{ sub: "sub_p", tier: "pro" }]);
		// a payment (grant) does NOT push a tier.
		await post(store, topUpSession("evt_cs", "cs_1", "cus_p", 100), { pushTier });
		assert.equal(calls.length, 1, "a grant does not push a tier");
	});

	it("a pushTier failure does NOT fail the webhook (best-effort)", async () => {
		const store = await freshStore("wh-pushfail-");
		await store.upsertCustomer("sub_f", "cus_f");
		const pushTier = async () => {
			throw new Error("gateway down");
		};
		const res = await post(
			store,
			{
				id: "evt_sf",
				type: "customer.subscription.created",
				created: T,
				livemode: true,
				data: {
					object: {
						id: "sub_f1",
						customer: "cus_f",
						status: "active",
						items: { data: [{ price: { id: "price_pro" } }] },
					},
				},
			},
			{ pushTier },
		);
		assert.equal(res.status, 200, "a push failure is swallowed; the webhook still 200s");
		assert.deepEqual(res.body, { kind: "subscription", applied: true, tier: "pro" });
	});
});
