import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphWriter } from "../workflow/graph-writer.js";
import { compileWorkflow, runWorkflow } from "../workflow/harness.js";
import { buildHojaSwarmInputs, normalizeHojaScenario } from "../workflow/hoja-swarm.js";
import { HOJA_SWARM_SCRIPT } from "../workflow/script-hoja-swarm.js";
import { buildHojaSwarmGenerateInputs, HOJA_SWARM_GENERATE_SCRIPT } from "../workflow/script-hoja-swarm-generate.js";
import type { NodeRunner } from "../workflow/types.js";

const scenario = {
	schema: "sophia.hoja.scenario.v1",
	id: "scenario-1",
	runId: "run-1",
	description: "Cross the browser and markdown doors.",
	beats: [
		{
			id: "create-1",
			operation: "create",
			mode: "sequential",
			capture: true,
			actions: [{ capability: "mcp", tool: "create_document", args: { documentId: "seed-1", title: "Seed" } }],
		},
	],
	invariants: [{ id: "I1", kind: "markdown_equal", left: { beat: "create-1" }, right: { beat: "create-1" } }],
};

const scenarioIntent = {
	description: "Cross every Hoja representation boundary.",
	title: "Hoja witness",
	witness: "Hoja witness paragraph; punctuation? Yes!",
	leftBlock: "Left branch.",
	rightBlock: "Right branch.",
};

