import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { SophiaContentStore } from "../agent-runtime/content-store.js";
import { AgentMemory } from "../agent-runtime/memory.js";
import {
	isWorkflowPausedError,
	makeRuntimeNodeRunner,
	stableAgentSessionId,
	stableWorkflowNodeKey,
} from "../workflow/runtime-control.js";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import type { AgentNodeResult, AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

function tmpRuntime(): { runtime: WorkflowRuntimeStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "workflow-runtime-test-"));
	const runtime = new WorkflowRuntimeStore(join(dir, "runtime.sqlite"));
	return { runtime, dir };
}

const spec: AgentNodeSpec = {
	label: "map:d1",
	phaseIndex: 1,
	prompt: "survey d1",
	model: "mock:done",
	graphId: "g1",
	agentType: "surveyor",
	...makeTestAgentSemanticBinding({ graphId: "g1", registeredName: "surveyor" }),
};

function resultFor(input: AgentNodeSpec): AgentNodeResult {
	return {
		nodeKey: input.nodeKey,
		sessionId: input.sessionId,
		invocationId: input.invocationId,
		label: input.label,
		phaseIndex: input.phaseIndex,
		state: "done",
		output: "ok",
		model: input.model,
		agentId: input.agentId,
		turns: 1,
		toolCalls: 0,
		tokens: 12,
		queuedAt: 1000,
		startedAt: 1100,
		durationMs: 200,
		agentType: input.agentType,
	};
}

