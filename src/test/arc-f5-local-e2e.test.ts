import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { AgentSessionFamilyGraphProxy } from "../agent-runtime/agent-session-family-graph-projection.js";
import {
	type AgentSessionFamilyProjectionGraphAuthority,
	AgentSessionFamilyProjectionPump,
} from "../agent-runtime/agent-session-family-projection-pump.js";
import { SophiaContentStore } from "../agent-runtime/content-store.js";
import { AgentMemory } from "../agent-runtime/memory.js";
import { digestAgentRuntimeBinding } from "../agent-runtime/profile.js";
import type { RlmDeleteSubagentResult } from "../agent-runtime/rlm-control-contract.js";
import { createSandboxEventBus } from "../event-bus.js";
import { digestSophiaAgentSourceTree } from "../runtime-bundles.js";
import { SandboxStore } from "../sandbox-store.js";
import { SandboxSpawner } from "../spawner.js";
import { makeNodeRunner } from "../workflow/run-node.js";
import { makeRuntimeNodeRunner } from "../workflow/runtime-control.js";
import {
	type AgentMaterializationRecord,
	type AgentSessionChildControlRecord,
	type AgentSessionChildRunRecord,
	type AgentSessionFamilyProjectionSnapshot,
	WorkflowRuntimeStore,
} from "../workflow/runtime-store.js";
import type { AgentNodeSpec, NodeRunner } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

const ENTRYPOINT = process.env.SOPHIA_AGENT_RUNTIME_ENTRYPOINT?.trim();
const BRIDGE = process.env.SOPHIA_JUPYTER_BRIDGE_PATH?.trim();
const PYTHON = process.env.SOPHIA_PRIME_KERNEL_PYTHON?.trim();
const LOCAL_RUNTIME_SKIP =
	!ENTRYPOINT || !existsSync(ENTRYPOINT) || !BRIDGE || !existsSync(BRIDGE) || !PYTHON || !existsSync(PYTHON)
		? "set the Prime worker, Jupyter bridge, and kernel Python paths"
		: false;

const GRAPH_ID = "arc-f5-local-proof";
const ACTOR_USER_ID = "arc-f5-local-actor";
const GRAPH_OWNER = "organization:arc-f5-local-proof";
const TEST_ONTOLOGY_OWNER = "user:test";
const WORKFLOW_NAME = "domain-agent-activity-loop-v1";
const QUEUED_SECRET = "queued F5 child prompt must never enter the family display";
const FAILURE_SECRET = "Fail inside the bounded F5 simple child without disturbing the parent.";
const ACTIVE_SECRET = "Remain active in a private kernel until the parent cancels this F5 child.";
const WORKER_CRASH_SECRET = "Remain active until the F5 worker crash stimulus.";
const KERNEL_CRASH_SECRET = "Remain active until the F5 kernel crash stimulus.";

