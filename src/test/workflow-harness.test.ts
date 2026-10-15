/**
 * Smoke test for the FORM (A) harness (`runWorkflow`): compile a tiny 2-phase
 * Workflow script (parallel fan-out → synthesize), run it end-to-end against a
 * MOCKED `runNode` (the journaled `NodeRunner` shape), and assert the returned
 * `RunRecord` is IDENTICAL in shape to `runSurveySynthesize`'s — with the right
 * agents attributed across BOTH phases.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FoundDocument, GraphWriter } from "../workflow/graph-writer.js";
import { type CompiledWorkflow, compileWorkflow, runWorkflow, type WorkflowRunInputs } from "../workflow/harness.js";
import type { WorkflowDeps } from "../workflow/interpreter-primitives.js";
import {
	buildSurveySynthesizeInputs,
	SURVEY_SYNTHESIZE_SCRIPT,
	WORKFLOW_NAME,
} from "../workflow/script-survey-synthesize.js";
import type { AgentNodeResult, AgentNodeSpec, NodeRunner, RunRecord } from "../workflow/types.js";

// ── Fakes ────────────────────────────────────────────────────────────────────

/**
 * A fake (journaled-shaped) NodeRunner: records every spec and returns canned,
 * schema-shaped results. Stands in for `withJournal`'s `runner` — the harness only
 * depends on the `NodeRunner` function type, so the tee/journal layer is opaque.
 */
function fakeRunner(behavior?: (spec: AgentNodeSpec) => Partial<AgentNodeResult>) {
	const calls: AgentNodeSpec[] = [];
	const runNode: NodeRunner = async (spec) => {
		calls.push(spec);
		const base: AgentNodeResult = {
			label: spec.label,
			phaseIndex: spec.phaseIndex,
			state: "done",
			output: `out:${spec.label}`,
			model: spec.model,
			turns: 1,
			toolCalls: spec.toolMode === "curated" ? 1 : 0,
			tokens: 100,
			queuedAt: 0,
			startedAt: 0,
			durationMs: 5,
			agentType: spec.agentType,
		};
		const structured =
			spec.phaseIndex === 1
				? { docId: spec.label.replace("map:", ""), relevance: 0.8, keyPoints: ["k"], evidence: ["e"] }
				: { title: "Synthesis", markdown: "# answer\nciting d1" };
		return { ...base, structured, ...behavior?.(spec) };
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
			return [];
		},
		async writeDocument(graphId, documentId, content) {
			writes.push({ graphId, documentId, content });
			return {};
		},
	};
	return { graph, writes };
}

function counterClock() {
	let t = 1000;
	return () => t++;
}

const baseDeps = (runNode: NodeRunner, graph?: GraphWriter): WorkflowDeps => ({
	runNode,
	graph,
	runId: "smoke-run",
	now: counterClock(),
});

// A tiny inline 2-phase script (parallel fan-out → synthesize) — the canonical
// `export const meta` + top-level async body form the harness compiles.
const TINY_SCRIPT = `export const meta = {
	name: "tiny-fanout-synth",
	description: "Two phases: parallel fan-out then one synthesizer.",
	phases: [
		{ title: "fan-out", detail: "One agent per item, in parallel." },
		{ title: "synthesize", detail: "One agent over the fan-out outputs." },
	],
}

phase("fan-out")
const mapped = await parallel(
	args.items.map((it) => () => agent("survey " + it, { label: "map:" + it, agentType: "graph-surveyor" })),
)

phase("synthesize")
const synth = await agent("synthesize " + mapped.length + " findings", {
	label: "synthesize",
	toolMode: "none",
	agentType: "findings-synthesizer",
})

const s = synth.structured
const synthesis = s && typeof s === "object" && typeof s.markdown === "string"
	? { title: s.title, markdown: s.markdown }
	: undefined
return { synthesis, question: "tiny?" }
`;

// ── Tests ──────────────────────────────────────────────────────────────────

