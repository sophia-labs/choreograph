import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { type BusEvent, createSandboxEventBus, type SandboxEventBus } from "../event-bus.js";
import type { SandboxStore } from "../sandbox-store.js";
import type { SandboxSpawner } from "../spawner.js";
import { JournalStore } from "../workflow/journal-store.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { withJournal } from "../workflow/with-journal.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

// The event bus only calls store.get() for the initial snapshot; a stub suffices.
const stubStore = { get: () => undefined } as unknown as SandboxStore;

const authContext = { method: "internal_service", userId: "u1", internalServiceSecret: "s" } as const;

/** A fake spawner that hands out deterministic sandbox ids per enqueue. */
function fakeSpawner(): { spawner: SandboxSpawner; ids: string[] } {
	const ids: string[] = [];
	let n = 0;
	const spawner = {
		enqueue: () => {
			const sandbox_id = `sb-${n++}`;
			ids.push(sandbox_id);
			return { sandbox_id } as never;
		},
		async awaitSpawnAttempt() {},
	} as unknown as SandboxSpawner;
	return { spawner, ids };
}

function tmpJournal(): { journal: JournalStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "with-journal-test-"));
	const journal = new JournalStore(join(dir, "journal.sqlite"));
	return { journal, dir };
}

async function waitForEnqueue(ids: readonly string[], expected: number): Promise<void> {
	while (ids.length < expected) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

const semantic = makeTestAgentSemanticBinding({ registeredName: "journaled-graph-surveyor" });

const spec = (label: string, phaseIndex: number): AgentNodeSpec => ({
	label,
	phaseIndex,
	prompt: "p",
	model: "cheap",
	provider: "openrouter",
	graphId: "g1",
	agentType: "graph-surveyor",
	sessionId: `session-${label.replace(/[^A-Za-z0-9_-]+/g, "-")}`,
	sandboxGeneration: 0,
	agentId: semantic.agentId,
	runtime: semantic.runtime,
	runtimeBindingDigest: semantic.runtimeBindingDigest,
	ontology: semantic.ontology,
	ontologyBindingDigest: semantic.ontologyBindingDigest,
});

/** Drive a sandbox's lifecycle on the bus: running → (tool_call) → terminal. */
function driveTerminal(
	bus: SandboxEventBus,
	sandboxId: string,
	opts: { withTool?: boolean; withStructured?: boolean; state?: "done" | "error"; tokens?: number },
): void {
	bus.emit({
		category: "lifecycle",
		type: "running",
		sandbox_id: sandboxId,
		ts: new Date(1200).toISOString(),
		pid: 1,
	} as BusEvent);
	if (opts.withTool) {
		bus.emit({
			category: "agent",
			type: "tool_call",
			sandbox_id: sandboxId,
			ts: new Date(1300).toISOString(),
			event: { type: "tool_call", gate: "read_document", args: { id: "d1" } },
		} as BusEvent);
	}
	bus.emit({
		category: "lifecycle",
		type: "terminal",
		sandbox_id: sandboxId,
		ts: new Date(1400).toISOString(),
		state: opts.state ?? "done",
		result:
			opts.state === "error"
				? undefined
				: {
						spawn_id: sandboxId,
						status: "terminated",
						output: "ok",
						turns: 2,
						tokens: opts.tokens ?? 100,
						tool_calls: opts.withTool ? 1 : 0,
						structured_output: opts.withStructured === false ? undefined : { docId: "d1" },
					},
	} as BusEvent);
}

describe("withJournal", () => {
	it("records node_queued → node_started → tool_call → (node_done + token_usage) in order", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();
		await journal.createRun({
			run_id: "run-1",
			workflow_name: "wf",
			graph_id: "g1",
			owner_user_id: "u1",
			started_at: 1000,
		});

		const bus = createSandboxEventBus(stubStore, { cleanupDelayMs: 0 });
		const { spawner, ids } = fakeSpawner();
		const { runner, drain, sandboxIds } = withJournal(
			{ spawner, eventBus: bus, authContext, ownerUserId: "u1", mnemosyne: { graphId: "g1" } },
			journal,
			"run-1",
		);

		const resultPromise = runner(spec("map:d1", 1));
		await waitForEnqueue(ids, 1);
		driveTerminal(bus, "sb-0", { withTool: true, tokens: 250 });
		const result = await resultPromise;
		assert.equal(result.state, "done");

		await drain();
		const { events } = await journal.readRun("run-1");
		assert.deepEqual(
			events.map((e) => e.type),
			["node_queued", "node_started", "tool_call", "node_done", "token_usage"],
		);

		// Attribution + payloads.
		for (const e of events) {
			assert.equal(e.sandbox_id, "sb-0");
			assert.equal(e.label, "map:d1");
			assert.equal(e.phase_index, 1);
		}
		const tokenUsage = events.find((e) => e.type === "token_usage");
		assert.deepEqual(tokenUsage?.payload, { tokens: 250, turns: 2 });
		const toolCall = events.find((e) => e.type === "tool_call");
		assert.deepEqual(toolCall?.payload, { gate: "read_document", args: { id: "d1" } });

		assert.ok(sandboxIds.has("sb-0"));
		journal.close();
	});

	it("maps a terminal error state to an `error` row, not node_done", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();
		await journal.createRun({
			run_id: "run-err",
			workflow_name: "wf",
			graph_id: "g1",
			owner_user_id: "u1",
			started_at: 0,
		});

		const bus = createSandboxEventBus(stubStore, { cleanupDelayMs: 0 });
		const { spawner, ids } = fakeSpawner();
		const { runner, drain } = withJournal(
			{ spawner, eventBus: bus, authContext, ownerUserId: "u1", mnemosyne: { graphId: "g1" } },
			journal,
			"run-err",
		);

		const p = runner(spec("map:bad", 1));
		await waitForEnqueue(ids, 1);
		driveTerminal(bus, "sb-0", { state: "error" });
		await p;
		await drain();

		const { events } = await journal.readRun("run-err");
		const terminalTypes = events.map((e) => e.type).filter((t) => t === "node_done" || t === "error");
		assert.deepEqual(terminalTypes, ["error"], "error terminal must yield an `error` row, never node_done");
		assert.ok(!events.some((e) => e.type === "node_done"));
		journal.close();
	});

	it("records a schema-bound terminal without structured output as an error", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();
		await journal.createRun({
			run_id: "run-missing-submit",
			workflow_name: "wf",
			graph_id: "g1",
			owner_user_id: "u1",
			started_at: 0,
		});

		const bus = createSandboxEventBus(stubStore, { cleanupDelayMs: 0 });
		const { spawner, ids } = fakeSpawner();
		const { runner, drain } = withJournal(
			{ spawner, eventBus: bus, authContext, ownerUserId: "u1", mnemosyne: { graphId: "g1" } },
			journal,
			"run-missing-submit",
		);

		const pending = runner({ ...spec("map:missing", 1), schema: { type: "object" } });
		await waitForEnqueue(ids, 1);
		driveTerminal(bus, "sb-0", { withStructured: false });
		const result = await pending;
		await drain();

		assert.equal(result.state, "error");
		const { events } = await journal.readRun("run-missing-submit");
		assert.ok(events.some((event) => event.type === "error"));
		assert.ok(!events.some((event) => event.type === "node_done"));
		journal.close();
	});

	it("fan-in index maps the run to all K sandbox_ids; serial writer preserves order across nodes", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();
		await journal.createRun({
			run_id: "run-k",
			workflow_name: "wf",
			graph_id: "g1",
			owner_user_id: "u1",
			started_at: 0,
		});

		const bus = createSandboxEventBus(stubStore, { cleanupDelayMs: 0 });
		const { spawner, ids } = fakeSpawner();
		const { runner, drain, sandboxIds } = withJournal(
			{ spawner, eventBus: bus, authContext, ownerUserId: "u1", mnemosyne: { graphId: "g1" } },
			journal,
			"run-k",
		);

		// Three concurrent map nodes (sb-0, sb-1, sb-2).
		const promises = [runner(spec("map:d1", 1)), runner(spec("map:d2", 1)), runner(spec("map:d3", 1))];
		await waitForEnqueue(ids, 3);
		for (const id of ["sb-0", "sb-1", "sb-2"]) {
			driveTerminal(bus, id, { withTool: false });
		}
		await Promise.all(promises);
		await drain();

		assert.deepEqual([...sandboxIds].sort(), ["sb-0", "sb-1", "sb-2"]);

		const { events } = await journal.readRun("run-k");
		// Seqs are contiguous from the single serial writer (no gaps/dupes).
		assert.deepEqual(
			events.map((e) => e.seq),
			Array.from({ length: events.length }, (_, i) => i),
		);
		// Each sandbox produced node_queued/node_started/node_done/token_usage.
		for (const id of ["sb-0", "sb-1", "sb-2"]) {
			const forSb = events.filter((e) => e.sandbox_id === id).map((e) => e.type);
			assert.deepEqual(forSb, ["node_queued", "node_started", "node_done", "token_usage"]);
		}
		journal.close();
	});
});
