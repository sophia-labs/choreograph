/**
 * Contract A run-telemetry tests:
 *
 * 1. Event projection (journal RunEventType → Contract A TelemetryEventType).
 * 2. RunTelemetryEmitter: journal.appendEvent notifies subscribers synchronously.
 * 3. Journal listEventsSince for replay-by-seq.
 * 4. SSE endpoint: replay past events then tail live; ?since=N resume; auth via ?token=.
 * 5. Poll-since-seq: JSON snapshot with nextSince cursor.
 * 6. phase_entered / phase_exited / log journal events emitted correctly.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { routeRequest } from "../orchestrator.js";
import type { SandboxStore } from "../sandbox-store.js";
import type { SessionStore } from "../session-store.js";
import type { SandboxSpawner } from "../spawner.js";
import { JournalStore, type RunEventType } from "../workflow/journal-store.js";
import {
	projectJournalEvent,
	RunTelemetryEmitter,
	type TelemetryEvent,
	toTelemetryEventType,
} from "../workflow/run-telemetry.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function tmpJournal(): { journal: JournalStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "run-telemetry-test-"));
	return { journal: new JournalStore(join(dir, "journal.sqlite")), dir };
}

async function seedBasicRun(journal: JournalStore, runId: string): Promise<void> {
	await journal.createRun({
		run_id: runId,
		workflow_name: "test-workflow",
		graph_id: "g1",
		owner_user_id: "user-1",
		started_at: 1000,
	});
	await journal.appendEvent(runId, { type: "run_started", ts: 1000 });
	await journal.appendEvent(runId, {
		type: "node_queued",
		ts: 1001,
		sandbox_id: "sb-0",
		label: "node-1-1",
		phase_index: 1,
		payload: { model: "cheap" },
	});
	await journal.appendEvent(runId, {
		type: "node_started",
		ts: 1010,
		sandbox_id: "sb-0",
		label: "node-1-1",
		phase_index: 1,
	});
	await journal.appendEvent(runId, {
		type: "tool_call",
		ts: 1020,
		sandbox_id: "sb-0",
		label: "node-1-1",
		phase_index: 1,
		payload: { gate: "read_document", args: { id: "d1" } },
	});
	await journal.appendEvent(runId, {
		type: "node_done",
		ts: 1100,
		sandbox_id: "sb-0",
		label: "node-1-1",
		phase_index: 1,
		payload: { state: "done", tokens: 50, turns: 2 },
	});
	await journal.appendEvent(runId, {
		type: "token_usage",
		ts: 1100,
		sandbox_id: "sb-0",
		label: "node-1-1",
		phase_index: 1,
		payload: { tokens: 50, turns: 2 },
	});
	await journal.appendEvent(runId, {
		type: "run_done",
		ts: 1200,
		payload: { status: "completed" },
	});
}

// ─── Projection tests ────────────────────────────────────────────────────────

describe("toTelemetryEventType — journal → Contract A mapping", () => {
	const expectedMappings: Array<[RunEventType, string | null]> = [
		["run_started", "run.started"],
		["run_done", "run.finished"],
		["node_queued", "node.queued"],
		["node_started", "node.started"],
		["node_done", "node.finished"],
		["error", "node.failed"],
		["phase_entered", "phase.entered"],
		["phase_exited", "phase.exited"],
		["log", "log"],
		// Folded into node.finished payload — not a top-level telemetry event.
		["tool_call", null],
		["token_usage", null],
	];

	for (const [input, expected] of expectedMappings) {
		it(`${input} → ${expected ?? "null (folded)"}`, () => {
			assert.equal(toTelemetryEventType(input), expected);
		});
	}
});

describe("projectJournalEvent — wire shape", () => {
	it("produces a TelemetryEvent with identity fields from the journal row", () => {
		const event = {
			run_id: "run-1",
			seq: 3,
			ts: 5000,
			type: "node_done" as RunEventType,
			sandbox_id: "sb-x",
			label: "my-node",
			phase_index: 2,
			payload: { state: "done", tokens: 42 },
		};
		const meta = { runId: "run-1", workflowName: "my-wf" };
		const te = projectJournalEvent(meta, event);
		assert.ok(te !== null);
		assert.equal(te!.type, "node.finished");
		assert.equal(te!.runId, "run-1"); // raw run id on the wire (URN is provenance-only)
		assert.equal(te!.workflowName, "my-wf");
		assert.equal(te!.seq, 3);
		assert.equal(te!.ts, 5000);
		assert.equal(te!.nodeId, "my-node");
		assert.equal(te!.phaseIndex, 2);
		assert.equal(te!.resultRef, "run-1");
		assert.deepEqual(te!.payload, { state: "done", tokens: 42 });
	});

	it("returns null for tool_call and token_usage (folded events)", () => {
		const base = { run_id: "r", seq: 0, ts: 0, sandbox_id: null, label: null, phase_index: null, payload: null };
		assert.equal(projectJournalEvent({ runId: "r", workflowName: "w" }, { ...base, type: "tool_call" }), null);
		assert.equal(projectJournalEvent({ runId: "r", workflowName: "w" }, { ...base, type: "token_usage" }), null);
	});

	it("extracts phaseTitle from phase_entered/exited payload", () => {
		const event = {
			run_id: "r",
			seq: 1,
			ts: 100,
			type: "phase_entered" as RunEventType,
			sandbox_id: null,
			label: "My Phase",
			phase_index: 1,
			payload: { phaseIndex: 1, phaseTitle: "My Phase" },
		};
		const te = projectJournalEvent({ runId: "r", workflowName: "w" }, event);
		assert.ok(te !== null);
		assert.equal(te!.type, "phase.entered");
		assert.equal(te!.phaseTitle, "My Phase");
		assert.equal(te!.phaseIndex, 1);
	});

	it("preserves every exact run terminal status instead of reporting cancellations as finished", () => {
		for (const status of ["completed", "failed", "stopped", "paused"] as const) {
			const event = {
				run_id: "r",
				seq: 2,
				ts: 200,
				type: "run_done" as RunEventType,
				sandbox_id: null,
				label: null,
				phase_index: null,
				payload: { status },
			};
			assert.equal(projectJournalEvent({ runId: "r", workflowName: "w" }, event)?.status, status);
		}
	});
});

// ─── RunTelemetryEmitter tests ───────────────────────────────────────────────

describe("RunTelemetryEmitter — live-tail fan-out via journal.appendEvent", () => {
	it("notifies subscribers synchronously for each appendEvent (atomic INSERT path)", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();

		const emitter = new RunTelemetryEmitter();
		journal.setTelemetryEmitter(emitter);

		await journal.createRun({
			run_id: "emitter-run",
			workflow_name: "my-wf",
			graph_id: "g1",
			owner_user_id: "u1",
			started_at: 0,
		});

		const received: TelemetryEvent[] = [];
		const unsub = emitter.subscribe((te) => received.push(te));
		after(() => unsub());

		await journal.appendEvent("emitter-run", { type: "run_started", ts: 1000 });
		await journal.appendEvent("emitter-run", {
			type: "node_queued",
			ts: 1001,
			sandbox_id: "sb-0",
			label: "n1",
			phase_index: 1,
		});
		await journal.appendEvent("emitter-run", { type: "run_done", ts: 1200, payload: { status: "completed" } });

		// tool_call and token_usage are NOT emitted as telemetry events.
		await journal.appendEvent("emitter-run", { type: "tool_call", payload: {} });
		await journal.appendEvent("emitter-run", { type: "token_usage", payload: { tokens: 5 } });

		assert.equal(received.length, 3, "should have 3 events (run.started, node.queued, run.finished)");
		assert.equal(received[0].type, "run.started");
		assert.equal(received[1].type, "node.queued");
		assert.equal(received[2].type, "run.finished");
		assert.equal(received[2].status, "completed");

		// Identity fields.
		for (const te of received) {
			assert.equal(te.runId, "emitter-run"); // raw run id on the wire (URN is provenance-only)
			assert.equal(te.workflowName, "my-wf");
			assert.equal(te.resultRef, "emitter-run");
		}

		// Seq is monotonically increasing.
		assert.ok(received[0].seq < received[1].seq && received[1].seq < received[2].seq);

		journal.close();
	});

	it("multiple subscribers each receive all events independently", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();

		const emitter = new RunTelemetryEmitter();
		journal.setTelemetryEmitter(emitter);

		await journal.createRun({
			run_id: "multi-sub-run",
			workflow_name: "wf",
			graph_id: "g1",
			owner_user_id: "u1",
			started_at: 0,
		});

		const a: TelemetryEvent[] = [];
		const b: TelemetryEvent[] = [];
		const unsubA = emitter.subscribe((te) => a.push(te));
		const unsubB = emitter.subscribe((te) => b.push(te));
		after(() => {
			unsubA();
			unsubB();
		});

		await journal.appendEvent("multi-sub-run", { type: "run_started" });
		await journal.appendEvent("multi-sub-run", { type: "run_done" });

		assert.equal(a.length, 2);
		assert.equal(b.length, 2);
		assert.deepEqual(
			a.map((e) => e.type),
			b.map((e) => e.type),
		);

		journal.close();
	});
});

// ─── listEventsSince tests ────────────────────────────────────────────────────

describe("JournalStore.listEventsSince — replay-by-seq", () => {
	it("returns all events when since=0 (full replay)", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();
		await seedBasicRun(journal, "replay-run");

		const events = await journal.listEventsSince("replay-run", 0);
		assert.ok(events.length >= 4, "should return all journal events");
		assert.equal(events[0].seq, 0);
		journal.close();
	});

	it("resumes from since=N (skip events with seq < since)", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();
		await seedBasicRun(journal, "since-run");

		const all = await journal.listEventsSince("since-run", 0);
		assert.ok(all.length >= 3);

		// Skip first 2 events.
		const partial = await journal.listEventsSince("since-run", 2);
		assert.ok(partial.length === all.length - 2, "should skip events with seq < 2");
		assert.equal(partial[0].seq, 2);

		// past-the-end: returns empty.
		const none = await journal.listEventsSince("since-run", all.length + 100);
		assert.equal(none.length, 0);

		journal.close();
	});

	it("returns only the event at exactly seq=since (inclusive boundary)", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();
		await journal.createRun({
			run_id: "boundary-run",
			workflow_name: "wf",
			graph_id: "g1",
			owner_user_id: "u1",
			started_at: 0,
		});
		await journal.appendEvent("boundary-run", { type: "run_started" }); // seq=0
		await journal.appendEvent("boundary-run", { type: "node_queued", label: "n1" }); // seq=1
		await journal.appendEvent("boundary-run", { type: "run_done" }); // seq=2

		const atOne = await journal.listEventsSince("boundary-run", 1);
		assert.equal(atOne.length, 2);
		assert.equal(atOne[0].seq, 1);
		assert.equal(atOne[0].type, "node_queued");

		journal.close();
	});
});

// ─── v1.1 phase/log journal events ──────────────────────────────────────────

describe("v1.1 phase_entered / phase_exited / log journal events", () => {
	it("phase_entered and phase_exited travel through journal and project correctly", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();
		await journal.createRun({
			run_id: "phase-run",
			workflow_name: "wf",
			graph_id: "g1",
			owner_user_id: "u1",
			started_at: 0,
		});

		await journal.appendEvent("phase-run", {
			type: "phase_exited",
			ts: 100,
			payload: { phaseIndex: 1, phaseTitle: "Old Phase" },
		});
		await journal.appendEvent("phase-run", {
			type: "phase_entered",
			ts: 101,
			payload: { phaseIndex: 2, phaseTitle: "New Phase" },
			phase_index: 2,
			label: "New Phase",
		});

		const events = await journal.listEvents("phase-run");
		assert.equal(events.length, 2);
		assert.equal(events[0].type, "phase_exited");
		assert.equal(events[1].type, "phase_entered");
		assert.equal(events[1].phase_index, 2);

		// Projection.
		const meta = { runId: "phase-run", workflowName: "wf" };
		const te0 = projectJournalEvent(meta, events[0]);
		const te1 = projectJournalEvent(meta, events[1]);
		assert.ok(te0);
		assert.ok(te1);
		assert.equal(te0!.type, "phase.exited");
		assert.equal(te1!.type, "phase.entered");
		assert.equal(te1!.phaseTitle, "New Phase");
		assert.equal(te1!.phaseIndex, 2);

		journal.close();
	});

	it("log journal event projects to log telemetry event", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();
		await journal.createRun({
			run_id: "log-run",
			workflow_name: "wf",
			graph_id: "g1",
			owner_user_id: "u1",
			started_at: 0,
		});

		await journal.appendEvent("log-run", {
			type: "log",
			ts: 500,
			payload: { msg: "hello from the script" },
		});

		const events = await journal.listEvents("log-run");
		assert.equal(events.length, 1);
		assert.equal(events[0].type, "log");

		const meta = { runId: "log-run", workflowName: "wf" };
		const te = projectJournalEvent(meta, events[0]);
		assert.ok(te);
		assert.equal(te!.type, "log");
		assert.deepEqual(te!.payload, { msg: "hello from the script" });

		journal.close();
	});
});

// ─── HTTP endpoint tests (routeRequest) ──────────────────────────────────────

/** Minimal AppContext for the telemetry endpoint tests. */
function makeTestCtx(journal: JournalStore) {
	const telemetry = new RunTelemetryEmitter();
	journal.setTelemetryEmitter(telemetry);
	return {
		store: { get: () => undefined, list: () => [] } as unknown as SandboxStore,
		sessions: {} as unknown as SessionStore,
		spawner: {} as unknown as SandboxSpawner,
		eventBus: undefined,
		journal,
		telemetry,
	};
}

