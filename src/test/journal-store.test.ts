import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { JournalStore } from "../workflow/journal-store.js";

function tmpDbPath(): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), "journal-test-"));
	return { dir, path: join(dir, "journal.sqlite") };
}

describe("JournalStore", () => {
	it("assigns gap-free, dup-free seqs under 50 CONCURRENT async appends (atomic-seq invariant)", async () => {
		const { dir, path } = tmpDbPath();
		after(() => rmSync(dir, { recursive: true, force: true }));

		const journal = new JournalStore(path);
		await journal.init();
		await journal.createRun({
			run_id: "run-concurrent",
			workflow_name: "wf",
			graph_id: "g1",
			owner_user_id: "u1",
			started_at: 1000,
		});

		// Drive the REAL async @libsql path with genuine concurrency. A
		// read-then-write straddling an await would dup/skip seqs here.
		const seqs = await Promise.all(
			Array.from({ length: 50 }, (_, i) =>
				journal.appendEvent("run-concurrent", { type: "tool_call", label: `n${i}`, payload: { i } }),
			),
		);

		const sorted = [...seqs].sort((a, b) => a - b);
		assert.deepEqual(
			sorted,
			Array.from({ length: 50 }, (_, i) => i),
			"50 concurrent appends must yield seqs 0..49 with no gaps or dupes",
		);
		assert.equal(new Set(seqs).size, 50, "no duplicate seqs");

		const { events } = await journal.readRun("run-concurrent");
		assert.equal(events.length, 50);
		// Stored rows are seq-ordered and contiguous.
		assert.deepEqual(
			events.map((e) => e.seq),
			Array.from({ length: 50 }, (_, i) => i),
		);
		journal.close();
	});

	it("round-trips the header and events; reopening the file recovers rows", async () => {
		const { dir, path } = tmpDbPath();
		after(() => rmSync(dir, { recursive: true, force: true }));

		const journal = new JournalStore(path);
		await journal.init();
		await journal.createRun({
			run_id: "run-rt",
			workflow_name: "graph-survey-synthesize",
			graph_id: "g1",
			owner_user_id: "owner-7",
			started_at: 5000,
			payload: { question: "what?" },
		});
		await journal.appendEvent("run-rt", { type: "run_started", ts: 5000 });
		await journal.appendEvent("run-rt", {
			type: "node_queued",
			ts: 5001,
			sandbox_id: "sb-a",
			label: "map:d1",
			phase_index: 1,
			payload: { model: "cheap" },
		});
		await journal.appendEvent("run-rt", {
			type: "node_done",
			ts: 5100,
			sandbox_id: "sb-a",
			label: "map:d1",
			phase_index: 1,
			payload: { tokens: 42, turns: 2, tool_calls: 1, output: "ok" },
		});
		await journal.finishRun("run-rt", {
			status: "completed",
			ended_at: 5200,
			duration_ms: 200,
			agent_count: 1,
			total_tokens: 42,
			synthesis_doc_id: "wf-synthesis-run-rt",
		});
		journal.close();

		// Reopen the SAME file — rows must survive across a fresh client.
		const reopened = new JournalStore(path);
		await reopened.init();
		const { header, events } = await reopened.readRun("run-rt");

		assert.ok(header);
		assert.equal(header.run_id, "run-rt");
		assert.equal(header.workflow_name, "graph-survey-synthesize");
		assert.equal(header.owner_user_id, "owner-7");
		assert.equal(header.status, "completed");
		assert.equal(header.started_at, 5000);
		assert.equal(header.ended_at, 5200);
		assert.equal(header.duration_ms, 200);
		assert.equal(header.agent_count, 1);
		assert.equal(header.total_tokens, 42);
		assert.equal(header.synthesis_doc_id, "wf-synthesis-run-rt");
		assert.deepEqual(header.payload, { question: "what?" });

		assert.equal(events.length, 3);
		assert.deepEqual(
			events.map((e) => e.type),
			["run_started", "node_queued", "node_done"],
		);
		const done = events[2];
		assert.equal(done.sandbox_id, "sb-a");
		assert.equal(done.label, "map:d1");
		assert.equal(done.phase_index, 1);
		assert.deepEqual(done.payload, { tokens: 42, turns: 2, tool_calls: 1, output: "ok" });
		reopened.close();
	});

	it("isolates seqs per run_id (no cross-run interference)", async () => {
		const { dir, path } = tmpDbPath();
		after(() => rmSync(dir, { recursive: true, force: true }));

		const journal = new JournalStore(path);
		await journal.init();
		for (const r of ["ra", "rb"]) {
			await journal.createRun({
				run_id: r,
				workflow_name: "wf",
				graph_id: "g",
				owner_user_id: "u",
				started_at: 0,
			});
		}
		const a0 = await journal.appendEvent("ra", { type: "run_started" });
		const b0 = await journal.appendEvent("rb", { type: "run_started" });
		const a1 = await journal.appendEvent("ra", { type: "run_done" });
		assert.deepEqual([a0, a1], [0, 1]);
		assert.equal(b0, 0, "rb seqs start at 0 independently of ra");
		journal.close();
	});

	it("snapshotToS3 is a no-op (returns null) when S3 is not configured — never touches the network", async () => {
		const { dir, path } = tmpDbPath();
		after(() => rmSync(dir, { recursive: true, force: true }));
		const journal = new JournalStore(path);
		await journal.init();
		const result = await journal.snapshotToS3();
		assert.equal(result, null);
		journal.close();
	});

	// ── Substrate concurrency-hardening (post-migration) ─────────────────────

	it("init sets WAL on the journal db (substrate base pragmas applied)", async () => {
		const { dir, path } = tmpDbPath();
		after(() => rmSync(dir, { recursive: true, force: true }));
		const journal = new JournalStore(path);
		await journal.init();
		// Access the inherited protected db via index to assert the pragma.
		const res = await (
			journal as unknown as { db: { execute: (s: string) => Promise<{ rows: { journal_mode?: unknown }[] }> } }
		).db.execute("PRAGMA journal_mode");
		assert.equal(String(res.rows[0]?.journal_mode).toLowerCase(), "wal");
		journal.close();
	});

	it("CONCURRENCY: same-run append burst lands zero SQLITE_BUSY (mixed createRun + appendEvent)", async () => {
		const { dir, path } = tmpDbPath();
		after(() => rmSync(dir, { recursive: true, force: true }));
		const journal = new JournalStore(path);
		await journal.init();
		await journal.createRun({
			run_id: "run-busy",
			workflow_name: "wf",
			graph_id: "g1",
			owner_user_id: "u1",
			started_at: 1,
		});
		// Fire 40 same-run appends concurrently AND a finishRun update in the mix —
		// the serialized chain must absorb all of it with no SQLITE_BUSY thrown.
		const ops: Promise<unknown>[] = [];
		for (let i = 0; i < 40; i++) {
			ops.push(journal.appendEvent("run-busy", { type: "tool_call", label: `n${i}` }));
		}
		ops.push(
			journal.finishRun("run-busy", {
				status: "completed",
				ended_at: 2,
				duration_ms: 1,
				agent_count: 1,
				total_tokens: 0,
			}),
		);
		await assert.doesNotReject(Promise.all(ops), "no SQLITE_BUSY under same-run concurrent appends + finishRun");
		const { events, header } = await journal.readRun("run-busy");
		assert.equal(events.length, 40, "all 40 events landed");
		assert.deepEqual(
			events.map((e) => e.seq),
			Array.from({ length: 40 }, (_, i) => i),
			"seqs are contiguous 0..39 (no gaps/dupes)",
		);
		assert.equal(header?.status, "completed", "finishRun update applied");
		journal.close();
	});
});