describe("runWorkflow harness — tiny 2-phase script end-to-end", () => {
	it("compiles the script, runs both phases against a mocked runNode, and rolls up a RunRecord with the right agents across both phases", async () => {
		const compiled: CompiledWorkflow = compileWorkflow(TINY_SCRIPT);
		assert.equal(compiled.meta.name, "tiny-fanout-synth");
		assert.equal(compiled.meta.phases?.length, 2);

		const { runNode, calls } = fakeRunner();
		const { graph, writes } = fakeGraph();

		const inputs: WorkflowRunInputs = {
			config: { graphId: "g1", model: "default-model" },
			args: { items: ["d1", "d2", "d3"] },
		};

		const run: RunRecord = await runWorkflow(baseDeps(runNode, graph), compiled, inputs);

		// Topology: 3 fan-out + 1 synth — once each (no recursive double-spawn).
		assert.equal(calls.length, 4);
		assert.equal(run.agentCount, 4);
		assert.equal(run.agents.length, 4);

		// Phase 1 (fan-out): 3 agents, attributed to phaseIndex 1.
		const phase1 = run.agents.filter((a) => a.phaseIndex === 1);
		assert.equal(phase1.length, 3);
		assert.deepEqual(phase1.map((a) => a.label).sort(), ["map:d1", "map:d2", "map:d3"]);
		assert.ok(phase1.every((a) => a.agentType === "graph-surveyor"));

		// Phase 2 (synthesize): exactly 1 agent, attributed to phaseIndex 2.
		const phase2 = run.agents.filter((a) => a.phaseIndex === 2);
		assert.equal(phase2.length, 1);
		assert.equal(phase2[0].label, "synthesize");
		assert.equal(phase2[0].agentType, "findings-synthesizer");

		// The synth spec carried the script's per-agent override (no tools).
		assert.equal(calls.find((c) => c.label === "synthesize")?.toolMode, "none");

		// Defaults folded by the interpreter (graphId + model) onto every spec.
		assert.ok(calls.every((c) => c.graphId === "g1"));

		// RunRecord shape (identical to runSurveySynthesize): roll-up fields.
		assert.equal(run.runId, "smoke-run");
		assert.equal(run.workflowName, "tiny-fanout-synth");
		assert.equal(run.workflowUri, "urn:sophia:wf:tiny-fanout-synth");
		assert.equal(run.status, "completed");
		assert.equal(run.totalTokens, 400);
		assert.ok(run.startedAt < run.endedAt);
		assert.equal(run.durationMs, run.endedAt - run.startedAt);

		// Code serializes: the harness wrote the synthesis doc from the RETURN value.
		assert.equal(run.synthesisDocId, "wf-synthesis-smoke-run");
		assert.ok(run.synthesisMarkdown?.includes("answer"));
		assert.equal(writes.length, 1);
		assert.equal(writes[0].documentId, "wf-synthesis-smoke-run");
		assert.ok(writes[0].content.includes("# Synthesis"));
		assert.ok(writes[0].content.includes("*Question: tiny?*"));
		assert.equal(run.note, undefined);
	});

	it("marks the run failed when any fan-out agent errors", async () => {
		const compiled = compileWorkflow(TINY_SCRIPT);
		const { runNode } = fakeRunner((spec) =>
			spec.label === "map:d2" ? { state: "error", structured: undefined } : {},
		);
		const run = await runWorkflow(baseDeps(runNode), compiled, {
			config: { graphId: "g", model: "m" },
			args: { items: ["d1", "d2"] },
		});
		assert.equal(run.status, "failed");
		assert.equal(run.agentCount, 3); // 2 fan-out + 1 synth still ran
	});

	it("runs without a graph (unit mode) — no synthesis doc, no throw", async () => {
		const compiled = compileWorkflow(TINY_SCRIPT);
		const { runNode } = fakeRunner();
		const run = await runWorkflow(baseDeps(runNode), compiled, {
			config: { graphId: "g", model: "m" },
			args: { items: ["d1"] },
		});
		assert.equal(run.synthesisDocId, undefined);
		assert.equal(run.agentCount, 2);
		assert.ok(run.synthesisMarkdown?.includes("answer"));
	});
});

describe("runWorkflow harness — survey-synthesize via the real compiled script", () => {
	it("reproduces the driver's topology and RunRecord through the script + harness", async () => {
		const compiled = compileWorkflow(SURVEY_SYNTHESIZE_SCRIPT);
		assert.equal(compiled.meta.name, WORKFLOW_NAME);

		const { runNode, calls } = fakeRunner();
		const { graph, writes } = fakeGraph();

		const inputs = buildSurveySynthesizeInputs({
			graphId: "g1",
			question: "What is X?",
			docIds: ["d1", "d2", "d3"],
			mapModel: "cheap",
			synthModel: "smart",
		});

		const run = await runWorkflow(baseDeps(runNode, graph), compiled, inputs);

		// Same topology as the driver: 3 map + 1 synth.
		assert.equal(run.agentCount, 4);
		const mapCalls = calls.filter((c) => c.phaseIndex === 1);
		const synthCalls = calls.filter((c) => c.phaseIndex === 2);
		assert.equal(mapCalls.length, 3);
		assert.equal(synthCalls.length, 1);

		// Map nodes: curated tools, cheap model, schema, archetype, the map prompt.
		assert.ok(mapCalls.every((c) => c.toolMode === "curated"));
		assert.ok(mapCalls.every((c) => c.model === "cheap"));
		assert.ok(mapCalls.every((c) => c.schema !== undefined));
		assert.ok(mapCalls.every((c) => c.agentType === "graph-surveyor"));
		assert.ok(mapCalls.every((c) => c.systemPrompt?.includes("graph surveyor")));
		assert.ok(mapCalls.every((c) => c.prompt.includes("Question: What is X?")));
		assert.deepEqual(mapCalls.map((c) => c.label).sort(), ["map:d1", "map:d2", "map:d3"]);

		// Synth node: no tools, smart model, schema, archetype.
		assert.equal(synthCalls[0].toolMode, "none");
		assert.equal(synthCalls[0].model, "smart");
		assert.equal(synthCalls[0].agentType, "findings-synthesizer");
		assert.ok(synthCalls[0].prompt.includes("Per-document findings"));

		// Roll-up identical in shape to runSurveySynthesize.
		assert.equal(run.status, "completed");
		assert.equal(run.totalTokens, 400);
		assert.equal(run.workflowName, "graph-survey-synthesize");
		assert.equal(run.workflowUri, "urn:sophia:wf:graph-survey-synthesize");
		assert.equal(run.synthesisDocId, "wf-synthesis-smoke-run");
		assert.equal(writes.length, 1);
		assert.ok(writes[0].content.includes("# Synthesis"));
		assert.ok(run.synthesisMarkdown?.includes("answer"));
	});
});
