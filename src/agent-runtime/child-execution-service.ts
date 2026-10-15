import { randomUUID } from "node:crypto";
import {
	type AdmitAgentSessionChildResult,
	type AgentMaterializationFaultKind,
	type AgentMaterializationRecord,
	type AgentMaterializationRecoveryClaim,
	AgentSessionChildAdmissionFault,
	type AgentSessionChildClosureWorkClaim,
	type AgentSessionChildRunClaim,
	AgentSessionChildRunFault,
	type AgentSessionChildRunRecoveryRecord,
	type AgentSessionChildRunState,
	type AgentSessionKernelState,
	type WorkflowRuntimeStore,
} from "../workflow/runtime-store.js";
import type { AgentNodeResult } from "../workflow/types.js";
import {
	parseRlmControlRequest,
	parseRlmDeleteSubagentResult,
	parseRlmListSubagentsResult,
	parseRlmSpawnHandle,
	RlmControlContractFault,
	type RlmControlRequest,
	type RlmDeleteSubagentResult,
	type RlmHostError,
	type RlmHostErrorClass,
	type RlmListSubagentsResult,
	type RlmSpawnHandle,
} from "./rlm-control-contract.js";

export interface AgentSessionChildParentContext {
	readonly sessionId: string;
	readonly generation: number;
	readonly activationId: string;
	readonly agentSandboxId: string;
	readonly ownerUserId: string;
	readonly graphOwnerPrincipal: string;
	readonly graphId: string;
}

/** Authority reconstructed from durable child testimony, never a parent bearer. */
export interface AgentSessionChildDurableAuthority {
	readonly ownerUserId: string;
	readonly graphOwnerPrincipal: string;
	readonly graphId: string;
}

export interface AgentSessionChildExecutionResult {
	/** The immutable logical result already written by the node runner. */
	readonly result: AgentNodeResult;
	/** Latest body testimony after the logical run returned. */
	readonly materialization: AgentMaterializationRecord;
}

export type AgentSessionChildCleanupInput =
	| {
			readonly phase: "prepare_closure";
			readonly terminalIntent: "cancelled";
			readonly materialization: AgentMaterializationRecord;
			readonly authority: AgentSessionChildDurableAuthority;
			readonly reason: string;
	  }
	| {
			readonly phase: "recovery";
			readonly terminalIntent: "completed" | "cancelled" | "faulted";
			readonly claim: AgentMaterializationRecoveryClaim;
			readonly authority: AgentSessionChildDurableAuthority;
			readonly reason: string;
	  }
	| {
			readonly phase: "closure";
			readonly terminalIntent: "cancelled";
			readonly claim: AgentSessionChildClosureWorkClaim;
			readonly authority: AgentSessionChildDurableAuthority;
			readonly reason: string;
	  };

export interface AgentSessionChildCleanupResult {
	readonly materializationState: "passivated" | "completed" | "faulted" | "cancelled";
	readonly faultKind?: AgentMaterializationFaultKind;
	readonly recoverable?: boolean;
	/** Omit for a simple body. Persistent kernels must return terminal testimony. */
	readonly kernelState?: Exclude<AgentSessionKernelState, "running">;
}

/** Active-only closure preparation found no local body; durable recovery must arbitrate it. */
export class AgentSessionChildCleanupUnavailable extends Error {
	readonly code = "agent_session_child_cleanup_unavailable";

	constructor(message = "No locally owned child body is available for active cleanup") {
		super(message);
		this.name = "AgentSessionChildCleanupUnavailable";
	}
}

export class AgentSessionChildHostRequestFault extends Error {
	readonly structured: RlmHostError;

	constructor(
		readonly code: string,
		readonly errorClass: RlmHostErrorClass,
		message: string,
		readonly retryable = false,
	) {
		super(message);
		this.name = "AgentSessionChildHostRequestFault";
		this.structured = { code, class: errorClass, message, retryable };
	}
}

type ChildRuntime = Pick<
	WorkflowRuntimeStore,
	| "admitAgentSessionChild"
	| "claimAgentSessionChildRun"
	| "renewAgentSessionChildRunLease"
	| "claimAgentSessionChildMaterialization"
	| "failUnboundAgentSessionChildRun"
	| "heartbeatAgentMaterialization"
	| "settleAgentSessionChildRun"
	| "readAgentMaterialization"
	| "readAgentSession"
	| "readAgentSessionChildRun"
	| "listAgentSessionChildControls"
	| "resolveAgentSessionChildControl"
	| "listAgentSessionChildCancellationRequests"
	| "listClaimableAgentSessionChildRuns"
	| "listAgentSessionChildRunsRequiringRecovery"
	| "reconcileAgentSessionChildAccountingHold"
	| "requestAgentSessionChildCancellation"
	| "requestAgentSessionChildClosure"
	| "progressAgentSessionDescendantCascade"
	| "claimAgentMaterializationRecovery"
	| "renewAgentMaterializationRecoveryLease"
	| "finishRecoveredAgentMaterialization"
	| "recordRecoveredAgentSessionKernelState"
	| "settleRecoveredAgentSessionChildRun"
	| "claimAgentSessionChildClosureWork"
	| "renewAgentSessionChildClosureWorkLease"
	| "finalizeAgentSessionChildClosure"
>;

