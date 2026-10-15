/**
 * `gate_events` and `gate_daily_counts` (Sobremesa, E §4.4.3) — REAL libSQL, NO MOCKS.
 *
 * The credit gate decides in both modes and records what it decided, so `observe` is
 * a dry run that can be read afterwards. Both tables live in `billing.sqlite`, which
 * already snapshots to S3 every 15 minutes: the dry run is readable without box access.
 *
 * RUN:  npx tsx --test src/test/billing-gate-events.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createClient } from "@libsql/client";
import { BillingStore, GATE_DECISIONS, GATE_DOORS, type GateEventInput } from "../billing-store.js";

async function freshStore(prefix = "gate-events-"): Promise<{ store: BillingStore; dir: string }> {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	after(() => rmSync(dir, { recursive: true, force: true }));
	const store = new BillingStore(join(dir, "billing.sqlite"));
	await store.init();
	after(() => store.close());
	return { store, dir };
}

function event(over: Partial<GateEventInput> = {}): GateEventInput {
	return {
		ts: 1_700_000_000_000,
		userId: "user-a",
		mode: "observe",
		door: "ingress.invocation",
		decision: "would_block",
		model: "google/gemini-2.5-flash",
		balanceMicroUsd: 3_800,
		requiredMicroUsd: 6_168,
		reason: "available=3800 holds=0",
		...over,
	};
}

describe("gate_events: an append-only record of every non-trivial gate decision", () => {
	it("names the doors and decisions the design records", () => {
		assert.deepEqual([...GATE_DOORS], ["ingress.invocation", "ingress.command", "call", "evaluator"]);
		assert.deepEqual(
			[...GATE_DECISIONS],
			[
				"would_block",
				"block",
				"would_clamp",
				"clamp",
				"model_unpriced",
				"fail_open",
				"exempt",
				"provider_unavailable",
			],
		);
	});

	it("appends a row and reads every field back", async () => {
		const { store } = await freshStore();
		const id = await store.recordGateEvent(event());
		assert.equal(typeof id, "number");
		const rows = await store.listGateEvents();
		assert.equal(rows.length, 1);
		assert.deepEqual(rows[0], { id, ...event() });
	});

	it("keeps nulls: an unattributed decision with no balance and no model is still a row", async () => {
		const { store } = await freshStore();
		await store.recordGateEvent(
			event({ userId: null, model: null, balanceMicroUsd: null, requiredMicroUsd: null, reason: null }),
		);
		const [row] = await store.listGateEvents();
		assert.equal(row.userId, null);
		assert.equal(row.model, null);
		assert.equal(row.balanceMicroUsd, null);
		assert.equal(row.requiredMicroUsd, null);
		assert.equal(row.reason, null);
	});

	it("is append-only: identical events are separate rows, ids only grow, earlier rows never change", async () => {
		const { store } = await freshStore();
		const first = await store.recordGateEvent(event());
		const snapshot = (await store.listGateEvents())[0];
		const second = await store.recordGateEvent(event());
		const third = await store.recordGateEvent(event({ decision: "block", mode: "enforce" }));
		assert.ok(first < second && second < third);
		const rows = await store.listGateEvents();
		assert.equal(rows.length, 3);
		assert.deepEqual(
			rows.find((r) => r.id === first),
			snapshot,
			"a later write never rewrites an earlier row",
		);
		// No mutation surface on the store: nothing that updates or deletes gate rows.
		const methods = Object.getOwnPropertyNames(BillingStore.prototype);
		assert.deepEqual(
			methods.filter((name) => /gate/i.test(name) && /^(update|delete|remove|purge|clear|set)/i.test(name)),
			[],
		);
	});

	it("refuses an unknown mode, door or decision instead of writing a row nothing can interpret", async () => {
		const { store } = await freshStore();
		await assert.rejects(store.recordGateEvent(event({ decision: "allow" as never })), /decision/);
		await assert.rejects(store.recordGateEvent(event({ door: "lobby" as never })), /door/);
		await assert.rejects(store.recordGateEvent(event({ mode: "dry" as never })), /mode/);
		assert.deepEqual(await store.listGateEvents(), []);
	});

	it("rejects non-integer money and bounds the free-text reason", async () => {
		const { store } = await freshStore();
		await assert.rejects(store.recordGateEvent(event({ balanceMicroUsd: 1.5 })), /integer/);
		await assert.rejects(store.recordGateEvent(event({ requiredMicroUsd: Number.NaN })), /integer/);
		await store.recordGateEvent(event({ reason: "x".repeat(2_000) }));
		const [row] = await store.listGateEvents();
		assert.equal(row.reason?.length, 500);
	});

	it("filters by time, user and decision, newest first, with a limit", async () => {
		const { store } = await freshStore();
		await store.recordGateEvent(event({ ts: 100, userId: "a", decision: "would_block" }));
		await store.recordGateEvent(event({ ts: 200, userId: "b", decision: "would_clamp" }));
		await store.recordGateEvent(event({ ts: 300, userId: "a", decision: "would_clamp" }));
		await store.recordGateEvent(event({ ts: 400, userId: "a", decision: "fail_open" }));

		assert.deepEqual(
			(await store.listGateEvents()).map((r) => r.ts),
			[400, 300, 200, 100],
			"newest first",
		);
		assert.deepEqual(
			(await store.listGateEvents({ sinceTs: 250 })).map((r) => r.ts),
			[400, 300],
		);
		assert.deepEqual(
			(await store.listGateEvents({ userId: "a" })).map((r) => r.ts),
			[400, 300, 100],
		);
		assert.deepEqual(
			(await store.listGateEvents({ decision: "would_clamp" })).map((r) => r.ts),
			[300, 200],
		);
		assert.deepEqual(
			(await store.listGateEvents({ limit: 2 })).map((r) => r.ts),
			[400, 300],
		);
	});

	it("survives in a snapshot: the dry run is readable from the file the S3 snapshot ships", async () => {
		const { store, dir } = await freshStore();
		await store.recordGateEvent(event({ ts: 1, decision: "would_block" }));
		await store.recordGateEvent(event({ ts: 2, decision: "would_clamp" }));
		await store.bumpGateCounters([{ day: "2026-09-29", mode: "observe", door: "call", decision: "allow", n: 41 }]);
		const snapshotPath = join(dir, "snapshot.sqlite");
		await store.snapshotToFile(snapshotPath);

		const reader = createClient({ url: `file:${snapshotPath}` });
		try {
			const events = await reader.execute("SELECT decision FROM gate_events ORDER BY id");
			assert.deepEqual(
				events.rows.map((r) => r.decision),
				["would_block", "would_clamp"],
			);
			const counts = await reader.execute("SELECT n FROM gate_daily_counts WHERE decision = 'allow'");
			assert.equal(Number(counts.rows[0]?.n), 41);
		} finally {
			reader.close();
		}
	});

	it("re-opening the same file keeps the rows (init is idempotent, nothing is dropped)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gate-events-reopen-"));
		after(() => rmSync(dir, { recursive: true, force: true }));
		const path = join(dir, "billing.sqlite");
		const first = new BillingStore(path);
		await first.init();
		await first.recordGateEvent(event());
		first.close();
		const second = new BillingStore(path);
		await second.init();
		try {
			assert.equal((await second.listGateEvents()).length, 1);
		} finally {
			second.close();
		}
	});
});

describe("gate_daily_counts: one counter row per day for the plain allows", () => {
	it("adds up deltas per (day, mode, door, decision) and keeps keys apart", async () => {
		const { store } = await freshStore();
		await store.bumpGateCounters([
			{ day: "2026-09-29", mode: "observe", door: "ingress.invocation", decision: "allow", n: 3 },
			{ day: "2026-09-29", mode: "observe", door: "call", decision: "allow", n: 10 },
		]);
		await store.bumpGateCounters([
			{ day: "2026-09-29", mode: "observe", door: "ingress.invocation", decision: "allow", n: 4 },
			{ day: "2026-09-30", mode: "observe", door: "ingress.invocation", decision: "allow", n: 1 },
			{ day: "2026-09-30", mode: "enforce", door: "ingress.invocation", decision: "allow", n: 2 },
		]);
		const all = await store.gateDailyCounts();
		const key = (r: { day: string; mode: string; door: string }) => `${r.day}/${r.mode}/${r.door}`;
		const byKey = new Map(all.map((r) => [key(r), r.n]));
		assert.equal(byKey.get("2026-09-29/observe/ingress.invocation"), 7);
		assert.equal(byKey.get("2026-09-29/observe/call"), 10);
		assert.equal(byKey.get("2026-09-30/observe/ingress.invocation"), 1);
		assert.equal(byKey.get("2026-09-30/enforce/ingress.invocation"), 2);
		assert.equal(all.length, 4);
		assert.deepEqual((await store.gateDailyCounts({ day: "2026-09-30" })).map((r) => r.mode).sort(), [
			"enforce",
			"observe",
		]);
	});

	it("ignores an empty batch, refuses a malformed day or a non-positive count", async () => {
		const { store } = await freshStore();
		await store.bumpGateCounters([]);
		assert.deepEqual(await store.gateDailyCounts(), []);
		await assert.rejects(
			store.bumpGateCounters([{ day: "yesterday", mode: "observe", door: "call", decision: "allow", n: 1 }]),
			/day/,
		);
		await assert.rejects(
			store.bumpGateCounters([{ day: "2026-09-29", mode: "observe", door: "call", decision: "allow", n: 0 }]),
			/count/,
		);
	});
});
