import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	MEANINGFUL_OBJECT_REF_SCHEMA,
	type MeaningfulObjectKind,
	type MeaningfulObjectRefV1,
} from "../agent-runtime/meaningful-object.js";
import {
	AGENT_ONTOLOGY_BINDING_SCHEMA,
	AgentOntologyBindingFault,
	type AgentOntologyBindingV1,
	digestAgentOntologyBinding,
	validateAgentOntologyBinding,
} from "../agent-runtime/ontology-binding.js";
import {
	AGENT_RUNTIME_BINDING_SCHEMA,
	type AgentRuntimeBindingV2,
	type AgentRuntimeBundleRefV1,
	digestAgentRuntimeBinding,
	PRIME_AGENT_RUNTIME_BASELINE,
	resolveAgentRuntimeBinding,
} from "../agent-runtime/profile.js";
import {
	CANONICAL_AGENT_ID,
	mintAgentUri,
	STANDALONE_AGENT_IDENTITY_ALGORITHM,
} from "../agent-subject/agent-ontology.js";
import { AgentSessionBindingConflictError, WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import type { AgentNodeSpec } from "../workflow/types.js";

const agentId = "agent-0123456789abcdef";
assert.match(agentId, CANONICAL_AGENT_ID);

function ref<Kind extends MeaningfulObjectKind>(
	kind: Kind,
	objectId: string,
	character: string,
): MeaningfulObjectRefV1<Kind> {
	return {
		schema: MEANINGFUL_OBJECT_REF_SCHEMA,
		kind,
		ownerPrincipal: "user:test",
		graphId: "g1",
		objectId,
		version: "1",
		digest: `sha256:${character.repeat(64)}`,
	};
}

const profileRef = ref("agent-runtime-profile", "prime-profile", "1");
const bundle: AgentRuntimeBundleRefV1 = {
	id: "sophia-agent-runtime",
	digest: `sha256:${"a".repeat(64)}`,
};
const profile: AgentRuntimeBindingV2 = {
	schema: AGENT_RUNTIME_BINDING_SCHEMA,
	kind: "prime",
	bundle,
	profileRef,
	constraints: PRIME_AGENT_RUNTIME_BASELINE,
};
const runtime = resolveAgentRuntimeBinding(
	{ kind: "prime", profileRef, constraints: { maxTurns: 8 } },
	{ bundles: { simple: bundle, prime: bundle }, profile },
);

const ontology: AgentOntologyBindingV1 = {
	schema: AGENT_ONTOLOGY_BINDING_SCHEMA,
	subject: {
		agentId,
		agentUri: mintAgentUri(agentId),
		observerId: agentId,
		registeredName: "researcher",
		identityAlgorithm: STANDALONE_AGENT_IDENTITY_ALGORITHM,
	},
	objects: {
		agent: ref("agent", "researcher", "2"),
		geist: ref("geist", "researcher-geist", "3"),
		prompt: ref("prompt", "researcher-prompt", "4"),
		skills: [ref("skill", "edit", "5"), ref("skill", "goal", "6")],
		harness: ref("harness", "researcher-harness", "7"),
		toolManifest: ref("tool-manifest", "researcher-tools", "8"),
		toolGrant: ref("tool-grant", "researcher-grant", "9"),
		runtimeProfile: profileRef,
	},
	resolvedAt: 1_000,
};

function nodeSpec(): AgentNodeSpec {
	return {
		label: "prime-node",
		phaseIndex: 1,
		prompt: "research",
		model: "mock:done",
		graphId: "g1",
		agentId,
		runtime,
		runtimeBindingDigest: digestAgentRuntimeBinding(runtime),
		ontology,
		ontologyBindingDigest: digestAgentOntologyBinding(ontology),
	};
}

describe("Agent Ontology runtime binding", () => {
	it("requires the agent and observer to be one witness and every slot to be a typed Meaningful Object", () => {
		validateAgentOntologyBinding(ontology);
		assert.throws(
			() =>
				validateAgentOntologyBinding({
					...ontology,
					subject: { ...ontology.subject, observerId: "agent-deadbeef" },
				}),
			AgentOntologyBindingFault,
		);
		assert.throws(
			() =>
				validateAgentOntologyBinding({
					...ontology,
					objects: { ...ontology.objects, geist: ref("prompt", "wrong-kind", "c") },
				}),
			AgentOntologyBindingFault,
		);
	});

	it("persists the complete pinned binding before spawn and rejects resume drift", async () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-ontology-runtime-"));
		const store = new WorkflowRuntimeStore(join(dir, "runtime.sqlite"));
		after(() => rmSync(dir, { recursive: true, force: true }));
		await store.init();
		await store.createWorkflowInstance({
			runId: "run-ontology",
			workflowName: "ontology-workflow",
			graphId: "g1",
			ownerUserId: "u1",
			inputs: {},
			startedAt: 1_000,
		});

		const spec = nodeSpec();
		await store.beginAgentSession({
			sessionId: "ags-ontology",
			runId: "run-ontology",
			workflowName: "ontology-workflow",
			graphId: "g1",
			ownerUserId: "u1",
			graphOwnerPrincipal: "user:u1",
			spec,
			nodeKey: "1:prime-node",
			frontier: {
				kind: "before-node",
				nodeKey: "1:prime-node",
				sessionId: "ags-ontology",
				label: "prime-node",
				phaseIndex: 1,
				ts: 1_001,
			},
			now: 1_001,
		});

		const stored = await store.readAgentSession("ags-ontology");
		assert.ok(stored);
		const document = JSON.parse(stored.document_json);
		assert.equal(document.source.runtimeBinding.schema, AGENT_RUNTIME_BINDING_SCHEMA);
		assert.equal(document.source.runtimeBinding.profileRef.objectId, "prime-profile");
		assert.equal(document.source.agentOntologyBinding.schema, AGENT_ONTOLOGY_BINDING_SCHEMA);
		assert.equal(document.source.agentOntologyBinding.objects.agent.objectId, "researcher");
		assert.equal(document.source.agentOntologyBinding.objects.geist.objectId, "researcher-geist");
		assert.equal(document.source.agentOntologyBindingDigest, spec.ontologyBindingDigest);
		const driftRuntime: AgentRuntimeBindingV2 = {
			...runtime,
			constraints: { ...runtime.constraints, maxTurns: runtime.constraints.maxTurns - 1 },
		};

		await assert.rejects(
			() =>
				store.beginAgentSession({
					sessionId: "ags-ontology",
					runId: "run-ontology",
					workflowName: "ontology-workflow",
					graphId: "g1",
					ownerUserId: "u1",
					graphOwnerPrincipal: "user:u1",
					spec: {
						...spec,
						runtime: driftRuntime,
						runtimeBindingDigest: digestAgentRuntimeBinding(driftRuntime),
					},
					nodeKey: "1:prime-node",
					frontier: {
						kind: "before-node",
						nodeKey: "1:prime-node",
						sessionId: "ags-ontology",
						label: "prime-node",
						phaseIndex: 1,
						ts: 1_002,
					},
					now: 1_002,
				}),
			AgentSessionBindingConflictError,
		);
		store.close();
	});

	it("journals append-only compute cells and projects a reconstructable read-only notebook", async () => {
		const dir = mkdtempSync(join(tmpdir(), "execution-journal-"));
		const store = new WorkflowRuntimeStore(join(dir, "runtime.sqlite"));
		await store.init();
		try {
			await store.createWorkflowInstance({
				runId: "run-cells",
				workflowName: "cell-workflow",
				graphId: "g1",
				ownerUserId: "u1",
				inputs: {},
				startedAt: 2_000,
			});
			await store.beginAgentSession({
				sessionId: "ags-cells",
				runId: "run-cells",
				workflowName: "cell-workflow",
				graphId: "g1",
				ownerUserId: "u1",
				graphOwnerPrincipal: "user:u1",
				spec: nodeSpec(),
				nodeKey: "1:prime-node",
				frontier: { kind: "before-node", nodeKey: "1:prime-node", sessionId: "ags-cells", ts: 2_001 },
				now: 2_001,
			});
			await store.claimAgentMaterialization("ags-cells", {
				generation: 0,
				activationId: "ags-cells:generation:0",
				now: 2_002,
			});
			await store.bindAgentSandbox("ags-cells", {
				sandboxId: "sandbox-cells",
				generation: 0,
				activationId: "ags-cells:generation:0",
				now: 2_003,
			});
			const cell = {
				schema: "choreograph.compute-cell.v1" as const,
				cellRef: "compute.cell:ags-cells:0",
				sessionId: "ags-cells",
				leaseId: "kls-1",
				kernelSandboxId: "kernel-1",
				inputId: "input-0",
				ordinal: 0,
				generation: 0,
				code: "x = 40\nx + 2",
				status: "ok" as const,
				executionCount: 1,
				outputs: [{ kind: "result" as const, data: { "text/plain": "42" } }],
				startedAt: 2_010,
				completedAt: 2_025,
				durationMs: 15,
				hostRequests: [],
				cellDigest: `sha256:${"b".repeat(64)}`,
			};
			await store.appendExecutionCell("ags-cells", "ags-cells:generation:0", cell);
			await store.appendExecutionCell("ags-cells", "ags-cells:generation:0", cell);
			const rows = await store.listExecutionCells("ags-cells");
			assert.equal(rows.length, 1, "cell identity makes journal appends idempotent");
			assert.equal(JSON.parse(rows[0].outputs_json)[0].data["text/plain"], "42");
			const session = await store.readAgentSession("ags-cells");
			assert.ok(session);
			const document = JSON.parse(session.document_json);
			assert.deepEqual(document.compute.order, [cell.cellRef]);
			assert.equal(document.compute.cells[cell.cellRef].code, cell.code);
			assert.equal(document.view.panes.find((pane: { id: string }) => pane.id === "notebook").readOnly, true);
			const events = await store.listAgentSessionEvents("ags-cells");
			const journaled = events.filter((event) => event.type === "compute.cell");
			assert.equal(journaled.length, 1);
			const payload = journaled[0].payload as { value?: { cellRef?: string } };
			assert.equal(payload.value?.cellRef, cell.cellRef);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
