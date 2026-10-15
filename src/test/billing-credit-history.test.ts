/**
 * The credit history (Sobremesa, E §4.4.4 and §4.5.4) — REAL libSQL and a REAL orchestrator on
 * loopback, NO MOCKS.
 *
 * `GET /api/billing/credits/history` is a NEW route on purpose. The deployed gateway parses the
 * balance, subscription and usage views with `deny_unknown_fields`, so widening any of them
 * would make it answer 502; a new route can be added gateway-first without touching them. It is
 * owner-scoped and bearer-only like its siblings, and it shows the person what moved their
 * balance up or down: top-ups and deposits (grants) and every signed adjustment.
 *
 * RUN:  npx tsx --test src/test/billing-credit-history.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { creditHistoryQuery, readCreditHistory } from "../billing-read.js";
import type { BillingStore } from "../billing-store.js";
import { httpJson } from "./billing-credit-fixture.js";
import { openBilling } from "./billing-ledger-fixture.js";
import { type BillingRouteRig, startBillingRouteRig } from "./billing-route-fixture.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 6));

async function grant(
	store: BillingStore,
	userId: string,
	id: string,
	amountMicroUsd: number,
	options: { currency?: string; stripeObject?: string } = {},
): Promise<void> {
	await store.recordGrantAndCredit(
		{
			eventId: `evt_${id}`,
			eventType: "checkout.session.completed",
			stripeCreated: 1,
			apiVersion: null,
			livemode: 1,
			stripeCustomerId: `cus_${userId}`,
			payloadSha256: null,
		},
		{
			grantId: `cs:${id}`,
			userId,
			stripeCustomerId: `cus_${userId}`,
			sourceEventId: `evt_${id}`,
			stripeObject: options.stripeObject ?? "checkout_session",
			amountMicroUsd,
			currency: options.currency ?? "usd",
			livemode: 1,
		},
	);
}

async function seedHistory(store: BillingStore, userId: string): Promise<void> {
	await grant(store, userId, `cs_one_${userId}`, 5_000_000);
	await tick();
	await store.recordCreditAdjustment({
		adjustmentId: `ops:credits-start:${userId}`,
		userId,
		amountMicroUsd: 250_000,
		kind: "goodwill",
		reason: "credits start",
		actor: "script:goodwill-lift",
		batchId: "credits-start",
		sourceRef: null,
	});
	await tick();
	await grant(store, userId, `cs_two_${userId}`, 10_000_000);
	await tick();
	await store.recordCreditAdjustment({
		adjustmentId: `refund:pi_two_${userId}:1000`,
		userId,
		amountMicroUsd: -5_000_000,
		kind: "refund",
		reason: "Refund of a credit purchase",
		actor: "stripe:webhook",
		batchId: null,
		sourceRef: `pi_two_${userId}`,
	});
}

describe("readCreditHistory: what moved a person's balance", () => {
	let dir: string;
	let store: BillingStore;

	before(async () => {
		dir = mkdtempSync(join(tmpdir(), "credit-history-"));
		store = await openBilling(dir);
		await seedHistory(store, "alice");
		await tick();
		await grant(store, "alice", "cs_eur", 9_000_000, { currency: "eur" });
		await tick();
		await grant(store, "alice", "in_deposit", 5_000_000, { stripeObject: "invoice" });
		await seedHistory(store, "bob");
	});
	after(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("lists grants and signed adjustments, newest first, with the sign of the money", async () => {
		const view = await readCreditHistory(store, "alice", { limit: 50 });
		assert.equal(view.schema, "sophia.credit-history.v1");
		assert.equal(view.userId, "alice");
		assert.equal(view.nextCursor, null);
		assert.deepEqual(
			view.items.map((item) => [item.kind, item.amountMicroUsd]),
			[
				["monthly-deposit", 5_000_000],
				["adjustment", -5_000_000],
				["top-up", 10_000_000],
				["adjustment", 250_000],
				["top-up", 5_000_000],
			],
		);
		for (const item of view.items) assert.ok(item.ts > 0);
		const timestamps = view.items.map((item) => item.ts);
		assert.deepEqual(
			timestamps,
			[...timestamps].sort((a, b) => b - a),
			"newest first",
		);
	});

	it("shows a label a person can read and the recorded reason of an adjustment, and nothing internal", async () => {
		const view = await readCreditHistory(store, "alice", { limit: 50 });
		const refund = view.items.find((item) => item.amountMicroUsd === -5_000_000);
		assert.deepEqual(
			{ label: refund?.label, reason: refund?.reason, kind: refund?.kind },
			{ label: "Refund", reason: "Refund of a credit purchase", kind: "adjustment" },
		);
		const goodwill = view.items.find((item) => item.amountMicroUsd === 250_000);
		assert.deepEqual(
			{ label: goodwill?.label, reason: goodwill?.reason },
			{ label: "Credits added by Sophia", reason: "credits start" },
		);
		const topUp = view.items.find((item) => item.kind === "top-up" && item.amountMicroUsd === 5_000_000);
		assert.deepEqual({ label: topUp?.label, reason: topUp?.reason }, { label: "Credits added", reason: null });
		const serialized = JSON.stringify(view);
		const internal = [
			"cus_alice",
			"cs_one",
			"evt_",
			"pi_two",
			"script:goodwill-lift",
			"stripe:webhook",
			"credits-start",
		];
		for (const secret of internal) {
			assert.equal(serialized.includes(secret), false, `${secret} must not reach the person`);
		}
		assert.deepEqual(Object.keys(view.items[0]).sort(), ["amountMicroUsd", "id", "kind", "label", "reason", "ts"]);
	});

	it("item ids are opaque and stable", async () => {
		const first = await readCreditHistory(store, "alice", { limit: 50 });
		const second = await readCreditHistory(store, "alice", { limit: 50 });
		assert.deepEqual(
			first.items.map((item) => item.id),
			second.items.map((item) => item.id),
		);
		for (const item of first.items) assert.match(item.id, /^h_[0-9a-f]{20}$/);
		assert.equal(new Set(first.items.map((item) => item.id)).size, first.items.length);
	});

	it("hides a payment that never credited (a non-USD purchase is not a balance movement)", async () => {
		const view = await readCreditHistory(store, "alice", { limit: 50 });
		assert.equal(
			view.items.some((item) => item.amountMicroUsd === 9_000_000),
			false,
		);
	});

	it("is owner-scoped: one person never sees another's movements", async () => {
		const bob = await readCreditHistory(store, "bob", { limit: 50 });
		assert.equal(bob.items.length, 4);
		const stranger = await readCreditHistory(store, "nobody", { limit: 50 });
		assert.deepEqual(stranger.items, []);
		assert.equal(stranger.nextCursor, null);
	});

	it("pages with an opaque cursor and never repeats or skips an item", async () => {
		const all = await readCreditHistory(store, "bob", { limit: 50 });
		const first = await readCreditHistory(store, "bob", { limit: 3 });
		assert.equal(first.items.length, 3);
		assert.ok(first.nextCursor);
		const second = await readCreditHistory(store, "bob", { limit: 3, before: first.nextCursor });
		assert.equal(second.items.length, 1);
		assert.equal(second.nextCursor, null);
		assert.deepEqual(
			[...first.items, ...second.items].map((item) => item.id),
			all.items.map((item) => item.id),
		);
	});
});

describe("creditHistoryQuery: the only two knobs (the page size and the cursor)", () => {
	it("defaults to a page of 50 and accepts limit 1..200 and a cursor", () => {
		assert.deepEqual(creditHistoryQuery(new URLSearchParams()), { limit: 50, before: undefined });
		assert.deepEqual(creditHistoryQuery(new URLSearchParams("limit=200")), { limit: 200, before: undefined });
		assert.deepEqual(creditHistoryQuery(new URLSearchParams("limit=1&before=abc_DEF-123")), {
			limit: 1,
			before: "abc_DEF-123",
		});
	});

	it("refuses anything else", () => {
		const bads = [
			"limit=0",
			"limit=201",
			"limit=-1",
			"limit=abc",
			"limit=1.5",
			"limit=",
			"before=",
			"before=a b",
			"x=1",
		];
		for (const bad of bads) {
			assert.throws(() => creditHistoryQuery(new URLSearchParams(bad)), /history query/, bad);
		}
		assert.throws(() => creditHistoryQuery(new URLSearchParams(`before=${"a".repeat(600)}`)), /history query/);
	});

	it("takes the cursor as `after`, the name the gateway forwards and the SPA sends, with the contract `before` has", () => {
		assert.deepEqual(creditHistoryQuery(new URLSearchParams("after=abc_DEF-123")), {
			limit: 50,
			before: "abc_DEF-123",
		});
		assert.deepEqual(creditHistoryQuery(new URLSearchParams("limit=1&after=abc_DEF-123")), {
			limit: 1,
			before: "abc_DEF-123",
		});
		// The same validation as `before`: a cursor is 1 to 512 of [A-Za-z0-9_-], sent once.
		for (const bad of ["after=", "after=a b", "after=a%2Fb", `after=${"a".repeat(600)}`, "after=x&after=y"]) {
			assert.throws(() => creditHistoryQuery(new URLSearchParams(bad)), /history query/, bad);
		}
		// One cursor, one name: `before` is the same cursor under its earlier name, never beside `after`.
		assert.throws(() => creditHistoryQuery(new URLSearchParams("after=abc&before=abc")), /one cursor/);
		assert.throws(() => creditHistoryQuery(new URLSearchParams("before=abc&after=def")), /one cursor/);
	});

	it("still refuses the window the gateway documents (from, to): Choreograph's history has none, and nothing sends one", () => {
		for (const bad of ["from=1", "to=2", "after=abc&from=1", "limit=2&to=9"]) {
			assert.throws(() => creditHistoryQuery(new URLSearchParams(bad)), /unsupported parameter/, bad);
		}
	});

	it("a cursor that is not one of ours is refused by the read, not trusted", async () => {
		const dir = mkdtempSync(join(tmpdir(), "credit-history-cursor-"));
		const store = await openBilling(dir);
		try {
			await assert.rejects(readCreditHistory(store, "alice", { limit: 10, before: "not-a-cursor" }), /cursor/);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("GET /api/billing/credits/history over real HTTP", { concurrency: false }, () => {
	let rig: BillingRouteRig;
	before(async () => {
		rig = await startBillingRouteRig({ mode: "enforce" });
		await seedHistory(rig.billing, "alice");
		await seedHistory(rig.billing, "bob");
	});
	after(() => rig.stop());

	it("returns the signed-in person's history in the documented schema", async () => {
		const res = await httpJson(rig.baseUrl, "GET", "/api/billing/credits/history", { headers: rig.bearer("alice") });
		assert.equal(res.status, 200, res.text);
		const body = res.body as {
			schema: string;
			userId: string;
			items: Array<{ kind: string }>;
			nextCursor: string | null;
		};
		assert.equal(body.schema, "sophia.credit-history.v1");
		assert.equal(body.userId, "alice");
		assert.equal(body.items.length, 4);
		assert.equal(body.nextCursor, null);
	});

	it("is scoped to the bearer: bob's request never returns alice's rows", async () => {
		const res = await httpJson(rig.baseUrl, "GET", "/api/billing/credits/history", { headers: rig.bearer("bob") });
		assert.equal((res.body as { userId: string }).userId, "bob");
		const carol = await httpJson(rig.baseUrl, "GET", "/api/billing/credits/history", {
			headers: rig.bearer("carol"),
		});
		assert.deepEqual((carol.body as { items: unknown[] }).items, []);
	});

	it("pages through the query string", async () => {
		const first = await httpJson(rig.baseUrl, "GET", "/api/billing/credits/history?limit=3", {
			headers: rig.bearer("alice"),
		});
		const firstBody = first.body as { items: unknown[]; nextCursor: string | null };
		assert.equal(firstBody.items.length, 3);
		assert.ok(firstBody.nextCursor);
		const second = await httpJson(
			rig.baseUrl,
			"GET",
			`/api/billing/credits/history?limit=3&before=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
			{ headers: rig.bearer("alice") },
		);
		assert.equal((second.body as { items: unknown[] }).items.length, 1);
	});

	it("pages through `after`, the SPA's and the gateway's name for the cursor, to every item once and in `before`'s order", async () => {
		const get = (query: string) =>
			httpJson(rig.baseUrl, "GET", `/api/billing/credits/history${query}`, { headers: rig.bearer("alice") });
		const body = (res: { body: unknown }) => res.body as { items: Array<{ id: string }>; nextCursor: string | null };
		const all = body(await get("?limit=50")).items.map((item) => item.id);
		assert.equal(all.length, 4);
		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const res = await get(`?limit=1${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`);
			assert.equal(res.status, 200, res.text);
			const page = body(res);
			assert.equal(page.items.length, 1);
			seen.push(page.items[0].id);
			cursor = page.nextCursor;
			pages += 1;
		} while (cursor && pages < 10);
		assert.deepEqual(seen, all, "each item once, newest first");

		const first = body(await get("?limit=2"));
		assert.ok(first.nextCursor);
		const viaAfter = await get(`?limit=2&after=${encodeURIComponent(first.nextCursor ?? "")}`);
		const viaBefore = await get(`?limit=2&before=${encodeURIComponent(first.nextCursor ?? "")}`);
		assert.equal(viaAfter.status, 200, viaAfter.text);
		assert.deepEqual(viaAfter.body, viaBefore.body, "the two names are one cursor");
	});

	it("refuses the two cursor names together, and the gateway's window, each as 400 invalid_history_query", async () => {
		const first = await httpJson(rig.baseUrl, "GET", "/api/billing/credits/history?limit=1", {
			headers: rig.bearer("alice"),
		});
		const cursor = encodeURIComponent((first.body as { nextCursor: string }).nextCursor);
		for (const query of [`after=${cursor}&before=${cursor}`, "from=1", "to=2", `after=${cursor}&from=1`]) {
			const res = await httpJson(rig.baseUrl, "GET", `/api/billing/credits/history?${query}`, {
				headers: rig.bearer("alice"),
			});
			assert.equal(res.status, 400, query);
			assert.equal((res.body as { error: string }).error, "invalid_history_query");
		}
	});

	it("refuses a malformed query with 400 and a code", async () => {
		for (const query of ["limit=0", "limit=abc", "before=%20", "after=%20", "extra=1"]) {
			const res = await httpJson(rig.baseUrl, "GET", `/api/billing/credits/history?${query}`, {
				headers: rig.bearer("alice"),
			});
			assert.equal(res.status, 400, query);
			assert.equal((res.body as { error: string }).error, "invalid_history_query");
		}
	});

	it("is bearer-only like its siblings: no auth 401, an internal-service assertion 403, non-Bearer 400", async () => {
		const anonymous = await httpJson(rig.baseUrl, "GET", "/api/billing/credits/history");
		assert.equal(anonymous.status, 401);
		const service = await httpJson(rig.baseUrl, "GET", "/api/billing/credits/history", {
			headers: { "x-internal-service": "shared-secret", "x-user-id": "alice" },
		});
		assert.equal(service.status, 403);
		assert.equal((service.body as { error: string }).error, "billing reads are bearer-only");
		const basic = await httpJson(rig.baseUrl, "GET", "/api/billing/credits/history", {
			headers: { authorization: "Basic Zm9v" },
		});
		assert.equal(basic.status, 400);
	});
});

describe("the account views the gateway parses with deny_unknown_fields: the balance view only ever grows", () => {
	/** The five keys the deployed gateway reads: never renamed, never removed, never retyped. */
	const original = ["balanceMicroUsd", "floorMicroUsd", "initialized", "lifetimeUsageMicroUsd", "userId"];

	async function balanceView(mode: "observe" | "enforce", env: Record<string, string | undefined> = {}) {
		const rig = await startBillingRouteRig({ mode, env });
		try {
			const res = await httpJson(rig.baseUrl, "GET", "/api/billing/balance", { headers: rig.bearer("alice") });
			assert.equal(res.status, 200, res.text);
			return res.body as Record<string, unknown>;
		} finally {
			await rig.stop();
		}
	}

	it("keeps its five keys and gains feeBps and gateMode; across the flip the floor, the mode and the fee move, nothing else", async () => {
		const before = await balanceView("observe", { BILLING_FEE_BPS: undefined, CREDITS_START_DATE: undefined });
		const after = await balanceView("enforce", { BILLING_FEE_BPS: "2000", CREDITS_START_DATE: undefined });
		const expected = [...original, "feeBps", "gateMode"].sort();
		assert.deepEqual(Object.keys(before).sort(), expected);
		assert.deepEqual(Object.keys(after).sort(), expected);
		assert.equal(before.floorMicroUsd, -500_000);
		assert.equal(after.floorMicroUsd, 0);
		assert.deepEqual([before.feeBps, before.gateMode], [1500, "observe"]);
		assert.deepEqual([after.feeBps, after.gateMode], [2000, "enforce"]);
		assert.deepEqual(
			{ ...after, floorMicroUsd: before.floorMicroUsd, feeBps: before.feeBps, gateMode: before.gateMode },
			before,
		);
	});

	it("over the real route, creditsStartDate appears when CREDITS_START_DATE is set and is absent otherwise", async () => {
		const withDate = await balanceView("observe", { CREDITS_START_DATE: "2026-10-06" });
		assert.equal(withDate.creditsStartDate, "2026-10-06");
		assert.deepEqual(Object.keys(withDate).sort(), [...original, "creditsStartDate", "feeBps", "gateMode"].sort());
		const without = await balanceView("observe", { CREDITS_START_DATE: undefined });
		assert.equal("creditsStartDate" in without, false);
		const unreadable = await balanceView("observe", { CREDITS_START_DATE: "soon" });
		assert.equal("creditsStartDate" in unreadable, false, "an unreadable date is never shown");
	});
});
