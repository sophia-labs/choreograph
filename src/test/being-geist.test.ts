/**
 * D10, "humane agents": a graph plan's beings get their own Geist (`src/workflow/being-geist.ts`;
 * `plans/2026-10-20-typed-objects/notes-geist-for-beings.md`).
 *
 * Real implementations throughout. Calls go through the real host gate stack, the real proxy and MCP client, to an
 * in-process MCP cell that answers the way gardend does (`garden-document-cell.ts`). Set `CHOREOGRAPH_TEST_GARDEND` to
 * a gardend binary (e.g. `/usr/local/bin/gardend`) and the isolation test runs against a real gardend. It uses its own
 * throwaway profile and port, member and session-all tokens it mints, and the witness graphs gardend writes.
 */

import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { OBSERVER_TOOLS } from "../../packages/agent-body/src/host-tools.js";
import { type AgentOntologyBindingV1, digestAgentOntologyBinding } from "../agent-runtime/ontology-binding.js";
import { type AgentRuntimeBindingV2, digestAgentRuntimeBinding } from "../agent-runtime/profile.js";
import { mintAgentUri, mintStandaloneAgentId } from "../agent-subject/agent-ontology.js";
import { applyHostCapabilityGrantPolicy } from "../capabilities/grant-gate.js";
import {
	type CapabilityBackend,
	HOST_BOUND_OBSERVER_TOOLS,
	HostedMnemosyneProxy,
	wrapMnemosyneProxy,
} from "../mnemosyne.js";
import { SandboxStore } from "../sandbox-store.js";
import { SandboxSpawner, type SpawnOptions } from "../spawner.js";
import {
	BEING_GEIST_WRITE_TOOLS,
	beingGeistRef,
	beingMemoryPromptLines,
	beingWitnessGraphs,
	GRAPH_PLAN_BEING_MODE_IRI,
	graphPlanBeingFence,
	graphPlanBeingGraphAccess,
	graphPlanStepGrantPolicy,
	resolveBeingGeist,
} from "../workflow/being-geist.js";
import { compileGraphPlan, graphPlanDigest, triplesFromSparqlResult } from "../workflow/graph-plan.js";
import { buildGraphPlanInputs } from "../workflow/script-graph-plan.js";
import { GardenDocumentCell } from "./garden-document-cell.js";

const FIXTURE = JSON.parse(
	readFileSync(new URL("./fixtures/graph-plan-freud-ch1.sparql.json", import.meta.url), "utf8"),
) as unknown;
const GRAPH = "freud-dreams";
const OWNER = "user:default";

interface BuiltStep {
	readonly id: string;
	readonly label: string;
	readonly agent: {
		readonly agentId: string;
		readonly systemPrompt: string;
		readonly includeTools: readonly string[];
		readonly graphAccess: "read" | "write";
		readonly runtime: AgentRuntimeBindingV2;
		readonly ontology: AgentOntologyBindingV1;
	};
}

function planSteps(input: { liveTools?: readonly string[]; now?: number } = {}): BuiltStep[] {
	const plan = compileGraphPlan(triplesFromSparqlResult(FIXTURE));
	const digest = graphPlanDigest(plan);
	const built = buildGraphPlanInputs({
		graphId: GRAPH,
		graphOwnerPrincipal: OWNER,
		request: { definition: "urn:sophia:wf:freud-ch1:v1", digest, inputs: {} },
		plan,
		digest,
		runtimeBundle: { id: "sophia-agent-runtime", digest: "0".repeat(64) },
		inference: { provider: "openrouter", model: "test/model" },
		...(input.liveTools ? { liveTools: input.liveTools } : {}),
		now: input.now ?? 0,
	});
	return (built.args as { plan: { phases: { steps: BuiltStep[] }[] } }).plan.phases.flatMap((phase) => phase.steps);
}

/** The tools a gardend cell serves for these tests, with the scopes gardend requires (`local-loopback-surface.json`). */
const CELL_TOOLS = [
	{ name: "read_document", scopes: ["documents.read"] },
	{ name: "search_documents", scopes: ["documents.read"] },
	{ name: "write_document", scopes: ["documents.write.crdt"] },
	{ name: "recall", scopes: ["memory.read"] },
	{ name: "music", scopes: ["memory.read"] },
	{ name: "remember", scopes: ["memory.write"] },
	{ name: "sing", scopes: ["memory.write"] },
];

