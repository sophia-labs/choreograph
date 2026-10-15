import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type AgentOptions,
	makeWorkflowContext,
	runWorkflow,
	type WorkflowContext,
	type WorkflowDeps,
} from "../workflow/interpreter-primitives.js";
import type { AgentNodeResult, AgentNodeSpec, NodeRunner } from "../workflow/types.js";

// ── Fakes ──────────────────────────────────────────────────────────────────

/** A baseline schema-shaped result for a spec. */
function baseResult(spec: AgentNodeSpec): AgentNodeResult {
	return {
		label: spec.label,
		phaseIndex: spec.phaseIndex,
		state: "done",
		output: `out:${spec.label}`,
		structured: { echoed: spec.label },
		model: spec.model,
		turns: 1,
		toolCalls: 0,
		tokens: 10,
		queuedAt: 0,
		startedAt: 0,
		durationMs: 1,
		agentType: spec.agentType,
	};
}

/** A fake runner that records every spec and resolves immediately. */
function recordingRunner() {
	const calls: AgentNodeSpec[] = [];
	const runNode: NodeRunner = async (spec) => {
		calls.push(spec);
		return baseResult(spec);
	};
	return { runNode, calls };
}

/**
 * A fake runner whose every node BLOCKS on an external gate keyed by node label.
 * Lets a test resolve nodes in a chosen order and observe enqueue-vs-settle
 * ordering precisely — the only way to prove barrier vs streaming semantics.
 */
function gatedRunner() {
	const enqueued: string[] = []; // labels, in runNode-call (enqueue) order
	const settled: string[] = []; // labels, in resolve order
	const gates = new Map<string, () => void>();

	const runNode: NodeRunner = (spec) => {
		enqueued.push(spec.label);
		return new Promise<AgentNodeResult>((resolve) => {
			gates.set(spec.label, () => {
				settled.push(spec.label);
				resolve(baseResult(spec));
			});
		});
	};

	/** Release one node by label. Throws if it never enqueued. */
	const release = (label: string): void => {
		const gate = gates.get(label);
		if (!gate) throw new Error(`no gated node "${label}" (enqueued: ${enqueued.join(", ")})`);
		gate();
	};

	return { runNode, enqueued, settled, release };
}

const baseDeps = (runNode: NodeRunner): WorkflowDeps => ({
	runNode,
	runId: "test-run",
	now: (() => {
		let t = 1000;
		return () => t++;
	})(),
});

const config = { graphId: "g1", model: "default-model" };

