/**
 * Money in, from Checkout (Sobremesa, E §4.4.5 a): REAL libSQL and REAL HMAC signatures, NO MOCKS.
 *
 * A top-up is credited from `checkout.session.completed` (a paid, `mode: payment` session whose
 * `metadata.kind` is `topup`), for `amount_subtotal` and only in USD, under the grant id
 * `cs:<session>`. It is NOT credited from `payment_intent.succeeded`: that event also fires for a
 * subscription invoice, and crediting both would pay the same money twice (the PaymentIntent
 * event under `pi:` and the session under `cs:`). Anything we understood but cannot lawfully
 * credit raises an ALARM, a durable `billing_alarms` row plus a countable log line, instead of a
 * silent skip; the response stays 200 for money we will never match, so Stripe does not retry it
 * for days.
 *
 * RUN:  npx tsx --test src/test/billing-topup-webhook.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createClient } from "@libsql/client";
import { FREE_TIER_BALANCE_MICRO_USD } from "../billing-pricing.js";
import { BillingStore } from "../billing-store.js";
import { processStripeWebhook, signStripePayload } from "../stripe-webhook.js";

const SECRET = "whsec_test_topup";
const T = 1_700_000_000;
const ASYNC_SUCCEEDED = "checkout.session.async_payment_succeeded";

interface Harness {
	store: BillingStore;
	path: string;
	lines: string[];
	post(event: object): ReturnType<typeof processStripeWebhook>;
}

async function harness(prefix = "topup-"): Promise<Harness> {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "billing.sqlite");
	const store = new BillingStore(path);
	await store.init();
	after(() => store.close());
	const lines: string[] = [];
	return {
		store,
		path,
		lines,
		post: (event) => {
			const rawBody = JSON.stringify(event);
			return processStripeWebhook(rawBody, signStripePayload(rawBody, SECRET, T), {
				billing: store,
				secret: SECRET,
				nowSecs: T,
				log: (line) => lines.push(line),
			});
		},
	};
}

interface SessionOptions {
	eventId?: string;
	type?: string;
	customer?: string | null;
	subtotal?: number | null;
	total?: number;
	currency?: string;
	paymentIntent?: string | null;
	livemode?: boolean;
	kind?: string | null;
	mode?: string;
	paymentStatus?: string;
	clientReferenceId?: string | null;
}

function sessionEvent(sessionId: string, options: SessionOptions = {}) {
	const subtotal = options.subtotal === undefined ? 1_000 : options.subtotal;
	return {
		id: options.eventId ?? `evt_${sessionId}`,
		type: options.type ?? "checkout.session.completed",
		created: T,
		livemode: options.livemode ?? true,
		api_version: "2025-03-31.basil",
		data: {
			object: {
				id: sessionId,
				object: "checkout.session",
				mode: options.mode ?? "payment",
				payment_status: options.paymentStatus ?? "paid",
				status: "complete",
				customer: options.customer === undefined ? "cus_payer" : options.customer,
				client_reference_id: options.clientReferenceId === undefined ? "payer" : options.clientReferenceId,
				metadata: options.kind === null ? {} : { kind: options.kind ?? "topup", user_id: "payer" },
				amount_subtotal: subtotal,
				amount_total: options.total ?? subtotal,
				currency: options.currency ?? "usd",
				payment_intent: options.paymentIntent === undefined ? `pi_${sessionId}` : options.paymentIntent,
			},
		},
	};
}

async function payerHarness() {
	const h = await harness();
	await h.store.upsertCustomer("payer", "cus_payer");
	return h;
}

describe("checkout.session.completed credits a top-up", () => {
	it("credits amount_subtotal (never the tax-inclusive total) under grant id cs:<session>", async () => {
		const h = await payerHarness();
		const res = await h.post(sessionEvent("cs_1", { subtotal: 1_000, total: 1_100 }));
		assert.equal(res.status, 200);
		assert.deepEqual(res.body, { kind: "grant", credited: true, isNewGrant: true });
		assert.equal((await h.store.getCredit("payer"))?.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD + 10_000_000);
		const grant = await h.store.getGrant("cs:cs_1");
		assert.equal(grant?.stripeObject, "checkout_session");
		assert.equal(grant?.amountMicroUsd, 10_000_000);
		assert.equal(grant?.currency, "usd");
		assert.equal(grant?.credited, true);
		assert.equal(grant?.userId, "payer");
		assert.deepEqual(h.lines, []);
	});

	it("credits once under redelivery with a different event id, and when the async event follows", async () => {
		const h = await payerHarness();
		await h.post(sessionEvent("cs_2", { subtotal: 500 }));
		const again = await h.post(sessionEvent("cs_2", { subtotal: 500, eventId: "evt_redelivered" }));
		assert.equal((again.body as { isNewGrant: boolean }).isNewGrant, false);
		const asyncEvent = await h.post(
			sessionEvent("cs_2", { subtotal: 500, eventId: "evt_async", type: ASYNC_SUCCEEDED }),
		);
		assert.equal((asyncEvent.body as { credited: boolean }).credited, false);
		assert.equal((await h.store.getCredit("payer"))?.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD + 5_000_000);
	});

	it("waits for money that has not settled: unpaid credits nothing until the async event says paid", async () => {
		const h = await payerHarness();
		const pending = await h.post(sessionEvent("cs_3", { subtotal: 2_500, paymentStatus: "unpaid" }));
		assert.deepEqual(pending.body, { ignored: "checkout.session.completed", reason: "payment_not_settled" });
		assert.equal(await h.store.getCredit("payer"), undefined);
		const settled = await h.post(
			sessionEvent("cs_3", { subtotal: 2_500, eventId: "evt_settled", type: ASYNC_SUCCEEDED }),
		);
		assert.deepEqual(settled.body, { kind: "grant", credited: true, isNewGrant: true });
		assert.equal((await h.store.getCredit("payer"))?.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD + 25_000_000);
	});

	it("credits only top-ups: a subscription or a payment with no topup marker is ignored", async () => {
		const h = await payerHarness();
		for (const [id, options] of [
			["cs_sub", { mode: "subscription" }],
			["cs_nokind", { kind: null }],
			["cs_other", { kind: "donation" }],
		] as const) {
			const res = await h.post(sessionEvent(id, options));
			assert.deepEqual(res.body, { ignored: "checkout.session.completed", reason: "not_a_topup" }, id);
		}
		assert.equal(await h.store.getCredit("payer"), undefined);
		assert.equal(await h.store.getGrant("cs:cs_sub"), undefined);
	});

	it("keeps the link to the PaymentIntent so a later refund or dispute can find this money", async () => {
		const h = await payerHarness();
		await h.post(sessionEvent("cs_4", { subtotal: 1_000, total: 1_100, paymentIntent: "pi_link" }));
		const link = await h.store.getGrantPayment("pi_link");
		assert.deepEqual(link, {
			paymentIntentId: "pi_link",
			grantId: "cs:cs_4",
			userId: "payer",
			chargeAmountCents: 1_100,
			creditedMicroUsd: 10_000_000,
			currency: "usd",
		});
		assert.equal(await h.store.getGrantPayment("pi_never"), undefined);
	});
});

describe("payment_intent.succeeded never credits (the double-credit trap)", () => {
	it("is acknowledged and ignored, even for the very PaymentIntent a top-up session was paid with", async () => {
		const h = await payerHarness();
		await h.post(sessionEvent("cs_5", { subtotal: 500, paymentIntent: "pi_5" }));
		const balanceAfterSession = (await h.store.getCredit("payer"))?.balanceMicroUsd;
		const res = await h.post({
			id: "evt_pi_5",
			type: "payment_intent.succeeded",
			created: T,
			livemode: true,
			data: { object: { id: "pi_5", customer: "cus_payer", amount: 500, currency: "usd" } },
		});
		assert.deepEqual(res.body, { ignored: "payment_intent.succeeded", reason: "credited_from_checkout_session" });
		assert.equal((await h.store.getCredit("payer"))?.balanceMicroUsd, balanceAfterSession);
		assert.equal(await h.store.getGrant("pi:pi_5"), undefined, "no second grant identity exists for this money");
	});

	it("does not credit the PaymentIntent of a subscription invoice either", async () => {
		const h = await payerHarness();
		const res = await h.post({
			id: "evt_pi_invoice",
			type: "payment_intent.succeeded",
			created: T,
			livemode: true,
			data: { object: { id: "pi_invoice", customer: "cus_payer", amount: 1_500, currency: "usd", invoice: "in_1" } },
		});
		assert.equal(res.status, 200);
		assert.equal(await h.store.getCredit("payer"), undefined);
	});
});

describe("what cannot be credited raises an alarm instead of a silent skip", () => {
	it("a live payment in another currency is recorded, never credited, and alarmed", async () => {
		const h = await payerHarness();
		const res = await h.post(sessionEvent("cs_eur", { subtotal: 1_000, currency: "eur" }));
		assert.equal(res.status, 200);
		assert.deepEqual(res.body, { kind: "grant", credited: false, isNewGrant: true, alarm: "non_usd_payment" });
		assert.equal(await h.store.getCredit("payer"), undefined);
		const alarms = await h.store.listBillingAlarms();
		assert.equal(alarms.length, 1);
		assert.equal(alarms[0].kind, "non_usd_payment");
		assert.equal(alarms[0].eventId, "evt_cs_eur");
		assert.equal(alarms[0].userId, "payer");
		assert.equal(alarms[0].objectId, "cs_eur");
		assert.ok(h.lines.some((line) => line.includes("ALARM") && line.includes("non_usd_payment")));
	});

	it("an alarm is raised once per event, however many times Stripe redelivers it", async () => {
		const h = await payerHarness();
		for (let i = 0; i < 3; i++) await h.post(sessionEvent("cs_eur2", { currency: "gbp", eventId: "evt_same" }));
		assert.equal((await h.store.listBillingAlarms()).length, 1);
		assert.equal(h.lines.filter((line) => line.includes("ALARM")).length, 1, "and the line is logged once");
	});

	it("a test-mode payment is inert by design: nothing credited and no alarm", async () => {
		const h = await payerHarness();
		const res = await h.post(sessionEvent("cs_test", { livemode: false }));
		assert.equal(res.status, 200);
		assert.equal((res.body as { credited: boolean }).credited, false);
		assert.equal(await h.store.getCredit("payer"), undefined);
		assert.deepEqual(await h.store.listBillingAlarms(), []);
	});

	it("an event for a customer we cannot map is 409 (Stripe retries), and alarmed once", async () => {
		const h = await harness();
		const first = await h.post(sessionEvent("cs_unmapped", { customer: "cus_stranger" }));
		assert.equal(first.status, 409);
		assert.deepEqual(first.body, { error: "unmapped_customer", customer: "cus_stranger" });
		await h.post(sessionEvent("cs_unmapped", { customer: "cus_stranger" }));
		const alarms = await h.store.listBillingAlarms();
		assert.equal(alarms.length, 1);
		assert.equal(alarms[0].kind, "unmapped_customer");
		assert.equal(alarms[0].objectId, "cus_stranger");
	});

	it("a session whose client_reference_id names someone else is refused and alarmed, not credited", async () => {
		const h = await payerHarness();
		const res = await h.post(sessionEvent("cs_swap", { clientReferenceId: "someone-else" }));
		assert.equal(res.status, 200);
		assert.deepEqual(res.body, { kind: "grant", credited: false, isNewGrant: false, alarm: "user_mismatch" });
		assert.equal(await h.store.getCredit("payer"), undefined);
		assert.equal(await h.store.getCredit("someone-else"), undefined);
		assert.equal((await h.store.listBillingAlarms())[0]?.kind, "user_mismatch");
	});

	it("a paid top-up with no positive whole-cent subtotal is alarmed, never credited", async () => {
		const h = await payerHarness();
		for (const [id, subtotal] of [
			["cs_zero", 0],
			["cs_null", null],
			["cs_frac", 12.5],
			["cs_neg", -100],
		] as const) {
			const res = await h.post(sessionEvent(id, { subtotal }));
			const expected = { kind: "grant", credited: false, isNewGrant: false, alarm: "bad_topup_amount" };
			assert.deepEqual(res.body, expected, id);
		}
		assert.equal(await h.store.getCredit("payer"), undefined);
		assert.equal((await h.store.listBillingAlarms()).length, 4);
	});
});

describe("historical money is never credited twice, whichever id it arrives under", () => {
	async function legacyHarness() {
		const h = await harness("topup-legacy-");
		const sql = createClient({ url: `file:${h.path}` });
		after(() => sql.close());
		// The offline migration insert (never a runtime path): cloud-1 money keyed by its PaymentIntent.
		await sql.execute({
			sql: "INSERT INTO legacy_payment_suppressions VALUES(?,?,?,?,?,?,?,?,?,?)",
			args: ["pi:pi_old", "payer", null, 5_000_000, "usd", 1, "cs_old", "a".repeat(64), "b".repeat(64), "import"],
		});
		await h.store.upsertCustomer("payer", "cus_payer");
		return { ...h, sql };
	}

	it("a replayed Checkout event for a session whose PaymentIntent was imported is suppressed", async () => {
		const h = await legacyHarness();
		const res = await h.post(sessionEvent("cs_old", { subtotal: 500, paymentIntent: "pi_old" }));
		assert.deepEqual(res.body, { kind: "grant", credited: false, isNewGrant: false, suppressedLegacy: true });
		assert.equal(await h.store.getCredit("payer"), undefined, "no seed, no grant, no balance");
		for (const table of ["credit_grants", "stripe_webhook_events", "credits", "credit_grant_payments"]) {
			assert.equal(Number((await h.sql.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0].n), 0, table);
		}
	});

	it("a session that merely resembles imported money in identity but not in amount is refused loudly", async () => {
		const h = await legacyHarness();
		await assert.rejects(
			h.post(sessionEvent("cs_old", { subtotal: 600, paymentIntent: "pi_old" })),
			/suppression conflicts/,
		);
		assert.equal(await h.store.getCredit("payer"), undefined);
	});

	it("unrelated new money still credits exactly once beside imported money", async () => {
		const h = await legacyHarness();
		await h.post(sessionEvent("cs_new", { subtotal: 500, paymentIntent: "pi_new" }));
		await h.post(sessionEvent("cs_new", { subtotal: 500, paymentIntent: "pi_new", eventId: "evt_again" }));
		assert.equal((await h.store.getCredit("payer"))?.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD + 5_000_000);
	});

	it("money the previous release credited under its PaymentIntent is not credited again by its session", async () => {
		// A rolling deploy can hand one payment's two events to two releases: the old one credits the
		// `payment_intent.succeeded` under `pi:<id>`, the new one then sees `checkout.session.completed`.
		const h = await payerHarness();
		await h.store.recordGrantAndCredit(
			{
				eventId: "evt_previous_release",
				eventType: "payment_intent.succeeded",
				stripeCreated: T,
				apiVersion: null,
				livemode: 1,
				stripeCustomerId: "cus_payer",
				payloadSha256: null,
			},
			{
				grantId: "pi:pi_prev",
				userId: "payer",
				stripeCustomerId: "cus_payer",
				sourceEventId: "evt_previous_release",
				stripeObject: "payment_intent",
				amountMicroUsd: 5_000_000,
				currency: "usd",
				livemode: 1,
			},
		);
		const res = await h.post(sessionEvent("cs_prev", { subtotal: 500, paymentIntent: "pi_prev" }));
		assert.deepEqual(res.body, { kind: "grant", credited: false, isNewGrant: false });
		assert.equal((await h.store.getCredit("payer"))?.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD + 5_000_000);
		assert.equal(await h.store.getGrant("cs:cs_prev"), undefined, "the session adds no second identity for it");
		assert.equal(await h.store.getGrantPayment("pi_prev"), undefined);
	});
});
