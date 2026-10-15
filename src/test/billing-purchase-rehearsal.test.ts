/**
 * The purchase test, rehearsed offline (Sobremesa ruling 6): a $10 top-up, then a refund as a negative
 * adjustment. The live test needs Vera's card and the Stripe dashboard; this is everything of it that code can
 * prove first, and it proves the one thing no single suite does: that the Checkout Session the route REALLY creates
 * is a session the webhook REALLY credits.
 *
 * The two halves were written by different bodies a week apart (the webhook credits only a paid `mode: payment`
 * session that carries `metadata.kind = topup`, a marker the old checkout never set). So the "paid" event below is
 * not hand-made: it is built field by field from the request the checkout route sent to Stripe, the way Stripe
 * would echo it back. A checkout that stops sending the marker, the owner, the amount or the currency makes this
 * rehearsal fail, not a customer's purchase.
 *
 * REAL: an orchestrator on loopback, the real route, real stores, real HMAC signing and verification, the real
 * Stripe client over real `fetch`. STAND-IN: Stripe itself, a loopback HTTP server that records what it receives.
 *
 * RUN:  npx tsx --test src/test/billing-purchase-rehearsal.test.ts
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readCreditHistory } from "../billing-read.js";
import { signStripePayload } from "../stripe-webhook.js";
import { httpJson } from "./billing-credit-fixture.js";
import { type BillingRouteRig, startBillingRouteRig } from "./billing-route-fixture.js";
import { type LoopbackStripe, startLoopbackStripe } from "./stripe-loopback-fixture.js";

const SECRET = "whsec_rehearsal";
const USER = "alice";
const CUSTOMER = "cus_rehearsal";
const SESSION = "cs_rehearsal";
const PAYMENT_INTENT = "pi_rehearsal";
const CHARGE = "ch_rehearsal";

describe("the $10 purchase and its refund, end to end over the real routes", { concurrency: false }, () => {
	let stripe: LoopbackStripe;
	let rig: BillingRouteRig;
	let sessionForm: Record<string, string>;
	let eventCounter = 0;

	before(async () => {
		stripe = await startLoopbackStripe({
			"/v1/customers": { json: { id: CUSTOMER } },
			"/v1/checkout/sessions": { json: { id: SESSION, url: `https://checkout.stripe.test/${SESSION}` } },
		});
		rig = await startBillingRouteRig({
			mode: "enforce",
			env: {
				STRIPE_SECRET_KEY: "sk_test_rehearsal",
				STRIPE_WEBHOOK_SECRET: SECRET,
				STRIPE_API_BASE_URL: stripe.baseUrl,
				BILLING_CHECKOUT_SUCCESS_URL: "https://garden.example/settings?settings=billing&checkout=success",
				BILLING_CHECKOUT_CANCEL_URL: "https://garden.example/settings?settings=billing&checkout=cancel",
			},
		});
	});
	after(async () => {
		await rig.stop();
		await stripe.close();
	});

	const history = () => readCreditHistory(rig.billing, USER, { limit: 10 });
	const balance = async () => (await rig.billing.getCredit(USER))?.balanceMicroUsd;

	/** Deliver a Stripe event to the webhook route exactly as Stripe does: the raw body, signed. */
	async function deliver(type: string, object: Record<string, unknown>, eventId = `evt_rehearsal_${++eventCounter}`) {
		const raw = JSON.stringify({
			id: eventId,
			type,
			api_version: "2025-03-31.basil",
			created: Math.floor(Date.now() / 1000),
			livemode: true,
			data: { object },
		});
		const response = await fetch(`${rig.baseUrl}/api/stripe/webhook`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"stripe-signature": signStripePayload(raw, SECRET, Math.floor(Date.now() / 1000)),
			},
			body: raw,
		});
		return { status: response.status, body: (await response.json()) as Record<string, unknown> };
	}

	/** What Stripe reports for the session it was asked to create, built from what it was asked. */
	function paidSession(form: Record<string, string>): Record<string, unknown> {
		const amount = Number(form["line_items[0][price_data][unit_amount]"]) * Number(form["line_items[0][quantity]"]);
		return {
			id: SESSION,
			object: "checkout.session",
			mode: form.mode,
			payment_status: "paid",
			customer: form.customer,
			client_reference_id: form.client_reference_id,
			metadata: { kind: form["metadata[kind]"], user_id: form["metadata[user_id]"] },
			amount_subtotal: amount,
			amount_total: amount,
			currency: form["line_items[0][price_data][currency]"],
			payment_intent: PAYMENT_INTENT,
		};
	}

	it("a person with no billing history asks to add $10: the route creates a customer and a payment session", async () => {
		const res = await httpJson(rig.baseUrl, "POST", "/api/billing/checkout", {
			body: { kind: "topup", amountCents: 1_000 },
			headers: rig.bearer(USER),
		});
		assert.equal(res.status, 200, res.text);
		assert.deepEqual(res.body, { url: `https://checkout.stripe.test/${SESSION}` });
		assert.deepEqual(
			stripe.requests.map((request) => request.path),
			["/v1/customers", "/v1/checkout/sessions"],
		);
		assert.equal(
			(await rig.billing.getCustomer(USER))?.stripeCustomerId,
			CUSTOMER,
			"the person is mapped to the customer",
		);
		sessionForm = stripe.to("/v1/checkout/sessions")[0].form;
		assert.equal(sessionForm.mode, "payment");
		assert.equal(sessionForm["line_items[0][price_data][unit_amount]"], "1000");
		assert.equal(await balance(), undefined, "nothing is credited by asking");
	});

	it("Stripe says it was paid: the person is credited exactly $10.000000, once, whatever the event id", async () => {
		const first = await deliver("checkout.session.completed", paidSession(sessionForm));
		assert.equal(first.status, 200, JSON.stringify(first.body));
		assert.equal(first.body.credited, true, JSON.stringify(first.body));
		assert.equal(await balance(), 1_000_000 + 10_000_000, "the $1.00 starter seed plus exactly $10.000000");

		const page = await history();
		assert.equal(page.items[0].kind, "top-up");
		assert.equal(page.items[0].amountMicroUsd, 10_000_000);
		assert.equal(page.items[0].label, "Credits added");

		// Stripe redelivers one payment under many event ids.
		const redelivered = await deliver(
			"checkout.session.completed",
			paidSession(sessionForm),
			"evt_redelivery_other_id",
		);
		assert.equal(redelivered.status, 200, JSON.stringify(redelivered.body));
		assert.equal(await balance(), 11_000_000, "the same session is the same money");
		const grants = (await history()).items.filter((item) => item.kind === "top-up");
		assert.equal(grants.length, 1);

		// The PaymentIntent event is acknowledged and never credits: it also fires for a subscription invoice.
		const paymentIntent = await deliver("payment_intent.succeeded", {
			id: PAYMENT_INTENT,
			customer: CUSTOMER,
			amount: 1_000,
			currency: "usd",
		});
		assert.equal(paymentIntent.status, 200);
		assert.equal(await balance(), 11_000_000);
	});

	it("the refund in the dashboard claws the credit back as a negative adjustment, which the history shows as a refund", async () => {
		const refunded = await deliver("charge.refunded", {
			id: CHARGE,
			amount_refunded: 1_000,
			currency: "usd",
			customer: CUSTOMER,
			payment_intent: PAYMENT_INTENT,
		});
		assert.equal(refunded.status, 200, JSON.stringify(refunded.body));
		assert.equal(await balance(), 1_000_000, "back to the starter seed: the whole $10.000000 was taken back");

		const page = await history();
		assert.equal(page.items[0].kind, "adjustment");
		assert.equal(page.items[0].label, "Refund");
		assert.equal(page.items[0].amountMicroUsd, -10_000_000);
		const adjustment = await rig.billing.getCreditAdjustment(`refund:${CHARGE}:1000`);
		assert.equal(adjustment?.kind, "refund");
		assert.equal(adjustment?.sourceRef, PAYMENT_INTENT);
		assert.equal(adjustment?.actor, "stripe:webhook");

		// A redelivery of the same refund state is a no-op.
		const again = await deliver("charge.refunded", {
			id: CHARGE,
			amount_refunded: 1_000,
			currency: "usd",
			customer: CUSTOMER,
			payment_intent: PAYMENT_INTENT,
		});
		assert.equal(again.status, 200);
		assert.equal(await balance(), 1_000_000, "refunded once");
	});

	it("an unsigned or wrongly signed delivery moves no money", async () => {
		const raw = JSON.stringify({
			id: "evt_forged",
			type: "checkout.session.completed",
			livemode: true,
			data: { object: paidSession(sessionForm) },
		});
		const forged = await fetch(`${rig.baseUrl}/api/stripe/webhook`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"stripe-signature": signStripePayload(raw, "whsec_wrong", Math.floor(Date.now() / 1000)),
			},
			body: raw,
		});
		assert.equal(forged.status, 400);
		assert.equal(await balance(), 1_000_000);
	});
});
