/**
 * Billing read projections (WS-B) — the shapers behind GET /api/billing/*.
 * REAL libSQL, NO MOCKS.
 *
 * RUN:  npx tsx --test src/test/billing-read.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { FREE_TIER_BALANCE_MICRO_USD, MIN_ALLOWED_BALANCE_MICRO_USD } from "../billing-pricing.js";
import { readBillingBalance, readBillingSubscription, readBillingUsage, usageWindow } from "../billing-read.js";
import { BillingStore } from "../billing-store.js";

async function freshStore(prefix: string): Promise<BillingStore> {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	after(() => rmSync(dir, { recursive: true, force: true }));
	const store = new BillingStore(join(dir, "billing.sqlite"));
	await store.init();
	after(() => store.close());
	return store;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

describe("billing-read: GET /api/billing/* shapers", () => {
	it("balance: an uninitialized user reports the free-tier defaults, the fee in force and the gate mode", async () => {
		const store = await freshStore("br-bal0-");
		const v = await readBillingBalance(store, "u_new", "observe", {});
		assert.deepEqual(v, {
			userId: "u_new",
			balanceMicroUsd: FREE_TIER_BALANCE_MICRO_USD,
			lifetimeUsageMicroUsd: 0,
			floorMicroUsd: MIN_ALLOWED_BALANCE_MICRO_USD,
			initialized: false,
			feeBps: 1500,
			gateMode: "observe",
		});
		assert.equal("creditsStartDate" in v, false, "absent, not null, when no date is set");
	});

	it("balance: the reported floor follows the gate mode (-$0.50 observe, $0 enforce), and only the mode moves with it", async () => {
		// The deployed gateway parses this view with deny_unknown_fields: the five original keys keep their names, and
		// the view only ever GROWS (feeBps, gateMode, creditsStartDate are additive, the gateway rolls first).
		const store = await freshStore("br-floor-");
		const observe = await readBillingBalance(store, "u_floor", "observe", {});
		const enforce = await readBillingBalance(store, "u_floor", "enforce", {});
		assert.equal(observe.floorMicroUsd, MIN_ALLOWED_BALANCE_MICRO_USD);
		assert.equal(enforce.floorMicroUsd, 0);
		assert.deepEqual(Object.keys(enforce).sort(), Object.keys(observe).sort());
		assert.deepEqual(Object.keys(enforce).sort(), [
			"balanceMicroUsd",
			"feeBps",
			"floorMicroUsd",
			"gateMode",
			"initialized",
			"lifetimeUsageMicroUsd",
			"userId",
		]);
		assert.deepEqual({ ...enforce, floorMicroUsd: observe.floorMicroUsd, gateMode: observe.gateMode }, observe);
	});

	it("balance: an unset mode reads the environment, and an unset environment is observe", async () => {
		const store = await freshStore("br-floor-env-");
		const previous = process.env.BILLING_GATE_MODE;
		delete process.env.BILLING_GATE_MODE;
		try {
			assert.equal((await readBillingBalance(store, "u_env")).floorMicroUsd, MIN_ALLOWED_BALANCE_MICRO_USD);
			process.env.BILLING_GATE_MODE = "enforce";
			assert.equal((await readBillingBalance(store, "u_env")).floorMicroUsd, 0);
		} finally {
			if (previous === undefined) delete process.env.BILLING_GATE_MODE;
			else process.env.BILLING_GATE_MODE = previous;
		}
	});

	it("balance: a debit past zero is reported as it is (negative), never clamped", async () => {
		const store = await freshStore("br-negative-");
		await store.recordUsageAndDebit({
			eventId: "br-neg-1",
			ts: Date.now(),
			userId: "u_neg",
			graphId: null,
			sandboxId: null,
			template: "agent",
			provider: "openrouter",
			model: "google/gemini-2.5-flash",
			modelPriced: "google/gemini-2.5-flash",
			reason: "stop",
			inputTokens: 1,
			outputTokens: 1,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 2,
			inputCostMicroUsd: 0,
			outputCostMicroUsd: 0,
			cacheReadCostMicroUsd: 0,
			cacheWriteCostMicroUsd: 0,
			providerCostMicroUsd: 0,
			markupMicroUsd: 0,
			costMicroUsd: 1_250_000,
			pricingVersion: "test",
			pricedDefault: false,
		});
		const v = await readBillingBalance(store, "u_neg", "enforce");
		assert.equal(v.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD - 1_250_000);
		assert.equal(v.initialized, true);
	});

	it("subscription: an unsubscribed user is free/none", async () => {
		const store = await freshStore("br-sub0-");
		const v = await readBillingSubscription(store, "u_x");
		assert.equal(v.tier, "free");
		assert.equal(v.status, "none");
		assert.equal(v.plan, null);
		assert.equal(v.currentPeriodEnd, null);
		assert.equal(v.canManage, false);
	});
	it("portal eligibility requires a customer and configuration, not a paid subscription", async () => {
		const store = await freshStore("br-portal-");
		assert.equal((await readBillingSubscription(store, "owner", true)).canManage, false);
		await store.upsertCustomer("owner", "cus_test");
		assert.equal((await readBillingSubscription(store, "owner", false)).canManage, false);
		const view = await readBillingSubscription(store, "owner", true);
		assert.equal(view.canManage, true);
		assert.equal(view.status, "none");
		assert.equal((await readBillingSubscription(store, "other", true)).canManage, false);
	});

	it("subscription: reflects a recorded pro subscription", async () => {
		const store = await freshStore("br-subpro-");
		await store.recordSubscriptionAndFold(
			{
				eventId: "e1",
				eventType: "customer.subscription.created",
				stripeCreated: 1,
				apiVersion: null,
				livemode: 1,
				stripeCustomerId: "cus",
				payloadSha256: null,
			},
			{
				userId: "u_p",
				stripeCustomerId: "cus",
				stripeSubscriptionId: "sub",
				plan: "price_pro",
				status: "active",
				currentPeriodEnd: 999,
				livemode: 1,
			},
			{ price_pro: "pro" },
		);
		const v = await readBillingSubscription(store, "u_p");
		assert.equal(v.tier, "pro");
		assert.equal(v.status, "active");
		assert.equal(v.plan, "price_pro");
		assert.equal(v.currentPeriodEnd, 999);
	});

	it("usage: an empty window sums to zero", async () => {
		const store = await freshStore("br-use-");
		const v = await readBillingUsage(store, "u_x", 0, Date.now());
		assert.equal(v.totalMicroUsd, 0);
		assert.equal(v.eventCount, 0);
	});

	it("usageWindow: defaults to a trailing 30-day window; honors ?from/?to; falls back on garbage", () => {
		const now = 1_000_000_000_000;
		assert.deepEqual(usageWindow(null, null, now), { fromTs: now - THIRTY_DAYS_MS, toTs: now });
		assert.deepEqual(usageWindow("100", "200", now), { fromTs: 100, toTs: 200 });
		assert.equal(usageWindow("nope", null, now).fromTs, now - THIRTY_DAYS_MS);
		// an empty param (`?from=`) must fall back to the default window, not epoch 0.
		assert.equal(usageWindow("", null, now).fromTs, now - THIRTY_DAYS_MS);
		assert.equal(usageWindow(null, "", now).toTs, now);
	});
});

describe("balance: the notice fields, additive (Vera, 2026-10-03: the credits notice is the backend's to turn over)", () => {
	const KEPT = {
		userId: "string",
		balanceMicroUsd: "number",
		lifetimeUsageMicroUsd: "number",
		floorMicroUsd: "number",
		initialized: "boolean",
	} as const;

	it("feeBps is the fee in force: 1500 until the flip, 2000 after it", async () => {
		const store = await freshStore("br-fee-");
		assert.equal((await readBillingBalance(store, "u", "observe", {})).feeBps, 1500);
		assert.equal((await readBillingBalance(store, "u", "enforce", { BILLING_FEE_BPS: "2000" })).feeBps, 2000);
		assert.equal(
			(await readBillingBalance(store, "u", "observe", { BILLING_FEE_BPS: "20%" })).feeBps,
			1500,
			"a typo is the default",
		);
	});

	it("gateMode is the live mode of the gate, whatever the fee says", async () => {
		const store = await freshStore("br-mode-");
		for (const mode of ["observe", "enforce"] as const) {
			assert.equal((await readBillingBalance(store, "u", mode, {})).gateMode, mode);
			assert.equal((await readBillingBalance(store, "u", mode, { BILLING_FEE_BPS: "2000" })).gateMode, mode);
		}
	});

	it("creditsStartDate is a valid YYYY-MM-DD from CREDITS_START_DATE, and absent (no key) otherwise", async () => {
		const store = await freshStore("br-date-");
		const view = (env: NodeJS.ProcessEnv) => readBillingBalance(store, "u", "observe", env);
		assert.equal((await view({ CREDITS_START_DATE: "2026-10-06" })).creditsStartDate, "2026-10-06");
		assert.equal((await view({ CREDITS_START_DATE: " 2026-10-06 " })).creditsStartDate, "2026-10-06");
		assert.equal((await view({ CREDITS_START_DATE: "2028-02-29" })).creditsStartDate, "2028-02-29", "a leap day");
		for (const unset of [{}, { CREDITS_START_DATE: "" }, { CREDITS_START_DATE: "   " }]) {
			assert.equal("creditsStartDate" in (await view(unset)), false, JSON.stringify(unset));
		}
		for (const bad of [
			"2026-13-01",
			"2026-02-30",
			"2027-02-29",
			"2026-10-6",
			"06/10/2026",
			"2026-10-06T00:00:00Z",
			"20261006",
			"tomorrow",
		]) {
			assert.equal(
				"creditsStartDate" in (await view({ CREDITS_START_DATE: bad })),
				false,
				`${bad} is not a date: absent, never shown wrong`,
			);
		}
	});

	it("the five original keys keep their names and their types: nothing is renamed, removed or retyped", async () => {
		const store = await freshStore("br-kept-");
		const view = await readBillingBalance(store, "u", "enforce", {
			BILLING_FEE_BPS: "2000",
			CREDITS_START_DATE: "2026-10-06",
		});
		for (const [key, type] of Object.entries(KEPT))
			assert.equal(typeof (view as unknown as Record<string, unknown>)[key], type, key);
		assert.deepEqual(Object.keys(view).sort(), [
			"balanceMicroUsd",
			"creditsStartDate",
			"feeBps",
			"floorMicroUsd",
			"gateMode",
			"initialized",
			"lifetimeUsageMicroUsd",
			"userId",
		]);
	});

	it("one restart turns the notice over: the observe deploy and the flip differ in exactly the fee, the mode, the floor and the date", async () => {
		const store = await freshStore("br-flip-");
		const observeDeploy = await readBillingBalance(store, "u", "observe", {});
		const flip = await readBillingBalance(store, "u", "enforce", {
			BILLING_FEE_BPS: "2000",
			CREDITS_START_DATE: "2026-10-06",
		});
		assert.deepEqual(
			{
				...flip,
				feeBps: observeDeploy.feeBps,
				gateMode: observeDeploy.gateMode,
				floorMicroUsd: observeDeploy.floorMicroUsd,
				creditsStartDate: undefined,
			},
			{ ...observeDeploy, creditsStartDate: undefined },
		);
		assert.deepEqual([observeDeploy.feeBps, observeDeploy.gateMode], [1500, "observe"]);
		assert.deepEqual([flip.feeBps, flip.gateMode, flip.creditsStartDate], [2000, "enforce", "2026-10-06"]);
	});
});
