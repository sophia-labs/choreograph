import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	AgentSessionChildCleanupUnavailable,
	AgentSessionChildExecutionService,
	type AgentSessionChildExecutionServiceOptions,
	AgentSessionChildHostRequestFault,
	type AgentSessionChildParentContext,
} from "../agent-runtime/child-execution-service.js";
import { SophiaContentStore } from "../agent-runtime/content-store.js";
import { AgentMemory } from "../agent-runtime/memory.js";
import { digestAgentRuntimeBinding } from "../agent-runtime/profile.js";
import { makeRuntimeNodeRunner } from "../workflow/runtime-control.js";
import type {
	AcceptedAgentSessionChildResult,
	AgentMaterializationRecord,
	AgentMaterializationRecoveryClaim,
	AgentSessionChildClosureWorkClaim,
	AgentSessionChildRunClaim,
	AgentSessionChildRunRecord,
	AgentSessionChildRunRecoveryRecord,
	AgentSessionRecord,
} from "../workflow/runtime-store.js";
import {
	AgentSessionChildAdmissionFault,
	AgentSessionChildRunFault,
	WorkflowRuntimeStore,
} from "../workflow/runtime-store.js";
import type { AgentNodeResult, AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

const childRunId = `acr_${"a".repeat(24)}`;
const childSessionId = `ags_${"b".repeat(24)}`;

const parent: AgentSessionChildParentContext = {
	sessionId: "ags_parent",
	generation: 2,
	activationId: "act_parent",
	agentSandboxId: "sbx_parent",
	ownerUserId: "owner-parent",
	graphOwnerPrincipal: "organization:child-runtime-lab",
	graphId: "graph-parent",
};

const spec: AgentNodeSpec = {
	nodeKey: `child:${childSessionId}`,
	sessionId: childSessionId,
	invocationId: childRunId,
	label: "researcher",
	phaseIndex: 1,
	prompt: "Inspect bounded evidence",
	model: "mock:done",
	provider: "openrouter",
	graphId: "graph-child",
	runtime: { kind: "simple", constraints: { allowPersistentKernel: false } } as never,
};

function session(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
	return {
		session_id: childSessionId,
		run_id: "wfr_child",
		owner_user_id: "owner-child",
		graph_owner_principal: "organization:child-runtime-lab",
		graph_id: "graph-child",
		workflow_name: "workflow",
		node_key: `child:${childSessionId}`,
		label: "researcher",
		phase_index: 1,
		agent_id: "agent-child",
		sandbox_id: "sbx_child",
		model: "mock:done",
		family_root_session_id: parent.sessionId,
		status: "running",
		lifecycle_state: "open",
		frontier_json: null,
		result_json: null,
		lifecycle_terminal_digest: null,
		document_json: "{}",
		created_at: 1,
		updated_at: 1,
		completed_at: null,
		...overrides,
	};
}

function run(overrides: Partial<AgentSessionChildRunRecord> = {}): AgentSessionChildRunRecord {
	return {
		child_run_id: childRunId,
		admission_id: "asa_child",
		parent_session_id: parent.sessionId,
		child_session_id: childSessionId,
		state: "claimed",
		attempt: 1,
		consumer: "consumer-test",
		claim_token: "claim-token",
		claimed_at: 2,
		claim_expires_at: 1_002,
		heartbeat_at: 2,
		materialization_generation: 0,
		materialized_at: 3,
		result: null,
		error: null,
		terminal_digest: null,
		created_at: 1,
		terminal_at: null,
		...overrides,
	};
}

function materialization(overrides: Partial<AgentMaterializationRecord> = {}): AgentMaterializationRecord {
	return {
		session_id: childSessionId,
		generation: 0,
		sandbox_id: "sbx_child",
		activation_id: childRunId,
		state: "running",
		fault_kind: null,
		recoverable: null,
		checkpoint_id: null,
		kernel_checkpoint_id: null,
		created_at: 3,
		updated_at: 4,
		passivated_at: null,
		...overrides,
	};
}

function accepted(): AcceptedAgentSessionChildResult {
	return {
		decision: "accepted",
		request: {
			parent_session_id: parent.sessionId,
			request_id: "request-1",
			request_digest: "sha256:request",
			decision: "accepted",
			admission_id: "asa_child",
			child_session_id: childSessionId,
			child_run_id: childRunId,
			denial_code: null,
			denial_message: null,
			created_at: 1,
		},
		child: session({ status: "queued", sandbox_id: null }),
		relation: {
			relation_id: "rel_child",
			relation_kind: "parent_child",
			parent_session_id: parent.sessionId,
			child_session_id: childSessionId,
			owner_user_id: "owner-child",
			graph_id: "graph-child",
			causation_id: "request-1",
			created_at: 1,
		},
		admission: {
			admission_id: "asa_child",
			parent_session_id: parent.sessionId,
			request_id: "request-1",
			request_digest: "sha256:request",
			child_session_id: childSessionId,
			child_run_id: childRunId,
			relation_id: "rel_child",
			child_name: "researcher",
			depth: 1,
			runtime_binding_digest: "sha256:runtime",
			ontology_binding_digest: "sha256:ontology",
			budget_allocation_id: "alloc_child",
			budget: {
				schema: "choreograph.agent-session-child-budget.v1",
				maxTurns: 1,
				maxWallTimeMs: 1_000,
				maxTokens: 100,
				maxCostUsdMicros: 100,
				maxArtifactBytes: 100,
			},
			created_at: 1,
		},
		allocation: {
			allocation_id: "alloc_child",
			admission_id: "asa_child",
			parent_session_id: parent.sessionId,
			child_session_id: childSessionId,
			state: "reserved",
			budget: {
				schema: "choreograph.agent-session-child-budget.v1",
				maxTurns: 1,
				maxWallTimeMs: 1_000,
				maxTokens: 100,
				maxCostUsdMicros: 100,
				maxArtifactBytes: 100,
			},
			hold_reason: null,
			created_at: 1,
			held_at: null,
			settled_at: null,
		},
		run: run({
			state: "queued",
			attempt: 0,
			consumer: null,
			claim_token: null,
			claimed_at: null,
			claim_expires_at: null,
			heartbeat_at: null,
			materialization_generation: null,
			materialized_at: null,
		}),
		spec,
		created: true,
	};
}

function claimed(): AgentSessionChildRunClaim {
	return { run: run(), child: session(), spec, claimed: true };
}

function result(state: AgentNodeResult["state"] = "done"): AgentNodeResult {
	return {
		sessionId: childSessionId,
		invocationId: childRunId,
		label: "researcher",
		phaseIndex: 1,
		state,
		output: state === "error" ? "failed" : "answer",
		model: "mock:done",
		turns: 1,
		toolCalls: 0,
		tokens: 7,
		queuedAt: 1,
		startedAt: 2,
		durationMs: 3,
	};
}

type Runtime = AgentSessionChildExecutionServiceOptions["runtime"];

function runtimeFixture(overrides: Partial<Runtime> = {}): Runtime {
	const defaults: Partial<Runtime> = {
		listClaimableAgentSessionChildRuns: async () => [],
		listAgentSessionChildRunsRequiringRecovery: async () => [],
		claimAgentMaterializationRecovery: async () => null,
		claimAgentSessionChildClosureWork: async () => null,
		listAgentSessionChildCancellationRequests: async () => [],
	};
	const values = { ...defaults, ...overrides } as Partial<Runtime>;
	return new Proxy(values, {
		get(target, property, receiver) {
			if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
			return async () => {
				throw new Error(`unexpected runtime call: ${String(property)}`);
			};
		},
	}) as Runtime;
}

function service(
	runtime: Runtime,
	overrides: Partial<Omit<AgentSessionChildExecutionServiceOptions, "runtime">> = {},
): AgentSessionChildExecutionService {
	return new AgentSessionChildExecutionService({
		runtime,
		consumer: "consumer-test",
		leaseMs: 1_000,
		heartbeatIntervalMs: 10,
		pollIntervalMs: 0,
		controlTimeoutMs: 100,
		execute: async () => ({ result: result(), materialization: materialization({ state: "completed" }) }),
		cleanup: async () => ({ materializationState: "cancelled" }),
		...overrides,
	});
}

async function eventually(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	assert.fail(message);
}

// Production scheduling timers are deliberately unref'ed. A referenced
// deadline keeps tests awaiting their work alive and reports a real timeout.
async function waitWithDeadline<T>(promise: Promise<T>, message: string): Promise<T> {
	let deadline: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				deadline = setTimeout(() => reject(new Error(message)), 5_000);
			}),
		]);
	} finally {
		if (deadline) clearTimeout(deadline);
	}
}

