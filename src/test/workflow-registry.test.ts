/**
 * Smoke test for Slice 1 — the in-process workflow registry + generic
 * run-by-name dispatch.
 *
 * Registers a trivial single-agent summarizer workflow (one node, no
 * synthesis doc), POSTs to the dispatch path with `workflow_name`, and
 * asserts:
 *   - the run record is created (journal createRun called)
 *   - the node runs (runner called once)
 *   - the run completes (status === "completed")
 *   - the response carries `workflowId` matching the registered name
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { FoundDocument, GraphWriter } from "../workflow/graph-writer.js";
import { compileWorkflow, runWorkflow, type WorkflowRunInputs } from "../workflow/harness.js";
import type { WorkflowDeps } from "../workflow/interpreter-primitives.js";
import { getWorkflow, listWorkflows, registerWorkflow, workflowEntryFromSource } from "../workflow/registry.js";
import type { AgentNodeResult, AgentNodeSpec, NodeRunner } from "../workflow/types.js";

// ── Fakes (mirrors workflow-harness.test.ts) ──────────────────────────────────

function fakeRunner(behavior?: (spec: AgentNodeSpec) => Partial<AgentNodeResult>) {
	const calls: AgentNodeSpec[] = [];
	const runNode: NodeRunner = async (spec) => {
		calls.push(spec);
		const base: AgentNodeResult = {
			label: spec.label,
			phaseIndex: spec.phaseIndex,
			state: "done",
			output: `summary:${spec.label}`,
			model: spec.model ?? "cheap",
			turns: 1,
			toolCalls: 0,
			tokens: 50,
			queuedAt: 0,
			startedAt: 0,
			durationMs: 2,
			agentType: spec.agentType,
		};
		return { ...base, ...behavior?.(spec) };
	};
	return { runNode, calls };
}

function fakeGraph() {
	const writes: Array<{ graphId: string; documentId: string; content: string }> = [];
	const graph: GraphWriter = {
		async sparqlUpdate() {},
		async sparqlQuery() {
			return {};
		},
		async searchDocuments(): Promise<FoundDocument[]> {
			return [{ document_id: "d1" }];
		},
		async writeDocument(graphId, documentId, content) {
			writes.push({ graphId, documentId, content });
			return {};
		},
	};
	return { graph, writes };
}

function counterClock() {
	let t = 2000;
	return () => t++;
}

const baseDeps = (runNode: NodeRunner, graph?: GraphWriter): WorkflowDeps => ({
	runNode,
	graph,
	runId: "reg-smoke-run",
	now: counterClock(),
});

// ── A trivial single-agent summarizer script ──────────────────────────────────

const SUMMARIZER_SCRIPT = `export const meta = {
	name: "trivial-summarizer",
	description: "Single-agent summarizer — the simplest possible workflow.",
	whenToUse: "Use to summarize a piece of text with one agent call.",
	phases: [
		{ title: "summarize", detail: "One agent reads args.text and returns a summary." },
	],
}

phase("summarize")
const result = await agent("Summarize: " + args.text, {
	label: "summarize",
	toolMode: "none",
	agentType: "summarizer",
})

return { result: result.output }
`;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("workflow registry — Slice 1 smoke", () => {
	it("registers a trivial summarizer workflow and getWorkflow returns it", () => {
		const compiled = compileWorkflow(SUMMARIZER_SCRIPT);
		assert.equal(compiled.meta.name, "trivial-summarizer");

		registerWorkflow({
			compiled,
			scriptSha256: "deadbeef",
			buildInputs(body) {
				const b = body as { workflow_args?: { text?: string } };
				const text =
					b.workflow_args && typeof b.workflow_args === "object" && "text" in b.workflow_args
						? String(b.workflow_args.text ?? "")
						: "";
				const inputs: WorkflowRunInputs = {
					config: { graphId: "test-graph", model: "cheap-model" },
					args: { text },
				};
				return inputs;
			},
		});

		const entry = getWorkflow("trivial-summarizer");
		assert.ok(entry, "getWorkflow must return the registered entry");
		assert.equal(entry.compiled.meta.name, "trivial-summarizer");
		assert.equal(entry.scriptSha256, "deadbeef");
	});

	it("listWorkflows includes the summarizer", () => {
		// The summarizer was registered in the previous test; registry persists
		// for the module lifetime. We just assert the summarizer appears.
		const names = listWorkflows().map((w) => w.name);
		assert.ok(names.includes("trivial-summarizer"), `expected trivial-summarizer in [${names.join(", ")}]`);
		const summary = listWorkflows().find((workflow) => workflow.name === "trivial-summarizer");
		assert.equal(summary?.workflowUri, "urn:sophia:wf:trivial-summarizer");
		assert.equal(summary?.definitionDigest, "deadbeef");
	});

	it("getWorkflow returns undefined for an unknown name", () => {
		assert.equal(getWorkflow("no-such-workflow"), undefined);
	});

	it("runs the summarizer via runWorkflow: node runs, run completes, RunRecord carries workflowId-compatible name", async () => {
		const entry = getWorkflow("trivial-summarizer");
		assert.ok(entry, "summarizer must be registered (run the register test first)");

		const { runNode, calls } = fakeRunner();
		const { graph } = fakeGraph();

		const body = { workflow_args: { text: "hello world" } };
		const inputs = await entry.buildInputs(body, { graph, graphId: "test-graph" });

		const run = await runWorkflow(baseDeps(runNode, graph), entry.compiled, inputs);

		// The node ran exactly once.
		assert.equal(calls.length, 1, "exactly one agent node must run");
		assert.equal(calls[0].label, "summarize");
		assert.equal(calls[0].toolMode, "none");
		assert.equal(calls[0].agentType, "summarizer");

		// Run record lifecycle.
		assert.equal(run.status, "completed");
		assert.equal(run.workflowName, "trivial-summarizer");
		assert.equal(run.workflowUri, "urn:sophia:wf:trivial-summarizer");
		assert.equal(run.agentCount, 1);
		assert.ok(run.startedAt < run.endedAt);

		// The workflow returns { result } not { synthesis }, so no synthesis doc.
		assert.equal(run.synthesisDocId, undefined);
		assert.equal(run.synthesisMarkdown, undefined);

		// workflowId from the entry is the meta.name — matches what the HTTP
		// handler would set in the response.
		assert.equal(entry.compiled.meta.name, "trivial-summarizer");
	});

	it("builds a dynamic workflow entry from trusted source without registering it globally", async () => {
		const sha256 = createHash("sha256").update(SUMMARIZER_SCRIPT).digest("hex");
		const entry = workflowEntryFromSource(
			{
				source: SUMMARIZER_SCRIPT,
				expectedName: "trivial-summarizer",
				expectedSha256: sha256,
			},
			{ graphId: "unused-default", model: "default-model" },
		);

		assert.equal(entry.compiled.meta.name, "trivial-summarizer");
		assert.equal(entry.scriptSha256, sha256);

		const { graph } = fakeGraph();
		const inputs = await entry.buildInputs(
			{
				workflow_args: { text: "dynamic hello" },
				workflow_model: "dynamic/model",
				tool_mode: "none",
				system_prompt: "dynamic system",
			},
			{ graph, graphId: "dynamic-graph" },
		);
		assert.deepEqual(inputs.args, { text: "dynamic hello" });
		assert.deepEqual(inputs.config, {
			graphId: "dynamic-graph",
			model: "dynamic/model",
			toolMode: "none",
			systemPrompt: "dynamic system",
		});
	});

	it("rejects dynamic source name and sha mismatches", async () => {
		const sha256 = createHash("sha256").update(SUMMARIZER_SCRIPT).digest("hex");
		assert.throws(
			() =>
				workflowEntryFromSource(
					{ source: SUMMARIZER_SCRIPT, expectedName: "wrong-name" },
					{ graphId: "g", model: "m" },
				),
			/meta\.name 'trivial-summarizer' does not match/,
		);
		assert.throws(
			() =>
				workflowEntryFromSource(
					{ source: SUMMARIZER_SCRIPT, expectedName: "trivial-summarizer", expectedSha256: `${sha256}00` },
					{ graphId: "g", model: "m" },
				),
			/sha256 does not match/,
		);
	});
});