export interface AgentSessionChildExecutionServiceOptions {
	readonly runtime: ChildRuntime;
	readonly execute: (input: {
		readonly claim: AgentSessionChildRunClaim;
		readonly materialization: AgentMaterializationRecord;
		readonly authority: AgentSessionChildDurableAuthority;
		readonly signal: AbortSignal;
	}) => Promise<AgentSessionChildExecutionResult>;
	/** Physical cleanup adapter. Recovery durability remains owned by this service. */
	readonly cleanup: (input: AgentSessionChildCleanupInput) => Promise<AgentSessionChildCleanupResult>;
	/** Wakes the durable display outbox; failures never roll back lifecycle truth. */
	readonly onDurableChange?: (sessionIds: readonly string[]) => void | Promise<void>;
	readonly now?: () => number;
	readonly consumer?: string;
	readonly leaseMs?: number;
	readonly heartbeatIntervalMs?: number;
	readonly pollIntervalMs?: number;
	readonly controlTimeoutMs?: number;
	readonly wait?: (milliseconds: number) => Promise<void>;
}

const LIVE_MATERIALIZATION_STATES = new Set(["claimed", "running", "quiescing", "quiescent"]);
const TERMINAL_RUN_STATES = new Set<AgentSessionChildRunState>(["completed", "failed", "cancelled"]);

/**
 * Durable F5 supervisor and exact RLM control dispatcher.
 *
 * `start` performs a finite restart scan before resolving. Long-running node
 * bodies remain detached: their durable leases, not an in-memory Promise, are
 * the restart authority. `stop` latches before waiting for finite pump work and
 * deliberately does not wait for resident bodies.
 */
export class AgentSessionChildExecutionService {
	private readonly now: () => number;
	private readonly consumer: string;
	private readonly leaseMs: number;
	private readonly heartbeatIntervalMs: number;
	private readonly pollIntervalMs: number;
	private readonly controlTimeoutMs: number;
	private readonly wait: (milliseconds: number) => Promise<void>;
	private readonly executions = new Map<string, Promise<void>>();
	private readonly executionAborts = new Map<string, AbortController>();
	private readonly executionHeartbeats = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly executionHeartbeatTasks = new Map<string, Promise<void>>();
	private readonly pendingRuns = new Set<string>();
	private readonly withheldRuns = new Set<string>();
	private readonly deferredWakeTimers = new Set<ReturnType<typeof setTimeout>>();
	private admissionsInProgress = 0;
	private pumpChain: Promise<void> = Promise.resolve();
	private pollTimer: ReturnType<typeof setTimeout> | null = null;
	private started = false;
	private stopping = false;

	constructor(private readonly options: AgentSessionChildExecutionServiceOptions) {
		this.now = options.now ?? Date.now;
		this.consumer = options.consumer ?? `choreograph-child:${process.pid}:${randomUUID()}`;
		this.leaseMs = positiveInteger(options.leaseMs ?? 30_000, "child supervisor leaseMs");
		this.heartbeatIntervalMs = positiveInteger(
			options.heartbeatIntervalMs ?? Math.max(250, Math.floor(this.leaseMs / 3)),
			"child supervisor heartbeatIntervalMs",
		);
		if (this.heartbeatIntervalMs >= this.leaseMs) {
			throw new Error("child supervisor heartbeatIntervalMs must be shorter than leaseMs");
		}
		this.pollIntervalMs = nonnegativeInteger(options.pollIntervalMs ?? 1_000, "child supervisor pollIntervalMs");
		this.controlTimeoutMs = positiveInteger(options.controlTimeoutMs ?? 30_000, "child control timeout");
		this.wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
	}

	async start(): Promise<void> {
		if (this.started) return;
		if (this.stopping) throw new Error("child supervisor cannot restart after stop");
		this.started = true;
		try {
			await this.enqueuePump(true);
		} catch (error) {
			// A poisoned recovery item must not keep the whole orchestrator down:
			// steady-state pump failures are already logged-and-survived (see
			// enqueuePump), so the startup pass gets the same discipline. The
			// poll loop below keeps retrying recovery; everything else boots.
			console.error(`[children] startup supervisor pump failed: ${boundedErrorMessage(error)}`);
		}
		this.armPoll();
	}

	/** Hint that durable work may now be claimable. Calls coalesce. */
	wake(): void {
		if (!this.started || this.stopping) return;
		void this.enqueuePump(false);
	}

	async stop(): Promise<void> {
		if (this.stopping) return this.pumpChain;
		this.stopping = true;
		if (this.pollTimer) clearTimeout(this.pollTimer);
		this.pollTimer = null;
		for (const timer of this.deferredWakeTimers) clearTimeout(timer);
		this.deferredWakeTimers.clear();
		for (const timer of this.executionHeartbeats.values()) clearTimeout(timer);
		this.executionHeartbeats.clear();
		await Promise.allSettled([...this.executionHeartbeatTasks.values()]);
		await this.pumpChain;
	}

	/** Abort logical child runners before the host begins killing their bodies. */
	abortExecutions(reason: unknown = new Error("Child supervisor shutdown")): void {
		for (const abort of this.executionAborts.values()) {
			if (!abort.signal.aborted) abort.abort(reason);
		}
	}

	/**
	 * Post-body-kill barrier. Once stop() has latched new claims, this resolves
	 * only after every previously admitted executor has ceased durable writes.
	 */
	async awaitExecutionDrain(): Promise<void> {
		while (this.executions.size > 0) {
			await Promise.allSettled([...this.executions.values()]);
		}
	}

