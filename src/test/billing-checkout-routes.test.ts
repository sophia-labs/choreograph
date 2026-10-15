/**
 * `POST /api/billing/checkout` and `/api/billing/portal` over a REAL orchestrator on loopback (Sobremesa money-in
 * fixes b and d). NO MOCKS: a real `routeRequest` behind a real HTTP server, a real `BillingStore` on a real
 * file, the real Stripe client over real `fetch` against a loopback Stripe. The signed-in person is resolved
 * the documented way when no Cognito pool is configured (`/profile/me`, see `billing-route-fixture.ts`).
 *
 * The contract the gateway and the SPA can rely on:
 *   - a top-up needs only the Stripe key (no Pro price), whole dollars from $5 to $200, else 400
 *     `invalid_topup_amount` with the bounds;
 *   - `kind: "subscription"` is 503 `subscriptions_unavailable` until the entitlement route exists, with no
 *     Stripe call and no customer created; a missing or unknown kind is 400 `invalid_checkout_kind`;
 *   - no Stripe key is 503 `billing_not_configured`.
 *
 * RUN:  npx tsx --test src/test/billing-checkout-routes.test.ts
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { httpJson } from "./billing-credit-fixture.js";
import { type BillingRouteRig, startBillingRouteRig } from "./billing-route-fixture.js";
import { type LoopbackStripe, type StripeReplies, startLoopbackStripe } from "./stripe-loopback-fixture.js";

const CUSTOMER_AND_SESSION: StripeReplies = {
	"/v1/customers": { json: { id: "cus_ana" } },
	"/v1/checkout/sessions": { json: { id: "cs_route", url: "https://checkout.stripe.test/cs_route" } },
	"/v1/billing_portal/sessions": { json: { url: "https://portal.stripe.test/p_route" } },
};

async function rigWith(
	replies: StripeReplies,
	env: Record<string, string | undefined> = {},
): Promise<{ rig: BillingRouteRig; stripe: LoopbackStripe }> {
	const stripe = await startLoopbackStripe(replies);
	const rig = await startBillingRouteRig({
		mode: "observe",
		env: {
			STRIPE_SECRET_KEY: "sk_test_route",
			STRIPE_API_BASE_URL: stripe.baseUrl,
			BILLING_CHECKOUT_SUCCESS_URL: "https://garden.example/settings?checkout=success",
			BILLING_CHECKOUT_CANCEL_URL: "https://garden.example/settings?checkout=cancel",
			BILLING_PORTAL_RETURN_URL: "https://garden.example/settings",
			...env,
		},
	});
	after(async () => {
		await rig.stop();
		await stripe.close();
	});
	return { rig, stripe };
}

function checkout(rig: BillingRouteRig, userId: string, body?: unknown) {
	return httpJson(rig.baseUrl, "POST", "/api/billing/checkout", {
		...(body === undefined ? {} : { body }),
		headers: rig.bearer(userId),
	});
}

describe("POST /api/billing/checkout: a top-up", () => {
	it("needs no Pro price: it creates the customer and the session and returns the hosted url", async () => {
		const { rig, stripe } = await rigWith(CUSTOMER_AND_SESSION);
		const res = await checkout(rig, "ana", { kind: "topup", amountCents: 1_000 });
		assert.equal(res.status, 200);
		assert.deepEqual(res.body, { url: "https://checkout.stripe.test/cs_route" });

		const [customer] = stripe.to("/v1/customers");
		assert.equal(customer.form["metadata[user_id]"], "ana");
		const [session] = stripe.to("/v1/checkout/sessions");
		assert.equal(session.form.mode, "payment");
		assert.equal(session.form.customer, "cus_ana");
		assert.equal(session.form["line_items[0][price_data][unit_amount]"], "1000");
		assert.equal(session.form["metadata[kind]"], "topup");
		assert.equal(session.form["payment_intent_data[metadata][kind]"], "topup");
		assert.equal(session.form.client_reference_id, "ana");
		assert.equal(session.form.success_url, "https://garden.example/settings?checkout=success");
		assert.equal(session.headers.authorization, "Bearer sk_test_route");
		assert.ok(session.headers["stripe-version"]);
		assert.ok(session.headers["idempotency-key"]);
		assert.equal((await rig.billing.getCustomer("ana"))?.stripeCustomerId, "cus_ana");
	});

	it("is whole dollars from $5 to $200: anything else is 400 with the bounds and no Stripe call", async () => {
		const { rig, stripe } = await rigWith(CUSTOMER_AND_SESSION);
		for (const body of [
			{ kind: "topup", amountCents: 100 },
			{ kind: "topup", amountCents: 499 },
			{ kind: "topup", amountCents: 1_050 },
			{ kind: "topup", amountCents: 20_100 },
			{ kind: "topup", amountCents: 1_000_000 },
			{ kind: "topup", amountCents: -500 },
			{ kind: "topup", amountCents: "500" },
			{ kind: "topup" },
		]) {
			const res = await checkout(rig, "ana", body);
			assert.equal(res.status, 400, JSON.stringify(body));
			const error = res.body as { error: string; message: string; minCents: number; maxCents: number };
			assert.equal(error.error, "invalid_topup_amount");
			assert.deepEqual([error.minCents, error.maxCents], [500, 20_000]);
			assert.match(error.message, /\$5/);
			assert.match(error.message, /\$200/);
		}
		assert.equal(stripe.requests.length, 0);
		for (const amountCents of [500, 20_000]) {
			assert.equal((await checkout(rig, "ana", { kind: "topup", amountCents })).status, 200);
		}
	});

	it("reports a Stripe failure as 502 with the reason", async () => {
		const { rig } = await rigWith({
			...CUSTOMER_AND_SESSION,
			"/v1/checkout/sessions": { status: 500, json: { error: { message: "stripe is down" } } },
		});
		const res = await checkout(rig, "ana", { kind: "topup", amountCents: 500 });
		assert.equal(res.status, 502);
		assert.match((res.body as { error: string }).error, /^stripe checkout session failed: 500/);
	});

	it("never sends the secret key to a base URL that is neither Stripe nor loopback", async () => {
		const { rig, stripe } = await rigWith(CUSTOMER_AND_SESSION, { STRIPE_API_BASE_URL: "https://evil.example" });
		const res = await checkout(rig, "ana", { kind: "topup", amountCents: 500 });
		assert.equal(res.status, 502);
		assert.match((res.body as { error: string }).error, /STRIPE_API_BASE_URL/);
		assert.equal(stripe.requests.length, 0);
	});
});

describe("POST /api/billing/checkout: what is not a top-up", () => {
	it("a subscription is 503 subscriptions_unavailable: no Stripe call, no customer", async () => {
		const { rig, stripe } = await rigWith(CUSTOMER_AND_SESSION);
		const res = await checkout(rig, "ana", { kind: "subscription" });
		assert.equal(res.status, 503);
		assert.equal((res.body as { error: string }).error, "subscriptions_unavailable");
		assert.equal(stripe.requests.length, 0);
		assert.equal(await rig.billing.getCustomer("ana"), undefined);
	});

	it("a missing or unknown kind is 400 invalid_checkout_kind, never a silent subscription", async () => {
		const { rig, stripe } = await rigWith(CUSTOMER_AND_SESSION);
		for (const body of [{}, { kind: "gift" }, { amountCents: 500 }, undefined]) {
			const res = await checkout(rig, "ana", body);
			assert.equal(res.status, 400, JSON.stringify(body));
			assert.equal((res.body as { error: string }).error, "invalid_checkout_kind");
		}
		assert.equal(stripe.requests.length, 0);
	});

	it("without a Stripe key the route is inert: 503 billing_not_configured", async () => {
		const { rig, stripe } = await rigWith(CUSTOMER_AND_SESSION, { STRIPE_SECRET_KEY: undefined });
		const res = await checkout(rig, "ana", { kind: "topup", amountCents: 500 });
		assert.equal(res.status, 503);
		assert.deepEqual(res.body, { error: "billing_not_configured" });
		assert.equal(stripe.requests.length, 0);
	});
});

describe("POST /api/billing/portal", () => {
	it("needs an existing customer (409), then returns the portal url", async () => {
		const { rig, stripe } = await rigWith(CUSTOMER_AND_SESSION);
		const missing = await httpJson(rig.baseUrl, "POST", "/api/billing/portal", { headers: rig.bearer("ana") });
		assert.equal(missing.status, 409);
		assert.deepEqual(missing.body, { error: "no_billing_customer" });
		assert.equal(stripe.requests.length, 0);

		await rig.billing.upsertCustomer("ana", "cus_ana");
		const res = await httpJson(rig.baseUrl, "POST", "/api/billing/portal", { headers: rig.bearer("ana") });
		assert.equal(res.status, 200);
		assert.deepEqual(res.body, { url: "https://portal.stripe.test/p_route" });
		assert.deepEqual(stripe.to("/v1/billing_portal/sessions")[0].form, {
			customer: "cus_ana",
			return_url: "https://garden.example/settings",
		});
	});
});
