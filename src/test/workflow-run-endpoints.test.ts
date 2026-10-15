import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { JournalStore } from "../workflow/journal-store.js";
import { serializeAgentRunProvenance, serializeRunStartedProvenance } from "../workflow/provenance.js";
import {
	listRunsProjected,
	readRunProjected,
	resolveSinceCursor,
	startRunSseStream,
} from "../workflow/run-endpoints.js";
import type { AgentNodeResult, RunRecord } from "../workflow/types.js";
import { REQUIRED_RUN_PREDICATES } from "../workflow/vocab.js";

function tmpJournal(): { journal: JournalStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "run-endpoints-test-"));
	const journal = new JournalStore(join(dir, "journal.sqlite"));
	return { journal, dir };
}

/** Seed a run header + a fixed event log so the read paths have data. */
async function seedRun(
	journal: JournalStore,
	opts: { runId: string; owner: string; status: "running" | "completed"; startedAt: number },
): Promise<void> {
	await journal.createRun({
		run_id: opts.runId,
		workflow_name: "graph-survey-synthesize",
		graph_id: "g1",
		owner_user_id: opts.owner,
		status: opts.status,
		started_at: opts.startedAt,
	});
	await journal.appendEvent(opts.runId, { type: "run_started", ts: opts.startedAt });
	await journal.appendEvent(opts.runId, {
		type: "node_queued",
		ts: opts.startedAt + 1,
		sandbox_id: "sb-a",
		label: "map:d1",
		phase_index: 1,
	});
	await journal.appendEvent(opts.runId, {
		type: "node_done",
		ts: opts.startedAt + 2,
		sandbox_id: "sb-a",
		label: "map:d1",
		phase_index: 1,
		payload: { tokens: 10, turns: 1, tool_calls: 0, output: "ok" },
	});
	if (opts.status === "completed") {
		await journal.appendEvent(opts.runId, { type: "run_done", ts: opts.startedAt + 3 });
		await journal.finishRun(opts.runId, {
			status: "completed",
			ended_at: opts.startedAt + 3,
			duration_ms: 3,
			agent_count: 1,
			total_tokens: 10,
		});
	}
}

describe("run-endpoints — run-list + run-detail", () => {
	it("listRunsProjected scopes to owner, filters by status/since, newest-first", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();

		await seedRun(journal, { runId: "r-old", owner: "u1", status: "completed", startedAt: 1000 });
		await seedRun(journal, { runId: "r-new", owner: "u1", status: "running", startedAt: 3000 });
		await seedRun(journal, { runId: "r-other", owner: "u2", status: "completed", startedAt: 2000 });

		// Owner scope: u1 sees only its two runs, newest-first.
		const u1 = await listRunsProjected(journal, "u1", {});
		assert.deepEqual(
			u1.map((r) => r.runId),
			["r-new", "r-old"],
		);
		assert.ok(!u1.some((r) => r.runId === "r-other"), "must not leak other owners' runs");

		// status filter.
		const running = await listRunsProjected(journal, "u1", { status: "running" });
		assert.deepEqual(
			running.map((r) => r.runId),
			["r-new"],
		);

		// since filter (started_at >= 2000) excludes r-old.
		const recent = await listRunsProjected(journal, "u1", { since: 2000 });
		assert.deepEqual(
			recent.map((r) => r.runId),
			["r-new"],
		);

		// limit caps the page.
		const capped = await listRunsProjected(journal, "u1", { limit: 1 });
		assert.equal(capped.length, 1);
		assert.equal(capped[0].runId, "r-new");
		journal.close();
	});

	it("readRunProjected returns header+events for the owner, null for a foreign/missing run", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();
		await seedRun(journal, { runId: "r1", owner: "u1", status: "completed", startedAt: 1000 });

		const ok = await readRunProjected(journal, "r1", "u1");
		assert.ok(ok);
		assert.equal(ok.run.runId, "r1");
		assert.equal(ok.run.status, "completed");
		assert.deepEqual(
			ok.events.map((e) => e.type),
			["run_started", "node_queued", "node_done", "run_done"],
		);
		// seq is the resume cursor and is contiguous from 0.
		assert.deepEqual(
			ok.events.map((e) => e.seq),
			[0, 1, 2, 3],
		);

		assert.equal(await readRunProjected(journal, "r1", "u2"), null, "foreign owner → null (404)");
		assert.equal(await readRunProjected(journal, "missing", "u1"), null, "missing run → null (404)");
		journal.close();
	});
});

