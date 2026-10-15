import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { createClient } from "@libsql/client";
import { BillingStore } from "../billing-store.js";
import { processStripeWebhook, signStripePayload } from "../stripe-webhook.js";

async function fixture(customer: string | null = null) {
	const dir = mkdtempSync(join(tmpdir(), "legacy-payment-suppression-"));
	const path = join(dir, "billing.sqlite");
	const store = new BillingStore(path);
	await store.init();
	const sql = createClient({ url: `file:${path}` });
	// This is the offline migration insert, never a runtime grant or API.
	await sql.execute({
		sql: "INSERT INTO legacy_payment_suppressions VALUES(?,?,?,?,?,?,?,?,?,?)",
		args: [
			"pi:pi_old",
			"owner",
			customer,
			50000,
			"usd",
			1,
			"cs_old",
			"a".repeat(64),
			"b".repeat(64),
			"fixture-import",
		],
	});
	after(async () => {
		await store.close();
		sql.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { store, sql };
}

/**
 * A Checkout top-up event for `amount` cents whose PaymentIntent is `pi`. Money is credited from the
 * SESSION now, so historical money (imported under its `pi:` identity) must be suppressed through the
 * session's PaymentIntent, whichever id it arrives under. No client_reference_id: this suite tests the
 * suppression conflicts, not the user-mismatch alarm.
 */
async function post(store: BillingStore, id: string, pi = "pi_old", amount = 5) {
	const body = JSON.stringify({
		id,
		type: "checkout.session.completed",
		livemode: true,
		created: 1700000000,
		data: {
			object: {
				id: `cs_of_${pi}`,
				mode: "payment",
				payment_status: "paid",
				customer: "cus_now",
				metadata: { kind: "topup" },
				amount_subtotal: amount,
				amount_total: amount,
				currency: "usd",
				payment_intent: pi,
			},
		},
	});
	return processStripeWebhook(body, signStripePayload(body, "fixture-secret", 1700000000), {
		billing: store,
		secret: "fixture-secret",
		nowSecs: 1700000000,
	});
}

it("suppresses historical PI under different signed events without seed, grant or webhook fabrication", async () => {
	const { store, sql } = await fixture();
	await store.upsertCustomer("owner", "cus_now");
	for (const event of ["evt_old", "evt_redelivery", "evt_alternate"]) {
		const result = await post(store, event);
		assert.equal(result.status, 200);
		assert.equal(result.body.suppressedLegacy, true);
		assert.equal(result.body.credited, false);
	}
	assert.equal(await store.getCredit("owner"), undefined);
	for (const table of ["credit_grants", "stripe_webhook_events", "credits"]) {
		assert.equal(Number((await sql.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0].n), 0);
	}
});

it("preserves imported balance while unrelated new money still credits exactly once", async () => {
	const { store, sql } = await fixture();
	await sql.execute("INSERT INTO credits VALUES('owner', 123, 19, 1)");
	await store.upsertCustomer("owner", "cus_now");
	await post(store, "evt_old");
	assert.equal((await store.getCredit("owner"))?.balanceMicroUsd, 123);
	await post(store, "evt_new", "pi_new");
	await post(store, "evt_new_replay", "pi_new");
	assert.equal((await store.getCredit("owner"))?.balanceMicroUsd, 50123);
	assert.equal((await store.getCredit("owner"))?.lifetimeUsageMicroUsd, 19);
});

it("refuses reassigned owner or changed amount without any partial money writes", async () => {
	const { store, sql } = await fixture();
	await store.upsertCustomer("other-owner", "cus_now");
	await assert.rejects(post(store, "evt_owner_conflict"), /suppression conflicts/);
	await sql.execute("DELETE FROM customer_map");
	await store.upsertCustomer("owner", "cus_now");
	await assert.rejects(post(store, "evt_amount_conflict", "pi_old", 6), /suppression conflicts/);
	assert.equal(Number((await sql.execute("SELECT count(*) AS n FROM credit_grants")).rows[0].n), 0);
});

it("retains a non-null historical customer constraint", async () => {
	const { store } = await fixture("cus_historical");
	await store.upsertCustomer("owner", "cus_now");
	await assert.rejects(post(store, "evt_customer_conflict"), /suppression conflicts/);
});