describe("Hoja swarm Meaningful Object workflow", () => {
	it("canonicalizes graph-storable scenarios into a deterministic replay digest", () => {
		const first = normalizeHojaScenario(scenario);
		const second = normalizeHojaScenario(structuredClone(scenario));
		assert.equal(first.digest, second.digest);
		assert.match(first.digest, /^[a-f0-9]{64}$/);
		assert.equal(JSON.parse(first.canonicalJson).schema, "sophia.hoja.scenario.v1");
	});

	it("restricts execution to obs-hoja campaign graphs and exact Contract B actions", () => {
		assert.throws(() => buildHojaSwarmInputs({ scenario }, "phanes"), /restricted to obs-hoja/);
		const inputs = buildHojaSwarmInputs({ scenario }, "obs-hoja-local");
		assert.equal((inputs.args as { graphId: string }).graphId, "obs-hoja-local");
		assert.throws(
			() =>
				normalizeHojaScenario({
					...scenario,
					beats: [
						{
							...scenario.beats[0],
							actions: [{ capability: "mcp", tool: "read_document", args: {}, token: "forbidden" }],
						},
					],
				}),
			/unknown fields: token/,
		);
		assert.throws(
			() =>
				normalizeHojaScenario({
					...scenario,
					beats: [
						{
							...scenario.beats[0],
							actions: [{ capability: "mcp", tool: "mcp", args: {} }],
						},
					],
				}),
			/not allowed for mcp/,
		);
		assert.throws(
			() =>
				normalizeHojaScenario({
					...scenario,
					invariants: [{ id: "I1", kind: "markdown_fixpoint" }],
				}),
			/I1 invariant/,
		);
	});

	it("accepts the generic workflow_args envelope advertised by the registry", () => {
		const replay = buildHojaSwarmInputs({ workflow_args: { scenario } }, "obs-hoja-local");
		assert.equal((replay.args as { graphId: string }).graphId, "obs-hoja-local");

		const generated = buildHojaSwarmGenerateInputs(
			{
				workflow_args: {
					runId: "run-1",
					scenarioId: "scenario-1",
					corpus: ["hello"],
					modalityPairs: ["mcp->http"],
					model: "thinkingmachines/inkling-small",
				},
			},
			"obs-hoja-local",
		);
		assert.deepEqual(generated.args, {
			runId: "run-1",
			scenarioId: "scenario-1",
			corpus: ["hello"],
			modalityPairs: ["mcp->http"],
			model: "thinkingmachines/inkling-small",
			graphId: "obs-hoja-local",
			browserUrl: "",
		});
	});

	it("compiles both the Inkling-Small generator and fully agentless replay/evaluator workflow", () => {
		const generator = compileWorkflow(HOJA_SWARM_GENERATE_SCRIPT);
		assert.equal(generator.meta.execution?.controller, "agent");
		assert.match(HOJA_SWARM_GENERATE_SCRIPT, /program, not you, owns every capability action/);
		assert.match(HOJA_SWARM_GENERATE_SCRIPT, /kind: "projection_latency"/);
		assert.match(HOJA_SWARM_GENERATE_SCRIPT, /program constructs canonical Markdown/);
		assert.match(HOJA_SWARM_GENERATE_SCRIPT, /const canonicalMarkdown/);
		assert.match(HOJA_SWARM_GENERATE_SCRIPT, /capture: true/);
		assert.match(HOJA_SWARM_GENERATE_SCRIPT, /url: args.browserUrl/);
		assert.match(HOJA_SWARM_GENERATE_SCRIPT, /path: exportPath\("markdown"\)/);
		const replay = compileWorkflow(HOJA_SWARM_SCRIPT);
		assert.equal(replay.meta.executor, "dumb");
		assert.equal(replay.meta.execution?.controller, "program");
		assert.deepEqual(replay.meta.execution?.capabilities, [
			"browser.chromium",
			"http",
			"mcp",
			"yws",
			"sparql",
			"soil",
			"evaluation.visual",
			"evaluation.primary",
			"evaluation.foreign",
		]);
	});

	it("hands delete-later actions back without executing them inside the swarm", async () => {
		const compiled = compileWorkflow(HOJA_SWARM_SCRIPT);
		const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
			...args: string[]
		) => (...args: unknown[]) => Promise<unknown>;
		const execute = new AsyncFunction("args", "invoke", "phase", "journey", compiled.bodySource);
		const calls: Array<{ capability: string; tool: string }> = [];
		const deferredAction = {
			capability: "mcp",
			tool: "delete_document",
			args: { graphId: "obs-hoja-local", documentId: "seed-1" },
		};
		const output = (await execute(
			{
				scenario: {
					...scenario,
					beats: [
						{
							id: "cleanup-1",
							operation: "delete-later",
							mode: "sequential",
							actions: [deferredAction],
						},
					],
					invariants: [],
				},
				digest: normalizeHojaScenario({
					...scenario,
					beats: [
						{
							id: "cleanup-1",
							operation: "delete-later",
							mode: "sequential",
							actions: [deferredAction],
						},
					],
					invariants: [],
				}).digest,
				graphId: "obs-hoja-local",
			},
			async (invocation: { capability: string; tool: string }) => {
				calls.push(invocation);
				if (invocation.tool === "reflect_wave") {
					return { result: { hypotheses: [], prioritizedFindings: [], nextWave: [] } };
				}
				return { success: true };
			},
			() => {},
			async (items: unknown[], handler: (item: unknown, control: { directives: string[] }) => Promise<unknown>) => {
				const results = [];
				for (const item of items) results.push(await handler(item, { directives: [] }));
				return results;
			},
		)) as { deferredCleanup: unknown[] };

		assert.deepEqual(output.deferredCleanup, [deferredAction]);
		assert.equal(
			calls.some((call) => call.tool === "delete_document"),
			false,
		);
	});

	it("fails the wave when the L1 visual judge reports a grave anomaly (E0.1)", async () => {
		const compiled = compileWorkflow(HOJA_SWARM_SCRIPT);
		const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
			...args: string[]
		) => (...args: unknown[]) => Promise<unknown>;
		const execute = new AsyncFunction("args", "invoke", "phase", "journey", compiled.bodySource);
		const journeySequential = async (
			items: unknown[],
			handler: (item: unknown, control: { directives: string[] }) => Promise<unknown>,
		) => {
			const results = [];
			for (const item of items) results.push(await handler(item, { directives: [] }));
			return results;
		};
		const observedScenario = {
			...scenario,
			beats: [
				{
					id: "observe-1",
					operation: "list",
					mode: "sequential",
					capture: true,
					actions: [{ capability: "http", tool: "get", args: { path: "/hoja/" } }],
				},
			],
			invariants: [],
		};
		const makeInvoke =
			(claims: Array<Record<string, unknown>>) => async (invocation: { capability: string; tool: string }) => {
				if (invocation.tool === "capture_beat")
					return { engine: "chromium", evidence: { screenshot: "evidence-ref" }, manifest: {} };
				if (invocation.tool === "perceptual_diff") return { dimensionsEqual: true, distancePermille: 0 };
				if (invocation.tool === "evaluate_visual")
					return {
						schema: "sophia.evaluation.visual-verdict.v1",
						verdict: "anomaly",
						confidencePermille: 900,
						claims,
					};
				if (invocation.tool === "reflect_wave")
					return { result: { hypotheses: [], prioritizedFindings: [], nextWave: [] } };
				return { success: true };
			};
		const grave = (await execute(
			{ scenario: observedScenario, digest: "0".repeat(64), graphId: "obs-hoja-local" },
			makeInvoke([
				{ code: "workspace_not_rendered", severity: "high", summary: "app unusable", evidenceSha256s: [] },
			]),
			() => {},
			journeySequential,
		)) as { status: string };
		assert.equal(grave.status, "failed");
		const mild = (await execute(
			{ scenario: observedScenario, digest: "0".repeat(64), graphId: "obs-hoja-local" },
			makeInvoke([{ code: "minor_offset", severity: "low", summary: "cosmetic drift", evidenceSha256s: [] }]),
			() => {},
			journeySequential,
		)) as { status: string };
		assert.equal(mild.status, "passed");
	});

	it("admits act, screenshot, and the I6 a11y_contains invariant (E1.1/E1.2)", async () => {
		const browserScenario = {
			...scenario,
			beats: [
				{
					id: "drive-1",
					operation: "list",
					mode: "sequential",
					actions: [
						{
							capability: "browser.chromium",
							tool: "navigate",
							args: { action: "url", url: "https://example.test/hoja/" },
						},
						{ capability: "browser.chromium", tool: "read_a11y_tree", args: {} },
						{ capability: "browser.chromium", tool: "act", args: { ref: "ref-1", action: "click" } },
						{ capability: "browser.chromium", tool: "screenshot", args: {} },
					],
				},
			],
			invariants: [{ id: "I6", kind: "a11y_contains", ref: { beat: "drive-1", action: 1 }, text: "Workspace" }],
		};
		const normalized = normalizeHojaScenario(browserScenario);
		assert.equal(normalized.scenario.invariants[0]?.id, "I6");

		const compiled = compileWorkflow(HOJA_SWARM_SCRIPT);
		const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
			...args: string[]
		) => (...args: unknown[]) => Promise<unknown>;
		const execute = new AsyncFunction("args", "invoke", "phase", "journey", compiled.bodySource);
		const output = (await execute(
			{ scenario: browserScenario, digest: normalized.digest, graphId: "obs-hoja-local" },
			async (invocation: { capability: string; tool: string }) => {
				if (invocation.tool === "read_a11y_tree") return { nodes: [{ role: "heading", name: "Workspace" }] };
				if (invocation.tool === "reflect_wave")
					return { result: { hypotheses: [], prioritizedFindings: [], nextWave: [] } };
				return { success: true };
			},
			() => {},
			async (items: unknown[], handler: (item: unknown, control: { directives: string[] }) => Promise<unknown>) => {
				const results = [];
				for (const item of items) results.push(await handler(item, { directives: [] }));
				return results;
			},
		)) as { status: string; verdicts: Array<{ invariant: string; passed: boolean }> };
		assert.equal(output.verdicts[0]?.invariant, "I6");
		assert.equal(output.verdicts[0]?.passed, true);
		assert.equal(output.status, "passed");
	});

	it("persists generated scenario data in the campaign graph and round-trips it into deterministic replay", async () => {
		const writes: Array<{ graphId: string; documentId: string; content: string }> = [];
		const graph: GraphWriter = {
			async sparqlUpdate() {},
			async sparqlQuery() {
				return {};
			},
			async searchDocuments() {
				return [];
			},
			async writeDocument(graphId, documentId, content) {
				writes.push({ graphId, documentId, content });
				return {};
			},
		};
		const runNode: NodeRunner = async (spec) => ({
			label: spec.label,
			phaseIndex: spec.phaseIndex,
			state: "done",
			output: "scenario submitted",
			structured: scenarioIntent,
			model: spec.model,
			turns: 1,
			toolCalls: 0,
			tokens: 10,
			queuedAt: 1,
			startedAt: 2,
			durationMs: 3,
			agentType: spec.agentType,
		});
		let now = 10;
		const generatedInputs = buildHojaSwarmGenerateInputs(
			{
				run_id: "run-1",
				scenario_id: "scenario-1",
				corpus: ["hello"],
				modality_pairs: ["mcp->http"],
				model: "thinkingmachines/inkling-small",
			},
			"obs-hoja-local",
		);
		const run = await runWorkflow(
			{ runNode, graph, runId: "generator-run", now: () => now++ },
			compileWorkflow(HOJA_SWARM_GENERATE_SCRIPT),
			{
				...generatedInputs,
				args: { ...(generatedInputs.args as Record<string, unknown>), browserUrl: "https://hoja.example/" },
			},
		);

		assert.equal(run.synthesisDocId, "wf-synthesis-generator-run");
		assert.equal(writes.length, 1);
		assert.equal(writes[0].graphId, "obs-hoja-local");
		const storedJson = /```json\n([\s\S]+?)\n```/.exec(writes[0].content)?.[1];
		assert.ok(storedJson, "scenario synthesis must contain a JSON data block");
		const storedScenario = normalizeHojaScenario(JSON.parse(storedJson)).scenario;
		assert.equal(storedScenario.id, "scenario-1");
		assert.equal(storedScenario.runId, "run-1");
		assert.deepEqual(
			storedScenario.beats
				.find((beat) => beat.id === "create")
				?.actions.map(({ capability, tool }) => ({
					capability,
					tool,
				})),
			[
				{ capability: "mcp", tool: "create_document" },
				{ capability: "mcp", tool: "write_document" },
				{ capability: "soil", tool: "roundtrip" },
			],
		);
		assert.equal(
			storedScenario.beats.find((beat) => beat.id === "observe")?.capture,
			true,
			"the deterministic compiler owns the capture beat",
		);
		assert.equal(
			storedScenario.beats
				.find((beat) => beat.id === "create")
				?.actions.find((action) => action.capability === "soil")?.args.body,
			"# Hoja witness\n\nWitness: Hoja witness paragraph; punctuation? Yes!\n",
		);
		assert.deepEqual(storedScenario.invariants.slice(0, 2), [
			{
				id: "I1",
				kind: "markdown_equal",
				left: { beat: "faces", action: 0, path: "value.structuredContent.content" },
				right: { beat: "faces", action: 2, path: "value.body" },
			},
			{
				id: "I2",
				kind: "face_agreement",
				refs: [
					{ beat: "faces", action: 1, path: "value.structuredContent.content" },
					{ beat: "faces", action: 5, path: "value.body" },
				],
			},
		]);
	});
});