describe("run-endpoints — JournalStore.listEventsAfter (SSE cursor)", () => {
	it("returns only events with seq > cursor, in order; -1 returns the whole log", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();
		await seedRun(journal, { runId: "r1", owner: "u1", status: "completed", startedAt: 1000 });

		const all = await journal.listEventsAfter("r1", -1);
		assert.deepEqual(
			all.map((e) => e.seq),
			[0, 1, 2, 3],
		);

		const afterFirst = await journal.listEventsAfter("r1", 0);
		assert.deepEqual(
			afterFirst.map((e) => e.seq),
			[1, 2, 3],
		);

		const tail = await journal.listEventsAfter("r1", 2);
		assert.deepEqual(
			tail.map((e) => e.seq),
			[3],
		);

		assert.deepEqual(await journal.listEventsAfter("r1", 3), [], "cursor at last seq → empty");
		journal.close();
	});
});

describe("run-endpoints — resolveSinceCursor", () => {
	it("?since wins, else Last-Event-ID, else -1", () => {
		assert.equal(resolveSinceCursor("5", "9"), 5, "since query wins over header");
		assert.equal(resolveSinceCursor(null, "9"), 9, "falls back to Last-Event-ID");
		assert.equal(resolveSinceCursor(null, undefined), -1, "absent → from the beginning");
		assert.equal(resolveSinceCursor("garbage", "7"), 7, "garbage since falls through to header");
		assert.equal(resolveSinceCursor("0", undefined), 0, "since=0 is honored (first seq is 0)");
	});
});

// ─── A minimal fake ServerResponse/IncomingMessage for the SSE smoke test ─────

interface FakeResponse extends EventEmitter {
	chunks: string[];
	ended: boolean;
	writableNeedDrain: boolean;
	statusCode?: number;
	headers?: Record<string, string>;
	writeHead(code: number, headers: Record<string, string>): void;
	write(chunk: string): boolean;
	end(): void;
	setTimeout(ms: number): void;
}

function fakeResponse(): FakeResponse {
	const emitter = new EventEmitter() as FakeResponse;
	emitter.chunks = [];
	emitter.ended = false;
	emitter.writableNeedDrain = false;
	emitter.writeHead = (code, headers) => {
		emitter.statusCode = code;
		emitter.headers = headers;
	};
	emitter.write = (chunk) => {
		emitter.chunks.push(chunk);
		return true;
	};
	emitter.end = () => {
		emitter.ended = true;
	};
	emitter.setTimeout = () => {};
	return emitter;
}