	async handle(input: {
		readonly requestId: string;
		readonly payload: unknown;
		readonly parent: AgentSessionChildParentContext;
	}): Promise<RlmSpawnHandle | RlmListSubagentsResult | RlmDeleteSubagentResult> {
		if (this.stopping) {
			throw new AgentSessionChildHostRequestFault(
				"rlm_host_stopping",
				"unavailable",
				"Child supervisor is stopping",
				true,
			);
		}
		let request: RlmControlRequest;
		try {
			request = parseRlmControlRequest(input.payload);
		} catch (error) {
			throw hostFault(error);
		}
		try {
			if (request.type === "rlm.run") return await this.handleRun(input.requestId, request, input.parent);
			if (request.type === "rlm.list_subagents") return await this.handleList(input.parent);
			return await this.handleDelete(input.requestId, request.target, input.parent);
		} catch (error) {
			throw hostFault(error);
		}
	}

	private async handleRun(
		requestId: string,
		request: Extract<RlmControlRequest, { type: "rlm.run" }>,
		parent: AgentSessionChildParentContext,
	): Promise<RlmSpawnHandle> {
		let admitted: AdmitAgentSessionChildResult;
		this.admissionsInProgress += 1;
		try {
			admitted = await this.options.runtime.admitAgentSessionChild(parent.sessionId, {
				requestId: requireRequestId(requestId),
				parentGeneration: parent.generation,
				parentActivationId: parent.activationId,
				parentSandboxId: parent.agentSandboxId,
				prompt: request.prompt,
				...(request.kwargs.name === undefined ? {} : { requestedName: request.kwargs.name }),
				...(request.kwargs.model === undefined ? {} : { requestedModel: request.kwargs.model }),
				causationId: requestId,
				now: this.now(),
			});
			if (admitted.decision === "accepted") this.withheldRuns.add(admitted.run.child_run_id);
		} finally {
			this.admissionsInProgress -= 1;
		}
		if (admitted.decision === "denied") {
			throw new AgentSessionChildHostRequestFault(
				admitted.request.denial_code ?? "child_spawn_denied",
				"denied",
				admitted.request.denial_message ?? "Child admission was denied",
			);
		}
		const handle: RlmSpawnHandle = {
			child_session_id: admitted.admission.child_session_id,
			child_run_id: admitted.admission.child_run_id,
			name: admitted.admission.child_name,
			model: admitted.spec.model,
		};
		try {
			const canonicalHandle = durableRlmResult(() => parseRlmSpawnHandle(handle));
			await this.notifyDurable([parent.sessionId, admitted.child.session_id]);
			this.deferRun(admitted.run.child_run_id);
			return canonicalHandle;
		} catch (error) {
			this.withheldRuns.delete(admitted.run.child_run_id);
			throw error;
		}
	}

	private async handleList(parent: AgentSessionChildParentContext): Promise<RlmListSubagentsResult> {
		const controls = await this.options.runtime.listAgentSessionChildControls(parent.sessionId);
		return durableRlmResult(() =>
			parseRlmListSubagentsResult({
				subagents: controls.map((control) => ({
					child_session_id: control.child_session_id,
					child_run_id: control.child_run_id,
					name: control.child_name,
					model: control.model,
					run_state: control.run_state,
					session_state: control.session_state as "open" | "closing" | "faulted",
				})),
			}),
		);
	}

	private async handleDelete(
		requestId: string,
		childRunId: string,
		parent: AgentSessionChildParentContext,
	): Promise<RlmDeleteSubagentResult> {
		const canonicalRequestId = requireRequestId(requestId);
		const original = await this.options.runtime.resolveAgentSessionChildControl(parent.sessionId, childRunId);
		if (!original) {
			throw new AgentSessionChildHostRequestFault("rlm_subagent_not_found", "not_found", "Child run not found");
		}
		let priorRunState = original.run_state;
		let cancellation: "observed" | "not_required";
		const deadline = this.now() + this.controlTimeoutMs;
		let closed = original;
		const request = {
			requestId: canonicalRequestId,
			actor: {
				kind: "parent_materialization" as const,
				parentSessionId: parent.sessionId,
				generation: parent.generation,
				activationId: parent.activationId,
				sandboxId: parent.agentSandboxId,
			},
			reason: `rlm.delete_subagent:${childRunId}`,
			now: this.now(),
		};
		const requested = await this.options.runtime.requestAgentSessionChildCancellation(childRunId, request);
		if (requested.request.disposition === "terminal_preceded") {
			cancellation = "not_required";
			while (!TERMINAL_RUN_STATES.has(closed.run_state)) {
				await this.enqueuePump(false);
				closed =
					(await this.options.runtime.resolveAgentSessionChildControl(parent.sessionId, childRunId)) ?? closed;
				if (TERMINAL_RUN_STATES.has(closed.run_state)) break;
				if (this.stopping || this.now() >= deadline) throw deletePendingFault();
				await this.wait(Math.min(50, Math.max(1, deadline - this.now())));
			}
			priorRunState = closed.run_state;
			if (closed.session_state !== "closed") {
				await this.options.runtime.requestAgentSessionChildClosure(childRunId, {
					...request,
					now: this.now(),
				});
			}
		} else {
			priorRunState = requested.request.observed_run_state;
			cancellation = "observed";
			const localExecution = this.executionAborts.get(childRunId);
			if (localExecution && !localExecution.signal.aborted) {
				localExecution.abort(requested.request.reason);
			}
		}
		await this.notifyDurable([parent.sessionId, original.child_session_id]);
		this.wake();

		while (closed.session_state !== "closed") {
			await this.enqueuePump(false);
			closed = (await this.options.runtime.resolveAgentSessionChildControl(parent.sessionId, childRunId)) ?? closed;
			if (closed.session_state === "closed") break;
			if (this.stopping || this.now() >= deadline) throw deletePendingFault();
			await this.wait(Math.min(50, Math.max(1, deadline - this.now())));
		}
		if (cancellation === "observed" && closed.run_state !== "cancelled") {
			throw new AgentSessionChildHostRequestFault(
				"rlm_delete_terminal_conflict",
				"conflict",
				`Child closed with ${closed.run_state} instead of cancelled`,
			);
		}
		return durableRlmResult(() =>
			parseRlmDeleteSubagentResult({
				closure: {
					child_session_id: closed.child_session_id,
					child_run_id: closed.child_run_id,
					name: closed.child_name,
					model: closed.model,
					prior_run_state: priorRunState,
					final_run_state: closed.run_state,
					session_state: "closed",
					cancellation,
				},
			}),
		);
	}

