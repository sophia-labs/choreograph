import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SOPHIA_CONTENT_REF_SCHEMA } from "../agent-runtime/content-store.js";
import { PRIME_HOST_PROTOCOL_VERSION } from "../agent-runtime/host-protocol.js";
import { createMeaningfulObjectRef, type MeaningfulObjectRefV1 } from "../agent-runtime/meaningful-object.js";
import { AGENT_CHECKPOINT_SCHEMA } from "../agent-runtime/memory.js";
import { digestAgentRuntimeBinding } from "../agent-runtime/profile.js";
import { PRIME_RUNTIME_STATE_SCHEMA } from "../agent-runtime/result-validation.js";
import { AgentSessionChildRunFault, WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

describe("Arc F5 durable child ownership", () => {
	it("fences a two-store lease race, reclaims only expired pre-body work, and recovery-fences the old activation", async () => {
		await withTwoStores(async (first, second) => {
			const seeded = await seedParent(first, "lease-race-parent", "prime");
			const child = await admitChild(first, seeded, "lease-race", 10);
			const claims = await Promise.all(
				Array.from({ length: 8 }, (_, index) =>
					(index % 2 === 0 ? first : second).claimAgentSessionChildRun(child.run.child_run_id, {
						consumer: `executor-${String(index)}`,
						leaseMs: 10,
						now: 20,
					}),
				),
			);
			assert.equal(claims.filter((claim) => claim.claimed).length, 1);
			const firstClaim = claims.find((claim) => claim.claimed)!;
			assert.equal(firstClaim.run.attempt, 1);

			const reclaimed = await second.claimAgentSessionChildRun(child.run.child_run_id, {
				consumer: "executor-reclaimed",
				leaseMs: 20,
				now: 31,
			});
			assert.equal(reclaimed.claimed, true);
			assert.equal(reclaimed.run.attempt, 2);
			await assert.rejects(
				first.renewAgentSessionChildRunLease(child.run.child_run_id, {
					consumer: firstClaim.run.consumer!,
					claimToken: firstClaim.run.claim_token!,
					leaseMs: 10,
					now: 32,
				}),
				(error: unknown) => error instanceof AgentSessionChildRunFault && error.reason === "lease_lost",
			);

			const activationId = "act-f5-child";
			await second.claimAgentSessionChildMaterialization(child.run.child_run_id, {
				consumer: reclaimed.run.consumer!,
				claimToken: reclaimed.run.claim_token!,
				generation: 0,
				activationId,
				now: 33,
			});
			await second.bindAgentSandbox(child.child.session_id, {
				generation: 0,
				activationId,
				sandboxId: "sbx-f5-child",
				childRunConsumer: reclaimed.run.consumer!,
				childRunClaimToken: reclaimed.run.claim_token!,
				now: 34,
			});
			await bindKernelBody(second, child.child.session_id, 0, activationId, 35);
			const cell = {
				schema: "choreograph.compute-cell.v1" as const,
				cellRef: "compute.cell:f5-recovery-fence:0",
				sessionId: child.child.session_id,
				leaseId: "kernel-lease-f5",
				kernelSandboxId: "kernel-sandbox-f5",
				inputId: "input-f5",
				ordinal: 0,
				generation: 0,
				code: "40 + 2",
				status: "ok" as const,
				executionCount: 1,
				outputs: [{ kind: "result" as const, data: { "text/plain": "42" } }],
				startedAt: 35,
				completedAt: 36,
				durationMs: 1,
				hostRequests: [],
				cellDigest: `sha256:${"c".repeat(64)}`,
			};
			await second.appendExecutionCell(child.child.session_id, activationId, cell);
			const witness = {
				sessionId: child.child.session_id,
				generation: 0,
				journalHeadDigest: cell.cellDigest,
				namespace: ["answer"],
				createdAt: 37,
			};
			await second.commitKernelReplayWitness(witness, activationId);
			assert.equal(
				(await second.appendExecutionCell(child.child.session_id, activationId, cell)).cell_ref,
				cell.cellRef,
			);
			await assert.rejects(
				second.appendExecutionCell(child.child.session_id, activationId, { ...cell, code: "changed" }),
				/different testimony/i,
			);
			await second.commitKernelReplayWitness(witness, activationId);
			await assert.rejects(
				second.commitKernelReplayWitness({ ...witness, namespace: ["changed"] }, activationId),
				/different testimony/i,
			);
			await second.renewAgentSessionChildRunLease(child.run.child_run_id, {
				consumer: reclaimed.run.consumer!,
				claimToken: reclaimed.run.claim_token!,
				leaseMs: 100,
				now: 40,
			});
			assert.deepEqual(await first.listClaimableAgentSessionChildRuns({ now: 60 }), []);
			await first.heartbeatAgentMaterialization(seeded.parentSessionId, 0, {
				activationId: seeded.parentFence.parentActivationId,
				now: 140,
			});

			const recovery = await first.claimAgentMaterializationRecovery({
				consumer: "supervisor-a",
				leaseMs: 20,
				staleBefore: 50,
				now: 141,
			});
			assert.equal(recovery?.materialization.session_id, child.child.session_id);
			await assert.rejects(
				second.claimAgentSessionChildMaterialization(child.run.child_run_id, {
					consumer: reclaimed.run.consumer!,
					claimToken: reclaimed.run.claim_token!,
					generation: 0,
					activationId,
					now: 142,
				}),
				/error|fence|lease|latest|live/i,
			);
			await assert.rejects(
				second.claimAgentMaterialization(child.child.session_id, { generation: 0, activationId, now: 142 }),
				/error|fence|lease|latest|live/i,
			);
			await assert.rejects(
				second.bindAgentSandbox(child.child.session_id, {
					generation: 0,
					activationId,
					sandboxId: "sbx-f5-child",
					childRunConsumer: reclaimed.run.consumer!,
					childRunClaimToken: reclaimed.run.claim_token!,
					now: 142,
				}),
				/error|fence|lease|latest|live/i,
			);
			await assert.rejects(
				second.heartbeatAgentMaterialization(child.child.session_id, 0, { activationId, now: 142 }),
				/error|fence/i,
			);
			await assert.rejects(
				second.appendAgentSessionEventForGeneration(child.child.session_id, 0, activationId, {
					type: "stale.worker.write",
					ts: 142,
				}),
				/error|fence|lease|latest|live/i,
			);
			await assert.rejects(
				second.appendExecutionCell(child.child.session_id, activationId, cell),
				/error|fence|lease|latest|live/i,
			);
			await assert.rejects(
				second.appendExecutionCell(child.child.session_id, activationId, {
					...cell,
					cellRef: "compute.cell:f5-recovery-fence:1",
					ordinal: 1,
					cellDigest: `sha256:${"d".repeat(64)}`,
				}),
				/error|fence|lease|latest|live/i,
			);
			await assert.rejects(
				second.commitKernelReplayWitness(witness, activationId),
				/error|fence|lease|latest|live/i,
			);
			await assert.rejects(
				second.renewAgentSessionChildRunLease(child.run.child_run_id, {
					consumer: reclaimed.run.consumer!,
					claimToken: reclaimed.run.claim_token!,
					leaseMs: 20,
					now: 40,
				}),
				(error: unknown) => error instanceof AgentSessionChildRunFault && error.reason === "lease_lost",
			);
		});
	});

	it("cancels queued work exactly once and releases generation-zero occupancy and allocation with zero spend", async () => {
		await withTwoStores(async (first, second) => {
			const seeded = await seedParent(first);
			const child = await admitChild(first, seeded, "queued-cancel", 10);
			const input = {
				requestId: "delete-queued-cancel",
				actor: {
					kind: "parent_materialization" as const,
					parentSessionId: seeded.parentSessionId,
					generation: seeded.parentFence.parentGeneration,
					activationId: seeded.parentFence.parentActivationId,
					sandboxId: seeded.parentFence.parentSandboxId,
				},
				reason: "operator deleted the queued child",
				now: 20,
			};
			const cancelled = await first.requestAgentSessionChildCancellation(child.run.child_run_id, input);
			assert.equal(cancelled.applied, true);
			assert.equal(cancelled.request.disposition, "cancelled_before_materialization");
			assert.equal(cancelled.run.state, "cancelled");
			assert.equal(cancelled.allocation.state, "released");
			assert.equal((await first.readAgentSession(child.child.session_id))?.lifecycle_state, "closed");

			const replay = await second.requestAgentSessionChildCancellation(child.run.child_run_id, input);
			assert.equal(replay.applied, false);
			assert.equal(replay.request.cancellation_id, cancelled.request.cancellation_id);
			await assert.rejects(
				second.requestAgentSessionChildCancellation(child.run.child_run_id, {
					...input,
					reason: "changed testimony",
				}),
				(error: unknown) => error instanceof AgentSessionChildRunFault && error.reason === "cancellation_conflict",
			);

			const parentBudget = await first.readAgentSessionBudgetSnapshot(seeded.parentSessionId);
			assert.equal(parentBudget?.account.reserved.costUsdMicros, 0);
			assert.equal(parentBudget?.account.spent.costUsdMicros, 0);
			assert.equal(
				(await first.resolveAgentSessionChildControl(seeded.parentSessionId, child.run.child_run_id))?.run_state,
				"cancelled",
			);
			const cancelledEvent = (await first.listAgentSessionEvents(seeded.parentSessionId)).find(
				(event) => event.type === "child.run.cancelled",
			);
			assert.deepEqual(cancelledEvent?.payload, {
				schema: "choreograph.agent-session-child-run-result.v1",
				childRunId: child.run.child_run_id,
				admissionId: child.admission.admission_id,
				parentSessionId: seeded.parentSessionId,
				childSessionId: child.child.session_id,
				childName: child.admission.child_name,
				status: "cancelled",
				terminalPolicy: "close",
				budgetAllocationId: child.allocation.allocation_id,
				materialization: null,
				result: null,
				error: input.reason,
				recovered: false,
			});
			await assert.rejects(
				first.resolveAgentSessionChildControl(seeded.parentSessionId, child.child.session_id),
				(error: unknown) => error instanceof AgentSessionChildRunFault && error.reason === "authority_invalid",
			);
		});
	});

	it("arbitrates cancellation-before-bind as no body and bind-before-cancellation as exact body cleanup", async () => {
		await withTwoStores(async (first, second) => {
			const parent = await seedParent(first, "launch-intent-race", "simple");
			const actor = {
				kind: "parent_materialization" as const,
				parentSessionId: parent.parentSessionId,
				generation: parent.parentFence.parentGeneration,
				activationId: parent.parentFence.parentActivationId,
				sandboxId: parent.parentFence.parentSandboxId,
			};

			const cancelFirst = await admitChild(first, parent, "cancel-first", 10);
			const cancelClaim = await first.claimAgentSessionChildRun(cancelFirst.run.child_run_id, {
				consumer: "cancel-first-executor",
				leaseMs: 100,
				now: 20,
			});
			const cancelActivation = "act-cancel-first";
			await first.claimAgentSessionChildMaterialization(cancelFirst.run.child_run_id, {
				consumer: cancelClaim.run.consumer!,
				claimToken: cancelClaim.run.claim_token!,
				generation: 0,
				activationId: cancelActivation,
				now: 21,
			});
			assert.equal((await first.readAgentSessionChildRun(cancelFirst.run.child_run_id))?.materialized_at, null);
			assert.equal((await first.readAgentMaterialization(cancelFirst.child.session_id, 0))?.state, "claimed");
			await first.heartbeatAgentMaterialization(parent.parentSessionId, 0, {
				activationId: parent.parentFence.parentActivationId,
				now: 99,
			});
			assert.equal(
				await second.claimAgentMaterializationRecovery({
					consumer: "must-not-recover-launch-intent",
					leaseMs: 20,
					staleBefore: 98,
					now: 100,
				}),
				null,
				"a launch intent is not a crashed worker body",
			);
			const cancellation = await second.requestAgentSessionChildCancellation(cancelFirst.run.child_run_id, {
				requestId: "cancel-before-bind",
				actor,
				reason: "cancel won before sandbox bind",
				now: 22,
			});
			assert.equal(cancellation.request.disposition, "cancelled_before_materialization");
			assert.equal(cancellation.run.state, "cancelled");
			assert.equal(await first.readAgentMaterialization(cancelFirst.child.session_id, 0), null);
			assert.equal(cancellation.allocation.state, "released");
			assert.equal(
				(await first.readAgentSessionChildGenerationOccupancy(cancelFirst.child.session_id, 0))?.state,
				"released",
			);
			await assert.rejects(
				first.bindAgentSandbox(cancelFirst.child.session_id, {
					generation: 0,
					activationId: cancelActivation,
					sandboxId: "sbx-must-not-bind",
					childRunConsumer: cancelClaim.run.consumer!,
					childRunClaimToken: cancelClaim.run.claim_token!,
					now: 23,
				}),
				/error|closed|terminal|bind/i,
			);
			const replay = await first.requestAgentSessionChildCancellation(cancelFirst.run.child_run_id, {
				requestId: "cancel-before-bind",
				actor,
				reason: "cancel won before sandbox bind",
				now: 24,
			});
			assert.equal(replay.applied, false);
			assert.equal(replay.request.disposition, "cancelled_before_materialization");

			const bindFirst = await admitChild(first, parent, "bind-first", 30);
			const bindClaim = await first.claimAgentSessionChildRun(bindFirst.run.child_run_id, {
				consumer: "bind-first-executor",
				leaseMs: 100,
				now: 31,
			});
			const bindActivation = "act-bind-first";
			await first.claimAgentSessionChildMaterialization(bindFirst.run.child_run_id, {
				consumer: bindClaim.run.consumer!,
				claimToken: bindClaim.run.claim_token!,
				generation: 0,
				activationId: bindActivation,
				now: 32,
			});
			await first.bindAgentSandbox(bindFirst.child.session_id, {
				generation: 0,
				activationId: bindActivation,
				sandboxId: "sbx-bind-first",
				childRunConsumer: bindClaim.run.consumer!,
				childRunClaimToken: bindClaim.run.claim_token!,
				now: 33,
			});
			assert.equal((await second.readAgentSessionChildRun(bindFirst.run.child_run_id))?.materialized_at, 33);
			const pending = await second.requestAgentSessionChildCancellation(bindFirst.run.child_run_id, {
				requestId: "cancel-after-bind",
				actor,
				reason: "bind won before cancellation",
				now: 34,
			});
			assert.equal(pending.request.disposition, "cancellation_pending");
			await assert.rejects(
				second.bindAgentSandbox(bindFirst.child.session_id, {
					generation: 0,
					activationId: bindActivation,
					sandboxId: "sbx-stale-rebind",
					childRunConsumer: "stale-executor",
					childRunClaimToken: "stale-token",
					now: 35,
				}),
				/error|closing|lease|cancellation/i,
			);
			assert.equal((await first.readAgentMaterialization(bindFirst.child.session_id, 0))?.state, "running");
			await first.finishAgentMaterialization(bindFirst.child.session_id, 0, {
				activationId: bindActivation,
				from: "running",
				to: "cancelled",
				now: 36,
			});
			const settled = await first.settleAgentSessionChildRun(bindFirst.run.child_run_id, {
				consumer: bindClaim.run.consumer!,
				claimToken: bindClaim.run.claim_token!,
				status: "cancelled",
				terminalPolicy: "close",
				materializationGeneration: 0,
				materializationState: "cancelled",
				error: "bind won before cancellation",
				now: 37,
			});
			assert.equal(settled.run.state, "cancelled");
			const family = await second.readAgentSessionFamilyProjection(parent.parentSessionId);
			const boundChild = family?.children.find((entry) => entry.child.sessionId === bindFirst.child.session_id);
			assert.equal(boundChild?.materializationState, "cancelled");
			assert.equal(boundChild?.workerState, "cancelled");
			assert.equal(boundChild?.kernelState, null);
			const boundCancelledEvent = (await second.listAgentSessionEvents(parent.parentSessionId)).find(
				(event) =>
					event.type === "child.run.cancelled" &&
					(event.payload as { childRunId?: unknown }).childRunId === bindFirst.run.child_run_id,
			);
			assert.deepEqual(boundCancelledEvent?.payload, {
				schema: "choreograph.agent-session-child-run-result.v1",
				childRunId: bindFirst.run.child_run_id,
				admissionId: bindFirst.admission.admission_id,
				parentSessionId: parent.parentSessionId,
				childSessionId: bindFirst.child.session_id,
				childName: bindFirst.admission.child_name,
				status: "cancelled",
				terminalPolicy: "close",
				budgetAllocationId: bindFirst.allocation.allocation_id,
				materialization: { generation: 0, state: "cancelled" },
				result: null,
				error: "bind won before cancellation",
				recovered: false,
			});
		});
	});

	it("settles an exact failed launch sentinel without inventing a worker body and rejects stale bind", async () => {
		await withTwoStores(async (first, second) => {
			const parent = await seedParent(first, "failed-before-bind", "prime");
			const child = await admitChild(first, parent, "failed-before-bind", 10);
			const claim = await first.claimAgentSessionChildRun(child.run.child_run_id, {
				consumer: "failed-launch-executor",
				leaseMs: 100,
				now: 20,
			});
			const activationId = "act-failed-before-bind";
			await first.claimAgentSessionChildMaterialization(child.run.child_run_id, {
				consumer: claim.run.consumer!,
				claimToken: claim.run.claim_token!,
				generation: 0,
				activationId,
				now: 21,
			});
			const input = {
				consumer: claim.run.consumer!,
				claimToken: claim.run.claim_token!,
				generation: 0,
				activationId,
				error: "worker executable missing",
				now: 22,
			};
			const failed = await second.failUnboundAgentSessionChildRun(child.run.child_run_id, input);
			assert.equal(failed.applied, true);
			assert.equal(failed.run.state, "failed");
			assert.equal(failed.run.materialized_at, null);
			assert.equal(failed.run.materialization_generation, null);
			assert.equal(failed.allocation.state, "released");
			assert.equal(await first.readAgentMaterialization(child.child.session_id, 0), null);
			assert.equal(
				(await first.readAgentSessionChildGenerationOccupancy(child.child.session_id, 0))?.state,
				"released",
			);
			assert.deepEqual(
				(
					await first.raw("SELECT role, state FROM agent_session_body_states WHERE session_id = ?", [
						child.child.session_id,
					])
				).rows,
				[],
			);
			const session = await first.readAgentSession(child.child.session_id);
			assert.equal(session?.status, "failed");
			assert.equal(session?.lifecycle_state, "closed");
			const replay = await first.failUnboundAgentSessionChildRun(child.run.child_run_id, {
				...input,
				now: 23,
			});
			assert.equal(replay.applied, false);
			await assert.rejects(
				first.bindAgentSandbox(child.child.session_id, {
					generation: 0,
					activationId,
					sandboxId: "sbx-stale-failed-launch",
					childRunConsumer: claim.run.consumer!,
					childRunClaimToken: claim.run.claim_token!,
					now: 24,
				}),
				/error|missing|terminal|bind/i,
			);
			const parentEvents = await first.listAgentSessionEvents(parent.parentSessionId);
			const failedEvents = parentEvents.filter((event) => event.type === "child.run.failed");
			assert.equal(failedEvents.length, 1);
			assert.deepEqual(failedEvents[0]?.payload, {
				schema: "choreograph.agent-session-child-run-result.v1",
				childRunId: child.run.child_run_id,
				admissionId: child.admission.admission_id,
				parentSessionId: parent.parentSessionId,
				childSessionId: child.child.session_id,
				childName: child.admission.child_name,
				status: "failed",
				terminalPolicy: "close",
				budgetAllocationId: child.allocation.allocation_id,
				materialization: null,
				result: null,
				error: input.error,
				recovered: false,
			});
			const childEvents = await first.listAgentSessionEvents(child.child.session_id);
			assert.equal(childEvents.filter((event) => event.type === "session.closed").length, 1);
			assert.equal(childEvents.filter((event) => event.type === "runtime.fault").length, 0);
			assert.equal(childEvents.filter((event) => event.type === "session.faulted").length, 0);
		});
	});

	it("fences kernel launch attempts from durable intent through one observed body bind", async () => {
		await withTwoStores(async (first, second) => {
			const root = await seedParent(first, "kernel-launch-attempts", "simple", true, "prime");
			await assert.rejects(
				first.recordAgentSessionKernelState(root.parentSessionId, 0, {
					activationId: root.parentFence.parentActivationId,
					state: "running",
					now: 4,
				}),
				/observed-spawn bind/i,
			);
			await first.beginAgentSessionKernelLaunch(root.parentSessionId, 0, {
				activationId: root.parentFence.parentActivationId,
				sandboxId: "sbx-kernel-attempt-a",
				now: 4,
			});
			await second.failUnboundAgentSessionKernelLaunch(root.parentSessionId, 0, {
				activationId: root.parentFence.parentActivationId,
				sandboxId: "sbx-kernel-attempt-a",
				now: 5,
			});
			await assert.rejects(
				first.recordAgentSessionKernelState(root.parentSessionId, 0, {
					activationId: root.parentFence.parentActivationId,
					state: "faulted",
					now: 5,
				}),
				/observed-spawn bind/i,
			);
			await assert.rejects(
				second.beginAgentSessionKernelLaunch(root.parentSessionId, 0, {
					activationId: root.parentFence.parentActivationId,
					sandboxId: "sbx-kernel-backdated",
					now: 4,
				}),
				/predates/i,
			);
			await second.beginAgentSessionKernelLaunch(root.parentSessionId, 0, {
				activationId: root.parentFence.parentActivationId,
				sandboxId: "sbx-kernel-attempt-b",
				now: 6,
			});
			await assert.rejects(
				second.bindAgentSessionKernelLaunch(root.parentSessionId, 0, {
					activationId: root.parentFence.parentActivationId,
					sandboxId: "sbx-kernel-attempt-b",
					now: 5,
				}),
				/predates/i,
			);
			const stillLaunching = await first.raw(
				"SELECT state, attempt, sandbox_id, updated_at FROM agent_session_kernel_launches WHERE session_id = ? AND generation = 0",
				[root.parentSessionId],
			);
			assert.deepEqual(
				{
					state: stillLaunching.rows[0]?.state,
					attempt: Number(stillLaunching.rows[0]?.attempt),
					sandboxId: stillLaunching.rows[0]?.sandbox_id,
					updatedAt: Number(stillLaunching.rows[0]?.updated_at),
				},
				{ state: "launching", attempt: 2, sandboxId: "sbx-kernel-attempt-b", updatedAt: 6 },
			);
			await assert.rejects(
				first.bindAgentSessionKernelLaunch(root.parentSessionId, 0, {
					activationId: root.parentFence.parentActivationId,
					sandboxId: "sbx-kernel-attempt-a",
					now: 7,
				}),
				/error|launch intent|CAS/i,
			);
			const body = await first.bindAgentSessionKernelLaunch(root.parentSessionId, 0, {
				activationId: root.parentFence.parentActivationId,
				sandboxId: "sbx-kernel-attempt-b",
				now: 8,
			});
			assert.equal(body.state, "running");
			assert.equal(
				(
					await second.recordAgentSessionKernelState(root.parentSessionId, 0, {
						activationId: root.parentFence.parentActivationId,
						state: "running",
						now: 8,
					})
				).state,
				"running",
			);
			const launch = await first.raw(
				"SELECT state, attempt, sandbox_id, body_observed_at FROM agent_session_kernel_launches WHERE session_id = ? AND generation = 0",
				[root.parentSessionId],
			);
			assert.deepEqual(
				{
					state: launch.rows[0]?.state,
					attempt: Number(launch.rows[0]?.attempt),
					sandboxId: launch.rows[0]?.sandbox_id,
					bodyObservedAt: Number(launch.rows[0]?.body_observed_at),
				},
				{ state: "bound", attempt: 2, sandboxId: "sbx-kernel-attempt-b", bodyObservedAt: 8 },
			);
			await assert.rejects(
				second.beginAgentSessionKernelLaunch(root.parentSessionId, 0, {
					activationId: root.parentFence.parentActivationId,
					sandboxId: "sbx-kernel-attempt-c",
					now: 9,
				}),
				/error|already owns/i,
			);
		});
	});

	it("reactivates only a retained live exact kernel body and never resurrects a terminal or passivated one", async () => {
		await withTwoStores(async (first, second) => {
			const root = await seedParent(first, "kernel-release-reactivation", "simple", true, "prime");
			const activationId = root.parentFence.parentActivationId;
			await bindKernelBody(first, root.parentSessionId, 0, activationId, 4);
			await first.recordAgentSessionKernelState(root.parentSessionId, 0, {
				activationId,
				state: "released",
				now: 5,
			});
			await assert.rejects(
				second.recordAgentSessionKernelState(root.parentSessionId, 0, {
					activationId: "act-f5-wrong-activation",
					state: "running",
					now: 6,
				}),
				/activation|latest/i,
			);
			assert.equal(
				(
					await second.recordAgentSessionKernelState(root.parentSessionId, 0, {
						activationId,
						state: "running",
						now: 6,
					})
				).state,
				"running",
			);
			const launch = await first.raw(
				"SELECT state, sandbox_id FROM agent_session_kernel_launches WHERE session_id = ? AND generation = 0",
				[root.parentSessionId],
			);
			assert.deepEqual(
				{ state: launch.rows[0]?.state, sandboxId: launch.rows[0]?.sandbox_id },
				{
					state: "bound",
					sandboxId: `kernel-${root.parentSessionId}-0-${activationId}`,
				},
				"reactivation must remain attached to the one observed kernel body",
			);
			await commitRootCheckpoint(first, root, 0, root.parentFence.parentSandboxId, 7);
			await first.recordAgentSessionKernelState(root.parentSessionId, 0, {
				activationId,
				state: "released",
				now: 8,
			});
			await first.transitionAgentMaterialization(root.parentSessionId, 0, {
				activationId,
				from: "running",
				to: "passivated",
				now: 9,
			});
			await assert.rejects(
				second.recordAgentSessionKernelState(root.parentSessionId, 0, {
					activationId,
					state: "running",
					now: 10,
				}),
				/latest live generation/i,
			);
			assert.equal(
				(
					await second.recordAgentSessionKernelState(root.parentSessionId, 0, {
						activationId,
						state: "shutdown",
						now: 11,
					})
				).state,
				"shutdown",
				"passivated cleanup retains authority to record a verified terminal reap",
			);

			const terminal = await seedParent(first, "kernel-terminal-reactivation", "simple", true, "prime");
			const terminalActivationId = terminal.parentFence.parentActivationId;
			await bindKernelBody(first, terminal.parentSessionId, 0, terminalActivationId, 12);
			await first.recordAgentSessionKernelState(terminal.parentSessionId, 0, {
				activationId: terminalActivationId,
				state: "shutdown",
				now: 13,
			});
			await assert.rejects(
				second.recordAgentSessionKernelState(terminal.parentSessionId, 0, {
					activationId: terminalActivationId,
					state: "running",
					now: 14,
				}),
				/cannot transition from shutdown to running/i,
			);
		});
	});

	it("rejects recovered kernel testimony before an exact observed-spawn bind", async () => {
		await withTwoStores(async (first, second) => {
			const notRequested = await seedParent(first, "recovered-kernel-not-requested", "simple", true, "prime");
			const notRequestedRecovery = await first.claimAgentMaterializationRecovery({
				consumer: "recover-not-requested",
				leaseMs: 20,
				staleBefore: 3,
				now: 50,
			});
			assert.equal(notRequestedRecovery?.materialization.session_id, notRequested.parentSessionId);
			await assert.rejects(
				first.recordRecoveredAgentSessionKernelState(notRequested.parentSessionId, 0, {
					consumer: notRequestedRecovery!.recovery_consumer,
					recoveryToken: notRequestedRecovery!.recovery_token,
					state: "faulted",
					now: 51,
				}),
				/observed-spawn bind/i,
			);

			const failedUnbound = await seedParent(second, "recovered-kernel-failed-unbound", "simple", true, "prime");
			await second.beginAgentSessionKernelLaunch(failedUnbound.parentSessionId, 0, {
				activationId: failedUnbound.parentFence.parentActivationId,
				sandboxId: "sbx-kernel-recovered-failed-unbound",
				now: 4,
			});
			await second.failUnboundAgentSessionKernelLaunch(failedUnbound.parentSessionId, 0, {
				activationId: failedUnbound.parentFence.parentActivationId,
				sandboxId: "sbx-kernel-recovered-failed-unbound",
				now: 5,
			});
			const failedUnboundRecovery = await second.claimAgentMaterializationRecovery({
				consumer: "recover-failed-unbound",
				leaseMs: 20,
				staleBefore: 5,
				now: 52,
			});
			assert.equal(failedUnboundRecovery?.materialization.session_id, failedUnbound.parentSessionId);
			await assert.rejects(
				second.recordRecoveredAgentSessionKernelState(failedUnbound.parentSessionId, 0, {
					consumer: failedUnboundRecovery!.recovery_consumer,
					recoveryToken: failedUnboundRecovery!.recovery_token,
					state: "faulted",
					now: 53,
				}),
				/observed-spawn bind/i,
			);
		});
	});

	it("settles a bound Prime worker cancellation with exact never-bound kernel testimony", async () => {
		await withTwoStores(async (first, second) => {
			const parent = await seedParent(first, "prime-kernel-prebind-cancel", "prime");
			const child = await admitChild(first, parent, "prime-kernel-prebind-cancel", 10);
			const claim = await first.claimAgentSessionChildRun(child.run.child_run_id, {
				consumer: "prime-kernel-prebind-cancel-executor",
				leaseMs: 100,
				now: 20,
			});
			const activationId = "act-prime-kernel-prebind-cancel";
			await first.claimAgentSessionChildMaterialization(child.run.child_run_id, {
				consumer: claim.run.consumer!,
				claimToken: claim.run.claim_token!,
				generation: 0,
				activationId,
				now: 21,
			});
			await first.bindAgentSandbox(child.child.session_id, {
				generation: 0,
				activationId,
				sandboxId: "sbx-prime-kernel-prebind-cancel",
				childRunConsumer: claim.run.consumer!,
				childRunClaimToken: claim.run.claim_token!,
				now: 22,
			});
			const cancellation = await second.requestAgentSessionChildCancellation(child.run.child_run_id, {
				requestId: "delete-prime-kernel-prebind-cancel",
				actor: {
					kind: "parent_materialization",
					parentSessionId: parent.parentSessionId,
					generation: parent.parentFence.parentGeneration,
					activationId: parent.parentFence.parentActivationId,
					sandboxId: parent.parentFence.parentSandboxId,
				},
				reason: "cancel while kernel acquire is still pre-bind",
				now: 23,
			});
			assert.equal(cancellation.request.disposition, "cancellation_pending");
			await first.finishAgentMaterialization(child.child.session_id, 0, {
				activationId,
				from: "running",
				to: "cancelled",
				now: 24,
			});
			const settled = await first.settleAgentSessionChildRun(child.run.child_run_id, {
				consumer: claim.run.consumer!,
				claimToken: claim.run.claim_token!,
				status: "cancelled",
				terminalPolicy: "close",
				materializationGeneration: 0,
				materializationState: "cancelled",
				error: "cancel while kernel acquire is still pre-bind",
				now: 25,
			});
			assert.equal(settled.run.state, "cancelled");
			assert.equal(settled.allocation.state, "settled");
			assert.equal((await second.readAgentSession(child.child.session_id))?.lifecycle_state, "closed");
			assert.equal(
				(await second.readAgentSessionChildGenerationOccupancy(child.child.session_id, 0))?.state,
				"released",
			);
			const bodies = await second.raw(
				"SELECT role, state FROM agent_session_body_states WHERE session_id = ? ORDER BY role",
				[child.child.session_id],
			);
			assert.deepEqual(bodies.rows, [{ role: "worker", state: "cancelled" }]);
			const launch = await second.raw(
				"SELECT state FROM agent_session_kernel_launches WHERE session_id = ? AND generation = 0",
				[child.child.session_id],
			);
			assert.deepEqual(
				launch.rows,
				[{ state: "not_requested" }],
				"not_requested is exact append-only no-kernel authority",
			);
		});
	});

	it("coalesces family projection work across a two-store claim and persists exact global revision receipts", async () => {
		await withTwoStores(async (first, second) => {
			const seeded = await seedParent(first);
			const [left, right] = await Promise.all([
				first.claimAgentSessionFamilyProjectionOutbox({ consumer: "projector-a", leaseMs: 20, now: 10 }),
				second.claimAgentSessionFamilyProjectionOutbox({ consumer: "projector-b", leaseMs: 20, now: 10 }),
			]);
			const claims = [left, right].filter((claim) => claim !== null);
			assert.equal(claims.length, 1);
			const claimed = claims[0]!;
			const claim = claimed.work;
			assert.equal(claim.work_kind, "project");
			assert.notEqual(claim.claimed_projection_revision, null);
			assert.ok(claimed.snapshot);
			await assert.rejects(
				first.retryAgentSessionFamilyProjectionOutbox({
					rootSessionId: claim.root_session_id,
					consumer: claim.consumer!,
					claimToken: claim.claim_token!,
					error: "backdated retry must not mutate the lease",
					retryAt: 9,
					now: 10,
				}),
				(error: unknown) => error instanceof AgentSessionChildRunFault && error.reason === "lease_lost",
			);

			await admitChild(second, seeded, "projection-coalesce", 11);
			const pending = await first.completeAgentSessionFamilyProjectionOutbox({
				rootSessionId: claim.root_session_id,
				consumer: claim.consumer!,
				claimToken: claim.claim_token!,
				workKind: claim.work_kind,
				projectedRevision: claimed.snapshot!.projectionRevision,
				now: 12,
			});
			assert.equal(pending.state, "pending");
			assert.equal(pending.delivered_projection_revision, claimed.snapshot!.projectionRevision);
			assert.ok(pending.delivered_revision < pending.desired_revision);

			const next = await second.claimAgentSessionFamilyProjectionOutbox({
				consumer: "projector-b",
				leaseMs: 20,
				now: 13,
			});
			assert.ok(next);
			assert.ok(next!.snapshot);
			const delivered = await second.completeAgentSessionFamilyProjectionOutbox({
				rootSessionId: next!.work.root_session_id,
				consumer: next!.work.consumer!,
				claimToken: next!.work.claim_token!,
				workKind: next!.work.work_kind,
				projectedRevision: next!.snapshot!.projectionRevision,
				now: 14,
			});
			assert.equal(delivered.state, "delivered");
			assert.equal(delivered.delivered_projection_revision, next!.snapshot!.projectionRevision);
			assert.equal(
				await first.claimAgentSessionFamilyProjectionOutbox({ consumer: "idle", leaseMs: 10, now: 15 }),
				null,
			);
		});
	});

	it("invalidates a stale standalone-root project and durably retires that root after reparenting", async () => {
		await withTwoStores(async (first, second, path) => {
			const parent = await seedParent(first);
			const detached = await seedParent(first, "detached");
			await drainFamilyProjectionOutbox(first, 10);

			await bindKernelBody(first, detached.parentSessionId, 0, detached.parentFence.parentActivationId, 20);
			const stale = await first.claimAgentSessionFamilyProjectionOutbox({
				consumer: "stale-projector",
				leaseMs: 100,
				now: 21,
			});
			assert.ok(stale);
			assert.equal(stale!.work.root_session_id, detached.parentSessionId);
			assert.equal(stale!.work.work_kind, "project");
			assert.ok(stale!.snapshot);
			const staleRevision = stale!.snapshot!.projectionRevision;

			await second.registerAgentSessionChild(parent.parentSessionId, detached.parentSessionId, {
				causationId: "attach-detached-root",
				now: 22,
			});
			await assert.rejects(
				first.completeAgentSessionFamilyProjectionOutbox({
					rootSessionId: detached.parentSessionId,
					consumer: stale!.work.consumer!,
					claimToken: stale!.work.claim_token!,
					workKind: "project",
					projectedRevision: staleRevision,
					now: 23,
				}),
				(error: unknown) => error instanceof AgentSessionChildRunFault && error.reason === "lease_lost",
			);

			let retire: Awaited<ReturnType<WorkflowRuntimeStore["claimAgentSessionFamilyProjectionOutbox"]>> = null;
			for (let now = 24; now < 30 && !retire; now += 1) {
				const claimed = await second.claimAgentSessionFamilyProjectionOutbox({
					consumer: "retire-projector",
					leaseMs: 100,
					now,
				});
				if (!claimed) break;
				if (claimed.work.work_kind === "retire") {
					retire = claimed;
					break;
				}
				await second.completeAgentSessionFamilyProjectionOutbox({
					rootSessionId: claimed.work.root_session_id,
					consumer: claimed.work.consumer!,
					claimToken: claimed.work.claim_token!,
					workKind: claimed.work.work_kind,
					projectedRevision: claimed.snapshot!.projectionRevision,
					now,
				});
			}
			assert.ok(retire);
			assert.equal(retire!.work.root_session_id, detached.parentSessionId);
			assert.equal(retire!.snapshot, null);
			assert.ok(retire!.work.claimed_projection_revision! > staleRevision);

			first.close();
			second.close();
			const reopened = new WorkflowRuntimeStore(path);
			await reopened.init();
			try {
				const completed = await reopened.completeAgentSessionFamilyProjectionOutbox({
					rootSessionId: retire!.work.root_session_id,
					consumer: retire!.work.consumer!,
					claimToken: retire!.work.claim_token!,
					workKind: "retire",
					projectedRevision: retire!.work.claimed_projection_revision!,
					now: 30,
				});
				assert.equal(completed.state, "delivered");
				assert.equal(completed.work_kind, "retire");
				assert.equal(completed.delivered_projection_revision, retire!.work.claimed_projection_revision);
			} finally {
				reopened.close();
			}
		});
	});

	it("reclaims resident closure work after a crash and fences the old body before exact closure", async () => {
		await withTwoStores(async (first, second, path) => {
			const seeded = await seedParent(first, "closure", "prime");
			const child = await admitChild(first, seeded, "resident-close", 10);
			const claimed = await first.claimAgentSessionChildRun(child.run.child_run_id, {
				consumer: "resident-executor",
				leaseMs: 100,
				now: 20,
			});
			assert.equal(claimed.claimed, true);
			const activationId = "act-resident-child";
			await first.claimAgentSessionChildMaterialization(child.run.child_run_id, {
				consumer: claimed.run.consumer!,
				claimToken: claimed.run.claim_token!,
				generation: 0,
				activationId,
				now: 21,
			});
			await first.bindAgentSandbox(child.child.session_id, {
				generation: 0,
				activationId,
				sandboxId: "sbx-resident-child",
				childRunConsumer: claimed.run.consumer!,
				childRunClaimToken: claimed.run.claim_token!,
				now: 22,
			});
			await bindKernelBody(first, child.child.session_id, 0, activationId, 23);
			const result = {
				nodeKey: child.spec.nodeKey,
				sessionId: child.child.session_id,
				invocationId: child.run.child_run_id,
				label: child.spec.label,
				phaseIndex: child.spec.phaseIndex,
				state: "done" as const,
				output: "resident ready",
				model: child.spec.model,
				turns: 1,
				toolCalls: 0,
				tokens: 8,
				queuedAt: 20,
				startedAt: 21,
				durationMs: 3,
			};
			await first.finishAgentSession(child.child.session_id, {
				result,
				status: "completed",
				generation: 0,
				activationId,
				childRunConsumer: claimed.run.consumer!,
				childRunClaimToken: claimed.run.claim_token!,
				now: 24,
				frontier: {
					kind: "after-node",
					nodeKey: child.spec.nodeKey!,
					sessionId: child.child.session_id,
					label: child.spec.label,
					phaseIndex: child.spec.phaseIndex,
					ts: 24,
				},
			});
			await first.settleAgentSessionChildRun(child.run.child_run_id, {
				consumer: claimed.run.consumer!,
				claimToken: claimed.run.claim_token!,
				status: "completed",
				terminalPolicy: "keep_open",
				materializationGeneration: 0,
				materializationState: "running",
				result,
				now: 25,
			});
			assert.deepEqual(
				await second.listAgentSessionChildRunsRequiringRecovery({ now: 25 }),
				[],
				"a healthy resident Prime body is steady state, not recovery work",
			);
			const closure = await first.requestAgentSessionChildClosure(child.run.child_run_id, {
				requestId: "close-resident",
				actor: {
					kind: "parent_materialization",
					parentSessionId: seeded.parentSessionId,
					generation: seeded.parentFence.parentGeneration,
					activationId: seeded.parentFence.parentActivationId,
					sandboxId: seeded.parentFence.parentSandboxId,
				},
				reason: "resident no longer needed",
				now: 26,
			});
			assert.equal(closure.applied, true);
			assert.equal(
				await first.claimAgentSessionChildClosureWork({ consumer: "cleanup-too-early", leaseMs: 3, now: 27 }),
				null,
				"closure ownership cannot fence a still-live resident body",
			);
			await first.finishAgentMaterialization(child.child.session_id, 0, {
				activationId,
				from: "running",
				to: "cancelled",
				now: 28,
			});
			await first.recordAgentSessionKernelState(child.child.session_id, 0, {
				activationId,
				state: "cancelled",
				now: 29,
			});
			const raced = await Promise.all([
				first.claimAgentSessionChildClosureWork({ consumer: "cleanup-a", leaseMs: 3, now: 30 }),
				second.claimAgentSessionChildClosureWork({ consumer: "cleanup-b", leaseMs: 3, now: 30 }),
			]);
			const staleCleanup = raced.find((value) => value !== null)!;
			assert.equal(raced.filter((value) => value !== null).length, 1);
			assert.equal(staleCleanup.request.closure_id, closure.request.closure_id);
			await assert.rejects(
				first.heartbeatAgentMaterialization(child.child.session_id, 0, { activationId, now: 31 }),
				/error|fence/i,
			);
			first.close();
			second.close();
			const reopenedA = new WorkflowRuntimeStore(path);
			const reopenedB = new WorkflowRuntimeStore(path);
			await reopenedA.init();
			await reopenedB.init();
			try {
				const reclaimedRace = await Promise.all([
					reopenedA.claimAgentSessionChildClosureWork({ consumer: "cleanup-reopen-a", leaseMs: 20, now: 34 }),
					reopenedB.claimAgentSessionChildClosureWork({ consumer: "cleanup-reopen-b", leaseMs: 20, now: 34 }),
				]);
				const cleanup = reclaimedRace.find((value) => value !== null)!;
				assert.equal(reclaimedRace.filter((value) => value !== null).length, 1);
				assert.equal(cleanup.attempt, 2);
				await assert.rejects(
					reopenedA.renewAgentSessionChildClosureWorkLease({
						closureId: staleCleanup.request.closure_id,
						consumer: staleCleanup.consumer,
						cleanupToken: staleCleanup.cleanup_token,
						leaseMs: 20,
						now: 35,
					}),
					(error: unknown) => error instanceof AgentSessionChildRunFault && error.reason === "lease_lost",
				);
				await assert.rejects(
					reopenedA.finishRecoveredAgentMaterialization(child.child.session_id, 0, {
						consumer: staleCleanup.consumer,
						recoveryToken: staleCleanup.cleanup_token,
						to: "cancelled",
						now: 35,
					}),
					(error: unknown) => error instanceof AgentSessionChildRunFault && error.reason === "lease_lost",
				);
				await reopenedA.finishRecoveredAgentMaterialization(child.child.session_id, 0, {
					consumer: cleanup.consumer,
					recoveryToken: cleanup.cleanup_token,
					to: "cancelled",
					now: 36,
				});
				await reopenedA.recordRecoveredAgentSessionKernelState(child.child.session_id, 0, {
					consumer: cleanup.consumer,
					recoveryToken: cleanup.cleanup_token,
					state: "cancelled",
					now: 37,
				});
				const receipt = await reopenedA.finalizeAgentSessionChildClosure(child.run.child_run_id, {
					consumer: cleanup.consumer,
					cleanupToken: cleanup.cleanup_token,
					materializationGeneration: 0,
					materializationState: "cancelled",
					now: 38,
				});
				assert.equal(receipt.applied, true);
				assert.equal(receipt.receipt?.session_state, "closed");
				assert.equal((await reopenedB.readAgentSession(child.child.session_id))?.lifecycle_state, "closed");
			} finally {
				reopenedA.close();
				reopenedB.close();
			}
		});
	});

	it("persists and advances a three-level explicit-cancel cascade one closed leaf at a time after reopen", async () => {
		await withTwoStores(async (first, second, path) => {
			const root = await seedParent(first, "cascade-root");
			const child = await seedParent(first, "cascade-child");
			const grandchild = await seedParent(first, "cascade-grandchild");
			for (const member of [root, child, grandchild]) {
				await bindKernelBody(first, member.parentSessionId, 0, member.parentFence.parentActivationId, 5);
			}
			await first.registerAgentSessionChild(root.parentSessionId, child.parentSessionId, {
				causationId: "cascade-root-child",
				now: 10,
			});
			await first.registerAgentSessionChild(child.parentSessionId, grandchild.parentSessionId, {
				causationId: "cascade-child-grandchild",
				now: 11,
			});
			const requested = await first.requestAgentSessionCancellation(root.parentSessionId, {
				requestId: "cancel-three-level-tree",
				actor: { kind: "owner_api", ownerUserId: "cognito-ada" },
				reason: "operator cancelled the Session tree",
				now: 12,
			});
			assert.equal(requested.applied, true);
			assert.equal(requested.cascade.state, "active");
			for (const member of [root, child, grandchild]) {
				assert.equal((await first.readAgentSession(member.parentSessionId))?.lifecycle_state, "closing");
			}

			first.close();
			second.close();
			const reopenedA = new WorkflowRuntimeStore(path);
			const reopenedB = new WorkflowRuntimeStore(path);
			await reopenedA.init();
			await reopenedB.init();
			try {
				for (const [index, expected] of [grandchild, child, root].entries()) {
					const now = 20 + index * 4;
					const claims = await Promise.all([
						reopenedA.claimAgentMaterializationRecovery({
							consumer: `cascade-a-${String(index)}`,
							leaseMs: 20,
							staleBefore: now,
							now,
						}),
						reopenedB.claimAgentMaterializationRecovery({
							consumer: `cascade-b-${String(index)}`,
							leaseMs: 20,
							staleBefore: now,
							now,
						}),
					]);
					const recovery = claims.find((claim) => claim !== null)!;
					assert.equal(claims.filter((claim) => claim !== null).length, 1);
					assert.equal(recovery.materialization.session_id, expected.parentSessionId);
					await reopenedA.finishRecoveredAgentMaterialization(expected.parentSessionId, 0, {
						consumer: recovery.recovery_consumer,
						recoveryToken: recovery.recovery_token,
						to: "cancelled",
						now: now + 1,
					});
					await reopenedA.recordRecoveredAgentSessionKernelState(expected.parentSessionId, 0, {
						consumer: recovery.recovery_consumer,
						recoveryToken: recovery.recovery_token,
						state: "cancelled",
						now: now + 2,
					});
					assert.equal((await reopenedB.readAgentSession(expected.parentSessionId))?.lifecycle_state, "closed");
					for (const notReady of [root, child].slice(0, 2 - index)) {
						assert.equal(
							(await reopenedB.readAgentSession(notReady.parentSessionId))?.lifecycle_state,
							"closing",
						);
					}
				}
				const completed = await reopenedB.progressAgentSessionDescendantCascade(requested.cascade.cascade_id, {
					now: 40,
				});
				assert.equal(completed.state, "completed");
			} finally {
				reopenedA.close();
				reopenedB.close();
			}
		});
	});

	it("closes a never-materialized standalone Session and completes its cancellation cascade atomically", async () => {
		await withTwoStores(async (first) => {
			const root = await seedParent(first, "no-body-cancel", "simple", false);
			const cancelled = await first.requestAgentSessionCancellation(root.parentSessionId, {
				requestId: "cancel-before-materialization",
				actor: { kind: "owner_api", ownerUserId: "cognito-ada" },
				reason: "cancel before host body claim",
				now: 10,
			});
			assert.equal(cancelled.cascade.state, "completed");
			const session = await first.readAgentSession(root.parentSessionId);
			assert.equal(session?.lifecycle_state, "closed");
			assert.equal(session?.status, "cancelled");
		});
	});

	it("keeps explicit cancellation and irrecoverable fault first-wins lifecycle testimony honest in both orders", async () => {
		await withTwoStores(async (first, second) => {
			const cancelFirst = await seedParent(first, "cancel-first-fault", "prime");
			await bindKernelBody(first, cancelFirst.parentSessionId, 0, cancelFirst.parentFence.parentActivationId, 4);
			await first.requestAgentSessionCancellation(cancelFirst.parentSessionId, {
				requestId: "cancel-before-worker-fault",
				actor: { kind: "owner_api", ownerUserId: "cognito-ada" },
				reason: "operator cancellation won",
				now: 5,
			});
			await second.finishAgentMaterialization(cancelFirst.parentSessionId, 0, {
				activationId: cancelFirst.parentFence.parentActivationId,
				from: "running",
				to: "faulted",
				faultKind: "worker_exit",
				recoverable: false,
				now: 6,
			});
			await second.recordAgentSessionKernelState(cancelFirst.parentSessionId, 0, {
				activationId: cancelFirst.parentFence.parentActivationId,
				state: "shutdown",
				now: 7,
			});
			const cancelFirstSession = await first.readAgentSession(cancelFirst.parentSessionId);
			assert.equal(cancelFirstSession?.lifecycle_state, "closed");
			assert.equal(cancelFirstSession?.status, "cancelled");
			const cancelFirstLifecycleEvents = (await first.listAgentSessionEvents(cancelFirst.parentSessionId)).filter(
				(event) => event.type === "session.closed" || event.type === "session.faulted",
			);
			assert.deepEqual(
				cancelFirstLifecycleEvents.map((event) => event.type),
				["session.closed"],
			);

			const faultFirst = await seedParent(first, "fault-first-cancel", "prime");
			await bindKernelBody(first, faultFirst.parentSessionId, 0, faultFirst.parentFence.parentActivationId, 14);
			await first.finishAgentMaterialization(faultFirst.parentSessionId, 0, {
				activationId: faultFirst.parentFence.parentActivationId,
				from: "running",
				to: "faulted",
				faultKind: "worker_exit",
				recoverable: false,
				now: 15,
			});
			await assert.rejects(
				second.requestAgentSessionCancellation(faultFirst.parentSessionId, {
					requestId: "cancel-after-worker-fault",
					actor: { kind: "owner_api", ownerUserId: "cognito-ada" },
					reason: "too late",
					now: 16,
				}),
				(error: unknown) => error instanceof AgentSessionChildRunFault && error.reason === "terminal_conflict",
			);
			await first.recordAgentSessionKernelState(faultFirst.parentSessionId, 0, {
				activationId: faultFirst.parentFence.parentActivationId,
				state: "shutdown",
				now: 17,
			});
			const faultFirstSession = await second.readAgentSession(faultFirst.parentSessionId);
			assert.equal(faultFirstSession?.lifecycle_state, "faulted");
			assert.equal(faultFirstSession?.status, "failed");
			const faultFirstLifecycleEvents = (await second.listAgentSessionEvents(faultFirst.parentSessionId)).filter(
				(event) => event.type === "session.closed" || event.type === "session.faulted",
			);
			assert.deepEqual(
				faultFirstLifecycleEvents.map((event) => event.type),
				["session.faulted"],
			);
		});
	});

	it("closes an admitted irrecoverably faulted child only after its descendant and reconciles allocation bottom-up", async () => {
		await withTwoStores(async (first, second) => {
			const parent = await seedParent(first, "fault-tree-parent", "prime");
			const child = await admitChild(first, parent, "fault-tree-child", 10);
			const childClaim = await first.claimAgentSessionChildRun(child.run.child_run_id, {
				consumer: "fault-tree-worker",
				leaseMs: 100,
				now: 20,
			});
			const childActivation = "act-fault-tree-child";
			await first.claimAgentSessionChildMaterialization(child.run.child_run_id, {
				consumer: childClaim.run.consumer!,
				claimToken: childClaim.run.claim_token!,
				generation: 0,
				activationId: childActivation,
				now: 21,
			});
			await first.bindAgentSandbox(child.child.session_id, {
				generation: 0,
				activationId: childActivation,
				sandboxId: "sbx-fault-tree-child",
				childRunConsumer: childClaim.run.consumer!,
				childRunClaimToken: childClaim.run.claim_token!,
				now: 22,
			});
			await bindKernelBody(first, child.child.session_id, 0, childActivation, 23);

			const descendant = await seedParent(first, "fault-tree-descendant", "prime");
			await bindKernelBody(first, descendant.parentSessionId, 0, descendant.parentFence.parentActivationId, 24);
			await first.registerAgentSessionChild(child.child.session_id, descendant.parentSessionId, {
				causationId: "fault-tree-edge",
				now: 25,
			});

			await first.finishAgentMaterialization(child.child.session_id, 0, {
				activationId: childActivation,
				from: "running",
				to: "faulted",
				faultKind: "worker_exit",
				recoverable: false,
				now: 26,
			});
			await first.recordAgentSessionKernelState(child.child.session_id, 0, {
				activationId: childActivation,
				state: "shutdown",
				now: 27,
			});
			assert.equal((await first.readAgentSession(child.child.session_id))?.lifecycle_state, "closing");
			assert.equal(
				(await first.readAgentSessionChildBudgetAllocation(child.allocation.allocation_id))?.state,
				"reserved",
			);

			const descendantRecovery = await second.claimAgentMaterializationRecovery({
				consumer: "fault-tree-supervisor",
				leaseMs: 30,
				staleBefore: 30,
				now: 30,
			});
			assert.equal(descendantRecovery?.materialization.session_id, descendant.parentSessionId);
			await second.finishRecoveredAgentMaterialization(descendant.parentSessionId, 0, {
				consumer: descendantRecovery!.recovery_consumer,
				recoveryToken: descendantRecovery!.recovery_token,
				to: "cancelled",
				now: 31,
			});
			await second.recordRecoveredAgentSessionKernelState(descendant.parentSessionId, 0, {
				consumer: descendantRecovery!.recovery_consumer,
				recoveryToken: descendantRecovery!.recovery_token,
				state: "cancelled",
				now: 32,
			});
			assert.equal((await first.readAgentSession(descendant.parentSessionId))?.lifecycle_state, "closed");

			const settled = await first.settleAgentSessionChildRun(child.run.child_run_id, {
				consumer: childClaim.run.consumer!,
				claimToken: childClaim.run.claim_token!,
				status: "failed",
				terminalPolicy: "close",
				materializationGeneration: 0,
				materializationState: "faulted",
				error: "materialization fault: worker_exit",
				now: 33,
			});
			assert.equal(settled.run.state, "failed");
			assert.equal(settled.allocation.state, "settled");
			assert.equal((await second.readAgentSession(child.child.session_id))?.lifecycle_state, "closed");
			const childEvents = await second.listAgentSessionEvents(child.child.session_id);
			assert.equal(childEvents.filter((event) => event.type === "runtime.fault").length, 1);
			assert.equal(childEvents.filter((event) => event.type === "session.closed").length, 1);
			assert.equal(childEvents.filter((event) => event.type === "session.faulted").length, 0);
			const cascade = await first.raw(
				"SELECT state FROM agent_session_descendant_cascades WHERE root_session_id = ?",
				[child.child.session_id],
			);
			assert.equal(cascade.rows[0]?.state, "completed");
		});
	});

	it("settles a recovered Prime body crash as failed and closed without inventing Session corruption", async () => {
		await withTwoStores(async (first, second) => {
			const parent = await seedParent(first, "recovered-prime-body-crash", "prime");
			const child = await admitChild(first, parent, "recovered-prime-body-crash-child", 10);
			const claim = await first.claimAgentSessionChildRun(child.run.child_run_id, {
				consumer: "crashed-prime-worker",
				leaseMs: 100,
				now: 20,
			});
			const activationId = "act-recovered-prime-body-crash";
			await first.claimAgentSessionChildMaterialization(child.run.child_run_id, {
				consumer: claim.run.consumer!,
				claimToken: claim.run.claim_token!,
				generation: 0,
				activationId,
				now: 21,
			});
			await first.bindAgentSandbox(child.child.session_id, {
				generation: 0,
				activationId,
				sandboxId: "sbx-recovered-prime-body-crash",
				childRunConsumer: claim.run.consumer!,
				childRunClaimToken: claim.run.claim_token!,
				now: 22,
			});
			await first.finishAgentMaterialization(child.child.session_id, 0, {
				activationId,
				from: "running",
				to: "faulted",
				faultKind: "worker_exit",
				recoverable: false,
				now: 24,
			});
			await first.heartbeatAgentMaterialization(parent.parentSessionId, 0, {
				activationId: parent.parentFence.parentActivationId,
				now: 121,
			});
			const recovery = await second.claimAgentMaterializationRecovery({
				consumer: "crashed-prime-recovery",
				leaseMs: 100,
				staleBefore: 120,
				now: 121,
			});
			assert.equal(recovery?.materialization.session_id, child.child.session_id);
			assert.equal(recovery?.kernel_state, null, "a kernel wrapper that never spawned has no body row");
			assert.equal(recovery?.kernel_launch_state, "not_requested");
			const settled = await second.settleRecoveredAgentSessionChildRun(child.run.child_run_id, {
				sessionId: child.child.session_id,
				generation: 0,
				consumer: recovery!.recovery_consumer,
				recoveryToken: recovery!.recovery_token,
				status: "failed",
				now: 122,
			});
			assert.equal(settled.run.state, "failed");
			assert.equal(settled.allocation.state, "settled");
			const recoveredSession = await first.readAgentSession(child.child.session_id);
			assert.equal(recoveredSession?.status, "failed");
			assert.equal(recoveredSession?.lifecycle_state, "closed");
			const events = await first.listAgentSessionEvents(child.child.session_id);
			assert.equal(events.filter((event) => event.type === "runtime.fault").length, 1);
			assert.equal(events.filter((event) => event.type === "session.closed").length, 1);
			assert.equal(events.filter((event) => event.type === "session.faulted").length, 0);
			const recoveredFailedEvent = (await first.listAgentSessionEvents(parent.parentSessionId)).find(
				(event) => event.type === "child.run.failed",
			);
			assert.deepEqual(recoveredFailedEvent?.payload, {
				schema: "choreograph.agent-session-child-run-result.v1",
				childRunId: child.run.child_run_id,
				admissionId: child.admission.admission_id,
				parentSessionId: parent.parentSessionId,
				childSessionId: child.child.session_id,
				childName: child.admission.child_name,
				status: "failed",
				terminalPolicy: "close",
				budgetAllocationId: child.allocation.allocation_id,
				materialization: { generation: 0, state: "faulted" },
				result: null,
				error: "materialization fault: worker_exit",
				recovered: true,
			});
			const kernelBodies = await first.raw(
				"SELECT state FROM agent_session_body_states WHERE session_id = ? AND generation = 0 AND role = 'kernel'",
				[child.child.session_id],
			);
			assert.equal(kernelBodies.rows.length, 0, "recovery cannot synthesize a kernel body that never existed");
			const cascade = await first.raw(
				"SELECT state FROM agent_session_descendant_cascades WHERE root_session_id = ?",
				[child.child.session_id],
			);
			assert.equal(cascade.rows[0]?.state, "completed");
		});
	});

	it("preserves outcome-first and body-fault-first truth when cancellation races terminal closure", async () => {
		await withTwoStores(async (first, second) => {
			const parent = await seedParent(first, "terminal-precedence");
			const actor = {
				kind: "parent_materialization" as const,
				parentSessionId: parent.parentSessionId,
				generation: parent.parentFence.parentGeneration,
				activationId: parent.parentFence.parentActivationId,
				sandboxId: parent.parentFence.parentSandboxId,
			};

			const outcomeFirst = await admitChild(first, parent, "outcome-first", 10);
			const outcomeClaim = await first.claimAgentSessionChildRun(outcomeFirst.run.child_run_id, {
				consumer: "outcome-worker",
				leaseMs: 100,
				now: 20,
			});
			const outcomeActivation = "act-outcome-first";
			await first.claimAgentSessionChildMaterialization(outcomeFirst.run.child_run_id, {
				consumer: outcomeClaim.run.consumer!,
				claimToken: outcomeClaim.run.claim_token!,
				generation: 0,
				activationId: outcomeActivation,
				now: 21,
			});
			await first.bindAgentSandbox(outcomeFirst.child.session_id, {
				generation: 0,
				activationId: outcomeActivation,
				sandboxId: "sbx-outcome-first",
				childRunConsumer: outcomeClaim.run.consumer!,
				childRunClaimToken: outcomeClaim.run.claim_token!,
				now: 22,
			});
			const completedResult = childResult(outcomeFirst, "outcome won", 20, 21, 2);
			await first.finishAgentSession(outcomeFirst.child.session_id, {
				result: completedResult,
				status: "completed",
				generation: 0,
				activationId: outcomeActivation,
				childRunConsumer: outcomeClaim.run.consumer!,
				childRunClaimToken: outcomeClaim.run.claim_token!,
				now: 23,
				frontier: {
					kind: "after-node",
					nodeKey: outcomeFirst.spec.nodeKey!,
					sessionId: outcomeFirst.child.session_id,
					label: outcomeFirst.spec.label,
					phaseIndex: outcomeFirst.spec.phaseIndex,
					ts: 23,
				},
			});
			const lateCancel = await second.requestAgentSessionChildCancellation(outcomeFirst.run.child_run_id, {
				requestId: "cancel-after-outcome",
				actor,
				reason: "outcome already won",
				now: 24,
			});
			assert.equal(lateCancel.request.disposition, "terminal_preceded");
			assert.equal(lateCancel.run.state, "claimed");
			await first.finishAgentMaterialization(outcomeFirst.child.session_id, 0, {
				activationId: outcomeActivation,
				from: "running",
				to: "completed",
				now: 25,
			});
			const outcomeSettlement = await first.settleAgentSessionChildRun(outcomeFirst.run.child_run_id, {
				consumer: outcomeClaim.run.consumer!,
				claimToken: outcomeClaim.run.claim_token!,
				status: "completed",
				terminalPolicy: "close",
				materializationGeneration: 0,
				materializationState: "completed",
				result: completedResult,
				now: 26,
			});
			assert.equal(outcomeSettlement.run.state, "completed");
			assert.equal((await second.readAgentSession(outcomeFirst.child.session_id))?.lifecycle_state, "closed");
			const completedEvent = (await second.listAgentSessionEvents(parent.parentSessionId)).find(
				(event) =>
					event.type === "child.run.completed" &&
					(event.payload as { childRunId?: unknown }).childRunId === outcomeFirst.run.child_run_id,
			);
			assert.deepEqual(completedEvent?.payload, {
				schema: "choreograph.agent-session-child-run-result.v1",
				childRunId: outcomeFirst.run.child_run_id,
				admissionId: outcomeFirst.admission.admission_id,
				parentSessionId: parent.parentSessionId,
				childSessionId: outcomeFirst.child.session_id,
				childName: outcomeFirst.admission.child_name,
				status: "completed",
				terminalPolicy: "close",
				budgetAllocationId: outcomeFirst.allocation.allocation_id,
				materialization: { generation: 0, state: "completed" },
				result: completedResult,
				error: null,
				recovered: false,
			});

			const bodyFirst = await admitChild(first, parent, "body-first", 30);
			const bodyClaim = await first.claimAgentSessionChildRun(bodyFirst.run.child_run_id, {
				consumer: "body-worker",
				leaseMs: 100,
				now: 31,
			});
			const bodyActivation = "act-body-first";
			await first.claimAgentSessionChildMaterialization(bodyFirst.run.child_run_id, {
				consumer: bodyClaim.run.consumer!,
				claimToken: bodyClaim.run.claim_token!,
				generation: 0,
				activationId: bodyActivation,
				now: 32,
			});
			await first.bindAgentSandbox(bodyFirst.child.session_id, {
				generation: 0,
				activationId: bodyActivation,
				sandboxId: "sbx-body-first",
				childRunConsumer: bodyClaim.run.consumer!,
				childRunClaimToken: bodyClaim.run.claim_token!,
				now: 33,
			});
			await first.finishAgentMaterialization(bodyFirst.child.session_id, 0, {
				activationId: bodyActivation,
				from: "running",
				to: "faulted",
				faultKind: "worker_exit",
				recoverable: false,
				now: 34,
			});
			const bodyLateCancel = await second.requestAgentSessionChildCancellation(bodyFirst.run.child_run_id, {
				requestId: "cancel-after-body-fault",
				actor,
				reason: "body already terminated",
				now: 35,
			});
			assert.equal(bodyLateCancel.request.disposition, "terminal_preceded");
			assert.equal(bodyLateCancel.run.state, "claimed");
			const bodySettlement = await first.settleAgentSessionChildRun(bodyFirst.run.child_run_id, {
				consumer: bodyClaim.run.consumer!,
				claimToken: bodyClaim.run.claim_token!,
				status: "failed",
				terminalPolicy: "close",
				materializationGeneration: 0,
				materializationState: "faulted",
				error: "materialization fault: worker_exit",
				now: 36,
			});
			assert.equal(bodySettlement.run.state, "failed");
			assert.equal((await second.readAgentSession(bodyFirst.child.session_id))?.lifecycle_state, "closed");
		});
	});

	it("recovers completed and failed logical outcomes without inventing a body fault before exact closure", async () => {
		for (const logicalStatus of ["completed", "failed"] as const) {
			await withTwoStores(async (first, second) => {
				const parent = await seedParent(first, `outcome-crash-${logicalStatus}`, "prime");
				const child = await admitChild(first, parent, `outcome-crash-${logicalStatus}`, 10);
				const claim = await first.claimAgentSessionChildRun(child.run.child_run_id, {
					consumer: `executor-${logicalStatus}`,
					leaseMs: 100,
					now: 20,
				});
				const activationId = `activation-${logicalStatus}`;
				await first.claimAgentSessionChildMaterialization(child.run.child_run_id, {
					consumer: claim.run.consumer!,
					claimToken: claim.run.claim_token!,
					generation: 0,
					activationId,
					now: 21,
				});
				await first.bindAgentSandbox(child.child.session_id, {
					generation: 0,
					activationId,
					sandboxId: `sandbox-${logicalStatus}`,
					childRunConsumer: claim.run.consumer!,
					childRunClaimToken: claim.run.claim_token!,
					now: 22,
				});
				await bindKernelBody(first, child.child.session_id, 0, activationId, 22);
				const baseResult = childResult(child, `${logicalStatus} outcome`, 20, 21, 2);
				const result =
					logicalStatus === "failed"
						? { ...baseResult, state: "error" as const, output: "logical failure" }
						: baseResult;
				await first.finishAgentSession(child.child.session_id, {
					result,
					status: logicalStatus,
					generation: 0,
					activationId,
					childRunConsumer: claim.run.consumer!,
					childRunClaimToken: claim.run.claim_token!,
					now: 23,
					frontier: {
						kind: "after-node",
						nodeKey: child.spec.nodeKey!,
						sessionId: child.child.session_id,
						label: child.spec.label,
						phaseIndex: child.spec.phaseIndex,
						ts: 23,
					},
				});
				const deletion = await second.requestAgentSessionChildCancellation(child.run.child_run_id, {
					requestId: `delete-${logicalStatus}-outcome-crash`,
					actor: {
						kind: "parent_materialization",
						parentSessionId: parent.parentSessionId,
						generation: parent.parentFence.parentGeneration,
						activationId: parent.parentFence.parentActivationId,
						sandboxId: parent.parentFence.parentSandboxId,
					},
					reason: "delete after durable logical outcome",
					now: 24,
				});
				assert.equal(deletion.request.disposition, "terminal_preceded");
				assert.equal(deletion.run.state, "claimed");
				await first.heartbeatAgentMaterialization(child.child.session_id, 0, {
					activationId,
					now: 29,
				});
				await first.heartbeatAgentMaterialization(parent.parentSessionId, 0, {
					activationId: parent.parentFence.parentActivationId,
					now: 29,
				});
				assert.equal(
					await second.claimAgentMaterializationRecovery({
						consumer: `premature-recovery-${logicalStatus}`,
						leaseMs: 200,
						staleBefore: 28,
						now: 30,
					}),
					null,
					"a closing cascade must not steal a freshly heartbeating executor",
				);
				await first.heartbeatAgentMaterialization(parent.parentSessionId, 0, {
					activationId: parent.parentFence.parentActivationId,
					now: 31,
				});
				assert.equal(
					await second.claimAgentMaterializationRecovery({
						consumer: `lease-live-recovery-${logicalStatus}`,
						leaseMs: 200,
						staleBefore: 29,
						now: 31,
					}),
					null,
					"stale child body recovery must still wait for its live run lease",
				);
				await first.heartbeatAgentMaterialization(parent.parentSessionId, 0, {
					activationId: parent.parentFence.parentActivationId,
					now: 121,
				});
				const recovery = await second.claimAgentMaterializationRecovery({
					consumer: `recovery-${logicalStatus}`,
					leaseMs: 200,
					staleBefore: 120,
					now: 121,
				});
				assert.equal(recovery?.materialization.session_id, child.child.session_id);
				assert.equal(recovery?.durable_outcome_status, logicalStatus);
				const recovered = await second.finishRecoveredAgentMaterialization(child.child.session_id, 0, {
					consumer: recovery!.recovery_consumer,
					recoveryToken: recovery!.recovery_token,
					to: "completed",
					now: 122,
				});
				assert.equal(recovered.materialization.state, "completed");
				await second.recordRecoveredAgentSessionKernelState(child.child.session_id, 0, {
					consumer: recovery!.recovery_consumer,
					recoveryToken: recovery!.recovery_token,
					state: "shutdown",
					now: 123,
				});
				const settlement = await first.settleRecoveredAgentSessionChildRun(child.run.child_run_id, {
					sessionId: child.child.session_id,
					generation: 0,
					consumer: recovery!.recovery_consumer,
					recoveryToken: recovery!.recovery_token,
					status: logicalStatus,
					now: 124,
				});
				assert.equal(settlement.run.state, logicalStatus);
				const recoveredEvent = (await first.listAgentSessionEvents(parent.parentSessionId)).find(
					(event) =>
						event.type === `child.run.${logicalStatus}` &&
						(event.payload as { childRunId?: unknown }).childRunId === child.run.child_run_id,
				);
				assert.deepEqual(recoveredEvent?.payload, {
					schema: "choreograph.agent-session-child-run-result.v1",
					childRunId: child.run.child_run_id,
					admissionId: child.admission.admission_id,
					parentSessionId: parent.parentSessionId,
					childSessionId: child.child.session_id,
					childName: child.admission.child_name,
					status: logicalStatus,
					terminalPolicy: "keep_open",
					budgetAllocationId: child.allocation.allocation_id,
					materialization: { generation: 0, state: "completed" },
					result,
					error: logicalStatus === "failed" ? "child execution failed" : null,
					recovered: true,
				});
				const closure = await second.requestAgentSessionChildClosure(child.run.child_run_id, {
					requestId: `close-${logicalStatus}-outcome-crash`,
					actor: {
						kind: "parent_materialization",
						parentSessionId: parent.parentSessionId,
						generation: parent.parentFence.parentGeneration,
						activationId: parent.parentFence.parentActivationId,
						sandboxId: parent.parentFence.parentSandboxId,
					},
					reason: "close recovered terminal resident",
					now: 125,
				});
				const cleanup = await first.claimAgentSessionChildClosureWork({
					consumer: `cleanup-${logicalStatus}`,
					leaseMs: 30,
					now: 126,
				});
				assert.equal(cleanup?.request.closure_id, closure.request.closure_id);
				const receipt = await first.finalizeAgentSessionChildClosure(child.run.child_run_id, {
					consumer: cleanup!.consumer,
					cleanupToken: cleanup!.cleanup_token,
					materializationGeneration: 0,
					materializationState: "completed",
					now: 127,
				});
				assert.equal(receipt.applied, true);
				const replay = await second.finalizeAgentSessionChildClosure(child.run.child_run_id, {
					consumer: cleanup!.consumer,
					cleanupToken: cleanup!.cleanup_token,
					materializationGeneration: 0,
					materializationState: "completed",
					now: 127,
				});
				assert.equal(replay.applied, false);
				assert.equal(replay.receipt?.closure_id, receipt.receipt?.closure_id);
				const events = await first.listAgentSessionEvents(child.child.session_id);
				assert.equal(events.filter((event) => event.type === "runtime.fault").length, 0);
				assert.equal(events.filter((event) => event.type === "session.faulted").length, 0);
				assert.equal(events.filter((event) => event.type === "session.closed").length, 1);
			});
		}
	});

	it("preserves a cancellation winner when the Prime worker and kernel fault during teardown", async () => {
		await withTwoStores(async (first, second) => {
			const parent = await seedParent(first, "cancel-then-fault", "prime");
			const child = await admitChild(first, parent, "cancel-then-fault-child", 10);
			const claim = await first.claimAgentSessionChildRun(child.run.child_run_id, {
				consumer: "cancel-fault-worker",
				leaseMs: 100,
				now: 20,
			});
			const activationId = "act-cancel-then-fault";
			await first.claimAgentSessionChildMaterialization(child.run.child_run_id, {
				consumer: claim.run.consumer!,
				claimToken: claim.run.claim_token!,
				generation: 0,
				activationId,
				now: 21,
			});
			await first.bindAgentSandbox(child.child.session_id, {
				generation: 0,
				activationId,
				sandboxId: "sbx-cancel-then-fault",
				childRunConsumer: claim.run.consumer!,
				childRunClaimToken: claim.run.claim_token!,
				now: 22,
			});
			await bindKernelBody(first, child.child.session_id, 0, activationId, 23);
			const reason = "operator cancellation won before teardown fault";
			const cancellation = await second.requestAgentSessionChildCancellation(child.run.child_run_id, {
				requestId: "cancel-before-teardown-fault",
				actor: {
					kind: "parent_materialization",
					parentSessionId: parent.parentSessionId,
					generation: parent.parentFence.parentGeneration,
					activationId: parent.parentFence.parentActivationId,
					sandboxId: parent.parentFence.parentSandboxId,
				},
				reason,
				now: 24,
			});
			assert.equal(cancellation.request.disposition, "cancellation_pending");
			assert.equal(cancellation.run.state, "cancelling");
			await first.finishAgentMaterialization(child.child.session_id, 0, {
				activationId,
				from: "running",
				to: "faulted",
				faultKind: "worker_exit",
				recoverable: false,
				now: 25,
			});
			await first.recordAgentSessionKernelState(child.child.session_id, 0, {
				activationId,
				state: "faulted",
				now: 26,
			});
			const settled = await first.settleAgentSessionChildRun(child.run.child_run_id, {
				consumer: claim.run.consumer!,
				claimToken: claim.run.claim_token!,
				status: "cancelled",
				terminalPolicy: "close",
				materializationGeneration: 0,
				materializationState: "faulted",
				error: reason,
				now: 27,
			});
			assert.equal(settled.run.state, "cancelled");
			assert.equal(settled.allocation.state, "settled");
			assert.equal((await second.readAgentSession(child.child.session_id))?.lifecycle_state, "closed");
			const lifecycleEvents = (await second.listAgentSessionEvents(child.child.session_id)).filter(
				(event) => event.type === "session.closed" || event.type === "session.faulted",
			);
			assert.deepEqual(
				lifecycleEvents.map((event) => event.type),
				["session.closed"],
			);
		});
	});

	it("retains resident Prime closure intent when immutable outcome precedes delete", async () => {
		await withTwoStores(async (first, second) => {
			const parent = await seedParent(first, "resident-outcome-delete", "prime");
			const child = await admitChild(first, parent, "resident-outcome-delete-child", 10);
			const claim = await first.claimAgentSessionChildRun(child.run.child_run_id, {
				consumer: "resident-outcome-worker",
				leaseMs: 100,
				now: 20,
			});
			const activationId = "act-resident-outcome-delete";
			await first.claimAgentSessionChildMaterialization(child.run.child_run_id, {
				consumer: claim.run.consumer!,
				claimToken: claim.run.claim_token!,
				generation: 0,
				activationId,
				now: 21,
			});
			await first.bindAgentSandbox(child.child.session_id, {
				generation: 0,
				activationId,
				sandboxId: "sbx-resident-outcome-delete",
				childRunConsumer: claim.run.consumer!,
				childRunClaimToken: claim.run.claim_token!,
				now: 22,
			});
			await bindKernelBody(first, child.child.session_id, 0, activationId, 23);
			const result = childResult(child, "resident outcome won", 20, 21, 2);
			await first.finishAgentSession(child.child.session_id, {
				result,
				status: "completed",
				generation: 0,
				activationId,
				childRunConsumer: claim.run.consumer!,
				childRunClaimToken: claim.run.claim_token!,
				now: 24,
				frontier: {
					kind: "after-node",
					nodeKey: child.spec.nodeKey!,
					sessionId: child.child.session_id,
					label: child.spec.label,
					phaseIndex: child.spec.phaseIndex,
					ts: 24,
				},
			});
			const deletion = await second.requestAgentSessionChildCancellation(child.run.child_run_id, {
				requestId: "delete-after-resident-outcome",
				actor: {
					kind: "parent_materialization",
					parentSessionId: parent.parentSessionId,
					generation: parent.parentFence.parentGeneration,
					activationId: parent.parentFence.parentActivationId,
					sandboxId: parent.parentFence.parentSandboxId,
				},
				reason: "delete resident after its outcome",
				now: 25,
			});
			assert.equal(deletion.request.disposition, "terminal_preceded");
			const settled = await first.settleAgentSessionChildRun(child.run.child_run_id, {
				consumer: claim.run.consumer!,
				claimToken: claim.run.claim_token!,
				status: "completed",
				terminalPolicy: "keep_open",
				materializationGeneration: 0,
				materializationState: "running",
				result,
				now: 26,
			});
			assert.equal(settled.run.state, "completed");
			await second.requestAgentSessionChildClosure(child.run.child_run_id, {
				requestId: "close-after-resident-outcome",
				actor: {
					kind: "parent_materialization",
					parentSessionId: parent.parentSessionId,
					generation: parent.parentFence.parentGeneration,
					activationId: parent.parentFence.parentActivationId,
					sandboxId: parent.parentFence.parentSandboxId,
				},
				reason: "close resident after its outcome",
				now: 27,
			});
			assert.equal((await second.readAgentSession(child.child.session_id))?.lifecycle_state, "closing");
			assert.equal(
				await second.claimAgentSessionChildClosureWork({
					consumer: "resident-outcome-too-early",
					leaseMs: 30,
					now: 28,
				}),
				null,
			);
			await first.finishAgentMaterialization(child.child.session_id, 0, {
				activationId,
				from: "running",
				to: "cancelled",
				now: 29,
			});
			await first.recordAgentSessionKernelState(child.child.session_id, 0, {
				activationId,
				state: "cancelled",
				now: 30,
			});

			const cleanup = await second.claimAgentSessionChildClosureWork({
				consumer: "resident-outcome-cleanup",
				leaseMs: 30,
				now: 31,
			});
			assert.equal(cleanup?.run.child_run_id, child.run.child_run_id);
			await second.finishRecoveredAgentMaterialization(child.child.session_id, 0, {
				consumer: cleanup!.consumer,
				recoveryToken: cleanup!.cleanup_token,
				to: "cancelled",
				now: 32,
			});
			await second.recordRecoveredAgentSessionKernelState(child.child.session_id, 0, {
				consumer: cleanup!.consumer,
				recoveryToken: cleanup!.cleanup_token,
				state: "cancelled",
				now: 33,
			});
			const receipt = await second.finalizeAgentSessionChildClosure(child.run.child_run_id, {
				consumer: cleanup!.consumer,
				cleanupToken: cleanup!.cleanup_token,
				materializationGeneration: 0,
				materializationState: "cancelled",
				now: 34,
			});
			assert.equal(receipt.run.state, "completed");
			assert.equal(receipt.receipt?.session_state, "closed");
		});
	});

	it("defers queued child cancellation until its live descendant closes bottom-up", async () => {
		await withTwoStores(async (first, second) => {
			const parent = await seedParent(first, "queued-subtree-parent", "prime");
			const child = await admitChild(first, parent, "queued-subtree-child", 10);
			const grandchild = await seedParent(first, "queued-subtree-grandchild", "prime");
			await bindKernelBody(first, grandchild.parentSessionId, 0, grandchild.parentFence.parentActivationId, 11);
			await first.registerAgentSessionChild(child.child.session_id, grandchild.parentSessionId, {
				causationId: "queued-subtree-edge",
				now: 12,
			});
			const requested = await first.requestAgentSessionChildCancellation(child.run.child_run_id, {
				requestId: "cancel-queued-subtree",
				actor: {
					kind: "parent_materialization",
					parentSessionId: parent.parentSessionId,
					generation: parent.parentFence.parentGeneration,
					activationId: parent.parentFence.parentActivationId,
					sandboxId: parent.parentFence.parentSandboxId,
				},
				reason: "cancel subtree bottom-up",
				now: 13,
			});
			assert.equal(requested.applied, false);
			assert.equal(requested.request.disposition, "cancellation_pending");
			assert.equal(requested.run.state, "queued");
			assert.deepEqual(await second.listClaimableAgentSessionChildRuns({ now: 14 }), []);

			const cleanup = await second.claimAgentMaterializationRecovery({
				consumer: "queued-subtree-supervisor",
				leaseMs: 20,
				staleBefore: 15,
				now: 15,
			});
			assert.equal(cleanup?.materialization.session_id, grandchild.parentSessionId);
			await second.finishRecoveredAgentMaterialization(grandchild.parentSessionId, 0, {
				consumer: cleanup!.recovery_consumer,
				recoveryToken: cleanup!.recovery_token,
				to: "cancelled",
				now: 16,
			});
			await second.recordRecoveredAgentSessionKernelState(grandchild.parentSessionId, 0, {
				consumer: cleanup!.recovery_consumer,
				recoveryToken: cleanup!.recovery_token,
				state: "cancelled",
				now: 17,
			});
			assert.equal((await first.readAgentSession(grandchild.parentSessionId))?.lifecycle_state, "closed");
			assert.equal((await first.readAgentSessionChildRun(child.run.child_run_id))?.state, "cancelled");
			assert.equal((await first.readAgentSession(child.child.session_id))?.lifecycle_state, "closed");
			assert.equal(
				(await first.readAgentSessionChildBudgetAllocation(child.allocation.allocation_id))?.state,
				"released",
			);
		});
	});

	it("cancels a materialized standalone simple Session without fabricating kernel testimony", async () => {
		await withTwoStores(async (first, second) => {
			const simple = await seedParent(first, "standalone-simple-cancel", "simple", true, "simple");
			const fakeCell = {
				schema: "choreograph.compute-cell.v1" as const,
				cellRef: "compute.cell:standalone-simple:0",
				sessionId: simple.parentSessionId,
				leaseId: "forbidden-kernel-lease",
				kernelSandboxId: "forbidden-kernel-sandbox",
				inputId: "forbidden-input",
				ordinal: 0,
				generation: 0,
				code: "1 + 1",
				status: "ok" as const,
				executionCount: 1,
				outputs: [],
				startedAt: 4,
				completedAt: 5,
				durationMs: 1,
				hostRequests: [],
				cellDigest: `sha256:${"e".repeat(64)}`,
			};
			await assert.rejects(
				first.appendExecutionCell(simple.parentSessionId, simple.parentFence.parentActivationId, fakeCell),
				/persistent Prime/i,
			);
			await first.requestAgentSessionCancellation(simple.parentSessionId, {
				requestId: "cancel-materialized-simple",
				actor: { kind: "owner_api", ownerUserId: "cognito-ada" },
				reason: "stop one-shot Session",
				now: 6,
			});
			await first.finishAgentMaterialization(simple.parentSessionId, 0, {
				activationId: simple.parentFence.parentActivationId,
				from: "running",
				to: "cancelled",
				now: 7,
			});
			assert.equal((await second.readAgentSession(simple.parentSessionId))?.lifecycle_state, "closed");
			assert.equal((await second.readAgentSession(simple.parentSessionId))?.status, "cancelled");

			const faultDuringCancel = await seedParent(first, "standalone-simple-cancel-fault", "simple", true, "simple");
			await first.requestAgentSessionCancellation(faultDuringCancel.parentSessionId, {
				requestId: "cancel-before-simple-fault",
				actor: { kind: "owner_api", ownerUserId: "cognito-ada" },
				reason: "cancel wins before exit fault",
				now: 16,
			});
			await first.finishAgentMaterialization(faultDuringCancel.parentSessionId, 0, {
				activationId: faultDuringCancel.parentFence.parentActivationId,
				from: "running",
				to: "faulted",
				faultKind: "worker_exit",
				recoverable: false,
				now: 17,
			});
			assert.equal((await second.readAgentSession(faultDuringCancel.parentSessionId))?.lifecycle_state, "closed");
			const lifecycle = (await second.listAgentSessionEvents(faultDuringCancel.parentSessionId)).filter(
				(event) => event.type === "session.closed" || event.type === "session.faulted",
			);
			assert.deepEqual(
				lifecycle.map((event) => event.type),
				["session.closed"],
			);
		});
	});

	it("rejects malformed cascade authority pairs and backdated allocation or occupancy testimony in SQLite", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-f5-schema-"));
		const path = join(directory, "runtime.sqlite");
		const store = new InspectableWorkflowRuntimeStore(path);
		try {
			await store.init();
			const faultRoot = await seedParent(store, "schema-fault-root", "prime");
			await store.finishAgentMaterialization(faultRoot.parentSessionId, 0, {
				activationId: faultRoot.parentFence.parentActivationId,
				from: "running",
				to: "faulted",
				faultKind: "worker_exit",
				recoverable: false,
				now: 10,
			});
			const unrelated = await seedParent(store, "schema-unrelated", "simple", false, "simple");
			for (const invalidGraphOwner of [
				"",
				"user:",
				"user:bad/name",
				"user:bad name",
				"user:bad\u00a0name",
				"user:ada\0/evil",
				`user:${"a".repeat(193)}`,
				"team:ada",
			]) {
				await assert.rejects(
					store.raw("UPDATE agent_sessions SET graph_owner_principal = ? WHERE session_id = ?", [
						invalidGraphOwner,
						unrelated.parentSessionId,
					]),
					/CHECK constraint/i,
				);
			}
			for (const validGraphOwner of [
				"user:ada",
				"agent:prime-1",
				"service:choreograph@cloud-2",
				"organization:sophia_labs",
			]) {
				await store.raw("UPDATE agent_sessions SET graph_owner_principal = ? WHERE session_id = ?", [
					validGraphOwner,
					unrelated.parentSessionId,
				]);
				assert.equal(
					(await store.readAgentSession(unrelated.parentSessionId))?.graph_owner_principal,
					validGraphOwner,
				);
			}
			const cascadeRows = await store.raw(
				"SELECT cascade_id, cause_digest FROM agent_session_descendant_cascades WHERE root_session_id = ?",
				[faultRoot.parentSessionId],
			);
			const cascadeId = String(cascadeRows.rows[0]!.cascade_id);
			const causeDigest = String(cascadeRows.rows[0]!.cause_digest);
			await assert.rejects(
				store.raw(
					`INSERT INTO agent_session_admission_fences (session_id, cascade_id, cause_digest, closed_at)
					 VALUES (?, ?, ?, ?)`,
					[unrelated.parentSessionId, cascadeId, causeDigest, 11],
				),
				/FOREIGN KEY/i,
			);
			await assert.rejects(
				store.raw(
					`INSERT INTO agent_session_cancellation_requests
					 (session_id, request_id, request_digest, actor_json, reason, cascade_id, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					[unrelated.parentSessionId, "bad-pair", "digest", "{}", "bad pair", cascadeId, 11],
				),
				/FOREIGN KEY/i,
			);
			await assert.rejects(
				store.raw(
					`INSERT INTO agent_session_descendant_cascade_members
					 (cascade_id, session_id, child_run_id, depth, action, created_at)
					 VALUES (?, ?, NULL, 0, 'none', ?)`,
					[cascadeId, unrelated.parentSessionId, 11],
				),
				/CHECK constraint/i,
			);

			const admitted = await admitChild(store, faultRoot, "schema-time-child", 12).catch(async () => {
				const healthyParent = await seedParent(store, "schema-time-parent", "prime");
				return admitChild(store, healthyParent, "schema-time-child", 12);
			});
			await assert.rejects(
				store.raw(
					`UPDATE agent_session_child_budget_allocations
					 SET state = 'accounting_hold', hold_reason = 'unresolved_child_reservations', held_at = created_at - 1
					 WHERE allocation_id = ?`,
					[admitted.allocation.allocation_id],
				),
				/CHECK constraint/i,
			);
			await assert.rejects(
				store.raw(
					`UPDATE agent_session_child_generation_occupancy
					 SET state = 'released', released_at = acquired_at - 1
					 WHERE child_session_id = ? AND generation = 0`,
					[admitted.child.session_id],
				),
				/CHECK constraint/i,
			);
		} finally {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("reapplies foreign-key and check enforcement after an actual cross-store writer reconnect", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-f5-reconnect-"));
		const path = join(directory, "runtime.sqlite");
		const first = new InspectableWorkflowRuntimeStore(path);
		const second = new InspectableWorkflowRuntimeStore(path);
		let releaseWriter!: () => void;
		const release = new Promise<void>((resolve) => {
			releaseWriter = resolve;
		});
		let writerStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			writerStarted = resolve;
		});
		let releaseTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			// This case exercises writer reconnects, not concurrent schema migration.
			// Initialize once before opening the second connection, as withTwoStores does.
			await first.init();
			await second.init();
			const incumbent = first.holdWriter(writerStarted, release);
			await started;
			const contender = second.writerRaw(
				"UPDATE agent_session_family_projection_clock SET revision = revision WHERE singleton = 1",
			);
			releaseTimer = setTimeout(releaseWriter, 75);
			await Promise.all([incumbent, contender]);

			const foreignKeys = await second.raw("PRAGMA foreign_keys");
			assert.equal(Number(foreignKeys.rows[0]?.foreign_keys), 1);
			await assert.rejects(
				second.writerRaw(
					`INSERT INTO agent_session_family_projection_outbox
					 (root_session_id, work_kind, desired_revision, delivered_revision, delivered_projection_revision,
					  state, not_before, updated_at)
					 VALUES ('ags-missing', 'project', 1, 0, 0, 'pending', 0, 0)`,
				),
				/FOREIGN KEY/i,
			);
			await assert.rejects(
				second.writerRaw("INSERT INTO agent_session_family_projection_clock (singleton, revision) VALUES (2, 0)"),
				/CHECK constraint/i,
			);
		} finally {
			if (releaseTimer) clearTimeout(releaseTimer);
			releaseWriter();
			first.close();
			second.close();
		}

		const reopened = new InspectableWorkflowRuntimeStore(path);
		try {
			await reopened.init();
			assert.equal(Number((await reopened.raw("PRAGMA foreign_keys")).rows[0]?.foreign_keys), 1);
			await assert.rejects(
				reopened.writerRaw(
					`INSERT INTO agent_session_family_projection_outbox
					 (root_session_id, work_kind, desired_revision, delivered_revision, delivered_projection_revision,
					  state, not_before, updated_at)
					 VALUES ('ags-still-missing', 'project', 1, 0, 0, 'pending', 0, 0)`,
				),
				/FOREIGN KEY/i,
			);
		} finally {
			reopened.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("fences normal passivated generations from journal writes after regrow while preserving terminal replay", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-f5-regrow-fence-"));
		const path = join(directory, "runtime.sqlite");
		const store = new InspectableWorkflowRuntimeStore(path);
		try {
			await store.init();
			const root = await seedParent(store, "regrow-fence", "prime");
			const activation0 = root.parentFence.parentActivationId;
			await bindKernelBody(store, root.parentSessionId, 0, activation0, 4);
			const cell0 = testCell(root.parentSessionId, 0, "regrow-fence-0", 5);
			await store.appendExecutionCell(root.parentSessionId, activation0, cell0);
			const witness0 = {
				sessionId: root.parentSessionId,
				generation: 0,
				journalHeadDigest: cell0.cellDigest,
				namespace: ["generation_zero"],
				createdAt: 6,
			};
			await store.commitKernelReplayWitness(witness0, activation0);
			await commitRootCheckpoint(store, root, 0, root.parentFence.parentSandboxId, 7);
			await store.transitionAgentMaterialization(root.parentSessionId, 0, {
				activationId: activation0,
				from: "running",
				to: "passivated",
				now: 8,
			});
			await store.recordAgentSessionKernelState(root.parentSessionId, 0, {
				activationId: activation0,
				state: "released",
				now: 9,
			});
			assert.equal(
				(
					await store.transitionAgentMaterialization(root.parentSessionId, 0, {
						activationId: activation0,
						from: "running",
						to: "passivated",
						now: 10,
					})
				).state,
				"passivated",
				"exact terminal materialization replay remains idempotent",
			);

			const activation1 = "act-f5-regrow-generation-1";
			await store.claimAgentMaterialization(root.parentSessionId, {
				generation: 1,
				activationId: activation1,
				now: 11,
			});
			await store.bindAgentSandbox(root.parentSessionId, {
				generation: 1,
				activationId: activation1,
				sandboxId: "sbx-f5-regrow-generation-1",
				now: 12,
			});
			const cell1 = testCell(root.parentSessionId, 1, "regrow-fence-1", 13);
			await store.appendExecutionCell(root.parentSessionId, activation1, cell1);
			await store.commitKernelReplayWitness(
				{
					sessionId: root.parentSessionId,
					generation: 1,
					journalHeadDigest: cell1.cellDigest,
					namespace: ["generation_one"],
					createdAt: 14,
				},
				activation1,
			);
			await assert.rejects(
				store.appendExecutionCell(root.parentSessionId, activation0, cell0),
				/error|latest|live|lease/i,
			);
			await assert.rejects(store.commitKernelReplayWitness(witness0, activation0), /error|latest|live|lease/i);
			await store.raw("DELETE FROM kernel_replay_witnesses WHERE session_id = ? AND generation = 0", [
				root.parentSessionId,
			]);
			await assert.rejects(store.commitKernelReplayWitness(witness0, activation0), /error|latest|live|lease/i);
		} finally {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("binds a quiet regrown generation to the inherited global journal head", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-f5-inherited-journal-head-"));
		const path = join(directory, "runtime.sqlite");
		const store = new InspectableWorkflowRuntimeStore(path);
		try {
			await store.init();
			const root = await seedParent(store, "inherited-journal-head", "prime");
			const activation0 = root.parentFence.parentActivationId;
			await bindKernelBody(store, root.parentSessionId, 0, activation0, 4);
			const cell0 = testCell(root.parentSessionId, 0, "inherited-journal-head-0", 5);
			await store.appendExecutionCell(root.parentSessionId, activation0, cell0);
			await store.commitKernelReplayWitness(
				{
					sessionId: root.parentSessionId,
					generation: 0,
					journalHeadDigest: cell0.cellDigest,
					namespace: ["generation_zero"],
					createdAt: 6,
				},
				activation0,
			);
			await commitRootCheckpoint(store, root, 0, root.parentFence.parentSandboxId, 7);
			await store.transitionAgentMaterialization(root.parentSessionId, 0, {
				activationId: activation0,
				from: "running",
				to: "passivated",
				now: 8,
			});
			await store.recordAgentSessionKernelState(root.parentSessionId, 0, {
				activationId: activation0,
				state: "released",
				now: 9,
			});

			const activation1 = "act-f5-inherited-journal-head-generation-1";
			await store.claimAgentMaterialization(root.parentSessionId, {
				generation: 1,
				activationId: activation1,
				now: 10,
			});
			await store.bindAgentSandbox(root.parentSessionId, {
				generation: 1,
				activationId: activation1,
				sandboxId: "sbx-f5-inherited-journal-head-generation-1",
				now: 11,
			});
			await bindKernelBody(store, root.parentSessionId, 1, activation1, 12);
			await assert.rejects(
				store.commitKernelReplayWitness(
					{
						sessionId: root.parentSessionId,
						generation: 1,
						journalHeadDigest: `sha256:${"d".repeat(64)}`,
						namespace: ["quiet_generation"],
						createdAt: 13,
					},
					activation1,
				),
				/committed journal head/i,
			);
			const witness1 = {
				sessionId: root.parentSessionId,
				generation: 1,
				journalHeadDigest: cell0.cellDigest,
				namespace: ["quiet_generation"],
				createdAt: 14,
			};
			await store.commitKernelReplayWitness(witness1, activation1);
			assert.deepEqual(await store.readLatestKernelReplayWitness(root.parentSessionId), witness1);

			await commitRootCheckpoint(store, root, 1, "sbx-f5-inherited-journal-head-generation-1", 15);
			await store.transitionAgentMaterialization(root.parentSessionId, 1, {
				activationId: activation1,
				from: "running",
				to: "passivated",
				now: 16,
			});
			await store.recordAgentSessionKernelState(root.parentSessionId, 1, {
				activationId: activation1,
				state: "released",
				now: 17,
			});

			const activation2 = "act-f5-inherited-journal-head-generation-2";
			await store.claimAgentMaterialization(root.parentSessionId, {
				generation: 2,
				activationId: activation2,
				now: 18,
			});
			await store.bindAgentSandbox(root.parentSessionId, {
				generation: 2,
				activationId: activation2,
				sandboxId: "sbx-f5-inherited-journal-head-generation-2",
				now: 19,
			});
			await bindKernelBody(store, root.parentSessionId, 2, activation2, 20);
			const cell2 = testCell(root.parentSessionId, 2, "inherited-journal-head-2", 21);
			await store.appendExecutionCell(root.parentSessionId, activation2, cell2);
			await store.commitKernelReplayWitness(
				{
					sessionId: root.parentSessionId,
					generation: 2,
					journalHeadDigest: cell2.cellDigest,
					namespace: ["generation_two"],
					createdAt: 22,
				},
				activation2,
			);
		} finally {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

class InspectableWorkflowRuntimeStore extends WorkflowRuntimeStore {
	raw(sql: string, args: any[] = []) {
		return this.db.execute({ sql, args });
	}

	writerRaw(sql: string, args: any[] = []) {
		return this.write({ sql, args }, "CAS");
	}

	holdWriter(started: () => void, release: Promise<void>) {
		return this.tx(async (tx) => {
			await tx.execute("UPDATE agent_session_family_projection_clock SET revision = revision WHERE singleton = 1");
			started();
			await release;
		}, "CAS");
	}
}

type SeededParent = Awaited<ReturnType<typeof seedParent>>;
type AcceptedChild = Extract<
	Awaited<ReturnType<WorkflowRuntimeStore["admitAgentSessionChild"]>>,
	{ decision: "accepted" }
>;

async function admitChild(
	runtime: WorkflowRuntimeStore,
	seeded: SeededParent,
	requestId: string,
	now: number,
): Promise<AcceptedChild> {
	const decision = await runtime.admitAgentSessionChild(seeded.parentSessionId, {
		...seeded.parentFence,
		requestId,
		prompt: `Run ${requestId}.`,
		requestedName: requestId,
		causationId: `cause-${requestId}`,
		now,
	});
	assert.equal(
		decision.decision,
		"accepted",
		decision.decision === "denied"
			? `${decision.request.denial_code}: ${decision.request.denial_message}`
			: undefined,
	);
	if (decision.decision !== "accepted") throw new Error(decision.request.denial_message ?? "child denied");
	return decision;
}

function childResult(child: AcceptedChild, output: string, queuedAt: number, startedAt: number, durationMs: number) {
	return {
		nodeKey: child.spec.nodeKey,
		sessionId: child.child.session_id,
		invocationId: child.run.child_run_id,
		label: child.spec.label,
		phaseIndex: child.spec.phaseIndex,
		state: "done" as const,
		output,
		model: child.spec.model,
		turns: 1,
		toolCalls: 0,
		tokens: 8,
		queuedAt,
		startedAt,
		durationMs,
	};
}

function testCell(sessionId: string, generation: number, suffix: string, now: number) {
	return {
		schema: "choreograph.compute-cell.v1" as const,
		cellRef: `compute.cell:${suffix}`,
		sessionId,
		leaseId: `kernel-lease-${suffix}`,
		kernelSandboxId: `kernel-sandbox-${suffix}`,
		inputId: `input-${suffix}`,
		ordinal: 0,
		generation,
		code: `${String(generation)} + 1`,
		status: "ok" as const,
		executionCount: generation + 1,
		outputs: [{ kind: "result" as const, data: { "text/plain": String(generation + 1) } }],
		startedAt: now,
		completedAt: now + 1,
		durationMs: 1,
		hostRequests: [],
		cellDigest: `sha256:${generation === 0 ? "8".repeat(64) : "9".repeat(64)}`,
	};
}

async function commitRootCheckpoint(
	runtime: WorkflowRuntimeStore,
	root: SeededParent,
	generation: number,
	sandboxId: string,
	now: number,
): Promise<void> {
	const session = await runtime.readAgentSession(root.parentSessionId);
	if (!session) throw new Error("checkpoint root Session is missing");
	const document = JSON.parse(session.document_json) as {
		meaningfulObjects: { agentSession: MeaningfulObjectRefV1<"agent-session"> };
	};
	const checkpointId = `checkpoint-${root.parentSessionId}-${String(generation)}`;
	const manifest = {
		schema: AGENT_CHECKPOINT_SCHEMA,
		checkpointId,
		agentSession: document.meaningfulObjects.agentSession,
		sessionId: root.parentSessionId,
		sessionSequence: generation,
		workerSequence: generation + 1,
		generation,
		sandboxId,
		runtimeBindingDigest: root.spec.runtimeBindingDigest!,
		ontologyBindingDigest: root.spec.ontologyBindingDigest!,
		compatibility: {
			primeStateSchema: PRIME_RUNTIME_STATE_SCHEMA,
			primeBridgeProtocol: PRIME_HOST_PROTOCOL_VERSION,
			runtimeBundleId: root.spec.runtime!.bundle.id,
			runtimeBundleDigest: root.spec.runtime!.bundle.digest,
			sessionFormatVersion: 3,
		},
		state: {
			schema: SOPHIA_CONTENT_REF_SCHEMA,
			uri: `file:///tmp/${checkpointId}`,
			digest: `sha256:${"6".repeat(64)}`,
			bytes: 0,
			mediaType: "application/vnd.sophia.prime-runtime-state+json",
		},
		stateDigest: `sha256:${"7".repeat(64)}`,
		causationId: `cause-${checkpointId}`,
		createdAt: new Date(now).toISOString(),
	} as const;
	await runtime.commitAgentCheckpoint({
		manifest,
		object: createMeaningfulObjectRef({
			kind: "agent-checkpoint",
			ownerPrincipal: session.owner_user_id,
			graphId: session.graph_id,
			objectId: checkpointId,
			version: `${String(generation)}:${String(generation)}`,
			value: manifest,
		}),
	});
}

async function seedParent(
	runtime: WorkflowRuntimeStore,
	suffix = "parent",
	childKind: "simple" | "prime" = "simple",
	materialize = true,
	rootKind: "simple" | "prime" = "prime",
) {
	const parentSessionId = `ags-f5-${suffix}`;
	const graphId = "prime-notebook-lab";
	const runId = `wfr-f5-${suffix}`;
	const workflowName = `f5-store-proof-${suffix}`;
	const pilot = makeTestAgentSemanticBinding({ graphId, kind: rootKind, registeredName: "phanes" });
	const childBase = makeTestAgentSemanticBinding({ graphId, kind: childKind, registeredName: "phanes" });
	const child =
		childKind === "prime"
			? {
					...childBase,
					runtime: {
						...childBase.runtime,
						constraints: { ...childBase.runtime.constraints, maxChildDepth: 1 },
					},
					runtimeBindingDigest: digestAgentRuntimeBinding({
						...childBase.runtime,
						constraints: { ...childBase.runtime.constraints, maxChildDepth: 1 },
					}),
				}
			: childBase;
	await runtime.createWorkflowInstance({
		runId,
		workflowName,
		graphId,
		ownerUserId: "cognito-ada",
		inputs: {
			hostContext: {
				schema: "sophia.domain-agent-host-context.v1",
				runtimes: { pilot: pilot.runtime, emanation: child.runtime },
				ontologies: { pilot: pilot.ontology, emanation: child.ontology },
				emanation: {
					enabled: true,
					provider: "openrouter",
					model: "mock:done",
					maxEmanations: 1,
					maxTurns: child.runtime.constraints.maxTurns,
				},
				emanationToolInclude: ["recall"],
				systemPrompt: "You are Phanes.",
				toolbelt: { tools: [{ name: "recall", capability: "mnemosyne", access: "read", available: true }] },
			},
		},
		startedAt: 1,
	});
	const spec: AgentNodeSpec = {
		label: "pilot-attend",
		phaseIndex: 1,
		prompt: "Attend.",
		model: "mock:done",
		provider: "openrouter",
		graphId,
		sessionId: parentSessionId,
		agentId: pilot.agentId,
		runtime: pilot.runtime,
		runtimeBindingDigest: digestAgentRuntimeBinding(pilot.runtime),
		ontology: pilot.ontology,
		ontologyBindingDigest: pilot.ontologyBindingDigest,
	};
	await runtime.beginAgentSession({
		sessionId: parentSessionId,
		runId,
		workflowName,
		graphId,
		ownerUserId: "cognito-ada",
		graphOwnerPrincipal: "organization:sophia-labs",
		spec,
		nodeKey: "1:pilot-attend",
		frontier: { kind: "before-node", sessionId: parentSessionId, phaseIndex: 1, ts: 1 },
		now: 1,
	});
	const parentFence = {
		parentGeneration: 0,
		parentActivationId: `act-f5-${suffix}`,
		parentSandboxId: `sbx-f5-${suffix}`,
	} as const;
	if (materialize) {
		await runtime.claimAgentMaterialization(parentSessionId, {
			generation: 0,
			activationId: parentFence.parentActivationId,
			now: 2,
		});
		await runtime.bindAgentSandbox(parentSessionId, {
			generation: 0,
			activationId: parentFence.parentActivationId,
			sandboxId: parentFence.parentSandboxId,
			now: 3,
		});
	}
	return { parentSessionId, parentFence, spec };
}

async function bindKernelBody(
	runtime: WorkflowRuntimeStore,
	sessionId: string,
	generation: number,
	activationId: string,
	now: number,
): Promise<void> {
	const sandboxId = `kernel-${sessionId}-${String(generation)}-${activationId}`;
	await runtime.beginAgentSessionKernelLaunch(sessionId, generation, { activationId, sandboxId, now });
	await runtime.bindAgentSessionKernelLaunch(sessionId, generation, { activationId, sandboxId, now });
}

async function drainFamilyProjectionOutbox(runtime: WorkflowRuntimeStore, startedAt: number): Promise<void> {
	for (let now = startedAt; now < startedAt + 20; now += 1) {
		const claim = await runtime.claimAgentSessionFamilyProjectionOutbox({
			consumer: "initial-projector",
			leaseMs: 100,
			now,
		});
		if (!claim) return;
		assert.equal(claim.work.work_kind, "project");
		assert.ok(claim.snapshot);
		await runtime.completeAgentSessionFamilyProjectionOutbox({
			rootSessionId: claim.work.root_session_id,
			consumer: claim.work.consumer!,
			claimToken: claim.work.claim_token!,
			workKind: claim.work.work_kind,
			projectedRevision: claim.snapshot!.projectionRevision,
			now,
		});
	}
	throw new Error("family projection outbox did not drain");
}

async function withTwoStores(
	run: (
		first: InspectableWorkflowRuntimeStore,
		second: InspectableWorkflowRuntimeStore,
		path: string,
	) => Promise<void>,
): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "agent-f5-store-"));
	const path = join(directory, "runtime.sqlite");
	const first = new InspectableWorkflowRuntimeStore(path);
	const second = new InspectableWorkflowRuntimeStore(path);
	try {
		await first.init();
		await second.init();
		await run(first, second, path);
	} finally {
		first.close();
		second.close();
		rmSync(directory, { recursive: true, force: true });
	}
}