/** Minimal mock ServerResponse that captures output. */
function mockResponse() {
	const chunks: string[] = [];
	let ended = false;
	const capturedHeaders: Record<string, string | number> = {};
	let statusCode = 0;

	const obj = {
		get output() {
			return chunks.join("");
		},
		get capturedHeaders() {
			return capturedHeaders;
		},
		get ended() {
			return ended;
		},
		get writableNeedDrain() {
			return false;
		},
		get statusCode() {
			return statusCode;
		},
		set statusCode(v: number) {
			statusCode = v;
		},
		writeHead(code: number, hdrs: Record<string, string>) {
			statusCode = code;
			Object.assign(capturedHeaders, hdrs);
		},
		setHeader(name: string, value: string | number) {
			capturedHeaders[name.toLowerCase()] = value;
		},
		write(chunk: string) {
			chunks.push(chunk);
			return true;
		},
		end(chunk?: string) {
			if (chunk) chunks.push(chunk);
			ended = true;
		},
		setTimeout() {},
		on() {},
	};
	return obj as unknown as ServerResponse & {
		output: string;
		capturedHeaders: Record<string, string | number>;
		ended: boolean;
	};
}

/** Minimal mock IncomingMessage. */
function mockRequest(opts: { method?: string; url?: string; headers?: Record<string, string>; accept?: string }) {
	const headers: Record<string, string> = {
		host: "localhost:3456",
		"x-internal-service": "dev-secret",
		"x-user-id": "user-1",
		...opts.headers,
	};
	if (opts.accept) headers["accept"] = opts.accept;
	return {
		method: opts.method ?? "GET",
		url: opts.url ?? "/",
		headers,
		on() {},
	} as unknown as IncomingMessage;
}