	private deferRun(childRunId: string): void {
		const timer = setTimeout(() => {
			this.deferredWakeTimers.delete(timer);
			this.withheldRuns.delete(childRunId);
			this.pendingRuns.add(childRunId);
			this.wake();
		}, 0);
		timer.unref?.();
		this.deferredWakeTimers.add(timer);
	}

	private enqueuePump(startup: boolean): Promise<void> {
		if (this.stopping) return this.pumpChain;
		const task = this.pumpChain.then(async () => {
			if (this.stopping) return;
			await this.drain(startup ? 1_000 : 100);
		});
		this.pumpChain = task.catch((error) => {
			console.error(`[children] supervisor pump failed: ${boundedErrorMessage(error)}`);
		});
		return startup ? task : this.pumpChain;
	}

	private async drain(maximumPasses: number): Promise<void> {
		for (let pass = 0; pass < maximumPasses && !this.stopping; pass += 1) {
			const actions = await this.pumpOnce();
			if (actions === 0) return;
		}
	}

	private async pumpOnce(): Promise<number> {
		let actions = 0;
		for (const childRunId of this.pendingRuns) {
			this.pendingRuns.delete(childRunId);
			if (this.launchExecution(childRunId)) actions += 1;
		}
		const recoveries = await this.options.runtime.listAgentSessionChildRunsRequiringRecovery({
			now: this.now(),
			limit: 1_000,
		});
		if (await this.recoverOneMaterialization()) {
			// The recovery claim may have changed a record in the snapshot above.
			// Re-read on the next pass before attempting activation-fenced cleanup.
			return actions + 1;
		}
		for (const recovery of recoveries) {
			if (recovery.reason === "accounting_held") {
				const reconciled = await this.options.runtime.reconcileAgentSessionChildAccountingHold(
					recovery.run.child_run_id,
					{
						now: this.now(),
					},
				);
				if (reconciled.applied) actions += 1;
				continue;
			}
			await this.progressKnownCascades(recovery.run.child_run_id);
			if (
				TERMINAL_RUN_STATES.has(recovery.run.state) &&
				recovery.materialization &&
				LIVE_MATERIALIZATION_STATES.has(recovery.materialization.state)
			) {
				if (await this.prepareClosure(recovery)) actions += 1;
			}
		}

		// Closure ownership is store-fenced to terminal bodies. A foreign live
		// resident that cannot be prepared on this host must not starve unrelated
		// terminal cleanup work.
		if (await this.closeOneResident()) actions += 1;

		// Orphan/materialization recovery always precedes reclaiming an expired run.
		// Otherwise startup can launch a new executor against already-terminal body
		// testimony and overwrite its paired-kernel outcome before recovery settles
		// the prior leased attempt.
		if (this.admissionsInProgress === 0) {
			const claimable = await this.options.runtime.listClaimableAgentSessionChildRuns({
				now: this.now(),
				limit: 1_000,
			});
			if (this.admissionsInProgress === 0) {
				for (const run of claimable) {
					if (!this.withheldRuns.has(run.child_run_id) && this.launchExecution(run.child_run_id)) actions += 1;
				}
			}
		}
		return actions;
	}

	private launchExecution(childRunId: string): boolean {
		if (this.stopping || this.executions.has(childRunId)) return false;
		const execution = this.executeRun(childRunId)
			.catch((error) => {
				console.error(
					`[children] child run ${childRunId} stopped without settlement: ${boundedErrorMessage(error)}`,
				);
			})
			.finally(() => {
				this.clearExecutionHeartbeat(childRunId);
				this.executionAborts.delete(childRunId);
				if (this.executions.get(childRunId) === execution) this.executions.delete(childRunId);
				this.wake();
			});
		this.executions.set(childRunId, execution);
		return true;
	}

