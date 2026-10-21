/**
 * D10, "humane agents": a graph plan's beings get their own Geist (`src/workflow/being-geist.ts`;
 * `plans/2026-10-20-typed-objects/notes-geist-for-beings.md`).
 *
 * Real implementations throughout. Calls go through the real host gate stack, the real proxy and MCP client, to an
 * in-process MCP cell that answers the way gardend does (`garden-document-cell.ts`). Set `CHOREOGRAPH_TEST_GARDEND` to
 * a gardend binary (one with `memory.write.observed`, gardend `loopback_agent_memory.rs`) and the isolation test runs
 * against a real gardend. It uses its own throwaway profile, port and services folder, member and session-all tokens
 * it mints, the token gardend mints for Compute under Choreograph's own manifest, and the witness graphs gardend writes.
 */

import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { SERVICE } from "../../deploy/gardend-service-manifest.mjs";
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

	it("the mode a plan step runs in hands its being its Geist, and the host enforces that mode", () => {
		const steps = planSteps();
		assert.equal(steps.length, 3);
		const fence = graphPlanBeingFence(GRAPH);
		assert.equal(fence.mode.access, "write");
		for (const step of steps) {
			const { agent } = step;
			for (const handed of ["recall", "remember", "music", "sing"]) {
				assert.ok(agent.includeTools.includes(handed), `${step.label} is handed ${handed}`);
			}
			for (const absent of ["memory_semantic_recall", "value", "remember_batch", "write_document"]) {
				assert.ok(!agent.includeTools.includes(absent), `${step.label} is not handed ${absent}`);
			}
			assert.equal(agent.graphAccess, "write", "the being writes its own memory and Song, and nothing else");
			// The binding pins the being's mode, and the host gate enforces exactly that mode (orchestrator.ts).
			assert.deepEqual(agent.ontology.mode, { iri: GRAPH_PLAN_BEING_MODE_IRI, digest: fence.digest });
			const policy = graphPlanStepGrantPolicy(GRAPH, agent.includeTools);
			assert.equal(policy.mode?.digest, agent.ontology.mode?.digest);
			for (const tool of ["recall", "remember", "music", "sing"])
				assert.ok(policy.exactTools.mnemosyne?.includes(tool));
			assert.ok(!policy.exactTools.mnemosyne?.includes("write_document"));
			// The witness is the being itself (ontology-binding.ts enforces observerId === agentId).
			assert.equal(agent.ontology.subject.observerId, agent.agentId);
		}
		// A cell that serves no Geist hands none (the step's tools are the live intersection), and the step is read-only.
		const older = planSteps({ liveTools: ["read_document", "search_documents", "sparql_query"] });
		for (const step of older) {
			for (const tool of ["recall", "remember", "music", "sing"]) assert.ok(!step.agent.includeTools.includes(tool));
			assert.equal(step.agent.graphAccess, "read");
		}
	});

	it("through the host's gate, the being's Geist calls reach the cell bound to its own observer; no other write does", async () => {
		const [reader] = planSteps();
		const proxy = cellProxy(cell, reader.agent.ontology.subject.observerId);
		const backend = stepBackend(proxy, reader);
		try {
			const listed = (await backend.listTools()).map((tool) => tool.name);
			for (const tool of ["recall", "remember", "music", "sing"])
				assert.ok(listed.includes(tool), `the being sees ${tool}`);
			assert.ok(!listed.includes("write_document"), "the being does not see write_document");
			cell.calls.length = 0;
			await backend.callTool("recall", { query: "straw", observer_agent_id: OTHER_BEING });
			await backend.callTool("remember", {
				content: "The source is terse.",
				block_ids: ["b1"],
				observerAgentId: OTHER_BEING,
			});
			await backend.callTool("sing", { verse: "I read slowly.", observer_agent_id: OTHER_BEING });
			await backend.callTool("music", { observerAgentId: OTHER_BEING });
			assert.deepEqual(
				cell.calls.map((call) => call.tool),
				["recall", "remember", "sing", "music"],
			);
			for (const call of cell.calls) {
				assert.equal(call.args.observer_agent_id, reader.agent.agentId, `${call.tool} is bound to the being`);
				assert.ok(!("observerAgentId" in call.args));
			}
			assert.equal(cell.calls[0].args.query, "straw");
			await assert.rejects(backend.callTool("write_document", { document_id: "d1", content: "x" }));
			assert.equal(cell.calls.length, 4, "the refused write never reached the cell");
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
			"You have a memory of your own that lasts across runs of this workflow: `recall` shows what is in it, and `remember` adds to it (name the blocks a note comes from); `music` shows your Song and `sing` adds a verse to it. Use it to notice what recurs, to remember what the source is like, and not to repeat a mistake.";
		for (const step of planSteps()) {
			assert.ok(step.agent.systemPrompt.includes(line), `${step.label} is told about its memory`);
			// The existing voice stays: the memory line sits before the submit rule.
			assert.ok(step.agent.systemPrompt.indexOf(line) < step.agent.systemPrompt.indexOf("call submit()"));
		}
		for (const step of planSteps({ liveTools: ["read_document", "search_documents"] })) {
			assert.doesNotMatch(step.agent.systemPrompt, /memory of your own/, "no Geist, no memory line");
		}
		// A cell that serves recall and music but not the writes: the line claims only the reads.
		for (const step of planSteps({ liveTools: ["read_document", "search_documents", "recall", "music"] })) {
			assert.match(
				step.agent.systemPrompt,
				/`recall` shows what is in it, which may be empty; `music` shows your Song, which may not be sung yet\./,
			);
			assert.doesNotMatch(step.agent.systemPrompt, /`remember`|`sing`/);
		}
		assert.deepEqual(beingMemoryPromptLines(["read_document"]), []);
	});

	it("Choreograph's gardend manifest asks for its beings' memory (agentMemory)", () => {
		// gardend then adds memory.write.observed and salience.write.observed to Compute's own token.
		assert.equal(SERVICE.serviceId, "choreograph");
		assert.equal(SERVICE.agentMemory, true);
	});

	it("the write half is the one list: remember and sing; with it emptied, the step is read-only again", async () => {
		assert.deepEqual(BEING_GEIST_WRITE_TOOLS, ["remember", "sing"]);
		const writes: readonly string[] = [];
		assert.equal(graphPlanBeingGraphAccess({ writes }), "read");
		assert.equal(graphPlanBeingFence(GRAPH, { writes }).mode.access, "read");
		const [reader] = planSteps();
		const step: BuiltStep = {
			...reader,
			agent: {
				...reader.agent,
				includeTools: reader.agent.includeTools.filter((tool) => !BEING_GEIST_WRITE_TOOLS.includes(tool)),
			},
		};
		const proxy = cellProxy(cell, reader.agent.agentId);
		const backend = stepBackend(proxy, step, writes);
		try {
			cell.calls.length = 0;
			await backend.callTool("recall", { query: "" });
			for (const tool of ["remember", "sing", "write_document"]) {
				await assert.rejects(backend.callTool(tool, { content: "x", block_ids: ["b1"] }));
			}
			assert.deepEqual(
				cell.calls.map((call) => call.tool),
				["recall"],
			);
		} finally {
			await backend.close();
		}
	});
});