describe("run-endpoints — startRunSseStream", () => {
	it("streams journaled events as SSE (event: wf:<type>, id: <seq>) and closes on terminal", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();
		await seedRun(journal, { runId: "r1", owner: "u1", status: "completed", startedAt: 1000 });

		const req = new EventEmitter() as unknown as IncomingMessage;
		const res = fakeResponse();
		startRunSseStream(req, res as unknown as ServerResponse, journal, "r1", -1);

		// The first tick fires synchronously-ish; poll until the stream closes
		// (the run is already terminal, so it should close on the first tick).
		const deadline = Date.now() + 5000;
		while (!res.ended && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 20));
		}
		assert.ok(res.ended, "stream must close once the run is terminal");

		const body = res.chunks.join("");
		// Each frozen event-type lands as event: wf:<type> with its seq as id.
		assert.match(body, /event: wf:run_started\nid: 0\n/);
		assert.match(body, /event: wf:node_queued\nid: 1\n/);
		assert.match(body, /event: wf:node_done\nid: 2\n/);
		assert.match(body, /event: wf:run_done\nid: 3\n/);
		// Terminal close frame.
		assert.match(body, /event: run:closed\n/);
		assert.match(body, /"status":"completed"/);
		journal.close();
	});

	it("resumes from a cursor — since=1 omits seq 0 and 1", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();
		await seedRun(journal, { runId: "r1", owner: "u1", status: "completed", startedAt: 1000 });

		const req = new EventEmitter() as unknown as IncomingMessage;
		const res = fakeResponse();
		startRunSseStream(req, res as unknown as ServerResponse, journal, "r1", 1);

		const deadline = Date.now() + 5000;
		while (!res.ended && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 20));
		}
		assert.ok(res.ended);
		const body = res.chunks.join("");
		assert.doesNotMatch(body, /id: 0\n/, "seq 0 must be skipped");
		assert.doesNotMatch(body, /id: 1\n/, "seq 1 (the cursor) must be skipped");
		assert.match(body, /id: 2\n/);
		assert.match(body, /id: 3\n/);
		journal.close();
	});
});

// ─── Incremental provenance serializers (frozen-vocab safety) ─────────────────

function fixtureRun(over: Partial<RunRecord> = {}): RunRecord {
	return {
		runId: "wfr-test-1",
		workflowName: "graph-survey-synthesize",
		workflowUri: "urn:sophia:wf:graph-survey-synthesize",
		status: "stopped",
		startedAt: 1_781_773_331_000,
		endedAt: 1_781_773_331_000,
		durationMs: 0,
		agentCount: 0,
		totalTokens: 0,
		agents: [],
		...over,
	};
}

function fixtureAgent(over: Partial<AgentNodeResult> = {}): AgentNodeResult {
	return {
		label: "map:d1",
		phaseIndex: 1,
		state: "done",
		output: "ok",
		model: "mistralai/mistral-nemo",
		turns: 2,
		toolCalls: 1,
		tokens: 321,
		queuedAt: 1_781_773_331_000,
		startedAt: 1_781_773_331_450,
		durationMs: 900,
		agentType: "graph-surveyor",
		...over,
	};
}

describe("incremental provenance — frozen-vocab safe", () => {
	it("serializeRunStartedProvenance emits a wf:Run only, all required run predicates, no agentRun/forbidden drift", () => {
		const sparql = serializeRunStartedProvenance(fixtureRun());
		assert.match(sparql, /INSERT DATA/);
		assert.match(sparql, /a wf:Run, prov:Activity/);
		for (const p of REQUIRED_RUN_PREDICATES) {
			assert.ok(sparql.includes(`${p} `), `must include run predicate ${p}`);
		}
		// No agent rows in the run_started emit.
		assert.doesNotMatch(sparql, /a wf:AgentRun/);
		// Frozen-vocab: the v0.1 `wf:run` drift must never appear; no capability
		// / AgentNode predicates (those would break render_class_triples).
		assert.doesNotMatch(sparql, /\bwf:run\b/);
		assert.doesNotMatch(sparql, /wf:AgentNode|wf:capability|wf:capabilities/);
	});

	it("serializeAgentRunProvenance emits one wf:AgentRun, partOfRun wired to the run, frozen-vocab safe", () => {
		const sparql = serializeAgentRunProvenance("wfr-test-1", fixtureAgent());
		assert.match(sparql, /INSERT DATA/);
		assert.match(sparql, /a wf:AgentRun/);
		assert.match(sparql, /wf:partOfRun <urn:sophia:wf-run:wfr-test-1>/);
		// Exactly one agent subject (no run row).
		assert.doesNotMatch(sparql, /a wf:Run\b/);
		assert.doesNotMatch(sparql, /\bwf:run\b/);
		assert.doesNotMatch(sparql, /wf:AgentNode|wf:capability/);
	});
});
