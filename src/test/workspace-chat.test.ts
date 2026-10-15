import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { AgentModeDeniedError, agentModeDigest } from "../agent-runtime/agent-mode.js";
import { digestAgentOntologyBinding, validateAgentOntologyBinding } from "../agent-runtime/ontology-binding.js";
import { digestAgentRuntimeBinding, validateResolvedAgentRuntimeBinding } from "../agent-runtime/profile.js";
import { applyHostCapabilityGrantPolicy } from "../capabilities/grant-gate.js";
import { createSandboxEventBus, type SandboxEventBus } from "../event-bus.js";
import { type CapabilityBackend, type HostedMcpToolDescriptor, READ_ONLY_MNEMOSYNE_TOOLS } from "../mnemosyne.js";
import { routeRequest } from "../orchestrator.js";
import { digestSophiaAgentSourceTree } from "../runtime-bundles.js";
import { SandboxStore } from "../sandbox-store.js";
import { SandboxSpawner } from "../spawner.js";
import { compileWorkflow, runWorkflow } from "../workflow/harness.js";
import { INVOCATION_ENVELOPE_SCHEMA, InvocationFault } from "../workflow/invocation.js";
import { JournalStore } from "../workflow/journal-store.js";
import { listWorkflows } from "../workflow/registry.js";
import { agentNodeSpecForCommandActivation, WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import { DOMAIN_AGENT_ACTIVITY_LOOP_NAME } from "../workflow/script-domain-agent-activity-loop.js";
import type { AgentNodeResult, AgentNodeSpec, NodeRunner } from "../workflow/types.js";
import {
	buildWorkspaceChatInputs,
	builtInModeFenceForSession,
	DEFAULT_WORKSPACE_CHAT_MODEL,
	parseWorkspaceChatRequest,
	readWorkspaceChatHostContext,
	resolveWorkspaceChatInference,
	stampWorkspaceChatSpec,
	WORKSPACE_CHAT_SCRIPT,
	WORKSPACE_CHAT_WORKFLOW_NAME,
	WORKSPACE_READER_MODE_IRI,
	WORKSPACE_READER_TOOLS,
	WORKSPACE_WRITER_MODE_IRI,
	WORKSPACE_WRITER_TOOLS,
	workspaceChatGrantTools,
	workspaceReaderFence,
	workspaceReaderFenceV1,
	workspaceWriterFence,
} from "../workflow/workspace-chat.js";
import { WORKSPACE_READER_TOOLS_V1, type WorkspaceChatRole } from "../workflow/workspace-chat-contract.js";
import { GardenDocumentCell } from "./garden-document-cell.js";

const BUNDLE = { id: "sophia-agent-runtime", digest: "a".repeat(64) };
const OWNER = "user:owner-1";

function inputsFor(
	graphId: string,
	text = "What is in this workspace?",
	role: WorkspaceChatRole = "viewer",
	contextRefs: string[] = [],
	/** The refs the graph answered (`admitTurnContextRefs`); the request's own list is never named unchecked. */
	admittedContextRefs?: string[],
) {
	return buildWorkspaceChatInputs({
		graphId,
		graphOwnerPrincipal: OWNER,
		request: parseWorkspaceChatRequest({
			input: { trigger: { kind: "sophia-cluster.message", text }, contextRefs, interactionMode: "headed" },
		}),
		runtimeBundle: BUNDLE,
		inference: { provider: "openrouter", model: "test/model" },
		role,
		...(admittedContextRefs ? { admittedContextRefs } : {}),
		now: 1_000,
	});
}

describe("workspace-chat-v1 inputs", () => {
	it("binds a valid Prime runtime, Agent ontology and, for a viewer, the built-in Reader mode", () => {
		const inputs = inputsFor("angels", undefined, "viewer");
		const args = inputs.args as {
			pilot: {
				runtime: unknown;
				ontology: { mode?: { iri: string; digest: string }; subject: { agentId: string } };
				includeTools: string[];
				systemPrompt: string;
			};
		};
		validateResolvedAgentRuntimeBinding(args.pilot.runtime);
		validateAgentOntologyBinding(args.pilot.ontology);
		const runtime = args.pilot.runtime as {
			kind: string;
			bundle: { digest: string };
			constraints: Record<string, unknown>;
		};
		assert.equal(runtime.kind, "prime");
		assert.equal(runtime.bundle.digest, `sha256:${BUNDLE.digest}`);
		assert.equal(runtime.constraints.maxChildren, 0);
		assert.equal(runtime.constraints.allowSchedules, false);
		assert.equal(runtime.constraints.allowWorkflowProposals, false);

		const fence = workspaceReaderFence("angels");
		assert.deepEqual(args.pilot.ontology.mode, { iri: WORKSPACE_READER_MODE_IRI, digest: fence.digest });
		assert.equal(fence.digest, agentModeDigest(fence.mode));
		assert.equal(fence.mode.access, "read");
		assert.deepEqual(fence.mode.graphScope, ["urn:graph:angels"]);

		assert.deepEqual(args.pilot.includeTools, [...WORKSPACE_READER_TOOLS]);
		for (const tool of args.pilot.includeTools) assert.ok(READ_ONLY_MNEMOSYNE_TOOLS.has(tool), tool);
		for (const write of ["write_document", "sparql_update", "context_bundle", "music", "recall"]) {
			assert.ok(!args.pilot.includeTools.includes(write), write);
		}
		assert.match(args.pilot.systemPrompt, /the assistant in the workspace "angels"/);
		assert.match(args.pilot.systemPrompt, /cannot change anything here/);
		assert.equal(inputs.config.strictToolManifest, false);
		assert.equal((inputs.args as { pilot: { graphAccess: string } }).pilot.graphAccess, "read");

		const host = readWorkspaceChatHostContext(inputs.hostContext);
		assert.ok(host);
		assert.equal(host.graphId, "angels");
		assert.equal(host.mode.digest, fence.digest);
		assert.equal(host.role, "viewer");
	});

	it("gives owners and editors the built-in Writer mode, write access and the writer manifest", () => {
		for (const role of ["owner", "editor"] as const) {
			const inputs = inputsFor("angels", undefined, role);
			const args = inputs.args as {
				pilot: {
					ontology: { mode?: { iri: string; digest: string }; objects: { toolManifest: { objectId: string } } };
					includeTools: string[];
					systemPrompt: string;
					graphAccess: string;
				};
			};
			validateAgentOntologyBinding(args.pilot.ontology);
			const fence = workspaceWriterFence("angels");
			assert.deepEqual(args.pilot.ontology.mode, { iri: WORKSPACE_WRITER_MODE_IRI, digest: fence.digest });
			assert.equal(fence.mode.access, "write");
			assert.deepEqual(fence.mode.graphScope, ["urn:graph:angels"]);
			assert.equal(fence.argumentPolicy, "workspace-writer-v1");
			assert.deepEqual(args.pilot.includeTools, [...WORKSPACE_WRITER_TOOLS]);
			assert.deepEqual(inputs.config.includeTools, [...WORKSPACE_WRITER_TOOLS]);
			assert.equal(args.pilot.graphAccess, "write");
			assert.match(args.pilot.ontology.objects.toolManifest.objectId, /writer-tools$/);
			assert.match(args.pilot.systemPrompt, /you can read, search and change it/);
			const host = readWorkspaceChatHostContext(inputs.hostContext)!;
			assert.equal(host.role, role);
			assert.equal(host.mode.mode.iri, WORKSPACE_WRITER_MODE_IRI);
			assert.deepEqual(host.tools, [...WORKSPACE_WRITER_TOOLS]);
		}
	});

	it("fails closed to the Reader when no role is named", () => {
		const inputs = buildWorkspaceChatInputs({
			graphId: "angels",
			graphOwnerPrincipal: OWNER,
			request: parseWorkspaceChatRequest({ input: { trigger: { kind: "x", text: "hi" } } }),
			runtimeBundle: BUNDLE,
			inference: { provider: "openrouter", model: "test/model" },
			now: 1_000,
		});
		assert.equal(readWorkspaceChatHostContext(inputs.hostContext)!.mode.mode.iri, WORKSPACE_READER_MODE_IRI);
		assert.equal((inputs.args as { pilot: { graphAccess: string } }).pilot.graphAccess, "read");
	});

	it("carries what the person has open as the first turn's own part: the person's words stay the prompt (D5)", () => {
		// The request's refs alone name nothing (they were not checked against the graph)...
		const unchecked = inputsFor("angels", "Summarize this document", "editor", ["q3-plan", "not an id"]);
		assert.equal(readWorkspaceChatHostContext(unchecked.hostContext)!.contextRefs, undefined);
		// ...the admitted ones do, renderable only.
		const inputs = inputsFor(
			"angels",
			"Summarize this document",
			"editor",
			["q3-plan", "not an id"],
			["q3-plan", "not an id"],
		);
		// The Session's prompt, its transcript and its title are the person's words; the note is the model's alone.
		assert.equal((inputs.args as { text: string }).text, "Summarize this document");
		const host = readWorkspaceChatHostContext(inputs.hostContext)!;
		assert.deepEqual(host.contextRefs, ["q3-plan"]);
		const stamped = stampWorkspaceChatSpec(
			{ label: "pilot-headed", phaseIndex: 1, prompt: "Summarize this document", model: "m", graphId: "angels" },
			host,
		);
		assert.deepEqual(stamped.contextRefs, ["q3-plan"]);
		assert.equal(stamped.prompt, "Summarize this document");
		// A script cannot name refs of its own: only the host context's reach the spec.
		const forged = stampWorkspaceChatSpec(
			{ label: "p", phaseIndex: 1, prompt: "x", model: "m", graphId: "angels", contextRefs: ["forged"] },
			readWorkspaceChatHostContext(inputsFor("angels").hostContext)!,
		);
		assert.equal(forged.contextRefs, undefined);
	});

	it("hands over the live intersection only, says only that, and refuses a cell without the tools a chat needs (exam 1)", () => {
		const live = WORKSPACE_WRITER_TOOLS.filter((tool) => tool !== "surface" && tool !== "custom_css");
		const inputs = buildWorkspaceChatInputs({
			graphId: "angels",
			graphOwnerPrincipal: OWNER,
			request: parseWorkspaceChatRequest({
				input: { trigger: { kind: "m", text: "hi" }, interactionMode: "headed" },
			}),
			runtimeBundle: BUNDLE,
			inference: { provider: "openrouter", model: "test/model" },
			role: "editor",
			liveTools: [...live, "some_future_tool"],
		});
		const host = readWorkspaceChatHostContext(inputs.hostContext)!;
		assert.deepEqual(host.tools, [...live].sort());
		const pilot = (inputs.args as { pilot: { includeTools: string[]; systemPrompt: string } }).pilot;
		assert.deepEqual(pilot.includeTools, [...live].sort());
		assert.doesNotMatch(pilot.systemPrompt, /`surface`|`custom_css`|some_future_tool/);
		// The mode stays the whole Writer, so its digest is the one every wake re-derives.
		assert.deepEqual(host.mode.mode.allowsTool, [...WORKSPACE_WRITER_TOOLS]);
		assert.throws(
			() =>
				buildWorkspaceChatInputs({
					graphId: "angels",
					graphOwnerPrincipal: OWNER,
					request: parseWorkspaceChatRequest({
						input: { trigger: { kind: "m", text: "hi" }, interactionMode: "headed" },
					}),
					runtimeBundle: BUNDLE,
					inference: { provider: "openrouter", model: "test/model" },
					role: "viewer",
					liveTools: ["search_documents", "list_documents"],
				}),
			(error: unknown) =>
				error instanceof InvocationFault &&
				error.status === 503 &&
				error.code === "workspace_chat_tools_unavailable",
		);
	});

	it("bounds the host's grant by the tools the session was handed (its includeTools), never past its mode", () => {
		assert.deepEqual(workspaceChatGrantTools(WORKSPACE_WRITER_TOOLS, ["read_document", "surface", "sparql_update"]), [
			"read_document",
			"surface",
		]);
		assert.deepEqual(workspaceChatGrantTools(WORKSPACE_READER_TOOLS, undefined), [...WORKSPACE_READER_TOOLS]);
	});

	it("gives each workspace its own agent identity and mode digest", () => {
		const angels = readWorkspaceChatHostContext(inputsFor("angels").hostContext)!;
		const cluster = readWorkspaceChatHostContext(inputsFor("sophia-cluster").hostContext)!;
		assert.notEqual(angels.agentId, cluster.agentId);
		assert.notEqual(angels.mode.digest, cluster.mode.digest);
	});

	it("rejects malformed input as a 400 with a stable code", () => {
		for (const body of [
			{ input: { trigger: { kind: "x" } } },
			{ input: { trigger: { kind: "x", text: "   " } } },
			{ input: { trigger: { kind: "x", text: "hi" }, interactionMode: "headless" } },
			{ input: { trigger: { kind: "x", text: "hi" }, contextRefs: [1] } },
			{ input: {} },
		]) {
			assert.throws(
				() => parseWorkspaceChatRequest(body),
				(error: unknown) =>
					error instanceof InvocationFault &&
					error.status === 400 &&
					error.code === "workspace_chat_input_invalid",
			);
		}
	});

	it("takes its model from host configuration", () => {
		assert.deepEqual(resolveWorkspaceChatInference({}), {
			provider: "openrouter",
			model: DEFAULT_WORKSPACE_CHAT_MODEL,
		});
		assert.equal(resolveWorkspaceChatInference({ OPENROUTER_MODEL: "b/model" }).model, "b/model");
		assert.equal(
			resolveWorkspaceChatInference({ OPENROUTER_MODEL: "b/model", CHOREOGRAPH_WORKSPACE_CHAT_MODEL: "a/model" })
				.model,
			"a/model",
		);
	});
});

describe("workspace-chat-v1 script", () => {
	it("runs exactly one headed pilot, with the graph access its role allows, and returns its reply", async () => {
		const compiled = compileWorkflow(WORKSPACE_CHAT_SCRIPT);
		assert.equal(compiled.meta.name, WORKSPACE_CHAT_WORKFLOW_NAME);
		const specs: AgentNodeSpec[] = [];
		const runNode: NodeRunner = async (spec) => {
			specs.push(spec);
			const result: AgentNodeResult = {
				label: spec.label,
				phaseIndex: spec.phaseIndex,
				state: "done",
				output: "The workspace holds two documents.",
				model: spec.model,
				turns: 1,
				toolCalls: 1,
				tokens: 10,
				queuedAt: 0,
				startedAt: 0,
				durationMs: 1,
			};
			return result;
		};
		let t = 1;
		const run = await runWorkflow({ runNode, runId: "wfr-test", now: () => t++ }, compiled, inputsFor("angels"));
		await runWorkflow(
			{ runNode, runId: "wfr-test-2", now: () => t++ },
			compiled,
			inputsFor("angels", "Fix it", "editor"),
		);
		assert.equal(specs.length, 2);
		assert.equal(specs[1].graphAccess, "write");
		assert.deepEqual(specs[1].includeTools, [...WORKSPACE_WRITER_TOOLS]);
		assert.equal(specs[1].ontology?.mode?.iri, WORKSPACE_WRITER_MODE_IRI);
		const [pilot] = specs;
		assert.equal(pilot.label, "pilot-headed");
		assert.equal(pilot.interactionMode, "headed");
		assert.equal(pilot.graphAccess, "read");
		assert.equal(pilot.provider, "openrouter");
		assert.equal(pilot.model, "test/model");
		assert.equal(pilot.prompt, "What is in this workspace?");
		assert.deepEqual(pilot.includeTools, [...WORKSPACE_READER_TOOLS]);
		assert.equal(pilot.strictToolManifest, false);
		assert.equal(pilot.ontology?.mode?.iri, WORKSPACE_READER_MODE_IRI);
		assert.deepEqual(run.output, { response: "The workspace holds two documents." });
	});
});

/** A real in-process graph MCP backend whose tools/list carries no scope metadata for reader tools. */
function cellBackend(overrides: Partial<Record<string, readonly string[]>> = {}) {
	const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
	const tools: HostedMcpToolDescriptor[] = [
		...WORKSPACE_READER_TOOLS.map((name) => ({
			name,
			destructive: false,
			...(overrides[name] ? { requiredScopes: overrides[name] } : {}),
		})),
		{ name: "write_document", destructive: true, requiredScopes: ["documents.write"] },
		{ name: "context_bundle", destructive: false },
	];
	const backend: CapabilityBackend & { calls: typeof calls } = {
		capabilityName: "mnemosyne",
		accessLevel: "rw",
		calls,
		async callTool(tool, args) {
			calls.push({ tool, args });
			return { ok: true, tool };
		},
		async listTools() {
			return tools.map((tool) => ({ ...tool }));
		},
		async close() {},
	};
	return backend;
}

describe("the built-in Reader mode at the host gate", () => {
	const policy = (graphId: string) => ({
		exactTools: { mnemosyne: [...WORKSPACE_READER_TOOLS] },
		mode: workspaceReaderFence(graphId),
	});

	it("exposes exactly the reader tools even when the cell omits scope metadata", async () => {
		const backend = cellBackend();
		const gated = applyHostCapabilityGrantPolicy(new Map([["mnemosyne", backend]]), policy("angels")).get(
			"mnemosyne",
		)!;
		const listed = (await gated.listTools()).map((tool) => tool.name).sort();
		assert.deepEqual(listed, [...WORKSPACE_READER_TOOLS]);
		await gated.callTool("read_document", { document_id: "notes" });
		await gated.callTool("sparql_query", { query: "SELECT * WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT 1" });
		assert.deepEqual(
			backend.calls.map((call) => call.tool),
			["read_document", "sparql_query"],
		);
	});

	it("denies writes, other graphs, and a reader tool the live cell says writes", async () => {
		const backend = cellBackend({ get_values: ["values.write"] });
		const gated = applyHostCapabilityGrantPolicy(new Map([["mnemosyne", backend]]), policy("angels")).get(
			"mnemosyne",
		)!;
		await assert.rejects(() => gated.callTool("write_document", { document_id: "x", content: "y" }));
		await assert.rejects(() => gated.callTool("context_bundle", {}));
		await assert.rejects(
			() => gated.callTool("read_document", { graph_id: "sophia-cluster", document_id: "secrets" }),
			(error: unknown) => error instanceof AgentModeDeniedError && error.reason === "graph_outside_scope",
		);
		await assert.rejects(
			() => gated.callTool("get_values", {}),
			(error: unknown) => error instanceof AgentModeDeniedError && error.reason === "write_in_read_mode",
		);
		assert.ok(!(await gated.listTools()).some((tool) => tool.name === "get_values"));
		assert.deepEqual(backend.calls, []);
	});

	it("re-derives a pinned built-in mode for a woken session and refuses a changed one", () => {
		const fence = workspaceReaderFence("angels");
		const same = builtInModeFenceForSession({ iri: WORKSPACE_READER_MODE_IRI, digest: fence.digest }, "angels");
		assert.ok(same && "fence" in same);
		assert.equal(same.fence.boundGraphId, "angels");
		assert.deepEqual(
			builtInModeFenceForSession({ iri: WORKSPACE_READER_MODE_IRI, digest: fence.digest }, "sophia-cluster"),
			{ mismatch: true },
		);
		assert.equal(
			builtInModeFenceForSession({ iri: "urn:sophia:mode:researcher", digest: fence.digest }, "angels"),
			undefined,
		);
	});
});

/** A backend that speaks the live cell's tools/list (engine r20261002): its real names and required scopes. */
function liveCellBackend() {
	const fixture = JSON.parse(
		readFileSync(new URL("./fixtures/garden-cell-tools-r20261002.json", import.meta.url), "utf8"),
	) as { tools: Array<{ name: string; requiredScopes: string[] }> };
	const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
	const backend: CapabilityBackend & { calls: typeof calls } = {
		capabilityName: "mnemosyne",
		accessLevel: "rw",
		calls,
		async callTool(tool, args) {
			calls.push({ tool, args });
			return { ok: true, tool };
		},
		async listTools() {
			return fixture.tools.map((tool) => ({
				name: tool.name,
				destructive: false,
				requiredScopes: tool.requiredScopes,
			}));
		},
		async close() {},
	};
	return backend;
}

describe("role-bound modes at the host gate, against the live cell's scopes", () => {
	const gate = (backend: CapabilityBackend, fence: ReturnType<typeof workspaceWriterFence>) =>
		applyHostCapabilityGrantPolicy(new Map([["mnemosyne", backend]]), {
			exactTools: { mnemosyne: [...fence.mode.allowsTool] },
			mode: fence,
		}).get("mnemosyne")!;

	it("a viewer's chat lists no write tool and every write is refused before it reaches the cell", async () => {
		const backend = liveCellBackend();
		const gated = gate(backend, workspaceReaderFence("angels"));
		const listed = (await gated.listTools()).map((tool) => tool.name).sort();
		assert.deepEqual(listed, [...WORKSPACE_READER_TOOLS]);
		for (const write of WORKSPACE_WRITER_TOOLS.filter((tool) => !WORKSPACE_READER_TOOLS.includes(tool))) {
			await assert.rejects(() => gated.callTool(write, { documentId: "notes" }), write);
		}
		assert.deepEqual(backend.calls, []);
	});

	it("an editor's chat lists the writer tools and its writes reach the cell", async () => {
		const backend = liveCellBackend();
		const gated = gate(backend, workspaceWriterFence("angels"));
		const listed = (await gated.listTools()).map((tool) => tool.name).sort();
		assert.deepEqual(listed, [...WORKSPACE_WRITER_TOOLS]);
		await gated.callTool("insert_blocks", { documentId: "notes", content: "A new line." });
		await gated.callTool("create_artifact_text", {
			artifact_id: "board-1",
			operation_id: "op-board-1-create",
			filename: "board.html",
			mime_type: "text/html",
			graph_incarnation: "inc-1",
			text: "<h1>Board</h1>",
		});
		await gated.callTool("custom_css", { action: "read" });
		await gated.callTool("create_wires", { sourceDocumentId: "a", targetDocumentId: "b", predicate: "cites" });
		await gated.callTool("rename", { entity_type: "document", entity_id: "notes", new_name: "Notes" });
		// Vera, 10-06: a true document delete (D1), and a wire deleted with the tool a person uses (D2).
		await gated.callTool("delete_document", { documentId: "old-notes" });
		await gated.callTool("delete", { type: "wire", wireId: "wire-1" });
		await gated.callTool("delete", { type: "wires", wireIds: ["wire-2", "wire-3"] });
		assert.deepEqual(
			backend.calls.map((call) => call.tool),
			[
				"insert_blocks",
				"create_artifact_text",
				"custom_css",
				"create_wires",
				"rename",
				"delete_document",
				"delete",
				"delete",
			],
		);
	});

	it("an editor's chat cannot reach another graph, delete anything but a wire with `delete`, or use a tool's graph-wide face", async () => {
		const backend = liveCellBackend();
		const gated = gate(backend, workspaceWriterFence("angels"));
		await assert.rejects(
			() => gated.callTool("write_document", { graphId: "sophia-cluster", documentId: "x", content: "y" }),
			(error: unknown) => error instanceof AgentModeDeniedError && error.reason === "graph_outside_scope",
		);
		for (const [tool, args] of [
			["custom_css", { action: "replace", cssText: "body{}" }],
			["custom_css", { action: "reset" }],
			["create_wires", { sourceDocumentId: "a", targetGraphId: "sophia-cluster", targetDocumentId: "b" }],
			["create_wires", { wires: [{ sourceDocumentId: "a", target_graph_id: "other", targetDocumentId: "b" }] }],
			["rename", { entity_type: "graph", new_name: "Renamed" }],
			["rename", { entityType: "graph", newName: "Renamed" }],
			// `delete` is admitted for wires only: documents go through delete_document, blocks through delete_blocks,
			// folders (a hard cascade) and the graph not at all.
			["delete", { type: "documents", documentId: "notes" }],
			["delete", { type: "document", document_ids: ["notes"] }],
			["delete", { type: "blocks", documentId: "notes", blockIds: ["b1"] }],
			["delete", { type: "folder", folderId: "f1", cascade: true }],
			["delete", { type: "graph" }],
			["delete", { type: "Graphs" }],
			["delete", { wireId: "wire-1" }],
		] as const) {
			await assert.rejects(
				() => gated.callTool(tool, { ...args }),
				(error: unknown) => error instanceof AgentModeDeniedError && error.reason === "argument_outside_mode",
				`${tool} ${JSON.stringify(args)}`,
			);
		}
		for (const tool of ["crdt_operation", "sparql_update", "rdf_load", "revaluate", "create_restore_point"]) {
			await assert.rejects(() => gated.callTool(tool, { documentId: "notes", type: "documents" }), tool);
		}
		await assert.rejects(
			() => gated.callTool("delete_document", { graphId: "sophia-cluster", documentId: "notes" }),
			(error: unknown) => error instanceof AgentModeDeniedError && error.reason === "graph_outside_scope",
		);
		// A wire inside this graph, named with this graph, is fine.
		await gated.callTool("create_wires", { sourceDocumentId: "a", targetGraphId: "angels", targetDocumentId: "b" });
		assert.deepEqual(
			backend.calls.map((call) => call.tool),
			["create_wires"],
		);
	});

	it("re-derives every built-in mode for a woken session, including the Reader of chats begun before this release", () => {
		for (const fence of [
			workspaceReaderFenceV1("angels"),
			workspaceReaderFence("angels"),
			workspaceWriterFence("angels"),
		]) {
			const woken = builtInModeFenceForSession({ iri: fence.mode.iri, digest: fence.digest }, "angels");
			assert.ok(woken && "fence" in woken, fence.mode.iri);
			assert.deepEqual(woken.fence.mode, fence.mode);
			assert.equal(woken.fence.argumentPolicy, fence.argumentPolicy);
			assert.deepEqual(builtInModeFenceForSession({ iri: fence.mode.iri, digest: fence.digest }, "sophia-cluster"), {
				mismatch: true,
			});
		}
		assert.notEqual(workspaceReaderFenceV1("angels").digest, workspaceReaderFence("angels").digest);
		// A Reader pin never wakes as a Writer, and a Writer pin never wakes with a Reader's digest.
		assert.deepEqual(
			builtInModeFenceForSession(
				{ iri: WORKSPACE_WRITER_MODE_IRI, digest: workspaceReaderFence("angels").digest },
				"angels",
			),
			{ mismatch: true },
		);
	});

	/**
	 * Exam 1, section 4: the test above checks a helper against digests today's code computes. This one wakes a Session
	 * stored exactly as the deployed release (`r20261003`) began it: its inputs are that release's own output
	 * (`fixtures/workspace-chat-r20261003-inputs.json`, generated by r20261003's buildWorkspaceChatInputs), stored through the
	 * real runtime store, then re-activated through the spawner's own wake path (its mode reread, its command-activation
	 * grant, its stored spec), and a write is attempted through the backend it wakes with.
	 */
	it("wakes a Session stored by the pre-release host as the frozen Reader: its prompt kept, every write refused", async () => {
		const stored = JSON.parse(
			readFileSync(new URL("./fixtures/workspace-chat-r20261003-inputs.json", import.meta.url), "utf8"),
		) as { inputs: { args: { text: string; pilot: Record<string, any> } } };
		const pilot = stored.inputs.args.pilot;
		const directory = mkdtempSync(join(tmpdir(), "woken-pre-release-"));
		const runtime = new WorkflowRuntimeStore(join(directory, "runtime.sqlite"));
		const store = new SandboxStore(join(directory, "sandboxes.sqlite"));
		await runtime.init();
		try {
			const sessionId = "ags-pre-release-1";
			await runtime.createWorkflowInstance({
				runId: "wfr-pre-release-1",
				workflowName: WORKSPACE_CHAT_WORKFLOW_NAME,
				graphId: "angels",
				ownerUserId: "owner-1",
				inputs: stored.inputs,
				startedAt: 1,
			});
			// The pilot spec r20261003's script opened: its arguments, with the graph access its script hard-coded.
			const spec: AgentNodeSpec = {
				label: "pilot-headed",
				phaseIndex: 1,
				prompt: stored.inputs.args.text,
				model: pilot.model,
				provider: pilot.provider,
				graphId: "angels",
				sessionId,
				agentId: pilot.agentId,
				interactionMode: "headed",
				systemPrompt: pilot.systemPrompt,
				toolMode: "dynamic",
				graphAccess: "read",
				includeTools: pilot.includeTools,
				strictToolManifest: false,
				runtime: pilot.runtime,
				runtimeBindingDigest: digestAgentRuntimeBinding(pilot.runtime),
				ontology: pilot.ontology,
				ontologyBindingDigest: digestAgentOntologyBinding(pilot.ontology),
			};
			await runtime.beginAgentSession({
				sessionId,
				runId: "wfr-pre-release-1",
				workflowName: WORKSPACE_CHAT_WORKFLOW_NAME,
				graphId: "angels",
				ownerUserId: "owner-1",
				graphOwnerPrincipal: "user:owner-1",
				spec,
				nodeKey: "1:pilot-headed",
				frontier: { kind: "before-node", sessionId, phaseIndex: 1, ts: 1 },
				now: 1,
			});
			const session = (await runtime.readAgentSession(sessionId))!;
			const spawner = new SandboxSpawner(
				store,
				{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
				{ sandboxMode: "local-native", workflowRuntime: runtime },
			);
			const wake = spawner as unknown as {
				rereadSessionModeFence(
					session: unknown,
				): Promise<{ mode: { iri: string; allowsTool: string[] }; digest: string }>;
				builtInModeCommandPolicy(
					session: unknown,
					input: unknown,
				): Promise<Parameters<typeof applyHostCapabilityGrantPolicy>[1]>;
			};
			// Its pinned mode wakes as the frozen Reader, not today's.
			const fence = await wake.rereadSessionModeFence(session);
			assert.equal(fence.mode.iri, WORKSPACE_READER_MODE_IRI);
			assert.equal(fence.digest, workspaceReaderFenceV1("angels").digest);
			assert.deepEqual([...fence.mode.allowsTool].sort(), [...WORKSPACE_READER_TOOLS_V1]);
			// Its stored spec wakes with the prompt it was begun with (frozen prompts are immutable: it names no tool, so it
			// names none the Session lacks, and it says nothing of History, whose tool reaches the model by its own schema).
			const woken = agentNodeSpecForCommandActivation(session, { generation: 1, activationId: "act-wake-1" });
			assert.equal(woken.systemPrompt, pilot.systemPrompt);
			assert.match(woken.systemPrompt ?? "", /You cannot change anything here/);
			// And the backend it wakes with: a write is refused before the cell, a tool of today's Reader is not offered, a
			// read of its own reaches the cell.
			const policy = await wake.builtInModeCommandPolicy(session, { activation: {} });
			const cell = liveCellBackend();
			const backend = applyHostCapabilityGrantPolicy(new Map([["mnemosyne", cell]]), policy).get("mnemosyne")!;
			for (const write of ["write_document", "create_document", "delete_document", "sparql_update"]) {
				await assert.rejects(backend.callTool(write, { documentId: "q3-plan", content: "x" }), write);
			}
			await assert.rejects(
				backend.callTool("semantic_search", { query: "plan" }),
				"today's Reader tool is not its own",
			);
			await backend.callTool("get_document_history", { documentId: "q3-plan" });
			assert.deepEqual(
				cell.calls.map((call) => call.tool),
				["get_document_history"],
			);
			const listed = (await backend.listTools()).map((tool) => tool.name).sort();
			assert.deepEqual(listed, [...WORKSPACE_READER_TOOLS_V1]);
		} finally {
			runtime.close();
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

// ─── Route level: a real MCP cell behind the direct-MCP graph backend ─────────

class ResponseRecorder {
	statusCode = 200;
	headers = new Map<string, string>();
	body = "";
	headersSent = false;
	setHeader(name: string, value: string) {
		this.headers.set(name.toLowerCase(), value);
	}
	writeHead(status: number) {
		this.statusCode = status;
		this.headersSent = true;
	}
	end(chunk?: string) {
		this.headersSent = true;
		if (chunk) this.body += chunk;
	}
	setTimeout(_timeoutMs: number) {}
}

/** The graph the gateway checked for these invocations, as it mints it beside the role (`/o/user:owner-1/g/angels`). */
const ANGELS = { "x-graph-id": "angels", "x-graph-owner": "user:owner-1" };

function invocationRequest(body: unknown, extraHeaders: Record<string, string> = {}) {
	return Object.assign(Readable.from([JSON.stringify(body)]), {
		method: "POST",
		url: "/api/invocations",
		headers: {
			"content-type": "application/json",
			"x-internal-service": "shared-secret",
			"x-user-id": "owner-1",
			prefer: "respond-async",
			...extraHeaders,
		},
	});
}

function digestOf(name: string): string {
	const entry = listWorkflows().find((workflow) => workflow.name === name);
	assert.ok(entry, `${name} is registered`);
	return entry.definitionDigest;
}

describe("POST /api/invocations — honest errors and the workspace chat path", { concurrency: false }, () => {
	const saved: Record<string, string | undefined> = {};
	const ENV = [
		"MNEMOSYNE_INTERNAL_SERVICE_SECRET",
		"MNEMOSYNE_MCP_URL",
		"MNEMOSYNE_MCP_ACCESS_TOKEN",
		"MNEMOSYNE_API_BASE_URL",
		"MNEMOSYNE_SERVICE_TOKEN",
		"MNEMOSYNE_GATEWAY_BASE_URL",
		"CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST",
		"CHOREOGRAPH_WORKSPACE_CHAT_MODEL",
		"CHOREOGRAPH_GATEWAY_HUMAN_DELEGATION_SECRET",
		"CHOREOGRAPH_REQUIRE_GATEWAY_GRAPH_ROLE",
	];
	let tempDir: string;
	let cell: GardenDocumentCell;
	let store: SandboxStore;
	let eventBus: SandboxEventBus;
	let spawner: SandboxSpawner;
	let journal: JournalStore;
	let runtime: WorkflowRuntimeStore;
	const workflowTails = new Set<Promise<void>>();
	const logLines: string[] = [];
	const originalConsoleError = console.error;

	before(async () => {
		for (const name of ENV) saved[name] = process.env[name];
		tempDir = mkdtempSync(join(tmpdir(), "choreograph-workspace-chat-"));
		cell = new GardenDocumentCell();
		await cell.start();
		// A sealed local-native runtime tree. Its only job is to pass host
		// admission; these tests assert what happens before the agent speaks.
		const runtimeRoot = join(tempDir, "runtime");
		const entry = join(runtimeRoot, "packages", "coding-agent", "src", "sophia");
		mkdirSync(entry, { recursive: true });
		writeFileSync(join(runtimeRoot, "package.json"), "{}\n");
		writeFileSync(join(runtimeRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
		writeFileSync(join(entry, "host-worker.ts"), "process.exit(3);\n");
		const runtimeDigest = digestSophiaAgentSourceTree(join(entry, "host-worker.ts")).slice("sha256:".length);
		const manifest = join(tempDir, "runtime-bundles.json");
		writeFileSync(
			manifest,
			JSON.stringify({
				bundles: [
					{
						id: "sophia-agent-runtime",
						digest: runtimeDigest,
						mounts: [{ guest_path: "/opt/choreograph-runtime/sophia-agent", mode: "ro", host_path: runtimeRoot }],
					},
				],
			}),
		);
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "shared-secret";
		process.env.MNEMOSYNE_MCP_URL = cell.url;
		process.env.MNEMOSYNE_MCP_ACCESS_TOKEN = "cell-access-token";
		process.env.CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST = manifest;
		process.env.CHOREOGRAPH_WORKSPACE_CHAT_MODEL = "test/workspace-model";
		process.env.CHOREOGRAPH_GATEWAY_HUMAN_DELEGATION_SECRET = "delegation-secret";
		delete process.env.CHOREOGRAPH_REQUIRE_GATEWAY_GRAPH_ROLE;
		for (const name of ["MNEMOSYNE_API_BASE_URL", "MNEMOSYNE_SERVICE_TOKEN", "MNEMOSYNE_GATEWAY_BASE_URL"]) {
			delete process.env[name];
		}
		store = new SandboxStore(join(tempDir, "sandboxes.sqlite"));
		eventBus = createSandboxEventBus(store, { cleanupDelayMs: 0 });
		spawner = new SandboxSpawner(
			store,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{ sandboxMode: "local-native", defaultTimeoutMs: 10_000, eventBus },
		);
		journal = new JournalStore(join(tempDir, "journal.sqlite"));
		runtime = new WorkflowRuntimeStore(join(tempDir, "runtime.sqlite"));
		await journal.init();
		await runtime.init();
		console.error = (...args: unknown[]) => {
			logLines.push(args.map(String).join(" "));
		};
	});

	after(async () => {
		console.error = originalConsoleError;
		// A headed session stays resident for its driver; stop the host, then give
		// the async tail a bounded moment to settle.
		await spawner.shutdownAll();
		await Promise.race([
			Promise.allSettled([...workflowTails]),
			new Promise((resolve) => setTimeout(resolve, 5_000).unref()),
		]);
		journal.close();
		runtime.close();
		store.close();
		await cell.stop();
		rmSync(tempDir, { recursive: true, force: true });
		for (const name of ENV) {
			if (saved[name] === undefined) delete process.env[name];
			else process.env[name] = saved[name];
		}
	});

	const ctx = () => ({ spawner, eventBus, journal, runtime, workflowTails }) as never;

	it("answers a graph with no Domain Agent definition with 404 domain_agent_not_provisioned, not 500", async () => {
		const runsBefore = await journal.listRuns({ ownerUserId: "owner-1", limit: 100 });
		const response = new ResponseRecorder();
		await routeRequest(
			invocationRequest({
				schema: INVOCATION_ENVELOPE_SCHEMA,
				invocationId: "c2chat.inv.angels-1",
				target: {
					workflowName: DOMAIN_AGENT_ACTIVITY_LOOP_NAME,
					workflowUri: `urn:sophia:wf:${DOMAIN_AGENT_ACTIVITY_LOOP_NAME}`,
					definitionDigest: digestOf(DOMAIN_AGENT_ACTIVITY_LOOP_NAME),
				},
				input: {
					definitionDocumentId: "domain-agent-definition",
					trigger: { kind: "sophia-cluster.message", text: "hello", resource: "graph:angels:chat:1" },
					contextRefs: [],
					interactionMode: "headed",
				},
				actorRef: "user:owner-1",
				graph: { ownerPrincipal: "user:owner-1", graphId: "angels" },
			}) as never,
			response as never,
			ctx(),
		);
		assert.equal(response.statusCode, 404, response.body);
		const body = JSON.parse(response.body);
		assert.equal(body.error.code, "domain_agent_not_provisioned");
		assert.deepEqual(await journal.listRuns({ ownerUserId: "owner-1", limit: 100 }), runsBefore);
		assert.ok(
			cell.calls.some(
				(call) => call.tool === "read_document" && call.args.document_id === "domain-agent-definition",
			),
		);
		const logged = logLines.find((line) => line.includes('"code":"domain_agent_not_provisioned"'));
		assert.ok(logged, logLines.join("\n"));
		const record = JSON.parse(logged.slice(logged.indexOf("{")));
		assert.equal(record.event, "invocation_failed");
		assert.equal(record.status, 404);
		assert.equal(record.graphId, "angels");
		assert.equal(record.invocationId, "c2chat.inv.angels-1");
		assert.ok(!logged.includes("cell-access-token") && !logged.includes("shared-secret"));
	});

	it("rejects malformed workspace chat input with 400 and a code", async () => {
		const response = new ResponseRecorder();
		await routeRequest(
			invocationRequest({
				schema: INVOCATION_ENVELOPE_SCHEMA,
				invocationId: "c2chat.inv.bad",
				target: {
					workflowName: WORKSPACE_CHAT_WORKFLOW_NAME,
					workflowUri: `urn:sophia:wf:${WORKSPACE_CHAT_WORKFLOW_NAME}`,
					definitionDigest: digestOf(WORKSPACE_CHAT_WORKFLOW_NAME),
				},
				input: { trigger: { kind: "sophia-cluster.message" }, interactionMode: "headed" },
				actorRef: "user:owner-1",
				graph: { ownerPrincipal: "user:owner-1", graphId: "angels" },
			}) as never,
			response as never,
			ctx(),
		);
		assert.equal(response.statusCode, 400, response.body);
		assert.equal(JSON.parse(response.body).error.code, "workspace_chat_input_invalid");
	});

	it("refuses a service trigger adapter with 403", async () => {
		const response = new ResponseRecorder();
		await routeRequest(
			invocationRequest(
				{
					schema: INVOCATION_ENVELOPE_SCHEMA,
					invocationId: "c2chat.inv.adapter",
					target: {
						workflowName: WORKSPACE_CHAT_WORKFLOW_NAME,
						workflowUri: `urn:sophia:wf:${WORKSPACE_CHAT_WORKFLOW_NAME}`,
						definitionDigest: digestOf(WORKSPACE_CHAT_WORKFLOW_NAME),
					},
					input: { trigger: { kind: "discord.message", text: "hi" }, interactionMode: "headed" },
					actorRef: "user:owner-1",
					graph: { ownerPrincipal: "user:owner-1", graphId: "angels" },
				},
				{ "x-sophia-trigger-adapter": "discord" },
			) as never,
			response as never,
			ctx(),
		);
		assert.equal(response.statusCode, 403, response.body);
		assert.equal(JSON.parse(response.body).error.code, "interaction_mode_denied");
	});

	it("starts a headed Writer chat for a person at the gateway in a graph with no definition: 202, a run, the built-in mode", async () => {
		const response = new ResponseRecorder();
		await routeRequest(
			invocationRequest({
				schema: INVOCATION_ENVELOPE_SCHEMA,
				invocationId: "c2chat.inv.angels-2",
				target: {
					workflowName: WORKSPACE_CHAT_WORKFLOW_NAME,
					workflowUri: `urn:sophia:wf:${WORKSPACE_CHAT_WORKFLOW_NAME}`,
					definitionDigest: digestOf(WORKSPACE_CHAT_WORKFLOW_NAME),
				},
				input: {
					trigger: { kind: "sophia-cluster.message", text: "What is here?", resource: "graph:angels:chat:2" },
					contextRefs: [],
					interactionMode: "headed",
				},
				actorRef: "user:owner-1",
				graph: { ownerPrincipal: "user:owner-1", graphId: "angels" },
			}) as never,
			response as never,
			ctx(),
		);
		assert.equal(response.statusCode, 202, response.body);
		const body = JSON.parse(response.body);
		assert.equal(body.invocationId, "c2chat.inv.angels-2");
		assert.match(body.runId, /^wfr-/);
		assert.equal(body.workflowId, WORKSPACE_CHAT_WORKFLOW_NAME);
		const instance = await runtime.getWorkflowInstance(body.runId);
		assert.ok(instance);
		const inputs = JSON.parse(String((instance as { inputs_json?: string }).inputs_json ?? "{}"));
		const host = readWorkspaceChatHostContext(inputs.hostContext);
		assert.ok(host, "the durable run carries the workspace chat host context");
		assert.equal(host.graphId, "angels");
		// No minted role: the gateway admitted this person at Editor or above, so the chat writes.
		assert.equal(host.mode.mode.iri, WORKSPACE_WRITER_MODE_IRI);
		assert.equal(host.role, "editor");
		assert.equal(inputs.args.pilot.graphAccess, "write");
		assert.equal(inputs.config.model, "test/workspace-model");
		assert.equal(inputs.config.provider, "openrouter");
		// No Domain Agent documents were needed.
		// The workspace path never asks the graph for Domain Agent documents.
		const definitionReads = cell.calls.filter((call) => call.args.document_id === "domain-agent-definition").length;
		assert.equal(definitionReads, 1, "only the earlier domain-loop test read the definition");
	});

	async function startChat(invocationId: string, headers: Record<string, string>, contextRefs: string[] = []) {
		const response = new ResponseRecorder();
		await routeRequest(
			invocationRequest(
				{
					schema: INVOCATION_ENVELOPE_SCHEMA,
					invocationId,
					target: {
						workflowName: WORKSPACE_CHAT_WORKFLOW_NAME,
						workflowUri: `urn:sophia:wf:${WORKSPACE_CHAT_WORKFLOW_NAME}`,
						definitionDigest: digestOf(WORKSPACE_CHAT_WORKFLOW_NAME),
					},
					input: {
						trigger: { kind: "sophia-cluster.message", text: "What is here?" },
						contextRefs,
						interactionMode: "headed",
					},
					actorRef: "user:owner-1",
					graph: { ownerPrincipal: "user:owner-1", graphId: "angels" },
				},
				headers,
			) as never,
			response as never,
			ctx(),
		);
		return response;
	}

	// What this checks: admission and the stored inputs of a viewer's chat. That a real Viewer's chat starts on a cell that
	// hides write tools and completes a turn with a worker that speaks is `viewer-turn.test.ts` (exam 1, section 4).
	it("starts a Reader chat for the role the gateway minted as viewer, and says so in its prompt", async () => {
		const response = await startChat("c2chat.inv.angels-viewer", { ...ANGELS, "x-sophia-graph-role": "viewer" });
		assert.equal(response.statusCode, 202, response.body);
		const instance = await runtime.getWorkflowInstance(JSON.parse(response.body).runId);
		const inputs = JSON.parse(String((instance as { inputs_json?: string }).inputs_json ?? "{}"));
		const host = readWorkspaceChatHostContext(inputs.hostContext)!;
		assert.equal(host.role, "viewer");
		assert.equal(host.mode.mode.iri, WORKSPACE_READER_MODE_IRI);
		assert.equal(inputs.args.pilot.graphAccess, "read");
		assert.match(inputs.args.pilot.systemPrompt, /cannot change anything here/);
	});

	it("refuses a minted role it cannot read with 400 and a code, before any run", async () => {
		const response = await startChat("c2chat.inv.angels-badrole", { ...ANGELS, "x-sophia-graph-role": "superuser" });
		assert.equal(response.statusCode, 400, response.body);
		assert.equal(JSON.parse(response.body).error.code, "graph_role_invalid");
	});

	async function hostOf(response: ResponseRecorder) {
		const instance = await runtime.getWorkflowInstance(JSON.parse(response.body).runId);
		const inputs = JSON.parse(String((instance as { inputs_json?: string }).inputs_json ?? "{}"));
		return { inputs, host: readWorkspaceChatHostContext(inputs.hostContext)! };
	}

	it("with the role header present it is the only rule: a viewer gets the Reader even through the owner's delegated ingress", async () => {
		const owner = { "x-sophia-human-delegation": "delegation-secret" };
		// Control: the owner's delegated ingress with no minted role is the owner (rule 2).
		const control = await startChat("c2chat.inv.angels-owner", owner);
		assert.equal(control.statusCode, 202, control.body);
		assert.equal((await hostOf(control)).host.role, "owner");
		const viewer = await startChat("c2chat.inv.angels-owner-viewer", {
			...owner,
			...ANGELS,
			"x-sophia-graph-role": "viewer",
		});
		assert.equal(viewer.statusCode, 202, viewer.body);
		const seen = await hostOf(viewer);
		assert.equal(seen.host.role, "viewer");
		assert.equal(seen.host.mode.mode.iri, WORKSPACE_READER_MODE_IRI);
		// Handed the Reader's tools that the cell serves (this cell serves five; exam 1, finding 7).
		assert.deepEqual(seen.host.tools, ["read_document", "search_documents", "sparql_query"]);
		assert.ok(seen.host.tools.every((tool: string) => WORKSPACE_READER_TOOLS.includes(tool)));
		assert.equal(seen.inputs.args.pilot.graphAccess, "read");
		const editor = await startChat("c2chat.inv.angels-owner-editor", {
			...owner,
			...ANGELS,
			"x-sophia-graph-role": "editor",
		});
		assert.equal((await hostOf(editor)).host.role, "editor");
	});

	it("lets a viewer start only the workspace chat: any other workflow is 403 before any graph read or run", async () => {
		const definitionReads = () =>
			cell.calls.filter((call) => call.args.document_id === "domain-agent-definition").length;
		const readsBefore = definitionReads();
		// Run ids, not rows: earlier tests' runs are still settling while this one runs.
		const runIds = async () =>
			(await journal.listRuns({ ownerUserId: "owner-1", limit: 100 })).map((run) => run.run_id);
		const runsBefore = await runIds();
		const response = new ResponseRecorder();
		await routeRequest(
			invocationRequest(
				{
					schema: INVOCATION_ENVELOPE_SCHEMA,
					invocationId: "c2chat.inv.angels-viewer-domain",
					target: {
						workflowName: DOMAIN_AGENT_ACTIVITY_LOOP_NAME,
						workflowUri: `urn:sophia:wf:${DOMAIN_AGENT_ACTIVITY_LOOP_NAME}`,
						definitionDigest: digestOf(DOMAIN_AGENT_ACTIVITY_LOOP_NAME),
					},
					input: {
						definitionDocumentId: "domain-agent-definition",
						trigger: { kind: "sophia-cluster.message", text: "hello", resource: "graph:angels:chat:9" },
						contextRefs: [],
						interactionMode: "headed",
					},
					actorRef: "user:owner-1",
					graph: { ownerPrincipal: "user:owner-1", graphId: "angels" },
				},
				{ ...ANGELS, "x-sophia-graph-role": "viewer" },
			) as never,
			response as never,
			ctx(),
		);
		assert.equal(response.statusCode, 403, response.body);
		assert.equal(JSON.parse(response.body).error.code, "workflow_role_insufficient");
		assert.equal(definitionReads(), readsBefore);
		assert.deepEqual(await runIds(), runsBefore);
	});

	it("when the host requires the gateway's role, a chat without one is refused before any run (rule 2 retired by configuration)", async () => {
		process.env.CHOREOGRAPH_REQUIRE_GATEWAY_GRAPH_ROLE = "true";
		try {
			const runIds = async () =>
				(await journal.listRuns({ ownerUserId: "owner-1", limit: 100 })).map((run) => run.run_id);
			const before = await runIds();
			const unminted = await startChat("c2chat.inv.angels-required", {
				"x-sophia-human-delegation": "delegation-secret",
			});
			assert.equal(unminted.statusCode, 403, unminted.body);
			assert.equal(JSON.parse(unminted.body).error.code, "graph_role_required");
			const plain = await startChat("c2chat.inv.angels-required-plain", {});
			assert.equal(plain.statusCode, 403, plain.body);
			assert.equal(JSON.parse(plain.body).error.code, "graph_role_required");
			assert.deepEqual(await runIds(), before, "no run exists for a refused chat");
			const minted = await startChat("c2chat.inv.angels-required-editor", {
				...ANGELS,
				"x-sophia-graph-role": "editor",
			});
			assert.equal(minted.statusCode, 202, minted.body);
			assert.equal((await hostOf(minted)).host.mode.mode.iri, WORKSPACE_WRITER_MODE_IRI);
		} finally {
			delete process.env.CHOREOGRAPH_REQUIRE_GATEWAY_GRAPH_ROLE;
		}
	});

	it("refuses a duplicated role header as unreadable, before any run", async () => {
		const twice = await startChat("c2chat.inv.angels-twice", {
			...ANGELS,
			"x-sophia-graph-role": ["editor", "viewer"] as unknown as string,
		});
		assert.equal(twice.statusCode, 400, twice.body);
		assert.equal(JSON.parse(twice.body).error.code, "graph_role_invalid");
		const joined = await startChat("c2chat.inv.angels-joined", {
			...ANGELS,
			"x-sophia-graph-role": "viewer, viewer",
		});
		assert.equal(joined.statusCode, 400, joined.body);
		assert.equal(JSON.parse(joined.body).error.code, "graph_role_invalid");
	});

	it("refuses a role minted for one graph on an invocation in another (the gateway exam's laundering, at invocation)", async () => {
		const elsewhere = await startChat("c2chat.inv.angels-elsewhere", {
			"x-graph-id": "home",
			"x-graph-owner": "user:owner-1",
			"x-sophia-graph-role": "owner",
		});
		assert.equal(elsewhere.statusCode, 403, elsewhere.body);
		assert.equal(JSON.parse(elsewhere.body).error.code, "graph_binding_mismatch");
		const own = await startChat("c2chat.inv.angels-own", {
			"x-graph-id": "angels",
			"x-graph-owner": "user:owner-1",
			"x-sophia-graph-role": "owner",
		});
		assert.equal(own.statusCode, 202, own.body);
	});

	// Exam 2, finding A. The legacy face (`POST /api/workflows/run`) takes its graph from the body, and the body's owner is
	// optional: the minted headers named `user:bob/notes`, the service authenticated `owner-1`, and the session bound to
	// the caller's own graph with bob's role. A minted role applies to exactly the graph it was minted for.
	describe("exam 2, A: a role minted for one owner-qualified graph binds the session to exactly that graph (legacy face)", () => {
		const BOB_NOTES = { "x-graph-id": "notes", "x-graph-owner": "user:bob" };

		/**
		 * A real HTTP gateway in front of the suite's cell, as Choreograph's service-auth path meets it: `/control/mcp`
		 * lists graphs (both Alice's and Bob's `notes` are visible, so a wrong owner is not hidden by a refusal),
		 * `/o/{owner}/g/{graph}/mcp` reaches the cell, and every path asked is recorded.
		 */
		async function withGateway(run: (paths: string[]) => Promise<void>): Promise<void> {
			const paths: string[] = [];
			const gateway = createHttpServer((req, res) => {
				const chunks: Buffer[] = [];
				req.on("data", (chunk: Buffer) => chunks.push(chunk));
				req.on("end", () => {
					const path = req.url ?? "";
					if (path === "/control/mcp") {
						res.setHeader("content-type", "application/json");
						res.end(
							JSON.stringify({
								jsonrpc: "2.0",
								id: "x",
								result: {
									structuredContent: [
										{ owner: "user:bob", graphId: "notes" },
										{ owner: "user:owner-1", graphId: "notes" },
									],
								},
							}),
						);
						return;
					}
					if (path.endsWith("/activate")) {
						res.statusCode = 200;
						res.end("{}");
						return;
					}
					paths.push(path);
					void fetch(cell.url, {
						method: "POST",
						headers: Object.fromEntries(
							Object.entries(req.headers).filter(
								([name]) => !["host", "content-length", "connection"].includes(name),
							),
						) as Record<string, string>,
						body: Buffer.concat(chunks),
					}).then(async (upstream) => {
						res.statusCode = upstream.status;
						upstream.headers.forEach((value, name) => {
							if (!["content-length", "transfer-encoding", "connection", "content-encoding"].includes(name)) {
								res.setHeader(name, value);
							}
						});
						res.end(Buffer.from(await upstream.arrayBuffer()));
					});
				});
			});
			await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
			const port = (gateway.address() as { port: number }).port;
			const env = {
				MNEMOSYNE_MCP_URL: process.env.MNEMOSYNE_MCP_URL,
				MNEMOSYNE_MCP_ACCESS_TOKEN: process.env.MNEMOSYNE_MCP_ACCESS_TOKEN,
				MNEMOSYNE_SERVICE_TOKEN: process.env.MNEMOSYNE_SERVICE_TOKEN,
				MNEMOSYNE_GATEWAY_BASE_URL: process.env.MNEMOSYNE_GATEWAY_BASE_URL,
				MNEMOSYNE_GRAPH_OWNER: process.env.MNEMOSYNE_GRAPH_OWNER,
			};
			delete process.env.MNEMOSYNE_MCP_URL;
			delete process.env.MNEMOSYNE_MCP_ACCESS_TOKEN;
			delete process.env.MNEMOSYNE_GRAPH_OWNER;
			process.env.MNEMOSYNE_SERVICE_TOKEN = "service-token";
			process.env.MNEMOSYNE_GATEWAY_BASE_URL = `http://127.0.0.1:${port}`;
			try {
				await run(paths);
			} finally {
				for (const [name, value] of Object.entries(env)) {
					if (value === undefined) delete process.env[name];
					else process.env[name] = value;
				}
				gateway.closeAllConnections?.();
				await new Promise<void>((resolve) => gateway.close(() => resolve()));
			}
		}

		async function startLegacy(headers: Record<string, string>, body: Record<string, unknown>) {
			const response = new ResponseRecorder();
			const req = invocationRequest(
				{
					workflow_name: WORKSPACE_CHAT_WORKFLOW_NAME,
					workflow_args: {
						trigger: { kind: "sophia-cluster.message", text: "What is here?" },
						contextRefs: [],
						interactionMode: "headed",
					},
					...body,
				},
				headers,
			);
			(req as { url: string }).url = "/api/workflows/run";
			await routeRequest(req as never, response as never, ctx());
			return response;
		}
		async function boundTo(response: ResponseRecorder) {
			const seen = await hostOf(response);
			// The session's graph is named by its agent identity: `<prefix>:<owner>/<graph>`.
			const named = /"registeredName":"[^":]+:([^/"]+)\/([^"]+)"/.exec(JSON.stringify(seen.inputs.args.pilot));
			assert.ok(named, "the session's agent names its graph");
			return { host: seen.host, pilot: { ownerPrincipal: named[1], graphId: named[2] } };
		}
		const BOB_MCP = `/o/${encodeURIComponent("user:bob")}/g/notes/mcp`;

		it("binds to the minted owner when the body omits graph_owner, never to the authenticated caller", async () => {
			await withGateway(async (paths) => {
				const response = await startLegacy(
					{ ...BOB_NOTES, "x-sophia-graph-role": "editor" },
					{ graph_id: "notes" },
				);
				assert.equal(response.statusCode, 202, response.body);
				const { host, pilot } = await boundTo(response);
				assert.equal(pilot.ownerPrincipal, "user:bob", "the session's agent is bob's graph's");
				assert.equal(pilot.graphId, "notes");
				assert.equal(host.role, "editor");
				assert.ok(paths.length > 0, "the host reached a graph");
				assert.deepEqual([...new Set(paths)], [BOB_MCP], "every graph call went to bob's graph, none to alice's");
			});
		});

		it("does not let MNEMOSYNE_GRAPH_OWNER stand in for the minted owner", async () => {
			await withGateway(async (paths) => {
				process.env.MNEMOSYNE_GRAPH_OWNER = "user:somebody-else";
				const response = await startLegacy(
					{ ...BOB_NOTES, "x-sophia-graph-role": "viewer" },
					{ graph_id: "notes" },
				);
				assert.equal(response.statusCode, 202, response.body);
				assert.equal((await boundTo(response)).pilot.ownerPrincipal, "user:bob");
				assert.deepEqual([...new Set(paths)], [BOB_MCP]);
			});
		});

		it("refuses, before any graph read, a body that names another owner or another graph", async () => {
			await withGateway(async (paths) => {
				const readsBefore = cell.calls.length;
				const otherOwner = await startLegacy(
					{ ...BOB_NOTES, "x-sophia-graph-role": "editor" },
					{ graph_id: "notes", graph_owner: "user:owner-1" },
				);
				assert.equal(otherOwner.statusCode, 403, otherOwner.body);
				assert.equal(JSON.parse(otherOwner.body).error.code, "graph_binding_mismatch");
				const otherGraph = await startLegacy(
					{ ...BOB_NOTES, "x-sophia-graph-role": "editor" },
					{ graph_id: "home", graph_owner: "user:bob" },
				);
				assert.equal(otherGraph.statusCode, 403, otherGraph.body);
				assert.equal(JSON.parse(otherGraph.body).error.code, "graph_binding_mismatch");
				assert.equal(cell.calls.length, readsBefore, "no graph read happened");
				assert.deepEqual(paths, [], "nothing reached any graph");
			});
		});

		it("on the legacy owner-less route the caller is the owner, and a body naming that owner is accepted", async () => {
			await withGateway(async (paths) => {
				const response = await startLegacy(
					{ "x-graph-id": "notes", "x-sophia-graph-role": "owner" },
					{ graph_id: "notes", graph_owner: "user:owner-1" },
				);
				assert.equal(response.statusCode, 202, response.body);
				assert.equal((await boundTo(response)).pilot.ownerPrincipal, "user:owner-1");
				assert.deepEqual([...new Set(paths)], [`/o/${encodeURIComponent("user:owner-1")}/g/notes/mcp`]);
			});
		});
	});

	it("reads every page of the live tools/list and hands over, and describes, exactly the live intersection (exam 1)", async () => {
		const fixture = JSON.parse(
			readFileSync(new URL("./fixtures/garden-cell-tools-r20261002.json", import.meta.url), "utf8"),
		) as { tools: Array<{ name: string; requiredScopes: string[] }> };
		// The cell serves its 102 tools minus `surface`, ten to a page: the write tools sit well past the first page.
		cell.tools = fixture.tools
			.filter((tool) => tool.name !== "surface")
			.map((tool) => ({ name: tool.name, scopes: tool.requiredScopes }));
		cell.pageSize = 10;
		try {
			const response = await startChat("c2chat.inv.angels-live", { ...ANGELS, "x-sophia-graph-role": "editor" });
			assert.equal(response.statusCode, 202, response.body);
			const seen = await hostOf(response);
			const expected = WORKSPACE_WRITER_TOOLS.filter((tool) => tool !== "surface");
			assert.deepEqual(seen.host.tools, [...expected].sort());
			assert.deepEqual(seen.inputs.args.pilot.includeTools, [...expected].sort());
			assert.doesNotMatch(seen.inputs.args.pilot.systemPrompt, /`surface`/);
			assert.match(
				seen.inputs.args.pilot.systemPrompt,
				/`delete_document`/,
				"a tool from a later page is described",
			);
		} finally {
			cell.tools = undefined;
			cell.pageSize = undefined;
		}
	});

	it("keeps the first turn's refs out of the run's prompt and in the host context (D5), only those the graph answers", async () => {
		// Exam 1: a ref is the host's assertion that the person has it open, so the graph must answer it for the person
		// first; a document the graph does not have (or the person may not read) is dropped before the model is told.
		cell.documents.set("q3-plan", "# Q3 plan");
		const response = await startChat("c2chat.inv.angels-refs", { ...ANGELS, "x-sophia-graph-role": "editor" }, [
			"someone-elses-doc",
			"q3-plan",
		]);
		assert.equal(response.statusCode, 202, response.body);
		const seen = await hostOf(response);
		assert.equal(seen.inputs.args.text, "What is here?");
		assert.deepEqual(seen.host.contextRefs, ["q3-plan"]);
		assert.ok(
			cell.calls.some((call) => call.tool === "read_document" && call.args.document_id === "someone-elses-doc"),
			"the dropped ref was asked of the graph",
		);
	});
});