function cellProxy(cell: GardenDocumentCell, observerAgentId?: string): HostedMnemosyneProxy {
	return new HostedMnemosyneProxy({
		apiBaseUrl: cell.url,
		graphId: GRAPH,
		toolProfile: "full",
		directMcp: { mcpUrl: cell.url, accessToken: "member-token-for-tests" },
		...(observerAgentId ? { observerAgentId } : {}),
	});
}

/** The host's stack for one plan step, as the spawner builds it: the session wrapper inside the step's grant policy. */
function stepBackend(proxy: HostedMnemosyneProxy, step: BuiltStep, writes?: readonly string[]): CapabilityBackend {
	const options = writes ? { writes } : {};
	const session = wrapMnemosyneProxy(proxy, {
		reads: true,
		writes: graphPlanBeingGraphAccess(options) === "write",
		dangerous_ops: false,
	});
	const policy = graphPlanStepGrantPolicy(GRAPH, step.agent.includeTools, options);
	const gated = applyHostCapabilityGrantPolicy(new Map([["mnemosyne", session]]), policy).get("mnemosyne");
	assert.ok(gated);
	return gated;
}

const OTHER_BEING = mintStandaloneAgentId({ name: "graph-plan-v1:user:default/freud-dreams/other-plan/thief" });

describe("a graph plan's being and its Geist", () => {
	const cell = new GardenDocumentCell();
	before(async () => {
		cell.tools = CELL_TOOLS;
		await cell.start();
	});
	after(() => cell.stop());

	it("the mode a plan step runs in hands its being recall, and the host enforces that mode", () => {
		const steps = planSteps();
		assert.equal(steps.length, 3);
		const fence = graphPlanBeingFence(GRAPH);
		for (const step of steps) {
			const { agent } = step;
			assert.ok(agent.includeTools.includes("recall"), `${step.label} is handed recall`);
			for (const absent of ["remember", "music", "sing", "memory_semantic_recall", "value"]) {
				assert.ok(!agent.includeTools.includes(absent), `${step.label} is not handed ${absent}`);
			}
			assert.equal(agent.graphAccess, "read", "no Geist write is handed, so the session stays read-only");
			// The binding pins the being's mode, and the host gate enforces exactly that mode (orchestrator.ts).
			assert.deepEqual(agent.ontology.mode, { iri: GRAPH_PLAN_BEING_MODE_IRI, digest: fence.digest });
			const policy = graphPlanStepGrantPolicy(GRAPH, agent.includeTools);
			assert.equal(policy.mode?.digest, agent.ontology.mode?.digest);
			assert.ok(policy.exactTools.mnemosyne?.includes("recall"));
			assert.ok(!policy.exactTools.mnemosyne?.includes("remember"));
			// The witness is the being itself (ontology-binding.ts enforces observerId === agentId).
			assert.equal(agent.ontology.subject.observerId, agent.agentId);
		}
		// A cell that serves no recall hands none (the step's tools are the live intersection).
		const older = planSteps({ liveTools: ["read_document", "search_documents", "sparql_query"] });
		for (const step of older) assert.ok(!step.agent.includeTools.includes("recall"));
	});

	it("through the host's gate, recall reaches the cell bound to the being's own observer; memory writes do not", async () => {
		const [reader] = planSteps();
		const proxy = cellProxy(cell, reader.agent.ontology.subject.observerId);
		const backend = stepBackend(proxy, reader);
		try {
			const listed = (await backend.listTools()).map((tool) => tool.name);
			assert.ok(listed.includes("recall"), "the being sees recall");
			for (const absent of ["remember", "music", "sing", "write_document"]) {
				assert.ok(!listed.includes(absent), `the being does not see ${absent}`);
			}
			cell.calls.length = 0;
			await backend.callTool("recall", { query: "straw", observer_agent_id: OTHER_BEING });
			assert.equal(cell.calls.length, 1);
			assert.equal(cell.calls[0].tool, "recall");
			assert.equal(cell.calls[0].args.observer_agent_id, reader.agent.agentId);
			assert.equal(cell.calls[0].args.query, "straw");
			for (const tool of ["remember", "music", "sing"]) {
				await assert.rejects(backend.callTool(tool, { content: "x", observer_agent_id: reader.agent.agentId }));
			}
			assert.equal(cell.calls.length, 1, "no refused Geist call reached the cell");
		} finally {
			await backend.close();
		}
	});

	it("a caller cannot override the observer, in either spelling, on any tool", async () => {
		const being = mintStandaloneAgentId({ name: "graph-plan-v1:user:default/freud-dreams/freud-ch1/clerk" });
		const proxy = cellProxy(cell, being);
		try {
			cell.calls.length = 0;
			await proxy.callTool("recall", { observer_agent_id: OTHER_BEING, observerAgentId: OTHER_BEING, query: "" });
			await proxy.callTool("music", { observerAgentId: OTHER_BEING });
			await proxy.callTool("read_document", { document_id: "d1", observer_agent_id: OTHER_BEING });
			const [recall, music, read] = cell.calls;
			assert.equal(recall.args.observer_agent_id, being);
			assert.ok(!("observerAgentId" in recall.args), "the camelCase spelling is dropped, not forwarded");
			assert.equal(music.args.observer_agent_id, being);
			assert.ok(!("observerAgentId" in music.args));
			assert.ok(!("observer_agent_id" in read.args), "a tool with no observer gets none, never the caller's");
		} finally {
			await proxy.close();
		}
		// The host binds the same tools the body fills (packages/agent-body/src/host-tools.ts), so an honest body sees
		// no change.
		assert.deepEqual([...HOST_BOUND_OBSERVER_TOOLS].sort(), [...OBSERVER_TOOLS].sort());
		// A proxy with no agent (a host-side writer) passes arguments through untouched.
		const unbound = cellProxy(cell);
		try {
			cell.calls.length = 0;
			await unbound.callTool("recall", { observer_agent_id: OTHER_BEING });
			assert.equal(cell.calls[0].args.observer_agent_id, OTHER_BEING);
		} finally {
			await unbound.close();
		}
	});

	it("the spawner binds a plan step's own being as the observer of its graph proxy", async () => {
		const [, clerk] = planSteps();
		const saved = { ...process.env };
		const dir = mkdtempSync(join(tmpdir(), "being-geist-spawner-"));
		const store = new SandboxStore(join(dir, "sandboxes.sqlite"));
		try {
			process.env.MNEMOSYNE_MCP_URL = cell.url;
			process.env.MNEMOSYNE_MCP_ACCESS_TOKEN = "member-token-for-tests";
			for (const key of ["MNEMOSYNE_SERVICE_TOKEN", "MNEMOSYNE_GATEWAY_BASE_URL", "MNEMOSYNE_API_BASE_URL"]) {
				delete process.env[key];
			}
			const spawner = new SandboxSpawner(store, { parentPath: "/sys/fs/cgroup/test", version: 2 } as never, {});
			const internals = spawner as unknown as {
				buildAgentRequest(
					sandboxId: string,
					opts: SpawnOptions,
					config: Record<string, unknown>,
				): Promise<{ capabilityRegistry?: Map<string, CapabilityBackend> }>;
			};
			const built = await internals.buildAgentRequest(
				"sandbox-being-geist",
				{
					template: "agent",
					mnemosyne: {
						graphId: GRAPH,
						requiredTools: ["read_document"],
						capabilities: { reads: true, writes: false, dangerous_ops: false },
					},
				},
				{
					mode: "agent",
					intent: "The item: {}",
					agent_id: clerk.agent.agentId,
					session_id: "session-being-geist",
					generation: 0,
					runtime_binding: clerk.agent.runtime,
					runtime_binding_digest: digestAgentRuntimeBinding(clerk.agent.runtime),
					agent_ontology: clerk.agent.ontology,
					agent_ontology_binding_digest: digestAgentOntologyBinding(clerk.agent.ontology),
				},
			);
			const mnemosyne = built.capabilityRegistry?.get("mnemosyne");
			assert.ok(mnemosyne, "the step's graph capability is bound");
			try {
				cell.calls.length = 0;
				// What a body (or code in it) would send if it tried to read another being's memory.
				await mnemosyne.callTool("recall", { query: "", observer_agent_id: OTHER_BEING });
				assert.equal(cell.calls[0].args.observer_agent_id, clerk.agent.agentId);
			} finally {
				await mnemosyne.close();
			}
		} finally {
			process.env = saved;
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("geistObjectRef names the being's witness graphs, the same in every run, never a builtin: placeholder", () => {
		const first = planSteps({ now: 0 });
		const later = planSteps({ now: 1_792_000_000_000 });
		for (const [index, step] of first.entries()) {
			const ref = step.agent.ontology.objects.geist;
			assert.ok(!ref.objectId.startsWith("builtin:"), `${step.label}'s geist is no placeholder: ${ref.objectId}`);
			const witness = beingWitnessGraphs(GRAPH, step.agent.agentId);
			assert.equal(ref.objectId, `urn:mnemosyne:local:graph:${GRAPH}:projection:memory:agent:${step.agent.agentId}`);
			assert.deepEqual(resolveBeingGeist(ref), { ...witness, observer: step.agent.agentId });
			assert.equal(ref.graphId, GRAPH);
			// The same being, the same Geist, in a later run.
			assert.deepEqual(later[index].agent.ontology.objects.geist, ref);
			assert.equal(later[index].agent.agentId, step.agent.agentId);
		}
		// Keyed by the bare id, as gardend names the graphs. The IRI form would name another graph.
		const agentId = first[0].agent.agentId;
		assert.throws(() => beingWitnessGraphs(GRAPH, mintAgentUri(agentId)), /canonical agent id/);
		// A placeholder resolves to nothing.
		const placeholder = { ...beingGeistRef({ ownerPrincipal: OWNER, graphId: GRAPH, agentId }) };
		assert.equal(resolveBeingGeist({ ...placeholder, objectId: "builtin:graph-plan-v1:reader:geist" }), undefined);
		assert.equal(resolveBeingGeist({ ...placeholder, graphId: "another-graph" }), undefined);
	});

	it("the step prompt tells the being it has a memory, and claims only the tools it is handed", () => {
		const line =
			"You have a memory of your own that lasts across runs of this workflow: `recall` shows what is in it, which may be empty. Use it to notice what recurs, to remember what the source is like, and not to repeat a mistake.";
		for (const step of planSteps()) {
			assert.ok(step.agent.systemPrompt.includes(line), `${step.label} is told about its memory`);
			assert.doesNotMatch(step.agent.systemPrompt, /`remember`/, "it is not told it can remember");
			// The existing voice stays: the memory line sits before the submit rule.
			assert.ok(step.agent.systemPrompt.indexOf(line) < step.agent.systemPrompt.indexOf("call submit()"));
		}
		for (const step of planSteps({ liveTools: ["read_document", "search_documents"] })) {
			assert.doesNotMatch(step.agent.systemPrompt, /memory of your own/, "no recall, no memory line");
		}
		assert.match(beingMemoryPromptLines(["recall", "remember"])[0], /`remember` adds to it/);
		assert.deepEqual(beingMemoryPromptLines(["read_document"]), []);
	});

	it("the write half is one list away: with remember granted, the step writes only its own memory", async () => {
		assert.deepEqual(BEING_GEIST_WRITE_TOOLS, [], "today a member token may not write memory (memory.write)");
		const writes = ["remember"];
		const [reader] = planSteps();
		const step: BuiltStep = {
			...reader,
			agent: { ...reader.agent, includeTools: [...reader.agent.includeTools, "remember"] },
		};
		assert.equal(graphPlanBeingGraphAccess({ writes }), "write");
		assert.equal(graphPlanBeingFence(GRAPH, { writes }).mode.access, "write");
		const proxy = cellProxy(cell, reader.agent.agentId);
		const backend = stepBackend(proxy, step, writes);
		try {
			cell.calls.length = 0;
			await backend.callTool("remember", {
				content: "The source is terse.",
				block_ids: ["b1"],
				observer_agent_id: OTHER_BEING,
			});
			assert.equal(cell.calls[0].tool, "remember");
			assert.equal(cell.calls[0].args.observer_agent_id, reader.agent.agentId);
			for (const tool of ["write_document", "sing", "music"]) {
				await assert.rejects(backend.callTool(tool, { content: "x" }), /outside|not permitted|mode/);
			}
			assert.equal(cell.calls.length, 1);
		} finally {
			await backend.close();
		}
	});
});

const GARDEND = process.env.CHOREOGRAPH_TEST_GARDEND?.trim();

describe(
	"against a real gardend (CHOREOGRAPH_TEST_GARDEND)",
	{ skip: GARDEND ? false : "set CHOREOGRAPH_TEST_GARDEND to a gardend binary" },
	() => {
		let child: ChildProcess | undefined;
		let profile = "";
		let mcpUrl = "";
		const tokens: Record<"member" | "admin", string> = { member: "", admin: "" };
		const LIVE = "being-geist";

		before(async () => {
			profile = mkdtempSync(join(tmpdir(), "being-geist-gardend-"));
			for (const [who, grant] of [
				["member", "member"],
				["admin", "session-all"],
			] as const) {
				const out = execFileSync(
					GARDEND!,
					[
						"token",
						"create",
						"--label",
						`being-geist-${who}`,
						"--grant",
						grant,
						"--profile-dir",
						profile,
						"--json",
					],
					{ encoding: "utf8" },
				);
				tokens[who] = (JSON.parse(out) as { token: string }).token;
			}
			const port = await new Promise<number>((resolve) => {
				const probe = createServer().listen(0, "127.0.0.1", () => {
					const address = probe.address();
					probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
				});
			});
			const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GARDEN_")));
			// gardend prints its master key on start; nothing here reads or prints its output.
			child = spawn(GARDEND!, ["serve", "--profile", profile, "--port", String(port)], { env, stdio: "ignore" });
			mcpUrl = `http://127.0.0.1:${port}/mcp`;
			const deadline = Date.now() + 30_000;
			for (;;) {
				try {
					const response = await fetch(mcpUrl, {
						method: "POST",
						headers: {
							authorization: `Bearer ${tokens.admin}`,
							"content-type": "application/json",
							accept: "application/json, text/event-stream",
						},
						body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
					});
					if (response.ok) break;
				} catch {
					// not listening yet
				}
				if (Date.now() > deadline) throw new Error("gardend did not start within 30 s");
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
		});
		after(() => {
			child?.kill("SIGTERM");
			if (profile) rmSync(profile, { recursive: true, force: true });
		});

		const proxy = (who: "member" | "admin", observerAgentId?: string) =>
			new HostedMnemosyneProxy({
				apiBaseUrl: mcpUrl,
				graphId: LIVE,
				toolProfile: "full",
				directMcp: { mcpUrl, accessToken: tokens[who] },
				...(observerAgentId ? { observerAgentId } : {}),
			});
		const structured = (value: unknown) =>
			(value as { structuredContent?: Record<string, unknown> }).structuredContent ??
			(JSON.parse(String((value as { content: { text: string }[] }).content[0].text)) as Record<string, unknown>);

		it("each being reads only its own memory, a forged observer reads its own, and a member cannot write memory", async () => {
			const plan = compileGraphPlan(triplesFromSparqlResult(FIXTURE));
			const name = (step: string) => `graph-plan-v1:${OWNER}/${LIVE}/${plan.name}/${step}`;
			const clerk = mintStandaloneAgentId({ name: name("clerk") });
			const censor = mintStandaloneAgentId({ name: name("censor") });

			// The owner (a session-all token, not Compute) gives the Clerk one memory, as gardend files a witnessed one.
			const admin = proxy("admin");
			try {
				await admin.callTool("create_graph", { title: "Being Geist" });
				const created = structured(await admin.callTool("create_document", { title: "Book", content: "Straw." }));
				const documentId = String(created.documentId);
				const blocks = structured(await admin.callTool("read_blocks", { document_id: documentId })) as {
					blocks: { blockId: string }[];
				};
				const stored = structured(
					await admin.callTool("remember", {
						observer_agent_id: clerk,
						content: "The book's experiments are short.",
						document_id: documentId,
						block_ids: [blocks.blocks[0].blockId],
					}),
				);
				assert.equal(stored.ok, true);
				assert.match(String(stored.subject), new RegExp(`:projection:memory:agent:${clerk}:`));
			} finally {
				await admin.close();
			}

			const clerkProxy = proxy("member", clerk);
			const censorProxy = proxy("member", censor);
			try {
				const own = structured(await clerkProxy.callTool("recall", { query: "" })) as {
					memories: { content: string }[];
					observer_agent_id: string;
				};
				assert.deepEqual(
					own.memories.map((memory) => memory.content),
					["The book's experiments are short."],
				);
				// The Censor names the Clerk as its observer; the host binds the Censor, so gardend reads the Censor's graph.
				const forged = structured(
					await censorProxy.callTool("recall", { query: "", observer_agent_id: clerk }),
				) as {
					memories: unknown[];
					observer_agent_id: string;
				};
				assert.equal(forged.observer_agent_id, censor);
				assert.deepEqual(forged.memories, []);
				// The write half is blocked by the grant, not by Choreograph: gardend refuses a member's remember.
				await assert.rejects(censorProxy.callTool("remember", { content: "x", block_ids: ["b"] }), /memory\.write/);
			} finally {
				await clerkProxy.close();
				await censorProxy.close();
			}
		});
	},
);
