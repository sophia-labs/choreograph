/**
 * Billing Phase 0 — usage-event ledger, REAL libSQL (NO MOCKS).
 *
 * Every test opens a real `file:` libSQL db in os.tmpdir() and exercises the
 * real BillingStore + real computeCost against real ProxyUsage-shaped inputs.
 * No stubs, no fakes — the whole slice is local (libSQL file + pure function),
 * so there is nothing to defer. Run via `tsx --test`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createClient } from "@libsql/client";
import { computeCost, PRICING_VERSION } from "../billing-pricing.js";
import { BillingStore, type UsageEventInput } from "../billing-store.js";

function tmpDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Build a real usage-event payload from a model + token counts, priced for real. */
function makeEvent(over: Partial<UsageEventInput> & { eventId: string }): UsageEventInput {
	const provider = over.provider ?? "openrouter";
	const model = over.model ?? "google/gemini-2.5-flash";
	const input = over.inputTokens ?? 1000;
	const output = over.outputTokens ?? 500;
	const cacheRead = over.cacheReadTokens ?? 200;
	const cacheWrite = over.cacheWriteTokens ?? 0;
	const cost = computeCost(model, { input, output, cacheRead, cacheWrite }, provider);
	return {
		eventId: over.eventId,
		ts: over.ts ?? Date.now(),
		userId: over.userId ?? "cognito-sub-A",
		graphId: over.graphId ?? "choreograph-2",
		sandboxId: over.sandboxId ?? "sbx_abcdef",
		template: over.template ?? "agent",
		provider,
		model,
		modelPriced: cost.modelPriced,
		reason: over.reason ?? "stop",
		inputTokens: input,
		outputTokens: output,
		cacheReadTokens: cacheRead,
		cacheWriteTokens: cacheWrite,
		totalTokens: over.totalTokens ?? input + output + cacheRead + cacheWrite,
		inputCostMicroUsd: cost.inputCostMicroUsd,
		outputCostMicroUsd: cost.outputCostMicroUsd,
		cacheReadCostMicroUsd: cost.cacheReadCostMicroUsd,
		cacheWriteCostMicroUsd: cost.cacheWriteCostMicroUsd,
		providerCostMicroUsd: cost.providerCostMicroUsd,
		markupMicroUsd: cost.markupMicroUsd,
		costMicroUsd: cost.totalCostMicroUsd,
		pricingVersion: PRICING_VERSION,
		pricedDefault: cost.pricedDefault,
		...over,
	};
}

