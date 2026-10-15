/**
 * Billing WS-C — monthly bonus-credit deposit on subscription renewal.
 * REAL libSQL + REAL HMAC signatures, NO MOCKS. The tier + amount are derived
 * from the invoice's OWN line-item price (order-independent), so the deposit is
 * correct even when the subscription fold hasn't landed yet — the "invoice beats
 * the subscription" race that would otherwise silently lose the first-month credit.
 *
 * RUN:  npx tsx --test src/test/billing-renewal.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { FREE_TIER_BALANCE_MICRO_USD } from "../billing-pricing.js";
import { BillingStore, MONTHLY_TIER_CREDIT_MICRO_USD, type Tier } from "../billing-store.js";
import { processStripeWebhook, signStripePayload } from "../stripe-webhook.js";

const SECRET = "whsec_test_wsc";
const PLAN_MAP: Record<string, Tier> = { price_pro: "pro" };
const T = 1_700_000_000;
const PRO_CREDIT = MONTHLY_TIER_CREDIT_MICRO_USD.pro;

async function freshStore(prefix: string): Promise<BillingStore> {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	after(() => rmSync(dir, { recursive: true, force: true }));
	const store = new BillingStore(join(dir, "billing.sqlite"));
	await store.init();
	after(() => store.close());
	return store;
}

function post(store: BillingStore, event: object, opts?: { tSecs?: number }) {
	const rawBody = JSON.stringify(event);
	const t = opts?.tSecs ?? T;
	const sig = signStripePayload(rawBody, SECRET, t);
	return processStripeWebhook(rawBody, sig, { billing: store, secret: SECRET, planTierMap: PLAN_MAP, nowSecs: t });
}

/** Map cus_→user via customer.created; optionally also fold a pro subscription. */
async function seed(store: BillingStore, sub: string, cus: string, opts?: { foldSub?: boolean }): Promise<void> {
	await post(store, {
		id: `evt_c_${cus}`,
		type: "customer.created",
		created: T,
		livemode: true,
		data: { object: { id: cus, metadata: { user_id: sub } } },
	});
	if (opts?.foldSub) {
		await post(store, {
			id: `evt_s_${cus}`,
			type: "customer.subscription.created",
			created: T,
			livemode: true,
			data: {
				object: {
					id: `sub_${cus}`,
					customer: cus,
					status: "active",
					items: { data: [{ price: { id: "price_pro" } }] },
				},
			},
		});
	}
}

function invoiceEvent(id: string, cus: string, reason: string, opts?: { livemode?: boolean; priceId?: string }) {
	const lines = opts?.priceId ? { data: [{ price: { id: opts.priceId } }] } : undefined;
	return {
		id: `evt_${id}`,
		type: "invoice.payment_succeeded",
		created: T,
		livemode: opts?.livemode ?? true,
		data: { object: { id, customer: cus, subscription: `sub_${cus}`, billing_reason: reason, lines } },
	};
}