describe("workflow runtime control", () => {
	it("stores a node as an agent session and replays completed results on resume", async () => {
		const { runtime, dir } = tmpRuntime();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await runtime.init();
		await runtime.createWorkflowInstance({
			runId: "run-1",
			workflowName: "wf",
			graphId: "g1",
			ownerUserId: "u1",
			sourceSha256: "sha",
			sourceText: "export const meta = {}",
			inputs: { config: { graphId: "g1", model: "mock:done" }, args: {} },
			startedAt: 900,
		});

		let calls = 0;
		const durableTransitions: string[] = [];
		const runner = makeRuntimeNodeRunner({
			runtime,
			memory: new AgentMemory(SophiaContentStore.fromUrl(new URL("memory/", `file://${dir}/`).toString()), runtime),
			runId: "run-1",
			workflowName: "wf",
			graphId: "g1",
			ownerUserId: "u1",
			graphOwnerPrincipal: "user:u1",
			now: () => 1200 + calls,
			onDurableSessionTransition: async (input, status) => {
				const stored = await runtime.readAgentSession(input.sessionId ?? "");
				durableTransitions.push(`${status}:${stored?.status ?? "missing"}`);
			},
			baseRunner: async (input) => {
				calls++;
				await runtime.bindAgentSandbox(input.sessionId!, {
					sandboxId: "sandbox-runtime-control",
					generation: input.sandboxGeneration ?? 0,
					activationId: input.invocationId!,
					now: 1200,
				});
				return resultFor(input);
			},
		});

		const first = await runner(spec);
		assert.equal(calls, 1);
		assert.equal(first.nodeKey, stableWorkflowNodeKey(spec));
		assert.equal(first.sessionId, stableAgentSessionId("run-1", stableWorkflowNodeKey(spec)));
		assert.deepEqual(durableTransitions, ["completed:completed"]);

		const stored = await runtime.readAgentSession(first.sessionId ?? "");
		assert.ok(stored);
		assert.equal(stored.status, "completed");
		assert.equal(stored.lifecycle_state, "closing", "logical completion precedes physical simple-body exit");
		assert.equal(stored.sandbox_id, "sandbox-runtime-control");
		const document = JSON.parse(stored.document_json);
		assert.equal(document.schema, "choreograph.agent-session-document.v1");
		assert.equal(document.collab.schema, "choreograph.agent-session-collab.v1");
		assert.equal(document.collab.backend, "oplog");
		assert.equal(document.collab.crdt, "loro");
		assert.equal(document.collab.revision, 3);
		assert.equal(document.runtime.status, "completed");
		assert.equal(document.meaningfulObjects.agentSession.kind, "agent-session");
		assert.equal(document.meaningfulObjects.workflow.kind, "workflow");
		assert.equal(document.meaningfulObjects.workflowNode.kind, "workflow-node");
		assert.equal(document.meaningfulObjects.agent.kind, "agent");
		const documentOps = await runtime.listAgentSessionDocumentOps(first.sessionId ?? "");
		assert.deepEqual(
			documentOps.map((op) => op.kind),
			["session.created", "runtime.bound", "session.outcome.completed"],
		);
		assert.equal(documentOps[2].rev, 3);
		assert.equal(documentOps[2].change_id, document.collab.changeId);
		await runtime.finishAgentMaterialization(first.sessionId!, 0, {
			activationId: first.invocationId!,
			from: "running",
			to: "completed",
			now: 1300,
		});
		assert.equal((await runtime.readAgentSession(first.sessionId!))?.lifecycle_state, "closed");

		const second = await runner(spec);
		assert.equal(calls, 1, "completed node must replay from runtime state, not respawn");
		assert.equal(second.output, "ok");
		assert.equal(second.sessionId, first.sessionId);
		assert.deepEqual(durableTransitions, ["completed:completed"], "replay emits no new durable transition");
		runtime.close();
	});

	it("turns a pause request into a stored before-node frontier", async () => {
		const { runtime, dir } = tmpRuntime();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await runtime.init();
		await runtime.createWorkflowInstance({
			runId: "run-pause",
			workflowName: "wf",
			graphId: "g1",
			ownerUserId: "u1",
			inputs: {},
			startedAt: 1000,
		});
		await runtime.requestPause("run-pause", { reason: "driver handoff", now: 1500 });

		const runner = makeRuntimeNodeRunner({
			runtime,
			memory: new AgentMemory(SophiaContentStore.fromUrl(new URL("memory/", `file://${dir}/`).toString()), runtime),
			runId: "run-pause",
			workflowName: "wf",
			graphId: "g1",
			ownerUserId: "u1",
			graphOwnerPrincipal: "user:u1",
			now: () => 2000,
			baseRunner: async (input) => resultFor(input),
		});

		await assert.rejects(() => runner(spec), isWorkflowPausedError);
		const instance = await runtime.getWorkflowInstance("run-pause");
		assert.equal(instance?.status, "paused");
		const frontier = JSON.parse(instance?.frontier_json ?? "{}");
		assert.equal(frontier.kind, "before-node");
		assert.equal(frontier.nodeKey, stableWorkflowNodeKey(spec));
		assert.equal(frontier.label, spec.label);
		assert.equal((await runtime.listAgentSessionsForRun("run-pause")).length, 0, "paused before scheduling");
		runtime.close();
	});

	it("releases a standalone launch intent when the runner fails before any body bind", async () => {
		const { runtime, dir } = tmpRuntime();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await runtime.init();
		await runtime.createWorkflowInstance({
			runId: "run-unbound-launch",
			workflowName: "wf",
			graphId: "g1",
			ownerUserId: "u1",
			inputs: {},
			startedAt: 1000,
		});
		let calls = 0;
		let clock = 2000;
		let lastInput: AgentNodeSpec | null = null;
		const runner = makeRuntimeNodeRunner({
			runtime,
			memory: new AgentMemory(SophiaContentStore.fromUrl(new URL("memory/", `file://${dir}/`).toString()), runtime),
			runId: "run-unbound-launch",
			workflowName: "wf",
			graphId: "g1",
			ownerUserId: "u1",
			graphOwnerPrincipal: "user:u1",
			now: () => clock++,
			baseRunner: async (input) => {
				calls += 1;
				lastInput = input;
				if (calls === 1) throw new Error("spawn missing-runtime ENOENT");
				await runtime.bindAgentSandbox(input.sessionId!, {
					sandboxId: "sandbox-unbound-retry",
					generation: input.sandboxGeneration ?? 0,
					activationId: input.invocationId!,
					now: clock++,
				});
				return resultFor(input);
			},
		});

		await assert.rejects(() => runner(spec), /spawn missing-runtime ENOENT/);
		const sessionId = stableAgentSessionId("run-unbound-launch", stableWorkflowNodeKey(spec));
		assert.equal(await runtime.readAgentMaterialization(sessionId, 0), null);
		const retryable = await runtime.readAgentSession(sessionId);
		assert.equal(retryable?.status, "queued");
		assert.equal(retryable?.lifecycle_state, "open");
		assert.equal(retryable?.sandbox_id, null);
		assert.equal(
			(await runtime.listAgentSessionEvents(sessionId)).filter((event) => event.type.startsWith("runtime.")).length,
			0,
			"a process that never spawned emits no fabricated runtime event",
		);
		await assert.rejects(
			runtime.bindAgentSandbox(sessionId, {
				sandboxId: "sandbox-stale-after-release",
				generation: 0,
				activationId: lastInput!.invocationId!,
				now: clock++,
			}),
			/error|materialization|activation/i,
			"release-first must fence a late process bind",
		);

		const retried = await runner(spec);
		assert.equal(retried.state, "done");
		assert.equal((await runtime.readAgentMaterialization(sessionId, 0))?.state, "running");
		assert.equal(
			await runtime.releaseUnboundAgentMaterializationLaunch(sessionId, {
				generation: 0,
				activationId: retried.invocationId!,
				reason: "late release after body bind",
				now: clock++,
			}),
			false,
			"bind-first must fence a late launch-intent release",
		);
		assert.equal(calls, 2);
		runtime.close();
	});

	it("retains a scheduler-owned no-body reservation across retryable activation failure", async () => {
		const { runtime, dir } = tmpRuntime();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await runtime.init();
		await runtime.createWorkflowInstance({
			runId: "run-scheduled-activation",
			workflowName: "wf",
			graphId: "g1",
			ownerUserId: "u1",
			inputs: {},
			startedAt: 1000,
		});
		let calls = 0;
		let clock = 2000;
		const runner = makeRuntimeNodeRunner({
			runtime,
			memory: new AgentMemory(SophiaContentStore.fromUrl(new URL("memory/", `file://${dir}/`).toString()), runtime),
			runId: "run-scheduled-activation",
			workflowName: "wf",
			graphId: "g1",
			ownerUserId: "u1",
			graphOwnerPrincipal: "user:u1",
			preserveMaterializationOnActivationFailure: true,
			now: () => clock++,
			baseRunner: async (input) => {
				calls++;
				if (calls === 1) throw new Error("retryable scheduled pre-spawn failure");
				await runtime.bindAgentSandbox(input.sessionId!, {
					sandboxId: "sandbox-scheduled-retry",
					generation: input.sandboxGeneration ?? 0,
					activationId: input.invocationId!,
					now: clock++,
				});
				return resultFor(input);
			},
		});
		const scheduledSpec = {
			...spec,
			awaitInitialCommand: true as const,
			invocationId: "schedule-fire-activation",
		};

		await assert.rejects(() => runner(scheduledSpec), /retryable scheduled pre-spawn failure/);
		const sessionId = stableAgentSessionId("run-scheduled-activation", stableWorkflowNodeKey(scheduledSpec));
		const reserved = await runtime.readAgentMaterialization(sessionId, 0);
		assert.equal(reserved?.state, "claimed");
		assert.equal(reserved?.activation_id, "schedule-fire-activation");
		assert.equal((await runtime.readAgentSession(sessionId))?.status, "queued");
		assert.equal(
			(await runtime.listAgentSessionEvents(sessionId)).filter((event) => event.type.startsWith("runtime.")).length,
			0,
			"a retained wake intent is not fabricated as body testimony",
		);

		const completed = await runner(scheduledSpec);
		assert.equal(completed.state, "done");
		assert.equal((await runtime.readAgentMaterialization(sessionId, 0))?.state, "running");
		assert.equal(calls, 2);
		runtime.close();
	});

	it("arbitrates one run driver and CAS-serializes beat amendments without widening authority", async () => {
		const { runtime, dir } = tmpRuntime();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await runtime.init();
		await runtime.createWorkflowInstance({
			runId: "run-beats",
			workflowName: "wf",
			graphId: "g1",
			ownerUserId: "u1",
			inputs: {},
			startedAt: 1000,
		});

		const first = await runtime.claimWorkflowDriver("run-beats", {
			clientId: "vehicle-a",
			claimTs: 2000,
			now: 2000,
			expectedRevision: 0,
		});
		assert.equal(first?.applied, true);
		assert.equal(first?.control.revision, 1);
		assert.equal(first?.control.driverLease?.epoch, 1);

		const stale = await runtime.claimWorkflowDriver("run-beats", {
			clientId: "vehicle-b",
			claimTs: 1999,
			now: 2001,
			expectedRevision: 1,
		});
		assert.equal(stale?.applied, false);
		assert.equal(stale?.reason, "stale_claim");
		assert.equal(stale?.driver, "vehicle-a");

		const takeover = await runtime.claimWorkflowDriver("run-beats", {
			clientId: "vehicle-b",
			claimTs: 2001,
			now: 2002,
			expectedRevision: 1,
		});
		assert.equal(takeover?.applied, true);
		assert.equal(takeover?.control.revision, 2);
		assert.equal(takeover?.control.driverLease?.epoch, 2);

		const nonDriver = await runtime.queueWorkflowBeatAmendment("run-beats", {
			clientId: "vehicle-a",
			amendmentId: "skip-b",
			kind: "skip",
			targetBeatId: "b",
			expectedRevision: 2,
			leaseEpoch: 2,
			now: 2003,
		});
		assert.equal(nonDriver?.reason, "not_driver");

		const contenders = await Promise.all([
			runtime.queueWorkflowBeatAmendment("run-beats", {
				clientId: "vehicle-b",
				amendmentId: "reorder-c-b",
				kind: "reorder",
				payload: { order: ["c", "b"] },
				expectedRevision: 2,
				leaseEpoch: 2,
				now: 2004,
			}),
			runtime.queueWorkflowBeatAmendment("run-beats", {
				clientId: "vehicle-b",
				amendmentId: "skip-b",
				kind: "skip",
				targetBeatId: "b",
				expectedRevision: 2,
				leaseEpoch: 2,
				now: 2005,
			}),
		]);
		assert.deepEqual(
			contenders.map((result) => result?.reason ?? "applied").sort(),
			["applied", "revision_conflict"],
			"one expected-revision writer wins and the stale concurrent writer loses",
		);
		const afterCas = await runtime.getWorkflowControl("run-beats");
		assert.equal(afterCas?.revision, 3);
		assert.equal(afterCas?.amendments.length, 1);

		await assert.rejects(
			runtime.queueWorkflowBeatAmendment("run-beats", {
				clientId: "vehicle-b",
				amendmentId: "widen-tools",
				kind: "reparameterize",
				payload: { parameters: { nested: { capabilityName: "admin", toolMode: "dynamic" } } },
				expectedRevision: 3,
				leaseEpoch: 2,
				now: 2006,
			}),
			/cannot mutate authority field 'capabilityName'/,
		);
		assert.equal((await runtime.getWorkflowControl("run-beats"))?.revision, 3);
		runtime.close();
	});
});