describe("BillingStore (real file: libSQL)", () => {
	it("computes + persists a usage event; every token + integer-µUSD column round-trips", async () => {
		const dir = tmpDir("billing-test-");
		after(() => rmSync(dir, { recursive: true, force: true }));
		const store = new BillingStore(join(dir, "billing.sqlite"));
		await store.init();

		const e = makeEvent({ eventId: "req-roundtrip" });
		const inserted = await store.recordUsage(e);
		assert.equal(inserted, true, "first insert returns true");

		const row = await store.getEvent("req-roundtrip");
		assert.ok(row, "row persisted");
		// Tokens round-trip.
		assert.equal(row.inputTokens, e.inputTokens);
		assert.equal(row.outputTokens, e.outputTokens);
		assert.equal(row.cacheReadTokens, e.cacheReadTokens);
		assert.equal(row.cacheWriteTokens, e.cacheWriteTokens);
		assert.equal(row.totalTokens, e.totalTokens);
		// Integer µUSD columns round-trip.
		assert.equal(row.inputCostMicroUsd, e.inputCostMicroUsd);
		assert.equal(row.outputCostMicroUsd, e.outputCostMicroUsd);
		assert.equal(row.cacheReadCostMicroUsd, e.cacheReadCostMicroUsd);
		assert.equal(row.providerCostMicroUsd, e.providerCostMicroUsd);
		assert.equal(row.markupMicroUsd, e.markupMicroUsd);
		assert.equal(row.costMicroUsd, e.costMicroUsd);
		// The DB invariant: total === provider + markup.
		assert.equal(row.costMicroUsd, row.providerCostMicroUsd + row.markupMicroUsd);
		// Provenance + audit columns.
		assert.equal(row.userId, "cognito-sub-A");
		assert.equal(row.graphId, "choreograph-2");
		assert.equal(row.sandboxId, "sbx_abcdef");
		assert.equal(row.provider, "openrouter");
		assert.equal(row.model, "google/gemini-2.5-flash");
		assert.equal(row.modelPriced, "google/gemini-2.5-flash");
		assert.equal(row.pricingVersion, PRICING_VERSION);
		assert.equal(row.pricedDefault, false);
		assert.equal(row.kind, "usage_event");
		// Every value the DB stored is an integer (no floats reached it).
		for (const v of [
			row.inputCostMicroUsd,
			row.outputCostMicroUsd,
			row.cacheReadCostMicroUsd,
			row.cacheWriteCostMicroUsd,
			row.providerCostMicroUsd,
			row.markupMicroUsd,
			row.costMicroUsd,
		]) {
			assert.equal(Number.isInteger(v), true, "cost columns are integers");
		}
		store.close();
	});

	it("migrates a pre-provider ledger in place and preserves old rows as OpenRouter usage", async () => {
		const dir = tmpDir("billing-provider-migration-");
		after(() => rmSync(dir, { recursive: true, force: true }));
		const path = join(dir, "billing.sqlite");

		const original = new BillingStore(path);
		await original.init();
		await original.recordUsage(makeEvent({ eventId: "legacy-event" }));
		original.close();

		const legacy = createClient({ url: `file:${path}` });
		await legacy.execute("ALTER TABLE usage_events DROP COLUMN provider");
		legacy.close();

		const migrated = new BillingStore(path);
		await migrated.init();
		const row = await migrated.getEvent("legacy-event");
		assert.ok(row);
		assert.equal(row.provider, "openrouter");
		migrated.close();
	});

	it("migrates optional Agent Session/provider provenance and preserves non-Agent rows", async () => {
		const dir = tmpDir("billing-agent-provenance-migration-");
		after(() => rmSync(dir, { recursive: true, force: true }));
		const path = join(dir, "billing.sqlite");

		const original = new BillingStore(path);
		await original.init();
		await original.recordUsage(makeEvent({ eventId: "pre-agent-provenance" }));
		original.close();

		const legacy = createClient({ url: `file:${path}` });
		await legacy.execute("DROP INDEX idx_usage_agent_session_generation");
		await legacy.execute("DROP INDEX idx_usage_inference_operation");
		for (const column of [
			"session_id",
			"generation",
			"inference_operation_id",
			"request_id",
			"child_run_id",
			"allocation_id",
			"provider_reported_cost_micro_usd",
		]) {
			await legacy.execute(`ALTER TABLE usage_events DROP COLUMN ${column}`);
		}
		legacy.close();

		const migrated = new BillingStore(path);
		await migrated.init();
		const oldRow = await migrated.getEvent("pre-agent-provenance");
		assert.ok(oldRow);
		assert.equal(oldRow.sessionId, null);
		assert.equal(oldRow.generation, null);
		assert.equal(oldRow.inferenceOperationId, null);
		assert.equal(oldRow.requestId, null);
		assert.equal(oldRow.childRunId, null);
		assert.equal(oldRow.allocationId, null);
		assert.equal(oldRow.providerReportedCostMicroUsd, null);

		const inspected = createClient({ url: `file:${path}` });
		try {
			const columns = await inspected.execute("PRAGMA table_info(usage_events)");
			const names = new Set(columns.rows.map((row) => String(row.name)));
			for (const name of [
				"session_id",
				"generation",
				"inference_operation_id",
				"request_id",
				"child_run_id",
				"allocation_id",
				"provider_reported_cost_micro_usd",
			]) {
				assert.equal(names.has(name), true, `${name} was restored`);
			}
		} finally {
			inspected.close();
		}
		migrated.close();
	});

	it("round-trips Agent Session provenance while eventId remains the global first-write-wins key", async () => {
		const dir = tmpDir("billing-agent-provenance-");
		after(() => rmSync(dir, { recursive: true, force: true }));
		const store = new BillingStore(join(dir, "billing.sqlite"));
		await store.init();

		const first = makeEvent({
			eventId: "inference:session-a:3:req-7",
			sessionId: "session-a",
			generation: 3,
			inferenceOperationId: "inference:session-a:3:req-7",
			requestId: "req-7",
			childRunId: "child-run-2",
			allocationId: "allocation-2",
			providerReportedCostMicroUsd: 314,
		});
		const conflictingReplay = makeEvent({
			...first,
			sessionId: "session-forged",
			generation: 99,
			inferenceOperationId: "inference:forged:99:req-7",
			providerReportedCostMicroUsd: 999_999,
		});
		assert.equal(await store.recordUsage(first), true);
		assert.equal(await store.recordUsage(conflictingReplay), false);

		const row = await store.getEvent(first.eventId);
		assert.ok(row);
		assert.equal(row.sessionId, "session-a");
		assert.equal(row.generation, 3);
		assert.equal(row.inferenceOperationId, "inference:session-a:3:req-7");
		assert.equal(row.requestId, "req-7");
		assert.equal(row.childRunId, "child-run-2");
		assert.equal(row.allocationId, "allocation-2");
		assert.equal(row.providerReportedCostMicroUsd, 314);
		store.close();
	});

	it("is idempotent + immutable on duplicate event_id (first write wins, no overwrite)", async () => {
		const dir = tmpDir("billing-test-");
		after(() => rmSync(dir, { recursive: true, force: true }));
		const store = new BillingStore(join(dir, "billing.sqlite"));
		await store.init();

		const first = makeEvent({ eventId: "req-dup", inputTokens: 1000, outputTokens: 500 });
		// Second call: SAME eventId, DIFFERENT numbers — proves the first write is
		// preserved (immutable) and not overwritten.
		const second = makeEvent({ eventId: "req-dup", inputTokens: 999_999, outputTokens: 999_999 });

		assert.equal(await store.recordUsage(first), true, "first insert succeeds");
		assert.equal(await store.recordUsage(second), false, "duplicate is a silent no-op");

		// Exactly one row, and it equals the FIRST payload.
		const got = await store.getEvent("req-dup");
		assert.ok(got);
		assert.equal(got.inputTokens, 1000, "stored row is the FIRST write, not the second");
		assert.equal(got.outputTokens, 500);
		assert.equal(got.costMicroUsd, first.costMicroUsd);

		const sum = await store.sumByUser("cognito-sub-A", 0, Date.now() + 1);
		assert.equal(sum.n, 1, "duplicate did not create a second row");
		store.close();
	});

	it("SUM(cost) per user projects correctly; excludes other users + NULL-user rows", async () => {
		const dir = tmpDir("billing-test-");
		after(() => rmSync(dir, { recursive: true, force: true }));
		const store = new BillingStore(join(dir, "billing.sqlite"));
		await store.init();

		// User A: three events. User B: two events. One unattributed (NULL user).
		const aEvents = [
			makeEvent({ eventId: "a1", userId: "userA", inputTokens: 1000, outputTokens: 500 }),
			makeEvent({ eventId: "a2", userId: "userA", inputTokens: 2000, outputTokens: 1000 }),
			makeEvent({ eventId: "a3", userId: "userA", inputTokens: 100, outputTokens: 50 }),
		];
		const bEvents = [
			makeEvent({ eventId: "b1", userId: "userB", inputTokens: 5000, outputTokens: 2500 }),
			makeEvent({ eventId: "b2", userId: "userB", inputTokens: 10, outputTokens: 5 }),
		];
		const anon = makeEvent({ eventId: "anon1", userId: null, inputTokens: 99_999, outputTokens: 99_999 });

		for (const e of [...aEvents, ...bEvents, anon]) {
			assert.equal(await store.recordUsage(e), true);
		}

		const expectedA = aEvents.reduce((acc, e) => acc + e.costMicroUsd, 0);
		const expectedB = bEvents.reduce((acc, e) => acc + e.costMicroUsd, 0);

		const sumA = await store.sumByUser("userA", 0, Date.now() + 1);
		assert.equal(sumA.n, 3, "userA has exactly 3 rows");
		assert.equal(sumA.totalMicroUsd, expectedA, "userA SUM matches exact integer sum");

		const sumB = await store.sumByUser("userB", 0, Date.now() + 1);
		assert.equal(sumB.n, 2);
		assert.equal(sumB.totalMicroUsd, expectedB);

		// The NULL-user (unattributed) row is excluded from every per-user SUM.
		assert.notEqual(sumA.totalMicroUsd, expectedA + anon.costMicroUsd);
		const sumNobody = await store.sumByUser("userC", 0, Date.now() + 1);
		assert.equal(sumNobody.n, 0);
		assert.equal(sumNobody.totalMicroUsd, 0);
		store.close();
	});

	it("sumByUser windows on [fromTs, toTs) — excludes rows outside the time range", async () => {
		const dir = tmpDir("billing-test-");
		after(() => rmSync(dir, { recursive: true, force: true }));
		const store = new BillingStore(join(dir, "billing.sqlite"));
		await store.init();

		await store.recordUsage(makeEvent({ eventId: "t100", userId: "u", ts: 100 }));
		await store.recordUsage(makeEvent({ eventId: "t200", userId: "u", ts: 200 }));
		await store.recordUsage(makeEvent({ eventId: "t300", userId: "u", ts: 300 }));

		// Window [150, 300): includes ts=200, excludes ts=100 (below) and ts=300 (toTs exclusive).
		const win = await store.sumByUser("u", 150, 300);
		assert.equal(win.n, 1, "only ts=200 is in [150,300)");
		store.close();
	});

	it("snapshotToS3 no-ops + returns null when BILLING_DB_S3_URL is unset (INFRA PAUSE)", async () => {
		const prev = process.env.BILLING_DB_S3_URL;
		delete process.env.BILLING_DB_S3_URL;
		try {
			const dir = tmpDir("billing-test-");
			after(() => rmSync(dir, { recursive: true, force: true }));
			const store = new BillingStore(join(dir, "billing.sqlite"));
			await store.init();
			const result = await store.snapshotToS3();
			assert.equal(result, null, "no-op when S3 not configured — never touches the network");
			store.close();
		} finally {
			if (prev !== undefined) process.env.BILLING_DB_S3_URL = prev;
		}
	});

	it("FAIL_SOFT: the wire pattern's .catch swallows a real recordUsage failure (no throw)", async () => {
		// Real failure condition (not a mock): pass an unsupported libSQL bind value.
		// The wire point wraps recordUsage in `.catch`, so a billing failure must never
		// escape onto the LLM response path.
		const dir = tmpDir("billing-failsoft-");
		after(() => rmSync(dir, { recursive: true, force: true }));
		const store = new BillingStore(join(dir, "billing.sqlite"));
		await store.init();
		// A normal write succeeds first — proves the store was genuinely healthy.
		assert.equal(await store.recordUsage(makeEvent({ eventId: "ok-before-close" })), true);
		const invalid = makeEvent({ eventId: "req-failsoft" });
		(invalid as { model: unknown }).model = {};

		let threw = false;
		let caught: unknown;
		// EXACT replication of the wire point: void + non-awaited + .catch.
		await new Promise<void>((resolve) => {
			try {
				void store
					.recordUsage(invalid)
					.then(() => resolve())
					.catch((err) => {
						caught = err; // swallowed here, exactly as spawner.ts does
						resolve();
					});
			} catch (err) {
				// A synchronous throw from recordUsage would ALSO be a wire hazard;
				// assert it does not happen (the store returns a rejected promise).
				threw = true;
				caught = err;
				resolve();
			}
		});
		assert.equal(threw, false, "recordUsage must not throw synchronously onto the response path");
		assert.ok(caught instanceof Error, "the real failure surfaced as a catchable rejection, swallowed by .catch");
		store.close();
	});
});