describe("GET /api/workflows/runs/:runId (JSON header + events)", () => {
	it("returns 404 for unknown run", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();
		// Stub the internal service secret env var so auth passes.
		const orig = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "dev-secret";
		after(() => {
			process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = orig;
		});

		const ctx = makeTestCtx(journal);
		const req = mockRequest({ url: "/api/workflows/runs/no-such-run" });
		const res = mockResponse();
		await routeRequest(req, res, ctx as never);
		const body = JSON.parse(res.output);
		assert.equal(res.statusCode, 404);
		assert.ok(body.error);
		journal.close();
	});

	it("returns header + events for an existing run", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();
		const orig = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "dev-secret";
		after(() => {
			process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = orig;
		});

		await seedBasicRun(journal, "read-run");
		await journal.finishRun("read-run", {
			status: "completed",
			ended_at: 2000,
			duration_ms: 1000,
			agent_count: 1,
			total_tokens: 50,
		});

		const ctx = makeTestCtx(journal);
		const req = mockRequest({ url: "/api/workflows/runs/read-run" });
		const res = mockResponse();
		await routeRequest(req, res, ctx as never);

		assert.equal(res.statusCode, 200);
		const body = JSON.parse(res.output);
		assert.ok(body.header);
		assert.equal(body.header.run_id, "read-run");
		assert.equal(body.header.workflow_name, "test-workflow");
		assert.ok(Array.isArray(body.events));
		assert.ok(body.events.length > 0);
		journal.close();
	});
});