describe("billing WS-C: monthly bonus-credit deposit", () => {
	it("subscription_cycle deposits the per-tier monthly credit, once (idempotent on invoice id)", async () => {
		const store = await freshStore("wsc-cycle-");
		await seed(store, "u_pro", "cus_pro", { foldSub: true });

		const a = await post(store, invoiceEvent("in_1", "cus_pro", "subscription_cycle", { priceId: "price_pro" }));
		assert.equal(a.status, 200);
		assert.equal((a.body as { credited: boolean }).credited, true);
		assert.equal((a.body as { tier: Tier }).tier, "pro");

		// redelivery under a DIFFERENT evt id, SAME invoice → deposited once only.
		const b = await post(store, {
			...invoiceEvent("in_1", "cus_pro", "subscription_cycle", { priceId: "price_pro" }),
			id: "evt_in_1_redeliver",
		});
		assert.equal((b.body as { isNewGrant: boolean }).isNewGrant, false);

		const bal = (await store.getCredit("u_pro"))?.balanceMicroUsd;
		assert.equal(bal, FREE_TIER_BALANCE_MICRO_USD + PRO_CREDIT, "free seed + exactly one pro monthly credit");
		assert.equal((await store.getGrant("in:in_1"))?.stripeObject, "invoice");
	});

	it("BLOCKER regression: invoice BEFORE the subscription fold still deposits (tier from the invoice price)", async () => {
		const store = await freshStore("wsc-race-");
		// Customer is mapped, but the subscription fold has NOT landed yet.
		await seed(store, "u_race", "cus_race", { foldSub: false });
		assert.equal(await store.getSubscription("u_race"), undefined, "precondition: no subscription row yet");

		const r = await post(store, invoiceEvent("in_race", "cus_race", "subscription_create", { priceId: "price_pro" }));
		assert.equal((r.body as { credited: boolean }).credited, true, "credit deposited despite no subscription fold");
		assert.equal((r.body as { tier: Tier }).tier, "pro");
		assert.equal((await store.getCredit("u_race"))?.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD + PRO_CREDIT);
	});

	it("subscription_create (first paid month) deposits from the invoice price", async () => {
		const store = await freshStore("wsc-create-");
		await seed(store, "u_c", "cus_c", { foldSub: true });
		const r = await post(store, invoiceEvent("in_c", "cus_c", "subscription_create", { priceId: "price_pro" }));
		assert.equal((r.body as { credited: boolean }).credited, true);
		assert.equal((await store.getCredit("u_c"))?.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD + PRO_CREDIT);
	});

	it("no price on the invoice → falls back to the stored subscription tier", async () => {
		const store = await freshStore("wsc-nopricesub-");
		await seed(store, "u_f", "cus_f", { foldSub: true });
		const r = await post(store, invoiceEvent("in_f", "cus_f", "subscription_cycle")); // no priceId
		assert.equal((r.body as { credited: boolean }).credited, true);
		assert.equal((r.body as { tier: Tier }).tier, "pro");
	});

	it("no price AND no subscription yet → 409 (Stripe retries; the credit is never lost)", async () => {
		const store = await freshStore("wsc-409-");
		await seed(store, "u_u", "cus_u", { foldSub: false }); // mapped, no sub row, invoice has no price
		const r = await post(store, invoiceEvent("in_u", "cus_u", "subscription_cycle"));
		assert.equal(r.status, 409);
		assert.equal(await store.getCredit("u_u"), undefined, "no partial credit written");
	});

	it("a non-recurring invoice (manual) is acked but never deposits", async () => {
		const store = await freshStore("wsc-manual-");
		await seed(store, "u_m", "cus_m", { foldSub: true });
		const r = await post(store, invoiceEvent("in_m", "cus_m", "manual", { priceId: "price_pro" }));
		assert.deepEqual(r.body, { ignored: "invoice.payment_succeeded" });
		assert.equal(await store.getCredit("u_m"), undefined, "no credits row created");
	});

	it("test-mode (livemode=0) records the grant but does NOT credit the live ledger", async () => {
		const store = await freshStore("wsc-test-");
		await seed(store, "u_t", "cus_t", { foldSub: true });
		const r = await post(
			store,
			invoiceEvent("in_t", "cus_t", "subscription_cycle", { priceId: "price_pro", livemode: false }),
		);
		assert.equal((r.body as { credited: boolean }).credited, false);
		assert.equal(await store.getCredit("u_t"), undefined, "live ledger untouched by a test-mode invoice");
	});

	it("an unmapped customer 409s (Stripe retries after customer.created lands)", async () => {
		const store = await freshStore("wsc-unmapped-");
		const r = await post(store, invoiceEvent("in_x", "cus_unknown", "subscription_cycle", { priceId: "price_pro" }));
		assert.equal(r.status, 409);
	});
});