const GARDEND = process.env.CHOREOGRAPH_TEST_GARDEND?.trim();

/**
 * Stands in for Compute's bundled app under gardend's own manifest for it: it hands the test the MCP token gardend
 * minted for the service (into a file only the owner may read, in the throwaway profile) and answers /health.
 */
const COMPUTE_STAND_IN = `import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
writeFileSync(process.env.BEING_GEIST_TOKEN_FILE, process.env.MNEMOSYNE_MCP_ACCESS_TOKEN ?? "", { mode: 0o600 });
createServer((_request, response) => {
	response.writeHead(200, { "content-type": "application/json" });
	response.end('{"ok":true}');
}).listen(Number(process.env.PORT), process.env.CHOREOGRAPH_BIND_HOST ?? "127.0.0.1");
`;

describe(
	"against a real gardend (CHOREOGRAPH_TEST_GARDEND)",
	{ skip: GARDEND ? false : "set CHOREOGRAPH_TEST_GARDEND to a gardend binary" },
	() => {
		let child: ChildProcess | undefined;
		let profile = "";
		let services = "";
		let mcpUrl = "";
		const tokens: Record<"member" | "admin" | "compute", string> = { member: "", admin: "", compute: "" };
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
			// Compute, as gardend supervises it: Choreograph's own manifest (deploy/gardend-service-manifest.mjs), its
			// command swapped for the stand-in and started at boot. gardend mints the service's token and grants it.
			services = mkdtempSync(join(tmpdir(), "being-geist-services-"));
			const serviceDir = join(services, SERVICE.serviceId);
			mkdirSync(serviceDir);
			const tokenFile = join(profile, "compute-token");
			writeFileSync(join(serviceDir, "stand-in.mjs"), COMPUTE_STAND_IN);
			writeFileSync(
				join(serviceDir, "service.json"),
				JSON.stringify({
					...SERVICE,
					command: process.execPath,
					args: ["stand-in.mjs"],
					autostart: true,
					env: [...SERVICE.env, { name: "BEING_GEIST_TOKEN_FILE", value: tokenFile }],
				}),
			);
			const port = await new Promise<number>((resolve) => {
				const probe = createServer().listen(0, "127.0.0.1", () => {
					const address = probe.address();
					probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
				});
			});
			const env = {
				...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GARDEN_"))),
				GARDEN_SERVICES_DIR: services,
			};
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
					if (response.ok && existsSync(tokenFile) && readFileSync(tokenFile, "utf8")) break;
				} catch {
					// not listening yet
				}
				if (Date.now() > deadline) throw new Error("gardend and its Compute did not start within 30 s");
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			tokens.compute = readFileSync(tokenFile, "utf8");
		});
		after(() => {
			child?.kill("SIGTERM");
			if (profile) rmSync(profile, { recursive: true, force: true });
			if (services) rmSync(services, { recursive: true, force: true });
		});

		const proxy = (who: "member" | "admin" | "compute", observerAgentId?: string) =>
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
		const contents = (value: unknown) =>
			(structured(value) as { memories: { content: string }[] }).memories.map((memory) => memory.content);
		const using = async <T>(run: HostedMnemosyneProxy, body: (run: HostedMnemosyneProxy) => Promise<T>) => {
			try {
				return await body(run);
			} finally {
				await run.close();
			}
		};

		it("a being remembers across runs, and only it: not another being, not the commons, not under a forged id", async () => {
			const plan = compileGraphPlan(triplesFromSparqlResult(FIXTURE));
			const name = (step: string) => `graph-plan-v1:${OWNER}/${LIVE}/${plan.name}/${step}`;
			const clerk = mintStandaloneAgentId({ name: name("clerk") });
			const censor = mintStandaloneAgentId({ name: name("censor") });

			// The owner makes the graph and a source to ground the memory in.
			const { documentId, blockId } = await using(proxy("admin"), async (admin) => {
				await admin.callTool("create_graph", { title: "Being Geist" });
				const created = structured(await admin.callTool("create_document", { title: "Book", content: "Straw." }));
				const read = structured(
					await admin.callTool("read_blocks", { document_id: String(created.documentId) }),
				) as {
					blocks: { blockId: string }[];
				};
				return { documentId: String(created.documentId), blockId: read.blocks[0].blockId };
			});

			// Run 1: the Clerk, through Compute's own token, its observer bound by the host.
			await using(proxy("compute", clerk), async (run) => {
				const stored = structured(
					await run.callTool("remember", {
						content: "The book's experiments are short.",
						document_id: documentId,
						block_ids: [blockId],
					}),
				);
				assert.equal(stored.ok, true);
				assert.match(String(stored.subject), new RegExp(`:projection:memory:agent:${clerk}:`));
				const silent = structured(await run.callTool("music", {}));
				assert.deepEqual(silent.verses, [], "a being that never sang has no Song, not a seeded one");
				await run.callTool("sing", { verse: "I read slowly." });
			});

			// Run 2: the same being, a later run.
			await using(proxy("compute", clerk), async (run) => {
				assert.deepEqual(contents(await run.callTool("recall", { query: "" })), [
					"The book's experiments are short.",
				]);
				const song = structured(await run.callTool("music", {})) as { verses: string[] };
				assert.equal(song.verses.length, 1);
				assert.match(song.verses[0], /I read slowly\./);
			});

			// The Censor names the Clerk as its observer; the host binds the Censor, so gardend reads and writes the
			// Censor's graphs.
			await using(proxy("compute", censor), async (run) => {
				const forged = structured(await run.callTool("recall", { query: "", observer_agent_id: clerk })) as {
					memories: unknown[];
					observer_agent_id: string;
				};
				assert.equal(forged.observer_agent_id, censor);
				assert.deepEqual(forged.memories, []);
				const planted = structured(
					await run.callTool("remember", {
						content: "Planted in the Clerk's memory.",
						document_id: documentId,
						block_ids: [blockId],
						observerAgentId: clerk,
					}),
				);
				assert.match(String(planted.subject), new RegExp(`:projection:memory:agent:${censor}:`));
			});
			await using(proxy("compute", clerk), async (run) => {
				assert.deepEqual(contents(await run.callTool("recall", { query: "" })), [
					"The book's experiments are short.",
				]);
			});

			// The commons holds none of it, and only a being's own observer admits a Compute write.
			await using(proxy("member"), async (person) => {
				assert.deepEqual(contents(await person.callTool("recall", { query: "" })), []);
				await assert.rejects(
					person.callTool("remember", { content: "x", document_id: documentId, block_ids: [blockId] }),
					/memory\.write/,
				);
			});
			await using(proxy("compute"), async (unbound) => {
				await assert.rejects(
					unbound.callTool("remember", { content: "x", document_id: documentId, block_ids: [blockId] }),
					/memory\.write/,
				);
			});
		});
	},
);