/** Yield to the microtask queue enough times for pending chains to advance. */
async function flush(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("interpreter primitives — agent()", () => {
	it("materializes a 1:1 AgentNodeSpec and returns the typed structured payload", async () => {
		const { runNode, calls } = recordingRunner();
		const ctx = makeWorkflowContext(baseDeps(runNode), config);

		const schema = { type: "object" };
		const handle = await ctx.agent<{ echoed: string }>("do the thing", {
			label: "alpha",
			model: "cheap-model",
			agentId: "agent-0123456789abcdef",
			graphId: "g2",
			graphAccess: "read",
			toolMode: "none",
			schema,
			maxTurns: 3,
			agentType: "surveyor",
			systemPrompt: "sys",
			includeTools: ["recall", "search_documents"],
			strictToolManifest: true,
			excludeTools: ["x"],
		});

		assert.equal(calls.length, 1);
		const spec = calls[0];
		assert.equal(spec.label, "alpha");
		assert.equal(spec.phaseIndex, 1); // phase 1 until a phase is declared
		assert.equal(spec.prompt, "do the thing");
		assert.equal(spec.model, "cheap-model");
		assert.equal(spec.graphId, "g2");
		assert.equal(spec.agentId, "agent-0123456789abcdef");
		assert.match(spec.agentId ?? "", /^agent-[0-9a-f]{16}$/);
		assert.equal(spec.toolMode, "none");
		assert.equal(spec.graphAccess, "read");
		assert.equal(spec.schema, schema);
		assert.equal(spec.maxTurns, 3);
		assert.equal(spec.agentType, "surveyor");
		assert.equal(spec.systemPrompt, "sys");
		assert.deepEqual(spec.includeTools, ["recall", "search_documents"]);
		assert.equal(spec.strictToolManifest, true);
		assert.deepEqual(spec.excludeTools, ["x"]);

		// Typed structured accessor flows back from the result.
		assert.deepEqual(handle.structured, { echoed: "alpha" });
		assert.equal(handle.state, "done");
	});

	it("fails closed on an explicit agent id that would split the witness URI", async () => {
		const { runNode } = recordingRunner();
		const ctx = makeWorkflowContext(baseDeps(runNode), config);
		await assert.rejects(ctx.agent("p", { agentId: "Phanes" }), /canonical agent-<hex>/);
	});

	it("folds interpreter defaults and defaults toolMode to curated", async () => {
		const { runNode, calls } = recordingRunner();
		const ctx = makeWorkflowContext(baseDeps(runNode), config);
		await ctx.agent("p");
		assert.equal(calls[0].model, "default-model");
		assert.equal(calls[0].graphId, "g1");
		assert.equal(calls[0].agentId, undefined);
		assert.equal(calls[0].toolMode, "curated");
		// Optional fields stay unset (so run-node's own `?? default` is honored).
		assert.equal(calls[0].schema, undefined);
		assert.equal(calls[0].maxTurns, undefined);
	});

	it("keeps an explicit registered agent identity label-blind across nodes", async () => {
		const { runNode, calls } = recordingRunner();
		const registeredAgentId = "agent-0123456789abcdef";
		const ctx = makeWorkflowContext(baseDeps(runNode), { ...config, agentId: registeredAgentId });

		await ctx.agent("first", { label: "writer", systemPrompt: "shared witness" });
		await ctx.agent("second", { label: "reviewer", systemPrompt: "shared witness" });

		assert.equal(calls.length, 2);
		assert.equal(calls[0].agentId, calls[1].agentId);
		assert.equal(calls[0].agentId, registeredAgentId);
		assert.match(calls[0].agentId ?? "", /^agent-[0-9a-f]{16}$/);
	});
});

describe("interpreter primitives — phase()", () => {
	it("assigns phaseIndex by DECLARATION ORDER (1-based) and carries the title", async () => {
		const { runNode, calls } = recordingRunner();
		const ctx = makeWorkflowContext(baseDeps(runNode), config);

		const survey = ctx.phase("survey");
		assert.equal(survey.index, 1);
		assert.equal(survey.title, "survey");
		await ctx.agent("a", { label: "a" });

		const refine = ctx.phase("refine");
		assert.equal(refine.index, 2);
		assert.equal(refine.title, "refine");
		await ctx.agent("b", { label: "b" });

		const review = ctx.phase("review");
		assert.equal(review.index, 3);
		await ctx.agent("c", { label: "c" });

		// Unpinned agents attribute to the most recently declared phase.
		assert.deepEqual(
			calls.map((c) => [c.label, c.phaseIndex]),
			[
				["a", 1],
				["b", 2],
				["c", 3],
			],
		);

		// An explicit phase handle pins a node regardless of the current phase.
		await ctx.agent("late-survey", { label: "d", phase: survey });
		assert.equal(calls.find((c) => c.label === "d")?.phaseIndex, 1);

		assert.deepEqual(
			ctx.phases.map((p) => p.title),
			["survey", "refine", "review"],
		);
	});
});

describe("interpreter primitives — fan-out", () => {
	it("a fan-out of N agents calls runNode exactly N times (once each)", async () => {
		const { runNode, calls } = recordingRunner();
		const ctx = makeWorkflowContext(baseDeps(runNode), config);

		const N = 7;
		const items = Array.from({ length: N }, (_, i) => `doc-${i}`);
		const out = await ctx.parallel(items.map((doc) => () => ctx.agent("survey", { label: `map:${doc}` })));

		assert.equal(calls.length, N); // once each — no double-spawn
		assert.equal(out.length, N);
		assert.deepEqual(calls.map((c) => c.label).sort(), items.map((d) => `map:${d}`).sort());
		// Every node is a distinct spec object (distinct host Promise).
		assert.equal(new Set(calls).size, N);
	});
});

describe("interpreter primitives — parallel() is a REAL barrier", () => {
	it("enqueues every branch before any awaits, and resolves only after ALL settle", async () => {
		const { runNode, enqueued, release } = gatedRunner();
		const ctx = makeWorkflowContext(baseDeps(runNode), config);

		let barrierPassed = false;
		const p = ctx
			.parallel([
				() => ctx.agent("1", { label: "n1" }),
				() => ctx.agent("2", { label: "n2" }),
				() => ctx.agent("3", { label: "n3" }),
			])
			.then((r) => {
				barrierPassed = true;
				return r;
			});

		await flush();
		// BARRIER property 1: all three branches enqueued BEFORE any awaiting join.
		assert.deepEqual(enqueued, ["n1", "n2", "n3"]);

		// Release two of three — the barrier must NOT pass yet.
		release("n1");
		release("n2");
		await flush();
		assert.equal(barrierPassed, false, "parallel resolved before all branches settled");

		// Release the last — now and only now does the barrier pass.
		release("n3");
		const results = await p;
		assert.equal(barrierPassed, true);
		assert.equal(results.length, 3);
		assert.deepEqual(results.map((r) => r.label).sort(), ["n1", "n2", "n3"]);
	});
});

describe("interpreter primitives — pipeline() has NO barrier (per-item streaming)", () => {
	it("a fast item finishes its whole chain while a slow sibling is still on stage 1", async () => {
		const { runNode, settled, release } = gatedRunner();
		const ctx = makeWorkflowContext(baseDeps(runNode), config);

		// Two stages. Each item runs stage1 then stage2 as ITS OWN chain.
		const stage1 = (item: string) => ctx.agent(`s1:${item}`, { label: `s1-${item}` });
		const stage2 = (prev: { label: string }) => ctx.agent(`s2:${prev.label}`, { label: `s2-${prev.label}` });

		const done = ctx.pipeline(["fast", "slow"], stage1, stage2);

		await flush();
		// Both items have started stage1 (streaming start — no pre-stage barrier).
		// Drive the FAST item all the way through BOTH stages while SLOW is parked
		// on stage1.
		release("s1-fast");
		await flush();
		release("s2-s1-fast"); // fast's stage2 node (labeled from stage1's result label)
		await flush();

		// NO-BARRIER property: fast has completed stage1 AND stage2 before slow has
		// even cleared stage1. If pipeline imposed a per-stage barrier, "s2-s1-fast"
		// could not have settled before "s1-slow".
		assert.ok(settled.includes("s1-fast"), "fast stage1 settled");
		assert.ok(settled.includes("s2-s1-fast"), "fast stage2 settled");
		assert.ok(!settled.includes("s1-slow"), "slow is still parked on stage1 — fast streamed past it");

		// Now drain the slow item and confirm the pipeline collects both terminals.
		release("s1-slow");
		await flush();
		release("s2-s1-slow");
		const terminals = await done;
		assert.equal(terminals.length, 2);
		// Order preserved (input order), even though fast finished first.
		assert.deepEqual(
			(terminals as Array<{ label: string }>).map((t) => t.label),
			["s2-s1-fast", "s2-s1-slow"],
		);
	});

	it("pipeline starts every item's chain eagerly (all items enter stage1 before any awaits)", async () => {
		const { runNode, enqueued } = gatedRunner();
		const ctx = makeWorkflowContext(baseDeps(runNode), config);

		const stage1 = (item: string) => ctx.agent(`s1:${item}`, { label: `s1-${item}` });
		void ctx.pipeline(["a", "b", "c"], stage1);
		await flush();
		// All three items' stage1 nodes are in flight concurrently.
		assert.deepEqual(enqueued.sort(), ["s1-a", "s1-b", "s1-c"]);
	});
});

describe("interpreter primitives — contract() + log()", () => {
	it("contract() is a no-op pass-through returning the schema verbatim", () => {
		const { runNode } = recordingRunner();
		const ctx = makeWorkflowContext(baseDeps(runNode), config);
		const schema = { type: "object", properties: {} };
		const out = ctx.contract("MyContract", schema);
		assert.equal(out, schema); // same reference — verbatim
	});

	it("log() captures lines with a clock timestamp", () => {
		const { runNode } = recordingRunner();
		const ctx = makeWorkflowContext(baseDeps(runNode), config);
		ctx.log("hello");
		ctx.log("world");
		assert.deepEqual(
			ctx.logs.map((l) => l.msg),
			["hello", "world"],
		);
		assert.ok(ctx.logs.every((l) => typeof l.ts === "number"));
	});
});

describe("runWorkflow harness (FORM A)", () => {
	it("runs a script over the context and returns value + captured telemetry", async () => {
		const { runNode, calls } = recordingRunner();

		const result = await runWorkflow(baseDeps(runNode), config, async (ctx: WorkflowContext) => {
			ctx.phase("map");
			const surveyed = await ctx.parallel(
				["d1", "d2", "d3"].map((d) => () => ctx.agent("survey", { label: `map:${d}` })),
			);
			ctx.phase("synthesize");
			const synth = await ctx.agent("synthesize", { label: "synth" });
			return { mapCount: surveyed.length, synthLabel: synth.label };
		});

		assert.deepEqual(result.value, { mapCount: 3, synthLabel: "synth" });
		assert.equal(result.runId, "test-run");
		assert.equal(calls.length, 4); // 3 map + 1 synth
		assert.equal(result.specs.length, 4);
		assert.equal(result.results.length, 4);
		assert.deepEqual(
			result.phases.map((p) => [p.index, p.title]),
			[
				[1, "map"],
				[2, "synthesize"],
			],
		);
		// The synth node attributes to phase 2 by declaration order.
		assert.equal(result.specs.find((s) => s.label === "synth")?.phaseIndex, 2);
		assert.ok(result.startedAt <= result.endedAt);
	});

	it("never spawns recursively — every agent() is a single host runNode call", async () => {
		// Construction guarantee: the script calls agent() N times → exactly N
		// runNode calls, no nested fan-out from inside a node.
		const { runNode, calls } = recordingRunner();
		await runWorkflow(baseDeps(runNode), config, async (ctx) => {
			await ctx.parallel([() => ctx.agent("a", { label: "a" }), () => ctx.agent("b", { label: "b" })]);
			await ctx.agent("c", { label: "c" });
		});
		assert.equal(calls.length, 3);
	});
});

// Keep AgentOptions referenced so the type stays exercised by the suite.
const _typecheck: AgentOptions = { label: "x" };
void _typecheck;
