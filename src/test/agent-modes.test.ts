import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Store, type Term } from "oxigraph";
import {
	AgentModeApprovalRequiredError,
	AgentModeDeniedError,
	AgentModeError,
	type AgentModeFenceV1,
	type AgentModeV1,
	agentModeDigest,
	attenuateToolsForMode,
	buildAgentModeCatalogQuery,
	parseAgentModeCatalog,
	requiredScopesFromToolMeta,
	resolveSessionMode,
	toolEffectClass,
} from "../agent-runtime/agent-mode.js";
import { buildAgentSessionFamilyProjection } from "../agent-runtime/agent-session-family-graph-projection.js";
import { digestAgentOntologyBinding } from "../agent-runtime/ontology-binding.js";
import { mintAgentSessionUri, mintStandaloneAgentId } from "../agent-subject/agent-ontology.js";
import { applyHostCapabilityGrantPolicy } from "../capabilities/grant-gate.js";
import type { CapabilityBackend, HostedMcpToolDescriptor } from "../mnemosyne.js";
import {
	type AgentModeReader,
	readAgentModeCatalogFromGraph,
	rereadPinnedAgentMode,
} from "../workflow/agent-mode-reader.js";
import { pinnedAgentSessionModeRef, WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";
import { CellRdfStore, type SeedModeInput, seedAgentModes } from "./cell-rdf-store.js";

const GRAPH = "modes-lab";
const AGENT_ID = mintStandaloneAgentId({ name: "scout" });

/** gardend's live tool registry scopes for the tools these tests touch. */
const CELL_TOOLS: readonly HostedMcpToolDescriptor[] = [
	{ name: "search_documents", destructive: false, requiredScopes: ["documents.read"] },
	{ name: "read_document", destructive: false, requiredScopes: ["documents.read"] },
	{ name: "sparql_query", destructive: false, requiredScopes: ["rdf.query"] },
	{ name: "rdf_dump", destructive: false, requiredScopes: ["rdf.dump"] },
	{ name: "write_document", destructive: true, requiredScopes: ["documents.write"] },
	{ name: "sparql_update", destructive: true, requiredScopes: ["rdf.update"] },
	// A cell that omits _meta for a tool: its effect class is unknown ⇒ write.
	{ name: "mystery_tool", destructive: false },
];

/** A real in-process graph MCP backend: every call is recorded and answered. */
function cellBackend(capabilityName = "mnemosyne"): CapabilityBackend & { calls: string[] } {
	const calls: string[] = [];
	return {
		capabilityName,
		accessLevel: "rw",
		calls,
		async callTool(tool) {
			calls.push(tool);
			return { ok: true, tool };
		},
		async listTools() {
			return CELL_TOOLS.map((tool) => ({ ...tool }));
		},
		async close() {},
	};
}

function mode(overrides: Partial<AgentModeV1> = {}): AgentModeV1 {
	return {
		iri: "urn:sophia:mode:researcher",
		label: "Researcher",
		access: "read",
		allowsTool: ["read_document", "search_documents", "sparql_query", "write_document"],
		graphScope: [],
		requiresApproval: [],
		...overrides,
	};
}

function fence(value: AgentModeV1, boundGraphId = GRAPH): AgentModeFenceV1 {
	return { mode: value, digest: agentModeDigest(value), boundGraphId };
}

const ALL_GRANTED = CELL_TOOLS.map((tool) => tool.name);

function catalogFrom(seed: { modes: readonly SeedModeInput[]; defaultMode?: string; mayUseModes?: string[] }) {
	const cell = new CellRdfStore();
	seedAgentModes(cell, GRAPH, { agentId: AGENT_ID, ...seed });
	return { cell, catalog: parseAgentModeCatalog(AGENT_ID, cell.query(buildAgentModeCatalogQuery(AGENT_ID, GRAPH))) };
}

describe("Choreograph modes v1 — the pure contract", () => {
	it("classifies tool effect from gardend requiredScopes, unknown ⇒ write", () => {
		assert.equal(toolEffectClass(["documents.read"]), "read");
		assert.equal(toolEffectClass(["rdf.query", "rdf.dump", "graph.read"]), "read");
		assert.equal(toolEffectClass(["documents.read", "documents.write"]), "write");
		assert.equal(toolEffectClass([]), "write");
		assert.equal(toolEffectClass(undefined), "write");
		assert.deepEqual(requiredScopesFromToolMeta({ "sophia.local.requiredScopes": ["rdf.query"] }), ["rdf.query"]);
		assert.equal(requiredScopesFromToolMeta({ "sophia.local.requiredScopes": [1] }), undefined);
	});

	it("parses the UI's triples from a real SPARQL cell and digests them order-independently", () => {
		const { catalog } = catalogFrom({
			modes: [
				{
					slug: "researcher",
					label: "Researcher",
					access: ["read"],
					allowsTool: ["sparql_query", "search_documents", "write_document"],
					graphScope: ["modes-lab", "sophia-cluster"],
					requiresApproval: ["write_document"],
					imageTransform: "noir",
				},
				{ slug: "editor", label: "Editor", access: ["write"], allowsTool: ["write_document"] },
			],
			defaultMode: "researcher",
			mayUseModes: ["researcher", "editor"],
		});
		assert.equal(catalog.defaultMode, "urn:sophia:mode:researcher");
		assert.deepEqual(catalog.mayUseModes, ["urn:sophia:mode:editor", "urn:sophia:mode:researcher"]);
		const researcher = catalog.modes.get("urn:sophia:mode:researcher");
		assert.deepEqual(researcher, {
			iri: "urn:sophia:mode:researcher",
			label: "Researcher",
			access: "read",
			allowsTool: ["search_documents", "sparql_query", "write_document"],
			graphScope: ["urn:graph:modes-lab", "urn:graph:sophia-cluster"],
			requiresApproval: ["write_document"],
		});
		const shuffled: AgentModeV1 = {
			...researcher!,
			allowsTool: ["sparql_query", "search_documents", "write_document", "sparql_query"],
			graphScope: [...researcher!.graphScope].reverse(),
		};
		assert.equal(agentModeDigest(shuffled), agentModeDigest(researcher!));
		assert.match(agentModeDigest(researcher!), /^[0-9a-f]{64}$/);
		assert.notEqual(agentModeDigest({ ...researcher!, access: "write" }), agentModeDigest(researcher!));
	});

	it("ignores mode assignments and definitions in unrelated named graphs", () => {
		const cell = new CellRdfStore();
		cell.updateRaw(`PREFIX agt: <http://mnemosyne.dev/agent#>
INSERT DATA { GRAPH <urn:elsewhere> {
  <urn:sophia:agent:${AGENT_ID}> agt:defaultMode <urn:sophia:mode:intruder> .
  <urn:sophia:mode:intruder> a agt:Mode ; agt:access "write" ; agt:allowsTool "sparql_update" .
} }`);
		const catalog = parseAgentModeCatalog(AGENT_ID, cell.query(buildAgentModeCatalogQuery(AGENT_ID, GRAPH)));
		assert.equal(catalog.defaultMode, undefined);
		assert.equal(catalog.modes.size, 0);
	});

	it("fails the access ceiling closed: missing, duplicate or unknown ⇒ read", () => {
		const { catalog } = catalogFrom({
			modes: [
				{ slug: "none", label: "None", allowsTool: ["x"] },
				{ slug: "both", label: "Both", access: ["read", "write"], allowsTool: ["x"] },
				{ slug: "root", label: "Root", access: ["admin"], allowsTool: ["x"] },
				{ slug: "writer", label: "Writer", access: ["write"], allowsTool: ["x"] },
			],
			mayUseModes: ["none", "both", "root", "writer"],
		});
		assert.equal(catalog.modes.get("urn:sophia:mode:none")?.access, "read");
		assert.equal(catalog.modes.get("urn:sophia:mode:both")?.access, "read");
		assert.equal(catalog.modes.get("urn:sophia:mode:root")?.access, "read");
		assert.equal(catalog.modes.get("urn:sophia:mode:writer")?.access, "write");
	});

	it("refuses an unrecognizable query result instead of treating it as 'no modes'", () => {
		assert.throws(
			() => parseAgentModeCatalog(AGENT_ID, {}),
			(error: unknown) => error instanceof AgentModeError && error.code === "mode_unavailable",
		);
		assert.throws(
			() => parseAgentModeCatalog(AGENT_ID, { resultType: "boolean", rows: [], boolean: true }),
			(error: unknown) => error instanceof AgentModeError && error.code === "mode_unavailable",
		);
	});

	it("selects default, validates per-session overrides, and rejects unknown or absent modes", () => {
		const { catalog } = catalogFrom({
			modes: [
				{ slug: "researcher", label: "R", access: ["read"], allowsTool: ["search_documents"] },
				{ slug: "editor", label: "E", access: ["write"], allowsTool: ["write_document"] },
				{ slug: "admin", label: "A", access: ["write"], allowsTool: ["sparql_update"] },
			],
			defaultMode: "researcher",
			mayUseModes: ["researcher", "editor", "ghost"],
		});
		assert.equal(resolveSessionMode(catalog)?.iri, "urn:sophia:mode:researcher");
		assert.equal(resolveSessionMode(catalog, "urn:sophia:mode:editor")?.iri, "urn:sophia:mode:editor");
		assert.throws(
			() => resolveSessionMode(catalog, "urn:sophia:mode:admin"),
			(error: unknown) => error instanceof AgentModeError && error.code === "mode_not_permitted",
		);
		assert.throws(
			() => resolveSessionMode(catalog, "urn:sophia:mode:ghost"),
			(error: unknown) => error instanceof AgentModeError && error.code === "mode_unknown",
		);
		assert.throws(
			() => resolveSessionMode(catalog, "urn:graph:modes-lab"),
			(error: unknown) => error instanceof AgentModeError && error.code === "mode_invalid",
		);
		const empty = catalogFrom({ modes: [] }).catalog;
		assert.equal(resolveSessionMode(empty), undefined, "an agent without modes keeps today's behavior");
		const undecided = catalogFrom({
			modes: [{ slug: "editor", label: "E", access: ["write"], allowsTool: ["x"] }],
			mayUseModes: ["editor"],
		}).catalog;
		assert.throws(
			() => resolveSessionMode(undecided),
			(error: unknown) => error instanceof AgentModeError && error.code === "mode_required",
		);
	});

	it("attenuates only: grant ∩ allowsTool, minus non-read tools under a read ceiling", () => {
		const effect = new Map(CELL_TOOLS.map((tool) => [tool.name, toolEffectClass(tool.requiredScopes)] as const));
		const granted = ["search_documents", "write_document", "mystery_tool"];
		const readMode = mode({ allowsTool: ["search_documents", "write_document", "read_document", "mystery_tool"] });
		assert.deepEqual(
			attenuateToolsForMode(granted, readMode, (tool) => effect.get(tool)),
			["search_documents"],
			"read_document is allowed by the mode but not granted: never escalated",
		);
		assert.deepEqual(
			attenuateToolsForMode(granted, { ...readMode, access: "write" }, (tool) => effect.get(tool)),
			["search_documents", "write_document", "mystery_tool"],
		);
	});
});

describe("Choreograph modes v1 — enforcement at the host grant gate", () => {
	it("filters tools/list to grant ∩ mode ∩ read ceiling", async () => {
		const gated = applyHostCapabilityGrantPolicy(new Map([["mnemosyne", cellBackend()]]), {
			exactTools: { mnemosyne: ["search_documents", "sparql_query", "write_document", "mystery_tool"] },
			mode: fence(mode({ allowsTool: ["search_documents", "write_document", "read_document", "mystery_tool"] })),
		});
		const listed = await gated.get("mnemosyne")!.listTools();
		assert.deepEqual(
			listed.map((tool) => tool.name),
			["search_documents"],
		);
		assert.equal("requiredScopes" in listed[0]!, false, "host classification input never reaches the worker");
	});

	it("denies calls outside the mode, and under the read ceiling write or unknown-effect tools", async () => {
		const raw = cellBackend();
		const gated = applyHostCapabilityGrantPolicy(new Map([["mnemosyne", raw]]), {
			exactTools: { mnemosyne: ALL_GRANTED },
			mode: fence(mode({ allowsTool: ["search_documents", "write_document", "mystery_tool"] })),
		}).get("mnemosyne")!;
		await gated.callTool("search_documents", { query: "q" });
		await assert.rejects(
			gated.callTool("sparql_query", {}),
			(error: unknown) => error instanceof AgentModeDeniedError && error.reason === "tool_outside_mode",
		);
		await assert.rejects(
			gated.callTool("write_document", {}),
			(error: unknown) => error instanceof AgentModeDeniedError && error.reason === "write_in_read_mode",
		);
		await assert.rejects(
			gated.callTool("mystery_tool", {}),
			(error: unknown) =>
				error instanceof AgentModeDeniedError && /effect class is unknown/.test((error as Error).message),
		);
		assert.deepEqual(raw.calls, ["search_documents"]);
	});

	it("never lets a mode escalate past the exact grant", async () => {
		const raw = cellBackend();
		const gated = applyHostCapabilityGrantPolicy(new Map([["mnemosyne", raw]]), {
			exactTools: { mnemosyne: ["search_documents"] },
			mode: fence(mode({ access: "write", allowsTool: ["search_documents", "write_document"] })),
		}).get("mnemosyne")!;
		assert.deepEqual(
			(await gated.listTools()).map((tool) => tool.name),
			["search_documents"],
		);
		await assert.rejects(gated.callTool("write_document", {}), /outside the exact host grant/);
		assert.deepEqual(raw.calls, []);
	});

	it("fences graph scope on the bound graph and on caller graph arguments", async () => {
		const scoped = mode({
			access: "write",
			allowsTool: ["search_documents", "write_document"],
			graphScope: ["urn:graph:modes-lab"],
		});
		const raw = cellBackend();
		const gated = applyHostCapabilityGrantPolicy(new Map([["mnemosyne", raw]]), {
			exactTools: { mnemosyne: ALL_GRANTED },
			mode: fence(scoped),
		}).get("mnemosyne")!;
		await gated.callTool("search_documents", { graph_id: "modes-lab" });
		await gated.callTool("write_document", { graphId: "modes-lab" });
		await gated.callTool("search_documents", {});
		for (const args of [{ graph_id: "sophia-cluster" }, { graphId: "elsewhere" }, { graph_id: 7 }]) {
			await assert.rejects(
				gated.callTool("search_documents", args),
				(error: unknown) => error instanceof AgentModeDeniedError && error.reason === "graph_outside_scope",
			);
		}
		const outside = applyHostCapabilityGrantPolicy(new Map([["mnemosyne", cellBackend()]]), {
			exactTools: { mnemosyne: ALL_GRANTED },
			mode: fence(scoped, "sophia-cluster"),
		}).get("mnemosyne")!;
		await assert.rejects(
			outside.callTool("search_documents", {}),
			(error: unknown) => error instanceof AgentModeDeniedError && error.reason === "graph_outside_scope",
		);
		assert.equal(raw.calls.length, 3);
	});

	it("denies approval-required tools with a structured approval_required error", async () => {
		const raw = cellBackend();
		const gated = applyHostCapabilityGrantPolicy(new Map([["mnemosyne", raw]]), {
			exactTools: { mnemosyne: ALL_GRANTED },
			mode: fence(
				mode({
					access: "write",
					allowsTool: ["search_documents", "write_document"],
					requiresApproval: ["write_document"],
				}),
			),
		}).get("mnemosyne")!;
		assert.deepEqual(
			(await gated.listTools()).map((tool) => tool.name),
			["search_documents", "write_document"],
			"approval-required tools stay visible; only the call is held",
		);
		await assert.rejects(gated.callTool("write_document", {}), (error: unknown) => {
			assert.ok(error instanceof AgentModeApprovalRequiredError);
			assert.equal(error.code, "approval_required");
			assert.equal(error.tool, "write_document");
			assert.equal(error.modeIri, "urn:sophia:mode:researcher");
			return true;
		});
		assert.deepEqual(raw.calls, []);
	});

	it("governs every graph binding (mcp, sparql) and leaves other capabilities to their grant", async () => {
		const sparqlFace: CapabilityBackend & { calls: string[] } = {
			...cellBackend("sparql"),
			async listTools() {
				return [{ name: "query", destructive: false }];
			},
		};
		const other = cellBackend("discord");
		const gated = applyHostCapabilityGrantPolicy(
			new Map<string, CapabilityBackend>([
				["mcp", cellBackend("mcp")],
				["sparql", sparqlFace],
				["discord", other],
			]),
			{
				exactTools: { mcp: ALL_GRANTED, sparql: ["query"], discord: ["post_message"] },
				mode: fence(mode({ allowsTool: ["sparql_query"] })),
			},
		);
		assert.deepEqual(
			(await gated.get("mcp")!.listTools()).map((tool) => tool.name),
			["sparql_query"],
		);
		await gated.get("sparql")!.callTool("query", { query: "ASK {}" });
		await gated.get("discord")!.callTool("post_message", {});
		const noSparql = applyHostCapabilityGrantPolicy(new Map([["sparql", sparqlFace]]), {
			exactTools: { sparql: ["query"] },
			mode: fence(mode({ allowsTool: ["search_documents"] })),
		}).get("sparql")!;
		assert.deepEqual(await noSparql.listTools(), []);
		await assert.rejects(noSparql.callTool("query", { query: "ASK {}" }), AgentModeDeniedError);
	});

	it("leaves a mode-less policy exactly as before", async () => {
		const raw = cellBackend();
		const gated = applyHostCapabilityGrantPolicy(new Map([["mnemosyne", raw]]), {
			exactTools: { mnemosyne: ["write_document", "mystery_tool"] },
		}).get("mnemosyne")!;
		assert.deepEqual(
			(await gated.listTools()).map((tool) => tool.name),
			["write_document", "mystery_tool"],
		);
		await gated.callTool("mystery_tool", {});
		assert.deepEqual(raw.calls, ["mystery_tool"]);
	});
});

describe("Choreograph modes v1 — durable Sessions: reread, pin and audit", () => {
	async function withRuntime(run: (runtime: WorkflowRuntimeStore) => Promise<void>): Promise<void> {
		const directory = mkdtempSync(join(tmpdir(), "agent-modes-"));
		const runtime = new WorkflowRuntimeStore(join(directory, "runtime.sqlite"));
		try {
			await runtime.init();
			await run(runtime);
		} finally {
			runtime.close();
			rmSync(directory, { recursive: true, force: true });
		}
	}

	function cellReader(cell: CellRdfStore): AgentModeReader {
		return {
			readAgentModeCatalog: (ref) =>
				readAgentModeCatalogFromGraph(
					{ sparqlQuery: async (_graph, query) => cell.query(query) },
					ref.graphId,
					ref.agentId,
				),
		};
	}

	it("pins the mode on the Session, re-reads it by digest, and projects agt:ranInMode", async () => {
		await withRuntime(async (runtime) => {
			const semantic = makeTestAgentSemanticBinding({ graphId: GRAPH, registeredName: "scout" });
			const cell = new CellRdfStore();
			seedAgentModes(cell, GRAPH, {
				agentId: semantic.agentId,
				modes: [{ slug: "researcher", label: "Researcher", access: ["read"], allowsTool: ["search_documents"] }],
				defaultMode: "researcher",
			});
			const catalog = await cellReader(cell).readAgentModeCatalog({
				graphOwnerPrincipal: "user:owner",
				graphId: GRAPH,
				agentId: semantic.agentId,
			});
			const bound = resolveSessionMode(catalog)!;
			const ontology = { ...semantic.ontology, mode: { iri: bound.iri, digest: agentModeDigest(bound) } };
			const sessionId = "ags_mode_bound";
			const spec: AgentNodeSpec = {
				label: sessionId,
				phaseIndex: 1,
				prompt: "research",
				model: "mock:done",
				graphId: GRAPH,
				sessionId,
				...semantic,
				ontology,
				ontologyBindingDigest: digestAgentOntologyBinding(ontology),
			};
			await runtime.createWorkflowInstance({
				runId: "wfr-modes",
				workflowName: "modes-fixture",
				graphId: GRAPH,
				ownerUserId: "user:owner",
				inputs: {},
				startedAt: 1,
			});
			await runtime.beginAgentSession({
				sessionId,
				runId: "wfr-modes",
				workflowName: "modes-fixture",
				graphId: GRAPH,
				ownerUserId: "user:owner",
				graphOwnerPrincipal: "user:owner",
				spec,
				nodeKey: `1:${sessionId}`,
				frontier: { kind: "before-node", sessionId, phaseIndex: 1, ts: 1 },
				now: 1,
			});
			const session = await runtime.readAgentSession(sessionId);
			const pinned = pinnedAgentSessionModeRef(session!);
			assert.deepEqual(pinned, ontology.mode);

			const ref = { graphOwnerPrincipal: "user:owner", graphId: GRAPH, agentId: semantic.agentId };
			assert.deepEqual(await rereadPinnedAgentMode(cellReader(cell), ref, pinned!), bound);

			// The owner edits the mode after the Session was bound: resuming must not
			// silently inherit the new surface.
			cell.update(
				GRAPH,
				`PREFIX agt: <http://mnemosyne.dev/agent#>
INSERT DATA { <urn:sophia:mode:researcher> agt:allowsTool "write_document" . }`,
			);
			await assert.rejects(
				rereadPinnedAgentMode(cellReader(cell), ref, pinned!),
				(error: unknown) => error instanceof AgentModeError && error.code === "mode_current_mismatch",
			);

			const snapshot = await runtime.readAgentSessionFamilyProjection(sessionId);
			assert.equal(snapshot?.root.modeIri, "urn:sophia:mode:researcher");
			const store = new Store();
			const update = buildAgentSessionFamilyProjection(snapshot!);
			store.update(update);
			store.update(update);
			const rows = store.query(`PREFIX agt: <http://mnemosyne.dev/agent#>
SELECT ?mode WHERE { GRAPH ?g { <${mintAgentSessionUri(semantic.agentId, sessionId)}> a agt:Session ; agt:ranInMode ?mode . } }`) as Array<
				Map<string, Term>
			>;
			assert.deepEqual(
				rows.map((row) => row.get("mode")?.value),
				["urn:sophia:mode:researcher"],
				"exactly one agt:ranInMode, idempotent under replay",
			);
		});
	});

	it("projects no agt:ranInMode for a mode-less Session", async () => {
		await withRuntime(async (runtime) => {
			const semantic = makeTestAgentSemanticBinding({ graphId: GRAPH, registeredName: "plain" });
			const sessionId = "ags_mode_less";
			await runtime.createWorkflowInstance({
				runId: "wfr-plain",
				workflowName: "modes-fixture",
				graphId: GRAPH,
				ownerUserId: "user:owner",
				inputs: {},
				startedAt: 1,
			});
			await runtime.beginAgentSession({
				sessionId,
				runId: "wfr-plain",
				workflowName: "modes-fixture",
				graphId: GRAPH,
				ownerUserId: "user:owner",
				graphOwnerPrincipal: "user:owner",
				spec: {
					label: sessionId,
					phaseIndex: 1,
					prompt: "p",
					model: "mock:done",
					graphId: GRAPH,
					sessionId,
					...semantic,
				},
				nodeKey: `1:${sessionId}`,
				frontier: { kind: "before-node", sessionId, phaseIndex: 1, ts: 1 },
				now: 1,
			});
			assert.equal(pinnedAgentSessionModeRef((await runtime.readAgentSession(sessionId))!), undefined);
			const snapshot = await runtime.readAgentSessionFamilyProjection(sessionId);
			assert.equal(snapshot?.root.modeIri, undefined);
			assert.doesNotMatch(buildAgentSessionFamilyProjection(snapshot!).split("WHERE")[0]!, /agt:ranInMode </);
		});
	});
});
