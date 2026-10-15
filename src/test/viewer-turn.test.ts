/**
 * Exam 1, finding 2 (and the weak "starts a Reader chat" test it named). A person who can only view a graph must be able
 * to start a workspace chat and have it answer, and the host must never write to that graph for them:
 *
 * - the run's own graph proxy demanded `write_document` and `sparql_update` at startup (`orchestrator.ts` requiredTools),
 *   which a real Viewer's cell does not serve, so a Viewer's chat could not start;
 * - the run's bookkeeping (wf: provenance at start, per node and at the end, the agt: fold) and the Session-family
 *   projection pump wrote to the graph with `sparql_update`, as the person, outside every manifest.
 *
 * Here the cell answers as a Viewer's lease makes garden answer (write tools hidden and refused), and the worker is a
 * scripted Prime worker that really speaks: it reads a document through the host, tries a write, and completes its turn
 * with a reply and a valid checkpoint. Nothing is mocked but the model (the worker's words are scripted).
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Store } from "oxigraph";
import type { AgentSessionFamilyGraphProxy } from "../agent-runtime/agent-session-family-graph-projection.js";
import type { AgentSessionFamilyProjectionPump } from "../agent-runtime/agent-session-family-projection-pump.js";
import { digestAgentRuntimeBinding } from "../agent-runtime/profile.js";
import { SandboxStore } from "../sandbox-store.js";
import { SandboxSpawner } from "../spawner.js";
import type { WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { workspaceChatHostWritesGraph } from "../workflow/workspace-chat.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";
import { useInvocationHarness, withRuntime } from "./chat-runtime-fixture.js";

const CANONICAL_JSON = new URL("../../packages/canonical-json/dist/index.js", import.meta.url).href;

/** A Prime worker that speaks the host bridge: one read, one attempted write, one reply, a valid checkpoint. */
const SCRIPTED_WORKER = `
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { canonicalJson } from ${JSON.stringify(CANONICAL_JSON)};

let context;
let sequence = 0;
let messages = 0;
const pending = new Map();
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const envelope = () => ({
	protocol: "choreograph.prime-host-bridge.v1",
	messageId: "worker:" + context.sandboxId + ":" + context.generation + ":" + messages++,
	sessionId: context.sessionId,
	sandboxId: context.sandboxId,
	generation: context.generation,
	correlationId: context.correlationId,
	direction: "worker_to_host",
});
const event = (name, payload) => send({ ...envelope(), kind: "event", workerSequence: sequence++, name, payload });
const request = (name, payload) => {
	const requestId = "req-" + sequence;
	const answered = new Promise((resolve) => pending.set(requestId, resolve));
	send({ ...envelope(), correlationId: requestId, kind: "request", workerSequence: sequence++, name, payload: { requestId, ...payload } });
	return answered;
};

async function turn() {
	const r = context.request;
	event("turn.started", { turn: 1 });
	event("tool.started", { tool: "read_document", args: { document_id: "q3-plan" } });
	const read = await request("capability.request", {
		capability: "mnemosyne",
		tool: "read_document",
		args: { document_id: "q3-plan", format: "markdown" },
	});
	event("tool.completed", { tool: "read_document", result: read.ok ? "read" : "refused" });
	const write = await request("capability.request", {
		capability: "mnemosyne",
		tool: "write_document",
		args: { document_id: "q3-plan", content: "changed" },
	});
	const output = "read " + (read.ok ? "ok" : "refused") + "; write " + (write.ok ? "ok" : "refused");
	event("message.completed", { output });
	event("turn.completed", { turn: 1 });
	const unsigned = {
		schema: "sophia.prime-runtime-state.v2",
		sessionId: r.session_id,
		sandboxId: r.spawn_id,
		generation: r.generation,
		runtimeBindingDigest: r.runtime_binding_digest,
		ontologyBindingDigest: r.agent_ontology_binding_digest,
		sessionHeader: { type: "session" },
		...(r.embodiment_binding_digest ? { embodimentDigest: r.embodiment_binding_digest } : {}),
		...(r.runtime_overlays ? { runtimeOverlayDigests: r.runtime_overlays.map((o) => o.artifactDigest) } : {}),
		entries: [],
		goal: null,
		autonomous: null,
		workerSequence: sequence,
		createdAt: new Date().toISOString(),
	};
	const prime_state = { ...unsigned, digest: "sha256:" + createHash("sha256").update(canonicalJson(unsigned)).digest("hex") };
	send({
		...envelope(),
		kind: "result",
		workerSequence: sequence++,
		name: "runtime.result",
		payload: {
			result: {
				spawn_id: r.spawn_id,
				status: "terminated",
				output,
				turns: 1,
				tokens: 0,
				tool_calls: 2,
				session_id: r.session_id,
				runtime_binding_digest: r.runtime_binding_digest,
				agent_ontology_binding_digest: r.agent_ontology_binding_digest,
				...(r.embodiment_binding_digest ? { embodiment_digest: r.embodiment_binding_digest } : {}),
				...(r.runtime_overlays ? { runtime_overlay_digests: r.runtime_overlays.map((o) => o.artifactDigest) } : {}),
				prime_state,
			},
		},
	});
}

createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line);
	if (message.kind === "response") {
		pending.get(message.requestId)?.(message);
		return;
	}
	if (message.kind === "command" && (message.name === "runtime.initialize" || message.name === "runtime.restore")) {
		context = {
			sessionId: message.sessionId,
			sandboxId: message.sandboxId,
			generation: message.generation,
			correlationId: message.correlationId,
			request: message.payload.request,
		};
		void turn();
	}
}).on("close", () => process.exit(0));
`;

