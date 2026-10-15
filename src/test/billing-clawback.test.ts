/**
 * Refunds and disputes as negative adjustments (Sobremesa, E §4.4.5 c) — REAL libSQL and REAL HMAC
 * signatures, NO MOCKS.
 *
 * Nothing clawed credit back: buy $10, spend it, refund it, and the ledger kept the money the
 * person no longer paid for (E L9). `charge.refunded` and `charge.dispute.created` now post
 * signed, idempotent adjustments against the top-up they belong to, found through the PaymentIntent
 * link recorded when the top-up was credited. The claw-back is proportional to the money returned
 * (a refund of half the charge takes back half the CREDIT, tax-inclusive charge or not), never more
 * than was credited across every refund and dispute together, and idempotent per cumulative refund
 * state. Money we cannot match, or that came back in another currency, raises an alarm.
 *
 * RUN:  npx tsx --test src/test/billing-clawback.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createClient } from "@libsql/client";
import { CreditAdmission } from "../billing-gate.js";
import { FREE_TIER_BALANCE_MICRO_USD } from "../billing-pricing.js";
import { readCreditHistory } from "../billing-read.js";
import { BillingStore } from "../billing-store.js";
import { processStripeWebhook, signStripePayload } from "../stripe-webhook.js";
import { usageEvent } from "./billing-ledger-fixture.js";

const SECRET = "whsec_test_clawback";
const T = 1_700_000_000;

async function harness() {
	const dir = mkdtempSync(join(tmpdir(), "clawback-"));
	after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "billing.sqlite");
	const store = new BillingStore(path);
	await store.init();
	after(() => store.close());
	await store.upsertCustomer("payer", "cus_payer");
	const lines: string[] = [];
	const post = (event: object) => {
		const rawBody = JSON.stringify(event);
		return processStripeWebhook(rawBody, signStripePayload(rawBody, SECRET, T), {
			billing: store,
			secret: SECRET,
			nowSecs: T,
			log: (line) => lines.push(line),
		});
	};
	return { store, path, lines, post };
}

function topUp(sessionId: string, paymentIntent: string, subtotal: number, total = subtotal, currency = "usd") {
	return {
		id: `evt_${sessionId}`,
		type: "checkout.session.completed",
		created: T,
		livemode: true,
		data: {
			object: {
				id: sessionId,
				mode: "payment",
				payment_status: "paid",
				customer: "cus_payer",
				client_reference_id: "payer",
				metadata: { kind: "topup", user_id: "payer" },
				amount_subtotal: subtotal,
				amount_total: total,
				currency,
				payment_intent: paymentIntent,
			},
		},
	};
}

function refund(
	eventId: string,
	chargeId: string,
	paymentIntent: string | null,
	amount: number,
	refunded: number,
	options: { currency?: string; livemode?: boolean } = {},
) {
	return {
		id: eventId,
		type: "charge.refunded",
		created: T,
		livemode: options.livemode ?? true,
		data: {
			object: {
				id: chargeId,
				object: "charge",
				amount,
				amount_refunded: refunded,
				currency: options.currency ?? "usd",
				customer: "cus_payer",
				payment_intent: paymentIntent,
				livemode: options.livemode ?? true,
			},
		},
	};
}

function dispute(
	eventId: string,
	disputeId: string,
	chargeId: string,
	paymentIntent: string | null,
	amount: number,
	options: { currency?: string; livemode?: boolean } = {},
) {
	return {
		id: eventId,
		type: "charge.dispute.created",
		created: T,
		livemode: options.livemode ?? true,
		data: {
			object: {
				id: disputeId,
				object: "dispute",
				amount,
				currency: options.currency ?? "usd",
				charge: chargeId,
				payment_intent: paymentIntent,
				status: "needs_response",
				reason: "fraudulent",
				livemode: options.livemode ?? true,
			},
		},
	};
}

describe("charge.refunded claws back the credit that was bought", () => {
	it("a full refund takes back the whole credit, once, and the history says so", async () => {
		const h = await harness();
		await h.post(topUp("cs_a", "pi_a", 1_000));
		const res = await h.post(refund("evt_r1", "ch_a", "pi_a", 1_000, 1_000));
		assert.equal(res.status, 200);
		assert.deepEqual(res.body, {
			kind: "clawback",
			applied: true,
			amountMicroUsd: 10_000_000,
			balanceMicroUsd: FREE_TIER_BALANCE_MICRO_USD,
		});
		const adjustment = await h.store.getCreditAdjustment("refund:ch_a:1000");
		assert.equal(adjustment?.amountMicroUsd, -10_000_000);
		assert.equal(adjustment?.kind, "refund");
		assert.equal(adjustment?.reason, "Refund of a credit purchase");
		assert.equal(adjustment?.actor, "stripe:webhook");
		assert.equal(adjustment?.sourceRef, "pi_a");
		assert.equal(adjustment?.userId, "payer");
		assert.equal((await h.store.getCredit("payer"))?.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD);

		const history = await readCreditHistory(h.store, "payer", { limit: 10 });
		assert.deepEqual(
			history.items.map((item) => [item.label, item.amountMicroUsd]),
			[
				["Refund", -10_000_000],
				["Credits added", 10_000_000],
			],
		);
	});

	it("marks the webhook row processed and dedupes the same event redelivered", async () => {
		const h = await harness();
		await h.post(topUp("cs_b0", "pi_b0", 500));
		await h.post(refund("evt_dup", "ch_b0", "pi_b0", 500, 500));
		const again = await h.post(refund("evt_dup", "ch_b0", "pi_b0", 500, 500));
		assert.deepEqual(again.body, { kind: "clawback", applied: false, reason: "duplicate" });
		const sql = createClient({ url: `file:${h.path}` });
		try {
			const row = await sql.execute("SELECT status FROM stripe_webhook_events WHERE event_id = 'evt_dup'");
			assert.equal(String(row.rows[0]?.status), "processed");
		} finally {
			sql.close();
		}
		assert.equal((await h.store.getCredit("payer"))?.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD);
	});

	it("partial refunds claw back the increments, and a redelivered or older state changes nothing", async () => {
		const h = await harness();
		await h.post(topUp("cs_b", "pi_b", 1_000));
		const first = await h.post(refund("evt_p1", "ch_b", "pi_b", 1_000, 400));
		assert.equal((first.body as { amountMicroUsd: number }).amountMicroUsd, 4_000_000);
		const second = await h.post(refund("evt_p2", "ch_b", "pi_b", 1_000, 700));
		const incremental = (second.body as { amountMicroUsd: number }).amountMicroUsd;
		assert.equal(incremental, 3_000_000, "the increment, not 7M again");
		const redelivered = await h.post(refund("evt_p1_again", "ch_b", "pi_b", 1_000, 400));
		assert.deepEqual(redelivered.body, { kind: "clawback", applied: false, reason: "duplicate" });
		const stale = await h.post(refund("evt_p_stale", "ch_b", "pi_b", 1_000, 300));
		assert.deepEqual(stale.body, { kind: "clawback", applied: false, reason: "nothing_to_claw_back" });
		const balance = (await h.store.getCredit("payer"))?.balanceMicroUsd;
		assert.equal(balance, FREE_TIER_BALANCE_MICRO_USD + 10_000_000 - 7_000_000);
	});

	it("is proportional to the money returned when the charge included tax", async () => {
		const h = await harness();
		await h.post(topUp("cs_tax", "pi_tax", 1_000, 1_100)); // $10.00 of credit, charged $11.00
		const half = await h.post(refund("evt_t1", "ch_tax", "pi_tax", 1_100, 550));
		assert.equal((half.body as { amountMicroUsd: number }).amountMicroUsd, 5_000_000);
		const rest = await h.post(refund("evt_t2", "ch_tax", "pi_tax", 1_100, 1_100));
		assert.equal((rest.body as { amountMicroUsd: number }).amountMicroUsd, 5_000_000);
		assert.equal((await h.store.getCredit("payer"))?.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD);
	});

	it("goes below zero when the credit was already spent, and the gate holds the line", async () => {
		const h = await harness();
		await h.post(topUp("cs_spent", "pi_spent", 1_000));
		const spend = usageEvent({ eventId: "spent-1", userId: "payer", costMicroUsd: 9_000_000 });
		await h.store.recordUsageAndDebit(spend);
		assert.equal((await h.store.getCredit("payer"))?.balanceMicroUsd, 2_000_000);
		await h.post(refund("evt_spent", "ch_spent", "pi_spent", 1_000, 1_000));
		assert.equal((await h.store.getCredit("payer"))?.balanceMicroUsd, 2_000_000 - 10_000_000);

		const gate = new CreditAdmission({ billing: h.store, mode: "enforce", log: () => {} });
		const verdict = await gate.admitIngress({
			door: "ingress.invocation",
			userId: "payer",
			provider: "openrouter",
			model: "google/gemini-2.5-flash",
		});
		assert.equal(verdict.allow, false, "the refunded, overspent person is out of credits");
	});

	it("many concurrent copies of one refund claw back exactly once", async () => {
		const h = await harness();
		await h.post(topUp("cs_race", "pi_race", 1_000));
		const results = await Promise.all(
			Array.from({ length: 6 }, (_, i) => h.post(refund(`evt_race_${i}`, "ch_race", "pi_race", 1_000, 1_000))),
		);
		assert.equal(results.filter((r) => (r.body as { applied: boolean }).applied).length, 1);
		assert.equal((await h.store.getCredit("payer"))?.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD);
	});
});

describe("charge.dispute.created claws back what was disputed", () => {
	it("takes back the disputed share immediately, once per dispute", async () => {
		const h = await harness();
		await h.post(topUp("cs_d", "pi_d", 1_000));
		const res = await h.post(dispute("evt_d1", "dp_1", "ch_d", "pi_d", 1_000));
		assert.deepEqual(res.body, {
			kind: "clawback",
			applied: true,
			amountMicroUsd: 10_000_000,
			balanceMicroUsd: FREE_TIER_BALANCE_MICRO_USD,
		});
		const adjustment = await h.store.getCreditAdjustment("dispute:dp_1");
		assert.equal(adjustment?.kind, "dispute");
		assert.equal(adjustment?.reason, "Dispute on a credit purchase");
		assert.equal(adjustment?.sourceRef, "pi_d");
		const again = await h.post(dispute("evt_d1_again", "dp_1", "ch_d", "pi_d", 1_000));
		assert.deepEqual(again.body, { kind: "clawback", applied: false, reason: "duplicate" });
	});

	it("never claws back more than was credited across refunds AND disputes together", async () => {
		const h = await harness();
		await h.post(topUp("cs_cap", "pi_cap", 1_000));
		await h.post(refund("evt_cap_r", "ch_cap", "pi_cap", 1_000, 1_000));
		const disputed = await h.post(dispute("evt_cap_d", "dp_cap", "ch_cap", "pi_cap", 1_000));
		assert.deepEqual(disputed.body, { kind: "clawback", applied: false, reason: "nothing_to_claw_back" });
		assert.equal((await h.store.getCredit("payer"))?.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD);
		assert.equal(await h.store.getCreditAdjustment("dispute:dp_cap"), undefined);
	});

	it("a partial dispute takes back its proportion", async () => {
		const h = await harness();
		await h.post(topUp("cs_pd", "pi_pd", 2_000));
		const res = await h.post(dispute("evt_pd", "dp_pd", "ch_pd", "pi_pd", 500));
		assert.equal((res.body as { amountMicroUsd: number }).amountMicroUsd, 5_000_000);
	});
});

describe("money that cannot be matched raises an alarm instead of a silent skip", () => {
	it("a refund of a payment we never credited is acknowledged and alarmed, and moves nothing", async () => {
		const h = await harness();
		const res = await h.post(refund("evt_x", "ch_x", "pi_never_credited", 1_000, 1_000));
		assert.equal(res.status, 200, "200, or Stripe would retry a payment we will never match");
		assert.deepEqual(res.body, {
			kind: "clawback",
			applied: false,
			reason: "unmatched_payment",
			alarm: "unmatched_payment",
		});
		const alarms = await h.store.listBillingAlarms();
		assert.equal(alarms.length, 1);
		assert.equal(alarms[0].kind, "unmatched_payment");
		assert.equal(alarms[0].objectId, "ch_x");
		assert.equal(alarms[0].eventId, "evt_x");
		assert.ok(h.lines.some((line) => line.includes("ALARM") && line.includes("unmatched_payment")));
		assert.equal(await h.store.getCredit("payer"), undefined);
	});

	it("a refund or dispute with no PaymentIntent at all cannot be matched and is alarmed the same way", async () => {
		const h = await harness();
		const refundResult = await h.post(refund("evt_nopi_r", "ch_nopi", null, 1_000, 1_000));
		const disputeResult = await h.post(dispute("evt_nopi_d", "dp_nopi", "ch_nopi", null, 1_000));
		for (const res of [refundResult, disputeResult]) {
			assert.equal((res.body as { alarm: string }).alarm, "unmatched_payment");
		}
		assert.equal((await h.store.listBillingAlarms()).length, 2);
	});

	it("a dispute of a payment we never credited is alarmed", async () => {
		const h = await harness();
		const res = await h.post(dispute("evt_dx", "dp_x", "ch_x", "pi_never_credited", 1_000));
		assert.equal((res.body as { alarm: string }).alarm, "unmatched_payment");
		assert.equal((await h.store.listBillingAlarms())[0]?.objectId, "dp_x");
	});

	it("money returned in another currency is not converted: alarmed and left alone", async () => {
		const h = await harness();
		await h.post(topUp("cs_cur", "pi_cur", 1_000));
		const res = await h.post(refund("evt_cur", "ch_cur", "pi_cur", 1_000, 1_000, { currency: "eur" }));
		assert.deepEqual(res.body, {
			kind: "clawback",
			applied: false,
			reason: "currency_mismatch",
			alarm: "clawback_currency_mismatch",
		});
		assert.equal((await h.store.getCredit("payer"))?.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD + 10_000_000);
	});

	it("a test-mode refund is inert by design: nothing moves and there is no alarm", async () => {
		const h = await harness();
		await h.post(topUp("cs_tm", "pi_tm", 1_000));
		const res = await h.post(refund("evt_tm", "ch_tm", "pi_tm", 1_000, 1_000, { livemode: false }));
		assert.deepEqual(res.body, { kind: "clawback", applied: false, reason: "test_mode" });
		assert.deepEqual(await h.store.listBillingAlarms(), []);
		assert.equal((await h.store.getCredit("payer"))?.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD + 10_000_000);
	});
});
