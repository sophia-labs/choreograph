/**
 * The run record claims only tool use that happened (D10, "record it honestly";
 * `plans/2026-10-20-typed-objects/notes-geist-for-beings.md` §4).
 *
 * A `tool_call` is journaled when a call starts, so it is an attempt. The journal now also keeps each call's outcome
 * (`tool_result`: the gate and whether it failed, never the result), and the fold counts a tool as used only when a
 * call to it succeeded. A refused `remember` (a member token lacks `memory.write`) is therefore no memory in the record.
 * A journal from before outcomes were kept still folds its attempts as used (`workflow-projection.test.ts`).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type BusEvent, createSandboxEventBus } from "../event-bus.js";
import type { SandboxStore } from "../sandbox-store.js";
import type { SandboxSpawner } from "../spawner.js";
import { JournalStore } from "../workflow/journal-store.js";
import { foldRunToAgentSubject, foldRunToProvenance } from "../workflow/projection.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { withJournal } from "../workflow/with-journal.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

describe("the run record claims no memory that did not happen", () => {
	it("a refused remember is not folded as used, and a recall folds as a read", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tool-outcomes-journal-"));
		const journal = new JournalStore(join(dir, "journal.sqlite"));
		try {
			await journal.init();
			await journal.createRun({
				run_id: "run-geist",
				workflow_name: "graph-plan-v1",
				graph_id: "freud-dreams",
				owner_user_id: "u1",
				started_at: 1000,
			});
			const semantic = makeTestAgentSemanticBinding({ graphId: "freud-dreams", registeredName: "the-reader" });
			const bus = createSandboxEventBus({ get: () => undefined } as unknown as SandboxStore, { cleanupDelayMs: 0 });
			const ids: string[] = [];
			const spawner = {
				enqueue: () => {
					ids.push(`sb-${ids.length}`);
					return { sandbox_id: ids.at(-1) } as never;
				},
				async awaitSpawnAttempt() {},
			} as unknown as SandboxSpawner;
			const { runner, drain } = withJournal(
				{ spawner, eventBus: bus, ownerUserId: "u1", mnemosyne: { graphId: "freud-dreams" } },
				journal,
				"run-geist",
			);
			const spec: AgentNodeSpec = {
				label: "the Reader",
				phaseIndex: 1,
				prompt: "Begin with your sources.",
				model: "test/model",
				provider: "openrouter",
				graphId: "freud-dreams",
				agentType: "reader",
				sessionId: "session-geist-reader",
				sandboxGeneration: 0,
				agentId: semantic.agentId,
				runtime: semantic.runtime,
				runtimeBindingDigest: semantic.runtimeBindingDigest,
				ontology: semantic.ontology,
				ontologyBindingDigest: semantic.ontologyBindingDigest,
			};
			const done = runner(spec);
			while (ids.length < 1) await new Promise<void>((resolve) => setImmediate(resolve));
			const at = (ms: number) => new Date(ms).toISOString();
			const agent = (type: string, ms: number, event: Record<string, unknown>) =>
				bus.emit({ category: "agent", type, sandbox_id: "sb-0", ts: at(ms), event } as BusEvent);
			bus.emit({ category: "lifecycle", type: "running", sandbox_id: "sb-0", ts: at(1100), pid: 1 } as BusEvent);
			agent("tool_call", 1200, { type: "tool_call", gate: "recall", args: { query: "" } });
			agent("tool_result", 1210, {
				type: "tool_result",
				gate: "recall",
				result: "the memories, verbatim",
				is_error: false,
			});
			agent("tool_call", 1300, { type: "tool_call", gate: "remember", args: { content: "x" } });
			agent("tool_result", 1310, {
				type: "tool_result",
				gate: "remember",
				result: "loopback token missing required scope memory.write",
				is_error: true,
			});
			bus.emit({
				category: "lifecycle",
				type: "terminal",
				sandbox_id: "sb-0",
				ts: at(1400),
				state: "done",
				result: { spawn_id: "sb-0", status: "terminated", output: "", turns: 3, tokens: 10, tool_calls: 2 },
			} as BusEvent);
			await done;
			await drain();
			await journal.appendEvent("run-geist", { type: "run_done", ts: 1500, payload: { status: "completed" } });
			await journal.finishRun("run-geist", {
				status: "completed",
				ended_at: 1500,
				duration_ms: 500,
				agent_count: 1,
				total_tokens: 10,
			});

			// The event stream keeps both calls and both outcomes, but never a result's text.
			const { events } = await journal.readRun("run-geist");
			assert.deepEqual(
				events.filter((event) => event.type === "tool_result").map((event) => event.payload),
				[
					{ gate: "recall", isError: false },
					{ gate: "remember", isError: true },
				],
			);
			assert.ok(!JSON.stringify(events).includes("the memories, verbatim"));
			assert.equal(events.filter((event) => event.type === "tool_call").length, 2);

			const { run } = await foldRunToProvenance(journal, "run-geist");
			assert.deepEqual(run.agents[0].usedTools, ["recall"], "the refused remember is no used tool");
			const { sparql } = await foldRunToAgentSubject(journal, "run-geist");
			assert.ok(!sparql.includes(":tool:remember"), "no agt:Tool claims a memory write");
			assert.match(sparql, new RegExp(`${semantic.agentId}:tool:recall> a agt:Tool ;[^.]*agt:toolAccess "read"`));
			assert.doesNotMatch(sparql, /recall"[^.]*agt:toolAccess "write"/);
		} finally {
			journal.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