	private async executeRun(childRunId: string): Promise<void> {
		if (this.stopping) return;
		const claim = await this.options.runtime.claimAgentSessionChildRun(childRunId, {
			consumer: this.consumer,
			leaseMs: this.leaseMs,
			now: this.now(),
		});
		if (!claim.claimed || !claim.run.claim_token || this.stopping) return;
		if ((await this.pendingCancellationReason(childRunId)) !== null || this.stopping) return;
		const generation = 0;
		const activationId = claim.spec.invocationId ?? childRunId;
		const materialization = await this.options.runtime.claimAgentSessionChildMaterialization(childRunId, {
			consumer: this.consumer,
			claimToken: claim.run.claim_token,
			generation,
			activationId,
			now: this.now(),
		});
		if (this.stopping) return;
		const authority = durableAuthority(claim.child);
		const abort = new AbortController();
		this.executionAborts.set(childRunId, abort);
		this.armExecutionHeartbeat(claim, materialization, abort);
		const cancellationBeforeExecute = await this.pendingCancellationReason(childRunId);
		if (cancellationBeforeExecute !== null) abort.abort(cancellationBeforeExecute);
		await this.notifyDurable([claim.run.parent_session_id, claim.child.session_id]);
		let executed: AgentSessionChildExecutionResult;
		try {
			if (abort.signal.aborted) {
				await this.settleAbortedExecution(claim, materialization, authority, cancellationBeforeExecute);
				return;
			}
			executed = await this.options.execute({ claim, materialization, authority, signal: abort.signal });
		} catch (error) {
			if (!abort.signal.aborted) {
				if (isSandboxCleanupUnavailable(error)) {
					// A terminal SandboxStore event may precede verified capability/cgroup
					// cleanup. Preserve the exact launch sentinel and leased run for stale
					// recovery; only a successfully reaped zero-body attempt may be failed.
					await this.pauseExecutionHeartbeat(childRunId);
					await this.notifyDurable([claim.run.parent_session_id, claim.child.session_id]);
					return;
				}
				const latest = await this.options.runtime.readAgentMaterialization(claim.child.session_id, generation);
				if (
					!latest ||
					latest.activation_id !== activationId ||
					latest.state !== "claimed" ||
					latest.sandbox_id !== `claim:${activationId}`
				) {
					throw error;
				}
				await this.pauseExecutionHeartbeat(childRunId);
				await this.options.runtime.failUnboundAgentSessionChildRun(childRunId, {
					consumer: this.consumer,
					claimToken: claim.run.claim_token,
					generation,
					activationId,
					error: boundedErrorMessage(error),
					now: this.now(),
				});
				await this.notifyDurable([claim.run.parent_session_id, claim.child.session_id]);
				return;
			}
			if (this.stopping) return;
			await this.settleAbortedExecution(
				claim,
				materialization,
				authority,
				(await this.pendingCancellationReason(childRunId)) ?? boundedErrorMessage(error),
			);
			return;
		}
		if (this.stopping) return;
		const currentRun = await this.options.runtime.readAgentSessionChildRun(childRunId);
		if (!currentRun || currentRun.consumer !== this.consumer || currentRun.claim_token !== claim.run.claim_token)
			return;
		const cancellationReason = await this.pendingCancellationReason(childRunId);
		const status =
			currentRun.state === "cancelling" || executed.materialization.state === "cancelled"
				? "cancelled"
				: executed.result.state === "error"
					? "failed"
					: "completed";
		const closes =
			claim.spec.runtime?.kind === "simple" ||
			executed.materialization.state === "completed" ||
			executed.materialization.state === "cancelled" ||
			(executed.materialization.state === "faulted" && executed.materialization.recoverable === false);
		await this.pauseExecutionHeartbeat(childRunId);
		await this.options.runtime.settleAgentSessionChildRun(childRunId, {
			consumer: this.consumer,
			claimToken: claim.run.claim_token,
			status,
			terminalPolicy: closes ? "close" : "keep_open",
			materializationGeneration: executed.materialization.generation,
			materializationState: executed.materialization.state,
			...(status === "cancelled" ? {} : { result: executed.result }),
			...(status === "cancelled"
				? { error: cancellationReason ?? "child execution cancelled" }
				: status === "failed"
					? { error: executed.result.output || "child execution failed" }
					: {}),
			now: this.now(),
		});
		await this.notifyDurable([claim.run.parent_session_id, claim.child.session_id]);
	}

	private async settleAbortedExecution(
		claim: AgentSessionChildRunClaim,
		materialization: AgentMaterializationRecord,
		authority: AgentSessionChildDurableAuthority,
		reason: string | null,
	): Promise<void> {
		const current = await this.options.runtime.readAgentSessionChildRun(claim.run.child_run_id);
		if (!current || TERMINAL_RUN_STATES.has(current.state)) {
			await this.notifyDurable([claim.run.parent_session_id, claim.child.session_id]);
			return;
		}
		// Shutdown without durable cancellation leaves the no-body launch intent
		// under its expiring run lease for restart reclamation.
		if (current.state !== "cancelling") return;
		const cleaned = await this.options.cleanup({
			phase: "prepare_closure",
			terminalIntent: "cancelled",
			materialization,
			authority,
			reason: reason ?? "child execution cancelled before spawn",
		});
		const run = await this.options.runtime.readAgentSessionChildRun(claim.run.child_run_id);
		if (!run || run.consumer !== this.consumer || run.claim_token !== claim.run.claim_token) return;
		await this.pauseExecutionHeartbeat(claim.run.child_run_id);
		await this.options.runtime.settleAgentSessionChildRun(claim.run.child_run_id, {
			consumer: this.consumer,
			claimToken: claim.run.claim_token!,
			status: "cancelled",
			terminalPolicy: "close",
			materializationGeneration: materialization.generation,
			materializationState: cleaned.materializationState,
			error: reason ?? "child execution cancelled before spawn",
			now: this.now(),
		});
		await this.notifyDurable([claim.run.parent_session_id, claim.child.session_id]);
	}