describe("GET /api/workflows/runs/:runId/events — poll-since-seq (JSON)", () => {
	it("returns projected Contract A events with nextSince cursor", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();
		const orig = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "dev-secret";
		after(() => {
			process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = orig;
		});

		await seedBasicRun(journal, "poll-run");
		await journal.finishRun("poll-run", {
			status: "completed",
			ended_at: 2000,
			duration_ms: 1000,
			agent_count: 1,
			total_tokens: 50,
		});

		const ctx = makeTestCtx(journal);
		const req = mockRequest({ url: "/api/workflows/runs/poll-run/events?since=0" });
		const res = mockResponse();
		await routeRequest(req, res, ctx as never);

		assert.equal(res.statusCode, 200);
		// Poll response is a BARE ARRAY — no wrapper object.
		const events = JSON.parse(res.output) as TelemetryEvent[];
		assert.ok(Array.isArray(events));
		// Should have at least run.started, node.queued, node.started, node.finished, run.finished.
		// (tool_call and token_usage are filtered out.)
		const types = events.map((e) => e.type);
		assert.ok(types.includes("run.started"), `expected run.started in ${JSON.stringify(types)}`);
		assert.ok(types.includes("node.queued"), `expected node.queued in ${JSON.stringify(types)}`);
		assert.ok(types.includes("node.finished"), `expected node.finished in ${JSON.stringify(types)}`);
		assert.ok(types.includes("run.finished"), `expected run.finished in ${JSON.stringify(types)}`);
		assert.ok(!types.includes(null), "no null events should appear");

		// run.finished must carry a top-level status field.
		const runFinished = events.find((e) => e.type === "run.finished");
		assert.ok(runFinished, "run.finished must be present");
		assert.equal(runFinished!.status, "completed");

		// Required identity fields are present on every event.
		for (const ev of events) {
			assert.equal(typeof ev.phaseIndex, "number", `phaseIndex must be a number on ${ev.type}`);
			assert.equal(typeof ev.phaseTitle, "string", `phaseTitle must be a string on ${ev.type}`);
			assert.equal(typeof ev.nodeId, "string", `nodeId must be a string on ${ev.type}`);
		}

		// nextSince pagination cursor is in the X-Next-Since response header.
		const nextSinceHeader = res.capturedHeaders["x-next-since"];
		assert.ok(nextSinceHeader !== undefined, "X-Next-Since header must be present");
		assert.ok(Number(nextSinceHeader) > 0, `X-Next-Since must be > 0, got ${nextSinceHeader}`);

		journal.close();
	});

	it("resumes correctly with ?since=N (skips already-seen events)", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();
		const orig = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "dev-secret";
		after(() => {
			process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = orig;
		});

		await seedBasicRun(journal, "resume-run");
		await journal.finishRun("resume-run", {
			status: "completed",
			ended_at: 2000,
			duration_ms: 1000,
			agent_count: 1,
			total_tokens: 50,
		});

		const ctx = makeTestCtx(journal);

		// First page: all events (bare array, nextSince in X-Next-Since header).
		const req0 = mockRequest({ url: "/api/workflows/runs/resume-run/events?since=0" });
		const res0 = mockResponse();
		await routeRequest(req0, res0, ctx as never);
		const nextSince = Number(res0.capturedHeaders["x-next-since"]);
		assert.ok(nextSince > 0, `X-Next-Since must be > 0, got ${nextSince}`);

		// Second page: nothing new (past end).
		const req1 = mockRequest({ url: `/api/workflows/runs/resume-run/events?since=${nextSince}` });
		const res1 = mockResponse();
		await routeRequest(req1, res1, ctx as never);
		const page2 = JSON.parse(res1.output) as TelemetryEvent[];
		assert.equal(page2.length, 0, "past the last event — no new events");

		journal.close();
	});
});

describe("GET /api/workflows/runs/:runId/events — SSE stream", () => {
	it("replays past events as SSE then closes if run is finished", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();
		const orig = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "dev-secret";
		after(() => {
			process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = orig;
		});

		await seedBasicRun(journal, "sse-run");
		await journal.finishRun("sse-run", {
			status: "completed",
			ended_at: 2000,
			duration_ms: 1000,
			agent_count: 1,
			total_tokens: 50,
		});

		const ctx = makeTestCtx(journal);
		const req = mockRequest({
			url: "/api/workflows/runs/sse-run/events",
			accept: "text/event-stream",
		});
		const res = mockResponse();
		await routeRequest(req, res, ctx as never);

		// Should have SSE headers.
		assert.equal(res.capturedHeaders["content-type"], "text/event-stream");

		// Should have emitted at least some SSE events.
		const output = res.output;
		assert.ok(output.includes("event: run.started"), `expected run.started SSE event; got: ${output.slice(0, 500)}`);
		assert.ok(
			output.includes("event: run.finished"),
			`expected run.finished SSE event; got: ${output.slice(0, 500)}`,
		);

		// Finished run should close after replay.
		assert.ok(res.ended, "response should be ended for a finished run");

		journal.close();
	});
});
