/**
 * Billing checkout + portal (WS-B initiation; Sobremesa money-in fixes b and d) — a REAL libSQL store and a
 * REAL `stripePost` over the real `fetch`, against a loopback Stripe (`stripe-loopback-fixture.ts`).
 *
 * Proves: a new person gets ONE Stripe customer (created with their Cognito email when we know it, under an
 * Idempotency-Key that makes a duplicate create converge, never twice for two concurrent first checkouts);
 * a top-up is a USD payment session that carries the top-up marker on the session AND its PaymentIntent, in
 * whole dollars from $5 to $200 (checked here as well as at the gateway: `choreograph.example.invalid` is
 * reachable without the gateway); a subscription is refused before Stripe is touched; every request is
 * version-pinned and keyed; the portal needs an existing customer; Stripe errors surface.
 *
 * RUN:  npx tsx --test src/test/billing-checkout.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	type CheckoutDeps,
	CheckoutRequestError,
	createCheckoutSession,
	createPortalSession,
	ensureStripeCustomer,
	MAX_TOPUP_CENTS,
	MIN_TOPUP_CENTS,
} from "../billing-checkout.js";
import { BillingStore } from "../billing-store.js";
import { DEFAULT_STRIPE_API_VERSION } from "../stripe-api.js";
import { type LoopbackStripe, type StripeReplies, startLoopbackStripe } from "./stripe-loopback-fixture.js";

async function freshStore(prefix: string): Promise<BillingStore> {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	after(() => rmSync(dir, { recursive: true, force: true }));
	const store = new BillingStore(join(dir, "billing.sqlite"));
	await store.init();
	after(() => store.close());
	return store;
}

async function stripeWith(replies: StripeReplies): Promise<LoopbackStripe> {
	const stripe = await startLoopbackStripe(replies);
	after(() => stripe.close());
	return stripe;
}

function deps(store: BillingStore, stripe: LoopbackStripe): CheckoutDeps {
	return {
		billing: store,
		secretKey: "sk_test_x",
		successUrl: "https://garden.example/billing/ok",
		cancelUrl: "https://garden.example/billing/cancel",
		portalReturnUrl: "https://garden.example/settings",
		baseUrl: stripe.baseUrl,
	};
}

const SESSION_REPLY = { "/v1/checkout/sessions": { json: { id: "cs_1", url: "https://checkout.stripe.test/cs_1" } } };

describe("ensureStripeCustomer", () => {
	it("creates and links one customer for a new person, then reuses it", async () => {
		const store = await freshStore("bc-cust-");
		const stripe = await stripeWith({ "/v1/customers": { json: { id: "cus_new" } } });
		assert.equal(await ensureStripeCustomer(deps(store, stripe), "u1"), "cus_new");
		assert.equal((await store.getCustomer("u1"))?.stripeCustomerId, "cus_new", "linked in customer_map");
		const [create] = stripe.to("/v1/customers");
		assert.equal(create.form["metadata[user_id]"], "u1");
		assert.equal("email" in create.form, false, "no email known, none sent");
		assert.equal(await ensureStripeCustomer(deps(store, stripe), "u1"), "cus_new");
		assert.equal(stripe.to("/v1/customers").length, 1, "no second create");
	});

	it("creates the customer with the caller's email when one is known, so Stripe's receipt can go out", async () => {
		const store = await freshStore("bc-email-");
		const stripe = await stripeWith({ "/v1/customers": { json: { id: "cus_mail" } } });
		await ensureStripeCustomer(deps(store, stripe), "u2", "ana@example.org");
		assert.equal(stripe.to("/v1/customers")[0].form.email, "ana@example.org");
		assert.equal((await store.getCustomer("u2"))?.email, "ana@example.org");
	});

	it("keys the create so a duplicate converges: one key per person and params", async () => {
		let created = 0;
		const stripe = await stripeWith({ "/v1/customers": () => ({ json: { id: `cus_k${++created}` } }) });
		const first = await freshStore("bc-key-a-");
		const second = await freshStore("bc-key-b-");
		await ensureStripeCustomer(deps(first, stripe), "u3", "ana@example.org");
		await ensureStripeCustomer(deps(second, stripe), "u3", "ana@example.org");
		await ensureStripeCustomer(deps(second, stripe), "u4", "ana@example.org");
		await ensureStripeCustomer(deps(await freshStore("bc-key-c-"), stripe), "u3", "other@example.org");
		const keys = stripe.to("/v1/customers").map((request) => String(request.headers["idempotency-key"]));
		assert.equal(keys.length, 4);
		assert.equal(keys[0], keys[1], "the same person with the same params: one key, so Stripe returns one customer");
		assert.match(keys[0], /^sophia-customer-u3-[0-9a-f]{16}$/);
		assert.equal(new Set(keys).size, 3, "another person or another email is another create");
	});

	it("two concurrent first checkouts for one person share ONE Stripe customer", async () => {
		const store = await freshStore("bc-race-");
		const stripe = await stripeWith({ "/v1/customers": { json: { id: "cus_once" }, delayMs: 60 } });
		const [a, b] = await Promise.all([
			ensureStripeCustomer(deps(store, stripe), "u5"),
			ensureStripeCustomer(deps(store, stripe), "u5"),
		]);
		assert.equal(a, "cus_once");
		assert.equal(b, "cus_once");
		assert.equal(stripe.to("/v1/customers").length, 1, "a second create would orphan a paying customer");
	});

	it("gives a customer that was mapped without an email the caller's email, once", async () => {
		const store = await freshStore("bc-attach-");
		await store.upsertCustomer("u6", "cus_6");
		const stripe = await stripeWith({ "/v1/customers/cus_6": { json: { id: "cus_6" } } });
		assert.equal(await ensureStripeCustomer(deps(store, stripe), "u6", "ana@example.org"), "cus_6");
		const [update] = stripe.to("/v1/customers/cus_6");
		assert.equal(update.method, "POST");
		assert.deepEqual(update.form, { email: "ana@example.org" });
		assert.equal((await store.getCustomer("u6"))?.email, "ana@example.org");
		assert.equal((await store.getCustomer("u6"))?.stripeCustomerId, "cus_6");
		await ensureStripeCustomer(deps(store, stripe), "u6", "ana@example.org");
		assert.equal(stripe.to("/v1/customers/cus_6").length, 1, "it has an email now: not touched again");
	});

	it("leaves a customer that already has an email alone", async () => {
		const store = await freshStore("bc-keep-");
		await store.upsertCustomer("u7", "cus_7", "kept@example.org");
		const stripe = await stripeWith({});
		await ensureStripeCustomer(deps(store, stripe), "u7", "other@example.org");
		assert.equal(stripe.requests.length, 0);
		assert.equal((await store.getCustomer("u7"))?.email, "kept@example.org");
	});

	it("never fails a checkout for want of an email: a failed attach leaves the mapping as it was", async () => {
		const store = await freshStore("bc-attachfail-");
		await store.upsertCustomer("u8", "cus_8");
		const stripe = await stripeWith({ "/v1/customers/cus_8": { status: 500, json: { error: { message: "boom" } } } });
		assert.equal(await ensureStripeCustomer(deps(store, stripe), "u8", "ana@example.org"), "cus_8");
		assert.equal((await store.getCustomer("u8"))?.email, null);
	});

	it("a Stripe failure on create surfaces as a throw and links nothing", async () => {
		const store = await freshStore("bc-createfail-");
		const stripe = await stripeWith({ "/v1/customers": { status: 400, json: { error: { message: "bad" } } } });
		await assert.rejects(ensureStripeCustomer(deps(store, stripe), "u9"), /stripe customer create failed: 400/);
		assert.equal(await store.getCustomer("u9"), undefined);
	});
});

describe("createCheckoutSession: a top-up", () => {
	it("is a USD payment session that marks the top-up on the session and on its PaymentIntent", async () => {
		const store = await freshStore("bc-top-");
		await store.upsertCustomer("u3", "cus_3");
		const stripe = await stripeWith(SESSION_REPLY);
		const out = await createCheckoutSession(deps(store, stripe), "u3", { kind: "topup", amountCents: 1_000 });
		assert.equal(out.url, "https://checkout.stripe.test/cs_1");
		assert.deepEqual(stripe.to("/v1/checkout/sessions")[0].form, {
			mode: "payment",
			customer: "cus_3",
			"line_items[0][price_data][currency]": "usd",
			"line_items[0][price_data][product_data][name]": "Sophia credit top-up",
			"line_items[0][price_data][unit_amount]": "1000",
			"line_items[0][quantity]": "1",
			client_reference_id: "u3",
			"metadata[kind]": "topup",
			"metadata[user_id]": "u3",
			"payment_intent_data[metadata][kind]": "topup",
			"payment_intent_data[metadata][user_id]": "u3",
			success_url: "https://garden.example/billing/ok",
			cancel_url: "https://garden.example/billing/cancel",
		});
	});

	it("creates the customer first with the caller's email, then the session on that customer", async () => {
		const store = await freshStore("bc-topnew-");
		const stripe = await stripeWith({ "/v1/customers": { json: { id: "cus_fresh" } }, ...SESSION_REPLY });
		await createCheckoutSession(deps(store, stripe), "u10", {
			kind: "topup",
			amountCents: 500,
			email: "ana@example.org",
		});
		assert.deepEqual(
			stripe.requests.map((request) => request.path),
			["/v1/customers", "/v1/checkout/sessions"],
		);
		assert.equal(stripe.requests[0].form.email, "ana@example.org");
		assert.equal(stripe.requests[1].form.customer, "cus_fresh");
	});

	it("pins the Stripe version and keys every request; a repeat purchase is a new session, not a replay", async () => {
		const store = await freshStore("bc-keys-");
		await store.upsertCustomer("u11", "cus_11");
		const stripe = await stripeWith(SESSION_REPLY);
		await createCheckoutSession(deps(store, stripe), "u11", { kind: "topup", amountCents: 500 });
		await createCheckoutSession(deps(store, stripe), "u11", { kind: "topup", amountCents: 500 });
		const [one, two] = stripe.to("/v1/checkout/sessions");
		for (const request of [one, two]) {
			assert.equal(request.headers["stripe-version"], DEFAULT_STRIPE_API_VERSION);
			assert.equal(request.headers.authorization, "Bearer sk_test_x");
		}
		assert.notEqual(one.headers["idempotency-key"], two.headers["idempotency-key"]);
	});

	it("honours a version override", async () => {
		const store = await freshStore("bc-version-");
		await store.upsertCustomer("u12", "cus_12");
		const stripe = await stripeWith(SESSION_REPLY);
		await createCheckoutSession({ ...deps(store, stripe), apiVersion: "2099-01-01.test" }, "u12", {
			kind: "topup",
			amountCents: 500,
		});
		assert.equal(stripe.to("/v1/checkout/sessions")[0].headers["stripe-version"], "2099-01-01.test");
	});

	it("is whole dollars from $5 to $200, and anything else is refused before Stripe is touched", async () => {
		assert.deepEqual([MIN_TOPUP_CENTS, MAX_TOPUP_CENTS], [500, 20_000]);
		const store = await freshStore("bc-range-");
		await store.upsertCustomer("u13", "cus_13");
		const stripe = await stripeWith(SESSION_REPLY);
		for (const amountCents of [500, 1_000, 2_500, 19_900, 20_000]) {
			await createCheckoutSession(deps(store, stripe), "u13", { kind: "topup", amountCents });
		}
		assert.equal(stripe.to("/v1/checkout/sessions").length, 5);
		const before = stripe.requests.length;
		for (const amountCents of [0, -500, 1, 100, 499, 550, 1_050, 20_100, 25_000, 1_000_000, 1.5, 500.5, Number.NaN]) {
			await assert.rejects(
				createCheckoutSession(deps(store, stripe), "u13", { kind: "topup", amountCents }),
				(error) =>
					error instanceof CheckoutRequestError && error.code === "invalid_topup_amount" && error.status === 400,
				String(amountCents),
			);
		}
		for (const amountCents of [undefined, "500" as unknown as number, null as unknown as number]) {
			await assert.rejects(
				createCheckoutSession(deps(store, stripe), "u13", { kind: "topup", amountCents }),
				(error) => error instanceof CheckoutRequestError && error.code === "invalid_topup_amount",
			);
		}
		assert.equal(stripe.requests.length, before, "a refused amount never reaches Stripe");
	});

	it("a Stripe error on the session surfaces as a throw", async () => {
		const store = await freshStore("bc-err-");
		await store.upsertCustomer("u14", "cus_14");
		const stripe = await stripeWith({
			"/v1/checkout/sessions": { status: 400, json: { error: { message: "bad" } } },
		});
		await assert.rejects(
			createCheckoutSession(deps(store, stripe), "u14", { kind: "topup", amountCents: 500 }),
			/stripe checkout session failed: 400/,
		);
	});
});

describe("createCheckoutSession: a subscription", () => {
	it("is refused with 503 subscriptions_unavailable before Stripe is touched, and creates no customer", async () => {
		const store = await freshStore("bc-sub-");
		const stripe = await stripeWith({ "/v1/customers": { json: { id: "cus_never" } }, ...SESSION_REPLY });
		await assert.rejects(
			createCheckoutSession(deps(store, stripe), "u15", { kind: "subscription" }),
			(error) =>
				error instanceof CheckoutRequestError && error.code === "subscriptions_unavailable" && error.status === 503,
		);
		assert.equal(stripe.requests.length, 0);
		assert.equal(await store.getCustomer("u15"), undefined);
	});
});

describe("createPortalSession", () => {
	it("requires an existing customer; returns the url, version-pinned and keyed, when present", async () => {
		const store = await freshStore("bc-portal-");
		const stripe = await stripeWith({
			"/v1/billing_portal/sessions": { json: { url: "https://portal.stripe.test/p1" } },
		});
		await assert.rejects(createPortalSession(deps(store, stripe), "u16"), /no_billing_customer/);
		assert.equal(stripe.requests.length, 0);
		await store.upsertCustomer("u16", "cus_16");
		const out = await createPortalSession(deps(store, stripe), "u16");
		assert.equal(out.url, "https://portal.stripe.test/p1");
		const [request] = stripe.to("/v1/billing_portal/sessions");
		assert.deepEqual(request.form, { customer: "cus_16", return_url: "https://garden.example/settings" });
		assert.equal(request.headers["stripe-version"], DEFAULT_STRIPE_API_VERSION);
		assert.ok(request.headers["idempotency-key"]);
	});

	it("a Stripe error surfaces as a throw", async () => {
		const store = await freshStore("bc-portalerr-");
		await store.upsertCustomer("u17", "cus_17");
		const stripe = await stripeWith({
			"/v1/billing_portal/sessions": { status: 400, json: { error: { message: "bad" } } },
		});
		await assert.rejects(createPortalSession(deps(store, stripe), "u17"), /stripe portal session failed: 400/);
	});
});