	private armExecutionHeartbeat(
		claim: AgentSessionChildRunClaim,
		materialization: AgentMaterializationRecord,
		abort: AbortController,
	): void {
		const childRunId = claim.run.child_run_id;
		const claimToken = claim.run.claim_token;
		if (!claimToken) return;
		const schedule = (): void => {
			const timer = setTimeout(async () => {
				if (this.stopping) return this.clearExecutionHeartbeat(childRunId);
				const heartbeat = (async () => {
					await this.options.runtime.renewAgentSessionChildRunLease(childRunId, {
						consumer: this.consumer,
						claimToken,
						leaseMs: this.leaseMs,
						now: this.now(),
					});
					await this.options.runtime.heartbeatAgentMaterialization(
						materialization.session_id,
						materialization.generation,
						{ activationId: materialization.activation_id, now: this.now() },
					);
					if ((await this.pendingCancellationReason(childRunId)) !== null && !abort.signal.aborted) abort.abort();
				})();
				this.executionHeartbeatTasks.set(childRunId, heartbeat);
				try {
					await heartbeat;
				} catch (error) {
					this.clearExecutionHeartbeat(childRunId);
					if (!abort.signal.aborted) abort.abort(error);
					return;
				} finally {
					if (this.executionHeartbeatTasks.get(childRunId) === heartbeat) {
						this.executionHeartbeatTasks.delete(childRunId);
					}
				}
				// Only the timer still registered for this run may schedule its
				// successor. Settlement/stop can clear it while a store call awaits.
				if (this.executionHeartbeats.get(childRunId) === timer) schedule();
			}, this.heartbeatIntervalMs);
			timer.unref?.();
			this.executionHeartbeats.set(childRunId, timer);
		};
		schedule();
	}

	private clearExecutionHeartbeat(childRunId: string): void {
		const timer = this.executionHeartbeats.get(childRunId);
		if (timer) clearTimeout(timer);
		this.executionHeartbeats.delete(childRunId);
	}

	private async pauseExecutionHeartbeat(childRunId: string): Promise<void> {
		this.clearExecutionHeartbeat(childRunId);
		const inFlight = this.executionHeartbeatTasks.get(childRunId);
		if (inFlight) await inFlight;
	}

	private async prepareClosure(recovery: AgentSessionChildRunRecoveryRecord): Promise<boolean> {
		const materialization = recovery.materialization;
		if (!materialization) return false;
		const session = await this.options.runtime.readAgentSession(recovery.run.child_session_id);
		if (!session) return false;
		let cleaned: AgentSessionChildCleanupResult;
		try {
			cleaned = await this.options.cleanup({
				phase: "prepare_closure",
				terminalIntent: "cancelled",
				materialization,
				authority: durableAuthority(session),
				reason: "resident child closure",
			});
		} catch (error) {
			if (error instanceof AgentSessionChildCleanupUnavailable) return false;
			throw error;
		}
		if (LIVE_MATERIALIZATION_STATES.has(cleaned.materializationState)) {
			throw new Error("closure preparation returned a live materialization");
		}
		await this.notifyDurable([recovery.run.parent_session_id, recovery.run.child_session_id]);
		return true;
	}