describe("Arc F5 local crash, cancellation, and recovery organism", { concurrency: false }, () => {
	it(
		"cancels a queued simple child with zero bodies, replays delete exactly, contains failure, and keeps the parent live",
		{ skip: LOCAL_RUNTIME_SKIP, timeout: 180_000 },
		async () => {
			const tempDir = mkdtempSync(join(tmpdir(), "choreograph-arc-f5-simple-e2e-"));
			const evidence = projectionEvidence();
			const harness = await createHarness(tempDir, evidence, "simple", 1);
			let releaseLaunchGate = () => {};
			try {
				const root = await createRoot(harness, {
					runId: "arc-f5-simple-local-e2e",
					parentSessionId: "ags_arc_f5_simple_parent",
					parentModel: "mock:rlm_f5_simple_parent",
					childKind: "simple",
					childModel: "mock:f5_failure",
					maxChildren: 2,
					maxConcurrentChildren: 1,
				});
				await harness.spawner.start();
				assert.equal((await root.runner(root.parentSpec)).state, "done");
				const parent = await requireLiveMaterialization(harness, root.parentSessionId);
				const parentLease = harness.spawner.getKernelLeaseForSession(root.parentSessionId);
				assert.ok(parentLease);
				assert.equal(harness.spawner.sessionBodyCount(root.parentSessionId), 2);
				const launchGateEntered = deferred();
				const launchGateReleased = deferred();
				releaseLaunchGate = launchGateReleased.resolve;
				const launchBlocker = harness.spawner.enqueue({
					template: "bare",
					preSpawnGate: async () => {
						launchGateEntered.resolve();
						await launchGateReleased.promise;
						throw new Error("Arc F5 launch blocker released without entering an adapter");
					},
				});
				await launchGateEntered.promise;

				const queued = await harness.runtime.admitAgentSessionChild(root.parentSessionId, {
					requestId: "arc-f5-queued-simple",
					parentGeneration: 0,
					parentActivationId: parent.activation_id,
					parentSandboxId: parent.sandbox_id,
					prompt: QUEUED_SECRET,
					requestedName: "queued-simple-child",
					requestedModel: "mock:f5_failure",
					causationId: "arc-f5-queued-simple",
					now: Date.now(),
				});
				if (queued.decision !== "accepted") {
					throw new Error(`queued F5 child was denied: ${JSON.stringify(queued.request)}`);
				}
				await waitFor(async () => {
					const [run, materialization] = await Promise.all([
						harness.runtime.readAgentSessionChildRun(queued.run.child_run_id),
						harness.runtime.readAgentMaterialization(queued.child.session_id, 0),
					]);
					return (
						run?.state === "claimed" &&
						materialization?.state === "claimed" &&
						run.materialized_at === null &&
						harness.spawner.sessionBodyCount(queued.child.session_id) === 0
					);
				}, "queued F5 child did not reach the awaited pre-spawn bind gate");

				await runParentPrompt(
					harness,
					root.parentSessionId,
					parent.sandbox_id,
					"arc-f5:delete-queued",
					"Delete the queued child through the exact hosted RLM control surface.",
				);
				releaseLaunchGate();
				await waitFor(
					() => harness.sandboxStore.get(launchBlocker.sandbox_id)?.state === "killed",
					"pre-spawn launch blocker did not settle",
				);
				const queuedRun = await requireRun(harness.runtime, queued.run.child_run_id, "cancelled");
				assert.equal(queuedRun.materialized_at, null);
				assert.equal(await harness.runtime.readAgentMaterialization(queued.child.session_id, 0), null);
				assert.equal(harness.spawner.sessionBodyCount(queued.child.session_id), 0);
				assert.equal((await harness.runtime.readAgentSession(queued.child.session_id))?.lifecycle_state, "closed");
				assert.equal(
					(await harness.runtime.readAgentSessionChildBudgetAllocation(queued.allocation.allocation_id))?.state,
					"released",
				);
				const queuedCancellations = await harness.runtime.listAgentSessionChildCancellationRequests(
					queued.run.child_run_id,
				);
				assert.equal(queuedCancellations.length, 1);
				assert.equal(queuedCancellations[0]?.disposition, "cancelled_before_materialization");

				const exactReplayInput = {
					requestId: queuedCancellations[0]!.request_id,
					payload: { type: "rlm.delete_subagent", target: queued.run.child_run_id },
					parent: parentContext(root.parentSessionId, parent),
				};
				const dispatcher = childDispatcher(harness.spawner);
				const firstReplay = await dispatcher.handle(exactReplayInput);
				const secondReplay = await dispatcher.handle(exactReplayInput);
				assert.equal(JSON.stringify(secondReplay), JSON.stringify(firstReplay));
				assert.deepEqual(secondReplay, firstReplay);
				assert.deepEqual(firstReplay, {
					closure: {
						child_session_id: queued.child.session_id,
						child_run_id: queued.run.child_run_id,
						name: "queued-simple-child",
						model: "mock:f5_failure",
						prior_run_state: "claimed",
						final_run_state: "cancelled",
						session_state: "closed",
						cancellation: "observed",
					},
				});

				await runParentPrompt(
					harness,
					root.parentSessionId,
					parent.sandbox_id,
					"arc-f5:spawn-failure",
					"Admit the deliberately failing simple child.",
				);
				const failedControl = await waitForChildControl(
					harness.runtime,
					root.parentSessionId,
					"failing-simple-child",
					"failed",
				);
				const failedRun = await requireRun(harness.runtime, failedControl.child_run_id, "failed");
				const failedMaterialization = await harness.runtime.readAgentMaterialization(
					failedControl.child_session_id,
					0,
				);
				assert.ok(failedMaterialization);
				assert.equal(failedMaterialization.state, "faulted");
				assert.ok(failedMaterialization.checkpoint_id);
				assert.equal(harness.spawner.sessionBodyCount(failedControl.child_session_id), 0);
				assert.equal(
					(await harness.runtime.readAgentSession(failedControl.child_session_id))?.lifecycle_state,
					"closed",
				);
				assert.match(
					failedRun.error ?? "",
					/Deliberate Arc F5 child inference failure|Prime stopped without calling done|child execution failed/i,
				);

				await runParentPrompt(
					harness,
					root.parentSessionId,
					parent.sandbox_id,
					"arc-f5:continue-after-failure",
					"Use a fresh delete request after the child fault, then continue in this parent kernel.",
				);
				assert.equal(harness.spawner.sessionBodyCount(root.parentSessionId), 2);
				assert.equal(harness.spawner.getKernelLeaseForSession(root.parentSessionId)?.leaseId, parentLease.leaseId);
				assert.equal((await harness.runtime.readAgentMaterialization(root.parentSessionId, 0))?.state, "running");
				assert.notEqual((await harness.runtime.readAgentSession(root.parentSessionId))?.status, "failed");

				const parentCells = await harness.runtime.listExecutionJournal(root.parentSessionId);
				const parentOutputs = JSON.stringify(parentCells.map((cell) => cell.outputs));
				assert.match(parentOutputs, /F5 queued delete observed/);
				assert.match(parentOutputs, /F5 failing child admitted/);
				assert.match(parentOutputs, /F5 parent continued after simple fault 1/);
				const family = await requireFamily(harness.runtime, root.parentSessionId, 2);
				const queuedDisplay = family.children.find((child) => child.childName === "queued-simple-child");
				const failedDisplay = family.children.find((child) => child.childName === "failing-simple-child");
				assert.equal(queuedDisplay?.childRunState, "cancelled");
				assert.equal(queuedDisplay?.admission?.allocationState, "released");
				assert.equal(queuedDisplay?.admission?.settledActualCostUsdMicros, null);
				assert.equal(queuedDisplay?.materializationState, null);
				assert.equal(queuedDisplay?.workerState, null);
				assert.equal(queuedDisplay?.kernelState, null);
				assert.equal(queuedDisplay?.child.sessionState, "closed");
				assert.equal(failedDisplay?.childRunState, "failed");
				assert.equal(failedDisplay?.admission?.allocationState, "settled");
				assert.equal(failedDisplay?.admission?.settledActualCostUsdMicros, 0);
				assert.equal(failedDisplay?.materializationState, "faulted");
				assert.equal(failedDisplay?.workerState, "faulted");
				assert.equal(failedDisplay?.kernelState, null);
				assert.equal(failedDisplay?.child.sessionState, "closed");
				await assertDurableDisplayBoundary(harness, evidence, root.parentSessionId, [
					QUEUED_SECRET,
					FAILURE_SECRET,
					"Prime stopped without calling done().",
					"Deliberate Arc F5 child inference failure.",
					"mock:f5_failure",
					queued.run.child_run_id,
					failedRun.child_run_id,
					failedMaterialization.sandbox_id,
					failedMaterialization.checkpoint_id,
					parent.sandbox_id,
				]);
				await assertParentEventCounts(harness.runtime, root.parentSessionId, {
					"child.run.cancelled": 1,
					"child.run.failed": 1,
				});
			} finally {
				releaseLaunchGate();
				await closeHarness(harness);
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	);

	it(
		"cancels an active Prime worker+kernel pair, reaps both exactly, and leaves its parent pair untouched",
		{ skip: LOCAL_RUNTIME_SKIP, timeout: 180_000 },
		async () => {
			const tempDir = mkdtempSync(join(tmpdir(), "choreograph-arc-f5-active-e2e-"));
			const evidence = projectionEvidence();
			const harness = await createHarness(tempDir, evidence, "active");
			try {
				const root = await createRoot(harness, {
					runId: "arc-f5-active-local-e2e",
					parentSessionId: "ags_arc_f5_active_parent",
					parentModel: "mock:rlm_f5_active_parent",
					childKind: "prime",
					childModel: "mock:f5_blocked_ipython",
					maxChildren: 1,
					maxConcurrentChildren: 1,
				});
				await harness.spawner.start();
				assert.equal((await root.runner(root.parentSpec)).state, "done");
				const parent = await requireLiveMaterialization(harness, root.parentSessionId);
				const parentLease = harness.spawner.getKernelLeaseForSession(root.parentSessionId);
				assert.ok(parentLease);

				await runParentPrompt(
					harness,
					root.parentSessionId,
					parent.sandbox_id,
					"arc-f5:spawn-active",
					"Admit a Prime child and let its private kernel enter the bounded wait.",
				);
				const active = await waitForActivePrimeChild(harness, root.parentSessionId, "active-prime-child");
				assert.notEqual(active.materialization.sandbox_id, parent.sandbox_id);
				assert.notEqual(active.kernelSandboxId, parentLease.kernelSandboxId);
				assert.equal((await harness.runtime.listExecutionJournal(active.control.child_session_id)).length, 0);

				await runParentPrompt(
					harness,
					root.parentSessionId,
					parent.sandbox_id,
					"arc-f5:delete-active",
					"Cancel the active Prime child through the exact hosted RLM control surface.",
				);
				const closed = await waitForChildControl(
					harness.runtime,
					root.parentSessionId,
					"active-prime-child",
					"cancelled",
				);
				assert.equal(closed.session_state, "closed");
				const cancelledMaterialization = await harness.runtime.readAgentMaterialization(closed.child_session_id, 0);
				assert.equal(cancelledMaterialization?.state, "cancelled");
				assert.equal(harness.spawner.sessionBodyCount(closed.child_session_id), 0);
				assert.equal(harness.spawner.getActive().has(active.materialization.sandbox_id), false);
				assert.equal(harness.spawner.getActive().has(active.kernelSandboxId), false);

				const cancellations = await harness.runtime.listAgentSessionChildCancellationRequests(closed.child_run_id);
				assert.equal(cancellations.length, 2);
				const parentCancellation = cancellations.find((request) => request.actor.kind === "parent_materialization");
				const cascadeCancellation = cancellations.find((request) => request.actor.kind === "session_cascade");
				assert.ok(parentCancellation);
				assert.ok(cascadeCancellation);
				assert.equal(parentCancellation.disposition, "cancellation_pending");
				assert.equal(cascadeCancellation.disposition, "cancellation_pending");
				const exactReplayInput = {
					requestId: parentCancellation.request_id,
					payload: { type: "rlm.delete_subagent", target: closed.child_run_id },
					parent: parentContext(root.parentSessionId, parent),
				};
				const firstReplay = await childDispatcher(harness.spawner).handle(exactReplayInput);
				const secondReplay = await childDispatcher(harness.spawner).handle(exactReplayInput);
				assert.equal(JSON.stringify(secondReplay), JSON.stringify(firstReplay));
				assert.deepEqual(secondReplay, firstReplay);
				assert.equal(firstReplay.closure.final_run_state, "cancelled");
				assert.equal(firstReplay.closure.cancellation, "observed");

				await runParentPrompt(
					harness,
					root.parentSessionId,
					parent.sandbox_id,
					"arc-f5:continue-after-active-cancel",
					"Issue a fresh terminal delete and continue in the original parent kernel.",
				);
				assert.equal(harness.spawner.sessionBodyCount(root.parentSessionId), 2);
				assert.equal(harness.spawner.getKernelLeaseForSession(root.parentSessionId)?.leaseId, parentLease.leaseId);
				assert.equal((await harness.runtime.readAgentMaterialization(root.parentSessionId, 0))?.state, "running");
				assert.notEqual((await harness.runtime.readAgentSession(root.parentSessionId))?.status, "failed");

				const family = await requireFamily(harness.runtime, root.parentSessionId, 1);
				const displayed = family.children[0]!;
				assert.equal(displayed.childRunState, "cancelled");
				assert.equal(displayed.materializationState, "cancelled");
				assert.equal(displayed.workerState, "cancelled");
				assert.equal(displayed.kernelState, "cancelled");
				assert.equal(displayed.admission?.allocationState, "settled");
				assert.equal(displayed.admission?.settledActualCostUsdMicros, 0);
				const outputs = JSON.stringify(
					(await harness.runtime.listExecutionJournal(root.parentSessionId)).map((cell) => cell.outputs),
				);
				assert.match(outputs, /F5 active delete observed/);
				assert.match(outputs, /F5 parent continued after active cancellation 1/);
				await assertDurableDisplayBoundary(harness, evidence, root.parentSessionId, [
					ACTIVE_SECRET,
					"mock:f5_blocked_ipython",
					closed.child_run_id,
					parent.sandbox_id,
					active.materialization.sandbox_id,
					active.kernelSandboxId,
				]);
				await assertParentEventCounts(harness.runtime, root.parentSessionId, { "child.run.cancelled": 1 });
			} finally {
				await closeHarness(harness);
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	);

	it(
		"recovers unexpected worker and kernel crashes after a real host restart without faulting the parent Session",
		{ skip: LOCAL_RUNTIME_SKIP, timeout: 240_000 },
		async () => {
			const tempDir = mkdtempSync(join(tmpdir(), "choreograph-arc-f5-crash-e2e-"));
			const evidence = projectionEvidence();
			let harness: LocalHarness | null = await createHarness(tempDir, evidence, "crash-before");
			try {
				const root = await createRoot(harness, {
					runId: "arc-f5-crash-local-e2e",
					parentSessionId: "ags_arc_f5_crash_parent",
					parentModel: "mock:rlm_f5_crash_parent",
					childKind: "prime",
					childModel: "mock:f5_blocked_ipython",
					maxChildren: 2,
					maxConcurrentChildren: 2,
				});
				await harness.spawner.start();
				assert.equal((await root.runner(root.parentSpec)).state, "done");
				const parent = await requireLiveMaterialization(harness, root.parentSessionId);
				await runParentPrompt(
					harness,
					root.parentSessionId,
					parent.sandbox_id,
					"arc-f5:spawn-crash-pair",
					"Admit the two crash-matrix children.",
				);
				const workerCrash = await waitForActivePrimeChild(harness, root.parentSessionId, "worker-crash-child");
				const kernelCrash = await waitForActivePrimeChild(harness, root.parentSessionId, "kernel-crash-child");
				await childDispatcher(harness.spawner).stop();

				const workerCrashWorker = unexpectedProcess(harness.spawner, workerCrash.materialization.sandbox_id);
				const workerCrashKernel = unexpectedProcess(harness.spawner, workerCrash.kernelSandboxId);
				const workerCrashPids = [requirePid(workerCrashWorker), requirePid(workerCrashKernel)];
				workerCrashWorker.kill("SIGKILL");
				await waitForCrashedPairPhysicalReap(harness, workerCrash, "worker crash");
				await waitFor(
					() => harness!.spawner.getKernelLeaseForSession(workerCrash.control.child_session_id) === undefined,
					"unexpected worker crash did not detach its kernel lease after both sandboxes exited",
				);
				assert.equal(harness.spawner.sessionBodyCount(workerCrash.control.child_session_id), 0);
				assert.equal(
					(await harness.runtime.readAgentMaterialization(workerCrash.control.child_session_id, 0))?.state,
					"faulted",
				);
				assert.equal(
					(await harness.runtime.readAgentSessionChildGenerationOccupancy(workerCrash.control.child_session_id, 0))
						?.state,
					"released",
				);
				for (const pid of workerCrashPids)
					assert.equal(isProcessAlive(pid), false, `worker-crash PID ${pid} survived`);

				const kernelCrashWorker = unexpectedProcess(harness.spawner, kernelCrash.materialization.sandbox_id);
				const kernelCrashKernel = unexpectedProcess(harness.spawner, kernelCrash.kernelSandboxId);
				const kernelCrashPids = [requirePid(kernelCrashWorker), requirePid(kernelCrashKernel)];
				kernelCrashKernel.kill("SIGKILL");
				await waitForCrashedPairPhysicalReap(harness, kernelCrash, "kernel crash");
				await waitFor(
					() => harness!.spawner.getKernelLeaseForSession(kernelCrash.control.child_session_id) === undefined,
					"unexpected kernel crash did not detach its kernel lease after both sandboxes exited",
				);
				assert.equal(harness.spawner.sessionBodyCount(kernelCrash.control.child_session_id), 0);
				assert.equal(
					(await harness.runtime.readAgentMaterialization(kernelCrash.control.child_session_id, 0))?.state,
					"faulted",
				);
				assert.equal(
					(await harness.runtime.readAgentSessionChildGenerationOccupancy(kernelCrash.control.child_session_id, 0))
						?.state,
					"released",
				);
				for (const pid of kernelCrashPids)
					assert.equal(isProcessAlive(pid), false, `kernel-crash PID ${pid} survived`);
				const crashedRuns = await Promise.all([
					requireRun(harness.runtime, workerCrash.control.child_run_id, "claimed"),
					requireRun(harness.runtime, kernelCrash.control.child_run_id, "claimed"),
				]);
				const leasedFamily = await requireFamily(harness.runtime, root.parentSessionId, 2);
				for (const child of leasedFamily.children) {
					assert.equal(child.childRunState, "claimed");
					assert.equal(child.materializationState, "faulted");
					assert.equal(child.workerState, "faulted");
					assert.equal(child.kernelState, "faulted");
					assert.equal(child.child.sessionState, "closing");
					assert.equal(child.admission?.allocationState, "reserved");
				}
				assert.equal((await harness.runtime.readAgentMaterialization(root.parentSessionId, 0))?.state, "running");
				assert.notEqual((await harness.runtime.readAgentSession(root.parentSessionId))?.status, "failed");
				const reclaimAfter = Math.max(...crashedRuns.map((run) => run.claim_expires_at ?? 0));

				await closeHarness(harness);
				harness = null;
				await delay(Math.max(0, reclaimAfter - Date.now() + 250));

				harness = await createHarness(tempDir, evidence, "crash-after");
				const reopenedBeforeStart = await requireFamily(harness.runtime, root.parentSessionId, 2);
				for (const child of reopenedBeforeStart.children) {
					assert.equal(child.childRunState, "claimed");
					assert.equal(child.materializationState, "faulted");
					assert.equal(child.workerState, "faulted");
					assert.equal(child.kernelState, "faulted");
					assert.equal(child.child.sessionState, "closing");
					assert.equal(child.admission?.allocationState, "reserved");
				}
				try {
					await harness.spawner.start();
				} catch (error) {
					const failedAfterStart = await harness.runtime.readAgentSessionFamilyProjection(root.parentSessionId);
					console.error(
						`ARC_F5_RECOVERY_DIAGNOSTIC:${JSON.stringify({
							error: String(error),
							stimuli: [
								{
									kind: "worker-crash",
									sessionId: workerCrash.control.child_session_id,
									generation: 0,
									workerSandboxId: workerCrash.materialization.sandbox_id,
									kernelSandboxId: workerCrash.kernelSandboxId,
								},
								{
									kind: "kernel-crash",
									sessionId: kernelCrash.control.child_session_id,
									generation: 0,
									workerSandboxId: kernelCrash.materialization.sandbox_id,
									kernelSandboxId: kernelCrash.kernelSandboxId,
								},
							],
							beforeStart: boundedFamilyBodySnapshot(reopenedBeforeStart),
							afterStart: failedAfterStart ? boundedFamilyBodySnapshot(failedAfterStart) : null,
						})}`,
					);
					throw error;
				}
				try {
					await Promise.all([
						waitForChildControl(harness.runtime, root.parentSessionId, "worker-crash-child", "failed"),
						waitForChildControl(harness.runtime, root.parentSessionId, "kernel-crash-child", "failed"),
					]);
				} catch (error) {
					console.error(
						`ARC_F5_RECOVERY_SETTLEMENT_DIAGNOSTIC:${JSON.stringify({
							error: String(error),
							beforeStart: boundedFamilyBodySnapshot(reopenedBeforeStart),
							afterStart: await boundedRecoverySettlementSnapshot(harness.runtime, root.parentSessionId, [
								{
									kind: "worker-crash",
									sessionId: workerCrash.control.child_session_id,
									childRunId: workerCrash.control.child_run_id,
									generation: 0,
									workerSandboxId: workerCrash.materialization.sandbox_id,
									kernelSandboxId: workerCrash.kernelSandboxId,
								},
								{
									kind: "kernel-crash",
									sessionId: kernelCrash.control.child_session_id,
									childRunId: kernelCrash.control.child_run_id,
									generation: 0,
									workerSandboxId: kernelCrash.materialization.sandbox_id,
									kernelSandboxId: kernelCrash.kernelSandboxId,
								},
							]),
						})}`,
					);
					throw error;
				}

				const restartedRunner = makeRootRunner(harness, root.runId);
				const parentRegrowSandboxBaseline = new Set(harness.sandboxStore.list().map((record) => record.sandbox_id));
				const resumed = await restartedRunner({
					...root.parentSpec,
					sandboxGeneration: 1,
					prompt: "Regrow the parent after both child crash recoveries and remain live.",
				});
				try {
					assert.equal(resumed.state, "done");
					assert.equal(harness.spawner.sessionBodyCount(root.parentSessionId), 2);
					assert.equal(harness.spawner.getKernelLeaseForSession(root.parentSessionId)?.generation, 1);
					assert.equal(
						(await harness.runtime.readAgentMaterialization(root.parentSessionId, 1))?.state,
						"running",
					);
					assert.notEqual((await harness.runtime.readAgentSession(root.parentSessionId))?.status, "failed");
				} catch (error) {
					console.error(
						`ARC_F5_PARENT_REGROW_DIAGNOSTIC:${JSON.stringify({
							error: String(error),
							resumedState: resumed.state,
							parent: await boundedParentRegrowSnapshot(
								harness,
								root.parentSessionId,
								1,
								parentRegrowSandboxBaseline,
							),
						})}`,
					);
					throw error;
				}

				const family = await requireFamily(harness.runtime, root.parentSessionId, 2);
				for (const child of family.children) {
					assert.equal(child.childRunState, "failed");
					assert.equal(child.materializationState, "faulted");
					assert.equal(child.workerState, "faulted");
					assert.equal(child.kernelState, "faulted");
					assert.equal(child.child.sessionState, "closed");
					assert.equal(child.admission?.allocationState, "settled");
					assert.equal(child.admission?.settledActualCostUsdMicros, 0);
				}
				assert.equal(
					(await harness.runtime.listAgentSessionChildCancellationRequests(workerCrash.control.child_run_id))
						.length,
					0,
				);
				assert.equal(
					(await harness.runtime.listAgentSessionChildCancellationRequests(kernelCrash.control.child_run_id))
						.length,
					0,
				);
				await assertDurableDisplayBoundary(harness, evidence, root.parentSessionId, [
					WORKER_CRASH_SECRET,
					KERNEL_CRASH_SECRET,
					"mock:f5_blocked_ipython",
					workerCrash.control.child_run_id,
					kernelCrash.control.child_run_id,
					workerCrash.materialization.sandbox_id,
					workerCrash.kernelSandboxId,
					kernelCrash.materialization.sandbox_id,
					kernelCrash.kernelSandboxId,
				]);
				await assertParentEventCounts(harness.runtime, root.parentSessionId, { "child.run.failed": 2 });
			} finally {
				if (harness) await closeHarness(harness);
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	);
});

interface ProjectionEvidence {
	readonly authorities: AgentSessionFamilyProjectionGraphAuthority[];
	readonly updates: { readonly graphId: string; readonly update: string }[];
}

interface LocalHarness {
	readonly runtime: WorkflowRuntimeStore;
	readonly sandboxStore: SandboxStore;
	readonly memory: AgentMemory;
	readonly spawner: SandboxSpawner;
	readonly projectionPump: AgentSessionFamilyProjectionPump;
}

interface RootOrganism {
	readonly runId: string;
	readonly parentSessionId: string;
	readonly parentSpec: AgentNodeSpec;
	readonly runner: NodeRunner;
}

function projectionEvidence(): ProjectionEvidence {
	return { authorities: [], updates: [] };
}

async function createHarness(
	tempDir: string,
	evidence: ProjectionEvidence,
	label: string,
	maxConcurrentSpawns = 8,
): Promise<LocalHarness> {
	const sandboxStore = new SandboxStore(join(tempDir, "sandboxes.sqlite"));
	const runtime = new WorkflowRuntimeStore(join(tempDir, "runtime.sqlite"));
	await runtime.init();
	const memory = new AgentMemory(
		SophiaContentStore.fromUrl(pathToFileURL(`${join(tempDir, "memory")}/`).toString()),
		runtime,
	);
	const eventBus = createSandboxEventBus(sandboxStore, { cleanupDelayMs: 0 });
	const projectionPump = new AgentSessionFamilyProjectionPump({
		store: runtime,
		consumer: `arc-f5-${label}`,
		leaseMs: 2_000,
		idlePollMs: 10,
		logger: { error() {}, warn() {} },
		proxyFactory: async (authority) => {
			evidence.authorities.push(authority);
			const proxy: AgentSessionFamilyGraphProxy = {
				async callTool(name, args) {
					assert.equal(name, "sparql_update");
					assert.equal(args.graphId, GRAPH_ID);
					assert.equal(typeof args.update, "string");
					evidence.updates.push({ graphId: String(args.graphId), update: String(args.update) });
					return { ok: true };
				},
			};
			return { proxy, async close() {} };
		},
	});
	const spawner = new SandboxSpawner(
		sandboxStore,
		{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
		{
			sandboxMode: "local-native",
			defaultTimeoutMs: 90_000,
			maxConcurrentSpawns,
			eventBus,
			agentMemory: memory,
			workflowRuntime: runtime,
			familyProjectionPump: projectionPump,
		},
	);
	return { runtime, sandboxStore, memory, spawner, projectionPump };
}

async function createRoot(
	harness: LocalHarness,
	input: {
		readonly runId: string;
		readonly parentSessionId: string;
		readonly parentModel: string;
		readonly childKind: "simple" | "prime";
		readonly childModel: string;
		readonly maxChildren: number;
		readonly maxConcurrentChildren: number;
	},
): Promise<RootOrganism> {
	const bundleDigest = digestSophiaAgentSourceTree(ENTRYPOINT!);
	const registeredName = `${input.runId}-agent`;
	const pilotBase = makeTestAgentSemanticBinding({
		kind: "prime",
		graphId: GRAPH_ID,
		registeredName,
		bundleDigest,
	});
	const pilotRuntime = {
		...pilotBase.runtime,
		constraints: {
			...pilotBase.runtime.constraints,
			maxChildren: input.maxChildren,
			maxConcurrentChildren: input.maxConcurrentChildren,
			maxCostUsdMicros: 4_000_000,
		},
	};
	const pilot = {
		...pilotBase,
		runtime: pilotRuntime,
		runtimeBindingDigest: digestAgentRuntimeBinding(pilotRuntime),
	};
	const childBase = makeTestAgentSemanticBinding({
		kind: input.childKind,
		graphId: GRAPH_ID,
		registeredName,
		bundleDigest,
	});
	const childRuntime = {
		...childBase.runtime,
		constraints: {
			...childBase.runtime.constraints,
			maxTurns: 6,
			maxWallTimeMs: 300_000,
			maxTokens: 20_000,
			maxCostUsdMicros: 500_000,
			maxChildren: 0,
			maxChildDepth: 0,
			maxConcurrentChildren: 0,
			maxArtifactBytes: 134_217_728,
		},
	};
	const child = {
		...childBase,
		runtime: childRuntime,
		runtimeBindingDigest: digestAgentRuntimeBinding(childRuntime),
	};
	await harness.runtime.createWorkflowInstance({
		runId: input.runId,
		workflowName: WORKFLOW_NAME,
		graphId: GRAPH_ID,
		ownerUserId: ACTOR_USER_ID,
		inputs: {
			hostContext: {
				schema: "sophia.domain-agent-host-context.v1",
				runtimes: { pilot: pilot.runtime, emanation: child.runtime },
				ontologies: { pilot: pilot.ontology, emanation: child.ontology },
				emanation: {
					enabled: true,
					provider: "openrouter",
					model: input.childModel,
					maxEmanations: input.maxChildren,
					maxTurns: child.runtime.constraints.maxTurns,
				},
				emanationToolInclude: [],
				systemPrompt: "You are a bounded Arc F5 child.",
				toolbelt: { tools: [] },
			},
		},
		startedAt: Date.now(),
	});
	const runner = makeRootRunner(harness, input.runId);
	const parentSpec: AgentNodeSpec = {
		label: `${input.runId}-parent`,
		phaseIndex: 1,
		nodeKey: `${input.runId}-parent`,
		sessionId: input.parentSessionId,
		depth: 0,
		sandboxGeneration: 0,
		prompt: "Initialize the Arc F5 parent and remain resident.",
		model: input.parentModel,
		provider: "openrouter",
		graphId: GRAPH_ID,
		toolMode: "none",
		...pilot,
	};
	return { runId: input.runId, parentSessionId: input.parentSessionId, parentSpec, runner };
}

function makeRootRunner(harness: LocalHarness, runId: string): NodeRunner {
	const eventBus = harness.spawner.bus!;
	const baseRunner = makeNodeRunner({
		spawner: harness.spawner,
		eventBus,
		authContext: {
			method: "internal_service",
			userId: ACTOR_USER_ID,
			internalServiceSecret: "local-proof-only",
		},
		ownerUserId: ACTOR_USER_ID,
		mnemosyne: {
			mcpUrl: "disabled",
			ownerPrincipal: GRAPH_OWNER,
			graphId: GRAPH_ID,
			capabilities: { reads: true, writes: false, dangerous_ops: false },
		},
		resolveCapabilityGrantPolicy: () => ({ exactTools: { mnemosyne: [] } }),
		onProcessSpawn: ({ spec, sandboxId }) =>
			harness.runtime.bindAgentSandbox(spec.sessionId!, {
				sandboxId,
				generation: spec.sandboxGeneration ?? 0,
				activationId: spec.invocationId!,
				now: Date.now(),
			}),
		onEvent: async ({ spec, event }) => {
			if ("category" in event && event.category === "execution" && event.type === "compute.cell") {
				await harness.runtime.appendExecutionCell(spec.sessionId!, spec.invocationId!, event.cell);
			}
		},
	});
	return makeRuntimeNodeRunner({
		runtime: harness.runtime,
		baseRunner,
		memory: harness.memory,
		runId,
		workflowName: WORKFLOW_NAME,
		graphId: GRAPH_ID,
		ownerUserId: ACTOR_USER_ID,
		graphOwnerPrincipal: GRAPH_OWNER,
	});
}

async function runParentPrompt(
	harness: LocalHarness,
	sessionId: string,
	sandboxId: string,
	commandId: string,
	text: string,
): Promise<void> {
	await harness.runtime.submitAgentSessionCommand(sessionId, {
		commandId,
		idempotencyKey: commandId,
		name: "prompt",
		payload: { text },
		clientId: "arc-f5-local-proof",
		targetGeneration: 0,
		now: Date.now(),
	});
	await harness.spawner.drainAgentSessionCommands(sandboxId);
	let command = await harness.runtime.readAgentSessionCommand(commandId);
	await waitFor(async () => {
		command = await harness.runtime.readAgentSessionCommand(commandId);
		return command !== null && ["completed", "failed", "cancelled"].includes(command.state);
	}, `command ${commandId} did not settle`);
	assert.equal(command?.state, "completed", command?.error ?? `command ${commandId} did not complete`);
}

async function requireLiveMaterialization(
	harness: LocalHarness,
	sessionId: string,
): Promise<AgentMaterializationRecord> {
	const materialization = await harness.runtime.readAgentMaterialization(sessionId, 0);
	assert.equal(materialization?.state, "running");
	assert.ok(materialization);
	return materialization;
}

async function requireRun(
	runtime: WorkflowRuntimeStore,
	childRunId: string,
	state: AgentSessionChildRunRecord["state"],
): Promise<AgentSessionChildRunRecord> {
	const run = await runtime.readAgentSessionChildRun(childRunId);
	assert.equal(run?.state, state);
	assert.ok(run);
	return run;
}

async function waitForChildControl(
	runtime: WorkflowRuntimeStore,
	parentSessionId: string,
	name: string,
	runState: AgentSessionChildRunRecord["state"],
): Promise<AgentSessionChildControlRecord> {
	let found: AgentSessionChildControlRecord | undefined;
	await waitFor(async () => {
		found = (await runtime.listAgentSessionChildControls(parentSessionId, { includeClosed: true })).find(
			(control) => control.child_name === name,
		);
		return found?.run_state === runState && found.session_state === "closed";
	}, `${name} did not reach ${runState}/closed`);
	return found!;
}

async function waitForActivePrimeChild(
	harness: LocalHarness,
	parentSessionId: string,
	name: string,
): Promise<{
	control: AgentSessionChildControlRecord;
	materialization: AgentMaterializationRecord;
	kernelSandboxId: string;
}> {
	let result:
		| {
				control: AgentSessionChildControlRecord;
				materialization: AgentMaterializationRecord;
				kernelSandboxId: string;
		  }
		| undefined;
	await waitFor(async () => {
		const control = (
			await harness.runtime.listAgentSessionChildControls(parentSessionId, { includeClosed: true })
		).find((candidate) => candidate.child_name === name);
		if (!control || control.run_state !== "claimed") return false;
		const materialization = await harness.runtime.readAgentMaterialization(control.child_session_id, 0);
		const lease = harness.spawner.getKernelLeaseForSession(control.child_session_id);
		if (!materialization || materialization.state !== "running" || !lease) return false;
		if (harness.spawner.sessionBodyCount(control.child_session_id) !== 2) return false;
		result = { control, materialization, kernelSandboxId: lease.kernelSandboxId };
		return true;
	}, `${name} did not materialize its exact worker+kernel pair`);
	return result!;
}

async function waitForCrashedPairPhysicalReap(
	harness: LocalHarness,
	child: Awaited<ReturnType<typeof waitForActivePrimeChild>>,
	label: string,
): Promise<void> {
	const sandboxIds = [child.materialization.sandbox_id, child.kernelSandboxId];
	try {
		await waitFor(
			() => sandboxIds.every((sandboxId) => !harness.spawner.getActive().has(sandboxId)),
			`${label} retained a worker or kernel sandbox in the active registry`,
		);
	} catch (error) {
		const active = await Promise.all(
			sandboxIds.map(async (sandboxId) => {
				const retained = harness.spawner.getActive().get(sandboxId) as
					| {
							record: { readonly state: string };
							process: ChildProcess;
							exitDone?: Promise<void>;
							exitCleanupError?: unknown;
							bodyBound?: boolean;
							durableSupervisorExit?: boolean;
							hostWorkAdmissionClosed?: boolean;
							isAgentRun?: boolean;
							agentRequest?: {
								readonly session_id: string;
								readonly generation: number;
								readonly invocation_id: string;
								readonly runtime_binding: { readonly kind: string };
							};
					  }
					| undefined;
				return {
					sandboxId,
					active: retained !== undefined,
					activeRecordState: retained?.record.state ?? null,
					sandboxStoreState: harness.sandboxStore.get(sandboxId)?.state ?? null,
					bodyBound: retained?.bodyBound ?? null,
					durableSupervisorExit: retained?.durableSupervisorExit ?? null,
					hostWorkAdmissionClosed: retained?.hostWorkAdmissionClosed ?? null,
					isAgentRun: retained?.isAgentRun ?? null,
					agentRequest: retained?.agentRequest
						? {
								sessionId: retained.agentRequest.session_id,
								generation: retained.agentRequest.generation,
								invocationId: retained.agentRequest.invocation_id,
								runtimeKind: retained.agentRequest.runtime_binding.kind,
							}
						: null,
					exitCleanupError: retained?.exitCleanupError ? String(retained.exitCleanupError) : null,
					exitDone: await promiseState(retained?.exitDone),
					pid: retained?.process.pid ?? null,
					pidAlive: retained?.process.pid ? isProcessAlive(retained.process.pid) : false,
					exitCode: retained?.process.exitCode ?? null,
					signalCode: retained?.process.signalCode ?? null,
				};
			}),
		);
		const [run, materialization, occupancy, session] = await Promise.all([
			harness.runtime.readAgentSessionChildRun(child.control.child_run_id),
			harness.runtime.readAgentMaterialization(child.control.child_session_id, 0),
			harness.runtime.readAgentSessionChildGenerationOccupancy(child.control.child_session_id, 0),
			harness.runtime.readAgentSession(child.control.child_session_id),
		]);
		const kernelLease = harness.spawner.getKernelLeaseForSession(child.control.child_session_id);
		console.error(
			`ARC_F5_CRASH_DIAGNOSTIC:${JSON.stringify({
				label,
				active,
				kernelLease: kernelLease
					? {
							sandboxId: kernelLease.kernelSandboxId,
							generation: kernelLease.generation,
							activationId: kernelLease.activationId,
						}
					: null,
				sessionBodyCount: harness.spawner.sessionBodyCount(child.control.child_session_id),
				run: run ? { state: run.state, claimExpiresAt: run.claim_expires_at } : null,
				materialization: materialization
					? {
							state: materialization.state,
							faultKind: materialization.fault_kind,
							sandboxId: materialization.sandbox_id,
							activationId: materialization.activation_id,
						}
					: null,
				occupancy: occupancy?.state ?? null,
				session: session ? { status: session.status, lifecycleState: session.lifecycle_state } : null,
			})}`,
		);
		await delay(100);
		throw error;
	}
}

async function promiseState(promise: Promise<void> | undefined): Promise<"missing" | "pending" | "fulfilled" | string> {
	if (!promise) return "missing";
	return Promise.race([
		promise.then(
			() => "fulfilled" as const,
			(error) => `rejected:${String(error)}`,
		),
		delay(0).then(() => "pending" as const),
	]);
}

async function requireFamily(
	runtime: WorkflowRuntimeStore,
	parentSessionId: string,
	children: number,
): Promise<AgentSessionFamilyProjectionSnapshot> {
	const family = await runtime.readAgentSessionFamilyProjection(parentSessionId);
	assert.ok(family);
	assert.equal(family.children.length, children);
	return family;
}

function boundedFamilyBodySnapshot(family: AgentSessionFamilyProjectionSnapshot): unknown {
	return {
		root: {
			sessionId: family.root.sessionId,
			generation: family.root.materializationGeneration,
			sessionState: family.root.sessionState,
			materializationState: family.root.materializationState,
			workerState: family.root.workerState,
			kernelState: family.root.kernelState,
		},
		children: family.children.map((child) => ({
			childName: child.childName,
			sessionId: child.child.sessionId,
			generation: child.materializationGeneration,
			runState: child.childRunState,
			sessionState: child.child.sessionState,
			materializationState: child.materializationState,
			workerState: child.workerState,
			kernelState: child.kernelState,
		})),
	};
}

interface CrashRecoveryStimulus {
	readonly kind: "worker-crash" | "kernel-crash";
	readonly sessionId: string;
	readonly childRunId: string;
	readonly generation: number;
	readonly workerSandboxId: string;
	readonly kernelSandboxId: string;
}

async function boundedRecoverySettlementSnapshot(
	runtime: WorkflowRuntimeStore,
	parentSessionId: string,
	stimuli: readonly CrashRecoveryStimulus[],
): Promise<unknown> {
	const now = Date.now();
	const [family, rootSession, rootMaterialization, rootBodies, requiringRecovery] = await Promise.all([
		runtime.readAgentSessionFamilyProjection(parentSessionId),
		runtime.readAgentSession(parentSessionId),
		runtime.readAgentMaterialization(parentSessionId, 0),
		runtimeDiagnosticRows(
			runtime,
			`SELECT role, state, updated_at AS updatedAt
			   FROM agent_session_body_states
			  WHERE session_id = ? AND generation = 0
			  ORDER BY role`,
			[parentSessionId],
		),
		runtime.listAgentSessionChildRunsRequiringRecovery({ now, limit: 100 }),
	]);
	const recoveryByRun = new Map(
		requiringRecovery.map((work) => [
			work.run.child_run_id,
			{
				reason: work.reason,
				runState: work.run.state,
				allocationState: work.allocation.state,
				materializationState: work.materialization?.state ?? null,
			},
		]),
	);
	return {
		capturedAt: now,
		family: family ? boundedFamilyBodySnapshot(family) : null,
		root: {
			sessionId: parentSessionId,
			sessionStatus: rootSession?.status ?? null,
			lifecycleState: rootSession?.lifecycle_state ?? null,
			generation: rootMaterialization?.generation ?? null,
			materializationState: rootMaterialization?.state ?? null,
			bodies: rootBodies,
		},
		children: await Promise.all(
			stimuli.map(async (stimulus) => ({
				...stimulus,
				durable:
					(
						await runtimeDiagnosticRows(
							runtime,
							`SELECT run.state AS runState,
						        run.attempt AS runAttempt,
						        run.consumer AS runConsumer,
						        run.claim_expires_at AS runClaimExpiresAt,
						        run.heartbeat_at AS runHeartbeatAt,
						        run.materialization_generation AS runMaterializationGeneration,
						        run.materialized_at AS runMaterializedAt,
						        session.status AS sessionStatus,
						        session.lifecycle_state AS lifecycleState,
						        materialization.state AS materializationState,
						        materialization.fault_kind AS materializationFaultKind,
						        materialization.recoverable AS materializationRecoverable,
						        supervision.heartbeat_at AS materializationHeartbeatAt,
						        supervision.recovery_attempt AS recoveryAttempt,
						        supervision.recovery_consumer AS recoveryConsumer,
						        supervision.recovery_token IS NOT NULL AS recoveryTokenPresent,
						        supervision.recovery_claimed_at AS recoveryClaimedAt,
						        supervision.recovery_expires_at AS recoveryExpiresAt,
						        supervision.recovery_heartbeat_at AS recoveryHeartbeatAt,
						        supervision.recovered_at AS recoveredAt,
						        worker.state AS workerState,
						        kernel.state AS kernelState,
						        occupancy.state AS occupancyState,
						        allocation.state AS allocationState,
						        allocation.hold_reason AS allocationHoldReason
						   FROM agent_session_child_runs AS run
						   JOIN agent_sessions AS session ON session.session_id = run.child_session_id
						   JOIN agent_session_child_budget_allocations AS allocation
						     ON allocation.admission_id = run.admission_id
						   LEFT JOIN agent_materializations AS materialization
						     ON materialization.session_id = run.child_session_id
						    AND materialization.generation = run.materialization_generation
						   LEFT JOIN agent_materialization_supervision AS supervision
						     ON supervision.session_id = materialization.session_id
						    AND supervision.generation = materialization.generation
						   LEFT JOIN agent_session_body_states AS worker
						     ON worker.session_id = materialization.session_id
						    AND worker.generation = materialization.generation
						    AND worker.role = 'worker'
						   LEFT JOIN agent_session_body_states AS kernel
						     ON kernel.session_id = materialization.session_id
						    AND kernel.generation = materialization.generation
						    AND kernel.role = 'kernel'
						   LEFT JOIN agent_session_child_generation_occupancy AS occupancy
						     ON occupancy.child_session_id = materialization.session_id
						    AND occupancy.generation = materialization.generation
						  WHERE run.child_run_id = ?`,
							[stimulus.childRunId],
						)
					)[0] ?? null,
				recoveryQueue: recoveryByRun.get(stimulus.childRunId) ?? null,
				closureWork: await runtimeDiagnosticRows(
					runtime,
					`SELECT request.disposition AS requestDisposition,
					        work.state AS workState,
					        work.attempt AS workAttempt,
					        work.consumer AS workConsumer,
					        work.claim_expires_at AS workClaimExpiresAt,
					        receipt.materialization_state AS receiptMaterializationState,
					        receipt.session_state AS receiptSessionState,
					        receipt.allocation_state AS receiptAllocationState
					   FROM agent_session_child_closure_requests AS request
					   LEFT JOIN agent_session_child_closure_work AS work ON work.closure_id = request.closure_id
					   LEFT JOIN agent_session_child_closure_receipts AS receipt ON receipt.closure_id = request.closure_id
					  WHERE request.child_run_id = ?`,
					[stimulus.childRunId],
				),
				cascadeWork: await runtimeDiagnosticRows(
					runtime,
					`SELECT cascade.cause,
					        cascade.state AS cascadeState,
					        member.depth,
					        member.action
					   FROM agent_session_descendant_cascade_members AS member
					   JOIN agent_session_descendant_cascades AS cascade ON cascade.cascade_id = member.cascade_id
					  WHERE member.session_id = ?
					  ORDER BY cascade.created_at, member.depth`,
					[stimulus.sessionId],
				),
			})),
		),
	};
}

async function boundedParentRegrowSnapshot(
	harness: LocalHarness,
	parentSessionId: string,
	generation: number,
	sandboxBaseline: ReadonlySet<string>,
): Promise<unknown> {
	const newSandboxes = harness.sandboxStore
		.list()
		.filter((record) => !sandboxBaseline.has(record.sandbox_id))
		.sort((left, right) => left.queued_at.localeCompare(right.queued_at));
	const [session, materialization, bodies, witness, checkpoint, journal, family, events] = await Promise.all([
		harness.runtime.readAgentSession(parentSessionId),
		harness.runtime.readAgentMaterialization(parentSessionId, generation),
		runtimeDiagnosticRows(
			harness.runtime,
			`SELECT generation, role, state, updated_at AS updatedAt
			   FROM agent_session_body_states
			  WHERE session_id = ?
			  ORDER BY generation, role`,
			[parentSessionId],
		),
		harness.runtime.readLatestKernelReplayWitness(parentSessionId),
		harness.runtime.readLatestKernelCheckpoint(parentSessionId),
		harness.runtime.listExecutionJournal(parentSessionId),
		harness.runtime.readAgentSessionFamilyProjection(parentSessionId),
		harness.runtime.listAgentSessionEvents(parentSessionId),
	]);
	const lease = harness.spawner.getKernelLeaseForSession(parentSessionId);
	return {
		sessionId: parentSessionId,
		generation,
		sessionStatus: session?.status ?? null,
		lifecycleState: session?.lifecycle_state ?? null,
		materialization: materialization
			? {
					generation: materialization.generation,
					state: materialization.state,
					faultKind: materialization.fault_kind,
					recoverable: materialization.recoverable,
					workerSandboxId: materialization.sandbox_id,
				}
			: null,
		bodies,
		sessionBodyCount: harness.spawner.sessionBodyCount(parentSessionId),
		kernelLease: lease
			? {
					kernelSandboxId: lease.kernelSandboxId,
					generation: lease.generation,
					pending: lease.pending,
				}
			: null,
		newSandboxes: await Promise.all(
			newSandboxes.map(async (record) => {
				const active = harness.spawner.getActive().get(record.sandbox_id) as
					| {
							process: ChildProcess;
							bodyBound?: boolean;
							durableSupervisorExit?: boolean;
							hostWorkAdmissionClosed?: boolean;
							isAgentRun?: boolean;
							workerTerminalState?: string;
							workerResultFault?: string;
							exitCleanupError?: unknown;
							exitDone?: Promise<void>;
							agentRequest?: {
								readonly session_id: string;
								readonly generation: number;
								readonly runtime_binding: { readonly kind: string };
							};
					  }
					| undefined;
				return {
					sandboxId: record.sandbox_id,
					template: record.template,
					storeState: record.state,
					pid: record.pid ?? null,
					pidAlive: record.pid ? isProcessAlive(record.pid) : false,
					exitCode: record.exit_code ?? null,
					errorDetail: record.error_detail ?? null,
					transitions: sandboxDiagnosticTransitions(harness.sandboxStore, record.sandbox_id),
					active: active
						? {
								pid: active.process.pid ?? null,
								pidAlive: active.process.pid ? isProcessAlive(active.process.pid) : false,
								exitCode: active.process.exitCode,
								signalCode: active.process.signalCode,
								bodyBound: active.bodyBound ?? null,
								durableSupervisorExit: active.durableSupervisorExit ?? null,
								hostWorkAdmissionClosed: active.hostWorkAdmissionClosed ?? null,
								isAgentRun: active.isAgentRun ?? null,
								workerTerminalState: active.workerTerminalState ?? null,
								workerResultFault: active.workerResultFault ?? null,
								exitCleanupError: active.exitCleanupError ? String(active.exitCleanupError) : null,
								exitDone: await promiseState(active.exitDone),
								agentRequest: active.agentRequest
									? {
											sessionId: active.agentRequest.session_id,
											generation: active.agentRequest.generation,
											runtimeKind: active.agentRequest.runtime_binding.kind,
										}
									: null,
							}
						: null,
				};
			}),
		),
		replayWitness: witness
			? {
					generation: witness.generation,
					journalHeadDigest: witness.journalHeadDigest,
					namespace: witness.namespace,
				}
			: null,
		checkpoint: checkpoint
			? {
					generation: checkpoint.manifest.generation,
					journalHeadDigest: checkpoint.manifest.journalHeadDigest,
					runtimeBundleDigest: checkpoint.manifest.runtimeBundleDigest,
					namespace: checkpoint.manifest.namespace,
					skipped: checkpoint.manifest.skipped,
				}
			: null,
		journal: {
			count: journal.length,
			head: journal.at(-1)
				? {
						generation: journal.at(-1)!.generation,
						cellDigest: journal.at(-1)!.cellDigest,
						kernelSandboxId: journal.at(-1)!.kernelSandboxId,
						status: journal.at(-1)!.status,
					}
				: null,
		},
		replayEvents: events
			.filter((event) => event.type === "runtime.resumed" || event.type === "runtime.fault")
			.map((event) => ({ type: event.type, ts: event.ts, payload: event.payload })),
		family: family ? boundedFamilyBodySnapshot(family) : null,
	};
}

function sandboxDiagnosticTransitions(store: SandboxStore, sandboxId: string): Record<string, unknown>[] {
	const db = (
		store as unknown as {
			db: {
				prepare(sql: string): {
					all(...args: unknown[]): readonly Record<string, unknown>[];
				};
			};
		}
	).db;
	return db
		.prepare(
			`SELECT from_state AS fromState, to_state AS toState, reason, transitioned_at AS transitionedAt
			   FROM state_transitions
			  WHERE sandbox_id = ?
			  ORDER BY id`,
		)
		.all(sandboxId)
		.map((row) => ({ ...row }));
}

async function runtimeDiagnosticRows(
	runtime: WorkflowRuntimeStore,
	sql: string,
	args: readonly (string | number)[],
): Promise<Record<string, unknown>[]> {
	const result = await (
		runtime as unknown as {
			read(input: {
				readonly sql: string;
				readonly args: readonly (string | number)[];
			}): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
		}
	).read({ sql, args });
	return result.rows.map((row) => ({ ...row }));
}

function parentContext(parentSessionId: string, materialization: AgentMaterializationRecord) {
	return {
		sessionId: parentSessionId,
		generation: materialization.generation,
		activationId: materialization.activation_id,
		agentSandboxId: materialization.sandbox_id,
		ownerUserId: ACTOR_USER_ID,
		graphOwnerPrincipal: GRAPH_OWNER,
		graphId: GRAPH_ID,
	};
}

function childDispatcher(spawner: SandboxSpawner): {
	handle(input: {
		requestId: string;
		payload: unknown;
		parent: ReturnType<typeof parentContext>;
	}): Promise<RlmDeleteSubagentResult>;
	stop(): Promise<void>;
} {
	const dispatcher = (
		spawner as unknown as {
			childExecutionService?: {
				handle(input: {
					requestId: string;
					payload: unknown;
					parent: ReturnType<typeof parentContext>;
				}): Promise<RlmDeleteSubagentResult>;
				stop(): Promise<void>;
			};
		}
	).childExecutionService;
	assert.ok(dispatcher, "Arc F5 organism requires the production child dispatcher");
	return dispatcher;
}

function unexpectedProcess(spawner: SandboxSpawner, sandboxId: string): ChildProcess {
	const active = spawner.getActive().get(sandboxId);
	assert.ok(active, `sandbox ${sandboxId} is not active for the crash stimulus`);
	return active.process;
}

function requirePid(child: ChildProcess): number {
	assert.notEqual(child.pid, undefined, "crash stimulus process has no PID");
	return child.pid!;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function assertDurableDisplayBoundary(
	harness: LocalHarness,
	evidence: ProjectionEvidence,
	parentSessionId: string,
	forbidden: readonly string[],
): Promise<void> {
	await waitFor(
		async () => (await harness.runtime.readAgentSessionFamilyProjectionOutboxNextAvailableAt(Date.now())) === null,
		"family projection outbox did not durably drain",
	);
	assert.ok(evidence.updates.length > 0);
	assert.ok(evidence.authorities.length > 0);
	for (const authority of evidence.authorities) {
		assert.equal(authority.ownerUserId, ACTOR_USER_ID);
		assert.equal(authority.graphOwnerPrincipal, GRAPH_OWNER);
		assert.equal(authority.graphId, GRAPH_ID);
		assert.equal(authority.rootSessionId, parentSessionId);
	}
	const family = await harness.runtime.readAgentSessionFamilyProjection(parentSessionId);
	assert.ok(family);
	const displayTruth = JSON.stringify({ family, updates: evidence.updates });
	for (const value of [ACTOR_USER_ID, GRAPH_OWNER, TEST_ONTOLOGY_OWNER, ...forbidden]) {
		assert.equal(displayTruth.includes(value), false, `family display leaked ${value}`);
	}
	for (const child of family.children) {
		assert.deepEqual(Object.keys(child.child).sort(), ["agentId", "graphId", "sessionId", "sessionState"]);
		assert.equal("model" in child, false);
		assert.equal("prompt" in child, false);
		assert.equal("sandboxId" in child, false);
		assert.equal("childRunId" in child, false);
	}
	for (const child of family.children) {
		const session = await harness.runtime.readAgentSession(child.child.sessionId);
		assert.equal(session?.owner_user_id, ACTOR_USER_ID);
		assert.equal(session?.graph_owner_principal, GRAPH_OWNER);
		assert.equal(session?.graph_id, GRAPH_ID);
	}
}

async function assertParentEventCounts(
	runtime: WorkflowRuntimeStore,
	parentSessionId: string,
	expected: Readonly<Record<string, number>>,
): Promise<void> {
	const events = await runtime.listAgentSessionEvents(parentSessionId);
	for (const [type, count] of Object.entries(expected)) {
		assert.equal(events.filter((event) => event.type === type).length, count, `${type} testimony count`);
	}
}

async function waitFor(check: () => boolean | Promise<boolean>, message: string, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await delay(10);
	}
	throw new Error(message);
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve!: () => void;
	return {
		promise: new Promise<void>((done) => {
			resolve = done;
		}),
		resolve: () => resolve(),
	};
}

async function closeHarness(harness: LocalHarness): Promise<void> {
	await harness.spawner.shutdownAll();
	harness.runtime.close();
	harness.sandboxStore.close();
}