const NOTES_AS_VIEWER = { "x-graph-id": "angels", "x-graph-owner": "user:owner-1", "x-sophia-graph-role": "viewer" };

describe("exam 1: a real Viewer starts a workspace chat, and it answers, and the host writes nothing to the graph", () => {
	const h = useInvocationHarness({ workerSource: SCRIPTED_WORKER });

	it("starts on a Viewer's cell, reads, has its write refused by the host, completes the turn, and leaves the graph untouched", async () => {
		h.cell.role = "viewer";
		h.cell.documents.set("q3-plan", "# Q3 plan");
		const started = await h.post(h.chat("c2chat.inv.viewer-turn"), NOTES_AS_VIEWER);
		assert.equal(started.statusCode, 202, started.body);
		const session = await h.waitForSession(started.json.runId);

		// The turn completes: the reply is durable on the Session.
		const deadline = Date.now() + 30_000;
		let reply: string | undefined;
		while (reply === undefined && Date.now() < deadline) {
			const events = await h.runtime.listAgentSessionEvents(session.session_id);
			const completed = events.find((event) => event.type === "message.completed");
			reply = (completed?.payload as { value?: { output?: string } } | undefined)?.value?.output;
			if (reply === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(reply, "read ok; write refused", "the Viewer's chat read, and its write was refused");
		await h.settle();

		// The pilot read as the person; the write never reached the cell (the Reader refused it first).
		assert.ok(
			h.cell.calls.some((call) => call.tool === "read_document" && call.args.document_id === "q3-plan"),
			"the pilot read the document through the cell",
		);
		assert.deepEqual(h.cell.refused, [], "no write reached the cell to be refused there");
		// No bookkeeping either: no provenance, no fold, no projection, nothing written for this person.
		const writes = h.cell.calls.filter((call) => ["sparql_update", "write_document", "rdf_load"].includes(call.tool));
		assert.deepEqual(writes, [], JSON.stringify(writes));
	});
});

/** A root Session of `workflowName`, materialized, with the graph access its document records. */
async function seedChatRoot(runtime: WorkflowRuntimeStore, suffix: string, graphAccess: "read" | "write") {
	const sessionId = `ags-proj-${suffix}`;
	const runId = `wfr-proj-${suffix}`;
	const semantic = makeTestAgentSemanticBinding({
		graphId: "angels",
		kind: "prime",
		registeredName: `chat-${suffix}`,
	});
	await runtime.createWorkflowInstance({
		runId,
		workflowName: "workspace-chat-v1",
		graphId: "angels",
		ownerUserId: "owner-1",
		inputs: {},
		startedAt: 1,
	});
	const spec: AgentNodeSpec = {
		label: "pilot-headed",
		phaseIndex: 1,
		prompt: "hi",
		model: "mock:done",
		provider: "openrouter",
		graphId: "angels",
		sessionId,
		graphAccess,
		interactionMode: "headed",
		agentId: semantic.agentId,
		runtime: semantic.runtime,
		runtimeBindingDigest: digestAgentRuntimeBinding(semantic.runtime),
		ontology: semantic.ontology,
		ontologyBindingDigest: semantic.ontologyBindingDigest,
	};
	await runtime.beginAgentSession({
		sessionId,
		runId,
		workflowName: "workspace-chat-v1",
		graphId: "angels",
		ownerUserId: "owner-1",
		graphOwnerPrincipal: "user:owner-1",
		spec,
		nodeKey: "1:pilot-headed",
		frontier: { kind: "before-node", sessionId, phaseIndex: 1, ts: 1 },
		now: 1,
	});
	return sessionId;
}

describe("exam 1: the Session-family projection never writes a Reader chat to the graph", () => {
	it("projects a Writer chat, and completes a Reader chat's outbox without asking for graph authority", async () => {
		await withRuntime(async (runtime, directory) => {
			const reader = await seedChatRoot(runtime, "reader", "read");
			const writer = await seedChatRoot(runtime, "writer", "write");
			const asked: string[] = [];
			const graph = new Store();
			const proxy: AgentSessionFamilyGraphProxy = {
				async callTool(_tool: string, args: Record<string, unknown>) {
					graph.update(String(args.update));
					return {};
				},
			} as unknown as AgentSessionFamilyGraphProxy;
			// The spawner's own pump, with the spawner's own policy: only the graph-authority factory is observed.
			const spawner = new SandboxSpawner(
				new SandboxStore(join(directory, "sandboxes.sqlite")),
				{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
				{ sandboxMode: "local-native", workflowRuntime: runtime },
			);
			(spawner as unknown as { createFamilyProjectionGraphLease: unknown }).createFamilyProjectionGraphLease =
				async (authority: { rootSessionId: string }) => {
					asked.push(authority.rootSessionId);
					return { proxy, close: async () => {} };
				};
			const pump = (spawner as unknown as { familyProjectionPump: AgentSessionFamilyProjectionPump })
				.familyProjectionPump;
			await pump.start();
			await pump.stop();
			assert.deepEqual(asked, [writer], "only the Writer chat asked for graph authority");
			assert.equal(
				await runtime.claimAgentSessionFamilyProjectionOutbox({ consumer: "after", leaseMs: 10, now: Date.now() }),
				null,
				"the Reader chat's outbox was settled, not left to retry",
			);
			assert.equal(workspaceChatHostWritesGraph({ workflow_name: "workspace-chat-v1", document_json: "{}" }), false);
			void reader;
		});
	});
});