// These tests exercise deliberately unref'ed production heartbeat timers.
// A bounded suite timeout keeps their awaited work alive in an otherwise idle
// Node test worker and reports a timeout instead of cancelling later tests.
describe("AgentSessionChildExecutionService", { timeout: 30_000 }, () => {
	it("returns the exact run handle before it claims, then leases generation zero and reconstructs durable authority", async () => {
		const order: string[] = [];
		const settlements: unknown[] = [];
		let queued = false;
		let releaseAdmissionNotification!: () => void;
		const admissionNotificationReleased = new Promise<void>((resolve) => {
			releaseAdmissionNotification = resolve;
		});
		let admissionNotificationStarted!: () => void;
		const admissionNotification = new Promise<void>((resolve) => {
			admissionNotificationStarted = resolve;
		});
		let notifications = 0;
		const runtime = runtimeFixture({
			admitAgentSessionChild: async (_sessionId, input) => {
				order.push("admit");
				assert.equal(input.parentActivationId, parent.activationId);
				queued = true;
				return accepted();
			},
			listClaimableAgentSessionChildRuns: async () => (queued ? [run({ state: "queued" })] : []),
			claimAgentSessionChildRun: async (_id, input) => {
				queued = false;
				order.push("claim");
				assert.deepEqual(input, { consumer: "consumer-test", leaseMs: 1_000, now: 10 });
				return claimed();
			},
			claimAgentSessionChildMaterialization: async (_id, input) => {
				order.push("materialize");
				assert.deepEqual(input, {
					consumer: "consumer-test",
					claimToken: "claim-token",
					generation: 0,
					activationId: childRunId,
					now: 10,
				});
				return materialization();
			},
			readAgentSessionChildRun: async () => run(),
			settleAgentSessionChildRun: async (_id, input) => {
				order.push("settle");
				settlements.push(input);
				return { run: run({ state: "completed" }), allocation: accepted().allocation, applied: true };
			},
		});
		const supervisor = service(runtime, {
			now: () => 10,
			onDurableChange: async () => {
				notifications += 1;
				if (notifications !== 1) return;
				order.push("notify");
				admissionNotificationStarted();
				await admissionNotificationReleased;
			},
			execute: async ({ authority }) => {
				order.push("execute");
				assert.deepEqual(authority, {
					ownerUserId: "owner-child",
					graphOwnerPrincipal: "organization:child-runtime-lab",
					graphId: "graph-child",
				});
				assert.equal("authContext" in authority, false);
				return { result: result(), materialization: materialization({ state: "completed", updated_at: 9 }) };
			},
		});
		await supervisor.start();
		const handlePromise = supervisor.handle({
			requestId: "request-1",
			payload: {
				type: "rlm.run",
				prompt: "Inspect bounded evidence",
				kwargs: { name: "researcher", model: "mock:done" },
			},
			parent,
		});
		await admissionNotification;
		supervisor.wake();
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.deepEqual(order, ["admit", "notify"], "execution must not be scheduled before the handle can return");
		releaseAdmissionNotification();
		const handle = await handlePromise;
		assert.deepEqual(handle, {
			child_session_id: childSessionId,
			child_run_id: childRunId,
			name: "researcher",
			model: "mock:done",
		});
		assert.deepEqual(order, ["admit", "notify"]);
		supervisor.wake();
		await eventually(() => settlements.length === 1, "child did not settle");
		assert.deepEqual(order, ["admit", "notify", "claim", "materialize", "execute", "settle"]);
		assert.deepEqual(settlements[0], {
			consumer: "consumer-test",
			claimToken: "claim-token",
			status: "completed",
			terminalPolicy: "close",
			materializationGeneration: 0,
			materializationState: "completed",
			result: result(),
			now: 10,
		});
		await supervisor.stop();
	});

	it("heartbeats both run and body leases and aborts execution on durable cancellation", async () => {
		let claimable = true;
		let cancellationVisible = false;
		let renewals = 0;
		let materializationHeartbeats = 0;
		const settlements: Record<string, unknown>[] = [];
		let markExecutionStarted!: () => void;
		const executionStarted = new Promise<void>((resolve) => {
			markExecutionStarted = resolve;
		});
		let finishExecution!: () => void;
		const executionFinished = new Promise<void>((resolve) => {
			finishExecution = resolve;
		});
		const runtime = runtimeFixture({
			listClaimableAgentSessionChildRuns: async () => (claimable ? [run({ state: "queued" })] : []),
			claimAgentSessionChildRun: async () => {
				claimable = false;
				return claimed();
			},
			claimAgentSessionChildMaterialization: async () => materialization(),
			renewAgentSessionChildRunLease: async () => {
				await executionStarted;
				renewals += 1;
				cancellationVisible = true;
				return run({ state: "cancelling" });
			},
			heartbeatAgentMaterialization: async () => {
				materializationHeartbeats += 1;
			},
			listAgentSessionChildCancellationRequests: async () =>
				cancellationVisible
					? [
							{
								cancellation_id: "acc_1",
								child_run_id: childRunId,
								request_id: "delete-1",
								request_digest: "sha256:cancel",
								actor: {
									kind: "parent_materialization" as const,
									parentSessionId: parent.sessionId,
									generation: parent.generation,
									activationId: parent.activationId,
									sandboxId: parent.agentSandboxId,
								},
								reason: "delete requested",
								disposition: "cancellation_pending" as const,
								observed_run_state: "claimed" as const,
								created_at: 5,
							},
						]
					: [],
			readAgentSessionChildRun: async () => run({ state: "cancelling" }),
			settleAgentSessionChildRun: async (_id, input) => {
				settlements.push(input as unknown as Record<string, unknown>);
				return { run: run({ state: "cancelled" }), allocation: accepted().allocation, applied: true };
			},
		});
		const supervisor = service(runtime, {
			execute: async ({ signal }) => {
				const aborted = new Promise<void>((resolve) =>
					signal.addEventListener("abort", () => resolve(), { once: true }),
				);
				markExecutionStarted();
				await aborted;
				finishExecution();
				return { result: result("error"), materialization: materialization({ state: "cancelled" }) };
			},
		});
		await supervisor.start();
		await waitWithDeadline(executionFinished, "child cancellation heartbeat did not finish");
		await eventually(() => settlements.length === 1, "cancelled child did not settle");
		assert.ok(renewals >= 1);
		assert.ok(materializationHeartbeats >= 1);
		assert.equal(settlements[0]?.status, "cancelled");
		assert.equal(settlements[0]?.error, "delete requested");
		assert.equal("result" in (settlements[0] ?? {}), false);
		await supervisor.stop();
	});

	it("serializes slow execution heartbeats so a later lease renewal cannot overtake an earlier tick", async () => {
		let claimable = true;
		let renewals = 0;
		let concurrentRenewals = 0;
		let maxConcurrentRenewals = 0;
		let releaseFirstRenewal!: () => void;
		const firstRenewalReleased = new Promise<void>((resolve) => {
			releaseFirstRenewal = resolve;
		});
		let firstRenewalStarted!: () => void;
		const firstRenewal = new Promise<void>((resolve) => {
			firstRenewalStarted = resolve;
		});
		let releaseSecondRenewal!: () => void;
		const secondRenewalReleased = new Promise<void>((resolve) => {
			releaseSecondRenewal = resolve;
		});
		let secondRenewalStarted!: () => void;
		const secondRenewal = new Promise<void>((resolve) => {
			secondRenewalStarted = resolve;
		});
		let finishExecution!: () => void;
		const executionFinished = new Promise<void>((resolve) => {
			finishExecution = resolve;
		});
		let executionAborted = false;
		let settlements = 0;
		let runState: AgentSessionChildRunRecord["state"] = "claimed";
		const runtime = runtimeFixture({
			listClaimableAgentSessionChildRuns: async () => (claimable ? [run({ state: "queued" })] : []),
			claimAgentSessionChildRun: async () => {
				claimable = false;
				return claimed();
			},
			claimAgentSessionChildMaterialization: async () => materialization(),
			renewAgentSessionChildRunLease: async () => {
				renewals += 1;
				concurrentRenewals += 1;
				maxConcurrentRenewals = Math.max(maxConcurrentRenewals, concurrentRenewals);
				if (renewals === 1) {
					firstRenewalStarted();
					await firstRenewalReleased;
				} else if (renewals === 2) {
					secondRenewalStarted();
					await secondRenewalReleased;
				}
				concurrentRenewals -= 1;
				return run({ state: "claimed" });
			},
			heartbeatAgentMaterialization: async () => materialization(),
			readAgentSessionChildRun: async () => run({ state: runState }),
			settleAgentSessionChildRun: async () => {
				settlements += 1;
				runState = "completed";
				return {
					run: run({ state: "completed", terminal_at: 10 }),
					allocation: accepted().allocation,
					applied: true,
				};
			},
		});
		const supervisor = service(runtime, {
			execute: async ({ signal }) => {
				signal.addEventListener("abort", () => {
					executionAborted = true;
				});
				await executionFinished;
				return { result: result(), materialization: materialization({ state: "completed" }) };
			},
		});
		await supervisor.start();
		await waitWithDeadline(firstRenewal, "first child lease renewal did not start");
		await new Promise((resolve) => setTimeout(resolve, 35));
		assert.equal(renewals, 1, "a slow renewal must suppress overlapping interval ticks");
		releaseFirstRenewal();
		await waitWithDeadline(secondRenewal, "second child lease renewal did not start");
		finishExecution();
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
		assert.equal(settlements, 0, "terminal run handoff must wait for the exact in-flight child heartbeat");
		assert.equal(runState, "claimed", "global resident heartbeat cannot observe a terminal run before the drain");
		releaseSecondRenewal();
		await supervisor.awaitExecutionDrain();
		assert.equal(maxConcurrentRenewals, 1);
		assert.equal(executionAborted, false);
		assert.equal(settlements, 1);
		assert.equal(runState, "completed");
		await supervisor.stop();
	});

	it("settles a cancellation visible before execution without spawning a child body", async () => {
		let executions = 0;
		let cancellationReads = 0;
		let terminalReads = 0;
		const cancellationRequest = {
			cancellation_id: "acc_before_execute",
			child_run_id: childRunId,
			request_id: "delete-before-execute",
			request_digest: "sha256:cancel-before-execute",
			actor: {
				kind: "parent_materialization" as const,
				parentSessionId: parent.sessionId,
				generation: parent.generation,
				activationId: parent.activationId,
				sandboxId: parent.agentSandboxId,
			},
			reason: "cancelled before body admission",
			disposition: "cancellation_pending" as const,
			observed_run_state: "claimed" as const,
			created_at: 5,
		};
		const runtime = runtimeFixture({
			listClaimableAgentSessionChildRuns: async () => [run({ state: "queued" })],
			claimAgentSessionChildRun: async () => claimed(),
			claimAgentSessionChildMaterialization: async () =>
				materialization({ state: "claimed", sandbox_id: `claim:${childRunId}` }),
			readAgentMaterialization: async () => materialization({ state: "claimed", sandbox_id: `claim:${childRunId}` }),
			listAgentSessionChildCancellationRequests: async () => {
				cancellationReads += 1;
				return cancellationReads === 1 ? [] : [cancellationRequest];
			},
			readAgentSessionChildRun: async () => {
				terminalReads += 1;
				return run({ state: "cancelled" });
			},
		});
		const supervisor = service(runtime, {
			execute: async () => {
				executions += 1;
				return { result: result(), materialization: materialization() };
			},
			cleanup: async (input) => {
				assert.equal(input.phase, "prepare_closure");
				return { materializationState: "cancelled" };
			},
		});
		await supervisor.start();
		await eventually(() => terminalReads === 1, "pre-execution cancellation did not settle");
		assert.equal(executions, 0);
		await supervisor.stop();
	});

	it("settles a pre-body execution failure through the exact no-materialization store seam", async () => {
		let queued = true;
		let executions = 0;
		let failures = 0;
		let notifications = 0;
		const runtime = runtimeFixture({
			listClaimableAgentSessionChildRuns: async () => (queued ? [run({ state: "queued" })] : []),
			claimAgentSessionChildRun: async () => {
				queued = false;
				return claimed();
			},
			claimAgentSessionChildMaterialization: async () =>
				materialization({ state: "claimed", sandbox_id: `claim:${childRunId}` }),
			readAgentMaterialization: async () => materialization({ state: "claimed", sandbox_id: `claim:${childRunId}` }),
			listAgentSessionChildCancellationRequests: async () => [],
			failUnboundAgentSessionChildRun: async (id, input) => {
				failures += 1;
				assert.equal(id, childRunId);
				assert.deepEqual(input, {
					consumer: "consumer-test",
					claimToken: "claim-token",
					generation: 0,
					activationId: childRunId,
					error: "worker executable missing",
					now: 10,
				});
				return {
					run: run({ state: "failed", terminal_at: 10, error: input.error }),
					allocation: { ...accepted().allocation, state: "released", settled_at: 10 },
					applied: true,
				};
			},
		});
		const supervisor = service(runtime, {
			execute: async () => {
				executions += 1;
				throw new Error("worker executable missing");
			},
			onDurableChange: () => {
				notifications += 1;
			},
			now: () => 10,
		});
		await supervisor.start();
		await eventually(() => failures === 1, "pre-body launch failure did not settle");
		await supervisor.awaitExecutionDrain();
		assert.equal(executions, 1);
		assert.equal(notifications, 2, "launch intent and terminal failure each wake durable projection");
		await supervisor.stop();
	});

	it("leaves a launch sentinel claimed when physical cleanup remains explicitly unavailable", async () => {
		let queued = true;
		let failures = 0;
		const runtime = runtimeFixture({
			listClaimableAgentSessionChildRuns: async () => (queued ? [run({ state: "queued" })] : []),
			claimAgentSessionChildRun: async () => {
				queued = false;
				return claimed();
			},
			claimAgentSessionChildMaterialization: async () =>
				materialization({ state: "claimed", sandbox_id: `claim:${childRunId}` }),
			listAgentSessionChildCancellationRequests: async () => [],
			failUnboundAgentSessionChildRun: async () => {
				failures += 1;
				throw new Error("must not terminalize an unverified cleanup");
			},
		});
		const supervisor = service(runtime, {
			execute: async () => {
				const error = new Error("worker cgroup remains populated");
				error.name = "SandboxCleanupUnavailable";
				throw error;
			},
		});
		await supervisor.start();
		await supervisor.awaitExecutionDrain();
		assert.equal(failures, 0, "unverified cleanup must remain under the claimed launch lease");
		await supervisor.stop();
	});

	it("recovers a stale orphan while an unrelated local child execution remains live", async () => {
		const orphanRunId = `acr_${"b".repeat(24)}`;
		const orphanSessionId = "ags_orphan";
		let activeQueued = true;
		let orphanAvailable = true;
		let orphanSettled = false;
		let releaseActive!: () => void;
		const activeReleased = new Promise<void>((resolve) => {
			releaseActive = resolve;
		});
		const orphanMaterialization = materialization({
			session_id: orphanSessionId,
			sandbox_id: "sbx_orphan",
			activation_id: orphanRunId,
		});
		const orphanRun = run({
			child_run_id: orphanRunId,
			child_session_id: orphanSessionId,
			claim_token: "orphan-claim-token",
			claim_expires_at: 0,
		});
		const runtime = runtimeFixture({
			listClaimableAgentSessionChildRuns: async () => (activeQueued ? [run({ state: "queued" })] : []),
			claimAgentSessionChildRun: async () => {
				activeQueued = false;
				return claimed();
			},
			claimAgentSessionChildMaterialization: async () => materialization(),
			claimAgentMaterializationRecovery: async () => {
				if (!orphanAvailable) return null;
				orphanAvailable = false;
				return {
					materialization: orphanMaterialization,
					child_run_id: orphanRunId,
					durable_outcome_status: null,
					kernel_state: null,
					lifecycle_state: "open",
					recovery_attempt: 1,
					recovery_consumer: "consumer-test",
					recovery_token: "orphan-recovery-token",
					recovery_expires_at: 1_000,
					claimed: true,
				};
			},
			readAgentSession: async (sessionId) =>
				sessionId === orphanSessionId
					? session({ session_id: orphanSessionId, sandbox_id: "sbx_orphan" })
					: session(),
			readAgentSessionChildRun: async (runId) => (runId === orphanRunId ? orphanRun : run()),
			finishRecoveredAgentMaterialization: async () => ({
				materialization: {
					...orphanMaterialization,
					state: "faulted",
					fault_kind: "worker_exit",
					recoverable: false,
				},
				childRun: orphanRun,
			}),
			settleRecoveredAgentSessionChildRun: async () => {
				orphanSettled = true;
				return {
					run: { ...orphanRun, state: "failed", terminal_at: 10 },
					allocation: accepted().allocation,
					applied: true,
				};
			},
			settleAgentSessionChildRun: async () => ({
				run: run({ state: "completed", terminal_at: 11 }),
				allocation: accepted().allocation,
				applied: true,
			}),
		});
		const supervisor = service(runtime, {
			execute: async () => {
				await activeReleased;
				return { result: result(), materialization: materialization({ state: "completed" }) };
			},
			cleanup: async (input) => {
				assert.equal(input.phase, "recovery");
				assert.equal(input.claim.materialization.session_id, orphanSessionId);
				return { materializationState: "faulted", faultKind: "worker_exit", recoverable: false };
			},
		});
		await supervisor.start();
		assert.equal(orphanSettled, true, "a live local turn must not globally block stale orphan recovery");
		releaseActive();
		await supervisor.awaitExecutionDrain();
		await supervisor.stop();
	});

	it("startup recovery fences cleanup, heartbeats recovery, records kernel deletion, and settles the crashed run", async () => {
		const recovery: AgentMaterializationRecoveryClaim = {
			materialization: materialization(),
			child_run_id: childRunId,
			durable_outcome_status: null,
			kernel_state: null,
			lifecycle_state: "open",
			recovery_attempt: 1,
			recovery_consumer: "consumer-test",
			recovery_token: "recovery-token",
			recovery_expires_at: 1_000,
			claimed: true,
		};
		let recoveryAvailable = true;
		let recoveryRenewals = 0;
		const calls: string[] = [];
		const runtime = runtimeFixture({
			claimAgentMaterializationRecovery: async () => {
				if (!recoveryAvailable) return null;
				recoveryAvailable = false;
				calls.push("claim-recovery");
				return recovery;
			},
			readAgentSession: async () => session(),
			readAgentSessionChildRun: async () => run({ claim_expires_at: 0 }),
			renewAgentMaterializationRecoveryLease: async () => {
				recoveryRenewals += 1;
				return recovery;
			},
			finishRecoveredAgentMaterialization: async (_id, _generation, input) => {
				calls.push(`finish-${input.to}`);
				assert.equal(input.recoveryToken, "recovery-token");
				return {
					materialization: materialization({ state: "faulted", fault_kind: "worker_exit", recoverable: false }),
					childRun: run(),
				};
			},
			recordRecoveredAgentSessionKernelState: async (_id, _generation, input) => {
				calls.push(`kernel-${input.state}`);
				return {} as never;
			},
			settleRecoveredAgentSessionChildRun: async (_id, input) => {
				calls.push(`settle-${input.status}`);
				return { run: run({ state: "failed" }), allocation: accepted().allocation, applied: true };
			},
		});
		const supervisor = service(runtime, {
			cleanup: async (input) => {
				assert.equal(input.phase, "recovery");
				assert.equal(input.terminalIntent, "faulted");
				assert.deepEqual(input.authority, {
					ownerUserId: "owner-child",
					graphOwnerPrincipal: "organization:child-runtime-lab",
					graphId: "graph-child",
				});
				calls.push("physical-cleanup");
				await new Promise((resolve) => setTimeout(resolve, 15));
				return {
					materializationState: "faulted",
					faultKind: "worker_exit",
					recoverable: false,
					kernelState: "faulted",
				};
			},
		});
		await supervisor.start();
		assert.deepEqual(calls, [
			"claim-recovery",
			"physical-cleanup",
			"kernel-faulted",
			"finish-faulted",
			"settle-failed",
		]);
		assert.ok(recoveryRenewals >= 1);
		await supervisor.stop();
	});

	it("preserves immutable completed and failed outcomes when recovery follows a terminal-preceded delete", async () => {
		for (const logicalStatus of ["completed", "failed"] as const) {
			const recovery: AgentMaterializationRecoveryClaim = {
				materialization: materialization(),
				child_run_id: childRunId,
				durable_outcome_status: logicalStatus,
				kernel_state: null,
				lifecycle_state: "closing",
				recovery_attempt: 1,
				recovery_consumer: "consumer-test",
				recovery_token: `outcome-recovery-${logicalStatus}`,
				recovery_expires_at: 1_000,
				claimed: true,
			};
			let available = true;
			let cleanupIntent: string | null = null;
			let recoveredTo: string | null = null;
			let settledAs: string | null = null;
			const runtime = runtimeFixture({
				claimAgentMaterializationRecovery: async () => {
					if (!available) return null;
					available = false;
					return recovery;
				},
				readAgentSession: async () =>
					session({
						// Mutable Session status is deliberately contradictory: the recovery
						// claim's immutable outcome join is the sole logical authority.
						status: logicalStatus === "completed" ? "failed" : "completed",
						lifecycle_state: "closing",
					}),
				readAgentSessionChildRun: async () => run({ state: "claimed", claim_expires_at: 0 }),
				finishRecoveredAgentMaterialization: async (_id, _generation, input) => {
					recoveredTo = input.to;
					return {
						materialization: materialization({ state: "completed" }),
						childRun: run({ state: "claimed" }),
					};
				},
				settleRecoveredAgentSessionChildRun: async (_id, input) => {
					settledAs = input.status;
					return {
						run: run({ state: input.status, terminal_at: 20 }),
						allocation: accepted().allocation,
						applied: true,
					};
				},
			});
			const supervisor = service(runtime, {
				cleanup: async (input) => {
					assert.equal(input.phase, "recovery");
					cleanupIntent = input.terminalIntent;
					return { materializationState: "completed" };
				},
			});
			await supervisor.start();
			assert.equal(cleanupIntent, "completed");
			assert.equal(recoveredTo, "completed");
			assert.equal(settledAs, logicalStatus);
			await supervisor.stop();
		}
	});

	it("reaps a terminal worker recovery claim and records its missing paired-kernel testimony without rewriting the worker", async () => {
		const terminalMaterialization = materialization({
			state: "faulted",
			fault_kind: "worker_exit",
			recoverable: false,
			updated_at: 5,
		});
		const recovery: AgentMaterializationRecoveryClaim = {
			materialization: terminalMaterialization,
			child_run_id: childRunId,
			durable_outcome_status: null,
			kernel_state: null,
			lifecycle_state: "faulted",
			recovery_attempt: 2,
			recovery_consumer: "consumer-test",
			recovery_token: "terminal-recovery-token",
			recovery_expires_at: 1_000,
			claimed: true,
		};
		let available = true;
		let physicalCleanup = 0;
		let workerFinishes = 0;
		let kernelTestimony: string | null = null;
		let recoveredSettlements = 0;
		const runtime = runtimeFixture({
			claimAgentMaterializationRecovery: async () => {
				if (!available) return null;
				available = false;
				return recovery;
			},
			readAgentSession: async () => session({ status: "failed", lifecycle_state: "faulted" }),
			readAgentSessionChildRun: async () => run({ state: "failed", terminal_at: 5, claim_expires_at: 0 }),
			finishRecoveredAgentMaterialization: async () => {
				workerFinishes += 1;
				throw new Error("terminal worker testimony must be preserved");
			},
			recordRecoveredAgentSessionKernelState: async (_id, _generation, input) => {
				assert.equal(input.recoveryToken, "terminal-recovery-token");
				kernelTestimony = input.state;
				return {} as never;
			},
			settleRecoveredAgentSessionChildRun: async () => {
				recoveredSettlements += 1;
				throw new Error("terminal logical run must not be resettled");
			},
		});
		const supervisor = service(runtime, {
			cleanup: async (input) => {
				assert.equal(input.phase, "recovery");
				assert.equal(input.terminalIntent, "faulted");
				physicalCleanup += 1;
				return {
					materializationState: "faulted",
					faultKind: "worker_exit",
					recoverable: false,
					kernelState: "faulted",
				};
			},
		});
		await supervisor.start();
		assert.equal(physicalCleanup, 1);
		assert.equal(workerFinishes, 0);
		assert.equal(kernelTestimony, "faulted");
		assert.equal(recoveredSettlements, 0);
		await supervisor.stop();
	});

	it("preserves first-wins terminal kernel testimony while recovery repairs a stale live materialization", async () => {
		const staleMaterialization = materialization({ state: "quiescing" });
		const recovery: AgentMaterializationRecoveryClaim = {
			materialization: staleMaterialization,
			child_run_id: null,
			durable_outcome_status: null,
			kernel_state: "shutdown",
			lifecycle_state: "open",
			recovery_attempt: 1,
			recovery_consumer: "consumer-test",
			recovery_token: "shutdown-kernel-recovery-token",
			recovery_expires_at: 1_000,
			claimed: true,
		};
		let available = true;
		let kernelWrites = 0;
		let finishedTo: string | null = null;
		const runtime = runtimeFixture({
			claimAgentMaterializationRecovery: async () => {
				if (!available) return null;
				available = false;
				return recovery;
			},
			readAgentSession: async () => session(),
			recordRecoveredAgentSessionKernelState: async () => {
				kernelWrites += 1;
				throw new Error("terminal kernel testimony must not be overwritten");
			},
			finishRecoveredAgentMaterialization: async (_id, _generation, input) => {
				finishedTo = input.to;
				return {
					materialization: materialization({ state: "faulted" }),
					childRun: null,
				};
			},
		});
		const supervisor = service(runtime, {
			cleanup: async (input) => {
				assert.equal(input.phase, "recovery");
				assert.equal(input.terminalIntent, "faulted");
				return {
					materializationState: "faulted",
					faultKind: "worker_exit",
					recoverable: false,
					kernelState: "faulted",
				};
			},
		});
		await supervisor.start();
		assert.equal(kernelWrites, 0, "immutable shutdown testimony remains first-wins");
		assert.equal(finishedTo, "faulted");
		await supervisor.stop();
	});

	it("does not keep-open settle a failed Prime when the host rejects its missing worker-kernel pair", async () => {
		let queued = true;
		let executions = 0;
		let settlements = 0;
		const errors: string[] = [];
		const originalConsoleError = console.error;
		console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
		try {
			const primeClaim: AgentSessionChildRunClaim = {
				...claimed(),
				spec: {
					...spec,
					runtime: { kind: "prime", constraints: { allowPersistentKernel: true } } as never,
				},
			};
			const runtime = runtimeFixture({
				listClaimableAgentSessionChildRuns: async () => (queued ? [run({ state: "queued" })] : []),
				claimAgentSessionChildRun: async () => {
					queued = false;
					return primeClaim;
				},
				claimAgentSessionChildMaterialization: async () => materialization(),
				readAgentMaterialization: async () => materialization(),
				settleAgentSessionChildRun: async () => {
					settlements += 1;
					throw new Error("missing-kernel Prime must not settle keep_open");
				},
			});
			const supervisor = service(runtime, {
				execute: async () => {
					executions += 1;
					throw new Error("Prime child has no independently leased resident kernel body");
				},
			});
			await supervisor.start();
			await eventually(() => errors.length === 1, "missing-kernel Prime rejection was not observed");
			await supervisor.stop();
			await supervisor.awaitExecutionDrain();
			assert.equal(executions, 1);
			assert.equal(settlements, 0);
			assert.match(errors[0] ?? "", /no independently leased resident kernel body/);
		} finally {
			console.error = originalConsoleError;
		}
	});

	it("prepares a live resident before claiming closure and delete waits for the closure receipt", async () => {
		let bodyState: AgentMaterializationRecord["state"] = "running";
		let closureRequested = false;
		let closureClaimed = false;
		let closureRenewals = 0;
		let concurrentClosureRenewals = 0;
		let maxConcurrentClosureRenewals = 0;
		let closureKernelState: string | null = null;
		let closed = false;
		const cleanupPhases: string[] = [];
		const recoveryRecord = (): AgentSessionChildRunRecoveryRecord => ({
			run: run({ state: "completed", claim_expires_at: 0, terminal_at: 6 }),
			allocation: accepted().allocation,
			materialization: materialization({ state: bodyState }),
			reason: "materialized_lease_expired",
		});
		const closureClaim = (): AgentSessionChildClosureWorkClaim => ({
			request: {
				closure_id: "acl_child",
				child_run_id: childRunId,
				request_id: "delete-1",
				request_digest: "sha256:closure",
				actor: {
					kind: "parent_materialization",
					parentSessionId: parent.sessionId,
					generation: parent.generation,
					activationId: parent.activationId,
					sandboxId: parent.agentSandboxId,
				},
				reason: `rlm.delete_subagent:${childRunId}`,
				disposition: "closure_pending",
				created_at: 7,
			},
			run: run({ state: "completed", terminal_at: 6 }),
			session: session({ lifecycle_state: "closing" }),
			materialization: materialization({ state: "passivated", checkpoint_id: "chk_1" }),
			attempt: 1,
			consumer: "consumer-test",
			cleanup_token: "cleanup-token",
			claim_expires_at: 1_000,
			claimed: true,
		});
		const control = () => ({
			child_session_id: childSessionId,
			child_run_id: childRunId,
			child_name: "researcher",
			model: "mock:done",
			run_state: "completed" as const,
			session_state: closed ? ("closed" as const) : ("open" as const),
		});
		const runtime = runtimeFixture({
			resolveAgentSessionChildControl: async () => control(),
			requestAgentSessionChildCancellation: async () => ({
				request: {
					cancellation_id: "acc_terminal_child",
					child_run_id: childRunId,
					request_id: "delete-1",
					request_digest: "sha256:terminal-child",
					actor: {
						kind: "parent_materialization" as const,
						parentSessionId: parent.sessionId,
						generation: parent.generation,
						activationId: parent.activationId,
						sandboxId: parent.agentSandboxId,
					},
					reason: `rlm.delete_subagent:${childRunId}`,
					disposition: "terminal_preceded" as const,
					observed_run_state: "completed" as const,
					created_at: 7,
				},
				run: run({ state: "completed", terminal_at: 6 }),
				allocation: accepted().allocation,
				applied: false,
			}),
			requestAgentSessionChildClosure: async () => {
				closureRequested = true;
				return {
					request: closureClaim().request,
					run: closureClaim().run,
					session: closureClaim().session,
					applied: true,
				};
			},
			listAgentSessionChildRunsRequiringRecovery: async () =>
				closureRequested && !closed ? [recoveryRecord()] : [],
			readAgentSession: async () => session({ lifecycle_state: "closing" }),
			claimAgentSessionChildClosureWork: async () => {
				if (!closureRequested || bodyState === "running" || closureClaimed) return null;
				closureClaimed = true;
				return closureClaim();
			},
			renewAgentSessionChildClosureWorkLease: async () => {
				closureRenewals += 1;
				concurrentClosureRenewals += 1;
				maxConcurrentClosureRenewals = Math.max(maxConcurrentClosureRenewals, concurrentClosureRenewals);
				await new Promise((resolve) => setTimeout(resolve, 15));
				concurrentClosureRenewals -= 1;
				return closureClaim();
			},
			recordRecoveredAgentSessionKernelState: async (_id, _generation, input) => {
				assert.equal(input.recoveryToken, "cleanup-token");
				closureKernelState = input.state;
				return {} as never;
			},
			finalizeAgentSessionChildClosure: async (_id, input) => {
				assert.equal(input.cleanupToken, "cleanup-token");
				assert.equal(input.materializationState, "passivated");
				closed = true;
				return { receipt: {} as never, run: closureClaim().run, allocation: accepted().allocation, applied: true };
			},
		});
		const supervisor = service(runtime, {
			cleanup: async (input) => {
				cleanupPhases.push(input.phase);
				if (input.phase === "prepare_closure") {
					bodyState = "passivated";
					return { materializationState: "passivated" };
				}
				assert.equal(input.phase, "closure");
				await new Promise((resolve) => setTimeout(resolve, 50));
				return { materializationState: "passivated", kernelState: "released" };
			},
		});
		await supervisor.start();
		const deleted = await supervisor.handle({
			requestId: "delete-1",
			payload: { type: "rlm.delete_subagent", target: childRunId },
			parent,
		});
		assert.deepEqual(cleanupPhases, ["prepare_closure", "closure"]);
		assert.ok(closureRenewals >= 1);
		assert.equal(
			maxConcurrentClosureRenewals,
			1,
			"closure lease renewals must remain serialized under store latency",
		);
		assert.equal(closureKernelState, "released");
		assert.deepEqual(deleted, {
			closure: {
				child_session_id: childSessionId,
				child_run_id: childRunId,
				name: "researcher",
				model: "mock:done",
				prior_run_state: "completed",
				final_run_state: "completed",
				session_state: "closed",
				cancellation: "not_required",
			},
		});
		await supervisor.stop();
	});

	it("honors a terminal outcome that wins between delete resolution and the atomic cancellation request", async () => {
		let resolved = 0;
		let closureRequests = 0;
		let closureFinished = false;
		const runtime = runtimeFixture({
			resolveAgentSessionChildControl: async () => {
				resolved += 1;
				const terminal = resolved >= 3;
				return {
					child_session_id: childSessionId,
					child_run_id: childRunId,
					child_name: "researcher",
					model: "mock:done",
					run_state: terminal ? ("completed" as const) : ("claimed" as const),
					session_state: closureFinished ? ("closed" as const) : ("open" as const),
				};
			},
			requestAgentSessionChildCancellation: async () => ({
				request: {
					cancellation_id: "acc_terminal_winner",
					child_run_id: childRunId,
					request_id: "delete-race",
					request_digest: "sha256:terminal-winner",
					actor: {
						kind: "parent_materialization",
						parentSessionId: parent.sessionId,
						generation: parent.generation,
						activationId: parent.activationId,
						sandboxId: parent.agentSandboxId,
					},
					reason: `rlm.delete_subagent:${childRunId}`,
					disposition: "terminal_preceded",
					observed_run_state: "claimed",
					created_at: 8,
				},
				run: run({ state: "completed", terminal_at: 7 }),
				allocation: accepted().allocation,
				applied: false,
			}),
			requestAgentSessionChildClosure: async () => {
				closureRequests += 1;
				closureFinished = true;
				return {
					request: {
						closure_id: "acl_terminal_winner",
						child_run_id: childRunId,
						request_id: "delete-race",
						request_digest: "sha256:closure",
						actor: {
							kind: "parent_materialization",
							parentSessionId: parent.sessionId,
							generation: parent.generation,
							activationId: parent.activationId,
							sandboxId: parent.agentSandboxId,
						},
						reason: `rlm.delete_subagent:${childRunId}`,
						disposition: "closure_pending",
						created_at: 8,
					},
					run: run({ state: "completed", terminal_at: 7 }),
					session: session({ status: "completed", lifecycle_state: "closing" }),
					applied: true,
				};
			},
		});
		const supervisor = service(runtime);
		await supervisor.start();
		assert.deepEqual(
			await supervisor.handle({
				requestId: "delete-race",
				payload: { type: "rlm.delete_subagent", target: childRunId },
				parent,
			}),
			{
				closure: {
					child_session_id: childSessionId,
					child_run_id: childRunId,
					name: "researcher",
					model: "mock:done",
					prior_run_state: "completed",
					final_run_state: "completed",
					session_state: "closed",
					cancellation: "not_required",
				},
			},
		);
		assert.equal(closureRequests, 1);
		await supervisor.stop();
	});

	it("reports observed cancellation when cancellation wins the same delete race", async () => {
		let cancelled = false;
		let closureRequests = 0;
		const localExecution = new AbortController();
		localExecution.signal.addEventListener("abort", () => {
			cancelled = true;
		});
		const runtime = runtimeFixture({
			resolveAgentSessionChildControl: async () => ({
				child_session_id: childSessionId,
				child_run_id: childRunId,
				child_name: "researcher",
				model: "mock:done",
				run_state: cancelled ? ("cancelled" as const) : ("claimed" as const),
				session_state: cancelled ? ("closed" as const) : ("open" as const),
			}),
			requestAgentSessionChildCancellation: async () => {
				return {
					request: {
						cancellation_id: "acc_cancellation_winner",
						child_run_id: childRunId,
						request_id: "delete-cancellation-wins",
						request_digest: "sha256:cancellation-winner",
						actor: {
							kind: "parent_materialization" as const,
							parentSessionId: parent.sessionId,
							generation: parent.generation,
							activationId: parent.activationId,
							sandboxId: parent.agentSandboxId,
						},
						reason: `rlm.delete_subagent:${childRunId}`,
						disposition: "cancellation_pending" as const,
						observed_run_state: "claimed" as const,
						created_at: 8,
					},
					run: run({ state: "cancelling" }),
					allocation: accepted().allocation,
					applied: true,
				};
			},
			requestAgentSessionChildClosure: async () => {
				closureRequests += 1;
				throw new Error("cancellation winner must not request terminal closure");
			},
		});
		const supervisor = service(runtime, { heartbeatIntervalMs: 500, controlTimeoutMs: 100 });
		(supervisor as unknown as { executionAborts: Map<string, AbortController> }).executionAborts.set(
			childRunId,
			localExecution,
		);
		await supervisor.start();
		assert.deepEqual(
			await supervisor.handle({
				requestId: "delete-cancellation-wins",
				payload: { type: "rlm.delete_subagent", target: childRunId },
				parent,
			}),
			{
				closure: {
					child_session_id: childSessionId,
					child_run_id: childRunId,
					name: "researcher",
					model: "mock:done",
					prior_run_state: "claimed",
					final_run_state: "cancelled",
					session_state: "closed",
					cancellation: "observed",
				},
			},
		);
		assert.equal(localExecution.signal.aborted, true, "durable cancellation synchronously fences the local executor");
		assert.equal(closureRequests, 0);
		await supervisor.stop();
	});

	it("replays both cancellation dispositions exactly and distinguishes a new terminal delete", async () => {
		for (const disposition of ["cancellation_pending", "cancelled_before_materialization"] as const) {
			const observed = disposition === "cancellation_pending" ? ("claimed" as const) : ("queued" as const);
			let closed = false;
			const records = new Map<
				string,
				{
					readonly actorGeneration: number;
					readonly disposition: typeof disposition | "terminal_preceded";
					readonly observed: "queued" | "claimed" | "cancelled";
				}
			>();
			const runtime = runtimeFixture({
				resolveAgentSessionChildControl: async () => ({
					child_session_id: childSessionId,
					child_run_id: childRunId,
					child_name: "researcher",
					model: "mock:done",
					run_state: closed ? ("cancelled" as const) : observed,
					session_state: closed ? ("closed" as const) : ("open" as const),
				}),
				requestAgentSessionChildCancellation: async (_id, input) => {
					assert.equal(input.actor.kind, "parent_materialization");
					if (input.actor.kind !== "parent_materialization") throw new Error("unexpected cascade actor");
					const replay = records.get(input.requestId);
					if (replay && replay.actorGeneration !== input.actor.generation) {
						throw new AgentSessionChildRunFault("cancellation_conflict", "delete request changed on replay");
					}
					const record =
						replay ??
						(input.requestId === `delete-${disposition}`
							? { actorGeneration: input.actor.generation, disposition, observed }
							: {
									actorGeneration: input.actor.generation,
									disposition: "terminal_preceded" as const,
									observed: "cancelled" as const,
								});
					records.set(input.requestId, record);
					if (record.disposition !== "terminal_preceded") closed = true;
					return {
						request: {
							cancellation_id: `acc_${input.requestId}`,
							child_run_id: childRunId,
							request_id: input.requestId,
							request_digest: `sha256:${input.requestId}`,
							actor: input.actor,
							reason: input.reason,
							disposition: record.disposition,
							observed_run_state: record.observed,
							created_at: input.now,
						},
						run: run({ state: closed ? "cancelled" : observed, terminal_at: closed ? 9 : null }),
						allocation: accepted().allocation,
						applied: replay === undefined,
					};
				},
			});
			const supervisor = service(runtime);
			await supervisor.start();
			const requestId = `delete-${disposition}`;
			const expected = {
				closure: {
					child_session_id: childSessionId,
					child_run_id: childRunId,
					name: "researcher",
					model: "mock:done",
					prior_run_state: observed,
					final_run_state: "cancelled" as const,
					session_state: "closed" as const,
					cancellation: "observed" as const,
				},
			};
			assert.deepEqual(
				await supervisor.handle({
					requestId,
					payload: { type: "rlm.delete_subagent", target: childRunId },
					parent,
				}),
				expected,
			);
			assert.deepEqual(
				await supervisor.handle({
					requestId,
					payload: { type: "rlm.delete_subagent", target: childRunId },
					parent,
				}),
				expected,
				"same delete request must reconstruct its first immutable disposition",
			);
			assert.deepEqual(
				await supervisor.handle({
					requestId: `delete-new-${disposition}`,
					payload: { type: "rlm.delete_subagent", target: childRunId },
					parent,
				}),
				{
					closure: {
						...expected.closure,
						prior_run_state: "cancelled",
						cancellation: "not_required",
					},
				},
			);
			await assert.rejects(
				supervisor.handle({
					requestId,
					payload: { type: "rlm.delete_subagent", target: childRunId },
					parent: { ...parent, generation: parent.generation + 1 },
				}),
				(error: unknown) =>
					error instanceof AgentSessionChildHostRequestFault &&
					error.structured.code === "agent_session_child_run_invalid" &&
					error.structured.class === "conflict",
			);
			await supervisor.stop();
		}
	});

	it("progresses durable descendant cascade actors discovered during recovery scans", async () => {
		let progressed: string | null = null;
		const runtime = runtimeFixture({
			listAgentSessionChildRunsRequiringRecovery: async () => [
				{
					run: run({ state: "cancelling" }),
					allocation: accepted().allocation,
					materialization: null,
					reason: "cancellation_pending",
				},
			],
			listAgentSessionChildCancellationRequests: async () => [
				{
					cancellation_id: "acc_cascade",
					child_run_id: childRunId,
					request_id: "cascade-request",
					request_digest: "sha256:cascade",
					actor: {
						kind: "session_cascade",
						rootSessionId: "ags_root",
						cascadeId: "asc_1",
						causeDigest: "sha256:cause",
					},
					reason: "ancestor cancelled",
					disposition: "cancellation_pending",
					observed_run_state: "claimed",
					created_at: 4,
				},
			],
			progressAgentSessionDescendantCascade: async (cascadeId) => {
				progressed = cascadeId;
				return {
					cascade_id: cascadeId,
					root_session_id: "ags_root",
					cause: "explicit_cancel",
					cause_digest: "sha256:cause",
					reason: "ancestor cancelled",
					state: "active",
					created_at: 3,
					completed_at: null,
				};
			},
		});
		const supervisor = service(runtime);
		await supervisor.start();
		assert.equal(progressed, "asc_1");
		await supervisor.stop();
	});

	it("defers foreign live-body cleanup without starving the store-fenced closure lane", async () => {
		let closureClaims = 0;
		let cleanupAttempts = 0;
		const runtime = runtimeFixture({
			listAgentSessionChildRunsRequiringRecovery: async () => [
				{
					run: run({ state: "completed", claim_expires_at: 0, terminal_at: 5 }),
					allocation: accepted().allocation,
					materialization: materialization(),
					reason: "materialized_lease_expired",
				},
			],
			readAgentSession: async () => session({ lifecycle_state: "closing" }),
			claimAgentSessionChildClosureWork: async () => {
				closureClaims += 1;
				return null;
			},
		});
		const supervisor = service(runtime, {
			cleanup: async (input) => {
				assert.equal(input.phase, "prepare_closure");
				cleanupAttempts += 1;
				throw new AgentSessionChildCleanupUnavailable();
			},
		});
		await supervisor.start();
		assert.equal(cleanupAttempts, 1);
		assert.equal(closureClaims, 1, "an unrelated terminal closure remains claimable");
		await supervisor.stop();
	});

	it("lists only the runtime's open controls and rejects mutable delete targets before store access", async () => {
		let resolved = false;
		const runtime = runtimeFixture({
			listAgentSessionChildControls: async (_parentId, input) => {
				assert.equal(input?.includeClosed, undefined);
				return [
					{
						child_session_id: childSessionId,
						child_run_id: childRunId,
						child_name: "researcher",
						model: "mock:done",
						run_state: "claimed",
						session_state: "open",
					},
				];
			},
			resolveAgentSessionChildControl: async () => {
				resolved = true;
				return null;
			},
		});
		const supervisor = service(runtime);
		await supervisor.start();
		assert.deepEqual(
			await supervisor.handle({ requestId: "list-1", payload: { type: "rlm.list_subagents" }, parent }),
			{
				subagents: [
					{
						child_session_id: childSessionId,
						child_run_id: childRunId,
						name: "researcher",
						model: "mock:done",
						run_state: "claimed",
						session_state: "open",
					},
				],
			},
		);
		await assert.rejects(
			supervisor.handle({
				requestId: "delete-1",
				payload: { type: "rlm.delete_subagent", target: "researcher" },
				parent,
			}),
			(error: unknown) => {
				assert.ok(error instanceof AgentSessionChildHostRequestFault);
				assert.deepEqual(error.structured, {
					code: "rlm_control_invalid",
					class: "invalid",
					message: "rlm.delete_subagent target must be an immutable child run id",
					retryable: false,
				});
				return true;
			},
		);
		assert.equal(resolved, false);
		await supervisor.stop();
	});

	it("fails closed when durable run, list, or delete testimony would produce a malformed RLM result", async () => {
		const assertInternalResultFault = (error: unknown): boolean => {
			assert.ok(error instanceof AgentSessionChildHostRequestFault);
			assert.equal(error.structured.code, "rlm_host_result_invalid");
			assert.equal(error.structured.class, "internal");
			assert.equal(error.structured.retryable, false);
			return true;
		};

		let claims = 0;
		const malformedRun = service(
			runtimeFixture({
				admitAgentSessionChild: async () => {
					const admission = accepted();
					return {
						...admission,
						admission: { ...admission.admission, child_name: "not valid" },
					};
				},
				claimAgentSessionChildRun: async () => {
					claims += 1;
					return claimed();
				},
			}),
		);
		await malformedRun.start();
		await assert.rejects(
			malformedRun.handle({
				requestId: "malformed-run",
				payload: { type: "rlm.run", prompt: "inspect", kwargs: {} },
				parent,
			}),
			assertInternalResultFault,
		);
		malformedRun.wake();
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(claims, 0, "malformed durable handle must not schedule execution");
		await malformedRun.stop();

		const closedLeak = service(
			runtimeFixture({
				listAgentSessionChildControls: async () => [
					{
						child_session_id: childSessionId,
						child_run_id: childRunId,
						child_name: "researcher",
						model: "mock:done",
						run_state: "completed",
						session_state: "closed",
					},
				],
			}),
		);
		await closedLeak.start();
		await assert.rejects(
			closedLeak.handle({ requestId: "closed-leak", payload: { type: "rlm.list_subagents" }, parent }),
			assertInternalResultFault,
		);
		await closedLeak.stop();

		const malformedDelete = service(
			runtimeFixture({
				resolveAgentSessionChildControl: async () => ({
					child_session_id: childSessionId,
					child_run_id: childRunId,
					child_name: "not valid",
					model: "mock:done",
					run_state: "completed",
					session_state: "closed",
				}),
				requestAgentSessionChildCancellation: async (_id, input) => ({
					request: {
						cancellation_id: "acc_malformed_delete",
						child_run_id: childRunId,
						request_id: input.requestId,
						request_digest: "sha256:malformed-delete",
						actor: input.actor,
						reason: input.reason,
						disposition: "terminal_preceded",
						observed_run_state: "completed",
						created_at: input.now,
					},
					run: run({ state: "completed", terminal_at: 5 }),
					allocation: accepted().allocation,
					applied: false,
				}),
			}),
		);
		await malformedDelete.start();
		await assert.rejects(
			malformedDelete.handle({
				requestId: "malformed-delete",
				payload: { type: "rlm.delete_subagent", target: childRunId },
				parent,
			}),
			assertInternalResultFault,
		);
		await malformedDelete.stop();
	});

	it("maps durable admission denial and conflicting replay into exact structured host errors", async () => {
		const denied = service(
			runtimeFixture({
				admitAgentSessionChild: async () => ({
					decision: "denied",
					request: {
						parent_session_id: parent.sessionId,
						request_id: "request-denied",
						request_digest: "sha256:denied",
						decision: "denied",
						admission_id: null,
						child_session_id: null,
						child_run_id: null,
						denial_code: "children_not_granted",
						denial_message: "Hosted children are not granted",
						created_at: 1,
					},
					created: true,
				}),
			}),
		);
		await denied.start();
		await assert.rejects(
			denied.handle({
				requestId: "request-denied",
				payload: { type: "rlm.run", prompt: "inspect", kwargs: {} },
				parent,
			}),
			(error: unknown) => {
				assert.ok(error instanceof AgentSessionChildHostRequestFault);
				assert.deepEqual(error.structured, {
					code: "children_not_granted",
					class: "denied",
					message: "Hosted children are not granted",
					retryable: false,
				});
				return true;
			},
		);
		await denied.stop();

		const conflict = service(
			runtimeFixture({
				admitAgentSessionChild: async () => {
					throw new AgentSessionChildAdmissionFault("request_conflict", "request content changed on replay");
				},
			}),
		);
		await conflict.start();
		await assert.rejects(
			conflict.handle({
				requestId: "request-conflict",
				payload: { type: "rlm.run", prompt: "inspect", kwargs: {} },
				parent,
			}),
			(error: unknown) => {
				assert.ok(error instanceof AgentSessionChildHostRequestFault);
				assert.deepEqual(error.structured, {
					code: "rlm_run_request_conflict",
					class: "conflict",
					message: "request content changed on replay",
					retryable: false,
				});
				return true;
			},
		);
		await conflict.stop();
	});

	it("replays the exact durable handle after terminal settlement without executing the child again", async () => {
		let claimAttempts = 0;
		let executions = 0;
		let settled = false;
		const runtime = runtimeFixture({
			admitAgentSessionChild: async () => ({ ...accepted(), created: !settled }),
			claimAgentSessionChildRun: async () => {
				claimAttempts += 1;
				return settled
					? { ...claimed(), run: run({ state: "completed", terminal_at: 10 }), claimed: false }
					: claimed();
			},
			claimAgentSessionChildMaterialization: async () => materialization(),
			readAgentSessionChildRun: async () => run(),
			settleAgentSessionChildRun: async () => {
				settled = true;
				return {
					run: run({ state: "completed", terminal_at: 10 }),
					allocation: accepted().allocation,
					applied: true,
				};
			},
		});
		const supervisor = service(runtime, {
			execute: async () => {
				executions += 1;
				return { result: result(), materialization: materialization({ state: "completed" }) };
			},
		});
		await supervisor.start();
		const request = {
			requestId: "request-1",
			payload: { type: "rlm.run", prompt: "Inspect bounded evidence", kwargs: {} },
			parent,
		} as const;
		const first = await supervisor.handle(request);
		supervisor.wake();
		await eventually(() => settled, "first child did not settle");
		const replay = await supervisor.handle(request);
		assert.deepEqual(replay, first);
		supervisor.wake();
		await eventually(() => claimAttempts >= 2, "terminal replay was not durably checked");
		assert.equal(executions, 1);
		await supervisor.stop();
	});

	it("keeps admission and settlement authoritative when durable display wakeups fail", async () => {
		let settled = false;
		let notifications = 0;
		const errors: string[] = [];
		const originalConsoleError = console.error;
		console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
		try {
			const runtime = runtimeFixture({
				admitAgentSessionChild: async () => accepted(),
				claimAgentSessionChildRun: async () => claimed(),
				claimAgentSessionChildMaterialization: async () => materialization(),
				readAgentSessionChildRun: async () => run(),
				settleAgentSessionChildRun: async () => {
					settled = true;
					return { run: run({ state: "completed" }), allocation: accepted().allocation, applied: true };
				},
			});
			const supervisor = service(runtime, {
				onDurableChange: async () => {
					notifications += 1;
					throw new Error("projection unavailable");
				},
			});
			await supervisor.start();
			const handle = await supervisor.handle({
				requestId: "request-1",
				payload: { type: "rlm.run", prompt: "Inspect bounded evidence", kwargs: {} },
				parent,
			});
			assert.equal("child_run_id" in handle && handle.child_run_id, childRunId);
			supervisor.wake();
			await eventually(() => settled, "settlement was rolled back by display failure");
			assert.ok(notifications >= 2);
			assert.ok(errors.every((entry) => entry.includes("durable change notification failed")));
			await supervisor.stop();
		} finally {
			console.error = originalConsoleError;
		}
	});

	it("re-enters a real admitted child through makeRuntimeNodeRunner without duplicating source, Session, run, or generation", async () => {
		const directory = mkdtempSync(join(tmpdir(), "child-runtime-reentry-"));
		const runtime = new WorkflowRuntimeStore(join(directory, "runtime.sqlite"));
		try {
			await runtime.init();
			const runId = "wfr-child-reentry";
			const workflowName = "domain-agent-activity-loop-v1";
			const graphId = "graph-child-reentry";
			const ownerUserId = "user:child-reentry";
			const parentSessionId = "ags-child-reentry-parent";
			const pilot = makeTestAgentSemanticBinding({ graphId, kind: "prime", registeredName: "phanes" });
			const emanation = makeTestAgentSemanticBinding({ graphId, kind: "simple", registeredName: "phanes" });
			await runtime.createWorkflowInstance({
				runId,
				workflowName,
				graphId,
				ownerUserId,
				inputs: {
					hostContext: {
						schema: "sophia.domain-agent-host-context.v1",
						runtimes: { pilot: pilot.runtime, emanation: emanation.runtime },
						ontologies: { pilot: pilot.ontology, emanation: emanation.ontology },
						emanation: {
							enabled: true,
							provider: "openrouter",
							model: "mock:done",
							maxEmanations: 1,
							maxTurns: emanation.runtime.constraints.maxTurns,
						},
						emanationToolInclude: [],
						systemPrompt: "You are Phanes.",
						toolbelt: { tools: [] },
					},
				},
				startedAt: 1,
			});
			const pilotSpec: AgentNodeSpec = {
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
				ownerUserId,
				graphOwnerPrincipal: "organization:child-runtime-lab",
				spec: pilotSpec,
				nodeKey: "1:pilot-attend",
				frontier: { kind: "before-node", sessionId: parentSessionId, phaseIndex: 1, ts: 1 },
				now: 1,
			});
			await runtime.claimAgentMaterialization(parentSessionId, {
				generation: 0,
				activationId: "parent-activation",
				now: 2,
			});
			await runtime.bindAgentSandbox(parentSessionId, {
				sandboxId: "sbx-parent",
				generation: 0,
				activationId: "parent-activation",
				now: 3,
			});
			await runtime.heartbeatAgentMaterialization(parentSessionId, 0, {
				activationId: "parent-activation",
				now: Date.now(),
			});

			let executions = 0;
			let outcomeRaceReady!: () => void;
			const outcomeReady = new Promise<void>((resolve) => {
				outcomeRaceReady = resolve;
			});
			let releaseOutcomeRace!: () => void;
			const outcomeReleased = new Promise<void>((resolve) => {
				releaseOutcomeRace = resolve;
			});
			const memory = new AgentMemory(
				SophiaContentStore.fromUrl(new URL("cas/", `file://${directory}/`).toString()),
				runtime,
			);
			const supervisor = new AgentSessionChildExecutionService({
				runtime,
				pollIntervalMs: 0,
				leaseMs: 30_000,
				heartbeatIntervalMs: 100,
				cleanup: async () => ({ materializationState: "completed" }),
				execute: async ({ claim, materialization: admittedMaterialization }) => {
					executions += 1;
					const childSandboxId = `sbx-${claim.child.session_id}`;
					const runner = makeRuntimeNodeRunner({
						runtime,
						memory,
						runId: claim.child.run_id,
						workflowName: claim.child.workflow_name,
						graphId: claim.child.graph_id,
						ownerUserId: claim.child.owner_user_id,
						graphOwnerPrincipal: claim.child.graph_owner_principal,
						childRunLease: {
							consumer: claim.run.consumer!,
							claimToken: claim.run.claim_token!,
						},
						baseRunner: async (childSpec) => {
							await runtime.bindAgentSandbox(childSpec.sessionId!, {
								sandboxId: childSandboxId,
								generation: childSpec.sandboxGeneration ?? 0,
								activationId: childSpec.invocationId!,
								childRunConsumer: claim.run.consumer!,
								childRunClaimToken: claim.run.claim_token!,
								now: Date.now(),
							});
							return {
								...result(childSpec.prompt.startsWith("Fail") ? "error" : "done"),
								nodeKey: childSpec.nodeKey,
								sessionId: childSpec.sessionId,
								invocationId: childSpec.invocationId,
								label: childSpec.label,
								phaseIndex: childSpec.phaseIndex,
								model: childSpec.model,
							};
						},
					});
					const nodeResult = await runner({ ...claim.spec, sandboxGeneration: 0 });
					if (claim.spec.prompt === "Race outcome.") {
						outcomeRaceReady();
						await outcomeReleased;
					}
					const finished =
						nodeResult.state === "error"
							? await runtime.finishAgentMaterialization(claim.child.session_id, 0, {
									activationId: admittedMaterialization.activation_id,
									from: "running",
									to: "faulted",
									faultKind: "worker_exit",
									recoverable: false,
									now: Date.now(),
								})
							: await runtime.finishAgentMaterialization(claim.child.session_id, 0, {
									activationId: admittedMaterialization.activation_id,
									from: "running",
									to: "completed",
									now: Date.now(),
								});
					return { result: nodeResult, materialization: finished };
				},
			});
			await supervisor.start();
			const parentContext = {
				sessionId: parentSessionId,
				generation: 0,
				activationId: "parent-activation",
				agentSandboxId: "sbx-parent",
				ownerUserId,
				graphOwnerPrincipal: "organization:child-runtime-lab",
				graphId,
			};
			const admitted = await supervisor.handle({
				requestId: "rlm-request-reentry",
				payload: { type: "rlm.run", prompt: "Inspect once.", kwargs: { name: "reader" } },
				parent: parentContext,
			});
			assert.ok("child_session_id" in admitted);
			if (!("child_session_id" in admitted)) return;
			supervisor.wake();
			await eventually(() => executions === 1, "real admitted child never entered the runtime runner");
			for (let attempt = 0; attempt < 100; attempt += 1) {
				if ((await runtime.readAgentSessionChildRun(admitted.child_run_id))?.state === "completed") break;
				await new Promise((resolve) => setTimeout(resolve, 2));
			}
			assert.equal((await runtime.readAgentSessionChildRun(admitted.child_run_id))?.state, "completed");

			const replay = await supervisor.handle({
				requestId: "rlm-request-reentry",
				payload: { type: "rlm.run", prompt: "Inspect once.", kwargs: { name: "reader" } },
				parent: parentContext,
			});
			assert.deepEqual(replay, admitted);
			supervisor.wake();
			await new Promise((resolve) => setTimeout(resolve, 10));

			const sessions = await runtime.listAgentSessionsForRun(runId);
			const childRows = sessions.filter((row) => row.session_id === admitted.child_session_id);
			assert.equal(childRows.length, 1, "admission and runtime re-entry share one durable Session row");
			const child = childRows[0]!;
			const document = JSON.parse(child.document_json) as Record<string, any>;
			assert.equal(document.source.kind, "child-admission");
			assert.equal(document.source.childRunId, admitted.child_run_id);
			assert.equal(document.meaningfulObjects.workflowNode, undefined);
			assert.deepEqual(
				(await runtime.listAgentSessionDocumentOps(child.session_id)).map((operation) => operation.kind),
				["session.created", "session.queued", "runtime.bound", "session.outcome.completed"],
			);
			assert.deepEqual(
				(await runtime.listAgentSessionEvents(child.session_id)).map((event) => event.type),
				["session.queued", "budget.ledger_updated", "session.queued", "runtime.bound", "session.closed"],
			);
			const generationZero = await runtime.readAgentMaterialization(child.session_id, 0);
			assert.ok(generationZero);
			assert.equal(generationZero.sandbox_id, `sbx-${admitted.child_session_id}`);
			assert.equal(generationZero.activation_id, admitted.child_run_id);
			assert.equal(generationZero.state, "completed");
			assert.equal(await runtime.readAgentMaterialization(child.session_id, 1), null);
			assert.equal(executions, 1, "durable replay cannot enter the runtime runner twice");
			assert.equal((await runtime.readAgentSessionChildRun(admitted.child_run_id))?.state, "completed");
			assert.equal(
				(await runtime.listAgentSessionEvents(parentSessionId)).filter(
					(event) => event.type === "child.run.completed",
				).length,
				1,
			);

			const raced = await supervisor.handle({
				requestId: "rlm-request-outcome-race",
				payload: { type: "rlm.run", prompt: "Race outcome.", kwargs: { name: "racer" } },
				parent: parentContext,
			});
			assert.ok("child_session_id" in raced);
			if (!("child_session_id" in raced)) return;
			supervisor.wake();
			await waitWithDeadline(outcomeReady, "raced child never reached the outcome hold");
			const deletion = supervisor.handle({
				requestId: "delete-outcome-race",
				payload: { type: "rlm.delete_subagent", target: raced.child_run_id },
				parent: parentContext,
			});
			for (let attempt = 0; attempt < 100; attempt += 1) {
				if ((await runtime.listAgentSessionChildCancellationRequests(raced.child_run_id)).length > 0) break;
				await new Promise((resolve) => setTimeout(resolve, 2));
			}
			const raceCancellation = (await runtime.listAgentSessionChildCancellationRequests(raced.child_run_id))[0];
			assert.equal(raceCancellation?.disposition, "terminal_preceded");
			assert.equal(raceCancellation?.observed_run_state, "claimed");
			releaseOutcomeRace();
			assert.deepEqual(await waitWithDeadline(deletion, "raced child deletion did not settle"), {
				closure: {
					child_session_id: raced.child_session_id,
					child_run_id: raced.child_run_id,
					name: "racer",
					model: "mock:done",
					prior_run_state: "completed",
					final_run_state: "completed",
					session_state: "closed",
					cancellation: "not_required",
				},
			});
			assert.deepEqual(
				await supervisor.handle({
					requestId: "delete-outcome-race",
					payload: { type: "rlm.delete_subagent", target: raced.child_run_id },
					parent: parentContext,
				}),
				{
					closure: {
						child_session_id: raced.child_session_id,
						child_run_id: raced.child_run_id,
						name: "racer",
						model: "mock:done",
						prior_run_state: "completed",
						final_run_state: "completed",
						session_state: "closed",
						cancellation: "not_required",
					},
				},
				"closed delete replay must preserve its first immutable result",
			);
			assert.deepEqual(
				await supervisor.handle({
					requestId: "delete-outcome-race-new",
					payload: { type: "rlm.delete_subagent", target: raced.child_run_id },
					parent: parentContext,
				}),
				{
					closure: {
						child_session_id: raced.child_session_id,
						child_run_id: raced.child_run_id,
						name: "racer",
						model: "mock:done",
						prior_run_state: "completed",
						final_run_state: "completed",
						session_state: "closed",
						cancellation: "not_required",
					},
				},
				"a new delete after terminal closure must be independently not-required",
			);
			await assert.rejects(
				supervisor.handle({
					requestId: "delete-outcome-race",
					payload: { type: "rlm.delete_subagent", target: raced.child_run_id },
					parent: { ...parentContext, generation: 1 },
				}),
				(error: unknown) =>
					error instanceof AgentSessionChildHostRequestFault && error.structured.class === "conflict",
				"a changed durable delete digest must conflict after closure",
			);

			const failed = await supervisor.handle({
				requestId: "rlm-request-failure",
				payload: { type: "rlm.run", prompt: "Fail once.", kwargs: { name: "critic" } },
				parent: parentContext,
			});
			assert.ok("child_session_id" in failed);
			if (!("child_session_id" in failed)) return;
			supervisor.wake();
			for (let attempt = 0; attempt < 100; attempt += 1) {
				if ((await runtime.readAgentSessionChildRun(failed.child_run_id))?.state === "failed") break;
				await new Promise((resolve) => setTimeout(resolve, 2));
			}
			const failedRun = await runtime.readAgentSessionChildRun(failed.child_run_id);
			const failedSession = await runtime.readAgentSession(failed.child_session_id);
			assert.equal(failedRun?.state, "failed");
			assert.equal(failedSession?.status, "failed");
			assert.equal(failedSession?.lifecycle_state, "closed");
			assert.equal((await runtime.readAgentMaterialization(failed.child_session_id, 0))?.state, "faulted");
			assert.equal(
				(await runtime.listAgentSessionEvents(parentSessionId)).filter(
					(event) =>
						event.type === "child.run.failed" &&
						(event.payload as { childRunId?: string }).childRunId === failed.child_run_id,
				).length,
				1,
			);
			assert.equal(
				(await runtime.listAgentSessionEvents(failed.child_session_id)).filter(
					(event) => event.type === "session.faulted",
				).length,
				0,
			);
			assert.equal((await runtime.readAgentSession(parentSessionId))?.lifecycle_state, "open");
			assert.equal(
				(await runtime.listClaimableAgentSessionChildRuns({ now: Date.now() })).some(
					(candidate) => candidate.child_run_id === failed.child_run_id,
				),
				false,
				"simple failure must not orphan execution-reclaimable work",
			);
			assert.equal(executions, 3);
			await supervisor.stop();
		} finally {
			runtime.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("stop latches claims while abort plus post-body-kill drain forms the final durable-write barrier", async () => {
		let claims = 0;
		let executionStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			executionStarted = resolve;
		});
		let releaseBody!: () => void;
		const bodyKilled = new Promise<void>((resolve) => {
			releaseBody = resolve;
		});
		let abortObserved = false;
		let durableWrites = 0;
		const runtime = runtimeFixture({
			listClaimableAgentSessionChildRuns: async () => [run({ state: "queued" })],
			claimAgentSessionChildRun: async () => {
				claims += 1;
				return claimed();
			},
			claimAgentSessionChildMaterialization: async () => materialization(),
			readAgentSessionChildRun: async () => {
				durableWrites += 1;
				return null;
			},
		});
		const supervisor = service(runtime, {
			execute: async ({ signal }) => {
				executionStarted();
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
				abortObserved = true;
				await bodyKilled;
				throw new Error("worker body terminated during shutdown");
			},
		});
		await supervisor.start();
		await waitWithDeadline(started, "child execution did not start before shutdown");
		await supervisor.stop();
		supervisor.abortExecutions();
		await eventually(() => abortObserved, "logical child execution did not observe shutdown abort");
		let drained = false;
		const drain = supervisor.awaitExecutionDrain().then(() => {
			drained = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(drained, false, "execution drain crossed the still-live worker body");
		releaseBody();
		await waitWithDeadline(drain, "child execution did not drain after body termination");
		assert.equal(durableWrites, 0);
		supervisor.wake();
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(claims, 1);
	});
});