	private async recoverOneMaterialization(): Promise<boolean> {
		if (this.stopping) return false;
		const claim = await this.options.runtime.claimAgentMaterializationRecovery({
			consumer: this.consumer,
			leaseMs: this.leaseMs,
			staleBefore: Math.max(0, this.now() - this.leaseMs),
			now: this.now(),
		});
		if (!claim) return false;
		const session = await this.options.runtime.readAgentSession(claim.materialization.session_id);
		if (!session) throw new Error(`recovery Session missing: ${claim.materialization.session_id}`);
		const run = claim.child_run_id ? await this.options.runtime.readAgentSessionChildRun(claim.child_run_id) : null;
		const cancellationReason = claim.child_run_id ? await this.pendingCancellationReason(claim.child_run_id) : null;
		const durableLogicalStatus = run?.state === "claimed" ? claim.durable_outcome_status : null;
		const cancelled =
			durableLogicalStatus === null && (run ? run.state === "cancelling" : claim.lifecycle_state === "closing");
		let materialization = claim.materialization;
		let kernelState: AgentSessionChildCleanupResult["kernelState"];
		const stopHeartbeat = this.armRecoveryHeartbeat(claim);
		try {
			const cleaned = await this.options.cleanup({
				phase: "recovery",
				terminalIntent:
					materialization.state === "faulted"
						? "faulted"
						: materialization.state === "cancelled" || cancelled
							? "cancelled"
							: durableLogicalStatus !== null
								? "completed"
								: "faulted",
				claim,
				authority: durableAuthority(session),
				reason: cancellationReason ?? "materialization lease expired or paired body cleanup is incomplete",
			});
			kernelState = cleaned.kernelState;
			// The materialization transition completes recovery supervision and
			// invalidates its token. Commit/replay paired-kernel cleanup first while the
			// exact recovery lease is still active, then terminalize the worker/body.
			const durableKernelState = claim.kernel_state;
			if (kernelState && (durableKernelState === null || durableKernelState === "running")) {
				await this.options.runtime.recordRecoveredAgentSessionKernelState(
					materialization.session_id,
					materialization.generation,
					{
						consumer: this.consumer,
						recoveryToken: claim.recovery_token,
						state: kernelState,
						now: this.now(),
					},
				);
			}
			if (LIVE_MATERIALIZATION_STATES.has(materialization.state)) {
				if (durableLogicalStatus !== null) {
					if (cleaned.materializationState !== "completed") {
						throw new Error("logical-outcome recovery must return completed materialization testimony");
					}
					materialization = (
						await this.options.runtime.finishRecoveredAgentMaterialization(
							materialization.session_id,
							materialization.generation,
							{
								consumer: this.consumer,
								recoveryToken: claim.recovery_token,
								to: "completed",
								now: this.now(),
							},
						)
					).materialization;
				} else if (cancelled) {
					if (cleaned.materializationState !== "cancelled") {
						throw new Error("cancellation recovery must return cancelled materialization testimony");
					}
					materialization = (
						await this.options.runtime.finishRecoveredAgentMaterialization(
							materialization.session_id,
							materialization.generation,
							{
								consumer: this.consumer,
								recoveryToken: claim.recovery_token,
								to: "cancelled",
								now: this.now(),
							},
						)
					).materialization;
				} else {
					if (cleaned.materializationState !== "faulted") {
						throw new Error("fault recovery must return faulted materialization testimony");
					}
					materialization = (
						await this.options.runtime.finishRecoveredAgentMaterialization(
							materialization.session_id,
							materialization.generation,
							{
								consumer: this.consumer,
								recoveryToken: claim.recovery_token,
								to: "faulted",
								faultKind: cleaned.faultKind ?? "worker_exit",
								recoverable: cleaned.recoverable ?? false,
								now: this.now(),
							},
						)
					).materialization;
				}
			}
			if (claim.child_run_id && run && !TERMINAL_RUN_STATES.has(run.state)) {
				const status =
					durableLogicalStatus ??
					(materialization.state === "cancelled"
						? "cancelled"
						: materialization.state === "faulted"
							? "failed"
							: session.status === "failed"
								? "failed"
								: "completed");
				await this.options.runtime.settleRecoveredAgentSessionChildRun(claim.child_run_id, {
					sessionId: materialization.session_id,
					generation: materialization.generation,
					consumer: this.consumer,
					recoveryToken: claim.recovery_token,
					status,
					now: this.now(),
				});
			}
			await this.notifyDurable([materialization.session_id, ...(run ? [run.parent_session_id] : [])]);
			if (claim.child_run_id) await this.progressKnownCascades(claim.child_run_id);
			return true;
		} finally {
			await stopHeartbeat();
		}
	}

	private armRecoveryHeartbeat(claim: AgentMaterializationRecoveryClaim): () => Promise<void> {
		return this.armSerializedLeaseHeartbeat(() =>
			this.options.runtime.renewAgentMaterializationRecoveryLease({
				sessionId: claim.materialization.session_id,
				generation: claim.materialization.generation,
				consumer: this.consumer,
				recoveryToken: claim.recovery_token,
				leaseMs: this.leaseMs,
				now: this.now(),
			}),
		);
	}

	private async closeOneResident(): Promise<boolean> {
		if (this.stopping) return false;
		const claim = await this.options.runtime.claimAgentSessionChildClosureWork({
			consumer: this.consumer,
			leaseMs: this.leaseMs,
			now: this.now(),
		});
		if (!claim) return false;
		if (LIVE_MATERIALIZATION_STATES.has(claim.materialization.state)) {
			throw new Error(`closure ${claim.request.closure_id} was claimed before body cleanup`);
		}
		const stopHeartbeat = this.armClosureHeartbeat(claim);
		try {
			const cleaned = await this.options.cleanup({
				phase: "closure",
				terminalIntent: "cancelled",
				claim,
				authority: durableAuthority(claim.session),
				reason: claim.request.reason,
			});
			if (cleaned.materializationState !== claim.materialization.state) {
				throw new Error("closure cleanup changed terminal materialization testimony");
			}
			if (cleaned.kernelState) {
				await this.options.runtime.recordRecoveredAgentSessionKernelState(
					claim.materialization.session_id,
					claim.materialization.generation,
					{
						consumer: this.consumer,
						recoveryToken: claim.cleanup_token,
						state: cleaned.kernelState,
						now: this.now(),
					},
				);
			}
			await this.options.runtime.finalizeAgentSessionChildClosure(claim.run.child_run_id, {
				consumer: this.consumer,
				cleanupToken: claim.cleanup_token,
				materializationGeneration: claim.materialization.generation,
				materializationState: cleaned.materializationState,
				now: this.now(),
			});
			await this.notifyDurable([claim.run.parent_session_id, claim.run.child_session_id]);
			await this.progressKnownCascades(claim.run.child_run_id);
			return true;
		} finally {
			await stopHeartbeat();
		}
	}

	private armClosureHeartbeat(claim: AgentSessionChildClosureWorkClaim): () => Promise<void> {
		return this.armSerializedLeaseHeartbeat(() =>
			this.options.runtime.renewAgentSessionChildClosureWorkLease({
				closureId: claim.request.closure_id,
				consumer: this.consumer,
				cleanupToken: claim.cleanup_token,
				leaseMs: this.leaseMs,
				now: this.now(),
			}),
		);
	}

