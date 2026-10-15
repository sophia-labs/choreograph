import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentSessionRelationFault, WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

describe("host-owned Agent Session child registry", () => {
	it("persists one event-free immutable relation across idempotent retries", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-child-registry-"));
		const database = join(directory, "runtime.sqlite");
		const runtime = new WorkflowRuntimeStore(database);
		try {
			await runtime.init();
			await seedSession(runtime, "ags-parent", "user:ada", "prime-notebook-lab", 1);
			await seedSession(runtime, "ags-child", "user:ada", "prime-notebook-lab", 2);

			const first = await runtime.registerAgentSessionChild("ags-parent", "ags-child", {
				now: 10,
				causationId: "spawn-request:req-1",
			});
			const duplicate = await runtime.registerAgentSessionChild("ags-parent", "ags-child", {
				now: 20,
				causationId: "spawn-request:req-replayed",
			});

			assert.equal(first.created, true);
			assert.equal(duplicate.created, false);
			assert.deepEqual(duplicate.relation, first.relation);
			assert.match(first.relation.relation_id, /^asr_[0-9a-f]{64}$/);
			assert.deepEqual(first.relation, {
				relation_id: first.relation.relation_id,
				relation_kind: "parent_child",
				parent_session_id: "ags-parent",
				child_session_id: "ags-child",
				owner_user_id: "user:ada",
				graph_id: "prime-notebook-lab",
				causation_id: "spawn-request:req-1",
				created_at: 10,
			});
			assert.deepEqual(await runtime.readAgentSessionParent("ags-child"), first.relation);
			assert.deepEqual(await runtime.listAgentSessionChildren("ags-parent"), [first.relation]);

			assert.equal(
				(await runtime.listAgentSessionEvents("ags-parent")).filter((event) => event.type.startsWith("child."))
					.length,
				0,
				"the F1 relation primitive is not child creation testimony",
			);
			assert.equal(
				(await runtime.listAgentSessionEvents("ags-child")).filter((event) => event.type === "child.created")
					.length,
				0,
				"child.created belongs to the parent timeline; the child reads its parent from the registry",
			);
			runtime.close();

			const reopened = new WorkflowRuntimeStore(database);
			await reopened.init();
			assert.deepEqual(await reopened.readAgentSessionParent("ags-child"), first.relation);
			reopened.close();
		} finally {
			runtime.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rejects orphaned, self, cross-owner, and cross-graph relations", async () => {
		await withRuntime(async (runtime) => {
			await seedSession(runtime, "ags-parent", "user:ada", "graph-a", 1);
			await seedSession(runtime, "ags-other-owner", "user:mallory", "graph-a", 2);
			await seedSession(runtime, "ags-other-graph", "user:ada", "graph-b", 3);

			await rejectsRelation(
				runtime.registerAgentSessionChild("ags-parent", "ags-missing", { now: 10 }),
				"session_not_found",
			);
			await rejectsRelation(
				runtime.registerAgentSessionChild("ags-parent", "ags-parent", { now: 11 }),
				"self_relation",
			);
			await rejectsRelation(
				runtime.registerAgentSessionChild("ags-parent", "ags-other-owner", { now: 12 }),
				"owner_mismatch",
			);
			await rejectsRelation(
				runtime.registerAgentSessionChild("ags-parent", "ags-other-graph", { now: 13 }),
				"graph_mismatch",
			);
			assert.deepEqual(await runtime.listAgentSessionChildren("ags-parent"), []);
		});
	});

	it("rejects cycles and refuses to reparent an existing child", async () => {
		await withRuntime(async (runtime) => {
			for (const [index, sessionId] of ["ags-a", "ags-b", "ags-c", "ags-d"].entries()) {
				await seedSession(runtime, sessionId, "user:ada", "graph-a", index + 1);
			}
			await runtime.registerAgentSessionChild("ags-a", "ags-b", { now: 10 });
			await runtime.registerAgentSessionChild("ags-b", "ags-c", { now: 11 });

			await rejectsRelation(runtime.registerAgentSessionChild("ags-c", "ags-a", { now: 12 }), "cycle");
			await rejectsRelation(
				runtime.registerAgentSessionChild("ags-d", "ags-b", { now: 13 }),
				"child_already_attached",
			);
			assert.equal((await runtime.listAgentSessionChildren("ags-a")).length, 1);
			assert.equal((await runtime.listAgentSessionChildren("ags-b")).length, 1);
			assert.equal(await runtime.readAgentSessionParent("ags-a"), null);
		});
	});
});

async function withRuntime(run: (runtime: WorkflowRuntimeStore) => Promise<void>): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "agent-child-registry-"));
	const runtime = new WorkflowRuntimeStore(join(directory, "runtime.sqlite"));
	try {
		await runtime.init();
		await run(runtime);
	} finally {
		runtime.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

async function seedSession(
	runtime: WorkflowRuntimeStore,
	sessionId: string,
	ownerUserId: string,
	graphId: string,
	phaseIndex: number,
): Promise<void> {
	const runId = `wfr-${sessionId}`;
	const workflowName = `wf-${sessionId}`;
	await runtime.createWorkflowInstance({
		runId,
		workflowName,
		graphId,
		ownerUserId,
		inputs: {},
		startedAt: phaseIndex,
	});
	const spec: AgentNodeSpec = {
		label: sessionId,
		phaseIndex,
		prompt: `run ${sessionId}`,
		model: "mock:done",
		graphId,
		sessionId,
		...makeTestAgentSemanticBinding({ graphId, registeredName: sessionId }),
	};
	await runtime.beginAgentSession({
		sessionId,
		runId,
		workflowName,
		graphId,
		ownerUserId,
		graphOwnerPrincipal: "user:registry-owner",
		spec,
		nodeKey: `${phaseIndex}:${sessionId}`,
		frontier: { kind: "before-node", sessionId, phaseIndex, ts: phaseIndex },
		now: phaseIndex,
	});
}

async function rejectsRelation(promise: Promise<unknown>, reason: AgentSessionRelationFault["reason"]): Promise<void> {
	await assert.rejects(
		promise,
		(error: unknown) => error instanceof AgentSessionRelationFault && error.reason === reason,
	);
}