	/** Cleanup lease heartbeats must never overtake one another under store latency. */
	private armSerializedLeaseHeartbeat(renew: () => Promise<unknown>): () => Promise<void> {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let inFlight: Promise<void> | undefined;
		const schedule = (): void => {
			timer = setTimeout(() => {
				if (stopped || this.stopping) return;
				const heartbeat = (async () => {
					try {
						await renew();
					} catch {
						stopped = true;
						return;
					}
					if (!stopped && !this.stopping) schedule();
				})();
				inFlight = heartbeat;
				void heartbeat.finally(() => {
					if (inFlight === heartbeat) inFlight = undefined;
				});
			}, this.heartbeatIntervalMs);
			timer.unref?.();
		};
		schedule();
		return async () => {
			stopped = true;
			if (timer) clearTimeout(timer);
			if (inFlight) await inFlight;
		};
	}

	private async pendingCancellationReason(childRunId: string): Promise<string | null> {
		const requests = await this.options.runtime.listAgentSessionChildCancellationRequests(childRunId);
		return requests.find((request) => request.disposition === "cancellation_pending")?.reason ?? null;
	}

	private async progressKnownCascades(childRunId: string): Promise<void> {
		const requests = await this.options.runtime.listAgentSessionChildCancellationRequests(childRunId);
		for (const request of requests) {
			if (request.actor.kind === "session_cascade") {
				await this.options.runtime.progressAgentSessionDescendantCascade(request.actor.cascadeId, {
					now: this.now(),
				});
			}
		}
	}

	private async notifyDurable(sessionIds: readonly string[]): Promise<void> {
		if (!this.options.onDurableChange) return;
		try {
			await this.options.onDurableChange([...new Set(sessionIds)]);
		} catch (error) {
			console.error(`[children] durable change notification failed: ${boundedErrorMessage(error)}`);
		}
	}

	private armPoll(): void {
		if (this.pollIntervalMs === 0 || this.stopping) return;
		this.pollTimer = setTimeout(() => {
			this.pollTimer = null;
			this.wake();
			this.armPoll();
		}, this.pollIntervalMs);
		this.pollTimer.unref?.();
	}
}

function durableAuthority(session: {
	readonly owner_user_id: string;
	readonly graph_owner_principal: string;
	readonly graph_id: string;
}): AgentSessionChildDurableAuthority {
	return {
		ownerUserId: session.owner_user_id,
		graphOwnerPrincipal: session.graph_owner_principal,
		graphId: session.graph_id,
	};
}

function requireRequestId(value: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > 128) {
		throw new AgentSessionChildHostRequestFault(
			"rlm_request_invalid",
			"invalid",
			"RLM request id must be a non-empty string of at most 128 characters",
		);
	}
	return value;
}

function deletePendingFault(): AgentSessionChildHostRequestFault {
	return new AgentSessionChildHostRequestFault(
		"rlm_delete_pending",
		"unavailable",
		"Child closure is durable but has not completed",
		true,
	);
}

function durableRlmResult<T>(parse: () => T): T {
	try {
		return parse();
	} catch (error) {
		if (error instanceof RlmControlContractFault) {
			throw new AgentSessionChildHostRequestFault(
				"rlm_host_result_invalid",
				"internal",
				`Host durable RLM result violated the shared contract: ${error.message}`,
			);
		}
		throw error;
	}
}

function hostFault(error: unknown): AgentSessionChildHostRequestFault {
	if (error instanceof AgentSessionChildHostRequestFault) return error;
	if (error instanceof RlmControlContractFault) {
		return new AgentSessionChildHostRequestFault("rlm_control_invalid", "invalid", error.message);
	}
	if (error instanceof AgentSessionChildAdmissionFault) {
		if (error.reason === "request_conflict") {
			return new AgentSessionChildHostRequestFault("rlm_run_request_conflict", "conflict", error.message);
		}
		if (error.reason === "children_not_granted" || error.reason === "binding_widening") {
			return new AgentSessionChildHostRequestFault(error.code, "denied", error.message);
		}
		return new AgentSessionChildHostRequestFault(error.code, "invalid", error.message);
	}
	if (error instanceof AgentSessionChildRunFault) {
		if (error.reason === "run_not_found") {
			return new AgentSessionChildHostRequestFault("rlm_subagent_not_found", "not_found", error.message);
		}
		if (error.reason === "authority_invalid") {
			return new AgentSessionChildHostRequestFault(error.code, "denied", error.message);
		}
		if (error.reason === "lease_lost" || error.reason === "lease_expired" || error.reason === "not_claimable") {
			return new AgentSessionChildHostRequestFault(error.code, "unavailable", error.message, true);
		}
		return new AgentSessionChildHostRequestFault(error.code, "conflict", error.message);
	}
	return new AgentSessionChildHostRequestFault("rlm_host_internal", "internal", boundedErrorMessage(error));
}

function boundedErrorMessage(error: unknown): string {
	const value = error instanceof Error ? error.message : String(error);
	return value.length <= 4_096 ? value : value.slice(0, 4_096);
}

function isSandboxCleanupUnavailable(error: unknown): boolean {
	return error instanceof Error && error.name === "SandboxCleanupUnavailable";
}

function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
	return value;
}

function nonnegativeInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
	return value;
}
