/**
 * WorkflowRuntimeStore — first-class durable runtime state for Choreograph
 * workflows.
 *
 * The run journal remains execution evidence. This store owns the resumable
 * runtime object model: workflow instances, safe-point frontiers, and
 * Vehicle-facing agent session documents. That keeps pause/restart/collab state
 * out of ad-hoc journal projections and gives a CRDT-shaped boundary for Loro.
 */

import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Row, Transaction } from "@libsql/client";
import { canonicalJson } from "@sophia-labs/canonical-json";
import { type AgentModeRefV1, isModeIri, validateAgentModeRef } from "../agent-runtime/agent-mode.js";
import type {
	AgentSessionScheduleControlReceiptV1,
	AgentSessionScheduleControlRequestV1,
	AgentSessionScheduleCreationOptionsV1,
	AgentSessionScheduleUpdatedPayloadV1,
} from "../agent-runtime/agent-session-schedule-control.js";
import {
	assertContentAuthorityBinding,
	assertVerifiedExecutionCapsuleReplay,
	type ContentAuthorityBindingV1,
	type VerifiedExecutionCapsuleV1,
} from "../agent-runtime/content-authority-contract.js";
import type { ExecutionCell } from "../agent-runtime/execution-service.js";
import {
	emptyPrimeGoalHandoffState,
	type PrimeGoalHandoffState,
	type PrimeGoalReducerInput,
	reducePrimeGoalWorkerMessage,
	registerPrimeGoalCommand,
} from "../agent-runtime/goal-command-handoff.js";
import {
	emptyGoalReducerState,
	type GoalReducerOperation,
	type GoalReducerState,
	reduceGoalOperation,
} from "../agent-runtime/goal-reducer-contract.js";
import type { PrimeGoalHostResponseV1 } from "../agent-runtime/host-protocol.js";
import { createMeaningfulObjectRef, validateMeaningfulObjectRef } from "../agent-runtime/meaningful-object.js";
import {
	type AgentCheckpointCommitV2,
	type KernelCheckpointCommitV1,
	validateCheckpointCommit,
} from "../agent-runtime/memory.js";
import {
	type AgentOntologyBindingV1,
	assertAgentOntologyRuntimeMatch,
	digestAgentOntologyBinding,
	validateAgentOntologyBinding,
} from "../agent-runtime/ontology-binding.js";
import {
	type AgentRuntimeBindingV2,
	type AgentRuntimeConstraintsV2,
	type AgentRuntimeKind,
	digestAgentRuntimeBinding,
	resolveAgentRuntimeBinding,
	validateResolvedAgentRuntimeBinding,
} from "../agent-runtime/profile.js";
import type { AgentSessionCommandNameV1, AgentSessionScheduleSpecV1 } from "../agent-runtime/session-contract.js";
import { staticPricingVersion } from "../billing-pricing.js";
import {
	parseRateCard,
	priceAtProviderReport,
	priceInferenceCall,
	RATE_CARD_VERSION_PATTERN,
	type RateCardV1,
	rateCardFromSessionSource,
} from "../billing-rate-card.js";
import type { UsageEventInput } from "../billing-store.js";
import {
	CHAT_ACTIVITY_COMMAND_NAMES,
	CHAT_ACTIVITY_EVENT_TYPES,
	CHAT_WORKFLOW_NAMES,
	type ChatSessionCatalogueRecord,
	type ChatSessionListPage,
	type ChatSessionListRow,
	type ChatSessionListStoreQuery,
	type ChatTitleSource,
	deriveChatTitle,
	isChatActivityEvent,
	normalizeExplicitChatTitle,
} from "../chat-catalogue.js";
import {
	type AgentSeedRefV1,
	CHAT_SEED_MAX_UNCLAIMED_PER_OWNER,
	CHAT_SEED_UNCLAIMED_TTL_MS,
	ChatSeedFault,
	parseAgentSeedRef,
	prepareChatSeed,
} from "../chat-seed.js";
import { CREDIT_EXHAUSTED_REASON, type CreditProbe, planCreditClamp } from "../credit-clamp.js";
import { requireCanonicalGraphOwnerPrincipal } from "../graph-owner-principal.js";
import { LibsqlStore } from "../persistence/libsql-store.js";
import {
	type AgentSessionScheduleGrantBindingV1,
	type AgentSessionScheduleGrantSnapshotV1,
	bindAgentSessionScheduleGrantSnapshot,
	parseAgentSessionScheduleGrantBinding,
	verifyAgentSessionScheduleGrantBinding,
} from "./agent-session-schedule-grant.js";
import {
	agentSessionCommandActivationId,
	appendCommandTranscript,
	appendNodeResultTranscript,
} from "./session-transcript.js";
import type { AgentNodeResult, AgentNodeSpec, WorkflowTerminalStatus } from "./types.js";

/** `stopping`: a stop was asked for and the run's live sittings are being ended; it becomes `stopped`. */
export type WorkflowRuntimeStatus = "running" | "pausing" | "paused" | "resuming" | "stopping" | WorkflowTerminalStatus;
/** A run that has ended for good: nothing drives it, and a stop leaves it as it is. A paused run may still be stopped. */
export const WORKFLOW_ENDED: ReadonlySet<string> = new Set(["completed", "failed", "stopped"]);
/** Latest durable run outcome. Body residency/passivation is not a Session outcome. */
export type AgentSessionStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type AgentSessionLifecycleState = "open" | "closing" | "closed" | "faulted";

export interface WorkflowFrontier {
	kind: "before-node" | "after-node" | "before-beat" | "after-beat" | "run-started" | "run-finished";
	nodeKey?: string;
	sessionId?: string;
	label?: string;
	phaseIndex?: number;
	beatId?: string;
	ts: number;
}

export interface WorkflowInstanceRecord {
	run_id: string;
	workflow_name: string;
	graph_id: string;
	owner_user_id: string;
	status: WorkflowRuntimeStatus;
	source_sha256: string | null;
	source_text: string | null;
	inputs_json: string;
	resume_from_run_id: string | null;
	frontier_json: string | null;
	pause_requested_at: number | null;
	pause_reason: string | null;
	/** When a stop was asked for, by whom (the owner's user id), and in what words: set once, never cleared. */
	stop_requested_at: number | null;
	stop_requested_by: string | null;
	stop_reason: string | null;
	started_at: number;
	updated_at: number;
	ended_at: number | null;
	payload_json: string | null;
}

export interface AgentSessionRecord {
	session_id: string;
	run_id: string;
	owner_user_id: string;
	graph_owner_principal: string;
	graph_id: string;
	workflow_name: string;
	node_key: string;
	label: string;
	phase_index: number;
	agent_id: string | null;
	sandbox_id: string | null;
	model: string;
	family_root_session_id: string;
	status: AgentSessionStatus;
	lifecycle_state: AgentSessionLifecycleState;
	frontier_json: string | null;
	result_json: string | null;
	lifecycle_terminal_digest: string | null;
	document_json: string;
	created_at: number;
	updated_at: number;
	completed_at: number | null;
}

export interface AgentSessionEvent {
	session_id: string;
	seq: number;
	ts: number;
	type: string;
	causation_id: string | null;
	command_id: string | null;
	payload: unknown;
}

/**
 * An immutable, host-owned family edge between two durable Agent Sessions.
 *
 * A child has exactly one parent. Both sessions remain independently durable;
 * body materialization and run lifecycle never recreate or mutate this edge.
 */
export interface AgentSessionChildRelationRecord {
	relation_id: string;
	relation_kind: "parent_child";
	parent_session_id: string;
	child_session_id: string;
	owner_user_id: string;
	graph_id: string;
	causation_id: string | null;
	created_at: number;
}

export interface AgentSessionChildBudgetSliceV1 {
	readonly schema: "choreograph.agent-session-child-budget.v1";
	readonly maxTurns: number;
	readonly maxWallTimeMs: number;
	readonly maxTokens: number;
	readonly maxCostUsdMicros: number;
	readonly maxArtifactBytes: number;
}

/** Durable F2 receipt for one host-admitted, not-yet-materialized child. */
export interface AgentSessionChildAdmissionRecord {
	admission_id: string;
	parent_session_id: string;
	request_id: string;
	request_digest: string;
	child_session_id: string;
	child_run_id: string;
	relation_id: string;
	child_name: string;
	depth: number;
	runtime_binding_digest: string;
	ontology_binding_digest: string;
	budget_allocation_id: string;
	budget: AgentSessionChildBudgetSliceV1;
	created_at: number;
}

export interface AgentSessionChildSpawnRequestRecord {
	parent_session_id: string;
	request_id: string;
	request_digest: string;
	decision: "accepted" | "denied";
	admission_id: string | null;
	child_session_id: string | null;
	child_run_id: string | null;
	denial_code: string | null;
	denial_message: string | null;
	created_at: number;
}

export type AgentSessionChildRunState = "queued" | "claimed" | "cancelling" | "completed" | "failed" | "cancelled";

export interface AgentSessionChildRunRecord {
	child_run_id: string;
	admission_id: string;
	parent_session_id: string;
	child_session_id: string;
	state: AgentSessionChildRunState;
	attempt: number;
	consumer: string | null;
	claim_token: string | null;
	claimed_at: number | null;
	claim_expires_at: number | null;
	heartbeat_at: number | null;
	materialization_generation: number | null;
	materialized_at: number | null;
	result: unknown;
	error: string | null;
	terminal_digest: string | null;
	created_at: number;
	terminal_at: number | null;
}

export type AgentSessionChildCancellationDisposition =
	| "cancelled_before_materialization"
	| "cancellation_pending"
	| "terminal_preceded";

/** Immutable request testimony. Its disposition records which side won the cancellation/terminal CAS. */
export interface AgentSessionChildCancellationRequestRecord {
	readonly cancellation_id: string;
	readonly child_run_id: string;
	readonly request_id: string;
	readonly request_digest: string;
	readonly actor: AgentSessionChildCancellationActor;
	readonly reason: string;
	readonly disposition: AgentSessionChildCancellationDisposition;
	readonly observed_run_state: AgentSessionChildRunState;
	readonly created_at: number;
}

export interface AgentSessionChildBudgetAllocationRecord {
	allocation_id: string;
	admission_id: string;
	parent_session_id: string;
	child_session_id: string;
	state: "reserved" | "accounting_hold" | "settled" | "released";
	budget: AgentSessionChildBudgetSliceV1;
	hold_reason: "unresolved_child_reservations" | null;
	created_at: number;
	held_at: number | null;
	settled_at: number | null;
}

/** The five host-enforced dimensions shared by runtime bindings and child slices. */
export interface AgentSessionBudgetVectorV1 {
	readonly turns: number;
	readonly wallTimeMs: number;
	readonly tokens: number;
	readonly costUsdMicros: number;
	readonly artifactBytes: number;
}

export type AgentSessionBudgetDimension = keyof AgentSessionBudgetVectorV1;

export interface AgentSessionBudgetAccountRecord {
	readonly session_id: string;
	readonly limit: AgentSessionBudgetVectorV1;
	readonly reserved: AgentSessionBudgetVectorV1;
	readonly spent: AgentSessionBudgetVectorV1;
	readonly exhausted: boolean;
	readonly revision: number;
	readonly created_at: number;
	readonly updated_at: number;
}

export type AgentSessionBudgetLedgerEntryKind =
	| "account_opened"
	| "child_allocated"
	| "child_settled"
	| "child_released"
	| "inference_reserved"
	| "inference_settled"
	| "inference_indeterminate"
	| "inference_released";

/** Immutable accounting testimony. Every entry carries every dimension, including zero deltas. */
export interface AgentSessionBudgetLedgerEntryRecord {
	readonly entry_id: string;
	readonly session_id: string;
	readonly ordinal: number;
	readonly kind: AgentSessionBudgetLedgerEntryKind;
	readonly reference_id: string;
	readonly reserved_delta: AgentSessionBudgetVectorV1;
	readonly spent_delta: AgentSessionBudgetVectorV1;
	readonly detail: unknown;
	readonly created_at: number;
}

export interface AgentSessionBudgetSnapshot {
	readonly account: AgentSessionBudgetAccountRecord;
	readonly available: AgentSessionBudgetVectorV1;
	readonly entries: readonly AgentSessionBudgetLedgerEntryRecord[];
}

export type AgentSessionInferenceReservationState = "reserved" | "settled" | "indeterminate" | "released";

export interface AgentSessionInferenceReservationRecord {
	readonly funding_source: "platform" | "user";
	readonly operation_id: string;
	readonly session_id: string;
	readonly generation: number;
	readonly activation_id: string;
	readonly sandbox_id: string;
	readonly request_id: string;
	readonly request_digest: string;
	readonly reservation_digest: string;
	readonly causation_id: string;
	readonly provider: string;
	readonly model: string;
	readonly pricing_version: string;
	readonly estimated_input_tokens: number;
	readonly max_output_tokens: number;
	readonly state: AgentSessionInferenceReservationState;
	readonly budget: AgentSessionBudgetVectorV1;
	readonly usage: AgentSessionBudgetVectorV1 | null;
	readonly reason: string | null;
	readonly created_at: number;
	readonly updated_at: number;
	readonly terminal_at: number | null;
}

export interface ReserveAgentSessionInferenceBudgetInput {
	/** Set only by the host after credential selection; never accepted from workers. */
	readonly fundingSource?: "platform" | "user";
	readonly generation: number;
	readonly activationId: string;
	readonly sandboxId: string;
	readonly requestId: string;
	/** Digest of the exact admitted inference request bytes. */
	readonly requestDigest: string;
	readonly causationId: string;
	readonly provider: string;
	readonly model: string;
	readonly estimatedInputTokens: number;
	readonly requestedOutputTokens: number;
	/** Must equal the pure pricing catalogue used by this runtime. */
	readonly pricingVersion: string;
	readonly now: number;
	/**
	 * Credit gate, Door B (host-set only, never from a worker; NOT part of the reservation digest, so a
	 * replay is unaffected). The person's spendable balance as a SECOND cost ceiling next to the session's
	 * own dollars: the output cap shrinks until the worst case fits both, and a call that cannot keep a
	 * viable output is refused with `credit_exhausted`. Absent = the reservation as it always was.
	 */
	readonly creditCeilingCostUsdMicros?: number;
	/** false = only report what the ceiling would have done (`creditProbe`); omitted = enforce it. */
	readonly creditEnforce?: boolean;
}

export interface AgentSessionInferenceFenceInput {
	readonly generation: number;
	readonly activationId: string;
	readonly sandboxId: string;
	readonly requestId: string;
	readonly requestDigest: string;
	readonly now: number;
}

export interface SettleAgentSessionInferenceBudgetInput extends AgentSessionInferenceFenceInput {
	/** Authoritative usage is recorded even when it exceeds the reservation or account ceiling. */
	readonly usage: AgentSessionBudgetVectorV1;
	/** Exact payload for the later BillingStore projection; the runtime ledger remains admission truth. */
	readonly billingEvent: AgentSessionInferenceBillingEvent;
}

export type AgentSessionInferenceBillingEvent = Omit<
	UsageEventInput,
	"eventId" | "sessionId" | "generation" | "inferenceOperationId" | "requestId" | "sandboxId" | "provider" | "model"
> & {
	readonly eventId: string;
	readonly sessionId: string;
	readonly generation: number;
	readonly inferenceOperationId: string;
	readonly requestId: string;
	readonly sandboxId: string;
	readonly provider: string;
	readonly model: string;
};

export interface AgentSessionInferenceBudgetMutationResult {
	readonly account: AgentSessionBudgetAccountRecord;
	readonly reservation: AgentSessionInferenceReservationRecord;
	readonly entry: AgentSessionBudgetLedgerEntryRecord;
	readonly applied: boolean;
	readonly exhaustedDimensions: readonly AgentSessionBudgetDimension[];
}

export interface AgentSessionInferenceBudgetReservationResult extends AgentSessionInferenceBudgetMutationResult {
	readonly maxOutputTokens: number;
	readonly billingProvenance: AgentSessionInferenceBillingProvenance;
	/** Present when the person's balance was the binding cost constraint on a new reservation. */
	readonly creditProbe?: CreditProbe;
}

export interface AgentSessionInferenceBillingProvenance {
	readonly userId: string;
	readonly graphId: string;
	readonly childRunId: string | null;
	readonly allocationId: string | null;
}

export interface AgentSessionInferenceBillingOutboxRecord {
	readonly operation_id: string;
	readonly session_id: string;
	readonly payload: AgentSessionInferenceBillingEvent;
	readonly payload_digest: string;
	readonly state: "pending" | "claimed" | "delivered";
	readonly consumer: string | null;
	readonly claim_token: string | null;
	readonly claimed_at: number | null;
	readonly claim_expires_at: number | null;
	readonly delivered_at: number | null;
	readonly created_at: number;
}

export interface AgentSessionChildGenerationOccupancyRecord {
	readonly parent_session_id: string;
	readonly child_session_id: string;
	readonly generation: number;
	readonly state: "occupied" | "released";
	readonly acquired_at: number;
	readonly released_at: number | null;
}

export type AgentSessionBudgetFaultReason =
	| "account_not_found"
	| "budget_exhausted"
	/** The person's credit balance cannot fund a viable call (Sobremesa credit gate, Door B). */
	| typeof CREDIT_EXHAUSTED_REASON
	| "request_conflict"
	| "request_invalid"
	| "reservation_not_found"
	| "reservation_state_conflict"
	| "materialization_stale"
	| "arithmetic_overflow";

export class AgentSessionBudgetFault extends Error {
	readonly code = "agent_session_budget_invalid";

	constructor(
		readonly reason: AgentSessionBudgetFaultReason,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "AgentSessionBudgetFault";
	}
}

/**
 * Projection-safe Agent Session coordinates. Deliberately excludes owner,
 * model, prompt, binding digests and ephemeral body identifiers.
 */
export interface AgentSessionFamilyProjectionSession {
	readonly sessionId: string;
	readonly agentId: string | null;
	readonly graphId: string;
	readonly sessionState: AgentSessionLifecycleState;
	/** Choreograph modes v1: the `agt:Mode` the Session is bound to (audit, `agt:ranInMode`). */
	readonly modeIri?: string;
}

/** Aggregate F4 admission and cost coordinates for the canonical family root. */
export interface AgentSessionFamilyProjectionRoot extends AgentSessionFamilyProjectionSession {
	readonly materializationState: AgentMaterializationState | null;
	readonly materializationGeneration: number | null;
	readonly materializationFaultKind: AgentMaterializationFaultKind | null;
	readonly materializationRecoverable: boolean | null;
	readonly workerState: AgentMaterializationState | null;
	readonly kernelState: AgentSessionKernelState | null;
	readonly directAcceptedChildren: number;
	readonly maxChildren: number;
	readonly occupiedChildren: number;
	readonly maxConcurrentChildren: number;
	readonly budgetCostSpentUsdMicros: number;
	readonly budgetCostReservedUsdMicros: number;
	readonly budgetCostRemainingUsdMicros: number;
	readonly budgetCostMaxUsdMicros: number;
	readonly budgetAccountExhausted: boolean;
	readonly budgetAccountRevision: number;
}

/** The F2 facts the sealed Shrubbery family Face is allowed to inspect. */
export interface AgentSessionFamilyProjectionAdmission {
	readonly childName: string;
	readonly depth: number;
	readonly runtimeKind: AgentRuntimeKind;
	readonly allocationState: AgentSessionChildBudgetAllocationRecord["state"];
	readonly allocationHoldKind: AgentSessionChildBudgetAllocationRecord["hold_reason"];
	/** Authoritative child-account spend; present exactly when the allocation is settled. */
	readonly settledActualCostUsdMicros: number | null;
	readonly budget: AgentSessionChildBudgetSliceV1;
}

export type AgentSessionBodyRole = "worker" | "kernel";
export type AgentSessionKernelState = "running" | "released" | "shutdown" | "faulted" | "cancelled";

export interface AgentSessionBodyStateRecord {
	readonly session_id: string;
	readonly generation: number;
	readonly role: AgentSessionBodyRole;
	readonly state: AgentMaterializationState | AgentSessionKernelState;
	readonly updated_at: number;
}

/** One immutable F1 edge plus optional, authoritative F2/F3 facts. */
export interface AgentSessionFamilyProjectionChild {
	readonly relationId: string;
	readonly parentSessionId: string;
	readonly child: AgentSessionFamilyProjectionSession;
	readonly childName: string;
	readonly depth: number;
	readonly registeredAt: number;
	readonly admission: AgentSessionFamilyProjectionAdmission | null;
	readonly childRunState: AgentSessionChildRunState | null;
	/** Latest durable materialization and its body testimony; body identifiers are never projected. */
	readonly materializationState: AgentMaterializationState | null;
	readonly materializationGeneration: number | null;
	readonly materializationFaultKind: AgentMaterializationFaultKind | null;
	readonly materializationRecoverable: boolean | null;
	readonly workerState: AgentMaterializationState | null;
	readonly kernelState: AgentSessionKernelState | null;
}

/** A root Session and every recursively registered descendant in display order. */
export interface AgentSessionFamilyProjectionSnapshot {
	/** Database-global durable revision fencing cross-process graph writes. */
	readonly projectionRevision: number;
	readonly root: AgentSessionFamilyProjectionRoot;
	readonly children: readonly AgentSessionFamilyProjectionChild[];
}

export interface AgentSessionFamilyProjectionOutboxRecord {
	readonly root_session_id: string;
	readonly work_kind: "project" | "retire";
	readonly desired_revision: number;
	readonly delivered_revision: number;
	readonly delivered_projection_revision: number;
	readonly state: "pending" | "claimed" | "delivered";
	readonly claimed_revision: number | null;
	readonly claimed_projection_revision: number | null;
	readonly consumer: string | null;
	readonly claim_token: string | null;
	readonly claimed_at: number | null;
	readonly claim_expires_at: number | null;
	readonly heartbeat_at: number | null;
	readonly not_before: number;
	readonly last_error: string | null;
	readonly updated_at: number;
}

export interface AgentSessionFamilyProjectionOutboxClaim {
	readonly work: AgentSessionFamilyProjectionOutboxRecord;
	readonly snapshot: AgentSessionFamilyProjectionSnapshot | null;
}

export interface AdmitAgentSessionChildInput {
	/** Worker-scoped durable identity. Replays must carry byte-identical content. */
	readonly requestId: string;
	/** Exact running parent body that issued this host request. */
	readonly parentGeneration: number;
	readonly parentActivationId: string;
	readonly parentSandboxId: string;
	readonly prompt: string;
	readonly requestedName?: string;
	readonly requestedModel?: string;
	readonly causationId: string;
	readonly now: number;
}

export interface AcceptedAgentSessionChildResult {
	readonly decision: "accepted";
	readonly request: AgentSessionChildSpawnRequestRecord;
	readonly child: AgentSessionRecord;
	readonly relation: AgentSessionChildRelationRecord;
	readonly admission: AgentSessionChildAdmissionRecord;
	readonly allocation: AgentSessionChildBudgetAllocationRecord;
	readonly run: AgentSessionChildRunRecord;
	readonly spec: AgentNodeSpec;
	readonly created: boolean;
}

export interface DeniedAgentSessionChildResult {
	readonly decision: "denied";
	readonly request: AgentSessionChildSpawnRequestRecord;
	readonly created: boolean;
}

export type AdmitAgentSessionChildResult = AcceptedAgentSessionChildResult | DeniedAgentSessionChildResult;

export interface AgentSessionChildRunClaim {
	readonly run: AgentSessionChildRunRecord;
	readonly child: AgentSessionRecord;
	readonly spec: AgentNodeSpec;
	readonly claimed: boolean;
}

export interface ClaimAgentSessionChildRunInput {
	readonly consumer: string;
	readonly leaseMs: number;
	readonly now: number;
}

export interface AgentSessionChildRunLeaseFence {
	readonly consumer: string;
	readonly claimToken: string;
	readonly now: number;
}

export interface RenewAgentSessionChildRunLeaseInput extends AgentSessionChildRunLeaseFence {
	readonly leaseMs: number;
}

export interface ClaimAgentSessionChildMaterializationInput extends AgentSessionChildRunLeaseFence {
	readonly generation: number;
	readonly activationId: string;
}

export interface SettleAgentSessionChildRunInput {
	readonly consumer: string;
	readonly claimToken: string;
	readonly status: "completed" | "failed" | "cancelled";
	readonly terminalPolicy: "keep_open" | "close";
	readonly materializationGeneration: number;
	readonly materializationState: AgentMaterializationState;
	readonly result?: unknown;
	readonly error?: string;
	readonly now: number;
}

export interface RequestAgentSessionChildCancellationInput {
	readonly requestId: string;
	readonly actor: AgentSessionChildCancellationActor;
	readonly reason: string;
	readonly now: number;
}

/** Exact live parent authority or a durable supervisor cascade rooted in terminal intent. */
export type AgentSessionChildCancellationActor =
	| {
			readonly kind: "parent_materialization";
			readonly parentSessionId: string;
			readonly generation: number;
			readonly activationId: string;
			readonly sandboxId: string;
	  }
	| {
			readonly kind: "session_cascade";
			readonly rootSessionId: string;
			readonly cascadeId: string;
			readonly causeDigest: string;
	  };

export interface AgentSessionDescendantCascadeRecord {
	readonly cascade_id: string;
	readonly root_session_id: string;
	readonly cause: "explicit_cancel" | "irrecoverable_fault";
	readonly cause_digest: string;
	readonly reason: string;
	readonly state: "active" | "completed";
	readonly created_at: number;
	readonly completed_at: number | null;
}

export interface AgentSessionChildCancellationResult {
	readonly request: AgentSessionChildCancellationRequestRecord;
	readonly run: AgentSessionChildRunRecord;
	readonly allocation: AgentSessionChildBudgetAllocationRecord;
	readonly applied: boolean;
}

export interface AgentSessionChildRunRecoveryRecord {
	readonly run: AgentSessionChildRunRecord;
	readonly allocation: AgentSessionChildBudgetAllocationRecord;
	readonly materialization: AgentMaterializationRecord | null;
	readonly reason: "claimable" | "materialized_lease_expired" | "cancellation_pending" | "accounting_held";
}

export interface AgentSessionChildControlRecord {
	readonly child_session_id: string;
	readonly child_run_id: string;
	readonly child_name: string;
	readonly model: string;
	readonly run_state: AgentSessionChildRunState;
	readonly session_state: AgentSessionLifecycleState;
}

export interface AgentSessionChildClosureRequestRecord {
	readonly closure_id: string;
	readonly child_run_id: string;
	readonly request_id: string;
	readonly request_digest: string;
	readonly actor: AgentSessionChildCancellationActor;
	readonly reason: string;
	readonly disposition: "closure_pending" | "already_closed";
	readonly created_at: number;
}

export interface AgentSessionChildClosureWorkClaim {
	readonly request: AgentSessionChildClosureRequestRecord;
	readonly run: AgentSessionChildRunRecord;
	readonly session: AgentSessionRecord;
	readonly materialization: AgentMaterializationRecord;
	readonly attempt: number;
	readonly consumer: string;
	readonly cleanup_token: string;
	readonly claim_expires_at: number;
	readonly claimed: boolean;
}

export interface AgentSessionChildClosureReceiptRecord {
	readonly closure_id: string;
	readonly child_run_id: string;
	readonly materialization_generation: number;
	readonly materialization_state: "passivated" | "completed" | "faulted" | "cancelled";
	readonly session_state: "closed";
	readonly allocation_state: AgentSessionChildBudgetAllocationRecord["state"];
	readonly receipt_digest: string;
	readonly created_at: number;
}

export interface ExecutionCellRecord {
	session_id: string;
	ordinal: number;
	cell_ref: string;
	lease_id: string;
	kernel_sandbox_id: string;
	input_id: string;
	code: string;
	status: string;
	execution_count: number | null;
	outputs_json: string;
	started_at: number;
	completed_at: number;
	duration_ms: number;
	generation: number;
	host_requests_json: string;
	cell_digest: string;
}

export type AgentMaterializationState =
	| "claimed"
	| "running"
	| "quiescing"
	| "quiescent"
	| "passivated"
	| "completed"
	| "faulted"
	| "cancelled"
	/** Scheduler-only unembodied activation tombstone after authority revocation. */
	| "authority_revoked";

export type AgentMaterializationFaultKind =
	| "worker_spawn"
	| "worker_exit"
	| "worker_timeout"
	| "worker_oom"
	| "worker_protocol"
	| "kernel_fault"
	| "quiescence_fault"
	| "checkpoint_fault"
	| "replay_divergence"
	| "host_invariant";

export interface AgentMaterializationRecord {
	session_id: string;
	generation: number;
	sandbox_id: string;
	activation_id: string;
	state: AgentMaterializationState;
	fault_kind: AgentMaterializationFaultKind | null;
	recoverable: boolean | null;
	checkpoint_id: string | null;
	kernel_checkpoint_id: string | null;
	created_at: number;
	updated_at: number;
	passivated_at: number | null;
}

export interface AgentMaterializationRecoveryClaim {
	readonly materialization: AgentMaterializationRecord;
	readonly child_run_id: string | null;
	readonly durable_outcome_status: "completed" | "failed" | null;
	/** Existing paired-kernel testimony. Terminal testimony is immutable first-wins. */
	readonly kernel_state: AgentSessionKernelState | null;
	/** Durable pre-spawn/bind authority for the generation's one kernel wrapper. */
	readonly kernel_launch_state: "not_requested" | "launching" | "bound" | "failed_unbound" | null;
	readonly kernel_launch_sandbox_id: string | null;
	readonly lifecycle_state: AgentSessionLifecycleState;
	readonly recovery_attempt: number;
	readonly recovery_consumer: string;
	readonly recovery_token: string;
	readonly recovery_expires_at: number;
	readonly claimed: boolean;
}

export interface KernelReplayWitness {
	readonly sessionId: string;
	readonly generation: number;
	readonly journalHeadDigest: string;
	readonly namespace: readonly string[];
	readonly createdAt: number;
}

export interface AgentSessionDocumentOp {
	session_id: string;
	rev: number;
	change_id: string;
	ts: number;
	actor: string;
	kind: string;
	patch: unknown;
	document: Record<string, unknown>;
}

export interface AgentSessionDriverLease {
	holder: string;
	clientId: string;
	claimTs: number;
	claimedAt: number;
	epoch: number;
}

export type AgentSessionCommandName = Extract<
	AgentSessionCommandNameV1,
	"prompt" | "follow_up" | "steer" | "abort" | "quiesce" | "goal.get" | "goal.create" | "goal.complete"
>;
export type AgentSessionCommandState = "queued" | "delivered" | "completed" | "failed" | "cancelled" | "rejected";

export interface AgentSessionCommandRecord {
	command_id: string;
	session_id: string;
	idempotency_key: string;
	command_digest: string;
	name: AgentSessionCommandName;
	payload: Record<string, unknown>;
	client_id: string;
	target_generation: number;
	delivery_generation: number | null;
	state: AgentSessionCommandState;
	result: unknown;
	error: string | null;
	submitted_at: number;
	delivered_at: number | null;
	completed_at: number | null;
}

/** One durable H1 projection, owned by the runtime store rather than a worker. */
export interface AgentSessionGoalProjectionRecord {
	session_id: string;
	reducer_state: GoalReducerState;
	handoff_state: PrimeGoalHandoffState;
	updated_at: number;
}

export type AgentSessionCommandActivationState = "pending" | "claimed" | "completed" | "failed";

/**
 * Durable ownership of the physical wake needed to deliver one already-admitted
 * command to a composted Prime Session. The command remains the logical work;
 * this row owns only renewable embodiment attempts.
 */
export interface AgentSessionCommandActivationRecord {
	readonly command_id: string;
	readonly session_id: string;
	readonly target_generation: number;
	readonly activation_id: string;
	readonly grant_snapshot_digest: string | null;
	readonly state: AgentSessionCommandActivationState;
	readonly attempt: number;
	readonly consumer: string | null;
	readonly claim_token: string | null;
	readonly claimed_at: number | null;
	readonly claim_expires_at: number | null;
	readonly heartbeat_at: number | null;
	readonly not_before: number;
	readonly last_error: string | null;
	readonly completed_at: number | null;
}

export interface AgentSessionCommandActivationClaim {
	readonly activation: AgentSessionCommandActivationRecord;
	readonly command: AgentSessionCommandRecord;
}

export interface AgentSessionCommandActivationLeaseInput {
	readonly consumer: string;
	readonly claimToken: string;
	readonly now: number;
}

export interface RenewAgentSessionCommandActivationLeaseInput extends AgentSessionCommandActivationLeaseInput {
	readonly leaseMs: number;
}

export type SettleAgentSessionCommandActivationInput = AgentSessionCommandActivationLeaseInput &
	(
		| { readonly outcome: "completed" }
		| { readonly outcome: "retryable_failure"; readonly error: string; readonly retryAt: number }
		| { readonly outcome: "terminal_failure"; readonly error: string }
	);

export class AgentSessionCommandActivationFault extends Error {
	readonly code = "agent_session_command_activation_fault";

	constructor(
		readonly reason: "not_found" | "lease_lost" | "lease_expired" | "materialization_conflict" | "request_invalid",
		message: string,
	) {
		super(message);
		this.name = "AgentSessionCommandActivationFault";
	}
}

export class AgentSessionCommandConflictError extends Error {
	readonly code = "agent_session_command_conflict";

	constructor(message: string) {
		super(message);
		this.name = "AgentSessionCommandConflictError";
	}
}

export interface SubmitAgentSessionCommandInput {
	commandId: string;
	idempotencyKey: string;
	name: AgentSessionCommandName;
	payload: Record<string, unknown>;
	clientId: string;
	now: number;
	targetGeneration?: number;
	requireDriver?: boolean;
}

export type AgentSessionScheduleDefinition =
	| { readonly kind: "once"; readonly fireAt: number }
	| { readonly kind: "interval"; readonly firstFireAt: number; readonly intervalMs: number }
	| { readonly kind: "cron"; readonly expression: string; readonly timezone: "UTC" };

export interface AgentSessionSchedulePrompt {
	readonly text: string;
}

export type ScheduledActivationAgentNodeSpec = AgentNodeSpec & {
	readonly sandboxGeneration: number;
	readonly invocationId: string;
	readonly awaitInitialCommand: true;
};

export type AgentSessionScheduleState = "active" | "paused" | "completed" | "cancelled";
export type AgentSessionScheduleFireState = "pending" | "claimed" | "completed" | "failed";
export type AgentSessionScheduleCancellationReason =
	| "requested"
	| "session_closed"
	| "session_faulted"
	| "authority_revoked";

/** Durable host authority for one logical Session schedule. */
export interface AgentSessionScheduleRecord {
	readonly schedule_id: string;
	readonly session_id: string;
	readonly create_request_id: string;
	readonly create_request_digest: string;
	readonly definition: AgentSessionScheduleDefinition;
	readonly prompt: AgentSessionSchedulePrompt;
	readonly client_id: string;
	readonly revision: number;
	readonly source: "internal" | "public" | "rlm_heartbeat";
	readonly label: string | null;
	readonly delivery_mode: "steer" | "follow_up";
	readonly grant_snapshot_digest: string | null;
	readonly state: AgentSessionScheduleState;
	readonly next_fire_at: number | null;
	readonly fire_count: number;
	readonly cancel_reason: string | null;
	readonly created_at: number;
	readonly updated_at: number;
	readonly completed_at: number | null;
	readonly cancelled_at: number | null;
}

/** One immutable, Session-keyed grant binding. Schedules may pin only its digest. */
export interface AgentSessionScheduleGrantBindingRecord {
	readonly session_id: string;
	readonly digest: string;
	readonly binding: AgentSessionScheduleGrantBindingV1;
	readonly captured_at: number;
}

export interface AgentSessionScheduleFireAuthorityAttemptRecord {
	readonly fire_id: string;
	readonly attempt: number;
	readonly outcome: "accepted" | "rejected" | "unavailable";
	readonly grant_digest: string | null;
	readonly revision: string | null;
	readonly code: string;
	readonly checked_at: number;
}

/**
 * One immutable logical fire joined with its mutable physical-attempt lease.
 * Fire, command and materialization coordinates never change across reclaim.
 */
export interface AgentSessionScheduleFireRecord {
	readonly fire_id: string;
	readonly schedule_id: string;
	readonly session_id: string;
	readonly ordinal: number;
	readonly scheduled_at: number;
	readonly coalesced_through_at: number;
	readonly coalesced_count: number;
	/** Exact immutable Session binding selected when this fire was created. */
	readonly grant_snapshot_digest: string | null;
	/** Requested schedule delivery; immutable even when a composted Session uses prompt. */
	readonly requested_delivery_mode: "steer" | "follow_up";
	/** Actual durable command selected at the due transaction. */
	readonly command_name: "prompt" | "steer" | "follow_up";
	readonly command_id: string;
	readonly target_generation: number;
	readonly activation_id: string;
	readonly created_at: number;
	readonly state: AgentSessionScheduleFireState;
	readonly attempt: number;
	readonly consumer: string | null;
	readonly claim_token: string | null;
	readonly claimed_at: number | null;
	readonly claim_expires_at: number | null;
	readonly heartbeat_at: number | null;
	readonly not_before: number;
	readonly last_error: string | null;
	readonly completed_at: number | null;
}

export interface AgentSessionScheduleFireClaim {
	readonly fire: AgentSessionScheduleFireRecord;
	readonly command: AgentSessionCommandRecord;
	readonly claimed: boolean;
}

export type AgentSessionScheduleCancellationDisposition = "cancelled" | "fire_preceded" | "already_terminal";

/** Immutable cancellation request testimony. */
export interface AgentSessionScheduleCancellationRecord {
	readonly cancellation_id: string;
	readonly session_id: string;
	readonly schedule_id: string;
	readonly request_id: string;
	readonly request_digest: string;
	readonly client_id: string;
	readonly reason: string;
	readonly disposition: AgentSessionScheduleCancellationDisposition;
	readonly created_at: number;
}

export interface CreateAgentSessionScheduleInput {
	readonly requestId: string;
	readonly scheduleId: string;
	readonly definition: AgentSessionScheduleDefinition;
	readonly prompt: AgentSessionSchedulePrompt;
	readonly clientId: string;
	readonly now: number;
	readonly options?: AgentSessionScheduleCreationOptionsV1;
}

export interface AgentSessionScheduleControlInput extends AgentSessionScheduleControlRequestV1 {
	readonly clientId: string;
	readonly now: number;
}

export interface CancelAgentSessionScheduleInput {
	readonly requestId: string;
	readonly clientId: string;
	readonly reason?: string;
	readonly now: number;
}

export interface AgentSessionScheduleFireLeaseInput {
	readonly consumer: string;
	readonly claimToken: string;
	readonly now: number;
}

export interface RenewAgentSessionScheduleFireLeaseInput extends AgentSessionScheduleFireLeaseInput {
	readonly leaseMs: number;
}

export type SettleAgentSessionScheduleFireInput = AgentSessionScheduleFireLeaseInput &
	(
		| { readonly outcome: "completed" }
		| { readonly outcome: "retryable_failure"; readonly error: string; readonly retryAt: number }
		| { readonly outcome: "terminal_failure"; readonly error: string }
	);

export type AgentSessionScheduleFaultReason =
	| "session_not_found"
	| "session_terminal"
	| "request_invalid"
	| "request_conflict"
	| "schedule_not_found"
	| "clock_regression"
	| "lease_lost"
	| "lease_expired"
	| "materialization_conflict";

export class AgentSessionScheduleFault extends Error {
	readonly code = "agent_session_schedule_invalid";

	constructor(
		readonly reason: AgentSessionScheduleFaultReason,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "AgentSessionScheduleFault";
	}
}

export type WorkflowBeatAmendmentKind = "skip" | "reorder" | "reparameterize" | "directive";
export type WorkflowBeatAmendmentState = "pending" | "applied" | "rejected";

export interface WorkflowBeatAmendment {
	id: string;
	clientId: string;
	kind: WorkflowBeatAmendmentKind;
	targetBeatId?: string;
	payload: Record<string, unknown>;
	ts: number;
	leaseEpoch: number;
	state: WorkflowBeatAmendmentState;
	appliedAt?: number;
	appliedBeatId?: string;
	rejection?: string;
}

export interface WorkflowBeatControlPoint {
	kind: "plan" | "before-beat" | "after-beat";
	beatId?: string;
	pendingBeatIds?: string[];
	ts: number;
}

export interface WorkflowControlRecord {
	runId: string;
	revision: number;
	driverLease: AgentSessionDriverLease | null;
	amendments: WorkflowBeatAmendment[];
	currentBeat: WorkflowBeatControlPoint | null;
	updatedAt: number;
}

export interface WorkflowControlMutationResult {
	control: WorkflowControlRecord;
	applied: boolean;
	driver: string | null;
	reason?: "not_driver" | "stale_claim" | "revision_conflict" | "lease_epoch_mismatch" | "amendment_conflict";
}

export interface WorkflowBeatDecision {
	schema: "choreograph.workflow-beat-decision.v1";
	runId: string;
	revision: number;
	stage: "plan" | "enter" | "complete";
	beatId?: string;
	action: "continue" | "skip" | "pause";
	parameters?: Record<string, unknown>;
	order?: string[];
	directives: string[];
	appliedAmendmentIds: string[];
	rejectedAmendmentIds: string[];
}

export interface EffectIdempotencyRecord {
	idempotency_key: string;
	proposal_digest: string;
	run_id: string;
	status: "claimed" | "complete";
	receipt: unknown;
	claimed_at: number;
	completed_at: number | null;
}

export interface DomainSourceTurnRecord {
	turn_id: string;
	turn_digest: string;
	source_ref: string;
	source_digest: string;
	trigger_digest: string;
	context_digest: string;
	owner_principal: string;
	graph_id: string;
	agent_id: string;
	actor_ref: string;
	auth_method: "owner" | "internal-service";
	trigger_adapter: string | null;
	first_invocation_id: string;
	turn: unknown;
	created_at: number;
	updated_at: number;
}

export type AgentMaterializationTransitionInput =
	| {
			readonly activationId: string;
			readonly from: AgentMaterializationState;
			readonly to: "faulted";
			readonly faultKind: AgentMaterializationFaultKind;
			readonly recoverable: boolean;
			readonly now: number;
	  }
	| {
			readonly activationId: string;
			readonly from: AgentMaterializationState;
			readonly to: Exclude<AgentMaterializationState, "faulted">;
			readonly now: number;
	  };

export class DomainSourceTurnConflictError extends Error {
	constructor(turnId: string) {
		super(`domain source turn '${turnId}' conflicts with different committed evidence`);
		this.name = "DomainSourceTurnConflictError";
	}
}

export interface OfferDomainSourceTurnInput {
	turnId: string;
	turnDigest: string;
	sourceRef: string;
	sourceDigest: string;
	triggerDigest: string;
	contextDigest: string;
	ownerPrincipal: string;
	graphId: string;
	agentId: string;
	actorRef: string;
	authMethod: "owner" | "internal-service";
	triggerAdapter?: string;
	invocationId: string;
	turn: unknown;
	now: number;
}

export type EffectHandoffState = "ready" | "claimed" | "executed" | "failed-terminal";

export class EffectHandoffConflictError extends Error {
	constructor(idempotencyKey: string) {
		super(`effect handoff '${idempotencyKey}' conflicts with different content`);
		this.name = "EffectHandoffConflictError";
	}
}

/** Durable, credential-free work offered to a trusted host adapter. */
export interface EffectHandoffRecord {
	idempotency_key: string;
	execution_digest: string;
	proposal_digest: string;
	run_id: string;
	graph_id: string;
	agent_id: string;
	actor_ref: string;
	grant_id: string;
	grant_document_id: string;
	grant_authority_graph_id: string;
	grant_authority_owner_principal: string;
	grant_digest: string;
	definition_digest: string | null;
	source_turn_id: string | null;
	source_turn_digest: string | null;
	source_owner_principal: string | null;
	source_turn: unknown;
	capability: string;
	operation: string;
	proposal: unknown;
	trigger: unknown;
	/** Human approval witnessed before this work crossed the host boundary. */
	approval: unknown;
	effect_index: number;
	state: EffectHandoffState;
	attempt: number;
	consumer: string | null;
	claim_token: string | null;
	lease_expires_at: number | null;
	not_before: number;
	completion: unknown;
	created_at: number;
	updated_at: number;
	completed_at: number | null;
}

export interface OfferEffectHandoffInput {
	idempotencyKey: string;
	executionDigest: string;
	proposalDigest: string;
	runId: string;
	graphId: string;
	agentId: string;
	actorRef: string;
	grantId: string;
	grantDocumentId: string;
	grantAuthorityGraphId: string;
	grantAuthorityOwnerPrincipal: string;
	grantDigest: string;
	definitionDigest?: string;
	sourceTurnId: string;
	sourceTurnDigest: string;
	sourceOwnerPrincipal: string;
	sourceTurn: unknown;
	capability: string;
	operation: string;
	proposal: unknown;
	trigger?: unknown;
	approval?: unknown;
	effectIndex: number;
	now: number;
}

export interface AgentSessionControlMutationResult {
	session: AgentSessionRecord;
	document: Record<string, unknown>;
	events: AgentSessionEvent[];
	documentOp?: AgentSessionDocumentOp;
	applied: boolean;
	driver: string | null;
	reason?: "not_driver" | "stale_claim";
}

export interface CreateWorkflowInstanceInput {
	runId: string;
	workflowName: string;
	graphId: string;
	ownerUserId: string;
	sourceSha256?: string;
	sourceText?: string;
	inputs: unknown;
	resumeFromRunId?: string;
	startedAt: number;
	payload?: unknown;
}

export interface PhanesPrivacyEpochBindingInput {
	runId: string;
	epochId: string;
	datasetGraphId: string;
	sourceEventRef: string;
	datasetEpoch: Readonly<Record<string, unknown>>;
	now: number;
}

export interface PhanesPrivacyRetirementScope {
	activeEpochId: string;
	homeGraphId: string;
	ownerUserId: string;
	graphOwnerPrincipal: string;
	workflowName: string;
}

export interface PhanesPrivacyRetirementPlan {
	retiredRunIds: string[];
	activeRunIds: string[];
	sandboxIds: string[];
}

export interface PhanesPrivacyRuntimePurgeReceipt {
	retiredRunIds: string[];
	retiredSourceTurnCount: number;
	retiredEffectCount: number;
	retiredAgentSessionCount: number;
}

export interface BeginAgentSessionInput {
	sessionId: string;
	runId: string;
	workflowName: string;
	graphId: string;
	ownerUserId: string;
	/** Exact durable graph address owner; distinct from the acting user. */
	graphOwnerPrincipal: string;
	spec: AgentNodeSpec;
	nodeKey: string;
	frontier: WorkflowFrontier;
	now: number;
}

export class AgentSessionBindingConflictError extends Error {
	readonly code = "agent_session_binding_conflict";

	constructor(
		readonly sessionId: string,
		readonly binding: "runtime" | "ontology",
		readonly expected: string,
		readonly actual: string | undefined,
	) {
		super(`agent session ${sessionId} cannot change its pinned ${binding} binding`);
		this.name = "AgentSessionBindingConflictError";
	}
}

export class AgentSessionGenerationFault extends Error {
	readonly code = "agent_session_generation_conflict";

	constructor(message: string) {
		super(message);
		this.name = "AgentSessionGenerationFault";
	}
}

/**
 * A regrow the predecessor generation can never permit: its durable testimony (checkpoint, runtime kind, terminal
 * kernel state, no-body tombstone) is fixed once it passivated or faulted, so waiting cannot change the answer. The
 * command activation path settles such a command terminally instead of re-admitting it on every claim (incident
 * 2026-10-13: one such command kept the orchestrator from ever listening).
 */
export class AgentSessionRegrowRefusedFault extends AgentSessionGenerationFault {
	readonly retryable = false;

	constructor(message: string) {
		super(message);
		this.name = "AgentSessionRegrowRefusedFault";
	}
}

/** Carries a regrow refusal out of the claim transaction, with the command it belongs to. */
class AgentSessionCommandActivationRefused extends Error {
	constructor(
		readonly commandId: string,
		readonly fault: AgentSessionRegrowRefusedFault,
	) {
		super(fault.message);
		this.name = "AgentSessionCommandActivationRefused";
	}
}

/** How many refused commands one claim call settles before it yields to the caller's next iteration. */
const MAX_REFUSED_COMMAND_ACTIVATIONS_PER_CLAIM = 32;

export type AgentSessionRelationFaultReason =
	| "session_not_found"
	| "self_relation"
	| "owner_mismatch"
	| "graph_mismatch"
	| "child_already_attached"
	| "cycle";

export class AgentSessionRelationFault extends Error {
	readonly code = "agent_session_relation_invalid";

	constructor(
		readonly reason: AgentSessionRelationFaultReason,
		message: string,
	) {
		super(message);
		this.name = "AgentSessionRelationFault";
	}
}

export type AgentSessionChildAdmissionFaultReason =
	| "parent_not_found"
	| "children_not_granted"
	| "request_conflict"
	| "request_invalid"
	| "binding_widening";

export class AgentSessionChildAdmissionFault extends Error {
	readonly code = "agent_session_child_admission_invalid";

	constructor(
		readonly reason: AgentSessionChildAdmissionFaultReason,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "AgentSessionChildAdmissionFault";
	}
}

export type AgentSessionChildRunFaultReason =
	| "run_not_found"
	| "not_claimable"
	| "lease_lost"
	| "lease_expired"
	| "terminal_conflict"
	| "materialization_conflict"
	| "accounting_blocked"
	| "cancellation_conflict"
	| "authority_invalid";

export class AgentSessionChildRunFault extends Error {
	readonly code = "agent_session_child_run_invalid";

	constructor(
		readonly reason: AgentSessionChildRunFaultReason,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "AgentSessionChildRunFault";
	}
}

const AGENT_SESSION_FAMILY_PROJECTION_REVISION_TABLES = [
	"agent_sessions",
	"agent_session_relations",
	"agent_session_child_admissions",
	"agent_session_child_runs",
	"agent_session_child_budget_allocations",
	"agent_session_budget_accounts",
	"agent_session_child_generation_occupancy",
	"agent_materializations",
	"agent_session_body_states",
] as const;

function agentSessionFamilyProjectionRevisionTriggers(): string[] {
	return AGENT_SESSION_FAMILY_PROJECTION_REVISION_TABLES.flatMap((table) =>
		(["INSERT", "UPDATE", "DELETE"] as const).map(
			(
				action,
			) => `CREATE TRIGGER IF NOT EXISTS bump_agent_session_family_projection_revision_${table}_${action.toLowerCase()}
				AFTER ${action} ON ${table}
				BEGIN
					UPDATE agent_session_family_projection_clock
					   SET revision = revision + 1
					 WHERE singleton = 1;
				END`,
		),
	);
}

const AGENT_SESSION_FAMILY_OUTBOX_ROOT_EXPRESSIONS = {
	agent_sessions: {
		insert: "NEW.family_root_session_id",
		update: "NEW.family_root_session_id",
		delete: "OLD.family_root_session_id",
	},
	agent_session_relations: {
		insert: "(SELECT family_root_session_id FROM agent_sessions WHERE session_id = NEW.parent_session_id)",
		update: "(SELECT family_root_session_id FROM agent_sessions WHERE session_id = NEW.parent_session_id)",
		delete: "(SELECT family_root_session_id FROM agent_sessions WHERE session_id = OLD.parent_session_id)",
	},
	agent_session_child_admissions: {
		insert: "(SELECT family_root_session_id FROM agent_sessions WHERE session_id = NEW.child_session_id)",
		update: "(SELECT family_root_session_id FROM agent_sessions WHERE session_id = NEW.child_session_id)",
		delete: "(SELECT family_root_session_id FROM agent_sessions WHERE session_id = OLD.child_session_id)",
	},
	agent_session_child_runs: {
		insert: "(SELECT family_root_session_id FROM agent_sessions WHERE session_id = NEW.child_session_id)",
		update: "(SELECT family_root_session_id FROM agent_sessions WHERE session_id = NEW.child_session_id)",
		delete: "(SELECT family_root_session_id FROM agent_sessions WHERE session_id = OLD.child_session_id)",
	},
	agent_session_child_budget_allocations: {
		insert: "(SELECT family_root_session_id FROM agent_sessions WHERE session_id = NEW.child_session_id)",
		update: "(SELECT family_root_session_id FROM agent_sessions WHERE session_id = NEW.child_session_id)",
		delete: "(SELECT family_root_session_id FROM agent_sessions WHERE session_id = OLD.child_session_id)",
	},
	agent_session_budget_accounts: {
		insert: "(SELECT family_root_session_id FROM agent_sessions WHERE session_id = NEW.session_id)",
		update: "(SELECT family_root_session_id FROM agent_sessions WHERE session_id = NEW.session_id)",
		delete: "(SELECT family_root_session_id FROM agent_sessions WHERE session_id = OLD.session_id)",
	},
	agent_session_child_generation_occupancy: {
		insert: "(SELECT family_root_session_id FROM agent_sessions WHERE session_id = NEW.child_session_id)",
		update: "(SELECT family_root_session_id FROM agent_sessions WHERE session_id = NEW.child_session_id)",
		delete: "(SELECT family_root_session_id FROM agent_sessions WHERE session_id = OLD.child_session_id)",
	},
	agent_materializations: {
		insert: "(SELECT family_root_session_id FROM agent_sessions WHERE session_id = NEW.session_id)",
		update: "(SELECT family_root_session_id FROM agent_sessions WHERE session_id = NEW.session_id)",
		delete: "(SELECT family_root_session_id FROM agent_sessions WHERE session_id = OLD.session_id)",
	},
	agent_session_body_states: {
		insert: "(SELECT family_root_session_id FROM agent_sessions WHERE session_id = NEW.session_id)",
		update: "(SELECT family_root_session_id FROM agent_sessions WHERE session_id = NEW.session_id)",
		delete: "(SELECT family_root_session_id FROM agent_sessions WHERE session_id = OLD.session_id)",
	},
} as const;

function agentSessionFamilyProjectionOutboxTriggers(): string[] {
	return Object.entries(AGENT_SESSION_FAMILY_OUTBOX_ROOT_EXPRESSIONS).flatMap(([table, expressions]) =>
		(["insert", "update", "delete"] as const).map((action) => {
			const root = expressions[action];
			return `CREATE TRIGGER IF NOT EXISTS enqueue_agent_session_family_projection_${table}_${action}
				AFTER ${action.toUpperCase()} ON ${table}
				BEGIN
					INSERT INTO agent_session_family_projection_outbox
						(root_session_id, work_kind, desired_revision, delivered_revision, state, not_before, updated_at)
					SELECT ${root}, 'project', 1, 0, 'pending', 0, CAST(unixepoch('subsec') * 1000 AS INTEGER)
					 WHERE ${root} IS NOT NULL
					ON CONFLICT(root_session_id) DO UPDATE SET
						desired_revision = desired_revision + 1,
						work_kind = 'project',
						state = CASE WHEN state = 'claimed' THEN 'claimed' ELSE 'pending' END,
						not_before = CASE WHEN state = 'claimed' THEN not_before ELSE 0 END,
						updated_at = excluded.updated_at;
				END`;
		}),
	);
}

/** A legacy chat a backfill has read and means to catalogue: what it took from the Session's document. */
export interface ChatBackfillCandidate {
	readonly sessionId: string;
	readonly ownerUserId: string;
	/** Derived from the Session's first message. */
	readonly title: string;
	readonly provider: string;
}

export class WorkflowRuntimeStore extends LibsqlStore {
	constructor(databasePath: string) {
		super(databasePath, {
			snapshotName: "workflow-runtime",
			s3Url: process.env.WORKFLOW_RUNTIME_S3_URL,
		});
	}

	protected async createSchema(): Promise<void> {
		await this.db.batch(
			[
				`CREATE TABLE IF NOT EXISTS workflow_instances (
					run_id             TEXT PRIMARY KEY,
					workflow_name      TEXT NOT NULL,
					graph_id           TEXT NOT NULL,
					owner_user_id      TEXT NOT NULL,
					status             TEXT NOT NULL,
					source_sha256      TEXT,
					source_text        TEXT,
					inputs_json        TEXT NOT NULL,
					resume_from_run_id TEXT,
					frontier_json      TEXT,
					pause_requested_at INTEGER,
					pause_reason       TEXT,
					stop_requested_at  INTEGER,
					stop_requested_by  TEXT,
					stop_reason        TEXT,
					started_at         INTEGER NOT NULL,
					updated_at         INTEGER NOT NULL,
					ended_at           INTEGER,
					payload_json        TEXT
				)`,
				`CREATE TABLE IF NOT EXISTS agent_sessions (
					session_id   TEXT PRIMARY KEY,
					run_id       TEXT NOT NULL,
					owner_user_id TEXT NOT NULL,
					graph_owner_principal TEXT NOT NULL CHECK (
						instr(graph_owner_principal, char(0)) = 0
						AND
						length(substr(graph_owner_principal, instr(graph_owner_principal, ':') + 1)) BETWEEN 1 AND 192
						AND graph_owner_principal NOT GLOB '*[^A-Za-z0-9_.@:-]*'
						AND (
							graph_owner_principal GLOB 'user:?*'
							OR graph_owner_principal GLOB 'agent:?*'
							OR graph_owner_principal GLOB 'service:?*'
							OR graph_owner_principal GLOB 'organization:?*'
						)
					),
					graph_id     TEXT NOT NULL,
					workflow_name TEXT NOT NULL,
					node_key     TEXT NOT NULL,
					label        TEXT NOT NULL,
					phase_index  INTEGER NOT NULL,
					agent_id     TEXT,
					sandbox_id   TEXT,
					model        TEXT NOT NULL,
					family_root_session_id TEXT NOT NULL,
					status       TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
					lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('open', 'closing', 'closed', 'faulted')),
					frontier_json TEXT,
					result_json  TEXT,
					lifecycle_terminal_digest TEXT,
					document_json TEXT NOT NULL,
					created_at   INTEGER NOT NULL,
					updated_at   INTEGER NOT NULL,
					completed_at INTEGER,
					UNIQUE(run_id, node_key),
					CHECK ((lifecycle_state IN ('open', 'closing') AND lifecycle_terminal_digest IS NULL)
					    OR (lifecycle_state IN ('closed', 'faulted') AND lifecycle_terminal_digest IS NOT NULL)),
					CHECK (created_at >= 0 AND updated_at >= 0 AND (completed_at IS NULL OR completed_at >= 0)),
					FOREIGN KEY (family_root_session_id) REFERENCES agent_sessions(session_id)
						DEFERRABLE INITIALLY DEFERRED
				)`,
				`CREATE TABLE IF NOT EXISTS agent_session_events (
					session_id TEXT NOT NULL,
					seq        INTEGER NOT NULL,
					ts         INTEGER NOT NULL,
					type       TEXT NOT NULL,
					causation_id TEXT,
					command_id TEXT,
					payload_json TEXT,
					PRIMARY KEY (session_id, seq),
					FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT
				)`,
				`CREATE TABLE IF NOT EXISTS agent_session_run_outcomes (
					session_id     TEXT NOT NULL,
					outcome_id     TEXT NOT NULL,
					outcome_digest TEXT NOT NULL,
					status         TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'cancelled')),
					result_json    TEXT NOT NULL,
					frontier_json  TEXT NOT NULL,
					created_at     INTEGER NOT NULL,
					PRIMARY KEY (session_id, outcome_id),
					FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT
				)`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_run_outcomes_immutable_update
					BEFORE UPDATE ON agent_session_run_outcomes
					BEGIN SELECT RAISE(ABORT, 'agent_session_run_outcomes are immutable'); END`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_run_outcomes_immutable_delete
					BEFORE DELETE ON agent_session_run_outcomes
					BEGIN SELECT RAISE(ABORT, 'agent_session_run_outcomes are immutable'); END`,
				`CREATE TABLE IF NOT EXISTS agent_session_lifecycle_transitions (
					session_id       TEXT NOT NULL,
					ordinal          INTEGER NOT NULL CHECK (ordinal >= 0),
					from_state       TEXT NOT NULL CHECK (from_state IN ('open', 'closing', 'closed', 'faulted')),
					to_state         TEXT NOT NULL CHECK (to_state IN ('closed', 'faulted')),
					reference_id     TEXT NOT NULL,
					transition_digest TEXT NOT NULL,
					created_at       INTEGER NOT NULL,
					PRIMARY KEY (session_id, ordinal),
					UNIQUE (session_id, reference_id),
					FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT
				)`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_lifecycle_transitions_immutable_update
					BEFORE UPDATE ON agent_session_lifecycle_transitions
					BEGIN SELECT RAISE(ABORT, 'agent_session_lifecycle_transitions are immutable'); END`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_lifecycle_transitions_immutable_delete
					BEFORE DELETE ON agent_session_lifecycle_transitions
					BEGIN SELECT RAISE(ABORT, 'agent_session_lifecycle_transitions are immutable'); END`,
				`CREATE TABLE IF NOT EXISTS agent_session_relations (
					relation_id      TEXT PRIMARY KEY,
					relation_kind    TEXT NOT NULL CHECK (relation_kind = 'parent_child'),
					parent_session_id TEXT NOT NULL,
					child_session_id  TEXT NOT NULL UNIQUE,
					owner_user_id     TEXT NOT NULL,
					graph_id          TEXT NOT NULL,
					causation_id      TEXT,
					created_at        INTEGER NOT NULL,
					CHECK (parent_session_id <> child_session_id),
					UNIQUE (parent_session_id, child_session_id),
					UNIQUE (relation_id, parent_session_id, child_session_id),
					FOREIGN KEY (parent_session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT,
					FOREIGN KEY (child_session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT
				)`,
				`CREATE TABLE IF NOT EXISTS agent_session_child_admissions (
					admission_id            TEXT PRIMARY KEY,
					parent_session_id       TEXT NOT NULL,
					request_id              TEXT NOT NULL,
					request_digest          TEXT NOT NULL,
					child_session_id        TEXT NOT NULL UNIQUE,
					child_run_id            TEXT NOT NULL UNIQUE,
					relation_id             TEXT NOT NULL UNIQUE,
					child_name              TEXT NOT NULL,
					depth                   INTEGER NOT NULL CHECK (depth >= 1),
					runtime_binding_digest  TEXT NOT NULL,
					ontology_binding_digest TEXT NOT NULL,
					budget_allocation_id     TEXT NOT NULL UNIQUE,
					budget_json             TEXT NOT NULL,
					created_at              INTEGER NOT NULL,
					UNIQUE (parent_session_id, request_id),
					UNIQUE (parent_session_id, child_name),
					UNIQUE (admission_id, parent_session_id, child_session_id),
					UNIQUE (admission_id, parent_session_id, child_session_id, child_run_id),
					FOREIGN KEY (parent_session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT,
					FOREIGN KEY (child_session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT,
					FOREIGN KEY (relation_id) REFERENCES agent_session_relations(relation_id) ON DELETE RESTRICT,
					FOREIGN KEY (relation_id, parent_session_id, child_session_id)
						REFERENCES agent_session_relations(relation_id, parent_session_id, child_session_id) ON DELETE RESTRICT,
					FOREIGN KEY (budget_allocation_id) REFERENCES agent_session_child_budget_allocations(allocation_id)
						DEFERRABLE INITIALLY DEFERRED,
					FOREIGN KEY (child_run_id) REFERENCES agent_session_child_runs(child_run_id)
						DEFERRABLE INITIALLY DEFERRED
				)`,
				`CREATE TABLE IF NOT EXISTS agent_session_child_spawn_requests (
					parent_session_id TEXT NOT NULL,
					request_id        TEXT NOT NULL,
					request_digest    TEXT NOT NULL,
					decision          TEXT NOT NULL CHECK (decision IN ('accepted', 'denied')),
					admission_id      TEXT,
					child_session_id  TEXT,
					child_run_id      TEXT,
					denial_code       TEXT,
					denial_message    TEXT,
					created_at        INTEGER NOT NULL,
					PRIMARY KEY (parent_session_id, request_id),
					CHECK (
						(decision = 'accepted' AND admission_id IS NOT NULL AND child_session_id IS NOT NULL
						 AND child_run_id IS NOT NULL
						 AND denial_code IS NULL AND denial_message IS NULL)
						OR
						(decision = 'denied' AND admission_id IS NULL AND child_session_id IS NULL
						 AND child_run_id IS NULL
						 AND denial_code IS NOT NULL AND denial_message IS NOT NULL)
					),
					FOREIGN KEY (parent_session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT
				)`,
				`CREATE TABLE IF NOT EXISTS agent_session_child_budget_allocations (
					allocation_id     TEXT PRIMARY KEY,
					admission_id      TEXT NOT NULL UNIQUE,
					parent_session_id TEXT NOT NULL,
					child_session_id  TEXT NOT NULL UNIQUE,
					state             TEXT NOT NULL CHECK (state IN ('reserved', 'accounting_hold', 'settled', 'released')),
					budget_json       TEXT NOT NULL,
					hold_reason       TEXT CHECK (hold_reason IS NULL OR hold_reason = 'unresolved_child_reservations'),
					created_at        INTEGER NOT NULL,
					held_at           INTEGER,
					settled_at        INTEGER,
					CHECK (
						(state = 'reserved' AND hold_reason IS NULL AND held_at IS NULL AND settled_at IS NULL)
						OR (state = 'accounting_hold' AND hold_reason = 'unresolved_child_reservations'
						    AND held_at IS NOT NULL AND settled_at IS NULL)
						OR (state IN ('settled', 'released') AND hold_reason IS NULL AND settled_at IS NOT NULL)
					),
					CHECK (created_at >= 0
					    AND (held_at IS NULL OR held_at >= created_at)
					    AND (settled_at IS NULL OR (settled_at >= created_at AND (held_at IS NULL OR settled_at >= held_at))))
					,FOREIGN KEY (admission_id) REFERENCES agent_session_child_admissions(admission_id)
						DEFERRABLE INITIALLY DEFERRED
					,FOREIGN KEY (admission_id, parent_session_id, child_session_id)
						REFERENCES agent_session_child_admissions(admission_id, parent_session_id, child_session_id)
						DEFERRABLE INITIALLY DEFERRED
					,FOREIGN KEY (parent_session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT
					,FOREIGN KEY (child_session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT
				)`,
				`CREATE TABLE IF NOT EXISTS agent_session_budget_accounts (
					session_id               TEXT PRIMARY KEY,
					limit_turns              INTEGER NOT NULL CHECK (limit_turns >= 0),
					limit_wall_time_ms       INTEGER NOT NULL CHECK (limit_wall_time_ms >= 0),
					limit_tokens             INTEGER NOT NULL CHECK (limit_tokens >= 0),
					limit_cost_usd_micros    INTEGER NOT NULL CHECK (limit_cost_usd_micros >= 0),
					limit_artifact_bytes     INTEGER NOT NULL CHECK (limit_artifact_bytes >= 0),
					reserved_turns           INTEGER NOT NULL DEFAULT 0 CHECK (reserved_turns >= 0),
					reserved_wall_time_ms    INTEGER NOT NULL DEFAULT 0 CHECK (reserved_wall_time_ms >= 0),
					reserved_tokens          INTEGER NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
					reserved_cost_usd_micros INTEGER NOT NULL DEFAULT 0 CHECK (reserved_cost_usd_micros >= 0),
					reserved_artifact_bytes  INTEGER NOT NULL DEFAULT 0 CHECK (reserved_artifact_bytes >= 0),
					spent_turns              INTEGER NOT NULL DEFAULT 0 CHECK (spent_turns >= 0),
					spent_wall_time_ms       INTEGER NOT NULL DEFAULT 0 CHECK (spent_wall_time_ms >= 0),
					spent_tokens             INTEGER NOT NULL DEFAULT 0 CHECK (spent_tokens >= 0),
					spent_cost_usd_micros    INTEGER NOT NULL DEFAULT 0 CHECK (spent_cost_usd_micros >= 0),
					spent_artifact_bytes     INTEGER NOT NULL DEFAULT 0 CHECK (spent_artifact_bytes >= 0),
					exhausted                INTEGER NOT NULL DEFAULT 0 CHECK (exhausted IN (0, 1)),
					revision                 INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
					created_at               INTEGER NOT NULL,
					updated_at               INTEGER NOT NULL
					,FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT
				)`,
				`CREATE TABLE IF NOT EXISTS agent_session_budget_entries (
					entry_id                       TEXT PRIMARY KEY,
					session_id                     TEXT NOT NULL,
					ordinal                        INTEGER NOT NULL CHECK (ordinal >= 0),
					kind                           TEXT NOT NULL,
					reference_id                   TEXT NOT NULL,
					reserved_turns_delta           INTEGER NOT NULL,
					reserved_wall_time_ms_delta    INTEGER NOT NULL,
					reserved_tokens_delta          INTEGER NOT NULL,
					reserved_cost_usd_micros_delta INTEGER NOT NULL,
					reserved_artifact_bytes_delta  INTEGER NOT NULL,
					spent_turns_delta              INTEGER NOT NULL,
					spent_wall_time_ms_delta       INTEGER NOT NULL,
					spent_tokens_delta             INTEGER NOT NULL,
					spent_cost_usd_micros_delta    INTEGER NOT NULL,
					spent_artifact_bytes_delta     INTEGER NOT NULL,
					detail_json                    TEXT NOT NULL,
					created_at                     INTEGER NOT NULL,
					UNIQUE (session_id, ordinal),
					UNIQUE (session_id, kind, reference_id),
					FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT
				)`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_budget_entries_immutable_update
					BEFORE UPDATE ON agent_session_budget_entries
					BEGIN SELECT RAISE(ABORT, 'agent_session_budget_entries are immutable'); END`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_budget_entries_immutable_delete
					BEFORE DELETE ON agent_session_budget_entries
					BEGIN SELECT RAISE(ABORT, 'agent_session_budget_entries are immutable'); END`,
				`CREATE TABLE IF NOT EXISTS agent_session_inference_reservations (
					operation_id          TEXT PRIMARY KEY,
					session_id            TEXT NOT NULL,
					generation            INTEGER NOT NULL CHECK (generation >= 0),
					activation_id         TEXT NOT NULL,
					sandbox_id            TEXT NOT NULL,
					request_id            TEXT NOT NULL,
					request_digest        TEXT NOT NULL,
					reservation_digest    TEXT NOT NULL,
					causation_id          TEXT NOT NULL,
					provider              TEXT NOT NULL,
					model                 TEXT NOT NULL,
					pricing_version       TEXT NOT NULL,
					estimated_input_tokens INTEGER NOT NULL CHECK (estimated_input_tokens >= 0),
					max_output_tokens     INTEGER NOT NULL CHECK (max_output_tokens >= 1),
					state                 TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'indeterminate', 'released')),
					budget_json           TEXT NOT NULL,
					usage_json            TEXT,
					reason                TEXT,
					created_at            INTEGER NOT NULL,
					updated_at            INTEGER NOT NULL,
					terminal_at           INTEGER,
					UNIQUE (session_id, generation, request_id),
					FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT
				)`,
				`CREATE TABLE IF NOT EXISTS agent_session_inference_billing_outbox (
					operation_id  TEXT PRIMARY KEY,
					session_id   TEXT NOT NULL,
					payload_json TEXT NOT NULL,
					payload_digest TEXT NOT NULL,
					state         TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'delivered')),
					consumer      TEXT,
					claim_token   TEXT,
					claimed_at    INTEGER,
					claim_expires_at INTEGER,
					delivered_at  INTEGER,
					created_at    INTEGER NOT NULL,
					FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT
				)`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_inference_billing_outbox_payload_immutable
					BEFORE UPDATE ON agent_session_inference_billing_outbox
					WHEN NEW.operation_id <> OLD.operation_id OR NEW.session_id <> OLD.session_id
					  OR NEW.payload_json <> OLD.payload_json OR NEW.payload_digest <> OLD.payload_digest
					  OR NEW.created_at <> OLD.created_at
					BEGIN SELECT RAISE(ABORT, 'inference billing outbox payload is immutable'); END`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_inference_billing_outbox_immutable_delete
					BEFORE DELETE ON agent_session_inference_billing_outbox
					BEGIN SELECT RAISE(ABORT, 'inference billing outbox is immutable'); END`,
				`CREATE TABLE IF NOT EXISTS agent_session_child_generation_occupancy (
					parent_session_id TEXT NOT NULL,
					child_session_id  TEXT NOT NULL,
					generation        INTEGER NOT NULL CHECK (generation >= 0),
					state             TEXT NOT NULL CHECK (state IN ('occupied', 'released')),
					acquired_at       INTEGER NOT NULL,
					released_at       INTEGER,
					PRIMARY KEY (child_session_id, generation),
					CHECK ((state = 'occupied' AND released_at IS NULL)
					    OR (state = 'released' AND released_at IS NOT NULL)),
					CHECK (acquired_at >= 0 AND (released_at IS NULL OR released_at >= acquired_at))
					,FOREIGN KEY (parent_session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT
					,FOREIGN KEY (child_session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT
					,FOREIGN KEY (parent_session_id, child_session_id)
						REFERENCES agent_session_relations(parent_session_id, child_session_id) ON DELETE RESTRICT
				)`,
				`CREATE INDEX IF NOT EXISTS idx_child_generation_occupancy_parent_state
					ON agent_session_child_generation_occupancy(parent_session_id, state)`,
				`CREATE TABLE IF NOT EXISTS agent_session_child_runs (
					child_run_id      TEXT PRIMARY KEY,
					admission_id      TEXT NOT NULL UNIQUE,
					parent_session_id TEXT NOT NULL,
					child_session_id  TEXT NOT NULL UNIQUE,
					state             TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'cancelling', 'completed', 'failed', 'cancelled')),
					attempt           INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
					consumer          TEXT,
					claim_token       TEXT,
					claimed_at        INTEGER,
					claim_expires_at  INTEGER,
					heartbeat_at      INTEGER,
					materialization_generation INTEGER,
					materialized_at   INTEGER,
					result_json       TEXT,
					error             TEXT,
					terminal_digest   TEXT,
					created_at        INTEGER NOT NULL,
					terminal_at       INTEGER,
					CHECK (
						(state = 'queued' AND attempt = 0 AND consumer IS NULL AND claim_token IS NULL
						 AND claimed_at IS NULL AND claim_expires_at IS NULL AND heartbeat_at IS NULL
						 AND materialization_generation IS NULL AND materialized_at IS NULL
						 AND terminal_digest IS NULL AND terminal_at IS NULL)
						OR
						(state IN ('claimed', 'cancelling') AND attempt > 0 AND consumer IS NOT NULL
						 AND claim_token IS NOT NULL AND claimed_at IS NOT NULL AND claim_expires_at IS NOT NULL
						 AND heartbeat_at IS NOT NULL AND terminal_digest IS NULL AND terminal_at IS NULL)
						OR
						(state IN ('completed', 'failed', 'cancelled') AND terminal_digest IS NOT NULL AND terminal_at IS NOT NULL)
					),
					CHECK ((materialization_generation IS NULL) = (materialized_at IS NULL)),
					CHECK (created_at >= 0 AND (claimed_at IS NULL OR claimed_at >= created_at)
					    AND (heartbeat_at IS NULL OR heartbeat_at >= claimed_at)
					    AND (claim_expires_at IS NULL OR claim_expires_at > heartbeat_at)
					    AND (materialized_at IS NULL OR materialized_at >= claimed_at)
					    AND (terminal_at IS NULL OR (terminal_at >= created_at
					         AND (heartbeat_at IS NULL OR terminal_at >= heartbeat_at)
					         AND (materialized_at IS NULL OR terminal_at >= materialized_at)))),
					UNIQUE (child_session_id, child_run_id),
					FOREIGN KEY (admission_id) REFERENCES agent_session_child_admissions(admission_id)
						DEFERRABLE INITIALLY DEFERRED,
					FOREIGN KEY (admission_id, parent_session_id, child_session_id, child_run_id)
						REFERENCES agent_session_child_admissions(admission_id, parent_session_id, child_session_id, child_run_id)
						DEFERRABLE INITIALLY DEFERRED,
					FOREIGN KEY (parent_session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT,
					FOREIGN KEY (child_session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT
					,FOREIGN KEY (child_session_id, materialization_generation)
						REFERENCES agent_materializations(session_id, generation) DEFERRABLE INITIALLY DEFERRED
				)`,
				`CREATE TABLE IF NOT EXISTS agent_session_descendant_cascades (
					cascade_id       TEXT PRIMARY KEY,
					root_session_id  TEXT NOT NULL,
					cause            TEXT NOT NULL CHECK (cause IN ('explicit_cancel', 'irrecoverable_fault')),
					cause_digest     TEXT NOT NULL,
					reason           TEXT NOT NULL,
					state            TEXT NOT NULL CHECK (state IN ('active', 'completed')),
					created_at       INTEGER NOT NULL CHECK (created_at >= 0),
					completed_at     INTEGER,
					UNIQUE (root_session_id),
					UNIQUE (root_session_id, cause_digest),
					UNIQUE (cascade_id, cause_digest),
					UNIQUE (cascade_id, root_session_id),
					FOREIGN KEY (root_session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT,
					CHECK ((state = 'active' AND completed_at IS NULL)
					    OR (state = 'completed' AND completed_at IS NOT NULL AND completed_at >= created_at))
				)`,
				`CREATE TABLE IF NOT EXISTS agent_session_admission_fences (
					session_id      TEXT PRIMARY KEY,
					cascade_id      TEXT NOT NULL,
					cause_digest    TEXT NOT NULL,
					closed_at       INTEGER NOT NULL CHECK (closed_at >= 0),
					FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT,
					FOREIGN KEY (cascade_id, cause_digest)
						REFERENCES agent_session_descendant_cascades(cascade_id, cause_digest) ON DELETE RESTRICT,
					FOREIGN KEY (cascade_id, session_id)
						REFERENCES agent_session_descendant_cascade_members(cascade_id, session_id)
						ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
				)`,
				`CREATE TABLE IF NOT EXISTS agent_session_cancellation_requests (
					session_id      TEXT NOT NULL,
					request_id      TEXT NOT NULL,
					request_digest  TEXT NOT NULL,
					actor_json      TEXT NOT NULL,
					reason          TEXT NOT NULL,
					cascade_id      TEXT NOT NULL UNIQUE,
					created_at      INTEGER NOT NULL CHECK (created_at >= 0),
					PRIMARY KEY (session_id, request_id),
					FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT,
					FOREIGN KEY (cascade_id) REFERENCES agent_session_descendant_cascades(cascade_id) ON DELETE RESTRICT,
					FOREIGN KEY (cascade_id, session_id)
						REFERENCES agent_session_descendant_cascades(cascade_id, root_session_id) ON DELETE RESTRICT
				)`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_cancellation_requests_immutable_update
					BEFORE UPDATE ON agent_session_cancellation_requests
					BEGIN SELECT RAISE(ABORT, 'agent_session_cancellation_requests are immutable'); END`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_cancellation_requests_immutable_delete
					BEFORE DELETE ON agent_session_cancellation_requests
					BEGIN SELECT RAISE(ABORT, 'agent_session_cancellation_requests are immutable'); END`,
				`CREATE TABLE IF NOT EXISTS agent_session_descendant_cascade_members (
					cascade_id      TEXT NOT NULL,
					session_id      TEXT NOT NULL,
					child_run_id    TEXT,
					depth           INTEGER NOT NULL CHECK (depth >= 0),
					action          TEXT NOT NULL CHECK (action IN ('root', 'cancel', 'close', 'none')),
					created_at      INTEGER NOT NULL CHECK (created_at >= 0),
					PRIMARY KEY (cascade_id, session_id),
					FOREIGN KEY (cascade_id) REFERENCES agent_session_descendant_cascades(cascade_id) ON DELETE RESTRICT,
					FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT,
					FOREIGN KEY (child_run_id) REFERENCES agent_session_child_runs(child_run_id) ON DELETE RESTRICT,
					FOREIGN KEY (session_id, child_run_id)
						REFERENCES agent_session_child_runs(child_session_id, child_run_id) ON DELETE RESTRICT,
					CHECK ((depth = 0 AND action = 'root') OR (depth > 0 AND action <> 'root')),
					CHECK (action NOT IN ('cancel', 'close') OR child_run_id IS NOT NULL)
				)`,
				`CREATE TABLE IF NOT EXISTS agent_session_child_cancellation_requests (
					cancellation_id   TEXT PRIMARY KEY,
					child_run_id      TEXT NOT NULL,
					request_id        TEXT NOT NULL,
					request_digest    TEXT NOT NULL,
					actor_json        TEXT NOT NULL,
					reason            TEXT NOT NULL,
					disposition       TEXT NOT NULL CHECK (disposition IN ('cancelled_before_materialization', 'cancellation_pending', 'terminal_preceded')),
					observed_run_state TEXT NOT NULL CHECK (observed_run_state IN ('queued', 'claimed', 'cancelling', 'completed', 'failed', 'cancelled')),
					created_at        INTEGER NOT NULL CHECK (created_at >= 0),
					UNIQUE (child_run_id, request_id),
					FOREIGN KEY (child_run_id) REFERENCES agent_session_child_runs(child_run_id) ON DELETE RESTRICT
				)`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_child_cancellations_immutable_update
					BEFORE UPDATE ON agent_session_child_cancellation_requests
					BEGIN SELECT RAISE(ABORT, 'agent_session_child_cancellation_requests are immutable'); END`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_child_cancellations_immutable_delete
					BEFORE DELETE ON agent_session_child_cancellation_requests
					BEGIN SELECT RAISE(ABORT, 'agent_session_child_cancellation_requests are immutable'); END`,
				`CREATE TABLE IF NOT EXISTS agent_session_child_closure_requests (
					closure_id       TEXT PRIMARY KEY,
					child_run_id      TEXT NOT NULL,
					request_id        TEXT NOT NULL,
					request_digest    TEXT NOT NULL,
					actor_json        TEXT NOT NULL,
					reason            TEXT NOT NULL,
					disposition       TEXT NOT NULL CHECK (disposition IN ('closure_pending', 'already_closed')),
					created_at        INTEGER NOT NULL CHECK (created_at >= 0),
					UNIQUE (child_run_id, request_id),
					UNIQUE (child_run_id),
					UNIQUE (closure_id, child_run_id),
					FOREIGN KEY (child_run_id) REFERENCES agent_session_child_runs(child_run_id) ON DELETE RESTRICT
				)`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_child_closure_requests_immutable_update
					BEFORE UPDATE ON agent_session_child_closure_requests
					BEGIN SELECT RAISE(ABORT, 'agent_session_child_closure_requests are immutable'); END`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_child_closure_requests_immutable_delete
					BEFORE DELETE ON agent_session_child_closure_requests
					BEGIN SELECT RAISE(ABORT, 'agent_session_child_closure_requests are immutable'); END`,
				`CREATE TABLE IF NOT EXISTS agent_session_child_closure_work (
					closure_id       TEXT PRIMARY KEY,
					child_run_id     TEXT NOT NULL UNIQUE,
					state            TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'completed')),
					attempt          INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
					consumer         TEXT,
					cleanup_token    TEXT,
					claimed_at       INTEGER,
					claim_expires_at INTEGER,
					heartbeat_at     INTEGER,
					completed_at     INTEGER,
					created_at       INTEGER NOT NULL CHECK (created_at >= 0),
					updated_at       INTEGER NOT NULL CHECK (updated_at >= created_at),
					FOREIGN KEY (closure_id, child_run_id)
						REFERENCES agent_session_child_closure_requests(closure_id, child_run_id) ON DELETE RESTRICT,
					CHECK (
						(state = 'pending' AND consumer IS NULL AND cleanup_token IS NULL AND claimed_at IS NULL
						 AND claim_expires_at IS NULL AND heartbeat_at IS NULL AND completed_at IS NULL)
						OR (state = 'claimed' AND consumer IS NOT NULL AND cleanup_token IS NOT NULL
						 AND claimed_at IS NOT NULL AND claim_expires_at IS NOT NULL AND heartbeat_at IS NOT NULL
						 AND completed_at IS NULL AND heartbeat_at >= claimed_at AND claim_expires_at > heartbeat_at)
						OR (state = 'completed' AND consumer IS NULL AND cleanup_token IS NULL AND claimed_at IS NULL
						 AND claim_expires_at IS NULL AND heartbeat_at IS NULL AND completed_at IS NOT NULL)
					),
					CHECK (completed_at IS NULL OR completed_at >= created_at)
				)`,
				`CREATE TABLE IF NOT EXISTS agent_session_child_closure_receipts (
					closure_id       TEXT PRIMARY KEY,
					child_run_id     TEXT NOT NULL UNIQUE,
					materialization_generation INTEGER NOT NULL CHECK (materialization_generation >= 0),
					materialization_state TEXT NOT NULL CHECK (materialization_state IN ('passivated', 'completed', 'faulted', 'cancelled')),
					session_state   TEXT NOT NULL CHECK (session_state = 'closed'),
					allocation_state TEXT NOT NULL CHECK (allocation_state IN ('accounting_hold', 'settled', 'released')),
					receipt_digest  TEXT NOT NULL,
					created_at      INTEGER NOT NULL CHECK (created_at >= 0),
					FOREIGN KEY (closure_id, child_run_id)
						REFERENCES agent_session_child_closure_requests(closure_id, child_run_id) ON DELETE RESTRICT,
					FOREIGN KEY (child_run_id) REFERENCES agent_session_child_runs(child_run_id) ON DELETE RESTRICT
				)`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_child_closure_receipts_immutable_update
					BEFORE UPDATE ON agent_session_child_closure_receipts
					BEGIN SELECT RAISE(ABORT, 'agent_session_child_closure_receipts are immutable'); END`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_child_closure_receipts_immutable_delete
					BEFORE DELETE ON agent_session_child_closure_receipts
					BEGIN SELECT RAISE(ABORT, 'agent_session_child_closure_receipts are immutable'); END`,
				`CREATE TABLE IF NOT EXISTS agent_session_document_ops (
					session_id   TEXT NOT NULL,
					rev          INTEGER NOT NULL,
					change_id    TEXT NOT NULL,
					ts           INTEGER NOT NULL,
					actor        TEXT NOT NULL,
					kind         TEXT NOT NULL,
					patch_json   TEXT NOT NULL,
					document_json TEXT NOT NULL,
					PRIMARY KEY (session_id, rev),
					UNIQUE(session_id, change_id)
				)`,
				`CREATE TABLE IF NOT EXISTS agent_session_commands (
					command_id          TEXT PRIMARY KEY,
					session_id          TEXT NOT NULL,
					idempotency_key     TEXT NOT NULL,
					command_digest      TEXT NOT NULL,
					name                TEXT NOT NULL,
					payload_json        TEXT NOT NULL,
					client_id           TEXT NOT NULL,
					target_generation   INTEGER NOT NULL,
					delivery_generation INTEGER,
					state               TEXT NOT NULL,
					result_json         TEXT,
					error               TEXT,
					submitted_at        INTEGER NOT NULL,
					delivered_at        INTEGER,
					completed_at        INTEGER,
					UNIQUE(session_id, idempotency_key)
				)`,
				`CREATE TABLE IF NOT EXISTS agent_session_goal_projections (
					session_id          TEXT PRIMARY KEY,
					reducer_state_json  TEXT NOT NULL,
					handoff_state_json  TEXT NOT NULL,
					updated_at          INTEGER NOT NULL CHECK (updated_at >= 0),
					FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT
				)`,
				`CREATE TABLE IF NOT EXISTS agent_session_schedule_clock (
					singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
					last_now  INTEGER NOT NULL CHECK (last_now >= 0)
				)`,
				`CREATE TABLE IF NOT EXISTS agent_session_schedule_grant_bindings (
					session_id   TEXT NOT NULL,
					digest       TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
					binding_json TEXT NOT NULL,
					captured_at  INTEGER NOT NULL CHECK (captured_at >= 0),
					PRIMARY KEY (session_id, digest),
					FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT
				)`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_schedule_grant_bindings_immutable_update
					BEFORE UPDATE ON agent_session_schedule_grant_bindings
					BEGIN SELECT RAISE(ABORT, 'agent_session_schedule_grant_bindings are immutable'); END`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_schedule_grant_bindings_immutable_delete
					BEFORE DELETE ON agent_session_schedule_grant_bindings
					BEGIN SELECT RAISE(ABORT, 'agent_session_schedule_grant_bindings are immutable'); END`,
				`CREATE TABLE IF NOT EXISTS agent_session_command_activation_work (
					command_id            TEXT PRIMARY KEY,
					session_id            TEXT NOT NULL,
					target_generation     INTEGER NOT NULL CHECK (target_generation >= 0),
					activation_id         TEXT NOT NULL,
					grant_snapshot_digest TEXT CHECK (grant_snapshot_digest IS NULL OR (length(grant_snapshot_digest) = 64 AND grant_snapshot_digest NOT GLOB '*[^0-9a-f]*')),
					state                 TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'completed', 'failed')),
					attempt               INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
					consumer              TEXT,
					claim_token           TEXT,
					claimed_at            INTEGER,
					claim_expires_at      INTEGER,
					heartbeat_at          INTEGER,
					not_before            INTEGER NOT NULL CHECK (not_before >= 0),
					last_error            TEXT,
					completed_at          INTEGER,
					FOREIGN KEY (command_id) REFERENCES agent_session_commands(command_id) ON DELETE RESTRICT,
					FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT,
					CHECK (
						(state = 'pending' AND consumer IS NULL AND claim_token IS NULL AND claimed_at IS NULL
						 AND claim_expires_at IS NULL AND heartbeat_at IS NULL AND completed_at IS NULL)
						OR (state = 'claimed' AND consumer IS NOT NULL AND claim_token IS NOT NULL
						 AND claimed_at IS NOT NULL AND claim_expires_at IS NOT NULL AND heartbeat_at IS NOT NULL
						 AND completed_at IS NULL AND heartbeat_at >= claimed_at AND claim_expires_at > heartbeat_at)
						OR (state IN ('completed', 'failed') AND consumer IS NULL AND claim_token IS NULL
						 AND claimed_at IS NULL AND claim_expires_at IS NULL AND heartbeat_at IS NULL
						 AND completed_at IS NOT NULL)
					)
				)`,
				`CREATE INDEX IF NOT EXISTS agent_session_command_activation_available
					ON agent_session_command_activation_work (state, not_before, claim_expires_at)`,
				`CREATE UNIQUE INDEX IF NOT EXISTS agent_session_command_activation_live_generation
					ON agent_session_command_activation_work (session_id, target_generation)
					WHERE state IN ('pending', 'claimed')`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_command_activation_require_bound_grant_insert
					BEFORE INSERT ON agent_session_command_activation_work
					WHEN NEW.grant_snapshot_digest IS NOT NULL
					 AND NOT EXISTS (
						SELECT 1 FROM agent_session_schedule_grant_bindings AS binding
						 WHERE binding.session_id = NEW.session_id AND binding.digest = NEW.grant_snapshot_digest
					 )
					BEGIN SELECT RAISE(ABORT, 'command activation grant digest has no immutable Session binding'); END`,
				`CREATE TABLE IF NOT EXISTS agent_session_command_activation_authority_attempts (
					command_id   TEXT NOT NULL,
					attempt      INTEGER NOT NULL CHECK (attempt >= 1),
					outcome      TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected', 'unavailable')),
					grant_digest TEXT CHECK (grant_digest IS NULL OR (length(grant_digest) = 64 AND grant_digest NOT GLOB '*[^0-9a-f]*')),
					revision     TEXT CHECK (revision IS NULL OR length(revision) BETWEEN 1 AND 256),
					code         TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 128),
					checked_at   INTEGER NOT NULL CHECK (checked_at >= 0),
					PRIMARY KEY (command_id, attempt),
					FOREIGN KEY (command_id) REFERENCES agent_session_command_activation_work(command_id) ON DELETE RESTRICT
				)`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_command_activation_authority_attempts_immutable_update
					BEFORE UPDATE ON agent_session_command_activation_authority_attempts
					BEGIN SELECT RAISE(ABORT, 'command activation authority attempts are immutable'); END`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_command_activation_authority_attempts_immutable_delete
					BEFORE DELETE ON agent_session_command_activation_authority_attempts
					BEGIN SELECT RAISE(ABORT, 'command activation authority attempts are immutable'); END`,
				`CREATE TABLE IF NOT EXISTS agent_session_schedules (
					session_id            TEXT NOT NULL,
					schedule_id           TEXT NOT NULL,
					create_request_id     TEXT NOT NULL,
					create_request_digest TEXT NOT NULL,
					kind                  TEXT NOT NULL CHECK (kind IN ('once', 'interval', 'cron')),
					fire_at               INTEGER,
					interval_ms           INTEGER,
					cron_expression       TEXT,
					timezone              TEXT,
					prompt_json           TEXT NOT NULL,
					client_id             TEXT NOT NULL,
					revision              INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
					source                TEXT NOT NULL DEFAULT 'internal' CHECK (source IN ('internal', 'public', 'rlm_heartbeat')),
					label                 TEXT,
					delivery_mode         TEXT NOT NULL DEFAULT 'steer' CHECK (delivery_mode IN ('steer', 'follow_up')),
					grant_snapshot_digest TEXT CHECK (grant_snapshot_digest IS NULL OR (length(grant_snapshot_digest) = 64 AND grant_snapshot_digest NOT GLOB '*[^0-9a-f]*')),
					state                 TEXT NOT NULL CHECK (state IN ('active', 'paused', 'completed', 'cancelled')),
					next_fire_at          INTEGER,
					fire_count            INTEGER NOT NULL DEFAULT 0 CHECK (fire_count >= 0),
					cancel_reason         TEXT,
					created_at            INTEGER NOT NULL CHECK (created_at >= 0),
					updated_at            INTEGER NOT NULL CHECK (updated_at >= created_at),
					completed_at          INTEGER,
					cancelled_at          INTEGER,
					PRIMARY KEY (session_id, schedule_id),
					UNIQUE (session_id, create_request_id),
					FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT,
					CHECK (
						(kind = 'once' AND fire_at IS NOT NULL AND interval_ms IS NULL
						 AND cron_expression IS NULL AND timezone IS NULL)
						OR (kind = 'interval' AND fire_at IS NOT NULL AND interval_ms IS NOT NULL AND interval_ms >= 10000
						 AND cron_expression IS NULL AND timezone IS NULL)
						OR (kind = 'cron' AND fire_at IS NULL AND interval_ms IS NULL
						 AND cron_expression IS NOT NULL AND timezone = 'UTC')
					),
					CHECK (
						(state IN ('active', 'paused') AND ((state = 'active' AND next_fire_at IS NOT NULL) OR (state = 'paused' AND next_fire_at IS NULL))
						 AND completed_at IS NULL AND cancelled_at IS NULL)
						OR (state = 'completed' AND next_fire_at IS NULL AND completed_at IS NOT NULL AND cancelled_at IS NULL)
						OR (state = 'cancelled' AND next_fire_at IS NULL AND completed_at IS NULL
						 AND cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)
					),
					CHECK (completed_at IS NULL OR completed_at >= created_at),
					CHECK (cancelled_at IS NULL OR cancelled_at >= created_at)
				)`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_schedules_require_bound_grant_insert
					BEFORE INSERT ON agent_session_schedules
					WHEN NEW.grant_snapshot_digest IS NOT NULL
					 AND NOT EXISTS (
						SELECT 1 FROM agent_session_schedule_grant_bindings AS binding
						 WHERE binding.session_id = NEW.session_id AND binding.digest = NEW.grant_snapshot_digest
					 )
					BEGIN SELECT RAISE(ABORT, 'schedule grant digest has no immutable Session binding'); END`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_schedules_require_bound_grant_update
					BEFORE UPDATE OF grant_snapshot_digest ON agent_session_schedules
					WHEN NEW.grant_snapshot_digest IS NOT NULL
					 AND NOT EXISTS (
						SELECT 1 FROM agent_session_schedule_grant_bindings AS binding
						 WHERE binding.session_id = NEW.session_id AND binding.digest = NEW.grant_snapshot_digest
					 )
					BEGIN SELECT RAISE(ABORT, 'schedule grant digest has no immutable Session binding'); END`,
				`CREATE TABLE IF NOT EXISTS agent_session_schedule_controls (
					control_id       TEXT PRIMARY KEY,
					session_id       TEXT NOT NULL,
					schedule_id      TEXT NOT NULL,
					request_id       TEXT NOT NULL,
					request_digest   TEXT NOT NULL,
					client_id        TEXT NOT NULL,
					action_json      TEXT NOT NULL,
					prior_revision   INTEGER NOT NULL CHECK (prior_revision >= 0),
					resulting_revision INTEGER NOT NULL CHECK (resulting_revision >= prior_revision),
					disposition      TEXT NOT NULL CHECK (disposition IN ('applied', 'no_change', 'already_terminal')),
					prior_state      TEXT NOT NULL CHECK (prior_state IN ('active', 'paused', 'completed', 'cancelled')),
					resulting_state   TEXT NOT NULL CHECK (resulting_state IN ('active', 'paused', 'completed', 'cancelled')),
					next_fire_at     INTEGER,
					committed_at     INTEGER NOT NULL CHECK (committed_at >= 0),
					UNIQUE (session_id, request_id),
					FOREIGN KEY (session_id, schedule_id)
						REFERENCES agent_session_schedules(session_id, schedule_id) ON DELETE RESTRICT
				)`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_schedule_controls_immutable_update
					BEFORE UPDATE ON agent_session_schedule_controls
					BEGIN SELECT RAISE(ABORT, 'agent_session_schedule_controls are immutable'); END`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_schedule_controls_immutable_delete
					BEFORE DELETE ON agent_session_schedule_controls
					BEGIN SELECT RAISE(ABORT, 'agent_session_schedule_controls are immutable'); END`,
				`CREATE TABLE IF NOT EXISTS agent_session_schedule_cancellations (
					cancellation_id TEXT PRIMARY KEY,
					session_id      TEXT NOT NULL,
					schedule_id     TEXT NOT NULL,
					request_id      TEXT NOT NULL,
					request_digest  TEXT NOT NULL,
					client_id       TEXT NOT NULL,
					reason          TEXT NOT NULL,
					disposition     TEXT NOT NULL CHECK (disposition IN ('cancelled', 'fire_preceded', 'already_terminal')),
					created_at      INTEGER NOT NULL CHECK (created_at >= 0),
					UNIQUE (session_id, request_id),
					FOREIGN KEY (session_id, schedule_id)
						REFERENCES agent_session_schedules(session_id, schedule_id) ON DELETE RESTRICT
				)`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_schedule_cancellations_immutable_update
					BEFORE UPDATE ON agent_session_schedule_cancellations
					BEGIN SELECT RAISE(ABORT, 'agent_session_schedule_cancellations are immutable'); END`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_schedule_cancellations_immutable_delete
					BEFORE DELETE ON agent_session_schedule_cancellations
					BEGIN SELECT RAISE(ABORT, 'agent_session_schedule_cancellations are immutable'); END`,
				`CREATE TABLE IF NOT EXISTS agent_session_schedule_fires (
					fire_id               TEXT PRIMARY KEY,
					session_id            TEXT NOT NULL,
					schedule_id           TEXT NOT NULL,
					ordinal               INTEGER NOT NULL CHECK (ordinal >= 0),
					scheduled_at          INTEGER NOT NULL CHECK (scheduled_at >= 0),
					coalesced_through_at  INTEGER NOT NULL CHECK (coalesced_through_at >= scheduled_at),
					coalesced_count       INTEGER NOT NULL CHECK (coalesced_count >= 1),
					grant_snapshot_digest TEXT,
					requested_delivery_mode TEXT NOT NULL CHECK (requested_delivery_mode IN ('steer', 'follow_up')),
					command_name          TEXT NOT NULL CHECK (command_name IN ('prompt', 'steer', 'follow_up')),
					command_id            TEXT NOT NULL UNIQUE,
					target_generation     INTEGER NOT NULL CHECK (target_generation >= 0),
					activation_id         TEXT NOT NULL,
					created_at            INTEGER NOT NULL CHECK (created_at >= coalesced_through_at),
					UNIQUE (session_id, schedule_id, ordinal),
					FOREIGN KEY (session_id, schedule_id)
						REFERENCES agent_session_schedules(session_id, schedule_id) ON DELETE RESTRICT,
					FOREIGN KEY (command_id) REFERENCES agent_session_commands(command_id)
						DEFERRABLE INITIALLY DEFERRED,
					FOREIGN KEY (session_id, target_generation, activation_id)
						REFERENCES agent_materializations(session_id, generation, activation_id)
						DEFERRABLE INITIALLY DEFERRED
				)`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_schedule_fires_immutable_update
					BEFORE UPDATE ON agent_session_schedule_fires
					BEGIN SELECT RAISE(ABORT, 'agent_session_schedule_fires are immutable'); END`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_schedule_fires_immutable_delete
					BEFORE DELETE ON agent_session_schedule_fires
					BEGIN SELECT RAISE(ABORT, 'agent_session_schedule_fires are immutable'); END`,
				`CREATE TABLE IF NOT EXISTS agent_session_schedule_fire_work (
					fire_id          TEXT PRIMARY KEY,
					state            TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'completed', 'failed')),
					attempt          INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
					consumer         TEXT,
					claim_token      TEXT,
					claimed_at       INTEGER,
					claim_expires_at INTEGER,
					heartbeat_at     INTEGER,
					not_before       INTEGER NOT NULL CHECK (not_before >= 0),
					last_error       TEXT,
					completed_at     INTEGER,
					FOREIGN KEY (fire_id) REFERENCES agent_session_schedule_fires(fire_id) ON DELETE RESTRICT,
					CHECK (
						(state = 'pending' AND consumer IS NULL AND claim_token IS NULL AND claimed_at IS NULL
						 AND claim_expires_at IS NULL AND heartbeat_at IS NULL AND completed_at IS NULL)
						OR (state = 'claimed' AND consumer IS NOT NULL AND claim_token IS NOT NULL
						 AND claimed_at IS NOT NULL AND claim_expires_at IS NOT NULL AND heartbeat_at IS NOT NULL
						 AND completed_at IS NULL AND heartbeat_at >= claimed_at AND claim_expires_at > heartbeat_at)
						OR (state IN ('completed', 'failed') AND consumer IS NULL AND claim_token IS NULL
						 AND claimed_at IS NULL AND claim_expires_at IS NULL AND heartbeat_at IS NULL
						 AND completed_at IS NOT NULL)
					)
				)`,
				`CREATE TABLE IF NOT EXISTS agent_session_schedule_fire_authority_attempts (
					fire_id TEXT NOT NULL,
					attempt INTEGER NOT NULL CHECK (attempt >= 1),
					outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected', 'unavailable')),
					grant_digest TEXT CHECK (grant_digest IS NULL OR (length(grant_digest) = 64 AND grant_digest NOT GLOB '*[^0-9a-f]*')),
					revision TEXT CHECK (revision IS NULL OR length(revision) BETWEEN 1 AND 256),
					code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 128),
					checked_at INTEGER NOT NULL CHECK (checked_at >= 0),
					PRIMARY KEY (fire_id, attempt),
					FOREIGN KEY (fire_id) REFERENCES agent_session_schedule_fires(fire_id) ON DELETE RESTRICT
				)`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_schedule_fire_authority_attempts_immutable_update BEFORE UPDATE ON agent_session_schedule_fire_authority_attempts BEGIN SELECT RAISE(ABORT, 'schedule authority attempts are immutable'); END`,
				`CREATE TRIGGER IF NOT EXISTS agent_session_schedule_fire_authority_attempts_immutable_delete BEFORE DELETE ON agent_session_schedule_fire_authority_attempts BEGIN SELECT RAISE(ABORT, 'schedule authority attempts are immutable'); END`,
				`INSERT OR IGNORE INTO agent_session_schedule_clock (singleton, last_now) VALUES (1, 0)`,
				`CREATE TABLE IF NOT EXISTS execution_cells (
					session_id        TEXT NOT NULL,
					ordinal           INTEGER NOT NULL,
					generation        INTEGER NOT NULL,
					cell_ref          TEXT NOT NULL,
					lease_id          TEXT NOT NULL,
					kernel_sandbox_id TEXT NOT NULL,
					input_id          TEXT NOT NULL,
					code              TEXT NOT NULL,
					status            TEXT NOT NULL,
					execution_count   INTEGER,
					outputs_json      TEXT NOT NULL,
					host_requests_json TEXT NOT NULL,
					cell_digest       TEXT NOT NULL,
					started_at        INTEGER NOT NULL,
					completed_at      INTEGER NOT NULL,
					duration_ms       INTEGER NOT NULL,
					PRIMARY KEY (session_id, generation, ordinal),
					UNIQUE (cell_ref)
				)`,
				`CREATE TABLE IF NOT EXISTS agent_materializations (
					session_id          TEXT NOT NULL,
					generation          INTEGER NOT NULL CHECK (generation >= 0),
					sandbox_id          TEXT NOT NULL,
					activation_id       TEXT NOT NULL,
					state               TEXT NOT NULL CHECK (state IN ('claimed', 'running', 'quiescing', 'quiescent', 'passivated', 'completed', 'faulted', 'cancelled', 'authority_revoked')),
					fault_kind          TEXT CHECK (fault_kind IS NULL OR fault_kind IN ('worker_spawn', 'worker_exit', 'worker_timeout', 'worker_oom', 'worker_protocol', 'kernel_fault', 'quiescence_fault', 'checkpoint_fault', 'replay_divergence', 'host_invariant')),
					recoverable         INTEGER CHECK (recoverable IS NULL OR recoverable IN (0, 1)),
					checkpoint_id       TEXT,
					kernel_checkpoint_id TEXT,
					created_at          INTEGER NOT NULL,
					updated_at          INTEGER NOT NULL,
					passivated_at       INTEGER,
					PRIMARY KEY (session_id, generation),
					CHECK (created_at >= 0 AND updated_at >= created_at),
					CHECK ((state = 'passivated' AND passivated_at IS NOT NULL AND passivated_at >= created_at)
					    OR (state <> 'passivated' AND passivated_at IS NULL)),
					UNIQUE (sandbox_id),
					UNIQUE (activation_id),
					UNIQUE (session_id, generation, activation_id),
					FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT,
					CHECK ((state = 'faulted' AND fault_kind IS NOT NULL AND recoverable IS NOT NULL)
					    OR (state <> 'faulted' AND fault_kind IS NULL AND recoverable IS NULL))
				)`,
				`CREATE TABLE IF NOT EXISTS agent_session_body_states (
					session_id TEXT NOT NULL,
					generation INTEGER NOT NULL CHECK (generation >= 0),
					role       TEXT NOT NULL CHECK (role IN ('worker', 'kernel')),
					state      TEXT NOT NULL,
					updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
					PRIMARY KEY (session_id, generation, role),
					FOREIGN KEY (session_id, generation) REFERENCES agent_materializations(session_id, generation)
						ON DELETE RESTRICT,
					CHECK ((role = 'worker' AND state IN ('claimed', 'running', 'quiescing', 'quiescent', 'passivated', 'completed', 'faulted', 'cancelled'))
					    OR (role = 'kernel' AND state IN ('running', 'released', 'shutdown', 'faulted', 'cancelled')))
				)`,
				`CREATE TABLE IF NOT EXISTS agent_session_kernel_launches (
					session_id      TEXT NOT NULL,
					generation      INTEGER NOT NULL CHECK (generation >= 0),
					activation_id   TEXT NOT NULL,
					sandbox_id      TEXT,
					state           TEXT NOT NULL CHECK (state IN ('not_requested', 'launching', 'bound', 'failed_unbound')),
					attempt         INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
					created_at      INTEGER NOT NULL CHECK (created_at >= 0),
					updated_at      INTEGER NOT NULL CHECK (updated_at >= created_at),
					body_observed_at INTEGER,
					terminal_at     INTEGER,
					PRIMARY KEY (session_id, generation),
					UNIQUE (sandbox_id),
					FOREIGN KEY (session_id, generation, activation_id)
						REFERENCES agent_materializations(session_id, generation, activation_id) ON DELETE RESTRICT,
					CHECK (
						(state = 'not_requested' AND attempt = 0 AND sandbox_id IS NULL
						 AND body_observed_at IS NULL AND terminal_at IS NULL)
						OR (state = 'launching' AND attempt > 0 AND sandbox_id IS NOT NULL
						    AND body_observed_at IS NULL AND terminal_at IS NULL)
						OR (state = 'bound' AND sandbox_id IS NOT NULL AND body_observed_at IS NOT NULL
						    AND body_observed_at >= created_at AND terminal_at IS NULL)
						OR (state = 'failed_unbound' AND attempt > 0 AND sandbox_id IS NOT NULL AND body_observed_at IS NULL
						    AND terminal_at IS NOT NULL AND terminal_at >= created_at)
					)
				)`,
				`CREATE TABLE IF NOT EXISTS agent_materialization_supervision (
					session_id       TEXT NOT NULL,
					generation       INTEGER NOT NULL CHECK (generation >= 0),
					activation_id    TEXT NOT NULL,
					heartbeat_at     INTEGER NOT NULL CHECK (heartbeat_at >= 0),
					recovery_attempt INTEGER NOT NULL DEFAULT 0 CHECK (recovery_attempt >= 0),
					recovery_consumer TEXT,
					recovery_token   TEXT,
					recovery_claimed_at INTEGER,
					recovery_expires_at INTEGER,
					recovery_heartbeat_at INTEGER,
					recovered_at     INTEGER,
					PRIMARY KEY (session_id, generation),
					FOREIGN KEY (session_id, generation, activation_id)
						REFERENCES agent_materializations(session_id, generation, activation_id) ON DELETE RESTRICT,
					CHECK (
						(recovery_consumer IS NULL AND recovery_token IS NULL AND recovery_claimed_at IS NULL
						 AND recovery_expires_at IS NULL AND recovery_heartbeat_at IS NULL AND recovered_at IS NULL)
						OR
						(recovery_consumer IS NOT NULL AND recovery_token IS NOT NULL AND recovery_claimed_at IS NOT NULL
						 AND recovery_expires_at IS NOT NULL AND recovery_heartbeat_at IS NOT NULL
						 AND recovery_claimed_at >= heartbeat_at AND recovery_heartbeat_at >= recovery_claimed_at
						 AND recovery_expires_at > recovery_heartbeat_at
						 AND (recovered_at IS NULL OR recovered_at >= recovery_heartbeat_at))
					)
				)`,
				`CREATE TABLE IF NOT EXISTS agent_checkpoints (
					checkpoint_id   TEXT PRIMARY KEY,
					session_id      TEXT NOT NULL,
					session_sequence INTEGER NOT NULL,
					generation      INTEGER NOT NULL,
					sandbox_id      TEXT NOT NULL,
					object_json     TEXT NOT NULL,
					manifest_json   TEXT NOT NULL,
					created_at      INTEGER NOT NULL,
					UNIQUE (session_id, session_sequence)
				)`,
				`CREATE TABLE IF NOT EXISTS kernel_checkpoints (
					checkpoint_id     TEXT PRIMARY KEY,
					session_id        TEXT NOT NULL,
					generation        INTEGER NOT NULL,
					journal_head_digest TEXT NOT NULL,
					object_json       TEXT NOT NULL,
					manifest_json     TEXT NOT NULL,
					created_at        INTEGER NOT NULL,
					UNIQUE (session_id, generation, journal_head_digest)
				)`,
				`CREATE TABLE IF NOT EXISTS kernel_replay_witnesses (
					session_id          TEXT NOT NULL,
					generation          INTEGER NOT NULL,
					journal_head_digest TEXT NOT NULL,
					namespace_json      TEXT NOT NULL,
					created_at          INTEGER NOT NULL,
					PRIMARY KEY (session_id, generation)
				)`,
				`CREATE TABLE IF NOT EXISTS effect_idempotency (
					idempotency_key TEXT PRIMARY KEY,
					proposal_digest TEXT NOT NULL,
					run_id         TEXT NOT NULL,
					status         TEXT NOT NULL,
					receipt_json   TEXT,
					claimed_at     INTEGER NOT NULL,
					completed_at   INTEGER
				)`,
				`CREATE TABLE IF NOT EXISTS domain_source_turns (
					turn_id             TEXT PRIMARY KEY,
					turn_digest         TEXT NOT NULL,
					source_ref          TEXT NOT NULL,
					source_digest       TEXT NOT NULL,
					trigger_digest      TEXT NOT NULL,
					context_digest      TEXT NOT NULL,
					owner_principal     TEXT NOT NULL,
					graph_id            TEXT NOT NULL,
					agent_id            TEXT NOT NULL,
					actor_ref           TEXT NOT NULL,
					auth_method         TEXT NOT NULL,
					trigger_adapter     TEXT,
					first_invocation_id TEXT NOT NULL,
					turn_json           TEXT NOT NULL,
					created_at          INTEGER NOT NULL,
					updated_at          INTEGER NOT NULL,
					UNIQUE(owner_principal, graph_id, agent_id, source_ref)
				)`,
				`CREATE TABLE IF NOT EXISTS effect_handoffs (
					idempotency_key          TEXT PRIMARY KEY,
					execution_digest        TEXT NOT NULL,
					proposal_digest         TEXT NOT NULL,
					run_id                  TEXT NOT NULL,
					graph_id                TEXT NOT NULL,
					agent_id                TEXT NOT NULL,
					actor_ref               TEXT NOT NULL,
					grant_id                TEXT NOT NULL,
					grant_document_id       TEXT NOT NULL,
					grant_authority_graph_id TEXT NOT NULL,
					grant_authority_owner_principal TEXT NOT NULL,
					grant_digest            TEXT NOT NULL,
					definition_digest       TEXT,
					source_turn_id          TEXT,
					source_turn_digest      TEXT,
					source_owner_principal  TEXT,
					source_turn_json        TEXT,
					capability              TEXT NOT NULL,
					operation               TEXT NOT NULL,
					proposal_json           TEXT NOT NULL,
					trigger_json            TEXT,
					approval_json           TEXT,
					effect_index            INTEGER NOT NULL,
					state                   TEXT NOT NULL,
					attempt                 INTEGER NOT NULL DEFAULT 0,
					consumer                TEXT,
					claim_token             TEXT,
					lease_expires_at        INTEGER,
					not_before              INTEGER NOT NULL,
					completion_json         TEXT,
					created_at              INTEGER NOT NULL,
					updated_at              INTEGER NOT NULL,
					completed_at            INTEGER
				)`,
				`CREATE TABLE IF NOT EXISTS workflow_controls (
					run_id            TEXT PRIMARY KEY,
					revision          INTEGER NOT NULL,
					driver_json       TEXT,
					amendments_json   TEXT NOT NULL,
					current_beat_json TEXT,
					updated_at        INTEGER NOT NULL
				)`,
				`CREATE TABLE IF NOT EXISTS privacy_epoch_runs (
					run_id            TEXT PRIMARY KEY,
					epoch_id          TEXT NOT NULL,
					dataset_graph_id   TEXT NOT NULL,
					source_event_ref   TEXT NOT NULL,
					binding_json       TEXT NOT NULL,
					bound_at           INTEGER NOT NULL
				)`,
				`CREATE TABLE IF NOT EXISTS agent_session_family_projection_clock (
					singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
					revision  INTEGER NOT NULL CHECK (revision >= 0)
				)`,
				`CREATE TABLE IF NOT EXISTS agent_session_family_projection_outbox (
					root_session_id   TEXT PRIMARY KEY,
					work_kind         TEXT NOT NULL CHECK (work_kind IN ('project', 'retire')),
					desired_revision  INTEGER NOT NULL CHECK (desired_revision >= 0),
					delivered_revision INTEGER NOT NULL CHECK (delivered_revision >= 0 AND delivered_revision <= desired_revision),
					delivered_projection_revision INTEGER NOT NULL DEFAULT 0 CHECK (delivered_projection_revision >= 0),
					state             TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'delivered')),
					claimed_revision  INTEGER,
					claimed_projection_revision INTEGER,
					consumer          TEXT,
					claim_token       TEXT,
					claimed_at        INTEGER,
					claim_expires_at INTEGER,
					heartbeat_at      INTEGER,
					not_before        INTEGER NOT NULL DEFAULT 0,
					last_error       TEXT,
					updated_at       INTEGER NOT NULL,
					FOREIGN KEY (root_session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT,
					CHECK ((state = 'delivered' AND delivered_revision = desired_revision)
					    OR (state = 'pending' AND delivered_revision < desired_revision)
					    OR (state = 'claimed' AND claimed_revision > delivered_revision
					        AND claimed_revision <= desired_revision)),
					CHECK (not_before >= 0 AND updated_at >= 0
					    AND (claimed_at IS NULL OR claimed_at >= 0)
					    AND (claim_expires_at IS NULL OR claim_expires_at > claimed_at)
					    AND (heartbeat_at IS NULL OR (heartbeat_at >= claimed_at AND heartbeat_at < claim_expires_at))),
					CHECK (
						(state = 'claimed' AND claimed_revision IS NOT NULL AND claimed_projection_revision IS NOT NULL
						 AND claimed_projection_revision >= delivered_projection_revision AND consumer IS NOT NULL
						 AND claim_token IS NOT NULL AND claimed_at IS NOT NULL AND claim_expires_at IS NOT NULL
						 AND heartbeat_at IS NOT NULL)
						OR
						(state <> 'claimed' AND claimed_revision IS NULL AND consumer IS NULL
						 AND claim_token IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL
						 AND heartbeat_at IS NULL AND claimed_projection_revision IS NULL)
					)
				)`,
				`INSERT OR IGNORE INTO agent_session_family_projection_clock (singleton, revision) VALUES (1, 0)`,
				...agentSessionFamilyProjectionRevisionTriggers(),
				...agentSessionFamilyProjectionOutboxTriggers(),
				`CREATE INDEX IF NOT EXISTS idx_workflow_instances_owner ON workflow_instances(owner_user_id, updated_at)`,
				`CREATE INDEX IF NOT EXISTS idx_agent_sessions_run ON agent_sessions(run_id, phase_index, label)`,
				`CREATE INDEX IF NOT EXISTS idx_agent_sessions_owner ON agent_sessions(owner_user_id, updated_at)`,
				`CREATE INDEX IF NOT EXISTS idx_agent_session_relations_parent ON agent_session_relations(parent_session_id, created_at, child_session_id)`,
				`CREATE INDEX IF NOT EXISTS idx_agent_session_child_admissions_parent ON agent_session_child_admissions(parent_session_id, created_at, child_session_id)`,
				`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_session_child_admissions_parent_name ON agent_session_child_admissions(parent_session_id, child_name)`,
				`CREATE INDEX IF NOT EXISTS idx_agent_session_child_spawn_requests_parent ON agent_session_child_spawn_requests(parent_session_id, created_at, request_id)`,
				`CREATE INDEX IF NOT EXISTS idx_agent_session_child_runs_recovery ON agent_session_child_runs(state, materialized_at, claim_expires_at, created_at)`,
				`CREATE INDEX IF NOT EXISTS idx_agent_session_child_cancellations_run ON agent_session_child_cancellation_requests(child_run_id, created_at, request_id)`,
				`CREATE INDEX IF NOT EXISTS idx_agent_session_child_closure_work_ready ON agent_session_child_closure_work(state, claim_expires_at, updated_at)`,
				`CREATE INDEX IF NOT EXISTS idx_agent_session_document_ops_session ON agent_session_document_ops(session_id, rev)`,
				`CREATE INDEX IF NOT EXISTS idx_agent_session_commands_delivery ON agent_session_commands(session_id, state, target_generation, submitted_at)`,
				`CREATE INDEX IF NOT EXISTS idx_agent_session_schedules_due ON agent_session_schedules(state, next_fire_at, created_at)`,
				`CREATE INDEX IF NOT EXISTS idx_agent_session_schedule_grant_bindings_session ON agent_session_schedule_grant_bindings(session_id, digest)`,
				// One Domain host context is admitted at first Session creation; no
				// later caller may add a competing grant binding for that Session.
				`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_session_schedule_grant_bindings_one_per_session
					ON agent_session_schedule_grant_bindings(session_id)`,
				`CREATE INDEX IF NOT EXISTS idx_agent_session_schedule_fire_work_ready ON agent_session_schedule_fire_work(state, not_before, claim_expires_at)`,
				`CREATE INDEX IF NOT EXISTS idx_agent_session_schedule_fires_session ON agent_session_schedule_fires(session_id, schedule_id, ordinal)`,
				`CREATE INDEX IF NOT EXISTS idx_execution_cells_session ON execution_cells(session_id, ordinal)`,
				`CREATE INDEX IF NOT EXISTS idx_agent_materializations_state ON agent_materializations(session_id, state, generation)`,
				`CREATE INDEX IF NOT EXISTS idx_agent_session_body_states_session ON agent_session_body_states(session_id, generation)`,
				`CREATE INDEX IF NOT EXISTS idx_agent_session_family_projection_outbox_ready ON agent_session_family_projection_outbox(state, not_before, claim_expires_at, updated_at)`,
				`CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_session ON agent_checkpoints(session_id, session_sequence)`,
				`CREATE INDEX IF NOT EXISTS idx_kernel_checkpoints_session ON kernel_checkpoints(session_id, generation, created_at)`,
				`CREATE INDEX IF NOT EXISTS idx_effect_idempotency_run ON effect_idempotency(run_id, claimed_at)`,
				`CREATE INDEX IF NOT EXISTS idx_domain_source_turns_source ON domain_source_turns(owner_principal, graph_id, source_ref)`,
				`CREATE INDEX IF NOT EXISTS idx_effect_handoffs_ready ON effect_handoffs(state, capability, not_before, created_at)`,
				`CREATE INDEX IF NOT EXISTS idx_effect_handoffs_run ON effect_handoffs(run_id, effect_index)`,
				`CREATE INDEX IF NOT EXISTS idx_privacy_epoch_runs_epoch ON privacy_epoch_runs(epoch_id, run_id)`,
			],
			"write",
		);
		const agentSessionInfo = await this.db.execute({ sql: "PRAGMA table_info(agent_sessions)", args: [] });
		if (!agentSessionInfo.rows.some((row) => String(row.name) === "graph_owner_principal")) {
			throw new Error(
				"agent_sessions lacks durable graph_owner_principal; this hard-cut runtime requires a fresh store",
			);
		}
		// Stores before 2026-10-21 have no stop request on a run.
		const instanceInfo = await this.db.execute({ sql: "PRAGMA table_info(workflow_instances)", args: [] });
		const instanceColumns = new Set(instanceInfo.rows.map((row) => String(row.name)));
		for (const [name, declaration] of [
			["stop_requested_at", "INTEGER"],
			["stop_requested_by", "TEXT"],
			["stop_reason", "TEXT"],
		] as const) {
			if (!instanceColumns.has(name)) {
				await this.db.execute({
					sql: `ALTER TABLE workflow_instances ADD COLUMN ${name} ${declaration}`,
					args: [],
				});
			}
		}
		const eventInfo = await this.db.execute({ sql: "PRAGMA table_info(agent_session_events)", args: [] });
		// G1 stores predate the G2 control columns and, importantly, their table
		// CHECK rejected `paused`.  Preserve every row in place while widening
		// that constraint before adding the additive columns.  This is deliberately
		// a schema-only migration: existing schedules remain active revision 0,
		// internal/steer, with no label or grant snapshot.
		const scheduleSchema = await this.db.execute({
			sql: "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_session_schedules'",
			args: [],
		});
		const scheduleSql = scheduleSchema.rows[0]?.sql;
		if (typeof scheduleSql === "string" && !scheduleSql.includes("'paused'")) {
			let widened = scheduleSql.replace(
				"state IN ('active', 'completed', 'cancelled')",
				"state IN ('active', 'paused', 'completed', 'cancelled')",
			);
			widened = widened.replace(
				"state = 'active' AND next_fire_at IS NOT NULL AND completed_at IS NULL AND cancelled_at IS NULL",
				"state IN ('active', 'paused') AND ((state = 'active' AND next_fire_at IS NOT NULL) OR (state = 'paused' AND next_fire_at IS NULL)) AND completed_at IS NULL AND cancelled_at IS NULL",
			);
			if (widened === scheduleSql) throw new Error("Unable to widen legacy schedule state constraint");
			await this.db.execute({ sql: "PRAGMA writable_schema = ON", args: [] });
			try {
				await this.db.execute({
					sql: "UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'agent_session_schedules'",
					args: [widened],
				});
			} finally {
				await this.db.execute({ sql: "PRAGMA writable_schema = OFF", args: [] });
			}
			const schemaVersion = await this.db.execute({ sql: "PRAGMA schema_version", args: [] });
			const version = Number(schemaVersion.rows[0]?.schema_version ?? 1);
			await this.db.execute({
				sql: `PRAGMA schema_version = ${Number.isSafeInteger(version) ? version + 1 : 1}`,
				args: [],
			});
		}
		const inferenceColumns = await this.db.execute({
			sql: "PRAGMA table_info(agent_session_inference_reservations)",
			args: [],
		});
		if (!inferenceColumns.rows.some((row) => row.name === "funding_source")) {
			await this.db.execute({
				sql: "ALTER TABLE agent_session_inference_reservations ADD COLUMN funding_source TEXT NOT NULL DEFAULT 'platform'",
				args: [],
			});
		}
		const materializationSchema = await this.db.execute({
			sql: "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_materializations'",
			args: [],
		});
		const materializationSql = materializationSchema.rows[0]?.sql;
		if (typeof materializationSql === "string" && !materializationSql.includes("'authority_revoked'")) {
			const widened = materializationSql.replace(
				"'faulted', 'cancelled'))",
				"'faulted', 'cancelled', 'authority_revoked'))",
			);
			if (widened === materializationSql)
				throw new Error("Unable to widen materialization authority tombstone constraint");
			await this.db.execute({ sql: "PRAGMA writable_schema = ON", args: [] });
			try {
				await this.db.execute({
					sql: "UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'agent_materializations'",
					args: [widened],
				});
			} finally {
				await this.db.execute({ sql: "PRAGMA writable_schema = OFF", args: [] });
			}
			const schemaVersion = await this.db.execute({ sql: "PRAGMA schema_version", args: [] });
			const version = Number(schemaVersion.rows[0]?.schema_version ?? 1);
			await this.db.execute({
				sql: `PRAGMA schema_version = ${Number.isSafeInteger(version) ? version + 1 : 1}`,
				args: [],
			});
		}
		const scheduleInfo = await this.db.execute({ sql: "PRAGMA table_info(agent_session_schedules)", args: [] });
		const scheduleColumns = new Set(scheduleInfo.rows.map((row) => String(row.name)));
		for (const [name, declaration] of [
			["revision", "INTEGER NOT NULL DEFAULT 0"],
			["source", "TEXT NOT NULL DEFAULT 'internal'"],
			["label", "TEXT"],
			["delivery_mode", "TEXT NOT NULL DEFAULT 'steer'"],
			["grant_snapshot_digest", "TEXT"],
		] as const) {
			if (!scheduleColumns.has(name)) {
				await this.db.execute({
					sql: `ALTER TABLE agent_session_schedules ADD COLUMN ${name} ${declaration}`,
					args: [],
				});
			}
		}
		// A G1 fire never had delivery testimony: its only legal command was
		// prompt. Preserve those rows while making the G2 requested/actual pair
		// explicit for every newly claimed fire.
		const fireInfo = await this.db.execute({ sql: "PRAGMA table_info(agent_session_schedule_fires)", args: [] });
		const fireColumns = new Set(fireInfo.rows.map((row) => String(row.name)));
		let backfillLegacyFireRequestedDelivery = false;
		for (const [name, declaration] of [
			["requested_delivery_mode", "TEXT NOT NULL DEFAULT 'steer'"],
			["command_name", "TEXT NOT NULL DEFAULT 'prompt'"],
			["grant_snapshot_digest", "TEXT"],
		] as const) {
			if (!fireColumns.has(name)) {
				await this.db.execute({
					sql: `ALTER TABLE agent_session_schedule_fires ADD COLUMN ${name} ${declaration}`,
					args: [],
				});
				if (name === "requested_delivery_mode") backfillLegacyFireRequestedDelivery = true;
			}
		}
		if (backfillLegacyFireRequestedDelivery) {
			await this.db.execute({
				sql: `UPDATE agent_session_schedule_fires AS fire
				         SET requested_delivery_mode = COALESCE((
						SELECT schedule.delivery_mode FROM agent_session_schedules AS schedule
						 WHERE schedule.session_id = fire.session_id AND schedule.schedule_id = fire.schedule_id
					), 'steer')`,
				args: [],
			});
		}
		const eventColumns = new Set(eventInfo.rows.map((row) => String(row.name)));
		for (const column of ["causation_id", "command_id"] as const) {
			if (!eventColumns.has(column)) {
				await this.db.execute({ sql: `ALTER TABLE agent_session_events ADD COLUMN ${column} TEXT`, args: [] });
			}
		}
		// Existing cloud-2 runtime databases predate source-turn testimony. Keep
		// their handoffs readable while all newly offered work is fully witnessed.
		const handoffInfo = await this.db.execute({ sql: "PRAGMA table_info(effect_handoffs)", args: [] });
		const handoffColumns = new Set(handoffInfo.rows.map((row) => String(row.name)));
		for (const [name, declaration] of [
			["source_turn_id", "TEXT"],
			["source_turn_digest", "TEXT"],
			["source_owner_principal", "TEXT"],
			["source_turn_json", "TEXT"],
			["approval_json", "TEXT"],
		] as const) {
			if (!handoffColumns.has(name)) {
				await this.db.execute({ sql: `ALTER TABLE effect_handoffs ADD COLUMN ${name} ${declaration}`, args: [] });
			}
		}
		await this.db.execute({
			sql: "CREATE INDEX IF NOT EXISTS idx_effect_handoffs_source_turn ON effect_handoffs(source_turn_id, effect_index)",
			args: [],
		});
		const cellInfo = await this.db.execute({ sql: "PRAGMA table_info(execution_cells)", args: [] });
		const cellColumns = new Set(cellInfo.rows.map((row) => String(row.name)));
		for (const [name, declaration] of [
			["generation", "INTEGER NOT NULL DEFAULT 0"],
			["host_requests_json", "TEXT NOT NULL DEFAULT '[]'"],
			[
				"cell_digest",
				"TEXT NOT NULL DEFAULT 'sha256:0000000000000000000000000000000000000000000000000000000000000000'",
			],
		] as const) {
			if (!cellColumns.has(name)) {
				await this.db.execute({ sql: `ALTER TABLE execution_cells ADD COLUMN ${name} ${declaration}`, args: [] });
			}
		}
		await this.ensureChatSessionCatalogue();
		await this.ensureChatSeedTables();
		await this.ensurePricingArchiveTable();
	}

	/**
	 * The chat catalogue (Sobremesa): one small row per chat Agent Session, kept
	 * beside the Session ledger so the list of a person's conversations survives
	 * the browser that started them. Additive and rollback-safe: an older
	 * Choreograph opening this database never reads or writes the table, and a
	 * missing row simply means "not listed". It has no foreign key on purpose:
	 * a Session purge must never be blocked by, or forget to take, its row (the
	 * purge below deletes the rows explicitly).
	 */
	private async ensureChatSessionCatalogue(): Promise<void> {
		await this.db.batch(
			[
				`CREATE TABLE IF NOT EXISTS chat_session_catalogue (
					session_id            TEXT PRIMARY KEY,
					run_id                TEXT NOT NULL,
					owner_user_id         TEXT NOT NULL,
					graph_owner_principal TEXT NOT NULL,
					graph_id              TEXT NOT NULL,
					workflow_name         TEXT NOT NULL,
					title                 TEXT NOT NULL,
					title_source          TEXT NOT NULL CHECK (title_source IN ('explicit', 'first-message', 'backfill')),
					model                 TEXT NOT NULL,
					provider              TEXT NOT NULL,
					continues_json        TEXT,
					seed_window_json      TEXT,
					created_at            INTEGER NOT NULL CHECK (created_at >= 0),
					last_activity_at      INTEGER NOT NULL CHECK (last_activity_at >= 0)
				)`,
				`CREATE INDEX IF NOT EXISTS idx_chat_session_catalogue_owner
					ON chat_session_catalogue(owner_user_id, graph_id, last_activity_at DESC, session_id DESC)`,
				`CREATE INDEX IF NOT EXISTS idx_chat_session_catalogue_owner_activity
					ON chat_session_catalogue(owner_user_id, last_activity_at DESC, session_id DESC)`,
			],
			"write",
		);
	}

	/** One chat's catalogue row, or null when the Session is not a listed chat. */
	async readChatSessionCatalogue(sessionId: string): Promise<ChatSessionCatalogueRecord | null> {
		const result = await this.read({
			sql: "SELECT * FROM chat_session_catalogue WHERE session_id = ?",
			args: [sessionId],
		});
		const row = result.rows[0];
		return row ? rowToChatSessionCatalogue(row) : null;
	}

	/**
	 * Page one owner's chats, newest activity first. Owner scoping is part of the
	 * query, not a filter applied afterwards: another person's rows are never read.
	 */
	async listChatSessions(query: ChatSessionListStoreQuery): Promise<ChatSessionListPage> {
		const clauses = ["c.owner_user_id = ?"];
		const args: Array<string | number> = [query.ownerUserId];
		if (query.graphId !== undefined) {
			clauses.push("c.graph_id = ?");
			args.push(query.graphId);
		}
		if (query.graphOwnerPrincipal !== undefined) {
			clauses.push("c.graph_owner_principal = ?");
			args.push(query.graphOwnerPrincipal);
		}
		if (query.workflowName !== undefined) {
			clauses.push("c.workflow_name = ?");
			args.push(query.workflowName);
		}
		if (query.cursor) {
			clauses.push("(c.last_activity_at < ? OR (c.last_activity_at = ? AND c.session_id < ?))");
			args.push(query.cursor.lastActivityAt, query.cursor.lastActivityAt, query.cursor.sessionId);
		}
		args.push(query.limit + 1);
		const result = await this.read({
			sql: `SELECT c.*, s.status AS session_status, s.lifecycle_state AS session_lifecycle_state
				FROM chat_session_catalogue c
				JOIN agent_sessions s ON s.session_id = c.session_id
				WHERE ${clauses.join(" AND ")}
				ORDER BY c.last_activity_at DESC, c.session_id DESC
				LIMIT ?`,
			args,
		});
		const rows = result.rows.map(rowToChatSessionListRow);
		const sessions = rows.slice(0, query.limit);
		const last = sessions[sessions.length - 1];
		return {
			sessions,
			nextCursor:
				rows.length > query.limit && last
					? { lastActivityAt: last.last_activity_at, sessionId: last.session_id }
					: null,
		};
	}

	/**
	 * Catalogue the owner's headed root Sessions that predate the catalogue, so a
	 * conversation started before the release still appears in the list. Decision
	 * (legacy sessions): lazy backfill, not lazy derivation on every read. It is
	 * called for one owner (and graph) when a first page is asked for, never as a
	 * startup scan, and catalogues at most `limit` Sessions per call, newest first.
	 * Everything comes from the Session's own record: the title from
	 * `document.source.prompt` (the first user message), the model and provider from
	 * the pinned Session binding (the inference fence rejects any turn that diverges
	 * from it, so it is exact for every turn without replaying events), and
	 * `lastActivityAt` from the Session's own activity events. Idempotent: a Session
	 * that already has a row is never touched.
	 *
	 * Cost and fragility, both measured (600 Sessions of 37 KB: the candidate query
	 * was 24 ms, now 1.5 ms). A Session's document holds its whole transcript, so
	 * what matters is how many documents are opened. The rows the owner already has
	 * are excluded by an owner-scoped, uncorrelated `NOT IN`, which SQLite turns into
	 * one index probe per Session before any JSON function runs; a correlated `NOT
	 * EXISTS`, or the earlier `LEFT JOIN ... IS NULL`, is deferred behind the cheap
	 * terms and every document is still opened. And a document that is not JSON must
	 * not fail the whole list: `json_valid` guards the extraction inside a `CASE`, the
	 * one construct SQLite evaluates in order, so the guard holds whatever order the
	 * planner picks. Such a Session is passed over (it stays unlisted), not fatal.
	 */
	async backfillChatSessionCatalogue(scope: {
		readonly ownerUserId: string;
		readonly graphId?: string;
		readonly graphOwnerPrincipal?: string;
		readonly limit?: number;
	}): Promise<number> {
		return (await this.backfillChatSessionCatalogueBatch(scope, scope.limit ?? 50)).inserted;
	}

	private async backfillChatSessionCatalogueBatch(
		scope: { readonly ownerUserId: string; readonly graphId?: string; readonly graphOwnerPrincipal?: string },
		limit: number,
	): Promise<{ candidates: number; inserted: number }> {
		const candidates = await this.readBackfillCandidates(scope, limit);
		let inserted = 0;
		for (const candidate of candidates) inserted += await this.writeBackfillCandidate(candidate);
		return { candidates: candidates.length, inserted };
	}

	/** The legacy chats to catalogue: the read half of a backfill. See `backfillChatSessionCatalogue` for what it avoids. */
	protected async readBackfillCandidates(
		scope: { readonly ownerUserId: string; readonly graphId?: string; readonly graphOwnerPrincipal?: string },
		limit: number,
	): Promise<ChatBackfillCandidate[]> {
		const clauses = [
			"s.owner_user_id = ?",
			"s.family_root_session_id = s.session_id",
			`s.workflow_name IN (${sqlPlaceholders(CHAT_WORKFLOW_NAMES.size)})`,
			"s.session_id NOT IN (SELECT c.session_id FROM chat_session_catalogue c WHERE c.owner_user_id = ? AND c.session_id IS NOT NULL)",
		];
		const args: Array<string | number> = [scope.ownerUserId, ...CHAT_WORKFLOW_NAMES, scope.ownerUserId];
		if (scope.graphId !== undefined) {
			clauses.push("s.graph_id = ?");
			args.push(scope.graphId);
		}
		if (scope.graphOwnerPrincipal !== undefined) {
			clauses.push("s.graph_owner_principal = ?");
			args.push(scope.graphOwnerPrincipal);
		}
		clauses.push(
			"CASE WHEN json_valid(s.document_json) THEN json_extract(s.document_json, '$.source.interactionMode') = 'headed' ELSE 0 END",
		);
		args.push(limit);
		const result = await this.read({
			sql: `SELECT s.session_id, s.owner_user_id,
					json_extract(s.document_json, '$.source.prompt') AS prompt,
					json_extract(s.document_json, '$.source.provider') AS provider
				FROM agent_sessions s
				WHERE ${clauses.join(" AND ")}
				ORDER BY s.created_at DESC, s.session_id DESC
				LIMIT ?`,
			args,
		});
		return result.rows.map((row) => ({
			sessionId: String(row.session_id),
			ownerUserId: String(row.owner_user_id),
			title: deriveChatTitle(typeof row.prompt === "string" ? row.prompt : ""),
			provider: typeof row.provider === "string" ? row.provider : "",
		}));
	}

	/**
	 * One legacy chat's row, written on the serial writer in one statement: the write half of a backfill. Returns
	 * 1 if a row was written, 0 if there was nothing to write.
	 *
	 * The row's facts are read FROM the Session in this statement, so a chat purged since `readBackfillCandidates`
	 * read it (a privacy retirement deletes the Session and its catalogue row) has nothing to select and leaves no
	 * title, owner or model behind: a catalogue row has no foreign key to hold it back. The chat's last activity is
	 * taken from its events in the same statement: read on its own first, an event committed between the read and
	 * the write found no row to move and was lost. The host's own commands (`quiesce`) are not activity.
	 */
	protected async writeBackfillCandidate(candidate: ChatBackfillCandidate): Promise<number> {
		const written = await this.write(
			{
				sql: `INSERT INTO chat_session_catalogue
						(session_id, run_id, owner_user_id, graph_owner_principal, graph_id, workflow_name,
						 title, title_source, model, provider, continues_json, seed_window_json,
						 created_at, last_activity_at)
					SELECT s.session_id, s.run_id, s.owner_user_id, s.graph_owner_principal, s.graph_id, s.workflow_name,
						?, 'backfill', s.model, ?, NULL, NULL, s.created_at,
						MAX(s.created_at, COALESCE((SELECT MAX(e.ts) FROM agent_session_events e
							WHERE e.session_id = s.session_id
							  AND e.type IN (${sqlPlaceholders(CHAT_ACTIVITY_EVENT_TYPES.size)})
							  AND (e.type <> 'command.accepted'
							       OR CASE WHEN json_valid(e.payload_json) THEN json_extract(e.payload_json, '$.name') END
							          IN (${sqlPlaceholders(CHAT_ACTIVITY_COMMAND_NAMES.size)}))), 0))
					FROM agent_sessions s
					WHERE s.session_id = ? AND s.owner_user_id = ?
					ON CONFLICT(session_id) DO NOTHING`,
				args: [
					candidate.title,
					candidate.provider,
					...CHAT_ACTIVITY_EVENT_TYPES,
					...CHAT_ACTIVITY_COMMAND_NAMES,
					candidate.sessionId,
					candidate.ownerUserId,
				],
			},
			"UPSERT_IF_ABSENT",
		);
		return written.rowsAffected;
	}

	/**
	 * The list route's way in: catalogue an owner's legacy chats for one scope, a page at a time, at most
	 * `maxRounds` pages, and remember when a scope has none left. A chat born under this build has its
	 * catalogue row from its first write, so once a scope has been read to its end there is nothing new to
	 * find; asking again on every first page would open the owner's documents for nothing. The memory is this
	 * process's alone (a restart, a restore from an older snapshot or a rollback and re-deploy all start it
	 * empty), and is only written when the last page was short: a scope that was cut off by `maxRounds` is
	 * asked again by the next first page.
	 */
	async catalogueLegacyChats(scope: {
		readonly ownerUserId: string;
		readonly graphId?: string;
		readonly graphOwnerPrincipal?: string;
		readonly pageSize: number;
		readonly maxRounds: number;
	}): Promise<{ inserted: number; done: boolean }> {
		const key = JSON.stringify([scope.ownerUserId, scope.graphId ?? null, scope.graphOwnerPrincipal ?? null]);
		if (this.legacyChatScopesDone.has(key)) return { inserted: 0, done: true };
		let inserted = 0;
		for (let round = 0; round < scope.maxRounds; round++) {
			const batch = await this.backfillChatSessionCatalogueBatch(scope, scope.pageSize);
			inserted += batch.inserted;
			if (batch.candidates < scope.pageSize) {
				this.legacyChatScopesDone.add(key);
				return { inserted, done: true };
			}
		}
		return { inserted, done: false };
	}

	/** Scopes (owner, graph, graph owner) whose legacy chats this process has catalogued to the end. */
	private readonly legacyChatScopesDone = new Set<string>();

	/**
	 * The chat seed store (Sobremesa): the window of an earlier conversation a new chat
	 * continues, kept in two tables of this database. This database is what a Choreograph
	 * host restores from its S3 snapshot on boot, so a claimed seed survives an instance
	 * refresh for as long as its Session does, with no second snapshot set to provision.
	 *
	 * The bytes live ONLY in `chat_seeds`. The run (`workflow_instances`), the journal, the
	 * event log, the checkpoint and the Session document hold the digest and counts, never
	 * the bytes. A seed is per owner (`owner_user_id`, `digest`), so another person can
	 * neither read it nor learn that it exists. `chat_seed_claims` binds a seed to the Session
	 * that continues it. There are no foreign keys, so a purge is never blocked by a row it
	 * forgot; the purge below and `reapChatSeeds` delete these rows explicitly.
	 */
	private async ensureChatSeedTables(): Promise<void> {
		await this.db.batch(
			[
				`CREATE TABLE IF NOT EXISTS chat_seeds (
					owner_user_id    TEXT NOT NULL,
					digest           TEXT NOT NULL CHECK (digest GLOB 'sha256:*'),
					bytes            INTEGER NOT NULL CHECK (bytes > 0),
					content          TEXT NOT NULL,
					created_at       INTEGER NOT NULL CHECK (created_at >= 0),
					expires_at       INTEGER NOT NULL CHECK (expires_at >= 0),
					first_claimed_at INTEGER CHECK (first_claimed_at IS NULL OR first_claimed_at >= 0),
					PRIMARY KEY (owner_user_id, digest)
				)`,
				`CREATE TABLE IF NOT EXISTS chat_seed_claims (
					session_id    TEXT PRIMARY KEY,
					owner_user_id TEXT NOT NULL,
					digest        TEXT NOT NULL,
					claimed_at    INTEGER NOT NULL CHECK (claimed_at >= 0)
				)`,
				`CREATE INDEX IF NOT EXISTS idx_chat_seed_claims_seed ON chat_seed_claims(owner_user_id, digest)`,
			],
			"write",
		);
	}

	/**
	 * Store posted bytes for one owner. Content-addressed: the same bytes from the same
	 * owner are the same seed, and putting them again refreshes an unclaimed seed's hour.
	 * Throws `ChatSeedFault` (`seed_too_large`, `seed_invalid`) before anything is written.
	 */
	async putChatSeed(input: {
		readonly ownerUserId: string;
		readonly bytes: Uint8Array;
		readonly now: number;
		readonly ttlMs?: number;
	}): Promise<{ digest: string; bytes: number; expiresAt: number; created: boolean }> {
		const prepared = prepareChatSeed(input.bytes);
		const requestedExpiry = input.now + (input.ttlMs ?? CHAT_SEED_UNCLAIMED_TTL_MS);
		return this.tx(async (tx) => {
			const existing = await tx.execute({
				sql: "SELECT expires_at FROM chat_seeds WHERE owner_user_id = ? AND digest = ?",
				args: [input.ownerUserId, prepared.digest],
			});
			if (existing.rows[0]) {
				const expiresAt = Math.max(Number(existing.rows[0].expires_at), requestedExpiry);
				await renewChatSeedTx(tx, input.ownerUserId, prepared.digest, expiresAt);
				return { digest: prepared.digest, bytes: prepared.bytes, expiresAt, created: false };
			}
			await tx.execute({
				sql: `INSERT INTO chat_seeds (owner_user_id, digest, bytes, content, created_at, expires_at)
					VALUES (?, ?, ?, ?, ?, ?)`,
				args: [input.ownerUserId, prepared.digest, prepared.bytes, prepared.content, input.now, requestedExpiry],
			});
			// One person holds only so many unused seeds: the row just put, and the most recently put of the rest
			// (`expires_at` moves with every put and every admission; equal instants fall back to the digest), go
			// on; the others are displaced. The new row is left out of the ranking and spared, so it counts once,
			// whatever its digest sorts to among seeds that share its millisecond. Claimed seeds have
			// `first_claimed_at` and are not this person's to lose here.
			await tx.execute({
				sql: `DELETE FROM chat_seeds
					WHERE owner_user_id = ? AND first_claimed_at IS NULL AND digest <> ?
					  AND digest NOT IN (
					    SELECT digest FROM chat_seeds
					    WHERE owner_user_id = ? AND first_claimed_at IS NULL AND digest <> ?
					    ORDER BY expires_at DESC, digest DESC
					    LIMIT ?
					  )`,
				args: [
					input.ownerUserId,
					prepared.digest,
					input.ownerUserId,
					prepared.digest,
					CHAT_SEED_MAX_UNCLAIMED_PER_OWNER - 1,
				],
			});
			return { digest: prepared.digest, bytes: prepared.bytes, expiresAt: requestedExpiry, created: true };
		}, "UPSERT_IF_ABSENT");
	}

	/** A seed's facts without its bytes, or null when it is not this owner's or has expired unclaimed. */
	async peekChatSeed(input: {
		readonly ownerUserId: string;
		readonly digest: string;
		readonly now: number;
	}): Promise<{ digest: string; bytes: number; claimed: boolean; expiresAt: number } | null> {
		const result = await this.read({
			sql: `SELECT bytes, expires_at, EXISTS (${CHAT_SEED_HAS_CLAIM_SQL}) AS claimed
				FROM chat_seeds WHERE owner_user_id = ? AND digest = ?`,
			args: [input.ownerUserId, input.digest],
		});
		const row = result.rows[0];
		if (!row) return null;
		const claimed = Number(row.claimed) === 1;
		const expiresAt = Number(row.expires_at);
		if (!claimed && expiresAt <= input.now) return null;
		return { digest: input.digest, bytes: Number(row.bytes), claimed, expiresAt };
	}

	/** A seed with its bytes (as stored UTF-8 text), or null on the same terms as `peekChatSeed`. */
	async readChatSeed(input: {
		readonly ownerUserId: string;
		readonly digest: string;
		readonly now: number;
	}): Promise<{ digest: string; bytes: number; content: string; claimed: boolean; expiresAt: number } | null> {
		const result = await this.read({
			sql: `SELECT bytes, content, expires_at, EXISTS (${CHAT_SEED_HAS_CLAIM_SQL}) AS claimed
				FROM chat_seeds WHERE owner_user_id = ? AND digest = ?`,
			args: [input.ownerUserId, input.digest],
		});
		const row = result.rows[0];
		if (!row) return null;
		const claimed = Number(row.claimed) === 1;
		const expiresAt = Number(row.expires_at);
		if (!claimed && expiresAt <= input.now) return null;
		return { digest: input.digest, bytes: Number(row.bytes), content: String(row.content), claimed, expiresAt };
	}

	/**
	 * Admission's read of a seed: `readChatSeed`, and in the same write transaction an unclaimed seed's hour
	 * renewed from `now`. The run that follows admission reaches the step that begins its Session some time
	 * after the 202, and what was admitted must still be there when that Session claims it. Renewing makes the
	 * admitted seed the newest of the person's unused seeds (the cap displaces the oldest) with a full hour
	 * ahead of it. Null on the same terms as `readChatSeed`.
	 */
	async reserveChatSeed(input: {
		readonly ownerUserId: string;
		readonly digest: string;
		readonly now: number;
		readonly ttlMs?: number;
	}): Promise<{ digest: string; bytes: number; content: string; claimed: boolean; expiresAt: number } | null> {
		return this.tx(async (tx) => {
			const result = await tx.execute({
				sql: `SELECT bytes, content, expires_at, EXISTS (${CHAT_SEED_HAS_CLAIM_SQL}) AS claimed
					FROM chat_seeds WHERE owner_user_id = ? AND digest = ?`,
				args: [input.ownerUserId, input.digest],
			});
			const row = result.rows[0];
			if (!row) return null;
			const claimed = Number(row.claimed) === 1;
			let expiresAt = Number(row.expires_at);
			if (!claimed) {
				if (expiresAt <= input.now) return null;
				expiresAt = Math.max(expiresAt, input.now + (input.ttlMs ?? CHAT_SEED_UNCLAIMED_TTL_MS));
				await renewChatSeedTx(tx, input.ownerUserId, input.digest, expiresAt);
			}
			return { digest: input.digest, bytes: Number(row.bytes), content: String(row.content), claimed, expiresAt };
		}, "UPSERT");
	}

	/**
	 * Bind a seed to the Session that continues it, so it lives as long as that Session.
	 * Idempotent for the same Session and seed. Throws `ChatSeedFault`: `seed_claim_invalid`
	 * (the Session does not exist or is not this owner's), `seed_claim_conflict` (the Session
	 * already claimed a different seed), `seed_not_found` (never existed, expired, or someone
	 * else's; one answer for all three), `seed_bytes_mismatch`.
	 */
	async claimChatSeed(input: ChatSeedClaimInput): Promise<void> {
		await this.tx((tx) => claimChatSeedTx(tx, input), "UPSERT_IF_ABSENT");
	}

	/**
	 * The seed's bytes for the Session that claimed it, and only for it: the claim must name
	 * this Session, this owner and this digest. This is what the spawner resolves every time a
	 * Session's body is built, first spawn and every regrow. Null when there is no such claim.
	 */
	async readChatSeedForSession(input: {
		readonly sessionId: string;
		readonly ownerUserId: string;
		readonly digest: string;
	}): Promise<string | null> {
		const result = await this.read({
			sql: `SELECT s.content FROM chat_seed_claims c
				JOIN chat_seeds s ON s.owner_user_id = c.owner_user_id AND s.digest = c.digest
				WHERE c.session_id = ? AND c.owner_user_id = ? AND c.digest = ?`,
			args: [input.sessionId, input.ownerUserId, input.digest],
		});
		const row = result.rows[0];
		return row ? String(row.content) : null;
	}

	/**
	 * Delete what no Session needs: claims whose Session is closed, faulted or gone (a Session
	 * that is merely closing keeps its claim), seeds that were claimed and lost every claim, and
	 * unclaimed seeds past their hour. Reads already refuse an expired unclaimed seed; this
	 * reclaims the space and makes "deleted with its Session" true on disk.
	 */
	async reapChatSeeds(input: { readonly now: number }): Promise<{
		expired: number;
		releasedClaims: number;
		deletedClaimed: number;
	}> {
		return this.tx(async (tx) => {
			const released = await tx.execute({
				sql: `DELETE FROM chat_seed_claims
					WHERE session_id NOT IN (
						SELECT session_id FROM agent_sessions WHERE lifecycle_state IN ('open', 'closing')
					)`,
				args: [],
			});
			const deletedClaimed = await tx.execute({
				sql: `DELETE FROM chat_seeds
					WHERE first_claimed_at IS NOT NULL AND NOT EXISTS (${CHAT_SEED_HAS_CLAIM_SQL})`,
				args: [],
			});
			const expired = await tx.execute({
				sql: `DELETE FROM chat_seeds
					WHERE first_claimed_at IS NULL AND expires_at <= ? AND NOT EXISTS (${CHAT_SEED_HAS_CLAIM_SQL})`,
				args: [input.now],
			});
			return {
				expired: expired.rowsAffected,
				releasedClaims: released.rowsAffected,
				deletedClaimed: deletedClaimed.rowsAffected,
			};
		}, "UPSERT");
	}

	/**
	 * The pricing archive (Sobremesa): the exact catalogue snapshot a Session's rate card was read from, kept by
	 * its digest. A billing event names its price only by `pricingVersion` (`cat:<12 hex>@<time>`), and Sessions
	 * are purged while billing rows are kept, so this is what lets any event be re-derived later: version, then
	 * snapshot, then the model's row, then its price strings. The bytes are the very bytes the digest names
	 * (verified before they are kept), compressed. One row per snapshot that priced a chat, never per chat.
	 */
	private async ensurePricingArchiveTable(): Promise<void> {
		await this.db.execute(
			`CREATE TABLE IF NOT EXISTS pricing_catalogue_archive (
				digest        TEXT PRIMARY KEY CHECK (length(digest) = 64),
				fetched_at    TEXT NOT NULL,
				model_count   INTEGER NOT NULL CHECK (model_count >= 0),
				snapshot_gzip TEXT NOT NULL,
				archived_at   INTEGER NOT NULL CHECK (archived_at >= 0)
			)`,
		);
	}

	/**
	 * Keep the snapshot `digest` names, once. `coreJson` is a thunk so the (large) text is built only when the
	 * archive lacks the digest; it must hash to the digest, or nothing is kept and this throws. Idempotent.
	 */
	async archivePricingCatalogue(input: {
		readonly digest: string;
		readonly fetchedAt: string;
		readonly coreJson: () => string;
		readonly now: number;
	}): Promise<{ archived: boolean }> {
		if (!/^[0-9a-f]{64}$/.test(input.digest)) throw new Error("a catalogue digest is 64 lower-case hex characters");
		const existing = await this.read({
			sql: "SELECT 1 AS present FROM pricing_catalogue_archive WHERE digest = ?",
			args: [input.digest],
		});
		if (existing.rows[0]) return { archived: false };
		const json = input.coreJson();
		if (createHash("sha256").update(json).digest("hex") !== input.digest) {
			throw new Error("the catalogue snapshot does not hash to the digest it was archived under");
		}
		const models = (JSON.parse(json) as { models?: unknown }).models;
		const written = await this.tx(
			(tx) =>
				tx.execute({
					sql: `INSERT OR IGNORE INTO pricing_catalogue_archive
						(digest, fetched_at, model_count, snapshot_gzip, archived_at)
						VALUES (?, ?, ?, ?, ?)`,
					args: [
						input.digest,
						input.fetchedAt,
						Array.isArray(models) ? models.length : 0,
						gzipSync(Buffer.from(json, "utf8")).toString("base64"),
						input.now,
					],
				}),
			"UPSERT_IF_ABSENT",
		);
		return { archived: written.rowsAffected > 0 };
	}

	/** An archived snapshot by its full digest, or null. `coreJson` hashes to `digest`. */
	async readPricingCatalogueArchive(
		digest: string,
	): Promise<{ digest: string; fetchedAt: string; modelCount: number; coreJson: string; archivedAt: number } | null> {
		const result = await this.read({
			sql: `SELECT digest, fetched_at, model_count, snapshot_gzip, archived_at
				FROM pricing_catalogue_archive WHERE digest = ?`,
			args: [digest],
		});
		const row = result.rows[0];
		if (!row) return null;
		return {
			digest: String(row.digest),
			fetchedAt: String(row.fetched_at),
			modelCount: Number(row.model_count),
			coreJson: gunzipSync(Buffer.from(String(row.snapshot_gzip), "base64")).toString("utf8"),
			archivedAt: Number(row.archived_at),
		};
	}

	async offerDomainSourceTurn(
		input: OfferDomainSourceTurnInput,
	): Promise<{ created: true; record: DomainSourceTurnRecord } | { created: false; record: DomainSourceTurnRecord }> {
		return this.tx(async (tx) => {
			const existing = await tx.execute({
				sql: "SELECT * FROM domain_source_turns WHERE turn_id = ?",
				args: [input.turnId],
			});
			if (existing.rows[0]) {
				const record = rowToDomainSourceTurn(existing.rows[0]);
				if (record.turn_digest !== input.turnDigest) throw new DomainSourceTurnConflictError(input.turnId);
				return { created: false as const, record };
			}
			const inserted = await tx.execute({
				sql: `
					INSERT INTO domain_source_turns
						(turn_id, turn_digest, source_ref, source_digest, trigger_digest,
						 context_digest, owner_principal, graph_id, agent_id, actor_ref,
						 auth_method, trigger_adapter, first_invocation_id, turn_json,
						 created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					RETURNING *
				`,
				args: [
					input.turnId,
					input.turnDigest,
					input.sourceRef,
					input.sourceDigest,
					input.triggerDigest,
					input.contextDigest,
					input.ownerPrincipal,
					input.graphId,
					input.agentId,
					input.actorRef,
					input.authMethod,
					input.triggerAdapter ?? null,
					input.invocationId,
					JSON.stringify(input.turn),
					input.now,
					input.now,
				],
			});
			if (!inserted.rows[0]) throw new Error("domain source turn insert returned no row");
			return { created: true as const, record: rowToDomainSourceTurn(inserted.rows[0]) };
		}, "UPSERT_IF_ABSENT");
	}

	async getDomainSourceTurn(turnId: string): Promise<DomainSourceTurnRecord | null> {
		const result = await this.read({ sql: "SELECT * FROM domain_source_turns WHERE turn_id = ?", args: [turnId] });
		return result.rows[0] ? rowToDomainSourceTurn(result.rows[0]) : null;
	}

	async claimEffectIdempotency(input: {
		idempotencyKey: string;
		proposalDigest: string;
		runId: string;
		now: number;
	}): Promise<{ claimed: true } | { claimed: false; record: EffectIdempotencyRecord }> {
		return this.tx(async (tx) => {
			const existing = await tx.execute({
				sql: "SELECT * FROM effect_idempotency WHERE idempotency_key = ?",
				args: [input.idempotencyKey],
			});
			if (existing.rows[0]) return { claimed: false, record: rowToEffectIdempotency(existing.rows[0]) };
			await tx.execute({
				sql: `
					INSERT INTO effect_idempotency
						(idempotency_key, proposal_digest, run_id, status, claimed_at)
					VALUES (?, ?, ?, 'claimed', ?)
				`,
				args: [input.idempotencyKey, input.proposalDigest, input.runId, input.now],
			});
			return { claimed: true };
		}, "UPSERT_IF_ABSENT");
	}

	async completeEffectIdempotency(input: {
		idempotencyKey: string;
		proposalDigest: string;
		receipt: unknown;
		now: number;
	}): Promise<void> {
		const result = await this.write(
			{
				sql: `
					UPDATE effect_idempotency
					   SET status = 'complete', receipt_json = ?, completed_at = ?
					 WHERE idempotency_key = ? AND proposal_digest = ?
				`,
				args: [JSON.stringify(input.receipt), input.now, input.idempotencyKey, input.proposalDigest],
			},
			"CAS",
		);
		if (result.rowsAffected !== 1) {
			throw new Error(`effect idempotency completion lost claim for '${input.idempotencyKey}'`);
		}
	}

	async getEffectIdempotency(idempotencyKey: string): Promise<EffectIdempotencyRecord | null> {
		const result = await this.read({
			sql: "SELECT * FROM effect_idempotency WHERE idempotency_key = ?",
			args: [idempotencyKey],
		});
		return result.rows[0] ? rowToEffectIdempotency(result.rows[0]) : null;
	}

	async offerEffectHandoff(
		input: OfferEffectHandoffInput,
	): Promise<{ created: true; record: EffectHandoffRecord } | { created: false; record: EffectHandoffRecord }> {
		return this.tx(async (tx) => {
			const existing = await tx.execute({
				sql: "SELECT * FROM effect_handoffs WHERE idempotency_key = ?",
				args: [input.idempotencyKey],
			});
			if (existing.rows[0]) {
				const record = rowToEffectHandoff(existing.rows[0]);
				if (record.execution_digest !== input.executionDigest) {
					throw new EffectHandoffConflictError(input.idempotencyKey);
				}
				return { created: false as const, record };
			}
			const inserted = await tx.execute({
				sql: `
					INSERT INTO effect_handoffs
						(idempotency_key, execution_digest, proposal_digest, run_id, graph_id,
						 agent_id, actor_ref, grant_id, grant_document_id,
						 grant_authority_graph_id, grant_authority_owner_principal, grant_digest,
						 definition_digest, source_turn_id, source_turn_digest, source_owner_principal,
						 source_turn_json,
						 capability, operation, proposal_json, trigger_json, approval_json,
						 effect_index, state, not_before, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)
					RETURNING *
				`,
				args: [
					input.idempotencyKey,
					input.executionDigest,
					input.proposalDigest,
					input.runId,
					input.graphId,
					input.agentId,
					input.actorRef,
					input.grantId,
					input.grantDocumentId,
					input.grantAuthorityGraphId,
					input.grantAuthorityOwnerPrincipal,
					input.grantDigest,
					input.definitionDigest ?? null,
					input.sourceTurnId,
					input.sourceTurnDigest,
					input.sourceOwnerPrincipal,
					JSON.stringify(input.sourceTurn),
					input.capability,
					input.operation,
					JSON.stringify(input.proposal),
					input.trigger === undefined ? null : JSON.stringify(input.trigger),
					input.approval === undefined ? null : JSON.stringify(input.approval),
					input.effectIndex,
					input.now,
					input.now,
					input.now,
				],
			});
			if (!inserted.rows[0]) throw new Error("effect handoff insert returned no row");
			return { created: true as const, record: rowToEffectHandoff(inserted.rows[0]) };
		}, "UPSERT_IF_ABSENT");
	}

	async claimEffectHandoff(input: {
		consumer: string;
		capabilities: readonly string[];
		leaseMs: number;
		now: number;
	}): Promise<EffectHandoffRecord | null> {
		if (input.capabilities.length === 0) return null;
		const placeholders = input.capabilities.map(() => "?").join(", ");
		return this.tx(async (tx) => {
			const selected = await tx.execute({
				sql: `
					SELECT idempotency_key
					  FROM effect_handoffs
					 WHERE capability IN (${placeholders})
					   AND not_before <= ?
					   AND (state = 'ready' OR (state = 'claimed' AND lease_expires_at <= ?))
					 ORDER BY created_at ASC, effect_index ASC
					 LIMIT 1
				`,
				args: [...input.capabilities, input.now, input.now],
			});
			const idempotencyKey = selected.rows[0]?.idempotency_key;
			if (typeof idempotencyKey !== "string") return null;
			const claimToken = randomUUID();
			const claimed = await tx.execute({
				sql: `
					UPDATE effect_handoffs
					   SET state = 'claimed', consumer = ?, claim_token = ?, lease_expires_at = ?,
					       attempt = attempt + 1, updated_at = ?
					 WHERE idempotency_key = ?
					   AND (state = 'ready' OR (state = 'claimed' AND lease_expires_at <= ?))
					 RETURNING *
				`,
				args: [input.consumer, claimToken, input.now + input.leaseMs, input.now, idempotencyKey, input.now],
			});
			return claimed.rows[0] ? rowToEffectHandoff(claimed.rows[0]) : null;
		}, "CAS");
	}

	async completeEffectHandoff(input: {
		idempotencyKey: string;
		consumer: string;
		claimToken: string;
		outcome: "executed" | "failed-retryable" | "failed-terminal";
		completion: unknown;
		retryAfterMs?: number;
		now: number;
	}): Promise<EffectHandoffRecord> {
		const state: EffectHandoffState = input.outcome === "failed-retryable" ? "ready" : input.outcome;
		const notBefore = input.outcome === "failed-retryable" ? input.now + (input.retryAfterMs ?? 0) : input.now;
		const completedAt = input.outcome === "failed-retryable" ? null : input.now;
		const result = await this.write(
			{
				sql: `
					UPDATE effect_handoffs
					   SET state = ?, completion_json = ?, completed_at = ?, not_before = ?,
					       consumer = NULL, claim_token = NULL, lease_expires_at = NULL, updated_at = ?
					 WHERE idempotency_key = ? AND state = 'claimed' AND consumer = ? AND claim_token = ?
					 RETURNING *
				`,
				args: [
					state,
					JSON.stringify(input.completion ?? {}),
					completedAt,
					notBefore,
					input.now,
					input.idempotencyKey,
					input.consumer,
					input.claimToken,
				],
			},
			"CAS",
		);
		if (!result.rows[0]) {
			throw new Error(`effect handoff completion lost lease for '${input.idempotencyKey}'`);
		}
		return rowToEffectHandoff(result.rows[0]);
	}

	async getEffectHandoff(idempotencyKey: string): Promise<EffectHandoffRecord | null> {
		const result = await this.read({
			sql: "SELECT * FROM effect_handoffs WHERE idempotency_key = ?",
			args: [idempotencyKey],
		});
		return result.rows[0] ? rowToEffectHandoff(result.rows[0]) : null;
	}

	async createWorkflowInstance(input: CreateWorkflowInstanceInput): Promise<void> {
		await this.tx(async (tx) => {
			await tx.execute({
				sql: `
					INSERT INTO workflow_instances
						(run_id, workflow_name, graph_id, owner_user_id, status, source_sha256,
						 source_text, inputs_json, resume_from_run_id, frontier_json,
						 started_at, updated_at, payload_json)
					VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(run_id) DO UPDATE SET
						status = 'resuming',
						updated_at = excluded.updated_at
				`,
				args: [
					input.runId,
					input.workflowName,
					input.graphId,
					input.ownerUserId,
					input.sourceSha256 ?? null,
					input.sourceText ?? null,
					JSON.stringify(input.inputs ?? {}),
					input.resumeFromRunId ?? null,
					JSON.stringify({ kind: "run-started", ts: input.startedAt } satisfies WorkflowFrontier),
					input.startedAt,
					input.startedAt,
					input.payload === undefined ? null : JSON.stringify(input.payload),
				],
			});
			await tx.execute({
				sql: `
					INSERT INTO workflow_controls
						(run_id, revision, driver_json, amendments_json, current_beat_json, updated_at)
					VALUES (?, 0, NULL, '[]', NULL, ?)
					ON CONFLICT(run_id) DO NOTHING
				`,
				args: [input.runId, input.startedAt],
			});
		}, "UPSERT_IF_ABSENT");
	}

	async bindPhanesPrivacyEpochRun(input: PhanesPrivacyEpochBindingInput): Promise<void> {
		if (!/^[0-9a-f]{32}$/.test(input.epochId)) throw new Error("Phanes privacy epoch id is invalid");
		if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(input.datasetGraphId)) {
			throw new Error("Phanes privacy dataset graph id is invalid");
		}
		if (input.datasetEpoch.epochId !== input.epochId || input.datasetEpoch.graphId !== input.datasetGraphId) {
			throw new Error("Phanes privacy dataset Meaningful Object differs from its run binding");
		}
		if (!input.sourceEventRef.startsWith(`urn:phanes:dataset-epoch:${input.epochId}:source-event:`)) {
			throw new Error("Phanes privacy source event differs from its epoch binding");
		}
		const objectId = `urn:choreograph:privacy-runtime-run-binding:${input.runId}`;
		const projection = {
			runId: input.runId,
			datasetEpoch: input.datasetEpoch,
			sourceEventRef: input.sourceEventRef,
		};
		const value = {
			schema: "sophia.privacy-runtime-run-binding.v1",
			object: {
				...createMeaningfulObjectRef({
					kind: "privacy-runtime-run-binding",
					ownerPrincipal: "service:choreograph",
					graphId: input.datasetGraphId,
					objectId,
					version: input.epochId,
					value: projection,
				}),
			},
			runId: input.runId,
			datasetEpoch: input.datasetEpoch,
			sourceEventRef: input.sourceEventRef,
			boundAt: input.now,
		};
		await this.tx(async (tx) => {
			const existing = await tx.execute({
				sql: "SELECT * FROM privacy_epoch_runs WHERE run_id = ?",
				args: [input.runId],
			});
			const row = existing.rows[0];
			if (row) {
				let prior: unknown;
				try {
					prior = JSON.parse(String(row.binding_json));
				} catch {
					throw new Error("Phanes privacy run has a corrupt epoch binding");
				}
				const priorRecord = prior as Record<string, unknown>;
				if (
					String(row.epoch_id) === input.epochId &&
					String(row.dataset_graph_id) === input.datasetGraphId &&
					String(row.source_event_ref) === input.sourceEventRef &&
					canonicalJson(priorRecord.datasetEpoch) === canonicalJson(input.datasetEpoch)
				) {
					return;
				}
				throw new Error("Phanes privacy run already has a different epoch binding");
			}
			await tx.execute({
				sql: `INSERT INTO privacy_epoch_runs
					(run_id, epoch_id, dataset_graph_id, source_event_ref, binding_json, bound_at)
					VALUES (?, ?, ?, ?, ?, ?)`,
				args: [
					input.runId,
					input.epochId,
					input.datasetGraphId,
					input.sourceEventRef,
					JSON.stringify(value),
					input.now,
				],
			});
		}, "UPSERT_IF_ABSENT");
	}

	async planPhanesPrivacyEpochRetirement(scope: PhanesPrivacyRetirementScope): Promise<PhanesPrivacyRetirementPlan> {
		validatePhanesPrivacyRetirementScope(scope);
		// Privacy retirement immediately follows this inventory with destructive
		// writes to the same tables. Keep the inventory on the serialized writer
		// connection so the embedded libSQL reader cannot retain a shared-cache
		// table lock across that boundary.
		return this.tx(async (tx) => {
			const result = await tx.execute({
				sql: `SELECT workflow.run_id, workflow.inputs_json, binding.epoch_id
					FROM workflow_instances AS workflow
					LEFT JOIN privacy_epoch_runs AS binding ON binding.run_id = workflow.run_id
					WHERE workflow.workflow_name = ? AND workflow.graph_id = ? AND workflow.owner_user_id = ?`,
				args: [scope.workflowName, scope.homeGraphId, scope.ownerUserId],
			});
			const retiredRunIds: string[] = [];
			const activeRunIds: string[] = [];
			for (const row of result.rows) {
				const runId = String(row.run_id);
				const epochId =
					(typeof row.epoch_id === "string" ? row.epoch_id : undefined) ??
					privacyEpochFromWorkflowInputs(String(row.inputs_json));
				(epochId === scope.activeEpochId ? activeRunIds : retiredRunIds).push(runId);
			}
			const sandboxIds: string[] = [];
			if (retiredRunIds.length > 0) {
				const sessions = await tx.execute({
					sql: `SELECT sandbox_id FROM agent_sessions
						WHERE run_id IN (${sqlPlaceholders(retiredRunIds.length)}) AND sandbox_id IS NOT NULL`,
					args: retiredRunIds,
				});
				for (const row of sessions.rows) sandboxIds.push(String(row.sandbox_id));
			}
			return {
				retiredRunIds: [...new Set(retiredRunIds)].sort(),
				activeRunIds: [...new Set(activeRunIds)].sort(),
				sandboxIds: [...new Set(sandboxIds)].sort(),
			};
		}, "UPSERT");
	}

	async purgePhanesPrivacyEpochs(scope: PhanesPrivacyRetirementScope): Promise<PhanesPrivacyRuntimePurgeReceipt> {
		const plan = await this.planPhanesPrivacyEpochRetirement(scope);
		const runIds = plan.retiredRunIds;
		return this.tx(async (tx) => {
			const sourceRows = await tx.execute({
				sql: `SELECT turn_id, source_ref FROM domain_source_turns
					WHERE owner_principal = ? AND graph_id = ? AND trigger_adapter = 'discord'`,
				args: [scope.graphOwnerPrincipal, scope.homeGraphId],
			});
			const retiredSourceTurnIds = sourceRows.rows
				.filter((row) => privacyEpochFromSourceRef(String(row.source_ref)) !== scope.activeEpochId)
				.map((row) => String(row.turn_id));
			let retiredEffectCount = 0;
			let retiredAgentSessionCount = 0;
			if (runIds.length > 0 || retiredSourceTurnIds.length > 0) {
				const effectClauses: string[] = [];
				const effectArgs: string[] = [];
				if (runIds.length > 0) {
					effectClauses.push(`run_id IN (${sqlPlaceholders(runIds.length)})`);
					effectArgs.push(...runIds);
				}
				if (retiredSourceTurnIds.length > 0) {
					effectClauses.push(`source_turn_id IN (${sqlPlaceholders(retiredSourceTurnIds.length)})`);
					effectArgs.push(...retiredSourceTurnIds);
				}
				const deleted = await tx.execute({
					sql: `DELETE FROM effect_handoffs WHERE ${effectClauses.join(" OR ")}`,
					args: effectArgs,
				});
				retiredEffectCount = deleted.rowsAffected;
			}
			if (runIds.length > 0) {
				const sessionRows = await tx.execute({
					sql: `SELECT session_id FROM agent_sessions WHERE run_id IN (${sqlPlaceholders(runIds.length)})`,
					args: runIds,
				});
				const sessionIds = sessionRows.rows.map((row) => String(row.session_id));
				retiredAgentSessionCount = sessionIds.length;
				if (sessionIds.length > 0) {
					await tx.execute({
						sql: `DELETE FROM agent_session_document_ops WHERE session_id IN (${sqlPlaceholders(sessionIds.length)})`,
						args: sessionIds,
					});
					await tx.execute({
						sql: `DELETE FROM agent_session_events WHERE session_id IN (${sqlPlaceholders(sessionIds.length)})`,
						args: sessionIds,
					});
					// A chat's title is private text: it goes with its session.
					await tx.execute({
						sql: `DELETE FROM chat_session_catalogue WHERE session_id IN (${sqlPlaceholders(sessionIds.length)})`,
						args: sessionIds,
					});
					// So does the seed it continued: its claim, and the seed once no Session claims it.
					await tx.execute({
						sql: `DELETE FROM chat_seed_claims WHERE session_id IN (${sqlPlaceholders(sessionIds.length)})`,
						args: sessionIds,
					});
					await tx.execute({
						sql: `DELETE FROM chat_seeds
							WHERE first_claimed_at IS NOT NULL AND NOT EXISTS (${CHAT_SEED_HAS_CLAIM_SQL})`,
						args: [],
					});
				}
				for (const table of ["agent_sessions", "effect_idempotency", "workflow_controls", "privacy_epoch_runs"]) {
					await tx.execute({
						sql: `DELETE FROM ${table} WHERE run_id IN (${sqlPlaceholders(runIds.length)})`,
						args: runIds,
					});
				}
				await tx.execute({
					sql: `DELETE FROM workflow_instances WHERE run_id IN (${sqlPlaceholders(runIds.length)})`,
					args: runIds,
				});
			}
			if (retiredSourceTurnIds.length > 0) {
				await tx.execute({
					sql: `DELETE FROM domain_source_turns WHERE turn_id IN (${sqlPlaceholders(retiredSourceTurnIds.length)})`,
					args: retiredSourceTurnIds,
				});
			}
			return {
				retiredRunIds: runIds,
				retiredSourceTurnCount: retiredSourceTurnIds.length,
				retiredEffectCount,
				retiredAgentSessionCount,
			};
		}, "UPSERT");
	}

	async getWorkflowInstance(runId: string): Promise<WorkflowInstanceRecord | null> {
		const result = await this.read({ sql: "SELECT * FROM workflow_instances WHERE run_id = ?", args: [runId] });
		const row = result.rows[0];
		return row ? rowToWorkflowInstance(row) : null;
	}

	async requestPause(runId: string, input: { reason?: string; now: number }): Promise<WorkflowInstanceRecord | null> {
		await this.write(
			{
				sql: `
					UPDATE workflow_instances
					   SET status = CASE
								WHEN status IN ('completed', 'failed', 'stopped', 'paused', 'stopping') THEN status
								ELSE 'pausing'
						   END,
						   pause_requested_at = COALESCE(pause_requested_at, ?),
						   pause_reason = COALESCE(?, pause_reason),
						   updated_at = ?
					 WHERE run_id = ?
				`,
				args: [input.now, input.reason ?? null, input.now, runId],
			},
			"UPSERT",
		);
		return this.getWorkflowInstance(runId);
	}

	/**
	 * Ask a run to stop: it starts no new sitting (`assertWorkflowCanSchedule`, the pre-spawn gate) and becomes `stopping`
	 * until its driver, or the stop route for a run nothing drives, marks it `stopped`. The first request's time, owner
	 * and words are kept; a run that already ended is left as it is.
	 */
	async requestStop(
		runId: string,
		input: { by: string; reason?: string; now: number },
	): Promise<{ instance: WorkflowInstanceRecord | null; first: boolean }> {
		return this.tx(async (tx) => {
			const before = await tx.execute({
				sql: "SELECT status, stop_requested_at FROM workflow_instances WHERE run_id = ?",
				args: [runId],
			});
			const row = before.rows[0];
			const first = Boolean(row) && row!.stop_requested_at === null && !WORKFLOW_ENDED.has(String(row!.status));
			await tx.execute({
				sql: `
					UPDATE workflow_instances
					   SET status = CASE
								WHEN status IN ('completed', 'failed', 'stopped') THEN status
								ELSE 'stopping'
						   END,
						   stop_requested_at = COALESCE(stop_requested_at, ?),
						   stop_requested_by = COALESCE(stop_requested_by, ?),
						   stop_reason = COALESCE(stop_reason, ?),
						   updated_at = ?
					 WHERE run_id = ? AND status NOT IN ('completed', 'failed', 'stopped')
				`,
				args: [input.now, input.by, input.reason ?? null, input.now, runId],
			});
			const after = await tx.execute({ sql: "SELECT * FROM workflow_instances WHERE run_id = ?", args: [runId] });
			return { instance: after.rows[0] ? rowToWorkflowInstance(after.rows[0]) : null, first };
		}, "UPSERT");
	}

	async markPaused(runId: string, frontier: WorkflowFrontier): Promise<void> {
		await this.write(
			{
				sql: `
					UPDATE workflow_instances
					   SET status = 'paused',
						   frontier_json = ?,
						   updated_at = ?
					 WHERE run_id = ?
				`,
				args: [JSON.stringify(frontier), frontier.ts, runId],
			},
			"UPSERT",
		);
	}

	async markWorkflowFinished(
		runId: string,
		input: { status: WorkflowTerminalStatus; endedAt: number; frontier?: WorkflowFrontier },
	): Promise<void> {
		await this.write(
			{
				sql: `
					UPDATE workflow_instances
					   SET status = ?,
						   ended_at = ?,
						   updated_at = ?,
						   frontier_json = COALESCE(?, frontier_json)
					 WHERE run_id = ?
				`,
				args: [
					input.status,
					input.endedAt,
					input.endedAt,
					input.frontier ? JSON.stringify(input.frontier) : null,
					runId,
				],
			},
			"UPSERT",
		);
	}

	async beginAgentSession(input: BeginAgentSessionInput): Promise<AgentSessionRecord> {
		const semantic = requireExecutableSessionBinding(input.spec);
		const graphOwnerPrincipal = requireTypedGraphOwnerPrincipal(input.graphOwnerPrincipal);
		return this.tx(async (tx) => {
			const existingResult = await tx.execute({
				sql: "SELECT * FROM agent_sessions WHERE run_id = ? AND node_key = ?",
				args: [input.runId, input.nodeKey],
			});
			const existingRow = existingResult.rows[0];
			const eventPayload = {
				nodeKey: input.nodeKey,
				label: input.spec.label,
				phaseIndex: input.spec.phaseIndex,
				runtimeKind: semantic.runtime.kind,
				runtimeBindingDigest: semantic.runtimeDigest,
				ontologyBindingDigest: semantic.ontologyDigest,
			};

			if (existingRow) {
				const existing = rowToAgentSession(existingRow);
				if (
					existing.owner_user_id !== input.ownerUserId ||
					existing.graph_owner_principal !== graphOwnerPrincipal ||
					existing.graph_id !== input.graphId
				) {
					throw new Error(`agent session ${existing.session_id} cannot change its durable graph authority`);
				}
				assertSessionBindingsStable(existing, input.spec);
				await requireAgentSessionBudgetAccountTx(
					tx,
					existing.session_id,
					budgetVectorFromConstraints(semantic.runtime.constraints),
				);
				const status = existing.status === "completed" ? existing.status : "queued";
				const document = {
					...agentSessionDocumentFromJson(existing.document_json),
					frontier: input.frontier,
					runtime: {
						...asRecord(agentSessionDocumentFromJson(existing.document_json).runtime),
						status,
					},
				};
				const documentOp = await appendAgentSessionDocumentOpTx(tx, existing.session_id, {
					ts: input.now,
					actor: "choreograph.workflow-runtime",
					kind: "session.queued",
					patch: { op: "frontier.set", frontier: input.frontier, status },
					document,
				});
				await tx.execute({
					sql: `
						UPDATE agent_sessions
						   SET status = ?,
							   updated_at = ?,
							   frontier_json = ?,
							   document_json = ?
						 WHERE session_id = ?
					`,
					args: [
						status,
						input.now,
						JSON.stringify(input.frontier),
						JSON.stringify(documentOp.document),
						existing.session_id,
					],
				});
				await appendAgentSessionEventTx(tx, existing.session_id, {
					type: "session.queued",
					ts: input.now,
					payload: { ...eventPayload, documentRevision: documentOp.rev, documentChangeId: documentOp.change_id },
				});
				const record = await readAgentSessionTx(tx, existing.session_id);
				if (!record) {
					throw new Error(`beginAgentSession: failed to read ${existing.session_id}`);
				}
				return record;
			}

			const document = buildAgentSessionDocument(input);
			const documentOp = await appendAgentSessionDocumentOpTx(tx, input.sessionId, {
				ts: input.now,
				actor: "choreograph.workflow-runtime",
				kind: "session.created",
				patch: { op: "document.create", source: document.source, frontier: input.frontier },
				document,
			});
			await tx.execute({
				sql: `
					INSERT INTO agent_sessions
						(session_id, run_id, owner_user_id, graph_owner_principal, graph_id, workflow_name, node_key,
						 label, phase_index, agent_id, model, family_root_session_id, status, lifecycle_state, frontier_json,
						 document_json, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'open', ?, ?, ?, ?)
				`,
				args: [
					input.sessionId,
					input.runId,
					input.ownerUserId,
					graphOwnerPrincipal,
					input.graphId,
					input.workflowName,
					input.nodeKey,
					input.spec.label,
					input.spec.phaseIndex,
					input.spec.agentId ?? null,
					input.spec.model,
					input.sessionId,
					JSON.stringify(input.frontier),
					JSON.stringify(documentOp.document),
					input.now,
					input.now,
				],
			});
			const chatRecord = chatCatalogueRecordForNewSession(input, graphOwnerPrincipal);
			if (chatRecord) await insertChatSessionCatalogueTx(tx, chatRecord);
			if (input.spec.seed) {
				// Claimed in the same transaction that creates the Session: a Session that continues a chat
				// either exists with its seed bound to it, or does not exist. A seed that vanished since
				// admission fails the whole creation with ChatSeedFault (404 seed_not_found).
				await claimChatSeedTx(tx, {
					sessionId: input.sessionId,
					ownerUserId: input.ownerUserId,
					digest: input.spec.seed.digest,
					bytes: input.spec.seed.bytes,
					now: input.now,
				});
			}
			const scheduleGrantBinding = await deriveAgentSessionScheduleGrantBindingTx(tx, {
				runId: input.runId,
				// `requireExecutableSessionBinding` validates the runtime/ontology
				// pair; the admitted Session's explicit agent coordinate remains the
				// authority identity for a Domain grant binding.
				agentId: input.spec.agentId ?? "",
				runtimeBindingDigest: semantic.runtimeDigest,
				agentOntologyDigest: semantic.ontologyDigest,
				ownerUserId: input.ownerUserId,
				graphOwnerPrincipal,
				graphId: input.graphId,
			});
			if (scheduleGrantBinding) {
				await tx.execute({
					sql: `INSERT INTO agent_session_schedule_grant_bindings
					        (session_id, digest, binding_json, captured_at)
					      VALUES (?, ?, ?, ?)`,
					args: [
						input.sessionId,
						scheduleGrantBinding.digest,
						canonicalJson(scheduleGrantBinding),
						scheduleGrantBinding.snapshot.capturedAt,
					],
				});
			}
			await appendAgentSessionEventTx(tx, input.sessionId, {
				type: "session.queued",
				ts: input.now,
				payload: { ...eventPayload, documentRevision: documentOp.rev, documentChangeId: documentOp.change_id },
			});
			await openAgentSessionBudgetAccountTx(
				tx,
				input.sessionId,
				budgetVectorFromConstraints(semantic.runtime.constraints),
				input.now,
			);
			const record = await readAgentSessionTx(tx, input.sessionId);
			if (!record) {
				throw new Error(`beginAgentSession: failed to read ${input.sessionId}`);
			}
			return record;
		}, "UPSERT");
	}

	async bindAgentSandbox(
		sessionId: string,
		input: {
			sandboxId: string;
			generation: number;
			activationId: string;
			now: number;
			childRunConsumer?: string;
			childRunClaimToken?: string;
		},
	): Promise<void> {
		await this.tx(async (tx) => {
			const existing = await readAgentSessionTx(tx, sessionId);
			if (!existing) return;
			if (existing.lifecycle_state !== "open") {
				throw new AgentSessionGenerationFault("A closing or terminal Session cannot bind a sandbox body");
			}
			if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
				throw new AgentSessionGenerationFault("Materialization generation must be a non-negative integer");
			}
			const latestResult = await tx.execute({
				sql: "SELECT * FROM agent_materializations WHERE session_id = ? ORDER BY generation DESC LIMIT 1",
				args: [sessionId],
			});
			const latest = latestResult.rows[0] ? rowToAgentMaterialization(latestResult.rows[0]) : undefined;
			const hostedRunResult = await tx.execute({
				sql: "SELECT * FROM agent_session_child_runs WHERE child_session_id = ?",
				args: [sessionId],
			});
			const hostedRun = hostedRunResult.rows[0] ? rowToAgentSessionChildRun(hostedRunResult.rows[0]) : null;
			if (hostedRun) {
				if (!input.childRunConsumer || !input.childRunClaimToken) {
					throw new AgentSessionGenerationFault("Hosted child sandbox bind requires its exact run lease");
				}
				assertActiveChildRunLease(
					hostedRun,
					{
						consumer: input.childRunConsumer,
						claimToken: input.childRunClaimToken,
						now: input.now,
					},
					["claimed"],
				);
				if (hostedRun.materialized_at !== null && hostedRun.materialization_generation !== input.generation) {
					throw new AgentSessionGenerationFault("Hosted child run already bound a different body generation");
				}
			}
			if (latest?.generation === input.generation) {
				if (latest.activation_id !== input.activationId) {
					throw new AgentSessionGenerationFault(
						`Generation ${String(input.generation)} already belongs to another materialization`,
					);
				}
				await assertLiveLatestMaterializationActivationTx(tx, sessionId, input.generation, input.activationId);
				if (latest.state !== "claimed") {
					if (
						latest.sandbox_id === input.sandboxId &&
						latest.state === "running" &&
						(!hostedRun || hostedRun.materialization_generation === input.generation)
					) {
						return;
					}
					throw new AgentSessionGenerationFault("Claimed generation is no longer bindable");
				}
				if (hostedRun) {
					const bound = await tx.execute({
						sql: `UPDATE agent_session_child_runs
						      SET materialization_generation = ?, materialized_at = ?
						      WHERE child_run_id = ? AND state = 'claimed' AND consumer = ? AND claim_token = ?
						        AND claim_expires_at > ? AND materialized_at IS NULL`,
						args: [
							input.generation,
							input.now,
							hostedRun.child_run_id,
							input.childRunConsumer!,
							input.childRunClaimToken!,
							input.now,
						],
					});
					if (bound.rowsAffected !== 1) {
						throw new AgentSessionGenerationFault("Hosted child sandbox bind lost cancellation arbitration");
					}
				}
				await tx.execute({
					sql: `UPDATE agent_materializations SET sandbox_id = ?, state = 'running', updated_at = ?
					WHERE session_id = ? AND generation = ? AND state = 'claimed'`,
					args: [input.sandboxId, input.now, sessionId, input.generation],
				});
				await upsertAgentSessionBodyStateTx(tx, {
					sessionId,
					generation: input.generation,
					role: "worker",
					state: "running",
					now: input.now,
				});
				if (readAgentSessionSemanticBinding(existing).runtime.kind === "prime") {
					await tx.execute({
						sql: `INSERT INTO agent_session_kernel_launches
						        (session_id, generation, activation_id, sandbox_id, state, attempt,
						         created_at, updated_at, body_observed_at, terminal_at)
						      VALUES (?, ?, ?, NULL, 'not_requested', 0, ?, ?, NULL, NULL)
						      ON CONFLICT(session_id, generation) DO NOTHING`,
						args: [sessionId, input.generation, input.activationId, input.now, input.now],
					});
				}
			} else {
				throw new AgentSessionGenerationFault("Materialization must be claimed before a sandbox is spawned");
			}
			const status = existing.status === "completed" ? existing.status : "running";
			const base = agentSessionDocumentFromJson(existing.document_json);
			const document = {
				...base,
				runtime: {
					...asRecord(base.runtime),
					status,
					sandboxId: input.sandboxId,
					sandboxGeneration: input.generation,
					activationId: input.activationId,
				},
			};
			const documentOp = await appendAgentSessionDocumentOpTx(tx, sessionId, {
				ts: input.now,
				actor: "choreograph.workflow-runtime",
				kind: "runtime.bound",
				patch: {
					op: "runtime.materialization.bind",
					sandboxId: input.sandboxId,
					generation: input.generation,
					activationId: input.activationId,
					status,
				},
				document,
			});
			await tx.execute({
				sql: `
					UPDATE agent_sessions
					   SET sandbox_id = ?,
						   status = ?,
						   document_json = ?,
						   updated_at = ?
					 WHERE session_id = ?
				`,
				args: [input.sandboxId, status, JSON.stringify(documentOp.document), input.now, sessionId],
			});
			await appendAgentSessionEventTx(tx, sessionId, {
				type: "runtime.bound",
				ts: input.now,
				payload: {
					sandboxId: input.sandboxId,
					generation: input.generation,
					activationId: input.activationId,
					documentRevision: documentOp.rev,
					documentChangeId: documentOp.change_id,
				},
			});
		}, "UPSERT");
	}

	async claimAgentMaterialization(
		sessionId: string,
		input: { generation: number; activationId: string; now: number },
	): Promise<AgentMaterializationRecord> {
		return this.tx(async (tx) => {
			const childRunResult = await tx.execute({
				sql: "SELECT * FROM agent_session_child_runs WHERE child_session_id = ?",
				args: [sessionId],
			});
			if (childRunResult.rows[0]) {
				const run = rowToAgentSessionChildRun(childRunResult.rows[0]);
				const child = await requireChildSessionForRunTx(tx, run);
				const initialFence = run.materialized_at !== null && run.materialization_generation === input.generation;
				const residentRegrow = isTerminalAgentSessionChildRunState(run.state) && child.lifecycle_state === "open";
				if (!initialFence && !residentRegrow) {
					throw new AgentSessionChildRunFault(
						"materialization_conflict",
						"hosted child materialization requires the child-run lease fence",
					);
				}
			}
			return claimAgentMaterializationTx(tx, sessionId, input);
		}, "CAS");
	}

	/**
	 * Relinquish a standalone root launch reservation that never crossed the OS
	 * process-spawn/body-bind boundary. No worker body existed, so this removes
	 * only the exact claim sentinel and leaves the Session queued for an honest
	 * workflow retry.
	 */
	async releaseUnboundAgentMaterializationLaunch(
		sessionId: string,
		input: { generation: number; activationId: string; reason: string; now: number },
	): Promise<boolean> {
		const reason = requiredBoundedText(input.reason, "unbound Agent launch failure", 2048);
		validateChildRunTimestamp(input.now, "unbound Agent launch failure time");
		return this.tx(async (tx) => {
			const session = await readAgentSessionTx(tx, sessionId);
			if (!session) return false;
			const hosted = await tx.execute({
				sql: "SELECT 1 AS found FROM agent_session_child_runs WHERE child_session_id = ?",
				args: [sessionId],
			});
			if (hosted.rows[0]) {
				throw new AgentSessionGenerationFault("Hosted child launch reservations are child-run supervised");
			}
			const materialization = await readAgentMaterializationTx(tx, sessionId, input.generation);
			if (!materialization) return false;
			if (
				materialization.activation_id !== input.activationId ||
				materialization.state !== "claimed" ||
				materialization.sandbox_id !== `claim:${input.activationId}`
			) {
				return false;
			}
			const bodies = await tx.execute({
				sql: "SELECT 1 AS found FROM agent_session_body_states WHERE session_id = ? AND generation = ? LIMIT 1",
				args: [sessionId, input.generation],
			});
			if (bodies.rows[0]) {
				throw new AgentSessionGenerationFault("Unbound Agent launch cannot own durable body testimony");
			}
			const deletedSupervision = await tx.execute({
				sql: `DELETE FROM agent_materialization_supervision
				      WHERE session_id = ? AND generation = ? AND activation_id = ?
				        AND recovery_token IS NULL`,
				args: [sessionId, input.generation, input.activationId],
			});
			if (deletedSupervision.rowsAffected !== 1) {
				throw new AgentSessionGenerationFault("Unbound Agent launch lost its exact supervision fence");
			}
			const deletedMaterialization = await tx.execute({
				sql: `DELETE FROM agent_materializations
				      WHERE session_id = ? AND generation = ? AND activation_id = ?
				        AND state = 'claimed' AND sandbox_id = 'claim:' || activation_id`,
				args: [sessionId, input.generation, input.activationId],
			});
			if (deletedMaterialization.rowsAffected !== 1) {
				throw new AgentSessionGenerationFault("Unbound Agent launch lost its exact claim sentinel");
			}
			await releaseAgentSessionChildGenerationOccupancyTx(tx, sessionId, input.generation, input.now);
			await tx.execute({
				sql: `UPDATE agent_sessions
				      SET sandbox_id = NULL, status = 'queued', updated_at = ?
				      WHERE session_id = ? AND lifecycle_state = 'open'`,
				args: [input.now, sessionId],
			});
			// `reason` is deliberately validated but not journaled: no ratified
			// runtime event exists for an OS body that never came into existence.
			void reason;
			return true;
		}, "CAS");
	}

	async commitAgentCheckpoint(checkpoint: AgentCheckpointCommitV2): Promise<void> {
		validateCheckpointCommit(checkpoint);
		await this.tx(async (tx) => {
			const manifest = checkpoint.manifest;
			const session = await readAgentSessionTx(tx, manifest.sessionId);
			if (!session) throw new Error(`Agent session not found: ${manifest.sessionId}`);
			const existing = await tx.execute({
				sql: "SELECT object_json, manifest_json FROM agent_checkpoints WHERE checkpoint_id = ?",
				args: [manifest.checkpointId],
			});
			if (existing.rows[0]) {
				if (
					String(existing.rows[0].object_json) !== JSON.stringify(checkpoint.object) ||
					String(existing.rows[0].manifest_json) !== JSON.stringify(manifest)
				) {
					throw new AgentSessionGenerationFault("Checkpoint id already names different memory");
				}
				return;
			}
			await assertMaterializationNotRecoveryFencedTx(tx, manifest.sessionId, manifest.generation);
			const materialization = await tx.execute({
				sql: "SELECT * FROM agent_materializations WHERE session_id = ? AND generation = ?",
				args: [manifest.sessionId, manifest.generation],
			});
			const incarnation = materialization.rows[0] ? rowToAgentMaterialization(materialization.rows[0]) : undefined;
			if (!incarnation || incarnation.sandbox_id !== manifest.sandboxId) {
				throw new AgentSessionGenerationFault("Checkpoint does not belong to the admitted materialization");
			}
			if (incarnation.state === "passivated") {
				throw new AgentSessionGenerationFault("A passivated generation cannot append another checkpoint");
			}
			const latest = await tx.execute({
				sql: "SELECT session_sequence FROM agent_checkpoints WHERE session_id = ? ORDER BY session_sequence DESC LIMIT 1",
				args: [manifest.sessionId],
			});
			const previousSequence = latest.rows[0]?.session_sequence;
			if (typeof previousSequence === "number" && manifest.sessionSequence <= previousSequence) {
				throw new AgentSessionGenerationFault("Checkpoint sequence did not advance");
			}
			await tx.execute({
				sql: `INSERT INTO agent_checkpoints
					(checkpoint_id, session_id, session_sequence, generation, sandbox_id,
					 object_json, manifest_json, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				args: [
					manifest.checkpointId,
					manifest.sessionId,
					manifest.sessionSequence,
					manifest.generation,
					manifest.sandboxId,
					JSON.stringify(checkpoint.object),
					JSON.stringify(manifest),
					Date.parse(manifest.createdAt),
				],
			});
			await tx.execute({
				sql: `UPDATE agent_materializations
					SET checkpoint_id = ?, updated_at = ?
					WHERE session_id = ? AND generation = ?`,
				args: [manifest.checkpointId, Date.parse(manifest.createdAt), manifest.sessionId, manifest.generation],
			});
			const base = agentSessionDocumentFromJson(session.document_json);
			const meaningfulObjects = asRecord(base.meaningfulObjects);
			const document = {
				...base,
				meaningfulObjects: { ...meaningfulObjects, agentCheckpoint: checkpoint.object },
				runtime: {
					...asRecord(base.runtime),
					checkpoint: checkpoint.object,
					checkpointSequence: manifest.sessionSequence,
					sandboxGeneration: manifest.generation,
				},
			};
			const documentOp = await appendAgentSessionDocumentOpTx(tx, manifest.sessionId, {
				ts: Date.parse(manifest.createdAt),
				actor: "choreograph.agent-memory",
				kind: "agent-checkpoint.committed",
				patch: { op: "runtime.checkpoint.commit", checkpoint: checkpoint.object },
				document,
			});
			await tx.execute({
				sql: "UPDATE agent_sessions SET document_json = ?, updated_at = ? WHERE session_id = ?",
				args: [JSON.stringify(documentOp.document), Date.parse(manifest.createdAt), manifest.sessionId],
			});
		}, "APPEND");
	}

	async readLatestAgentCheckpoint(sessionId: string): Promise<AgentCheckpointCommitV2 | null> {
		const result = await this.read({
			sql: "SELECT object_json, manifest_json FROM agent_checkpoints WHERE session_id = ? ORDER BY session_sequence DESC LIMIT 1",
			args: [sessionId],
		});
		const row = result.rows[0];
		if (!row) return null;
		const checkpoint = {
			object: JSON.parse(String(row.object_json)),
			manifest: JSON.parse(String(row.manifest_json)),
		} as AgentCheckpointCommitV2;
		validateCheckpointCommit(checkpoint);
		return checkpoint;
	}

	async commitKernelCheckpoint(checkpoint: KernelCheckpointCommitV1): Promise<void> {
		await this.tx(async (tx) => {
			const manifest = checkpoint.manifest;
			const existing = await tx.execute({
				sql: "SELECT object_json, manifest_json FROM kernel_checkpoints WHERE checkpoint_id = ?",
				args: [manifest.checkpointId],
			});
			if (existing.rows[0]) {
				if (
					String(existing.rows[0].object_json) !== JSON.stringify(checkpoint.object) ||
					String(existing.rows[0].manifest_json) !== JSON.stringify(manifest)
				) {
					throw new AgentSessionGenerationFault("Kernel checkpoint id already names different memory");
				}
				return;
			}
			await assertMaterializationNotRecoveryFencedTx(tx, manifest.sessionId, manifest.generation);
			const materialization = await tx.execute({
				sql: "SELECT * FROM agent_materializations WHERE session_id = ? AND generation = ?",
				args: [manifest.sessionId, manifest.generation],
			});
			const incarnation = materialization.rows[0] ? rowToAgentMaterialization(materialization.rows[0]) : undefined;
			if (!incarnation || !incarnation.checkpoint_id || incarnation.state === "passivated") {
				throw new AgentSessionGenerationFault(
					"Kernel snapshot requires a live generation with committed conversational memory",
				);
			}
			const head = await tx.execute({
				sql: `SELECT cell_digest FROM execution_cells
					WHERE session_id = ? ORDER BY generation DESC, ordinal DESC LIMIT 1`,
				args: [manifest.sessionId],
			});
			if (String(head.rows[0]?.cell_digest ?? "") !== manifest.journalHeadDigest) {
				throw new AgentSessionGenerationFault("Kernel snapshot does not bind the committed journal head");
			}
			await tx.execute({
				sql: `INSERT INTO kernel_checkpoints
					(checkpoint_id, session_id, generation, journal_head_digest, object_json, manifest_json, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?)`,
				args: [
					manifest.checkpointId,
					manifest.sessionId,
					manifest.generation,
					manifest.journalHeadDigest,
					JSON.stringify(checkpoint.object),
					JSON.stringify(manifest),
					Date.parse(manifest.createdAt),
				],
			});
			await tx.execute({
				sql: `UPDATE agent_materializations SET kernel_checkpoint_id = ?, updated_at = ?
					WHERE session_id = ? AND generation = ?`,
				args: [manifest.checkpointId, Date.parse(manifest.createdAt), manifest.sessionId, manifest.generation],
			});
			const session = await readAgentSessionTx(tx, manifest.sessionId);
			if (!session) return;
			const base = agentSessionDocumentFromJson(session.document_json);
			const document = {
				...base,
				meaningfulObjects: {
					...asRecord(base.meaningfulObjects),
					kernelCheckpoint: checkpoint.object,
				},
				compute: { ...asRecord(base.compute), checkpoint: checkpoint.object },
			};
			const documentOp = await appendAgentSessionDocumentOpTx(tx, manifest.sessionId, {
				ts: Date.parse(manifest.createdAt),
				actor: "choreograph.execution-service",
				kind: "kernel.checkpointed",
				patch: { op: "compute.checkpoint.commit", checkpoint: checkpoint.object },
				document,
			});
			await tx.execute({
				sql: "UPDATE agent_sessions SET document_json = ?, updated_at = ? WHERE session_id = ?",
				args: [JSON.stringify(documentOp.document), Date.parse(manifest.createdAt), manifest.sessionId],
			});
			await appendAgentSessionEventTx(tx, manifest.sessionId, {
				type: "kernel.checkpointed",
				ts: Date.parse(manifest.createdAt),
				payload: { checkpoint: checkpoint.object, generation: manifest.generation },
			});
		}, "APPEND");
	}

	async readLatestKernelCheckpoint(sessionId: string): Promise<KernelCheckpointCommitV1 | null> {
		const result = await this.read({
			sql: `SELECT object_json, manifest_json FROM kernel_checkpoints
				WHERE session_id = ? ORDER BY generation DESC, created_at DESC LIMIT 1`,
			args: [sessionId],
		});
		const row = result.rows[0];
		if (!row) return null;
		return {
			object: JSON.parse(String(row.object_json)),
			manifest: JSON.parse(String(row.manifest_json)),
		} as KernelCheckpointCommitV1;
	}

	async readAgentMaterialization(sessionId: string, generation: number): Promise<AgentMaterializationRecord | null> {
		const result = await this.read({
			sql: "SELECT * FROM agent_materializations WHERE session_id = ? AND generation = ?",
			args: [sessionId, generation],
		});
		return result.rows[0] ? rowToAgentMaterialization(result.rows[0]) : null;
	}

	async heartbeatAgentMaterialization(
		sessionId: string,
		generation: number,
		input: { readonly activationId: string; readonly now: number },
	): Promise<void> {
		validateChildRunTimestamp(input.now, "materialization heartbeat time");
		const result = await this.write(
			{
				sql: `UPDATE agent_materialization_supervision AS supervision
				         SET heartbeat_at = ?
					       WHERE session_id = ? AND generation = ? AND activation_id = ?
					         AND recovery_token IS NULL
					         AND heartbeat_at <= ?
					         AND EXISTS (
				           SELECT 1 FROM agent_materializations AS materialization
				            WHERE materialization.session_id = supervision.session_id
				              AND materialization.generation = supervision.generation
				              AND materialization.state IN ('claimed', 'running', 'quiescing', 'quiescent')
				         )`,
				args: [input.now, sessionId, generation, input.activationId, input.now],
			},
			"CAS",
		);
		if (result.rowsAffected !== 1) {
			throw new AgentSessionGenerationFault("materialization heartbeat lost its live activation fence");
		}
	}

	async claimAgentMaterializationRecovery(input: {
		readonly consumer: string;
		readonly leaseMs: number;
		readonly staleBefore: number;
		readonly now: number;
	}): Promise<AgentMaterializationRecoveryClaim | null> {
		const consumer = requiredChildRunText(input.consumer, "materialization recovery consumer", 256);
		validatePositiveChildRunInteger(input.leaseMs, "materialization recovery lease duration");
		validateChildRunTimestamp(input.staleBefore, "materialization stale boundary");
		validateChildRunTimestamp(input.now, "materialization recovery claim time");
		if (input.staleBefore > input.now) {
			throw new AgentSessionChildRunFault("not_claimable", "materialization stale boundary cannot be in the future");
		}
		return this.tx(async (tx) => {
			const selected = await tx.execute({
				sql: `SELECT supervision.session_id, supervision.generation
					        FROM agent_materialization_supervision AS supervision
					        JOIN agent_materializations AS materialization
				          ON materialization.session_id = supervision.session_id
					         AND materialization.generation = supervision.generation
					        JOIN agent_sessions AS session ON session.session_id = materialization.session_id
				   LEFT JOIN agent_session_child_runs AS child_run
				          ON child_run.child_session_id = materialization.session_id
				         AND child_run.materialization_generation = materialization.generation
				       WHERE (
					               (materialization.state IN ('claimed', 'running', 'quiescing', 'quiescent')
					                AND NOT (materialization.state = 'claimed'
					                         AND materialization.sandbox_id = 'claim:' || materialization.activation_id)
				                AND supervision.heartbeat_at <= ?
				                AND (child_run.child_run_id IS NULL
				                  OR child_run.state IN ('completed', 'failed', 'cancelled')
				                  OR child_run.claim_expires_at <= ?))
				            OR (materialization.state IN ('passivated', 'completed', 'faulted', 'cancelled')
					                AND child_run.state IN ('claimed', 'cancelling')
					                AND child_run.claim_expires_at <= ?)
					         )
					         AND NOT EXISTS (
					           SELECT 1 FROM agent_sessions AS closing_session
					           JOIN agent_session_relations AS relation ON relation.parent_session_id = closing_session.session_id
					           JOIN agent_sessions AS descendant ON descendant.session_id = relation.child_session_id
					          WHERE closing_session.session_id = materialization.session_id
					            AND closing_session.lifecycle_state = 'closing'
					            AND descendant.lifecycle_state <> 'closed'
					         )
					         AND supervision.heartbeat_at <= ?
					         AND (supervision.recovery_token IS NULL OR supervision.recovery_expires_at <= ?)
				       ORDER BY supervision.heartbeat_at ASC, supervision.session_id ASC, supervision.generation ASC
				       LIMIT 1`,
				args: [input.staleBefore, input.now, input.now, input.now, input.now],
			});
			if (!selected.rows[0]) return null;
			const sessionId = String(selected.rows[0].session_id);
			const generation = Number(selected.rows[0].generation);
			const recoveryToken = randomUUID();
			const updated = await tx.execute({
				sql: `UPDATE agent_materialization_supervision
					         SET recovery_attempt = recovery_attempt + 1, recovery_consumer = ?, recovery_token = ?,
					             recovery_claimed_at = ?, recovery_expires_at = ?, recovery_heartbeat_at = ?, recovered_at = NULL
				       WHERE session_id = ? AND generation = ?
					         AND (
					               (heartbeat_at <= ? AND EXISTS (
					                  SELECT 1 FROM agent_materializations AS materialization
					             LEFT JOIN agent_session_child_runs AS child_run
					                    ON child_run.child_session_id = materialization.session_id
					                   AND child_run.materialization_generation = materialization.generation
					                   WHERE materialization.session_id = agent_materialization_supervision.session_id
					                     AND materialization.generation = agent_materialization_supervision.generation
					                     AND materialization.state IN ('claimed', 'running', 'quiescing', 'quiescent')
					                     AND NOT (materialization.state = 'claimed'
					                              AND materialization.sandbox_id = 'claim:' || materialization.activation_id)
					                     AND (child_run.child_run_id IS NULL
					                       OR child_run.state IN ('completed', 'failed', 'cancelled')
					                       OR child_run.claim_expires_at <= ?)
					               ))
					            OR EXISTS (
				                  SELECT 1 FROM agent_materializations AS materialization
				                  JOIN agent_session_child_runs AS child_run
				                    ON child_run.child_session_id = materialization.session_id
				                   AND child_run.materialization_generation = materialization.generation
				                 WHERE materialization.session_id = agent_materialization_supervision.session_id
				                   AND materialization.generation = agent_materialization_supervision.generation
				                   AND materialization.state IN ('passivated', 'completed', 'faulted', 'cancelled')
				                   AND child_run.state IN ('claimed', 'cancelling')
					                   AND child_run.claim_expires_at <= ?
					               )
					         )
					         AND NOT EXISTS (
					           SELECT 1 FROM agent_sessions AS closing_session
					           JOIN agent_session_relations AS relation ON relation.parent_session_id = closing_session.session_id
					           JOIN agent_sessions AS descendant ON descendant.session_id = relation.child_session_id
					          WHERE closing_session.session_id = agent_materialization_supervision.session_id
					            AND closing_session.lifecycle_state = 'closing'
					            AND descendant.lifecycle_state <> 'closed'
					         )
					         AND heartbeat_at <= ?
					         AND (recovery_token IS NULL OR recovery_expires_at <= ?)
				       RETURNING *`,
				args: [
					consumer,
					recoveryToken,
					input.now,
					checkedBudgetSum(input.now, input.leaseMs),
					input.now,
					sessionId,
					generation,
					input.staleBefore,
					input.now,
					input.now,
					input.now,
					input.now,
				],
			});
			if (!updated.rows[0]) return null;
			return requireAgentMaterializationRecoveryClaimTx(tx, sessionId, generation, true);
		}, "CAS");
	}

	async renewAgentMaterializationRecoveryLease(input: {
		readonly sessionId: string;
		readonly generation: number;
		readonly consumer: string;
		readonly recoveryToken: string;
		readonly leaseMs: number;
		readonly now: number;
	}): Promise<AgentMaterializationRecoveryClaim> {
		validatePositiveChildRunInteger(input.leaseMs, "materialization recovery lease duration");
		validateChildRunTimestamp(input.now, "materialization recovery renewal time");
		return this.tx(async (tx) => {
			const updated = await tx.execute({
				sql: `UPDATE agent_materialization_supervision
					         SET recovery_heartbeat_at = ?, recovery_expires_at = ?
					       WHERE session_id = ? AND generation = ? AND recovery_consumer = ? AND recovery_token = ?
					         AND recovery_expires_at > ? AND recovery_heartbeat_at <= ?
					         AND ? >= recovery_expires_at AND recovered_at IS NULL`,
				args: [
					input.now,
					checkedBudgetSum(input.now, input.leaseMs),
					input.sessionId,
					input.generation,
					input.consumer,
					input.recoveryToken,
					input.now,
					input.now,
					checkedBudgetSum(input.now, input.leaseMs),
				],
			});
			if (updated.rowsAffected !== 1) {
				throw new AgentSessionChildRunFault("lease_lost", "materialization recovery lease was lost");
			}
			return requireAgentMaterializationRecoveryClaimTx(tx, input.sessionId, input.generation, false);
		}, "CAS");
	}

	async finishRecoveredAgentMaterialization(
		sessionId: string,
		generation: number,
		input:
			| {
					readonly consumer: string;
					readonly recoveryToken: string;
					readonly to: "completed";
					readonly now: number;
			  }
			| {
					readonly consumer: string;
					readonly recoveryToken: string;
					readonly to: "faulted";
					readonly faultKind: AgentMaterializationFaultKind;
					readonly recoverable: boolean;
					readonly now: number;
			  }
			| {
					readonly consumer: string;
					readonly recoveryToken: string;
					readonly to: "cancelled";
					readonly now: number;
			  },
	): Promise<{ materialization: AgentMaterializationRecord; childRun: AgentSessionChildRunRecord | null }> {
		validateChildRunTimestamp(input.now, "materialization recovery finish time");
		return this.tx(async (tx) => {
			await assertMaterializationRecoveryLeaseIdentityTx(tx, sessionId, generation, input);
			const materialization = await readAgentMaterializationTx(tx, sessionId, generation);
			if (materialization?.state === input.to) {
				if (
					input.to === "faulted" &&
					(materialization.fault_kind !== input.faultKind || materialization.recoverable !== input.recoverable)
				) {
					throw new AgentSessionChildRunFault(
						"materialization_conflict",
						"recovered materialization replay changed fault testimony",
					);
				}
				const replayRun = await tx.execute({
					sql: "SELECT * FROM agent_session_child_runs WHERE child_session_id = ?",
					args: [sessionId],
				});
				await finalizeStandaloneSimpleSessionIfReadyTx(tx, sessionId, generation, input.now);
				await finalizeTerminalResidentChildFaultIfReadyTx(tx, sessionId, generation, input.now);
				await finalizeStandalonePrimeFaultIfReadyTx(tx, sessionId, generation, input.now);
				await finalizeStandaloneCascadeCancellationIfReadyTx(tx, sessionId, generation, input.now);
				return {
					materialization,
					childRun: replayRun.rows[0] ? rowToAgentSessionChildRun(replayRun.rows[0]) : null,
				};
			}
			if (!materialization || !["claimed", "running", "quiescing", "quiescent"].includes(materialization.state)) {
				throw new AgentSessionChildRunFault("materialization_conflict", "recovery target is no longer nonterminal");
			}
			await assertActiveMaterializationRecoveryLeaseTx(tx, sessionId, generation, input);
			await assertHostedChildMaterializationOutcomeTx(tx, sessionId, generation, input.to);
			const updated = await tx.execute({
				sql: `UPDATE agent_materializations
				         SET state = ?, fault_kind = ?, recoverable = ?, updated_at = ?
				       WHERE session_id = ? AND generation = ? AND state IN ('claimed', 'running', 'quiescing', 'quiescent')
				         AND EXISTS (
				           SELECT 1 FROM agent_materialization_supervision AS supervision
				            WHERE supervision.session_id = agent_materializations.session_id
				              AND supervision.generation = agent_materializations.generation
				              AND supervision.recovery_consumer = ?
				              AND supervision.recovery_token = ?
				              AND supervision.recovery_expires_at > ?
				         )`,
				args: [
					input.to,
					input.to === "faulted" ? input.faultKind : null,
					input.to === "faulted" ? (input.recoverable ? 1 : 0) : null,
					input.now,
					sessionId,
					generation,
					input.consumer,
					input.recoveryToken,
					input.now,
				],
			});
			if (updated.rowsAffected !== 1) {
				throw new AgentSessionChildRunFault(
					"lease_lost",
					"materialization recovery lost its terminalization fence",
				);
			}
			await upsertAgentSessionBodyStateTx(tx, {
				sessionId,
				generation,
				role: "worker",
				state: input.to,
				now: input.now,
			});
			await releaseAgentSessionChildGenerationOccupancyTx(tx, sessionId, generation, input.now);
			if (input.to === "faulted") {
				await appendAgentSessionEventTx(tx, sessionId, {
					type: "runtime.fault",
					ts: input.now,
					payload: {
						generation,
						from: materialization.state,
						to: "faulted",
						faultKind: input.faultKind,
						recoverable: input.recoverable,
						recovered: true,
					},
				});
				if (!input.recoverable && !(await hasHostedSimpleLogicalOutcomeTx(tx, sessionId))) {
					await ensureAgentSessionDescendantCascadeTx(tx, sessionId, {
						cause: "irrecoverable_fault",
						causeDigest: digestJson({
							schema: "choreograph.agent-materialization-fault.v1",
							sessionId,
							generation,
							faultKind: input.faultKind,
							recoverable: false,
						}),
						reason: `irrecoverable materialization fault: ${input.faultKind}`,
						now: input.now,
					});
				}
			}
			const childRunResult = await tx.execute({
				sql: "SELECT * FROM agent_session_child_runs WHERE child_session_id = ?",
				args: [sessionId],
			});
			const childRun = childRunResult.rows[0] ? rowToAgentSessionChildRun(childRunResult.rows[0]) : null;
			if (!childRun || isTerminalAgentSessionChildRunState(childRun.state)) {
				if (input.to === "faulted" && input.recoverable) {
					await reopenRecoverableAgentSessionTx(tx, sessionId, input.now);
				}
				await finalizeStandaloneSimpleSessionIfReadyTx(tx, sessionId, generation, input.now);
				await finalizeTerminalResidentChildFaultIfReadyTx(tx, sessionId, generation, input.now);
				await finalizeStandalonePrimeFaultIfReadyTx(tx, sessionId, generation, input.now);
				await finalizeStandaloneCascadeCancellationIfReadyTx(tx, sessionId, generation, input.now);
			}
			return {
				materialization: (await readAgentMaterializationTx(tx, sessionId, generation))!,
				childRun,
			};
		}, "CAS");
	}

	async settleRecoveredAgentSessionChildRun(
		childRunId: string,
		input: {
			readonly sessionId: string;
			readonly generation: number;
			readonly consumer: string;
			readonly recoveryToken: string;
			readonly status: "completed" | "failed" | "cancelled";
			readonly result?: unknown;
			readonly error?: string;
			readonly now: number;
		},
	): Promise<{
		run: AgentSessionChildRunRecord;
		allocation: AgentSessionChildBudgetAllocationRecord;
		applied: boolean;
	}> {
		validateChildRunTimestamp(input.now, "recovered child settlement time");
		return this.tx(async (tx) => {
			await assertMaterializationRecoveryLeaseIdentityTx(tx, input.sessionId, input.generation, input);
			const run = await requireAgentSessionChildRunTx(tx, childRunId);
			if (run.child_session_id !== input.sessionId || run.materialization_generation !== input.generation) {
				throw new AgentSessionChildRunFault(
					"materialization_conflict",
					"recovery lease does not own this child run",
				);
			}
			const materialization = await readAgentMaterializationTx(tx, input.sessionId, input.generation);
			if (!materialization || !["completed", "faulted", "cancelled"].includes(materialization.state)) {
				throw new AgentSessionChildRunFault("materialization_conflict", "recovered child body is not terminal");
			}
			if (materialization.updated_at > input.now || run.heartbeat_at === null || run.heartbeat_at > input.now) {
				throw new AgentSessionChildRunFault(
					"lease_lost",
					"recovered settlement predates durable run/body testimony",
				);
			}
			if (
				(input.status === "cancelled" && !["cancelled", "faulted"].includes(materialization.state)) ||
				(input.status !== "cancelled" && materialization.state === "cancelled")
			) {
				throw new AgentSessionChildRunFault(
					"materialization_conflict",
					"recovered child logical outcome conflicts with cancellation body truth",
				);
			}
			const outcomeResult = await tx.execute({
				sql: `SELECT status, result_json FROM agent_session_run_outcomes
				      WHERE session_id = ? AND outcome_id = ?`,
				args: [input.sessionId, childRunId],
			});
			const durableOutcome = outcomeResult.rows[0];
			if (durableOutcome && String(durableOutcome.status) !== input.status) {
				throw new AgentSessionChildRunFault(
					"terminal_conflict",
					"recovered child settlement diverges from immutable logical outcome testimony",
				);
			}
			if (
				(input.status === "completed" || (input.status === "failed" && materialization.state === "completed")) &&
				!durableOutcome
			) {
				throw new AgentSessionChildRunFault(
					"terminal_conflict",
					"healthy recovered child outcome requires immutable logical outcome testimony",
				);
			}
			const durableResult = durableOutcome ? JSON.parse(String(durableOutcome.result_json)) : undefined;
			if (!durableOutcome && input.result !== undefined) {
				throw new AgentSessionChildRunFault(
					"terminal_conflict",
					"body-derived recovered failure/cancellation cannot invent a result payload",
				);
			}
			if (
				durableOutcome &&
				input.result !== undefined &&
				canonicalJson(input.result) !== canonicalJson(durableResult)
			) {
				throw new AgentSessionChildRunFault(
					"terminal_conflict",
					"recovered child result diverges from immutable logical outcome testimony",
				);
			}
			const result = durableOutcome ? durableResult : (input.result ?? null);
			let canonicalError: string | null = null;
			if (input.status === "cancelled") {
				const cancellation = await tx.execute({
					sql: `SELECT reason FROM agent_session_child_cancellation_requests
					      WHERE child_run_id = ? AND disposition = 'cancellation_pending'
					      ORDER BY created_at ASC, request_id ASC LIMIT 1`,
					args: [childRunId],
				});
				if (!cancellation.rows[0]) {
					throw new AgentSessionChildRunFault(
						"cancellation_conflict",
						"recovered cancellation lacks immutable intent",
					);
				}
				canonicalError = String(cancellation.rows[0].reason);
			} else if (input.status === "failed") {
				canonicalError = durableOutcome
					? "child execution failed"
					: `materialization fault: ${String(materialization.fault_kind)}`;
			}
			if (input.error !== undefined && input.error !== canonicalError) {
				throw new AgentSessionChildRunFault(
					"terminal_conflict",
					"recovered child terminal error diverges from durable authority testimony",
				);
			}
			const error = canonicalError;
			await requireReleasedChildRunOccupancyTx(tx, run, materialization);
			const admission = await requireChildAdmissionForRunTx(tx, run);
			const child = await requireChildSessionForRunTx(tx, run);
			const runtimeKind = childRuntimeKindFromDocument(
				child.document_json,
				child.session_id,
				admission.runtime_binding_digest,
			);
			const irrecoverableFault = materialization.state === "faulted" && materialization.recoverable === false;
			const sessionCorruptionFault =
				irrecoverableFault && agentMaterializationFaultRequiresSessionFault(materialization.fault_kind);
			const closesSession = runtimeKind === "simple" || input.status === "cancelled" || irrecoverableFault;
			if (closesSession) await requireClosedAgentSessionDescendantsTx(tx, child.session_id);
			let allocation = await requireChildAllocationForRunTx(tx, childRunId);
			const terminalPolicy = closesSession ? "close" : "keep_open";
			const terminalDigest = digestChildRunTerminal({
				childRunId,
				status: input.status,
				terminalPolicy,
				materializationGeneration: input.generation,
				materializationState: materialization.state,
				result,
				error,
			});
			if (isTerminalAgentSessionChildRunState(run.state)) {
				if (run.terminal_digest !== terminalDigest) {
					throw new AgentSessionChildRunFault(
						"terminal_conflict",
						"recovered child run was replayed with different terminal testimony",
					);
				}
				return { run, allocation, applied: false };
			}
			if (run.claim_expires_at === null || run.claim_expires_at > input.now) {
				throw new AgentSessionChildRunFault("lease_lost", "live executor still owns the child run");
			}
			await assertActiveMaterializationRecoveryLeaseTx(tx, input.sessionId, input.generation, input);
			if (
				(input.status === "cancelled" && run.state !== "cancelling") ||
				(input.status !== "cancelled" && run.state !== "claimed")
			) {
				throw new AgentSessionChildRunFault(
					"terminal_conflict",
					"recovered child outcome conflicts with its run state",
				);
			}
			const updated = await tx.execute({
				sql: `UPDATE agent_session_child_runs
				         SET state = ?, result_json = ?, error = ?, terminal_digest = ?, terminal_at = ?
				       WHERE child_run_id = ? AND state = ? AND claim_expires_at <= ?`,
				args: [
					input.status,
					result === null ? null : JSON.stringify(result),
					error,
					terminalDigest,
					input.now,
					childRunId,
					run.state,
					input.now,
				],
			});
			if (updated.rowsAffected !== 1) {
				const raced = await requireAgentSessionChildRunTx(tx, childRunId);
				if (isTerminalAgentSessionChildRunState(raced.state) && raced.terminal_digest === terminalDigest) {
					return {
						run: raced,
						allocation: await requireChildAllocationForRunTx(tx, childRunId),
						applied: false,
					};
				}
				throw new AgentSessionChildRunFault(
					isTerminalAgentSessionChildRunState(raced.state) ? "terminal_conflict" : "lease_lost",
					"recovered child settlement lost its terminalization fence",
				);
			}
			if (closesSession) allocation = await closeExecutedChildAllocationTx(tx, admission, allocation, input.now);
			if (closesSession) {
				const lifecycleState = sessionCorruptionFault ? "faulted" : "closed";
				await terminalizeAgentSessionLifecycleTx(
					tx,
					child.session_id,
					lifecycleState,
					`recovery:${childRunId}`,
					input.now,
				);
				await appendAgentSessionEventTx(tx, child.session_id, {
					type: lifecycleState === "faulted" ? "session.faulted" : "session.closed",
					ts: input.now,
					payload: {
						schema: "choreograph.agent-session-lifecycle.v1",
						sessionId: child.session_id,
						state: lifecycleState,
						childRunId,
						recovered: true,
					},
				});
			} else {
				await reopenRecoverableAgentSessionTx(tx, child.session_id, input.now);
			}
			await tx.execute({
				sql: `UPDATE agent_sessions
				         SET status = ?, completed_at = CASE WHEN ? THEN COALESCE(completed_at, ?) ELSE completed_at END,
				             updated_at = ?
				       WHERE session_id = ?`,
				args: [input.status, closesSession ? 1 : 0, input.now, input.now, child.session_id],
			});
			await appendAgentSessionEventTx(tx, run.parent_session_id, {
				type: `child.run.${input.status}`,
				ts: input.now,
				payload: agentSessionChildRunResultPayload({
					run,
					admission,
					allocation,
					status: input.status,
					terminalPolicy,
					materialization: { generation: input.generation, state: materialization.state },
					result,
					error,
					recovered: true,
				}),
			});
			await advanceAgentSessionCascadesContainingMemberTx(tx, child.session_id, input.now);
			await completeAgentMaterializationRecoveryTx(tx, input.sessionId, input.generation, input.now);
			return {
				run: await requireAgentSessionChildRunTx(tx, childRunId),
				allocation,
				applied: true,
			};
		}, "CAS");
	}

	/** Reserve the generation's exact kernel sandbox identity before OS process preparation. */
	async beginAgentSessionKernelLaunch(
		sessionId: string,
		generation: number,
		input: { readonly activationId: string; readonly sandboxId: string; readonly now: number },
	): Promise<void> {
		validateChildRunTimestamp(input.now, "kernel launch intent time");
		const sandboxId = requiredChildRunText(input.sandboxId, "kernel launch sandbox id", 256);
		await this.tx(async (tx) => {
			await assertLiveLatestMaterializationActivationTx(tx, sessionId, generation, input.activationId);
			await assertPersistentKernelSessionTx(tx, sessionId);
			const launch = await tx.execute({
				sql: "SELECT * FROM agent_session_kernel_launches WHERE session_id = ? AND generation = ?",
				args: [sessionId, generation],
			});
			if (!launch.rows[0]) {
				throw new AgentSessionGenerationFault("Kernel launch intent requires a bound Prime worker body");
			}
			const state = String(launch.rows[0].state);
			const existingSandboxId = nullableString(launch.rows[0].sandbox_id);
			const updatedAt = Number(launch.rows[0].updated_at);
			if (updatedAt > input.now) {
				throw new AgentSessionGenerationFault("Kernel launch intent time predates durable attempt testimony");
			}
			if (state === "launching" && existingSandboxId === sandboxId) return;
			if (state !== "not_requested" && state !== "failed_unbound") {
				throw new AgentSessionGenerationFault("Kernel generation already owns a launch attempt");
			}
			const updated = await tx.execute({
				sql: `UPDATE agent_session_kernel_launches
				         SET state = 'launching', sandbox_id = ?, attempt = attempt + 1,
				             body_observed_at = NULL, terminal_at = NULL, updated_at = ?
				       WHERE session_id = ? AND generation = ? AND activation_id = ?
				         AND state IN ('not_requested', 'failed_unbound') AND updated_at <= ?`,
				args: [sandboxId, input.now, sessionId, generation, input.activationId, input.now],
			});
			if (updated.rowsAffected !== 1) {
				throw new AgentSessionGenerationFault("Kernel launch intent lost its exact generation CAS");
			}
		}, "CAS");
	}

	/** Bind observed kernel process existence and running body testimony atomically. */
	async bindAgentSessionKernelLaunch(
		sessionId: string,
		generation: number,
		input: { readonly activationId: string; readonly sandboxId: string; readonly now: number },
	): Promise<AgentSessionBodyStateRecord> {
		validateChildRunTimestamp(input.now, "kernel process bind time");
		const sandboxId = requiredChildRunText(input.sandboxId, "kernel launch sandbox id", 256);
		return this.tx(async (tx) => {
			await assertLiveLatestMaterializationActivationTx(tx, sessionId, generation, input.activationId);
			await assertPersistentKernelSessionTx(tx, sessionId);
			const existingBody = await tx.execute({
				sql: "SELECT * FROM agent_session_body_states WHERE session_id = ? AND generation = ? AND role = 'kernel'",
				args: [sessionId, generation],
			});
			const launch = await tx.execute({
				sql: "SELECT state, sandbox_id, updated_at FROM agent_session_kernel_launches WHERE session_id = ? AND generation = ? AND activation_id = ?",
				args: [sessionId, generation, input.activationId],
			});
			if (launch.rows[0] && Number(launch.rows[0].updated_at) > input.now) {
				throw new AgentSessionGenerationFault("Kernel process bind time predates its durable launch intent");
			}
			if (
				String(launch.rows[0]?.state ?? "") === "bound" &&
				nullableString(launch.rows[0]?.sandbox_id) === sandboxId &&
				existingBody.rows[0] &&
				String(existingBody.rows[0].state) === "running"
			) {
				return rowToAgentSessionBodyState(existingBody.rows[0]);
			}
			const bound = await tx.execute({
				sql: `UPDATE agent_session_kernel_launches
				         SET state = 'bound', body_observed_at = ?, updated_at = ?
				       WHERE session_id = ? AND generation = ? AND activation_id = ?
				         AND state = 'launching' AND sandbox_id = ? AND updated_at <= ?`,
				args: [input.now, input.now, sessionId, generation, input.activationId, sandboxId, input.now],
			});
			if (bound.rowsAffected !== 1) {
				throw new AgentSessionGenerationFault("Kernel process bind lost its durable launch intent");
			}
			return upsertAgentSessionBodyStateTx(tx, {
				sessionId,
				generation,
				role: "kernel",
				state: "running",
				now: input.now,
			});
		}, "CAS");
	}

	/** Close an exact launch intent after verified failure before the OS spawn event. */
	async failUnboundAgentSessionKernelLaunch(
		sessionId: string,
		generation: number,
		input: { readonly activationId: string; readonly sandboxId: string; readonly now: number },
	): Promise<boolean> {
		validateChildRunTimestamp(input.now, "unbound kernel launch failure time");
		const sandboxId = requiredChildRunText(input.sandboxId, "kernel launch sandbox id", 256);
		return this.tx(async (tx) => {
			const materialization = await readAgentMaterializationTx(tx, sessionId, generation);
			if (!materialization || materialization.activation_id !== input.activationId) {
				throw new AgentSessionGenerationFault("Unbound kernel launch failure lost its materialization activation");
			}
			const bodies = await tx.execute({
				sql: "SELECT 1 AS found FROM agent_session_body_states WHERE session_id = ? AND generation = ? AND role = 'kernel'",
				args: [sessionId, generation],
			});
			if (bodies.rows[0]) {
				throw new AgentSessionGenerationFault("Unbound kernel launch failure cannot erase observed body testimony");
			}
			const launch = await tx.execute({
				sql: "SELECT state, sandbox_id, updated_at FROM agent_session_kernel_launches WHERE session_id = ? AND generation = ?",
				args: [sessionId, generation],
			});
			if (!launch.rows[0]) return false;
			if (Number(launch.rows[0].updated_at) > input.now) {
				throw new AgentSessionGenerationFault("Unbound kernel failure time predates its durable launch intent");
			}
			if (
				String(launch.rows[0].state) === "failed_unbound" &&
				nullableString(launch.rows[0].sandbox_id) === sandboxId
			)
				return false;
			const failed = await tx.execute({
				sql: `UPDATE agent_session_kernel_launches
				         SET state = 'failed_unbound', terminal_at = ?, updated_at = ?
				       WHERE session_id = ? AND generation = ? AND activation_id = ?
				         AND state = 'launching' AND sandbox_id = ? AND updated_at <= ?`,
				args: [input.now, input.now, sessionId, generation, input.activationId, sandboxId, input.now],
			});
			if (failed.rowsAffected !== 1) {
				throw new AgentSessionGenerationFault("Unbound kernel launch failure lost its exact launch intent");
			}
			return true;
		}, "CAS");
	}

	/** Record host testimony for the kernel body paired with an admitted materialization. */
	async recordAgentSessionKernelState(
		sessionId: string,
		generation: number,
		input: {
			readonly activationId: string;
			readonly state: AgentSessionKernelState;
			readonly now: number;
		},
	): Promise<AgentSessionBodyStateRecord> {
		if (!Number.isSafeInteger(generation) || generation < 0) {
			throw new AgentSessionGenerationFault("Kernel generation must be a non-negative integer");
		}
		if (!Number.isSafeInteger(input.now) || input.now < 0) {
			throw new AgentSessionGenerationFault("Kernel body testimony time must be a non-negative integer");
		}
		if (!isAgentSessionKernelState(input.state)) {
			throw new AgentSessionGenerationFault("Kernel body state is not supported");
		}
		return this.tx(async (tx) => {
			// A retained kernel may be reattached only while its exact materialization
			// remains live. Cleanup testimony, in contrast, must remain possible after
			// passivation so a verified body reap can still be recorded durably.
			if (input.state === "running") {
				await assertLiveLatestMaterializationActivationTx(tx, sessionId, generation, input.activationId);
			} else {
				await assertLatestMaterializationActivationTx(tx, sessionId, generation, input.activationId);
			}
			await assertPersistentKernelSessionTx(tx, sessionId);
			const materialization = await tx.execute({
				sql: "SELECT 1 AS found FROM agent_materializations WHERE session_id = ? AND generation = ?",
				args: [sessionId, generation],
			});
			if (!materialization.rows[0]) {
				throw new AgentSessionGenerationFault("Kernel body testimony requires an admitted materialization");
			}
			await requireBoundKernelBodyTx(tx, sessionId, generation, input.activationId);
			const body = await upsertAgentSessionBodyStateTx(tx, {
				sessionId,
				generation,
				role: "kernel",
				state: input.state,
				now: input.now,
			});
			await finalizeTerminalResidentChildFaultIfReadyTx(tx, sessionId, generation, input.now);
			await finalizeStandalonePrimeFaultIfReadyTx(tx, sessionId, generation, input.now);
			await finalizeStandaloneCascadeCancellationIfReadyTx(tx, sessionId, generation, input.now);
			return body;
		}, "UPSERT");
	}

	async recordRecoveredAgentSessionKernelState(
		sessionId: string,
		generation: number,
		input: {
			readonly consumer: string;
			readonly recoveryToken: string;
			readonly state: Exclude<AgentSessionKernelState, "running">;
			readonly now: number;
		},
	): Promise<AgentSessionBodyStateRecord> {
		validateChildRunTimestamp(input.now, "recovered kernel testimony time");
		if (!isAgentSessionKernelState(input.state) || input.state === "running") {
			throw new AgentSessionGenerationFault("Recovered kernel testimony must be terminal");
		}
		return this.tx(async (tx) => {
			await assertActiveMaterializationRecoveryLeaseTx(tx, sessionId, generation, input);
			await assertPersistentKernelSessionTx(tx, sessionId);
			const materialization = await readAgentMaterializationTx(tx, sessionId, generation);
			if (!materialization)
				throw new AgentSessionGenerationFault("Recovered kernel testimony lost its materialization");
			await requireBoundKernelBodyTx(tx, sessionId, generation, materialization.activation_id);
			const body = await upsertAgentSessionBodyStateTx(tx, {
				sessionId,
				generation,
				role: "kernel",
				state: input.state,
				now: input.now,
			});
			await finalizeTerminalResidentChildFaultIfReadyTx(tx, sessionId, generation, input.now);
			await finalizeStandalonePrimeFaultIfReadyTx(tx, sessionId, generation, input.now);
			await finalizeStandaloneCascadeCancellationIfReadyTx(tx, sessionId, generation, input.now);
			return body;
		}, "CAS");
	}

	async transitionAgentMaterialization(
		sessionId: string,
		generation: number,
		input: AgentMaterializationTransitionInput,
	): Promise<AgentMaterializationRecord> {
		return this.tx(async (tx) => {
			await assertActiveMaterializationActivationTx(tx, sessionId, generation, input.activationId);
			const currentResult = await tx.execute({
				sql: "SELECT * FROM agent_materializations WHERE session_id = ? AND generation = ?",
				args: [sessionId, generation],
			});
			if (!currentResult.rows[0]) throw new AgentSessionGenerationFault("Materialization does not exist");
			const current = rowToAgentMaterialization(currentResult.rows[0]);
			if (current.state === input.to) {
				if (
					input.to === "faulted" &&
					(current.fault_kind !== input.faultKind || current.recoverable !== input.recoverable)
				) {
					throw new AgentSessionGenerationFault("Materialization fault replay changed its testimony");
				}
				return current;
			}
			if (current.state !== input.from) {
				throw new AgentSessionGenerationFault(
					`Materialization transition expected ${input.from}, found ${current.state}`,
				);
			}
			if (["passivated", "completed", "faulted", "cancelled"].includes(input.to)) {
				await assertHostedChildMaterializationOutcomeTx(tx, sessionId, generation, input.to);
			}
			if (input.to === "passivated" && !current.checkpoint_id) {
				throw new AgentSessionGenerationFault("Passivation requires committed memory");
			}
			await tx.execute({
				sql: `UPDATE agent_materializations
				      SET state = ?, fault_kind = ?, recoverable = ?, updated_at = ?, passivated_at = ?
					WHERE session_id = ? AND generation = ? AND state = ?`,
				args: [
					input.to,
					input.to === "faulted" ? input.faultKind : null,
					input.to === "faulted" ? (input.recoverable ? 1 : 0) : null,
					input.now,
					input.to === "passivated" ? input.now : null,
					sessionId,
					generation,
					input.from,
				],
			});
			await upsertAgentSessionBodyStateTx(tx, {
				sessionId,
				generation,
				role: "worker",
				state: input.to,
				now: input.now,
			});
			if (["passivated", "completed", "faulted", "cancelled"].includes(input.to)) {
				await releaseAgentSessionChildGenerationOccupancyTx(tx, sessionId, generation, input.now);
			}
			if (input.to === "faulted" && !input.recoverable) {
				await ensureAgentSessionDescendantCascadeTx(tx, sessionId, {
					cause: "irrecoverable_fault",
					causeDigest: digestJson({
						schema: "choreograph.agent-materialization-fault.v1",
						sessionId,
						generation,
						faultKind: input.faultKind,
						recoverable: false,
					}),
					reason: `irrecoverable materialization fault: ${input.faultKind}`,
					now: input.now,
				});
			}
			const session = await readAgentSessionTx(tx, sessionId);
			if (session) {
				const base = agentSessionDocumentFromJson(session.document_json);
				const document = {
					...base,
					runtime: {
						...asRecord(base.runtime),
						materializationState: input.to,
						sandboxGeneration: generation,
						...(input.to === "passivated" ? { sandboxId: null } : {}),
					},
				};
				const documentOp = await appendAgentSessionDocumentOpTx(tx, sessionId, {
					ts: input.now,
					actor: "choreograph.agent-memory",
					kind: agentMaterializationTransitionEventType(input.to) ?? "runtime.materialization.finished",
					patch: { op: "runtime.materialization.transition", generation, from: input.from, to: input.to },
					document,
				});
				const cancelling = input.to === "cancelled" && (await hasCancellingChildRunTx(tx, sessionId));
				await tx.execute({
					sql: `UPDATE agent_sessions
					         SET lifecycle_state = CASE WHEN ? THEN 'closing' ELSE lifecycle_state END,
					             document_json = ?, updated_at = ?
					       WHERE session_id = ?`,
					args: [cancelling ? 1 : 0, JSON.stringify(documentOp.document), input.now, sessionId],
				});
				const eventType = agentMaterializationTransitionEventType(input.to);
				if (eventType) {
					await appendAgentSessionEventTx(tx, sessionId, {
						type: eventType,
						ts: input.now,
						payload: {
							generation,
							from: input.from,
							to: input.to,
							...(input.to === "faulted" ? { faultKind: input.faultKind, recoverable: input.recoverable } : {}),
						},
					});
				}
			}
			const updated = await tx.execute({
				sql: "SELECT * FROM agent_materializations WHERE session_id = ? AND generation = ?",
				args: [sessionId, generation],
			});
			return rowToAgentMaterialization(updated.rows[0]!);
		}, "CAS");
	}

	/**
	 * Record that an ephemeral materialization has actually left the host.
	 * Session completion/failure is testified separately; this CAS deliberately
	 * emits no invented runtime event and never borrows resident passivation
	 * states for a one-shot simple body.
	 */
	async finishAgentMaterialization(
		sessionId: string,
		generation: number,
		input:
			| {
					readonly activationId: string;
					readonly from: "claimed" | "running";
					readonly to: "faulted";
					readonly faultKind: AgentMaterializationFaultKind;
					readonly recoverable: boolean;
					readonly now: number;
			  }
			| {
					readonly activationId: string;
					readonly from: "claimed" | "running";
					readonly to: "completed" | "cancelled";
					readonly now: number;
			  },
	): Promise<AgentMaterializationRecord> {
		return this.tx(async (tx) => {
			await assertActiveMaterializationActivationTx(tx, sessionId, generation, input.activationId);
			const currentResult = await tx.execute({
				sql: "SELECT * FROM agent_materializations WHERE session_id = ? AND generation = ?",
				args: [sessionId, generation],
			});
			if (!currentResult.rows[0]) throw new AgentSessionGenerationFault("Materialization does not exist");
			const current = rowToAgentMaterialization(currentResult.rows[0]);
			if (current.state === input.to) {
				if (
					input.to === "faulted" &&
					(current.fault_kind !== input.faultKind || current.recoverable !== input.recoverable)
				) {
					throw new AgentSessionGenerationFault("Materialization fault replay changed its testimony");
				}
				await upsertAgentSessionBodyStateTx(tx, {
					sessionId,
					generation,
					role: "worker",
					state: input.to,
					now: input.now,
				});
				await releaseAgentSessionChildGenerationOccupancyTx(tx, sessionId, generation, input.now);
				return current;
			}
			if (current.state !== input.from) {
				throw new AgentSessionGenerationFault(
					`Materialization finish expected ${input.from}, found ${current.state}`,
				);
			}
			await assertHostedChildMaterializationOutcomeTx(tx, sessionId, generation, input.to);
			await tx.execute({
				sql: `UPDATE agent_materializations
				      SET state = ?, fault_kind = ?, recoverable = ?, updated_at = ?
				      WHERE session_id = ? AND generation = ? AND state = ?`,
				args: [
					input.to,
					input.to === "faulted" ? input.faultKind : null,
					input.to === "faulted" ? (input.recoverable ? 1 : 0) : null,
					input.now,
					sessionId,
					generation,
					input.from,
				],
			});
			await upsertAgentSessionBodyStateTx(tx, {
				sessionId,
				generation,
				role: "worker",
				state: input.to,
				now: input.now,
			});
			await releaseAgentSessionChildGenerationOccupancyTx(tx, sessionId, generation, input.now);
			if (input.to === "faulted") {
				await appendAgentSessionEventTx(tx, sessionId, {
					type: "runtime.fault",
					ts: input.now,
					payload: {
						generation,
						from: input.from,
						to: input.to,
						faultKind: input.faultKind,
						recoverable: input.recoverable,
					},
				});
				if (!input.recoverable && !(await hasHostedSimpleLogicalOutcomeTx(tx, sessionId))) {
					await ensureAgentSessionDescendantCascadeTx(tx, sessionId, {
						cause: "irrecoverable_fault",
						causeDigest: digestJson({
							schema: "choreograph.agent-materialization-fault.v1",
							sessionId,
							generation,
							faultKind: input.faultKind,
							recoverable: false,
						}),
						reason: `irrecoverable materialization fault: ${input.faultKind}`,
						now: input.now,
					});
				}
				if (input.recoverable) {
					await reopenRecoverableAgentSessionTx(tx, sessionId, input.now);
				}
			}
			const cancelling = input.to === "cancelled" && (await hasCancellingChildRunTx(tx, sessionId));
			if (cancelling) {
				await tx.execute({
					sql: "UPDATE agent_sessions SET lifecycle_state = 'closing', updated_at = ? WHERE session_id = ?",
					args: [input.now, sessionId],
				});
			}
			await finalizeStandaloneSimpleSessionIfReadyTx(tx, sessionId, generation, input.now);
			await finalizeTerminalResidentChildFaultIfReadyTx(tx, sessionId, generation, input.now);
			await finalizeStandalonePrimeFaultIfReadyTx(tx, sessionId, generation, input.now);
			await finalizeStandaloneCascadeCancellationIfReadyTx(tx, sessionId, generation, input.now);
			const updated = await tx.execute({
				sql: "SELECT * FROM agent_materializations WHERE session_id = ? AND generation = ?",
				args: [sessionId, generation],
			});
			return rowToAgentMaterialization(updated.rows[0]!);
		}, "CAS");
	}

	async finishAgentSession(
		sessionId: string,
		input: {
			result: AgentNodeResult;
			status: "completed" | "failed" | "cancelled";
			generation: number;
			activationId: string;
			childRunConsumer?: string;
			childRunClaimToken?: string;
			now: number;
			frontier: WorkflowFrontier;
		},
	): Promise<void> {
		await this.tx(async (tx) => {
			const existing = await readAgentSessionTx(tx, sessionId);
			if (!existing) return;
			const hostedRun = await tx.execute({
				sql: "SELECT child_run_id FROM agent_session_child_runs WHERE child_session_id = ?",
				args: [sessionId],
			});
			const outcomeId = hostedRun.rows[0]
				? String(hostedRun.rows[0].child_run_id)
				: requiredChildRunText(
						input.result.invocationId ?? input.result.sessionId ?? input.result.label,
						"Agent Session outcome identity",
						256,
					);
			if (hostedRun.rows[0] && input.result.invocationId !== outcomeId) {
				throw new AgentSessionChildRunFault(
					"terminal_conflict",
					"hosted child logical outcome must bind its immutable child run id",
				);
			}
			const outcomeDigest = digestJson({
				schema: "choreograph.agent-session-outcome.v1",
				sessionId,
				outcomeId,
				status: input.status,
				result: input.result,
				frontier: input.frontier,
			});
			const priorOutcome = await tx.execute({
				sql: "SELECT outcome_digest, status FROM agent_session_run_outcomes WHERE session_id = ? AND outcome_id = ?",
				args: [sessionId, outcomeId],
			});
			if (priorOutcome.rows[0]) {
				if (String(priorOutcome.rows[0].outcome_digest) !== outcomeDigest) {
					// Hosted child runs are lease-fenced (consumer + claim token +
					// materialization generation), so a conflicting re-testimony there
					// means a real invariant breach: refuse it.
					if (hostedRun.rows[0]) {
						throw new AgentSessionChildAdmissionFault(
							"request_conflict",
							`Agent Session ${sessionId} outcome ${outcomeId} was replayed with different testimony`,
						);
					}
					// Standalone sessions have no lease fence, so duplicate activations
					// (e.g. a recovery pass racing the original) can legitimately
					// re-finish the same logical outcome slot with drifted timing or
					// frontier fields. Outcomes are immutable: the FIRST committed
					// testimony stands; a healthy body's death is never retroactively
					// failed by a late duplicate. Log and no-op.
					console.warn(
						`[workflow] Agent Session ${sessionId} outcome ${outcomeId} re-testified with different testimony ` +
							`(stored status=${String(priorOutcome.rows[0].status)}, incoming status=${input.status}); ` +
							`first testimony stands`,
					);
					return;
				}
				return;
			}
			await assertActiveMaterializationActivationTx(tx, sessionId, input.generation, input.activationId);
			const outcomeMaterialization = await readAgentMaterializationTx(tx, sessionId, input.generation);
			if (!outcomeMaterialization || !["running", "quiescing", "quiescent"].includes(outcomeMaterialization.state)) {
				throw new AgentSessionChildRunFault(
					"materialization_conflict",
					"new logical outcome testimony requires the exact live materialization",
				);
			}
			if (existing.lifecycle_state !== "open") {
				throw new AgentSessionChildRunFault(
					"terminal_conflict",
					"new logical outcome testimony requires an open Session",
				);
			}
			if (hostedRun.rows[0]) {
				const run = await requireAgentSessionChildRunTx(tx, outcomeId);
				const expectedState = input.status === "cancelled" ? "cancelling" : "claimed";
				if (
					run.state !== expectedState ||
					run.consumer !== input.childRunConsumer ||
					run.claim_token !== input.childRunClaimToken ||
					run.claim_expires_at === null ||
					run.claim_expires_at <= input.now ||
					(run.heartbeat_at ?? Number.MAX_SAFE_INTEGER) > input.now ||
					run.materialization_generation !== input.generation
				) {
					throw new AgentSessionChildRunFault(
						"lease_lost",
						"hosted child logical outcome lost its exact run and materialization fence",
					);
				}
			}
			const runtimeKind = readAgentSessionSemanticBinding(existing).runtime.kind;
			const document = updateAgentSessionDocument(existing.document_json, input.result, input.frontier, {
				sessionId,
				generation: input.generation,
				now: input.now,
			});
			const documentOp = await appendAgentSessionDocumentOpTx(tx, sessionId, {
				ts: input.now,
				actor: "choreograph.agent-worker",
				kind: `session.outcome.${input.status}`,
				patch: {
					op: "transcript.result.append",
					frontier: input.frontier,
					resultEventId: `result:${input.result.invocationId ?? input.result.sessionId ?? input.result.label}`,
					status: input.status,
				},
				document,
			});
			await tx.execute({
				sql: `INSERT INTO agent_session_run_outcomes
				        (session_id, outcome_id, outcome_digest, status, result_json, frontier_json, created_at)
				      VALUES (?, ?, ?, ?, ?, ?, ?)`,
				args: [
					sessionId,
					outcomeId,
					outcomeDigest,
					input.status,
					JSON.stringify(input.result),
					JSON.stringify(input.frontier),
					input.now,
				],
			});
			if (runtimeKind === "simple" && existing.lifecycle_state === "open") {
				await tx.execute({
					sql: "UPDATE agent_sessions SET lifecycle_state = 'closing', updated_at = ? WHERE session_id = ? AND lifecycle_state = 'open'",
					args: [input.now, sessionId],
				});
			}
			await tx.execute({
				sql: `
					UPDATE agent_sessions
					   SET status = ?,
					       result_json = ?,
						   document_json = ?,
						   frontier_json = ?,
						   updated_at = ?,
						   completed_at = ?
					 WHERE session_id = ?
				`,
				args: [
					input.status,
					JSON.stringify(input.result),
					JSON.stringify(documentOp.document),
					JSON.stringify(input.frontier),
					input.now,
					input.now,
					sessionId,
				],
			});
			const latestMaterialization = await tx.execute({
				sql: "SELECT generation FROM agent_materializations WHERE session_id = ? ORDER BY generation DESC LIMIT 1",
				args: [sessionId],
			});
			if (latestMaterialization.rows[0]) {
				await finalizeStandaloneSimpleSessionIfReadyTx(
					tx,
					sessionId,
					Number(latestMaterialization.rows[0].generation),
					input.now,
				);
			}
		}, "UPSERT");
	}

	async readAgentSession(sessionId: string): Promise<AgentSessionRecord | null> {
		const result = await this.read({ sql: "SELECT * FROM agent_sessions WHERE session_id = ?", args: [sessionId] });
		const row = result.rows[0];
		return row ? rowToAgentSession(row) : null;
	}

	async readAgentSessionByNodeKey(runId: string, nodeKey: string): Promise<AgentSessionRecord | null> {
		const result = await this.read({
			sql: "SELECT * FROM agent_sessions WHERE run_id = ? AND node_key = ?",
			args: [runId, nodeKey],
		});
		const row = result.rows[0];
		return row ? rowToAgentSession(row) : null;
	}

	async listAgentSessionsForRun(runId: string, ownerUserId?: string): Promise<AgentSessionRecord[]> {
		const clauses = ["run_id = ?"];
		const args: string[] = [runId];
		if (ownerUserId) {
			clauses.push("owner_user_id = ?");
			args.push(ownerUserId);
		}
		const result = await this.read({
			sql: `SELECT * FROM agent_sessions WHERE ${clauses.join(" AND ")} ORDER BY phase_index ASC, label ASC`,
			args,
		});
		return result.rows.map(rowToAgentSession);
	}

	/**
	 * Register one immutable parent/child edge after both Agent Sessions exist.
	 * The identity is derived by the host from the pair, so retrying the exact
	 * registration is idempotent and cannot mint a second family edge.
	 *
	 * Arc F1 deliberately stops at the registry boundary: this does not admit a
	 * child request, attenuate a binding, allocate budget, or spawn a body.
	 */
	async registerAgentSessionChild(
		parentSessionId: string,
		childSessionId: string,
		input: { now: number; causationId?: string },
	): Promise<{ relation: AgentSessionChildRelationRecord; created: boolean }> {
		if (parentSessionId === childSessionId) {
			throw new AgentSessionRelationFault("self_relation", "an Agent Session cannot be its own child");
		}
		return this.tx(async (tx) => {
			const sessions = await tx.execute({
				sql: "SELECT * FROM agent_sessions WHERE session_id IN (?, ?)",
				args: [parentSessionId, childSessionId],
			});
			const records = new Map(sessions.rows.map((row) => [String(row.session_id), rowToAgentSession(row)]));
			const parent = records.get(parentSessionId);
			const child = records.get(childSessionId);
			if (!parent || !child) {
				const missing = [!parent ? parentSessionId : undefined, !child ? childSessionId : undefined].filter(
					(value): value is string => value !== undefined,
				);
				throw new AgentSessionRelationFault(
					"session_not_found",
					`cannot register an orphaned child relation; missing session(s): ${missing.join(", ")}`,
				);
			}
			if (parent.owner_user_id !== child.owner_user_id) {
				throw new AgentSessionRelationFault(
					"owner_mismatch",
					"parent and child Agent Sessions must have the same owner",
				);
			}
			if (parent.graph_id !== child.graph_id) {
				throw new AgentSessionRelationFault(
					"graph_mismatch",
					"parent and child Agent Sessions must inhabit the same graph authority boundary",
				);
			}

			const existing = await tx.execute({
				sql: "SELECT * FROM agent_session_relations WHERE child_session_id = ?",
				args: [childSessionId],
			});
			if (existing.rows[0]) {
				const relation = rowToAgentSessionChildRelation(existing.rows[0]);
				if (relation.parent_session_id !== parentSessionId) {
					throw new AgentSessionRelationFault(
						"child_already_attached",
						`Agent Session ${childSessionId} already belongs to parent ${relation.parent_session_id}`,
					);
				}
				return { relation, created: false };
			}
			if (parent.lifecycle_state !== "open") {
				throw new AgentSessionRelationFault(
					"child_already_attached",
					"a new child relation requires an open parent Session",
				);
			}
			const admissionFence = await tx.execute({
				sql: "SELECT 1 AS found FROM agent_session_admission_fences WHERE session_id = ?",
				args: [parentSessionId],
			});
			if (admissionFence.rows[0]) {
				throw new AgentSessionRelationFault(
					"child_already_attached",
					"a terminal cascade closed this parent Session admission boundary",
				);
			}

			const cycle = await tx.execute({
				sql: `
					WITH RECURSIVE descendants(session_id) AS (
						SELECT child_session_id
						  FROM agent_session_relations
						 WHERE parent_session_id = ?
						UNION
						SELECT relation.child_session_id
						  FROM agent_session_relations AS relation
						  JOIN descendants ON relation.parent_session_id = descendants.session_id
					)
					SELECT 1 AS found FROM descendants WHERE session_id = ? LIMIT 1
				`,
				args: [childSessionId, parentSessionId],
			});
			if (cycle.rows[0]) {
				throw new AgentSessionRelationFault(
					"cycle",
					`registering ${parentSessionId} -> ${childSessionId} would create a child cycle`,
				);
			}

			const relationId = agentSessionChildRelationId(parentSessionId, childSessionId);
			await tx.execute({
				sql: `
					INSERT INTO agent_session_relations
						(relation_id, relation_kind, parent_session_id, child_session_id,
						 owner_user_id, graph_id, causation_id, created_at)
					VALUES (?, 'parent_child', ?, ?, ?, ?, ?, ?)
				`,
				args: [
					relationId,
					parentSessionId,
					childSessionId,
					parent.owner_user_id,
					parent.graph_id,
					input.causationId ?? null,
					input.now,
				],
			});
			await tx.execute({
				sql: `WITH RECURSIVE subtree(session_id) AS (
				         SELECT ?
				         UNION ALL
				         SELECT relation.child_session_id
				           FROM agent_session_relations AS relation
				           JOIN subtree ON relation.parent_session_id = subtree.session_id
				       )
				       UPDATE agent_sessions SET family_root_session_id = ?
				        WHERE session_id IN (SELECT session_id FROM subtree)`,
				args: [childSessionId, parent.family_root_session_id],
			});
			if (child.family_root_session_id !== parent.family_root_session_id) {
				await tx.execute({
					sql: `INSERT INTO agent_session_family_projection_outbox
					        (root_session_id, work_kind, desired_revision, delivered_revision, state, not_before, updated_at)
					      VALUES (?, 'retire', 1, 0, 'pending', 0, ?)
					      ON CONFLICT(root_session_id) DO UPDATE SET
					        work_kind = 'retire', desired_revision = desired_revision + 1, state = 'pending',
					        claimed_revision = NULL, claimed_projection_revision = NULL,
					        consumer = NULL, claim_token = NULL, claimed_at = NULL,
					        claim_expires_at = NULL, heartbeat_at = NULL,
					        not_before = 0, last_error = NULL, updated_at = excluded.updated_at`,
					args: [child.family_root_session_id, input.now],
				});
			}
			const inserted = await tx.execute({
				sql: "SELECT * FROM agent_session_relations WHERE relation_id = ?",
				args: [relationId],
			});
			return { relation: rowToAgentSessionChildRelation(inserted.rows[0]!), created: true };
		}, "UPSERT");
	}

	/**
	 * Atomically decide one host-resolved child request. The worker supplies
	 * task content and a bounded session-name hint; the host-resolved Domain Agent
	 * context supplies model, runtime, ontology, graph and tool authority.
	 *
	 * Both acceptance and policy denial are durable/idempotent. Acceptance creates
	 * the child Session, relation, binding testimony and a real budget reservation
	 * in one transaction. Body materialization is a separate execution step.
	 */
	async admitAgentSessionChild(
		parentSessionId: string,
		input: AdmitAgentSessionChildInput,
	): Promise<AdmitAgentSessionChildResult> {
		const request = validateChildAdmissionRequest(input);
		const requestDigest = childAdmissionRequestDigest(request);
		return this.tx(async (tx) => {
			const existingRequest = await tx.execute({
				sql: `SELECT * FROM agent_session_child_spawn_requests
				       WHERE parent_session_id = ? AND request_id = ?`,
				args: [parentSessionId, request.requestId],
			});
			if (existingRequest.rows[0]) {
				const decision = rowToAgentSessionChildSpawnRequest(existingRequest.rows[0]);
				if (decision.request_digest !== requestDigest) {
					throw new AgentSessionChildAdmissionFault(
						"request_conflict",
						`child request ${request.requestId} was replayed with different content`,
					);
				}
				if (decision.decision === "denied") return { decision: "denied", request: decision, created: false };
				return loadAcceptedChildAdmissionTx(tx, decision, false);
			}

			const parent = await readAgentSessionTx(tx, parentSessionId);
			if (!parent) {
				throw new AgentSessionChildAdmissionFault(
					"parent_not_found",
					`parent Agent Session not found: ${parentSessionId}`,
				);
			}
			const admissionFence = await tx.execute({
				sql: "SELECT cascade_id FROM agent_session_admission_fences WHERE session_id = ?",
				args: [parentSessionId],
			});
			if (admissionFence.rows[0]) {
				return denyChildSpawnRequestTx(
					tx,
					parentSessionId,
					request,
					requestDigest,
					"children_not_granted",
					"the parent Session admission boundary is closed by durable terminal cascade intent",
				);
			}
			const parentMaterializationResult = await tx.execute({
				sql: "SELECT * FROM agent_materializations WHERE session_id = ? ORDER BY generation DESC LIMIT 1",
				args: [parentSessionId],
			});
			const parentMaterialization = parentMaterializationResult.rows[0]
				? rowToAgentMaterialization(parentMaterializationResult.rows[0])
				: null;
			const parentSupervision = await tx.execute({
				sql: `SELECT 1 AS active FROM agent_materialization_supervision
				      WHERE session_id = ? AND generation = ? AND activation_id = ? AND recovery_token IS NULL`,
				args: [parentSessionId, request.parentGeneration, request.parentActivationId],
			});
			if (
				!parentMaterialization ||
				parent.lifecycle_state !== "open" ||
				!parentSupervision.rows[0] ||
				parentMaterialization.generation !== request.parentGeneration ||
				parentMaterialization.activation_id !== request.parentActivationId ||
				parentMaterialization.sandbox_id !== request.parentSandboxId ||
				parentMaterialization.state !== "running" ||
				parent.sandbox_id !== request.parentSandboxId
			) {
				return denyChildSpawnRequestTx(
					tx,
					parentSessionId,
					request,
					requestDigest,
					"parent_generation_stale",
					"the child request does not belong to the exact running parent materialization",
				);
			}
			let parentSemantic: ReturnType<typeof readAgentSessionSemanticBinding>;
			try {
				parentSemantic = readAgentSessionSemanticBinding(parent);
			} catch (error) {
				return denyChildSpawnRequestTx(
					tx,
					parentSessionId,
					request,
					requestDigest,
					"children_not_granted",
					error instanceof Error ? error.message : "parent semantic binding is invalid",
				);
			}
			if (
				parentSemantic.runtime.kind !== "prime" ||
				parentSemantic.runtime.constraints.maxChildren < 1 ||
				parentSemantic.runtime.constraints.maxConcurrentChildren < 1
			) {
				return denyChildSpawnRequestTx(
					tx,
					parentSessionId,
					request,
					requestDigest,
					"children_not_granted",
					"the parent runtime binding does not grant hosted child admission",
				);
			}
			if (parentSemantic.runtime.constraints.maxChildDepth < 1) {
				return denyChildSpawnRequestTx(
					tx,
					parentSessionId,
					request,
					requestDigest,
					"max_child_depth_exhausted",
					"the parent Session has no remaining child depth",
				);
			}
			const authority = await readHostResolvedChildAuthorityTx(tx, parent);
			if (!authority) {
				return denyChildSpawnRequestTx(
					tx,
					parentSessionId,
					request,
					requestDigest,
					"children_not_granted",
					"the parent run has no trusted host-resolved child binding",
				);
			}
			if (
				digestAgentRuntimeBinding(parentSemantic.runtime) !== digestAgentRuntimeBinding(authority.parentRuntime) ||
				digestAgentOntologyBinding(parentSemantic.ontology) !== digestAgentOntologyBinding(authority.parentOntology)
			) {
				return denyChildSpawnRequestTx(
					tx,
					parentSessionId,
					request,
					requestDigest,
					"children_not_granted",
					"the requesting Session is not the host-bound parent embodiment for this run",
				);
			}
			if (request.requestedModel !== undefined && request.requestedModel !== authority.model) {
				return denyChildSpawnRequestTx(
					tx,
					parentSessionId,
					request,
					requestDigest,
					"model_not_granted",
					"the requested child model does not match the host-resolved emanation model",
				);
			}
			if (
				authority.childRuntime.constraints.maxChildDepth >
				Math.max(0, parentSemantic.runtime.constraints.maxChildDepth - 1)
			) {
				return denyChildSpawnRequestTx(
					tx,
					parentSessionId,
					request,
					requestDigest,
					"max_child_depth_exhausted",
					"the trusted child binding does not attenuate remaining child depth by one",
				);
			}

			const depth = (await agentSessionDepthTx(tx, parentSessionId)) + 1;
			const lifetimeChildrenResult = await tx.execute({
				sql: "SELECT COUNT(*) AS count FROM agent_session_child_admissions WHERE parent_session_id = ?",
				args: [parentSessionId],
			});
			if (Number(lifetimeChildrenResult.rows[0]?.count ?? 0) >= parentSemantic.runtime.constraints.maxChildren) {
				return denyChildSpawnRequestTx(
					tx,
					parentSessionId,
					request,
					requestDigest,
					"max_children_exhausted",
					"the parent Session has exhausted its lifetime child count",
				);
			}
			const occupiedChildrenResult = await tx.execute({
				sql: `SELECT COUNT(*) AS count FROM agent_session_child_generation_occupancy
				      WHERE parent_session_id = ? AND state = 'occupied'`,
				args: [parentSessionId],
			});
			if (
				Number(occupiedChildrenResult.rows[0]?.count ?? 0) >=
				parentSemantic.runtime.constraints.maxConcurrentChildren
			) {
				return denyChildSpawnRequestTx(
					tx,
					parentSessionId,
					request,
					requestDigest,
					"max_concurrent_children_exhausted",
					"the parent Session has no unoccupied child-generation slot",
				);
			}
			const childSessionId = stableAgentSessionChildId(parentSessionId, request.requestId);
			const childName = request.requestedName ?? stableAgentSessionChildName(parentSessionId, request.requestId);
			const siblingName = await tx.execute({
				sql: `SELECT child_session_id FROM agent_session_child_admissions
				       WHERE parent_session_id = ? AND child_name = ?`,
				args: [parentSessionId, childName],
			});
			if (siblingName.rows[0]) {
				return denyChildSpawnRequestTx(
					tx,
					parentSessionId,
					request,
					requestDigest,
					"child_name_conflict",
					`the parent already has a child named ${childName}`,
				);
			}
			let semantic: ReturnType<typeof deriveChildSemanticBinding>;
			try {
				semantic = deriveChildSemanticBinding({
					parentRuntime: parentSemantic.runtime,
					childRuntime: authority.childRuntime,
					childOntology: authority.childOntology,
				});
			} catch (error) {
				if (!(error instanceof AgentSessionChildAdmissionFault)) throw error;
				return denyChildSpawnRequestTx(tx, parentSessionId, request, requestDigest, error.reason, error.message);
			}
			const parentAccount = await requireAgentSessionBudgetAccountTx(
				tx,
				parentSessionId,
				budgetVectorFromConstraints(parentSemantic.runtime.constraints),
			);
			const childBudgetVector = budgetVectorFromChildSlice(semantic.budget);
			const insufficientDimensions = budgetDimensionsExceedingAvailable(parentAccount, childBudgetVector);
			if (insufficientDimensions.length > 0) {
				return denyChildSpawnRequestTx(
					tx,
					parentSessionId,
					request,
					requestDigest,
					insufficientDimensions.includes("costUsdMicros")
						? "child_cost_budget_exhausted"
						: "child_budget_exhausted",
					`the child budget slice exceeds remaining parent capacity: ${insufficientDimensions.join(", ")}`,
				);
			}
			const relationId = agentSessionChildRelationId(parentSessionId, childSessionId);
			const admissionId = childAdmissionId(parentSessionId, request.requestId);
			const childRunId = stableAgentSessionChildRunId(parentSessionId, request.requestId);
			const allocationId = childBudgetAllocationId(admissionId);
			const nodeKey = `child:${childSessionId}`;
			const frontier: WorkflowFrontier = {
				kind: "before-node",
				nodeKey,
				sessionId: childSessionId,
				label: childName,
				phaseIndex: parent.phase_index,
				ts: request.now,
			};
			const spec: AgentNodeSpec = {
				nodeKey,
				sessionId: childSessionId,
				label: childName,
				phaseIndex: parent.phase_index,
				prompt: request.prompt,
				systemPrompt: authority.systemPrompt,
				model: authority.model,
				provider: authority.provider,
				graphId: parent.graph_id,
				graphAccess: "read",
				agentId: semantic.ontology.subject.agentId,
				runtime: semantic.runtime,
				runtimeBindingDigest: semantic.runtimeBindingDigest,
				ontology: semantic.ontology,
				ontologyBindingDigest: semantic.ontologyBindingDigest,
				maxTurns: semantic.runtime.constraints.maxTurns,
				toolMode: "dynamic",
				includeTools: authority.includeTools,
				strictToolManifest: true,
				agentType: "domain-agent-emanation",
				invocationId: childRunId,
				depth,
			};
			const childInput: BeginAgentSessionInput = {
				sessionId: childSessionId,
				runId: parent.run_id,
				workflowName: parent.workflow_name,
				graphId: parent.graph_id,
				ownerUserId: parent.owner_user_id,
				graphOwnerPrincipal: parent.graph_owner_principal,
				spec,
				nodeKey,
				frontier,
				now: request.now,
			};
			const collision = await tx.execute({
				sql: "SELECT session_id FROM agent_sessions WHERE session_id = ? OR (run_id = ? AND node_key = ?)",
				args: [childSessionId, parent.run_id, nodeKey],
			});
			if (collision.rows[0]) {
				return denyChildSpawnRequestTx(
					tx,
					parentSessionId,
					request,
					requestDigest,
					"child_identity_collision",
					"the derived child identity collides with a Session outside this admission",
				);
			}
			const child = await insertNewAgentSessionTx(
				tx,
				childInput,
				{
					kind: "child-admission",
					parentSessionId,
					relationId,
					admissionId,
					childRunId,
					requestId: request.requestId,
					causationId: request.causationId,
					childName,
					depth,
				},
				parent.family_root_session_id,
			);
			await tx.execute({
				sql: `
					INSERT INTO agent_session_relations
						(relation_id, relation_kind, parent_session_id, child_session_id,
						 owner_user_id, graph_id, causation_id, created_at)
					VALUES (?, 'parent_child', ?, ?, ?, ?, ?, ?)
				`,
				args: [
					relationId,
					parentSessionId,
					childSessionId,
					parent.owner_user_id,
					parent.graph_id,
					request.causationId,
					request.now,
				],
			});
			await applyAgentSessionBudgetLedgerEntryTx(tx, {
				sessionId: parentSessionId,
				kind: "child_allocated",
				referenceId: allocationId,
				reservedDelta: childBudgetVector,
				spentDelta: ZERO_AGENT_SESSION_BUDGET,
				detail: {
					schema: "choreograph.agent-session-budget-child-allocation.v1",
					allocationId,
					admissionId,
					childSessionId,
					generation: 0,
				},
				now: request.now,
			});
			await tx.execute({
				sql: `INSERT INTO agent_session_child_generation_occupancy
				        (parent_session_id, child_session_id, generation, state, acquired_at)
				      VALUES (?, ?, 0, 'occupied', ?)`,
				args: [parentSessionId, childSessionId, request.now],
			});
			await tx.execute({
				sql: `
					INSERT INTO agent_session_child_budget_allocations
						(allocation_id, admission_id, parent_session_id, child_session_id,
						 state, budget_json, created_at)
					VALUES (?, ?, ?, ?, 'reserved', ?, ?)
				`,
				args: [
					allocationId,
					admissionId,
					parentSessionId,
					childSessionId,
					JSON.stringify(semantic.budget),
					request.now,
				],
			});
			await tx.execute({
				sql: `
					INSERT INTO agent_session_child_admissions
						(admission_id, parent_session_id, request_id, request_digest,
						 child_session_id, child_run_id, relation_id, child_name, depth,
						 runtime_binding_digest, ontology_binding_digest, budget_allocation_id,
						 budget_json, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`,
				args: [
					admissionId,
					parentSessionId,
					request.requestId,
					requestDigest,
					childSessionId,
					childRunId,
					relationId,
					childName,
					depth,
					semantic.runtimeBindingDigest,
					semantic.ontologyBindingDigest,
					allocationId,
					JSON.stringify(semantic.budget),
					request.now,
				],
			});
			const spawnRequest: AgentSessionChildSpawnRequestRecord = {
				parent_session_id: parentSessionId,
				request_id: request.requestId,
				request_digest: requestDigest,
				decision: "accepted",
				admission_id: admissionId,
				child_session_id: childSessionId,
				child_run_id: childRunId,
				denial_code: null,
				denial_message: null,
				created_at: request.now,
			};
			await insertChildSpawnRequestTx(tx, spawnRequest);
			await appendAgentSessionEventTx(tx, parentSessionId, {
				type: "child.spawn_requested",
				ts: request.now,
				payload: {
					schema: "choreograph.agent-session-child-spawn-requested.v1",
					requestId: request.requestId,
					causationId: request.causationId,
					decision: "accepted",
					admissionId,
					childSessionId,
					childRunId,
					childName,
				},
			});
			await appendAgentSessionEventTx(tx, parentSessionId, {
				type: "child.created",
				ts: request.now,
				payload: {
					schema: "choreograph.agent-session-child-created.v1",
					admissionId,
					relationId,
					requestId: request.requestId,
					causationId: request.causationId,
					parentSessionId,
					childSessionId,
					childRunId,
					childName,
					depth,
					runtimeKind: semantic.runtime.kind,
					runtimeBindingDigest: semantic.runtimeBindingDigest,
					ontologyBindingDigest: semantic.ontologyBindingDigest,
					budgetAllocationId: allocationId,
					budgetSlice: semantic.budget,
				},
			});
			const relation: AgentSessionChildRelationRecord = {
				relation_id: relationId,
				relation_kind: "parent_child",
				parent_session_id: parentSessionId,
				child_session_id: childSessionId,
				owner_user_id: parent.owner_user_id,
				graph_id: parent.graph_id,
				causation_id: request.causationId,
				created_at: request.now,
			};
			const admission: AgentSessionChildAdmissionRecord = {
				admission_id: admissionId,
				parent_session_id: parentSessionId,
				request_id: request.requestId,
				request_digest: requestDigest,
				child_session_id: childSessionId,
				child_run_id: childRunId,
				relation_id: relationId,
				child_name: childName,
				depth,
				runtime_binding_digest: semantic.runtimeBindingDigest,
				ontology_binding_digest: semantic.ontologyBindingDigest,
				budget_allocation_id: allocationId,
				budget: semantic.budget,
				created_at: request.now,
			};
			const allocation: AgentSessionChildBudgetAllocationRecord = {
				allocation_id: allocationId,
				admission_id: admissionId,
				parent_session_id: parentSessionId,
				child_session_id: childSessionId,
				state: "reserved",
				budget: semantic.budget,
				hold_reason: null,
				created_at: request.now,
				held_at: null,
				settled_at: null,
			};
			const run: AgentSessionChildRunRecord = {
				child_run_id: childRunId,
				admission_id: admissionId,
				parent_session_id: parentSessionId,
				child_session_id: childSessionId,
				state: "queued",
				attempt: 0,
				consumer: null,
				claim_token: null,
				claimed_at: null,
				claim_expires_at: null,
				heartbeat_at: null,
				materialization_generation: null,
				materialized_at: null,
				result: null,
				error: null,
				terminal_digest: null,
				created_at: request.now,
				terminal_at: null,
			};
			await insertAgentSessionChildRunTx(tx, run);
			return {
				decision: "accepted",
				request: spawnRequest,
				child,
				relation,
				admission,
				allocation,
				run,
				spec,
				created: true,
			};
		}, "UPSERT_IF_ABSENT");
	}

	async readAgentSessionChildSpawnRequest(
		parentSessionId: string,
		requestId: string,
	): Promise<AgentSessionChildSpawnRequestRecord | null> {
		const result = await this.read({
			sql: `SELECT * FROM agent_session_child_spawn_requests
			       WHERE parent_session_id = ? AND request_id = ?`,
			args: [parentSessionId, requestId],
		});
		return result.rows[0] ? rowToAgentSessionChildSpawnRequest(result.rows[0]) : null;
	}

	async readAgentSessionChildRun(childRunId: string): Promise<AgentSessionChildRunRecord | null> {
		const result = await this.read({
			sql: "SELECT * FROM agent_session_child_runs WHERE child_run_id = ?",
			args: [childRunId],
		});
		return result.rows[0] ? rowToAgentSessionChildRun(result.rows[0]) : null;
	}

	async readAgentSessionChildBudgetAllocation(
		allocationId: string,
	): Promise<AgentSessionChildBudgetAllocationRecord | null> {
		const result = await this.read({
			sql: "SELECT * FROM agent_session_child_budget_allocations WHERE allocation_id = ?",
			args: [allocationId],
		});
		return result.rows[0] ? rowToAgentSessionChildBudgetAllocation(result.rows[0]) : null;
	}

	async listAgentSessionChildCancellationRequests(
		childRunId: string,
	): Promise<AgentSessionChildCancellationRequestRecord[]> {
		const result = await this.read({
			sql: `SELECT * FROM agent_session_child_cancellation_requests
			      WHERE child_run_id = ? ORDER BY created_at ASC, request_id ASC`,
			args: [childRunId],
		});
		return result.rows.map(rowToAgentSessionChildCancellationRequest);
	}

	/** Ordered startup queue: only work that a new executor is legally allowed to lease. */
	async listClaimableAgentSessionChildRuns(input: {
		readonly now: number;
		readonly limit?: number;
	}): Promise<AgentSessionChildRunRecord[]> {
		validateBudgetInteger(input.now, "child run recovery time");
		const limit = validateChildRunRecoveryLimit(input.limit);
		const result = await this.read({
			sql: `SELECT run.* FROM agent_session_child_runs AS run
			      JOIN agent_sessions AS child ON child.session_id = run.child_session_id
			      WHERE child.lifecycle_state = 'open'
			        AND NOT EXISTS (
			          SELECT 1 FROM agent_session_admission_fences AS fence
			           WHERE fence.session_id = run.child_session_id
			        )
			        AND (run.state = 'queued'
			         OR (run.state = 'claimed' AND run.materialized_at IS NULL AND run.claim_expires_at <= ?))
			      ORDER BY run.created_at ASC, run.child_run_id ASC LIMIT ?`,
			args: [input.now, limit],
		});
		return result.rows.map(rowToAgentSessionChildRun);
	}

	/** Recovery inspection is testimony only; materialized work is never execution-reclaimed through this seam. */
	async listAgentSessionChildRunsRequiringRecovery(input: {
		readonly now: number;
		readonly limit?: number;
	}): Promise<AgentSessionChildRunRecoveryRecord[]> {
		validateBudgetInteger(input.now, "child run recovery time");
		const limit = validateChildRunRecoveryLimit(input.limit);
		const result = await this.read({
			sql: `SELECT run.*, allocation.state AS allocation_state,
			             allocation.budget_json AS allocation_budget_json,
			             allocation.hold_reason AS allocation_hold_reason,
			             allocation.created_at AS allocation_created_at,
			             allocation.held_at AS allocation_held_at,
			             allocation.settled_at AS allocation_settled_at,
			             allocation.allocation_id AS allocation_record_id,
			             materialization.session_id AS materialization_session_id,
			             materialization.generation AS materialization_record_generation,
			             materialization.sandbox_id AS materialization_sandbox_id,
			             materialization.activation_id AS materialization_activation_id,
			             materialization.state AS materialization_record_state,
			             materialization.fault_kind AS materialization_fault_kind,
			             materialization.recoverable AS materialization_recoverable,
			             materialization.checkpoint_id AS materialization_checkpoint_id,
			             materialization.kernel_checkpoint_id AS materialization_kernel_checkpoint_id,
			             materialization.created_at AS materialization_created_at,
			             materialization.updated_at AS materialization_updated_at,
			             materialization.passivated_at AS materialization_passivated_at
			        FROM agent_session_child_runs AS run
			        JOIN agent_session_child_budget_allocations AS allocation
			          ON allocation.admission_id = run.admission_id
			        JOIN agent_sessions AS child ON child.session_id = run.child_session_id
			   LEFT JOIN agent_materializations AS materialization
			          ON materialization.session_id = run.child_session_id
			         AND materialization.generation = (
			             SELECT MAX(latest.generation) FROM agent_materializations AS latest
			              WHERE latest.session_id = run.child_session_id
			         )
			       WHERE run.state = 'cancelling'
			          OR (run.state = 'claimed' AND run.materialized_at IS NOT NULL AND run.claim_expires_at <= ?)
			          OR (run.state IN ('completed', 'failed', 'cancelled')
			              AND child.lifecycle_state <> 'closed'
			              AND (
			                EXISTS (
			                  SELECT 1 FROM agent_session_child_closure_work AS closure_work
			                   WHERE closure_work.child_run_id = run.child_run_id
			                     AND closure_work.state IN ('pending', 'claimed')
			                )
			                OR (materialization.state = 'faulted' AND materialization.recoverable = 0)
			              ))
			          OR allocation.state = 'accounting_hold'
			       ORDER BY run.created_at ASC, run.child_run_id ASC LIMIT ?`,
			args: [input.now, limit],
		});
		return result.rows.map(rowToAgentSessionChildRunRecovery);
	}

	async reconcileAgentSessionChildAccountingHold(
		childRunId: string,
		input: { readonly now: number },
	): Promise<{ allocation: AgentSessionChildBudgetAllocationRecord; applied: boolean }> {
		validateBudgetInteger(input.now, "child accounting reconciliation time");
		return this.tx(async (tx) => {
			const run = await requireAgentSessionChildRunTx(tx, childRunId);
			if (!isTerminalAgentSessionChildRunState(run.state)) {
				throw new AgentSessionChildRunFault("accounting_blocked", `child run ${childRunId} is not terminal`);
			}
			const allocation = await requireChildAllocationForRunTx(tx, childRunId);
			if (allocation.state !== "accounting_hold") return { allocation, applied: false };
			const admission = await requireChildAdmissionForRunTx(tx, run);
			const reconciled = await closeExecutedChildAllocationTx(tx, admission, allocation, input.now);
			return { allocation: reconciled, applied: reconciled.state === "settled" };
		}, "CAS");
	}

	async readAgentSessionBudgetSnapshot(sessionId: string): Promise<AgentSessionBudgetSnapshot | null> {
		return this.tx(async (tx) => {
			const accountResult = await tx.execute({
				sql: "SELECT * FROM agent_session_budget_accounts WHERE session_id = ?",
				args: [sessionId],
			});
			if (!accountResult.rows[0]) return null;
			const entriesResult = await tx.execute({
				sql: "SELECT * FROM agent_session_budget_entries WHERE session_id = ? ORDER BY ordinal ASC",
				args: [sessionId],
			});
			const account = rowToAgentSessionBudgetAccount(accountResult.rows[0]);
			return {
				account,
				available: availableAgentSessionBudget(account),
				entries: entriesResult.rows.map(rowToAgentSessionBudgetLedgerEntry),
			};
		}, "CAS");
	}

	async listAgentSessionBudgetEntries(sessionId: string): Promise<AgentSessionBudgetLedgerEntryRecord[]> {
		const result = await this.read({
			sql: "SELECT * FROM agent_session_budget_entries WHERE session_id = ? ORDER BY ordinal ASC",
			args: [sessionId],
		});
		return result.rows.map(rowToAgentSessionBudgetLedgerEntry);
	}

	async readAgentSessionInferenceReservation(
		operationId: string,
	): Promise<AgentSessionInferenceReservationRecord | null> {
		const result = await this.read({
			sql: "SELECT * FROM agent_session_inference_reservations WHERE operation_id = ?",
			args: [operationId],
		});
		return result.rows[0] ? rowToAgentSessionInferenceReservation(result.rows[0]) : null;
	}

	async readAgentSessionChildGenerationOccupancy(
		childSessionId: string,
		generation: number,
	): Promise<AgentSessionChildGenerationOccupancyRecord | null> {
		const result = await this.read({
			sql: `SELECT * FROM agent_session_child_generation_occupancy
			      WHERE child_session_id = ? AND generation = ?`,
			args: [childSessionId, generation],
		});
		return result.rows[0] ? rowToAgentSessionChildGenerationOccupancy(result.rows[0]) : null;
	}

	/** Atomically price and reserve the largest possible output under the durable account. */
	async reserveAgentSessionInferenceBudget(
		sessionId: string,
		input: ReserveAgentSessionInferenceBudgetInput,
	): Promise<AgentSessionInferenceBudgetReservationResult> {
		const normalized = validateInferenceReservationInput(input);
		const operationId = agentSessionInferenceOperationId(sessionId, input.generation, input.requestId);
		const reservationDigest = digestInferenceReservationInput(normalized);
		return this.tx(async (tx) => {
			const billingProvenance = await readAgentSessionInferenceBillingProvenanceTx(tx, sessionId);
			const existingResult = await tx.execute({
				sql: "SELECT * FROM agent_session_inference_reservations WHERE operation_id = ?",
				args: [operationId],
			});
			if (existingResult.rows[0]) {
				const reservation = rowToAgentSessionInferenceReservation(existingResult.rows[0]);
				if (reservation.reservation_digest !== reservationDigest) {
					throw new AgentSessionBudgetFault(
						"request_conflict",
						`inference request ${input.requestId} was replayed with different reservation evidence`,
					);
				}
				const account = await requireAgentSessionBudgetAccountTx(tx, sessionId);
				const entry = await requireAgentSessionBudgetEntryTx(tx, sessionId, "inference_reserved", operationId);
				return {
					account,
					reservation,
					entry,
					applied: false,
					exhaustedDimensions: exhaustedAgentSessionBudgetDimensions(account),
					maxOutputTokens: reservation.max_output_tokens,
					billingProvenance,
				};
			}
			const { rateCard } = await requireExactRunningMaterializationTx(tx, sessionId, normalized);
			const account = await requireAgentSessionBudgetAccountTx(tx, sessionId);
			if (account.exhausted) {
				throw new AgentSessionBudgetFault("budget_exhausted", "Agent Session budget is exhausted");
			}
			const sessionAvailable = availableAgentSessionBudget(account);
			// ONE call expression prices every ceiling considered here (the session's, and the person's
			// balance), so whichever rate card `maximalAffordableOutputTokens` prices with, the credit clamp
			// and the reservation cannot disagree. The card is the Session's own, read in this transaction:
			// the clamp is against the price the call will be reserved and settled at, never the static table.
			const maxTokensUnder = (costUsdMicros: number): number =>
				maximalAffordableOutputTokens({
					provider: normalized.provider,
					model: normalized.model,
					estimatedInputTokens: normalized.estimatedInputTokens,
					requestedOutputTokens: normalized.requestedOutputTokens,
					available: { ...sessionAvailable, costUsdMicros },
					rateCard,
				});
			const clamp = planCreditClamp({
				creditCeilingCostUsdMicros: input.creditCeilingCostUsdMicros,
				creditEnforce: input.creditEnforce,
				requestedOutputTokens: normalized.requestedOutputTokens,
				sessionAvailableCostUsdMicros: sessionAvailable.costUsdMicros,
				maxTokensUnder,
			});
			if (clamp.refuse) {
				throw new AgentSessionBudgetFault(
					CREDIT_EXHAUSTED_REASON,
					"The credit balance cannot fund another inference request",
					{ creditProbe: clamp.probe },
				);
			}
			const available = { ...sessionAvailable, costUsdMicros: clamp.costCeilingUsdMicros };
			const maxOutputTokens = clamp.maxOutputTokens;
			if (available.turns < 1 || maxOutputTokens < 1) {
				throw new AgentSessionBudgetFault(
					"budget_exhausted",
					"Agent Session budget cannot admit another inference request",
					{ available },
				);
			}
			const costUsdMicros = projectedInferenceBudgetCost(
				normalized.model,
				normalized.provider,
				normalized.estimatedInputTokens,
				maxOutputTokens,
				rateCard,
			);
			const budget: AgentSessionBudgetVectorV1 = {
				turns: 1,
				wallTimeMs: 0,
				tokens: checkedBudgetSum(normalized.estimatedInputTokens, maxOutputTokens),
				costUsdMicros,
				artifactBytes: 0,
			};
			const entry = await applyAgentSessionBudgetLedgerEntryTx(tx, {
				sessionId,
				kind: "inference_reserved",
				referenceId: operationId,
				reservedDelta: budget,
				spentDelta: ZERO_AGENT_SESSION_BUDGET,
				detail: {
					schema: "choreograph.agent-session-inference-budget-reserved.v1",
					operationId,
					generation: normalized.generation,
					requestId: normalized.requestId,
					requestDigest: normalized.requestDigest,
					provider: normalized.provider,
					model: normalized.model,
					pricingVersion: normalized.pricingVersion,
					estimatedInputTokens: normalized.estimatedInputTokens,
					maxOutputTokens,
				},
				now: normalized.now,
			});
			await tx.execute({
				sql: `INSERT INTO agent_session_inference_reservations
				        (operation_id, session_id, generation, activation_id, sandbox_id,
				         request_id, request_digest, reservation_digest, causation_id, provider, model,
				         pricing_version, estimated_input_tokens, max_output_tokens, state, budget_json,
				         created_at, updated_at, funding_source)
				      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?)`,
				args: [
					operationId,
					sessionId,
					normalized.generation,
					normalized.activationId,
					normalized.sandboxId,
					normalized.requestId,
					normalized.requestDigest,
					reservationDigest,
					normalized.causationId,
					normalized.provider,
					normalized.model,
					normalized.pricingVersion,
					normalized.estimatedInputTokens,
					maxOutputTokens,
					JSON.stringify(budget),
					normalized.now,
					normalized.now,
					normalized.fundingSource ?? "platform",
				],
			});
			const reservation = await requireAgentSessionInferenceReservationTx(tx, operationId);
			const updatedAccount = await requireAgentSessionBudgetAccountTx(tx, sessionId);
			return {
				account: updatedAccount,
				reservation,
				entry,
				applied: true,
				exhaustedDimensions: exhaustedAgentSessionBudgetDimensions(updatedAccount),
				maxOutputTokens,
				billingProvenance,
				...(clamp.probe ? { creditProbe: clamp.probe } : {}),
			};
		}, "CAS");
	}

	async settleAgentSessionInferenceBudget(
		operationId: string,
		input: SettleAgentSessionInferenceBudgetInput,
	): Promise<AgentSessionInferenceBudgetMutationResult> {
		const fence = validateInferenceFenceInput(input);
		const usage = validateAgentSessionBudgetVector(input.usage, "inference usage");
		return this.tx(async (tx) => {
			const reservation = await requireAgentSessionInferenceReservationTx(tx, operationId);
			assertInferenceReservationFence(reservation, fence);
			const billingEvent = await validateBillingOutboxPayloadTx(tx, input.billingEvent, reservation, usage);
			if (reservation.state === "settled") {
				if (
					!reservation.usage ||
					!budgetVectorsEqual(reservation.usage, usage) ||
					(await requireAgentSessionInferenceBillingOutboxTx(tx, operationId)).payload_digest !==
						digestJson(billingEvent)
				) {
					throw new AgentSessionBudgetFault(
						"request_conflict",
						`inference operation ${operationId} was replayed with different settlement truth`,
					);
				}
				const account = await requireAgentSessionBudgetAccountTx(tx, reservation.session_id);
				return {
					account,
					reservation,
					entry: await requireAgentSessionBudgetEntryTx(
						tx,
						reservation.session_id,
						"inference_settled",
						operationId,
					),
					applied: false,
					exhaustedDimensions: exhaustedAgentSessionBudgetDimensions(account),
				};
			}
			if (reservation.state === "released") {
				throw new AgentSessionBudgetFault(
					"reservation_state_conflict",
					`released inference operation ${operationId} cannot be settled`,
				);
			}
			const before = await requireAgentSessionBudgetAccountTx(tx, reservation.session_id);
			const entry = await applyAgentSessionBudgetLedgerEntryTx(tx, {
				sessionId: reservation.session_id,
				kind: "inference_settled",
				referenceId: operationId,
				reservedDelta: negateAgentSessionBudget(reservation.budget),
				spentDelta: usage,
				detail: {
					schema: "choreograph.agent-session-inference-budget-settled.v1",
					operationId,
					requestId: reservation.request_id,
					usage,
				},
				now: fence.now,
				allowExhaustion: true,
			});
			await tx.execute({
				sql: `UPDATE agent_session_inference_reservations
				         SET state = 'settled', usage_json = ?, reason = NULL, updated_at = ?, terminal_at = ?
				       WHERE operation_id = ?`,
				args: [JSON.stringify(usage), fence.now, fence.now, operationId],
			});
			await tx.execute({
				sql: `INSERT INTO agent_session_inference_billing_outbox
				        (operation_id, session_id, payload_json, payload_digest, state, created_at)
				      VALUES (?, ?, ?, ?, 'pending', ?)`,
				args: [
					operationId,
					reservation.session_id,
					canonicalJson(billingEvent),
					digestJson(billingEvent),
					fence.now,
				],
			});
			const account = await requireAgentSessionBudgetAccountTx(tx, reservation.session_id);
			const exhaustedDimensions = exhaustedAgentSessionBudgetDimensions(account);
			if (!before.exhausted && account.exhausted) {
				await appendAgentSessionEventTx(tx, reservation.session_id, {
					type: "budget.exhausted",
					ts: fence.now,
					payload: {
						schema: "choreograph.agent-session-budget-exhausted.v1",
						operationId,
						dimensions: exhaustedDimensions,
					},
				});
			}
			return {
				account,
				reservation: await requireAgentSessionInferenceReservationTx(tx, operationId),
				entry,
				applied: true,
				exhaustedDimensions,
			};
		}, "CAS");
	}

	async markAgentSessionInferenceBudgetIndeterminate(
		operationId: string,
		input: AgentSessionInferenceFenceInput & { readonly reason: string },
	): Promise<AgentSessionInferenceBudgetMutationResult> {
		const fence = validateInferenceFenceInput(input);
		const reason = requiredBoundedText(input.reason, "indeterminate reason", 2048);
		return this.tx(async (tx) => {
			const reservation = await requireAgentSessionInferenceReservationTx(tx, operationId);
			assertInferenceReservationFence(reservation, fence);
			if (reservation.state === "indeterminate") {
				if (reservation.reason !== reason) {
					throw new AgentSessionBudgetFault("request_conflict", "indeterminate replay changed its reason");
				}
				const account = await requireAgentSessionBudgetAccountTx(tx, reservation.session_id);
				return {
					account,
					reservation,
					entry: await requireAgentSessionBudgetEntryTx(
						tx,
						reservation.session_id,
						"inference_indeterminate",
						operationId,
					),
					applied: false,
					exhaustedDimensions: exhaustedAgentSessionBudgetDimensions(account),
				};
			}
			if (reservation.state !== "reserved") {
				throw new AgentSessionBudgetFault(
					"reservation_state_conflict",
					`inference operation ${operationId} is already ${reservation.state}`,
				);
			}
			const entry = await applyAgentSessionBudgetLedgerEntryTx(tx, {
				sessionId: reservation.session_id,
				kind: "inference_indeterminate",
				referenceId: operationId,
				reservedDelta: ZERO_AGENT_SESSION_BUDGET,
				spentDelta: ZERO_AGENT_SESSION_BUDGET,
				detail: {
					schema: "choreograph.agent-session-inference-budget-indeterminate.v1",
					operationId,
					reason,
				},
				now: fence.now,
			});
			await tx.execute({
				sql: `UPDATE agent_session_inference_reservations
				         SET state = 'indeterminate', reason = ?, updated_at = ? WHERE operation_id = ?`,
				args: [reason, fence.now, operationId],
			});
			const account = await requireAgentSessionBudgetAccountTx(tx, reservation.session_id);
			return {
				account,
				reservation: await requireAgentSessionInferenceReservationTx(tx, operationId),
				entry,
				applied: true,
				exhaustedDimensions: exhaustedAgentSessionBudgetDimensions(account),
			};
		}, "CAS");
	}

	async releaseAgentSessionInferenceBudget(
		operationId: string,
		input: AgentSessionInferenceFenceInput & { readonly reason: string },
	): Promise<AgentSessionInferenceBudgetMutationResult> {
		const fence = validateInferenceFenceInput(input);
		const reason = requiredBoundedText(input.reason, "release reason", 2048);
		return this.tx(async (tx) => {
			const reservation = await requireAgentSessionInferenceReservationTx(tx, operationId);
			assertInferenceReservationFence(reservation, fence);
			if (reservation.state === "released") {
				if (reservation.reason !== reason) {
					throw new AgentSessionBudgetFault("request_conflict", "release replay changed its reason");
				}
				const account = await requireAgentSessionBudgetAccountTx(tx, reservation.session_id);
				return {
					account,
					reservation,
					entry: await requireAgentSessionBudgetEntryTx(
						tx,
						reservation.session_id,
						"inference_released",
						operationId,
					),
					applied: false,
					exhaustedDimensions: exhaustedAgentSessionBudgetDimensions(account),
				};
			}
			if (reservation.state === "settled") {
				throw new AgentSessionBudgetFault(
					"reservation_state_conflict",
					`settled inference operation ${operationId} cannot be released`,
				);
			}
			const entry = await applyAgentSessionBudgetLedgerEntryTx(tx, {
				sessionId: reservation.session_id,
				kind: "inference_released",
				referenceId: operationId,
				reservedDelta: negateAgentSessionBudget(reservation.budget),
				spentDelta: ZERO_AGENT_SESSION_BUDGET,
				detail: {
					schema: "choreograph.agent-session-inference-budget-released.v1",
					operationId,
					reason,
				},
				now: fence.now,
			});
			await tx.execute({
				sql: `UPDATE agent_session_inference_reservations
				         SET state = 'released', reason = ?, updated_at = ?, terminal_at = ? WHERE operation_id = ?`,
				args: [reason, fence.now, fence.now, operationId],
			});
			const account = await requireAgentSessionBudgetAccountTx(tx, reservation.session_id);
			return {
				account,
				reservation: await requireAgentSessionInferenceReservationTx(tx, operationId),
				entry,
				applied: true,
				exhaustedDimensions: exhaustedAgentSessionBudgetDimensions(account),
			};
		}, "CAS");
	}

	async claimAgentSessionInferenceBillingOutbox(input: {
		readonly consumer: string;
		readonly leaseMs: number;
		readonly now: number;
	}): Promise<AgentSessionInferenceBillingOutboxRecord | null> {
		const consumer = requiredBoundedText(input.consumer, "billing outbox consumer", 256);
		validateBudgetInteger(input.now, "billing outbox claim time");
		validatePositiveBudgetInteger(input.leaseMs, "billing outbox leaseMs");
		return this.tx(async (tx) => {
			const selected = await tx.execute({
				sql: `SELECT operation_id FROM agent_session_inference_billing_outbox
				      WHERE state = 'pending' OR (state = 'claimed' AND claim_expires_at <= ?)
				      ORDER BY created_at ASC, operation_id ASC LIMIT 1`,
				args: [input.now],
			});
			if (!selected.rows[0]) return null;
			const operationId = String(selected.rows[0].operation_id);
			const claimToken = randomUUID();
			const result = await tx.execute({
				sql: `UPDATE agent_session_inference_billing_outbox
				         SET state = 'claimed', consumer = ?, claim_token = ?, claimed_at = ?, claim_expires_at = ?
				       WHERE operation_id = ?
				         AND (state = 'pending' OR (state = 'claimed' AND claim_expires_at <= ?))
				       RETURNING *`,
				args: [consumer, claimToken, input.now, checkedBudgetSum(input.now, input.leaseMs), operationId, input.now],
			});
			return result.rows[0] ? rowToAgentSessionInferenceBillingOutbox(result.rows[0]) : null;
		}, "CAS");
	}

	/** Earliest durable instant at which any undelivered billing row can be claimed. */
	async readAgentSessionInferenceBillingOutboxNextAvailableAt(now: number): Promise<number | null> {
		validateBudgetInteger(now, "billing outbox availability time");
		const result = await this.read({
			sql: `SELECT MIN(
			         CASE
			           WHEN state = 'pending' THEN ?
			           WHEN state = 'claimed' THEN MAX(claim_expires_at, ?)
			         END
			       ) AS next_available_at
			  FROM agent_session_inference_billing_outbox
			 WHERE state IN ('pending', 'claimed')`,
			args: [now, now],
		});
		const value = result.rows[0]?.next_available_at;
		if (value === null || value === undefined) return null;
		return requiredProjectionInteger(value, "billing outbox next availability");
	}

	async completeAgentSessionInferenceBillingOutbox(input: {
		readonly operationId: string;
		readonly consumer: string;
		readonly claimToken: string;
		readonly now: number;
	}): Promise<AgentSessionInferenceBillingOutboxRecord> {
		validateBudgetInteger(input.now, "billing outbox completion time");
		const result = await this.write(
			{
				sql: `UPDATE agent_session_inference_billing_outbox
				         SET state = 'delivered', delivered_at = ?
				       WHERE operation_id = ? AND state = 'claimed' AND consumer = ? AND claim_token = ?
				         AND claim_expires_at > ?
				       RETURNING *`,
				args: [input.now, input.operationId, input.consumer, input.claimToken, input.now],
			},
			"CAS",
		);
		if (!result.rows[0]) throw new Error(`inference billing outbox completion lost claim: ${input.operationId}`);
		return rowToAgentSessionInferenceBillingOutbox(result.rows[0]);
	}

	/** Lease queued or expired pre-materialization work; a body-owning run is never execution-reclaimed. */
	async claimAgentSessionChildRun(
		childRunId: string,
		input: ClaimAgentSessionChildRunInput,
	): Promise<AgentSessionChildRunClaim> {
		const claim = validateChildRunClaimInput(input);
		return this.tx(async (tx) => {
			const existing = await requireAgentSessionChildRunTx(tx, childRunId);
			const child = await requireChildSessionForRunTx(tx, existing);
			const admissionFence = await tx.execute({
				sql: "SELECT 1 AS found FROM agent_session_admission_fences WHERE session_id = ?",
				args: [existing.child_session_id],
			});
			const childAcceptsExecution = child.lifecycle_state === "open" && !admissionFence.rows[0];
			const eligible =
				childAcceptsExecution &&
				(existing.state === "queued" ||
					(existing.state === "claimed" &&
						existing.materialized_at === null &&
						(existing.claim_expires_at ?? Number.MAX_SAFE_INTEGER) <= claim.now));
			let run = existing;
			let claimed = false;
			if (eligible) {
				const claimToken = randomUUID();
				const updated = await tx.execute({
					sql: `UPDATE agent_session_child_runs
					         SET state = 'claimed', attempt = attempt + 1, consumer = ?, claim_token = ?,
					             claimed_at = ?, claim_expires_at = ?, heartbeat_at = ?
					       WHERE child_run_id = ?
					         AND EXISTS (
					           SELECT 1 FROM agent_sessions AS child
					            WHERE child.session_id = agent_session_child_runs.child_session_id
					              AND child.lifecycle_state = 'open'
					         )
					         AND NOT EXISTS (
					           SELECT 1 FROM agent_session_admission_fences AS fence
					            WHERE fence.session_id = agent_session_child_runs.child_session_id
					         )
					         AND (state = 'queued' OR
					              (state = 'claimed' AND materialized_at IS NULL AND claim_expires_at <= ?))
					       RETURNING *`,
					args: [
						claim.consumer,
						claimToken,
						claim.now,
						checkedBudgetSum(claim.now, claim.leaseMs),
						claim.now,
						childRunId,
						claim.now,
					],
				});
				if (updated.rows[0]) {
					run = rowToAgentSessionChildRun(updated.rows[0]);
					claimed = true;
				}
			}
			const relationDepth = await agentSessionDepthTx(tx, child.session_id);
			return { run, child, spec: agentNodeSpecFromChildSession(child, childRunId, relationDepth), claimed };
		}, "CAS");
	}

	async renewAgentSessionChildRunLease(
		childRunId: string,
		input: RenewAgentSessionChildRunLeaseInput,
	): Promise<AgentSessionChildRunRecord> {
		const fence = validateChildRunLeaseInput(input);
		return this.tx(async (tx) => {
			const run = await requireAgentSessionChildRunTx(tx, childRunId);
			assertActiveChildRunLease(run, fence, ["claimed", "cancelling"]);
			const updated = await tx.execute({
				sql: `UPDATE agent_session_child_runs
				         SET heartbeat_at = ?, claim_expires_at = ?
				       WHERE child_run_id = ? AND state IN ('claimed', 'cancelling')
					         AND consumer = ? AND claim_token = ? AND claim_expires_at > ? AND heartbeat_at <= ?
					         AND ? >= claim_expires_at
				         AND NOT EXISTS (
				           SELECT 1 FROM agent_materialization_supervision AS supervision
				            WHERE supervision.session_id = agent_session_child_runs.child_session_id
				              AND supervision.generation = agent_session_child_runs.materialization_generation
				              AND supervision.recovery_token IS NOT NULL
				         )
				       RETURNING *`,
				args: [
					fence.now,
					checkedBudgetSum(fence.now, fence.leaseMs),
					childRunId,
					fence.consumer,
					fence.claimToken,
					fence.now,
					fence.now,
					checkedBudgetSum(fence.now, fence.leaseMs),
				],
			});
			if (!updated.rows[0])
				throw new AgentSessionChildRunFault("lease_lost", `child run ${childRunId} lost its lease`);
			return rowToAgentSessionChildRun(updated.rows[0]);
		}, "CAS");
	}

	/** Reserve generation zero under the exact run lease without claiming an OS body. */
	async claimAgentSessionChildMaterialization(
		childRunId: string,
		input: ClaimAgentSessionChildMaterializationInput,
	): Promise<AgentMaterializationRecord> {
		const fence = validateChildRunMaterializationInput(input);
		return this.tx(async (tx) => {
			const run = await requireAgentSessionChildRunTx(tx, childRunId);
			assertActiveChildRunLease(run, fence, ["claimed"]);
			if (run.materialized_at !== null) {
				const existing = await readAgentMaterializationTx(tx, run.child_session_id, fence.generation);
				if (run.materialization_generation === fence.generation && existing?.activation_id === fence.activationId) {
					await assertLiveLatestMaterializationActivationTx(
						tx,
						run.child_session_id,
						fence.generation,
						fence.activationId,
					);
					return existing;
				}
				throw new AgentSessionChildRunFault(
					"materialization_conflict",
					`child run ${childRunId} already bound a different materialization`,
				);
			}
			const materialization = await claimAgentMaterializationTx(tx, run.child_session_id, {
				generation: fence.generation,
				activationId: fence.activationId,
				now: fence.now,
			});
			return materialization;
		}, "CAS");
	}

	/**
	 * Settle a hosted child launch that failed before any OS worker was observed.
	 * The exact launch sentinel is removed under the live run lease; no
	 * materialization/body testimony is manufactured for a process that never
	 * existed.
	 */
	async failUnboundAgentSessionChildRun(
		childRunId: string,
		input: ClaimAgentSessionChildMaterializationInput & { readonly error: string },
	): Promise<{
		run: AgentSessionChildRunRecord;
		allocation: AgentSessionChildBudgetAllocationRecord;
		applied: boolean;
	}> {
		const fence = validateChildRunMaterializationInput(input);
		const error = requiredChildRunText(input.error, "unbound child launch failure", 2048);
		const terminalDigest = digestChildRunTerminal({
			childRunId,
			status: "failed",
			terminalPolicy: "close",
			materializationGeneration: null,
			materializationState: "not_materialized",
			result: null,
			error,
		});
		return this.tx(async (tx) => {
			const run = await requireAgentSessionChildRunTx(tx, childRunId);
			assertChildRunLeaseIdentity(run, fence);
			if (isTerminalAgentSessionChildRunState(run.state)) {
				if (run.state !== "failed" || run.terminal_digest !== terminalDigest) {
					throw new AgentSessionChildRunFault(
						"terminal_conflict",
						"unbound child launch failure changed on replay",
					);
				}
				return {
					run,
					allocation: await requireChildAllocationForRunTx(tx, childRunId),
					applied: false,
				};
			}
			assertActiveChildRunLease(run, fence, ["claimed"]);
			if (run.materialized_at !== null || run.materialization_generation !== null || fence.generation !== 0) {
				throw new AgentSessionChildRunFault(
					"materialization_conflict",
					"unbound child launch failure cannot replace admitted body testimony",
				);
			}
			const materialization = await readAgentMaterializationTx(tx, run.child_session_id, fence.generation);
			if (
				!materialization ||
				materialization.activation_id !== fence.activationId ||
				materialization.state !== "claimed" ||
				materialization.sandbox_id !== `claim:${fence.activationId}`
			) {
				throw new AgentSessionChildRunFault(
					"materialization_conflict",
					"unbound child launch failure lost its exact launch sentinel",
				);
			}
			const bodies = await tx.execute({
				sql: "SELECT 1 AS found FROM agent_session_body_states WHERE session_id = ? AND generation = ? LIMIT 1",
				args: [run.child_session_id, fence.generation],
			});
			if (bodies.rows[0]) {
				throw new AgentSessionChildRunFault(
					"materialization_conflict",
					"unbound child launch failure cannot erase body testimony",
				);
			}
			const deletedSupervision = await tx.execute({
				sql: `DELETE FROM agent_materialization_supervision
				      WHERE session_id = ? AND generation = ? AND activation_id = ?
				        AND recovery_token IS NULL`,
				args: [run.child_session_id, fence.generation, fence.activationId],
			});
			if (deletedSupervision.rowsAffected !== 1) {
				throw new AgentSessionChildRunFault("lease_lost", "unbound child launch lost its supervision fence");
			}
			const deletedMaterialization = await tx.execute({
				sql: `DELETE FROM agent_materializations
				      WHERE session_id = ? AND generation = ? AND activation_id = ?
				        AND state = 'claimed' AND sandbox_id = 'claim:' || activation_id`,
				args: [run.child_session_id, fence.generation, fence.activationId],
			});
			if (deletedMaterialization.rowsAffected !== 1) {
				throw new AgentSessionChildRunFault("lease_lost", "unbound child launch lost its claim sentinel");
			}

			const admission = await requireChildAdmissionForRunTx(tx, run);
			const allocation = await requireChildAllocationForRunTx(tx, childRunId);
			if (allocation.state !== "reserved") {
				throw new AgentSessionChildRunFault(
					"accounting_blocked",
					"unbound child launch failure requires a reserved allocation",
				);
			}
			const childAccount = await requireAgentSessionBudgetAccountTx(
				tx,
				run.child_session_id,
				budgetVectorFromChildSlice(allocation.budget),
			);
			if (
				AGENT_SESSION_BUDGET_DIMENSIONS.some(
					(dimension) => childAccount.reserved[dimension] !== 0 || childAccount.spent[dimension] !== 0,
				)
			) {
				throw new AgentSessionChildRunFault(
					"accounting_blocked",
					"unbound child launch failure cannot release a non-zero child account",
				);
			}
			await releaseAgentSessionChildGenerationOccupancyTx(tx, run.child_session_id, fence.generation, fence.now);
			await applyAgentSessionBudgetLedgerEntryTx(tx, {
				sessionId: run.parent_session_id,
				kind: "child_released",
				referenceId: allocation.allocation_id,
				reservedDelta: negateAgentSessionBudget(budgetVectorFromChildSlice(allocation.budget)),
				spentDelta: ZERO_AGENT_SESSION_BUDGET,
				detail: {
					schema: "choreograph.agent-session-budget-child-released.v1",
					allocationId: allocation.allocation_id,
					childSessionId: run.child_session_id,
					reason: "failed_before_materialization",
				},
				now: fence.now,
			});
			const released = await tx.execute({
				sql: `UPDATE agent_session_child_budget_allocations
				         SET state = 'released', settled_at = ?
				       WHERE allocation_id = ? AND state = 'reserved'`,
				args: [fence.now, allocation.allocation_id],
			});
			if (released.rowsAffected !== 1) {
				throw new AgentSessionChildRunFault("accounting_blocked", "unbound child allocation release lost its CAS");
			}
			const terminal = await tx.execute({
				sql: `UPDATE agent_session_child_runs
				         SET state = 'failed', error = ?, terminal_digest = ?, terminal_at = ?
				       WHERE child_run_id = ? AND state = 'claimed' AND consumer = ? AND claim_token = ?
				         AND materialized_at IS NULL AND materialization_generation IS NULL
				         AND claim_expires_at > ? AND heartbeat_at <= ?`,
				args: [
					error,
					terminalDigest,
					fence.now,
					childRunId,
					fence.consumer,
					fence.claimToken,
					fence.now,
					fence.now,
				],
			});
			if (terminal.rowsAffected !== 1) {
				throw new AgentSessionChildRunFault("lease_lost", "unbound child launch failure lost its run lease");
			}
			await terminalizeAgentSessionLifecycleTx(tx, run.child_session_id, "closed", childRunId, fence.now);
			await tx.execute({
				sql: "UPDATE agent_sessions SET status = 'failed', completed_at = ?, updated_at = ? WHERE session_id = ?",
				args: [fence.now, fence.now, run.child_session_id],
			});
			await appendAgentSessionEventTx(tx, run.parent_session_id, {
				type: "child.run.failed",
				ts: fence.now,
				payload: agentSessionChildRunResultPayload({
					run,
					admission,
					allocation,
					status: "failed",
					terminalPolicy: "close",
					materialization: null,
					result: null,
					error,
					recovered: false,
				}),
			});
			await appendAgentSessionEventTx(tx, run.child_session_id, {
				type: "session.closed",
				ts: fence.now,
				payload: {
					schema: "choreograph.agent-session-lifecycle.v1",
					sessionId: run.child_session_id,
					state: "closed",
					childRunId,
				},
			});
			await advanceAgentSessionCascadesContainingMemberTx(tx, run.child_session_id, fence.now);
			return {
				run: await requireAgentSessionChildRunTx(tx, childRunId),
				allocation: { ...allocation, state: "released", settled_at: fence.now },
				applied: true,
			};
		}, "CAS");
	}

	/** Immutable cancellation intent with cancel-vs-terminal first-wins semantics. */
	async progressAgentSessionDescendantCascade(
		cascadeId: string,
		input: { readonly now: number },
	): Promise<AgentSessionDescendantCascadeRecord> {
		const canonicalCascadeId = requiredChildRunText(cascadeId, "descendant cascade id", 128);
		validateChildRunTimestamp(input.now, "descendant cascade progress time");
		return this.tx(async (tx) => {
			await advanceAgentSessionDescendantCascadeTx(tx, canonicalCascadeId, input.now);
			const result = await tx.execute({
				sql: "SELECT * FROM agent_session_descendant_cascades WHERE cascade_id = ?",
				args: [canonicalCascadeId],
			});
			if (!result.rows[0]) throw new AgentSessionChildRunFault("run_not_found", "descendant cascade is missing");
			return rowToAgentSessionDescendantCascade(result.rows[0]);
		}, "CAS");
	}

	/** Immutable cancellation intent with cancel-vs-terminal first-wins semantics. */
	async requestAgentSessionCancellation(
		sessionId: string,
		input: {
			readonly requestId: string;
			readonly actor: { readonly kind: "owner_api"; readonly ownerUserId: string };
			readonly reason: string;
			readonly now: number;
		},
	): Promise<{ cascade: AgentSessionDescendantCascadeRecord; applied: boolean }> {
		const requestId = requiredChildRunText(input.requestId, "Session cancellation request id", 128);
		const reason = requiredChildRunText(input.reason, "Session cancellation reason", 2048);
		validateChildRunTimestamp(input.now, "Session cancellation time");
		if (input.actor?.kind !== "owner_api") {
			throw new AgentSessionChildRunFault("authority_invalid", "Session cancellation requires owner API authority");
		}
		const ownerUserId = requiredChildRunText(input.actor.ownerUserId, "Session cancellation owner", 256);
		const requestDigest = digestJson({
			schema: "choreograph.agent-session-cancellation.v1",
			sessionId,
			reason,
			actor: { kind: "owner_api", ownerUserId },
		});
		return this.tx(async (tx) => {
			const replay = await tx.execute({
				sql: "SELECT request_digest, cascade_id FROM agent_session_cancellation_requests WHERE session_id = ? AND request_id = ?",
				args: [sessionId, requestId],
			});
			if (replay.rows[0]) {
				if (String(replay.rows[0].request_digest) !== requestDigest) {
					throw new AgentSessionChildRunFault("cancellation_conflict", "Session cancellation changed on replay");
				}
				const cascade = await tx.execute({
					sql: "SELECT * FROM agent_session_descendant_cascades WHERE cascade_id = ?",
					args: [String(replay.rows[0].cascade_id)],
				});
				return { cascade: rowToAgentSessionDescendantCascade(cascade.rows[0]!), applied: false };
			}
			const session = await readAgentSessionTx(tx, sessionId);
			if (!session) throw new AgentSessionChildRunFault("run_not_found", "Session cancellation target is missing");
			if (session.owner_user_id !== ownerUserId) {
				throw new AgentSessionChildRunFault(
					"authority_invalid",
					"Session cancellation owner does not own the target",
				);
			}
			if (session.lifecycle_state === "closed" || session.lifecycle_state === "faulted") {
				throw new AgentSessionChildRunFault(
					"terminal_conflict",
					"terminal Session cancellation cannot create new intent",
				);
			}
			const cascade = await ensureAgentSessionDescendantCascadeTx(tx, sessionId, {
				cause: "explicit_cancel",
				causeDigest: requestDigest,
				reason,
				now: input.now,
			});
			if (cascade.cause_digest !== requestDigest) {
				throw new AgentSessionChildRunFault(
					"terminal_conflict",
					"a prior terminal cascade already owns this Session lifecycle",
				);
			}
			await tx.execute({
				sql: `INSERT INTO agent_session_cancellation_requests
				        (session_id, request_id, request_digest, actor_json, reason, cascade_id, created_at)
				      VALUES (?, ?, ?, ?, ?, ?, ?)`,
				args: [
					sessionId,
					requestId,
					requestDigest,
					JSON.stringify({ kind: "owner_api", ownerUserId }),
					reason,
					cascade.cascade_id,
					input.now,
				],
			});
			await cancelLiveAgentSessionCommandActivationForSessionTx(tx, session, reason, input.now);
			await advanceAgentSessionDescendantCascadeTx(tx, cascade.cascade_id, input.now);
			const durableCascade = await tx.execute({
				sql: "SELECT * FROM agent_session_descendant_cascades WHERE cascade_id = ?",
				args: [cascade.cascade_id],
			});
			return {
				cascade: rowToAgentSessionDescendantCascade(durableCascade.rows[0]!),
				applied: true,
			};
		}, "CAS");
	}

	/** Immutable cancellation intent with cancel-vs-terminal first-wins semantics. */
	async requestAgentSessionChildCancellation(
		childRunId: string,
		input: RequestAgentSessionChildCancellationInput,
	): Promise<AgentSessionChildCancellationResult> {
		const request = validateChildCancellationInput(childRunId, input);
		return this.tx(async (tx) => {
			const replay = await readAgentSessionChildCancellationRequestTx(tx, childRunId, request.requestId);
			if (replay) {
				if (replay.request_digest !== request.requestDigest) {
					throw new AgentSessionChildRunFault(
						"cancellation_conflict",
						`child run ${childRunId} cancellation request changed on replay`,
					);
				}
				return {
					request: replay,
					run: await requireAgentSessionChildRunTx(tx, childRunId),
					allocation: await requireChildAllocationForRunTx(tx, childRunId),
					applied: false,
				};
			}
			const run = await requireAgentSessionChildRunTx(tx, childRunId);
			await assertChildCancellationActorTx(tx, run, request.actor);
			const terminalPreceded = await agentSessionChildTerminalPrecededTx(tx, run);
			const hasOpenDescendants = terminalPreceded
				? false
				: await hasOpenAgentSessionDescendantsTx(tx, run.child_session_id);
			const {
				disposition,
				applied,
			}: {
				disposition: AgentSessionChildCancellationRequestRecord["disposition"];
				applied: boolean;
			} = terminalPreceded
				? { disposition: "terminal_preceded", applied: false }
				: hasOpenDescendants
					? { disposition: "cancellation_pending", applied: false }
					: await decideAgentSessionChildCancellationTx(tx, run, request.reason, request.now);
			const record: AgentSessionChildCancellationRequestRecord = {
				cancellation_id: childCancellationId(childRunId, request.requestId),
				child_run_id: childRunId,
				request_id: request.requestId,
				request_digest: request.requestDigest,
				actor: request.actor,
				reason: request.reason,
				disposition,
				observed_run_state: run.state,
				created_at: request.now,
			};
			await insertAgentSessionChildCancellationRequestTx(tx, record);
			if (disposition !== "terminal_preceded") {
				await ensureAgentSessionDescendantCascadeTx(tx, run.child_session_id, {
					cause: "explicit_cancel",
					causeDigest: request.requestDigest,
					reason: request.reason,
					now: request.now,
				});
			}
			return {
				request: record,
				run: await requireAgentSessionChildRunTx(tx, childRunId),
				allocation: await requireChildAllocationForRunTx(tx, childRunId),
				applied,
			};
		}, "CAS");
	}

	/** Parent-fenced delete intent for a resident child whose logical run is already terminal. */
	async requestAgentSessionChildClosure(
		childRunId: string,
		input: RequestAgentSessionChildCancellationInput,
	): Promise<{
		request: AgentSessionChildClosureRequestRecord;
		run: AgentSessionChildRunRecord;
		session: AgentSessionRecord;
		applied: boolean;
	}> {
		const normalized = validateChildCancellationInput(childRunId, input);
		return this.tx(async (tx) => {
			const replayResult = await tx.execute({
				sql: `SELECT * FROM agent_session_child_closure_requests
				      WHERE child_run_id = ? AND request_id = ?`,
				args: [childRunId, normalized.requestId],
			});
			if (replayResult.rows[0]) {
				const replay = rowToAgentSessionChildClosureRequest(replayResult.rows[0]);
				if (replay.request_digest !== normalized.requestDigest) {
					throw new AgentSessionChildRunFault(
						"cancellation_conflict",
						`child run ${childRunId} closure request changed on replay`,
					);
				}
				return {
					request: replay,
					run: await requireAgentSessionChildRunTx(tx, childRunId),
					session: await requireChildSessionForRunTx(tx, await requireAgentSessionChildRunTx(tx, childRunId)),
					applied: false,
				};
			}
			const canonicalResult = await tx.execute({
				sql: "SELECT * FROM agent_session_child_closure_requests WHERE child_run_id = ?",
				args: [childRunId],
			});
			if (canonicalResult.rows[0]) {
				const canonical = rowToAgentSessionChildClosureRequest(canonicalResult.rows[0]);
				const canonicalRun = await requireAgentSessionChildRunTx(tx, childRunId);
				await assertChildCancellationActorTx(tx, canonicalRun, normalized.actor);
				return {
					request: canonical,
					run: canonicalRun,
					session: await requireChildSessionForRunTx(tx, canonicalRun),
					applied: false,
				};
			}
			const run = await requireAgentSessionChildRunTx(tx, childRunId);
			if (!isTerminalAgentSessionChildRunState(run.state)) {
				throw new AgentSessionChildRunFault(
					"terminal_conflict",
					"nonterminal child runs must be cancelled, not closed as terminal residents",
				);
			}
			await assertChildCancellationActorTx(tx, run, normalized.actor);
			const session = await requireChildSessionForRunTx(tx, run);
			const record: AgentSessionChildClosureRequestRecord = {
				closure_id: childClosureId(childRunId, normalized.requestId),
				child_run_id: childRunId,
				request_id: normalized.requestId,
				request_digest: normalized.requestDigest,
				actor: normalized.actor,
				reason: normalized.reason,
				disposition: session.lifecycle_state === "closed" ? "already_closed" : "closure_pending",
				created_at: normalized.now,
			};
			await tx.execute({
				sql: `INSERT INTO agent_session_child_closure_requests
				        (closure_id, child_run_id, request_id, request_digest, actor_json,
				         reason, disposition, created_at)
				      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				args: [
					record.closure_id,
					record.child_run_id,
					record.request_id,
					record.request_digest,
					JSON.stringify(record.actor),
					record.reason,
					record.disposition,
					record.created_at,
				],
			});
			if (record.disposition === "closure_pending") {
				await tx.execute({
					sql: `INSERT INTO agent_session_child_closure_work
					        (closure_id, child_run_id, state, created_at, updated_at)
					      VALUES (?, ?, 'pending', ?, ?)`,
					args: [record.closure_id, childRunId, normalized.now, normalized.now],
				});
				await ensureAgentSessionDescendantCascadeTx(tx, run.child_session_id, {
					cause: "explicit_cancel",
					causeDigest: normalized.requestDigest,
					reason: normalized.reason,
					now: normalized.now,
				});
			}
			if (record.disposition === "closure_pending" && session.lifecycle_state === "open") {
				await tx.execute({
					sql: "UPDATE agent_sessions SET lifecycle_state = 'closing', updated_at = ? WHERE session_id = ?",
					args: [normalized.now, session.session_id],
				});
			}
			return {
				request: record,
				run,
				session: (await readAgentSessionTx(tx, session.session_id))!,
				applied: true,
			};
		}, "CAS");
	}

	/** Acquire restart-safe, exclusive ownership of one durable resident-child cleanup. */
	async claimAgentSessionChildClosureWork(input: {
		readonly consumer: string;
		readonly leaseMs: number;
		readonly now: number;
	}): Promise<AgentSessionChildClosureWorkClaim | null> {
		const consumer = requiredChildRunText(input.consumer, "child closure consumer", 256);
		validatePositiveChildRunInteger(input.leaseMs, "child closure lease duration");
		validateChildRunTimestamp(input.now, "child closure claim time");
		return this.tx(async (tx) => {
			const selected = await tx.execute({
				sql: `SELECT work.closure_id, work.child_run_id
				        FROM agent_session_child_closure_work AS work
				        JOIN agent_session_child_runs AS run ON run.child_run_id = work.child_run_id
				        JOIN agent_materializations AS materialization
				          ON materialization.session_id = run.child_session_id
				         AND materialization.generation = (
				           SELECT MAX(latest.generation) FROM agent_materializations AS latest
				            WHERE latest.session_id = run.child_session_id
				         )
				        JOIN agent_materialization_supervision AS supervision
				          ON supervision.session_id = materialization.session_id
				         AND supervision.generation = materialization.generation
				   LEFT JOIN agent_session_child_admissions AS admission ON admission.child_run_id = run.child_run_id
					       WHERE (work.state = 'pending' OR (work.state = 'claimed' AND work.claim_expires_at <= ?))
					         AND materialization.state IN ('passivated', 'completed', 'faulted', 'cancelled')
					         AND (supervision.recovery_token IS NULL OR supervision.recovery_expires_at <= ?
					              OR supervision.recovered_at IS NOT NULL)
					         AND NOT EXISTS (
					           SELECT 1 FROM agent_session_relations AS child_relation
					           JOIN agent_sessions AS descendant ON descendant.session_id = child_relation.child_session_id
					          WHERE child_relation.parent_session_id = run.child_session_id
					            AND descendant.lifecycle_state <> 'closed'
					         )
				       ORDER BY COALESCE(admission.depth, 0) DESC, work.updated_at ASC, work.child_run_id ASC
				       LIMIT 1`,
				args: [input.now, input.now],
			});
			if (!selected.rows[0]) return null;
			const closureId = String(selected.rows[0].closure_id);
			const childRunId = String(selected.rows[0].child_run_id);
			const cleanupToken = randomUUID();
			const expiresAt = checkedBudgetSum(input.now, input.leaseMs);
			const work = await tx.execute({
				sql: `UPDATE agent_session_child_closure_work
				         SET state = 'claimed', attempt = attempt + 1, consumer = ?, cleanup_token = ?,
				             claimed_at = ?, claim_expires_at = ?, heartbeat_at = ?, updated_at = ?
					       WHERE closure_id = ? AND child_run_id = ?
					         AND (state = 'pending' OR (state = 'claimed' AND claim_expires_at <= ?))
					         AND EXISTS (
					           SELECT 1 FROM agent_session_child_runs AS run
					           JOIN agent_materializations AS materialization
					             ON materialization.session_id = run.child_session_id
					            AND materialization.generation = (
					              SELECT MAX(latest.generation) FROM agent_materializations AS latest
					               WHERE latest.session_id = run.child_session_id
					            )
					          WHERE run.child_run_id = agent_session_child_closure_work.child_run_id
					            AND materialization.state IN ('passivated', 'completed', 'faulted', 'cancelled')
					         )`,
				args: [
					consumer,
					cleanupToken,
					input.now,
					expiresAt,
					input.now,
					input.now,
					closureId,
					childRunId,
					input.now,
				],
			});
			if (work.rowsAffected !== 1) return null;
			const owned = await tx.execute({
				sql: `SELECT run.child_session_id, materialization.generation
				        FROM agent_session_child_runs AS run
				        JOIN agent_materializations AS materialization
				          ON materialization.session_id = run.child_session_id
				         AND materialization.generation = (
				           SELECT MAX(latest.generation) FROM agent_materializations AS latest
				            WHERE latest.session_id = run.child_session_id
				         )
					       WHERE run.child_run_id = ?
					         AND materialization.state IN ('passivated', 'completed', 'faulted', 'cancelled')`,
				args: [childRunId],
			});
			if (!owned.rows[0]) {
				throw new AgentSessionChildRunFault("materialization_conflict", "child closure has no latest body");
			}
			const childSessionId = String(owned.rows[0].child_session_id);
			const generation = Number(owned.rows[0].generation);
			const supervision = await tx.execute({
				sql: `UPDATE agent_materialization_supervision
				         SET recovery_attempt = recovery_attempt + 1, recovery_consumer = ?, recovery_token = ?,
				             recovery_claimed_at = ?, recovery_expires_at = ?, recovery_heartbeat_at = ?, recovered_at = NULL
				       WHERE session_id = ? AND generation = ?
				         AND (recovery_token IS NULL OR recovery_expires_at <= ? OR recovered_at IS NOT NULL)`,
				args: [consumer, cleanupToken, input.now, expiresAt, input.now, childSessionId, generation, input.now],
			});
			if (supervision.rowsAffected !== 1) {
				throw new AgentSessionChildRunFault("lease_lost", "child closure could not fence its materialization");
			}
			return requireAgentSessionChildClosureWorkClaimTx(tx, closureId, true);
		}, "CAS");
	}

	async renewAgentSessionChildClosureWorkLease(input: {
		readonly closureId: string;
		readonly consumer: string;
		readonly cleanupToken: string;
		readonly leaseMs: number;
		readonly now: number;
	}): Promise<AgentSessionChildClosureWorkClaim> {
		validatePositiveChildRunInteger(input.leaseMs, "child closure lease duration");
		validateChildRunTimestamp(input.now, "child closure renewal time");
		const expiresAt = checkedBudgetSum(input.now, input.leaseMs);
		return this.tx(async (tx) => {
			const current = await requireAgentSessionChildClosureWorkClaimTx(tx, input.closureId, false);
			if (current.consumer !== input.consumer || current.cleanup_token !== input.cleanupToken) {
				throw new AgentSessionChildRunFault("lease_lost", "child closure lease token is stale");
			}
			const work = await tx.execute({
				sql: `UPDATE agent_session_child_closure_work
				         SET heartbeat_at = ?, claim_expires_at = ?, updated_at = ?
				       WHERE closure_id = ? AND state = 'claimed' AND consumer = ? AND cleanup_token = ?
				         AND claim_expires_at > ? AND heartbeat_at <= ? AND ? >= claim_expires_at`,
				args: [
					input.now,
					expiresAt,
					input.now,
					input.closureId,
					input.consumer,
					input.cleanupToken,
					input.now,
					input.now,
					expiresAt,
				],
			});
			if (work.rowsAffected !== 1) throw new AgentSessionChildRunFault("lease_lost", "child closure lease was lost");
			const recovery = await tx.execute({
				sql: `UPDATE agent_materialization_supervision
				         SET recovery_heartbeat_at = ?, recovery_expires_at = ?
				       WHERE session_id = ? AND generation = ? AND recovery_consumer = ? AND recovery_token = ?
				         AND recovery_expires_at > ? AND recovery_heartbeat_at <= ? AND ? >= recovery_expires_at
				         AND recovered_at IS NULL`,
				args: [
					input.now,
					expiresAt,
					current.session.session_id,
					current.materialization.generation,
					input.consumer,
					input.cleanupToken,
					input.now,
					input.now,
					expiresAt,
				],
			});
			if (recovery.rowsAffected !== 1) {
				throw new AgentSessionChildRunFault("lease_lost", "child closure recovery fence was lost");
			}
			return requireAgentSessionChildClosureWorkClaimTx(tx, input.closureId, false);
		}, "CAS");
	}

	async finalizeAgentSessionChildClosure(
		childRunId: string,
		input: {
			readonly consumer: string;
			readonly cleanupToken: string;
			readonly materializationGeneration: number;
			readonly materializationState: "passivated" | "completed" | "faulted" | "cancelled";
			readonly now: number;
		},
	): Promise<{
		receipt: AgentSessionChildClosureReceiptRecord | null;
		run: AgentSessionChildRunRecord;
		allocation: AgentSessionChildBudgetAllocationRecord;
		applied: boolean;
	}> {
		validateChildRunTimestamp(input.now, "child closure time");
		const consumer = requiredChildRunText(input.consumer, "child closure consumer", 256);
		const cleanupToken = requiredChildRunText(input.cleanupToken, "child closure cleanup token", 256);
		return this.tx(async (tx) => {
			const requestResult = await tx.execute({
				sql: "SELECT * FROM agent_session_child_closure_requests WHERE child_run_id = ?",
				args: [childRunId],
			});
			if (!requestResult.rows[0]) {
				throw new AgentSessionChildRunFault("run_not_found", "child closure request not found");
			}
			const request = rowToAgentSessionChildClosureRequest(requestResult.rows[0]);
			const run = await requireAgentSessionChildRunTx(tx, childRunId);
			const existingReceipt = await tx.execute({
				sql: "SELECT * FROM agent_session_child_closure_receipts WHERE child_run_id = ?",
				args: [childRunId],
			});
			if (existingReceipt.rows[0]) {
				const receipt = rowToAgentSessionChildClosureReceipt(existingReceipt.rows[0]);
				if (
					receipt.materialization_generation !== input.materializationGeneration ||
					receipt.materialization_state !== input.materializationState
				) {
					throw new AgentSessionChildRunFault("terminal_conflict", "child closure replay changed body testimony");
				}
				return {
					receipt,
					run,
					allocation: await requireChildAllocationForRunTx(tx, childRunId),
					applied: false,
				};
			}
			const allocation = await requireChildAllocationForRunTx(tx, childRunId);
			if (request.disposition === "already_closed") {
				return { receipt: null, run, allocation, applied: false };
			}
			const work = await tx.execute({
				sql: `SELECT heartbeat_at, claim_expires_at FROM agent_session_child_closure_work
				      WHERE closure_id = ? AND child_run_id = ? AND state = 'claimed'
				        AND consumer = ? AND cleanup_token = ? AND claim_expires_at > ? AND heartbeat_at <= ?`,
				args: [request.closure_id, childRunId, consumer, cleanupToken, input.now, input.now],
			});
			if (!work.rows[0]) throw new AgentSessionChildRunFault("lease_lost", "child closure cleanup lease was lost");
			const materialization = await readAgentMaterializationTx(
				tx,
				run.child_session_id,
				input.materializationGeneration,
			);
			if (!materialization || materialization.state !== input.materializationState) {
				throw new AgentSessionChildRunFault("materialization_conflict", "child closure body testimony is stale");
			}
			if (materialization.updated_at > input.now) {
				throw new AgentSessionChildRunFault("lease_lost", "child closure time precedes durable body testimony");
			}
			await assertActiveMaterializationRecoveryLeaseTx(tx, run.child_session_id, input.materializationGeneration, {
				consumer,
				recoveryToken: cleanupToken,
				now: input.now,
			});
			await requireClosedAgentSessionDescendantsTx(tx, run.child_session_id);
			await requireReleasedChildRunOccupancyTx(tx, run, materialization);
			const admission = await requireChildAdmissionForRunTx(tx, run);
			const reconciled = await closeExecutedChildAllocationTx(tx, admission, allocation, input.now);
			await terminalizeAgentSessionLifecycleTx(tx, run.child_session_id, "closed", request.closure_id, input.now, {
				allowFaultTombstone: true,
			});
			const receiptDigest = digestJson({
				schema: "choreograph.agent-session-child-closure-receipt.v1",
				closureId: request.closure_id,
				childRunId,
				materializationGeneration: input.materializationGeneration,
				materializationState: input.materializationState,
				sessionState: "closed",
				allocationState: reconciled.state,
			});
			const receipt: AgentSessionChildClosureReceiptRecord = {
				closure_id: request.closure_id,
				child_run_id: childRunId,
				materialization_generation: input.materializationGeneration,
				materialization_state: input.materializationState,
				session_state: "closed",
				allocation_state: reconciled.state,
				receipt_digest: receiptDigest,
				created_at: input.now,
			};
			await tx.execute({
				sql: `INSERT INTO agent_session_child_closure_receipts
				        (closure_id, child_run_id, materialization_generation, materialization_state,
				         session_state, allocation_state, receipt_digest, created_at)
				      VALUES (?, ?, ?, ?, 'closed', ?, ?, ?)`,
				args: [
					receipt.closure_id,
					receipt.child_run_id,
					receipt.materialization_generation,
					receipt.materialization_state,
					receipt.allocation_state,
					receipt.receipt_digest,
					receipt.created_at,
				],
			});
			await appendAgentSessionEventTx(tx, run.child_session_id, {
				type: "session.closed",
				ts: input.now,
				payload: {
					schema: "choreograph.agent-session-lifecycle.v1",
					sessionId: run.child_session_id,
					state: "closed",
					childRunId,
					closureId: request.closure_id,
				},
			});
			const completed = await tx.execute({
				sql: `UPDATE agent_session_child_closure_work
				         SET state = 'completed', consumer = NULL, cleanup_token = NULL,
				             claimed_at = NULL, claim_expires_at = NULL, heartbeat_at = NULL,
				             completed_at = ?, updated_at = ?
				       WHERE closure_id = ? AND child_run_id = ? AND state = 'claimed'
				         AND consumer = ? AND cleanup_token = ?`,
				args: [input.now, input.now, request.closure_id, childRunId, consumer, cleanupToken],
			});
			if (completed.rowsAffected !== 1) {
				throw new AgentSessionChildRunFault("lease_lost", "child closure completion lost its lease");
			}
			await completeAgentMaterializationRecoveryTx(
				tx,
				run.child_session_id,
				input.materializationGeneration,
				input.now,
			);
			return { receipt, run, allocation: reconciled, applied: true };
		}, "CAS");
	}

	/** Finalize a leased run only after body and occupancy truth establish a terminal barrier. */
	async settleAgentSessionChildRun(
		childRunId: string,
		input: SettleAgentSessionChildRunInput,
	): Promise<{
		run: AgentSessionChildRunRecord;
		allocation: AgentSessionChildBudgetAllocationRecord;
		applied: boolean;
	}> {
		const settlement = validateChildRunSettlementInput(childRunId, input);
		return this.tx(async (tx) => {
			const existing = await requireAgentSessionChildRunTx(tx, childRunId);
			assertChildRunLeaseIdentity(existing, settlement);
			if (isTerminalAgentSessionChildRunState(existing.state)) {
				if (existing.terminal_digest !== settlement.terminalDigest) {
					throw new AgentSessionChildRunFault(
						"terminal_conflict",
						`child run ${childRunId} was replayed with different terminal testimony`,
					);
				}
				return {
					run: existing,
					allocation: await requireChildAllocationForRunTx(tx, childRunId),
					applied: false,
				};
			}
			assertActiveChildRunLease(
				existing,
				settlement,
				settlement.status === "cancelled" ? ["cancelling"] : ["claimed"],
			);
			const admission = await requireChildAdmissionForRunTx(tx, existing);
			const child = await requireChildSessionForRunTx(tx, existing);
			const runtimeKind = childRuntimeKindFromDocument(
				child.document_json,
				existing.child_session_id,
				admission.runtime_binding_digest,
			);
			let allocation = await requireChildAllocationForRunTx(tx, childRunId);
			const materialization = await requireChildRunExpectedMaterializationTx(tx, existing, settlement);
			await assertChildRunLogicalOutcomeTx(tx, existing, settlement, materialization);
			const irrecoverableFault = materialization.state === "faulted" && materialization.recoverable === false;
			const sessionCorruptionFault =
				irrecoverableFault && agentMaterializationFaultRequiresSessionFault(materialization.fault_kind);
			const closesSession = runtimeKind === "simple" || settlement.status === "cancelled" || irrecoverableFault;
			if (runtimeKind === "simple" && settlement.terminalPolicy !== "close") {
				throw new AgentSessionChildRunFault("terminal_conflict", "simple child settlement must close its Session");
			}
			if (
				runtimeKind === "simple" &&
				((settlement.status === "completed" && materialization.state !== "completed") ||
					(settlement.status === "failed" && !["completed", "faulted"].includes(materialization.state)) ||
					(settlement.status === "cancelled" && !["cancelled", "faulted"].includes(materialization.state)))
			) {
				throw new AgentSessionChildRunFault(
					"terminal_conflict",
					"simple child terminal result diverges from its terminal materialization",
				);
			}
			if (runtimeKind === "prime") {
				if (settlement.status === "completed") {
					if (settlement.terminalPolicy !== "keep_open" || materialization.state !== "running") {
						throw new AgentSessionChildRunFault(
							"terminal_conflict",
							"resident Prime completion requires a running body and keep_open policy",
						);
					}
				} else if (settlement.status === "failed") {
					const recoverableResidentFailure =
						materialization.state === "running" ||
						(materialization.state === "faulted" && materialization.recoverable === true);
					if (
						(recoverableResidentFailure && settlement.terminalPolicy !== "keep_open") ||
						(irrecoverableFault && settlement.terminalPolicy !== "close") ||
						(!recoverableResidentFailure && !irrecoverableFault)
					) {
						throw new AgentSessionChildRunFault(
							"terminal_conflict",
							"Prime failure policy diverges from its durable body state",
						);
					}
				} else if (
					settlement.terminalPolicy !== "close" ||
					!["cancelled", "faulted"].includes(materialization.state)
				) {
					throw new AgentSessionChildRunFault(
						"terminal_conflict",
						"Prime cancellation requires a cancelled body and close policy",
					);
				}
			}
			if (closesSession) {
				await requireClosedAgentSessionDescendantsTx(tx, child.session_id);
				await requireReleasedChildRunOccupancyTx(tx, existing, materialization);
				allocation = await closeExecutedChildAllocationTx(tx, admission, allocation, settlement.now);
			}
			const lifecycleState: AgentSessionLifecycleState = sessionCorruptionFault
				? "faulted"
				: closesSession
					? "closed"
					: "open";
			if (closesSession) {
				await terminalizeAgentSessionLifecycleTx(
					tx,
					child.session_id,
					lifecycleState as "closed" | "faulted",
					childRunId,
					settlement.now,
				);
			} else {
				await reopenRecoverableAgentSessionTx(tx, child.session_id, settlement.now);
			}
			const terminalUpdate = await tx.execute({
				sql: `UPDATE agent_session_child_runs
				         SET state = ?, result_json = ?, error = ?, terminal_digest = ?, terminal_at = ?
				       WHERE child_run_id = ? AND state = ? AND consumer = ? AND claim_token = ?
				         AND claim_expires_at > ? AND heartbeat_at <= ?`,
				args: [
					settlement.status,
					settlement.resultJson,
					settlement.error,
					settlement.terminalDigest,
					settlement.now,
					childRunId,
					existing.state,
					settlement.consumer,
					settlement.claimToken,
					settlement.now,
					settlement.now,
				],
			});
			if (terminalUpdate.rowsAffected !== 1) {
				throw new AgentSessionChildRunFault("lease_lost", `child run ${childRunId} lost its settlement fence`);
			}
			await tx.execute({
				sql: "UPDATE agent_sessions SET status = ?, updated_at = ?, completed_at = ? WHERE session_id = ?",
				args: [
					settlement.status,
					settlement.now,
					closesSession ? settlement.now : child.completed_at,
					child.session_id,
				],
			});
			await appendAgentSessionEventTx(tx, existing.parent_session_id, {
				type: `child.run.${settlement.status}`,
				ts: settlement.now,
				payload: agentSessionChildRunResultPayload({
					run: existing,
					admission,
					allocation,
					status: settlement.status,
					terminalPolicy: settlement.terminalPolicy,
					materialization: {
						generation: settlement.materializationGeneration,
						state: materialization.state,
					},
					result: input.result === undefined ? null : input.result,
					error: settlement.error,
					recovered: false,
				}),
			});
			if (closesSession) {
				await appendAgentSessionEventTx(tx, child.session_id, {
					type: lifecycleState === "faulted" ? "session.faulted" : "session.closed",
					ts: settlement.now,
					payload: {
						schema: "choreograph.agent-session-lifecycle.v1",
						sessionId: child.session_id,
						state: lifecycleState,
						childRunId,
						...(materialization?.state === "faulted"
							? {
									faultKind: materialization.fault_kind,
									recoverable: materialization.recoverable,
								}
							: {}),
					},
				});
			}
			await advanceAgentSessionCascadesContainingMemberTx(tx, child.session_id, settlement.now);
			return {
				run: await requireAgentSessionChildRunTx(tx, childRunId),
				allocation,
				applied: true,
			};
		}, "CAS");
	}

	async readAgentSessionParent(childSessionId: string): Promise<AgentSessionChildRelationRecord | null> {
		const result = await this.read({
			sql: "SELECT * FROM agent_session_relations WHERE child_session_id = ?",
			args: [childSessionId],
		});
		return result.rows[0] ? rowToAgentSessionChildRelation(result.rows[0]) : null;
	}

	async listAgentSessionChildren(parentSessionId: string): Promise<AgentSessionChildRelationRecord[]> {
		const result = await this.read({
			sql: `
				SELECT * FROM agent_session_relations
				 WHERE parent_session_id = ?
				 ORDER BY created_at ASC, child_session_id ASC
			`,
			args: [parentSessionId],
		});
		return result.rows.map(rowToAgentSessionChildRelation);
	}

	async listAgentSessionChildControls(
		parentSessionId: string,
		input: { readonly includeClosed?: boolean } = {},
	): Promise<AgentSessionChildControlRecord[]> {
		const result = await this.read({
			sql: `SELECT admission.child_session_id, admission.child_run_id, admission.child_name,
			             child.model, run.state AS run_state, child.lifecycle_state AS session_state
			        FROM agent_session_child_admissions AS admission
			        JOIN agent_sessions AS child ON child.session_id = admission.child_session_id
			        JOIN agent_session_child_runs AS run ON run.child_run_id = admission.child_run_id
			       WHERE admission.parent_session_id = ?
			         AND (? OR child.lifecycle_state <> 'closed')
			       ORDER BY admission.created_at ASC, admission.child_session_id ASC`,
			args: [parentSessionId, input.includeClosed ? 1 : 0],
		});
		return result.rows.map(rowToAgentSessionChildControl);
	}

	async resolveAgentSessionChildControl(
		parentSessionId: string,
		childRunId: string,
	): Promise<AgentSessionChildControlRecord | null> {
		const canonicalChildRunId = requireCanonicalAgentSessionChildRunId(childRunId);
		const result = await this.read({
			sql: `SELECT admission.child_session_id, admission.child_run_id, admission.child_name,
			             child.model, run.state AS run_state, child.lifecycle_state AS session_state
			        FROM agent_session_child_admissions AS admission
			        JOIN agent_sessions AS child ON child.session_id = admission.child_session_id
			        JOIN agent_session_child_runs AS run ON run.child_run_id = admission.child_run_id
			       WHERE admission.parent_session_id = ? AND admission.child_run_id = ?`,
			args: [parentSessionId, canonicalChildRunId],
		});
		return result.rows[0] ? rowToAgentSessionChildControl(result.rows[0]) : null;
	}

	async claimAgentSessionFamilyProjectionOutbox(input: {
		readonly consumer: string;
		readonly leaseMs: number;
		readonly now: number;
	}): Promise<AgentSessionFamilyProjectionOutboxClaim | null> {
		const consumer = requiredChildRunText(input.consumer, "family projection consumer", 256);
		validatePositiveChildRunInteger(input.leaseMs, "family projection lease duration");
		validateChildRunTimestamp(input.now, "family projection claim time");
		return this.tx(async (tx) => {
			const selected = await tx.execute({
				sql: `SELECT root_session_id FROM agent_session_family_projection_outbox
				       WHERE ((state = 'pending' AND delivered_revision < desired_revision AND not_before <= ?)
				          OR (state = 'claimed' AND claim_expires_at <= ?))
				       ORDER BY updated_at ASC, root_session_id ASC LIMIT 1`,
				args: [input.now, input.now],
			});
			if (!selected.rows[0]) return null;
			const rootSessionId = String(selected.rows[0].root_session_id);
			const claimToken = randomUUID();
			const updated = await tx.execute({
				sql: `UPDATE agent_session_family_projection_outbox
					         SET state = 'claimed', claimed_revision = desired_revision,
					             claimed_projection_revision = (SELECT revision FROM agent_session_family_projection_clock WHERE singleton = 1),
				             consumer = ?, claim_token = ?, claimed_at = ?, claim_expires_at = ?, heartbeat_at = ?,
				             updated_at = ?
				       WHERE root_session_id = ?
				         AND ((state = 'pending' AND delivered_revision < desired_revision AND not_before <= ?)
				           OR (state = 'claimed' AND claim_expires_at <= ?))
				       RETURNING *`,
				args: [
					consumer,
					claimToken,
					input.now,
					checkedBudgetSum(input.now, input.leaseMs),
					input.now,
					input.now,
					rootSessionId,
					input.now,
					input.now,
				],
			});
			if (!updated.rows[0]) return null;
			const work = rowToAgentSessionFamilyProjectionOutbox(updated.rows[0]);
			const snapshot =
				work.work_kind === "project"
					? await this.readAgentSessionFamilyProjectionSnapshot(work.root_session_id, tx)
					: null;
			if (
				work.work_kind === "project" &&
				(!snapshot || snapshot.projectionRevision !== work.claimed_projection_revision)
			) {
				throw new AgentSessionChildRunFault(
					"terminal_conflict",
					"family projection claim did not bind its exact atomic snapshot",
				);
			}
			return { work, snapshot };
		}, "CAS");
	}

	async readAgentSessionFamilyProjectionOutboxNextAvailableAt(now: number): Promise<number | null> {
		validateChildRunTimestamp(now, "family projection availability time");
		const result = await this.read({
			sql: `SELECT MIN(
			         CASE
			           WHEN state = 'pending' AND delivered_revision < desired_revision THEN MAX(not_before, ?)
			           WHEN state = 'claimed' THEN MAX(claim_expires_at, ?)
			         END
			       ) AS next_available_at
			  FROM agent_session_family_projection_outbox
			 WHERE (state = 'pending' AND delivered_revision < desired_revision) OR state = 'claimed'`,
			args: [now, now],
		});
		const value = result.rows[0]?.next_available_at;
		return value == null ? null : requiredProjectionInteger(value, "family projection next availability");
	}

	async renewAgentSessionFamilyProjectionOutboxLease(input: {
		readonly rootSessionId: string;
		readonly consumer: string;
		readonly claimToken: string;
		readonly leaseMs: number;
		readonly now: number;
	}): Promise<AgentSessionFamilyProjectionOutboxRecord> {
		validatePositiveChildRunInteger(input.leaseMs, "family projection lease duration");
		validateChildRunTimestamp(input.now, "family projection renewal time");
		const result = await this.write(
			{
				sql: `UPDATE agent_session_family_projection_outbox
				         SET heartbeat_at = ?, claim_expires_at = ?, updated_at = ?
				       WHERE root_session_id = ? AND state = 'claimed' AND consumer = ? AND claim_token = ?
					         AND claim_expires_at > ? AND heartbeat_at <= ?
					         AND ? >= claim_expires_at RETURNING *`,
				args: [
					input.now,
					checkedBudgetSum(input.now, input.leaseMs),
					input.now,
					input.rootSessionId,
					input.consumer,
					input.claimToken,
					input.now,
					input.now,
					checkedBudgetSum(input.now, input.leaseMs),
				],
			},
			"CAS",
		);
		if (!result.rows[0]) throw new AgentSessionChildRunFault("lease_lost", "family projection lease was lost");
		return rowToAgentSessionFamilyProjectionOutbox(result.rows[0]);
	}

	async completeAgentSessionFamilyProjectionOutbox(input: {
		readonly rootSessionId: string;
		readonly consumer: string;
		readonly claimToken: string;
		readonly workKind: "project" | "retire";
		readonly projectedRevision: number;
		readonly now: number;
	}): Promise<AgentSessionFamilyProjectionOutboxRecord> {
		validateChildRunTimestamp(input.now, "family projection completion time");
		const projectedRevision = requiredProjectionInteger(
			input.projectedRevision,
			"family projection delivered graph revision",
		);
		const result = await this.write(
			{
				sql: `UPDATE agent_session_family_projection_outbox
				         SET delivered_revision = MAX(delivered_revision, claimed_revision),
				             delivered_projection_revision = MAX(delivered_projection_revision, ?),
				             state = CASE WHEN desired_revision <= claimed_revision THEN 'delivered' ELSE 'pending' END,
				             claimed_revision = NULL, claimed_projection_revision = NULL,
				             consumer = NULL, claim_token = NULL,
				             claimed_at = NULL, claim_expires_at = NULL, heartbeat_at = NULL,
				             not_before = 0, last_error = NULL, updated_at = ?
					       WHERE root_session_id = ? AND work_kind = ?
					         AND state = 'claimed' AND consumer = ? AND claim_token = ?
					         AND claim_expires_at > ? AND heartbeat_at <= ?
					         AND ? = claimed_projection_revision AND ? >= delivered_projection_revision
				         AND ? <= (SELECT revision FROM agent_session_family_projection_clock WHERE singleton = 1)
				       RETURNING *`,
				args: [
					projectedRevision,
					input.now,
					input.rootSessionId,
					input.workKind,
					input.consumer,
					input.claimToken,
					input.now,
					input.now,
					projectedRevision,
					projectedRevision,
					projectedRevision,
				],
			},
			"CAS",
		);
		if (!result.rows[0]) throw new AgentSessionChildRunFault("lease_lost", "family projection completion lost claim");
		return rowToAgentSessionFamilyProjectionOutbox(result.rows[0]);
	}

	async retryAgentSessionFamilyProjectionOutbox(input: {
		readonly rootSessionId: string;
		readonly consumer: string;
		readonly claimToken: string;
		readonly error: string;
		readonly retryAt: number;
		readonly now: number;
	}): Promise<AgentSessionFamilyProjectionOutboxRecord> {
		const error = requiredChildRunText(input.error, "family projection retry error", 2048);
		validateChildRunTimestamp(input.now, "family projection retry time");
		validateChildRunTimestamp(input.retryAt, "family projection retry instant");
		if (input.retryAt < input.now) {
			throw new AgentSessionChildRunFault("lease_lost", "family projection retry cannot predate its claim action");
		}
		const result = await this.write(
			{
				sql: `UPDATE agent_session_family_projection_outbox
					         SET state = 'pending', claimed_revision = NULL, claimed_projection_revision = NULL,
					             consumer = NULL, claim_token = NULL,
				             claimed_at = NULL, claim_expires_at = NULL, heartbeat_at = NULL,
				             not_before = ?, last_error = ?, updated_at = ?
				       WHERE root_session_id = ? AND state = 'claimed' AND consumer = ? AND claim_token = ?
				         AND claim_expires_at > ? AND heartbeat_at <= ? RETURNING *`,
				args: [
					input.retryAt,
					error,
					input.now,
					input.rootSessionId,
					input.consumer,
					input.claimToken,
					input.now,
					input.now,
				],
			},
			"CAS",
		);
		if (!result.rows[0]) throw new AgentSessionChildRunFault("lease_lost", "family projection retry lost claim");
		return rowToAgentSessionFamilyProjectionOutbox(result.rows[0]);
	}

	/**
	 * Read the bounded, content-free family facts consumed by the graph projector.
	 * The caller may name any member: the first recursive walk follows immutable
	 * parent edges to the canonical root, and the second collects that root's full
	 * descendant tree. One SQL snapshot prevents a descendant from being paired
	 * with an admission or materialization from a different read. The registry's
	 * cycle/reparent guards make both `UNION ALL` walks finite and unique.
	 */
	async readAgentSessionFamilyProjection(sessionId: string): Promise<AgentSessionFamilyProjectionSnapshot | null> {
		return this.readAgentSessionFamilyProjectionSnapshot(sessionId);
	}

	private async readAgentSessionFamilyProjectionSnapshot(
		sessionId: string,
		tx?: RuntimeTx,
	): Promise<AgentSessionFamilyProjectionSnapshot | null> {
		const statement = {
			sql: `
				WITH RECURSIVE ancestors(session_id, distance) AS (
					SELECT ?, 0
					UNION ALL
					SELECT relation.parent_session_id, ancestors.distance + 1
					  FROM agent_session_relations AS relation
					  JOIN ancestors ON relation.child_session_id = ancestors.session_id
				),
				family_root(session_id) AS (
					SELECT ancestors.session_id
					  FROM ancestors
					  LEFT JOIN agent_session_relations AS parent_relation
					    ON parent_relation.child_session_id = ancestors.session_id
					 WHERE parent_relation.relation_id IS NULL
					 ORDER BY ancestors.distance DESC
					 LIMIT 1
				),
				family(
					relation_id, parent_session_id, child_session_id,
					graph_id, created_at, depth
				) AS (
					SELECT relation_id, parent_session_id, child_session_id,
					       graph_id, created_at, 1
					  FROM agent_session_relations
					 WHERE parent_session_id = (SELECT session_id FROM family_root)
					UNION ALL
					SELECT relation.relation_id, relation.parent_session_id, relation.child_session_id,
					       relation.graph_id, relation.created_at, family.depth + 1
					  FROM agent_session_relations AS relation
					  JOIN family ON relation.parent_session_id = family.child_session_id
				)
				SELECT clock.revision AS projection_revision,
				       root.session_id AS root_session_id,
				       root.agent_id AS root_agent_id,
				       root.graph_id AS root_graph_id,
				       root.lifecycle_state AS root_session_state,
				       root_materialization.state AS root_materialization_state,
				       root_materialization.generation AS root_materialization_generation,
				       root_materialization.fault_kind AS root_materialization_fault_kind,
				       root_materialization.recoverable AS root_materialization_recoverable,
				       root_worker_state.state AS root_worker_state,
				       root_kernel_state.state AS root_kernel_state,
				       root.document_json AS root_document_json,
				       (SELECT COUNT(*)
				          FROM agent_session_child_admissions AS direct_admission
				         WHERE direct_admission.parent_session_id = root.session_id) AS root_direct_accepted_children,
				       (SELECT COUNT(*)
				          FROM agent_session_child_generation_occupancy AS direct_occupancy
				         WHERE direct_occupancy.parent_session_id = root.session_id
				           AND direct_occupancy.state = 'occupied') AS root_occupied_children,
				       root_budget_account.limit_cost_usd_micros AS root_budget_cost_max_usd_micros,
				       root_budget_account.reserved_cost_usd_micros AS root_budget_cost_reserved_usd_micros,
				       root_budget_account.spent_cost_usd_micros AS root_budget_cost_spent_usd_micros,
				       root_budget_account.exhausted AS root_budget_account_exhausted,
				       root_budget_account.revision AS root_budget_account_revision,
				       family.relation_id AS family_relation_id,
				       family.parent_session_id AS family_parent_session_id,
				       family.child_session_id AS family_child_session_id,
				       family.graph_id AS family_graph_id,
				       family.created_at AS family_created_at,
				       family.depth AS family_depth,
				       child.agent_id AS child_agent_id,
				       child.graph_id AS child_graph_id,
				       child.lifecycle_state AS child_session_state,
				       child.label AS child_label,
				       child.document_json AS child_document_json,
				       admission.admission_id AS admission_id,
				       admission.child_name AS admission_child_name,
				       admission.depth AS admission_depth,
				       admission.runtime_binding_digest AS admission_runtime_binding_digest,
				       allocation.state AS allocation_state,
				       allocation.hold_reason AS allocation_hold_reason,
				       allocation.budget_json AS allocation_budget_json,
				       child_run.state AS child_run_state,
				       child_budget_account.spent_cost_usd_micros AS child_budget_cost_spent_usd_micros,
				       materialization.state AS materialization_state,
				       materialization.generation AS materialization_generation,
				       materialization.fault_kind AS materialization_fault_kind,
				       materialization.recoverable AS materialization_recoverable,
				       worker_state.state AS worker_state,
				       kernel_state.state AS kernel_state
				  FROM agent_session_family_projection_clock AS clock
				  JOIN family_root ON 1 = 1
				  JOIN agent_sessions AS root ON root.session_id = family_root.session_id
				  LEFT JOIN agent_materializations AS root_materialization
				    ON root_materialization.session_id = root.session_id
				   AND root_materialization.generation = (
				       SELECT MAX(latest.generation) FROM agent_materializations AS latest
				        WHERE latest.session_id = root.session_id
				   )
				  LEFT JOIN agent_session_body_states AS root_worker_state
				    ON root_worker_state.session_id = root_materialization.session_id
				   AND root_worker_state.generation = root_materialization.generation
				   AND root_worker_state.role = 'worker'
				  LEFT JOIN agent_session_body_states AS root_kernel_state
				    ON root_kernel_state.session_id = root_materialization.session_id
				   AND root_kernel_state.generation = root_materialization.generation
				   AND root_kernel_state.role = 'kernel'
				  LEFT JOIN agent_session_budget_accounts AS root_budget_account
				    ON root_budget_account.session_id = root.session_id
				  LEFT JOIN family ON 1 = 1
				  LEFT JOIN agent_sessions AS child
				    ON child.session_id = family.child_session_id
				  LEFT JOIN agent_session_child_admissions AS admission
				    ON admission.relation_id = family.relation_id
				  LEFT JOIN agent_session_child_budget_allocations AS allocation
				    ON allocation.admission_id = admission.admission_id
				  LEFT JOIN agent_session_child_runs AS child_run
				    ON child_run.admission_id = admission.admission_id
				  LEFT JOIN agent_session_budget_accounts AS child_budget_account
				    ON child_budget_account.session_id = family.child_session_id
				  LEFT JOIN agent_materializations AS materialization
				    ON materialization.session_id = family.child_session_id
				   AND materialization.generation = (
				       SELECT MAX(latest.generation)
				         FROM agent_materializations AS latest
				        WHERE latest.session_id = family.child_session_id
				   )
				  LEFT JOIN agent_session_body_states AS worker_state
				    ON worker_state.session_id = materialization.session_id
				   AND worker_state.generation = materialization.generation
				   AND worker_state.role = 'worker'
				  LEFT JOIN agent_session_body_states AS kernel_state
				    ON kernel_state.session_id = materialization.session_id
				   AND kernel_state.generation = materialization.generation
				   AND kernel_state.role = 'kernel'
				 ORDER BY family.depth ASC, family.created_at ASC, family.child_session_id ASC
			`,
			args: [sessionId],
		};
		const result = tx ? await tx.execute(statement) : await this.read(statement);
		const first = result.rows[0];
		if (!first) return null;
		const projectionRevision = requiredProjectionInteger(first.projection_revision, "family projection revision");
		const rootSessionId = requiredProjectionString(first.root_session_id, "family root session");
		const rootConstraints = familyRootProjectionConstraintsFromDocument(
			requiredProjectionString(first.root_document_json, `family root ${rootSessionId} document`),
			rootSessionId,
		);
		const directAcceptedChildren = requiredProjectionInteger(
			first.root_direct_accepted_children,
			"family root direct accepted children",
		);
		const occupiedChildren = requiredProjectionInteger(first.root_occupied_children, "family root occupied children");
		const budgetCostMaxUsdMicros = requiredProjectionInteger(
			first.root_budget_cost_max_usd_micros,
			"family root maximum cost budget",
		);
		const budgetCostReservedUsdMicros = requiredProjectionInteger(
			first.root_budget_cost_reserved_usd_micros,
			"family root reserved cost budget",
		);
		const budgetCostSpentUsdMicros = requiredProjectionInteger(
			first.root_budget_cost_spent_usd_micros,
			"family root spent cost budget",
		);
		const budgetAccountExhausted = requiredProjectionBoolean(
			first.root_budget_account_exhausted,
			"family root budget account exhausted",
		);
		if (budgetCostMaxUsdMicros !== rootConstraints.maxCostUsdMicros) {
			throw new Error(`family root ${rootSessionId} cost account diverges from its pinned runtime binding`);
		}
		if (
			checkedBudgetSum(budgetCostReservedUsdMicros, budgetCostSpentUsdMicros) > budgetCostMaxUsdMicros &&
			!budgetAccountExhausted
		) {
			throw new Error(`family root ${rootSessionId} cost account suppresses exhausted testimony`);
		}
		if (
			directAcceptedChildren > rootConstraints.maxChildren ||
			occupiedChildren > rootConstraints.maxConcurrentChildren ||
			occupiedChildren > directAcceptedChildren
		) {
			throw new Error(`family root ${rootSessionId} child capacity diverges from its pinned runtime binding`);
		}
		const rootModeIri = projectionModeIriFromDocument(
			requiredProjectionString(first.root_document_json, `family root ${rootSessionId} document`),
		);
		const root: AgentSessionFamilyProjectionRoot = {
			sessionId: rootSessionId,
			agentId: nullableString(first.root_agent_id),
			graphId: requiredProjectionString(first.root_graph_id, `family root ${rootSessionId} graph`),
			sessionState: requiredAgentSessionLifecycleState(
				first.root_session_state,
				`family root ${rootSessionId} Session state`,
			),
			...modeIriField(rootModeIri),
			...projectionMaterializationFacts(first, "root", `family root ${rootSessionId}`),
			directAcceptedChildren,
			maxChildren: rootConstraints.maxChildren,
			occupiedChildren,
			maxConcurrentChildren: rootConstraints.maxConcurrentChildren,
			budgetCostSpentUsdMicros,
			budgetCostReservedUsdMicros,
			budgetCostRemainingUsdMicros: Math.max(
				0,
				checkedBudgetDifference(
					budgetCostMaxUsdMicros,
					checkedBudgetSum(budgetCostReservedUsdMicros, budgetCostSpentUsdMicros),
				),
			),
			budgetCostMaxUsdMicros,
			budgetAccountExhausted,
			budgetAccountRevision: requiredProjectionInteger(
				first.root_budget_account_revision,
				"family root budget account revision",
			),
		};
		const children: AgentSessionFamilyProjectionChild[] = [];
		for (const row of result.rows) {
			const relationId = nullableString(row.family_relation_id);
			if (!relationId) continue;
			const childSessionId = requiredProjectionString(row.family_child_session_id, "family child session");
			const childLabel = requiredProjectionString(row.child_label, `family child ${childSessionId} label`);
			const depth = requiredProjectionInteger(row.family_depth, `family child ${childSessionId} depth`);
			const admissionId = nullableString(row.admission_id);
			let admission: AgentSessionFamilyProjectionAdmission | null = null;
			if (admissionId) {
				const admissionChildName = requiredProjectionString(
					row.admission_child_name,
					`family admission ${admissionId} child name`,
				);
				const admissionDepth = requiredProjectionInteger(
					row.admission_depth,
					`family admission ${admissionId} depth`,
				);
				if (admissionChildName !== childLabel || admissionDepth !== depth) {
					throw new Error(`family admission ${admissionId} diverges from its immutable relation`);
				}
				const allocationState = requiredProjectionString(
					row.allocation_state,
					`family admission ${admissionId} allocation state`,
				);
				if (!isAgentSessionChildAllocationState(allocationState)) {
					throw new Error(`family admission ${admissionId} has an invalid allocation state`);
				}
				const budget = parseJson(row.allocation_budget_json);
				if (!isChildBudgetSlice(budget)) {
					throw new Error(`family admission ${admissionId} has an invalid allocation budget`);
				}
				admission = {
					childName: admissionChildName,
					depth: admissionDepth,
					runtimeKind: childRuntimeKindFromDocument(
						requiredProjectionString(row.child_document_json, `family child ${childSessionId} document`),
						childSessionId,
						requiredProjectionString(
							row.admission_runtime_binding_digest,
							`family admission ${admissionId} runtime digest`,
						),
					),
					allocationState,
					allocationHoldKind:
						allocationState === "accounting_hold"
							? requiredAllocationHoldReason(
									row.allocation_hold_reason,
									`family admission ${admissionId} allocation hold`,
								)
							: null,
					settledActualCostUsdMicros:
						allocationState === "settled"
							? requiredProjectionInteger(
									row.child_budget_cost_spent_usd_micros,
									`family admission ${admissionId} settled actual cost`,
								)
							: null,
					budget,
				};
			} else if (
				row.admission_runtime_binding_digest != null ||
				row.allocation_state != null ||
				row.allocation_budget_json != null
			) {
				throw new Error(`family relation ${relationId} has an orphaned budget allocation`);
			}
			const materializationFacts = projectionMaterializationFacts(row, "", `family child ${childSessionId}`);
			const familyGraphId = requiredProjectionString(row.family_graph_id, `family relation ${relationId} graph`);
			const childGraphId = requiredProjectionString(row.child_graph_id, `family child ${childSessionId} graph`);
			if (familyGraphId !== root.graphId || childGraphId !== root.graphId) {
				throw new Error(`family relation ${relationId} crossed its root graph authority boundary`);
			}
			const childRunState = nullableAgentSessionChildRunState(
				row.child_run_state,
				`family child ${childSessionId} run state`,
			);
			if (admission !== null && childRunState === null) {
				throw new Error(`family admission ${admissionId!} lacks its durable child run`);
			}
			children.push({
				relationId,
				parentSessionId: requiredProjectionString(
					row.family_parent_session_id,
					`family relation ${relationId} parent`,
				),
				child: {
					sessionId: childSessionId,
					agentId: nullableString(row.child_agent_id),
					graphId: childGraphId,
					sessionState: requiredAgentSessionLifecycleState(
						row.child_session_state,
						`family child ${childSessionId} Session state`,
					),
					...modeIriField(
						projectionModeIriFromDocument(
							requiredProjectionString(row.child_document_json, `family child ${childSessionId} document`),
						),
					),
				},
				childName: admission?.childName ?? childLabel,
				depth,
				registeredAt: requiredProjectionInteger(row.family_created_at, `family relation ${relationId} time`),
				admission,
				childRunState,
				...materializationFacts,
			});
		}
		return { projectionRevision, root, children };
	}

	async listAgentSessionEvents(sessionId: string): Promise<AgentSessionEvent[]> {
		const result = await this.read({
			sql: "SELECT * FROM agent_session_events WHERE session_id = ? ORDER BY seq ASC",
			args: [sessionId],
		});
		return result.rows.map(rowToAgentSessionEvent);
	}

	async listAgentSessionEventsAfter(sessionId: string, cursor: number): Promise<AgentSessionEvent[]> {
		const result = await this.read({
			sql: "SELECT * FROM agent_session_events WHERE session_id = ? AND seq > ? ORDER BY seq ASC",
			args: [sessionId, cursor],
		});
		return result.rows.map(rowToAgentSessionEvent);
	}

	async listAgentSessionDocumentOps(sessionId: string): Promise<AgentSessionDocumentOp[]> {
		const result = await this.read({
			sql: "SELECT * FROM agent_session_document_ops WHERE session_id = ? ORDER BY rev ASC",
			args: [sessionId],
		});
		return result.rows.map(rowToAgentSessionDocumentOp);
	}

	async listAgentSessionDocumentOpsAfter(sessionId: string, revision: number): Promise<AgentSessionDocumentOp[]> {
		const result = await this.read({
			sql: "SELECT * FROM agent_session_document_ops WHERE session_id = ? AND rev > ? ORDER BY rev ASC",
			args: [sessionId, revision],
		});
		return result.rows.map(rowToAgentSessionDocumentOp);
	}

	async appendAgentSessionEvent(
		sessionId: string,
		event: { type: string; ts?: number; causationId?: string; commandId?: string; payload?: unknown },
	): Promise<number> {
		const ts = event.ts ?? Date.now();
		// One transaction with the catalogue's activity bump, through the same helper every
		// other event writer uses.
		return this.tx(async (tx) => {
			const appended = await appendAgentSessionEventTx(tx, sessionId, {
				type: event.type,
				ts,
				causationId: event.causationId,
				commandId: event.commandId,
				payload: event.payload,
			});
			return appended.seq;
		}, "APPEND");
	}

	/**
	 * Append an event once per `receiptKey` (exam 3, C). The event's `payload.value.receiptKey` must equal `receiptKey`;
	 * when the Session already holds an event with that key, nothing is written and the existing event's seq is
	 * returned, so retrying an append whose outcome is unknown (a commit followed by a lost answer) never duplicates it.
	 * The check and the insert are one write transaction (on a file-backed store `BEGIN IMMEDIATE`, which serializes
	 * writers across store instances on the file). The lookup is by `session_id` (the table's primary key) and guarded
	 * with `json_valid`, so a row whose payload is not JSON cannot make it throw. No index, no schema change.
	 */
	async appendAgentSessionEventOnce(
		sessionId: string,
		receiptKey: string,
		event: { type: string; ts?: number; causationId?: string; commandId?: string; payload?: unknown },
	): Promise<number> {
		const keyed = (event.payload as { value?: { receiptKey?: unknown } } | undefined)?.value?.receiptKey;
		if (keyed !== receiptKey) throw new Error("appendAgentSessionEventOnce: the payload must carry the receiptKey");
		const ts = event.ts ?? Date.now();
		return this.tx(async (tx) => {
			const existing = await tx.execute({
				sql: "SELECT seq FROM agent_session_events WHERE session_id = ? AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.value.receiptKey') END = ?",
				args: [sessionId, receiptKey],
			});
			const seq = existing.rows[0]?.seq;
			if (typeof seq === "number") return seq;
			const appended = await appendAgentSessionEventTx(tx as never, sessionId, {
				type: event.type,
				ts,
				causationId: event.causationId,
				commandId: event.commandId,
				payload: event.payload,
			});
			return appended.seq;
		}, "APPEND");
	}

	async appendAgentSessionEventForGeneration(
		sessionId: string,
		generation: number,
		activationId: string,
		event: { type: string; ts?: number; causationId?: string; commandId?: string; payload?: unknown },
	): Promise<number> {
		return this.tx(async (tx) => {
			await assertLiveLatestMaterializationActivationTx(tx, sessionId, generation, activationId);
			const latest = await tx.execute({
				sql: "SELECT * FROM agent_materializations WHERE session_id = ? ORDER BY generation DESC LIMIT 1",
				args: [sessionId],
			});
			const materialization = latest.rows[0] ? rowToAgentMaterialization(latest.rows[0]) : undefined;
			if (
				!materialization ||
				materialization.generation !== generation ||
				!(["running", "quiescing"] as AgentMaterializationState[]).includes(materialization.state)
			) {
				throw new AgentSessionGenerationFault("Session event belongs to a stale or quiescent materialization");
			}
			return appendAgentSessionEventTx(tx, sessionId, {
				type: event.type,
				ts: event.ts ?? Date.now(),
				causationId: event.causationId,
				commandId: event.commandId,
				payload: event.payload,
			});
		}, "APPEND");
	}

	async appendExecutionCell(
		sessionId: string,
		activationId: string,
		cell: ExecutionCell,
	): Promise<ExecutionCellRecord> {
		if (cell.sessionId !== sessionId) throw new Error("Execution cell session does not match journal partition");
		return this.tx(async (tx) => {
			await assertLiveLatestMaterializationActivationTx(tx, sessionId, cell.generation, activationId);
			await assertPersistentKernelSessionTx(tx, sessionId);
			const existingCell = await tx.execute({
				sql: "SELECT * FROM execution_cells WHERE cell_ref = ?",
				args: [cell.cellRef],
			});
			if (existingCell.rows[0]) {
				const existing = rowToExecutionCell(existingCell.rows[0]);
				if (!executionCellRecordMatchesCell(existing, cell)) {
					throw new AgentSessionGenerationFault("Execution cell identity was replayed with different testimony");
				}
				return existing;
			}
			const session = await readAgentSessionTx(tx, sessionId);
			if (!session) throw new Error(`Agent session not found: ${sessionId}`);
			const materialization = await tx.execute({
				sql: "SELECT * FROM agent_materializations WHERE session_id = ? ORDER BY generation DESC LIMIT 1",
				args: [sessionId],
			});
			const incarnation = materialization.rows[0] ? rowToAgentMaterialization(materialization.rows[0]) : undefined;
			if (
				!incarnation ||
				incarnation.generation !== cell.generation ||
				!(["running", "quiescing"] as AgentMaterializationState[]).includes(incarnation.state)
			) {
				throw new AgentSessionGenerationFault("Execution cell belongs to a stale or absent materialization");
			}
			await tx.execute({
				sql: `INSERT INTO execution_cells
					(session_id, ordinal, generation, cell_ref, lease_id, kernel_sandbox_id, input_id, code,
					 status, execution_count, outputs_json, host_requests_json, cell_digest,
					 started_at, completed_at, duration_ms)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				args: [
					sessionId,
					cell.ordinal,
					cell.generation,
					cell.cellRef,
					cell.leaseId,
					cell.kernelSandboxId,
					cell.inputId,
					cell.code,
					cell.status,
					cell.executionCount ?? null,
					JSON.stringify(cell.outputs),
					JSON.stringify(cell.hostRequests),
					cell.cellDigest,
					cell.startedAt,
					cell.completedAt,
					cell.durationMs,
				],
			});
			const base = agentSessionDocumentFromJson(session.document_json);
			const compute = asRecord(base.compute);
			const order = Array.isArray(compute.order)
				? compute.order.filter((value): value is string => typeof value === "string")
				: [];
			const cells = asRecord(compute.cells);
			const document = {
				...base,
				compute: {
					schema: "choreograph.notebook-projection.v1",
					order: order.includes(cell.cellRef) ? order : [...order, cell.cellRef],
					cells: { ...cells, [cell.cellRef]: cell },
				},
			};
			const documentOp = await appendAgentSessionDocumentOpTx(tx, sessionId, {
				ts: cell.completedAt,
				actor: "choreograph.execution-service",
				kind: "compute.cell",
				patch: { op: "compute.cell.append", path: ["compute", "cells", cell.cellRef], value: cell },
				document,
			});
			await tx.execute({
				sql: "UPDATE agent_sessions SET document_json = ?, updated_at = ? WHERE session_id = ?",
				args: [JSON.stringify(documentOp.document), cell.completedAt, sessionId],
			});
			await appendAgentSessionEventTx(tx, sessionId, {
				type: "compute.cell",
				ts: cell.completedAt,
				payload: {
					schema: "sophia.agent-session-semantic-event.v1",
					sourceType: "execution.compute.cell",
					value: cell,
					documentRevision: documentOp.rev,
					documentChangeId: documentOp.change_id,
				},
			});
			const row = await tx.execute({
				sql: "SELECT * FROM execution_cells WHERE session_id = ? AND generation = ? AND ordinal = ?",
				args: [sessionId, cell.generation, cell.ordinal],
			});
			if (!row.rows[0]) throw new Error(`Execution cell was not journaled: ${cell.cellRef}`);
			return rowToExecutionCell(row.rows[0]);
		}, "APPEND");
	}

	async listExecutionCells(sessionId: string): Promise<ExecutionCellRecord[]> {
		const result = await this.read({
			sql: "SELECT * FROM execution_cells WHERE session_id = ? ORDER BY generation ASC, ordinal ASC",
			args: [sessionId],
		});
		return result.rows.map(rowToExecutionCell);
	}

	async listExecutionJournal(sessionId: string): Promise<ExecutionCell[]> {
		const records = await this.listExecutionCells(sessionId);
		return records.map((record) => ({
			schema: "choreograph.compute-cell.v1",
			cellRef: record.cell_ref,
			sessionId: record.session_id,
			leaseId: record.lease_id,
			kernelSandboxId: record.kernel_sandbox_id,
			inputId: record.input_id,
			ordinal: record.ordinal,
			generation: record.generation,
			code: record.code,
			status: record.status as ExecutionCell["status"],
			...(record.execution_count === null ? {} : { executionCount: record.execution_count }),
			outputs: JSON.parse(record.outputs_json) as ExecutionCell["outputs"],
			startedAt: record.started_at,
			completedAt: record.completed_at,
			durationMs: record.duration_ms,
			hostRequests: JSON.parse(record.host_requests_json) as ExecutionCell["hostRequests"],
			cellDigest: record.cell_digest,
		}));
	}

	async commitKernelReplayWitness(witness: KernelReplayWitness, activationId: string): Promise<void> {
		await this.tx(async (tx) => {
			await assertLiveLatestMaterializationActivationTx(tx, witness.sessionId, witness.generation, activationId);
			await assertPersistentKernelSessionTx(tx, witness.sessionId);
			const existing = await tx.execute({
				sql: `SELECT * FROM kernel_replay_witnesses WHERE session_id = ? AND generation = ?`,
				args: [witness.sessionId, witness.generation],
			});
			if (existing.rows[0]) {
				const exact =
					String(existing.rows[0].journal_head_digest) === witness.journalHeadDigest &&
					canonicalJson(JSON.parse(String(existing.rows[0].namespace_json))) ===
						canonicalJson(witness.namespace) &&
					Number(existing.rows[0].created_at) === witness.createdAt;
				if (!exact) {
					throw new AgentSessionGenerationFault("Kernel replay witness identity names different testimony");
				}
				return;
			}
			const head = await tx.execute({
				sql: `SELECT cell_digest FROM execution_cells
					WHERE session_id = ? ORDER BY generation DESC, ordinal DESC LIMIT 1`,
				args: [witness.sessionId],
			});
			if (String(head.rows[0]?.cell_digest ?? "") !== witness.journalHeadDigest) {
				throw new AgentSessionGenerationFault("Kernel replay witness does not bind the committed journal head");
			}
			await tx.execute({
				sql: `INSERT INTO kernel_replay_witnesses
					(session_id, generation, journal_head_digest, namespace_json, created_at)
					VALUES (?, ?, ?, ?, ?)`,
				args: [
					witness.sessionId,
					witness.generation,
					witness.journalHeadDigest,
					JSON.stringify(witness.namespace),
					witness.createdAt,
				],
			});
		}, "APPEND");
	}

	async readLatestKernelReplayWitness(sessionId: string): Promise<KernelReplayWitness | null> {
		const result = await this.read({
			sql: `SELECT * FROM kernel_replay_witnesses
				WHERE session_id = ? ORDER BY generation DESC LIMIT 1`,
			args: [sessionId],
		});
		const row = result.rows[0];
		if (!row) return null;
		const namespace = JSON.parse(String(row.namespace_json));
		if (!Array.isArray(namespace) || !namespace.every((value) => typeof value === "string")) {
			throw new Error("Kernel replay witness namespace is corrupt");
		}
		return {
			sessionId: String(row.session_id),
			generation: Number(row.generation),
			journalHeadDigest: String(row.journal_head_digest),
			namespace,
			createdAt: Number(row.created_at),
		};
	}

	async claimAgentSessionDriver(
		sessionId: string,
		input: { clientId: string; now: number; claimTs?: number },
	): Promise<AgentSessionControlMutationResult | null> {
		return this.tx(async (tx) => {
			const result = await tx.execute({
				sql: "SELECT * FROM agent_sessions WHERE session_id = ?",
				args: [sessionId],
			});
			const row = result.rows[0];
			if (!row) return null;

			const session = rowToAgentSession(row);
			const document = agentSessionDocumentFromJson(session.document_json);
			const control = normalizeAgentSessionControl(document);
			const current = parseDriverLease(control.driverLease);
			const candidate = makeDriverLease(input.clientId, input.claimTs ?? input.now, input.now, current);

			if (current && current.holder !== input.clientId && !driverLeaseBeats(candidate, current)) {
				return {
					session,
					document,
					events: [],
					applied: false,
					driver: current.holder,
					reason: "stale_claim",
				};
			}

			if (current && current.holder === input.clientId && !driverLeaseBeats(candidate, current)) {
				return {
					session,
					document,
					events: [],
					applied: true,
					driver: current.holder,
				};
			}

			control.driverLease = candidate;
			document.control = control;
			const documentOp = await appendAgentSessionDocumentOpTx(tx, sessionId, {
				ts: input.now,
				actor: input.clientId,
				kind: "control.driver-claimed",
				patch: {
					op: "control.driverLease.set",
					path: ["control", "driverLease"],
					value: candidate,
					previous: current,
				},
				document,
			});
			await tx.execute({
				sql: "UPDATE agent_sessions SET document_json = ?, updated_at = ? WHERE session_id = ?",
				args: [JSON.stringify(documentOp.document), input.now, sessionId],
			});
			const event = await appendAgentSessionEventTx(tx, sessionId, {
				type: "control.driver-claimed",
				ts: input.now,
				payload: {
					driverLease: candidate,
					previousDriver: current?.holder ?? null,
					documentRevision: documentOp.rev,
					documentChangeId: documentOp.change_id,
				},
			});
			const updated = await readAgentSessionTx(tx, sessionId);
			return {
				session: updated ?? {
					...session,
					document_json: JSON.stringify(documentOp.document),
					updated_at: input.now,
				},
				document: documentOp.document,
				events: [event],
				documentOp,
				applied: true,
				driver: candidate.holder,
			};
		}, "CAS");
	}

	async releaseAgentSessionDriver(
		sessionId: string,
		input: { clientId: string; now: number },
	): Promise<AgentSessionControlMutationResult | null> {
		return this.tx(async (tx) => {
			const result = await tx.execute({
				sql: "SELECT * FROM agent_sessions WHERE session_id = ?",
				args: [sessionId],
			});
			const row = result.rows[0];
			if (!row) return null;

			const session = rowToAgentSession(row);
			const document = agentSessionDocumentFromJson(session.document_json);
			const control = normalizeAgentSessionControl(document);
			const current = parseDriverLease(control.driverLease);

			if (!current) {
				return { session, document, events: [], applied: false, driver: null };
			}
			if (current.holder !== input.clientId) {
				return {
					session,
					document,
					events: [],
					applied: false,
					driver: current.holder,
					reason: "not_driver",
				};
			}

			control.driverLease = null;
			document.control = control;
			const documentOp = await appendAgentSessionDocumentOpTx(tx, sessionId, {
				ts: input.now,
				actor: input.clientId,
				kind: "control.driver-released",
				patch: {
					op: "control.driverLease.clear",
					path: ["control", "driverLease"],
					previous: current,
				},
				document,
			});
			await tx.execute({
				sql: "UPDATE agent_sessions SET document_json = ?, updated_at = ? WHERE session_id = ?",
				args: [JSON.stringify(documentOp.document), input.now, sessionId],
			});
			const event = await appendAgentSessionEventTx(tx, sessionId, {
				type: "control.driver-released",
				ts: input.now,
				payload: {
					driverLease: current,
					releasedBy: input.clientId,
					documentRevision: documentOp.rev,
					documentChangeId: documentOp.change_id,
				},
			});
			const updated = await readAgentSessionTx(tx, sessionId);
			return {
				session: updated ?? {
					...session,
					document_json: JSON.stringify(documentOp.document),
					updated_at: input.now,
				},
				document: documentOp.document,
				events: [event],
				documentOp,
				applied: true,
				driver: null,
			};
		}, "CAS");
	}

	async createAgentSessionSchedule(
		sessionId: string,
		input: CreateAgentSessionScheduleInput,
	): Promise<{ schedule: AgentSessionScheduleRecord; created: boolean }> {
		const normalized = validateAgentSessionScheduleCreateInput(input);
		const requestDigest = digestJson({
			schema: "choreograph.agent-session-schedule-create.v1",
			sessionId,
			scheduleId: normalized.scheduleId,
			definition: normalized.definition,
			prompt: normalized.prompt,
			clientId: normalized.clientId,
			options: normalized.options,
		});
		return this.tx(async (tx) => {
			const replay = await tx.execute({
				sql: `SELECT * FROM agent_session_schedules
				      WHERE session_id = ? AND create_request_id = ?`,
				args: [sessionId, normalized.requestId],
			});
			if (replay.rows[0]) {
				const schedule = rowToAgentSessionSchedule(replay.rows[0]);
				if (schedule.create_request_digest !== requestDigest || schedule.schedule_id !== normalized.scheduleId) {
					throw new AgentSessionScheduleFault(
						"request_conflict",
						`Schedule request ${normalized.requestId} changed on replay`,
					);
				}
				return { schedule, created: false };
			}
			await fenceAgentSessionScheduleClockTx(tx, normalized.now);
			const session = await readAgentSessionTx(tx, sessionId);
			if (!session) {
				throw new AgentSessionScheduleFault("session_not_found", `Agent Session not found: ${sessionId}`);
			}
			if (session.lifecycle_state !== "open") {
				throw new AgentSessionScheduleFault(
					"session_terminal",
					`A ${session.lifecycle_state} Session cannot create a schedule`,
				);
			}
			const runtime = readAgentSessionSemanticBinding(session).runtime;
			if (runtime.kind !== "prime" || runtime.constraints.allowSchedules !== true) {
				throw new AgentSessionScheduleFault(
					"request_invalid",
					"Agent Session durable runtime authority does not allow schedules",
				);
			}
			const externalAuthority = await agentSessionScheduleExternalAuthorityRequirementTx(tx, session);
			const grantSnapshotDigest =
				normalized.options.grantSnapshotDigest ??
				(externalAuthority ? await soleAgentSessionScheduleGrantBindingDigestTx(tx, session.session_id) : null);
			if (externalAuthority && grantSnapshotDigest === null) {
				throw new AgentSessionScheduleFault(
					"request_invalid",
					`Scheduled external authority requires a Session-bound grant snapshot: ${externalAuthority}`,
				);
			}
			if (grantSnapshotDigest !== null) {
				try {
					await verifyAgentSessionScheduleGrantBindingTx(tx, session, grantSnapshotDigest, normalized.now);
				} catch (cause) {
					throw new AgentSessionScheduleFault(
						"request_invalid",
						"Schedule grant snapshot is absent, invalid, or inactive for this Session",
						cause,
					);
				}
			}
			const collision = await tx.execute({
				sql: "SELECT * FROM agent_session_schedules WHERE session_id = ? AND schedule_id = ?",
				args: [sessionId, normalized.scheduleId],
			});
			if (collision.rows[0]) {
				throw new AgentSessionScheduleFault(
					"request_conflict",
					`Schedule id ${normalized.scheduleId} already belongs to another create request`,
				);
			}
			const fields = scheduleDefinitionFields(normalized.definition, normalized.now);
			await tx.execute({
				sql: `INSERT INTO agent_session_schedules
				        (session_id, schedule_id, create_request_id, create_request_digest,
				         kind, fire_at, interval_ms, cron_expression, timezone, prompt_json,
				         client_id, revision, source, label, delivery_mode, grant_snapshot_digest,
				         state, next_fire_at, created_at, updated_at)
				      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'active', ?, ?, ?)`,
				args: [
					sessionId,
					normalized.scheduleId,
					normalized.requestId,
					requestDigest,
					fields.kind,
					fields.fireAt,
					fields.intervalMs,
					fields.cronExpression,
					fields.timezone,
					canonicalJson(normalized.prompt),
					normalized.clientId,
					normalized.options.source,
					normalized.options.label,
					normalized.options.deliveryMode,
					grantSnapshotDigest,
					fields.nextFireAt,
					normalized.now,
					normalized.now,
				],
			});
			await appendAgentSessionEventTx(tx, sessionId, {
				type: "schedule.created",
				ts: normalized.now,
				causationId: normalized.requestId,
				payload: {
					schema: "choreograph.agent-session-schedule-created.v1",
					scheduleId: normalized.scheduleId,
					requestId: normalized.requestId,
					schedule: agentSessionScheduleContractSpec(normalized.definition),
					input: normalized.prompt,
					nextFireAt: agentSessionScheduleTimestampIso(fields.nextFireAt),
				},
			});
			const created = await readAgentSessionScheduleTx(tx, sessionId, normalized.scheduleId);
			if (!created) throw new Error(`created schedule vanished: ${sessionId}/${normalized.scheduleId}`);
			return { schedule: created, created: true };
		}, "CAS");
	}

	async controlAgentSessionSchedule(
		sessionId: string,
		input: AgentSessionScheduleControlInput,
	): Promise<{
		schedule: AgentSessionScheduleRecord;
		receipt: AgentSessionScheduleControlReceiptV1;
		applied: boolean;
	}> {
		const normalized = validateAgentSessionScheduleControlInput(input);
		const requestDigest = digestJson({
			schema: normalized.schema,
			sessionId,
			scheduleId: normalized.scheduleId,
			requestId: normalized.requestId,
			clientId: normalized.clientId,
			expectedRevision: normalized.expectedRevision ?? null,
			action: normalized.action,
		});
		return this.tx(async (tx) => {
			const replay = await tx.execute({
				sql: "SELECT * FROM agent_session_schedule_controls WHERE session_id = ? AND request_id = ?",
				args: [sessionId, normalized.requestId],
			});
			if (replay.rows[0]) {
				const receipt = rowToAgentSessionScheduleControlReceipt(replay.rows[0]);
				if (receipt.requestDigest !== requestDigest || receipt.scheduleId !== normalized.scheduleId) {
					throw new AgentSessionScheduleFault("request_conflict", "Schedule control changed on replay");
				}
				const schedule = await readAgentSessionScheduleTx(tx, sessionId, normalized.scheduleId);
				if (!schedule) throw new Error("Schedule control replay lost its schedule");
				return { schedule, receipt, applied: receipt.disposition === "applied" };
			}
			await fenceAgentSessionScheduleClockTx(tx, normalized.now);
			const schedule = await readAgentSessionScheduleTx(tx, sessionId, normalized.scheduleId);
			if (!schedule) {
				throw new AgentSessionScheduleFault(
					"schedule_not_found",
					`Agent Session schedule not found: ${sessionId}/${normalized.scheduleId}`,
				);
			}
			if (normalized.expectedRevision !== undefined && normalized.expectedRevision !== schedule.revision) {
				throw new AgentSessionScheduleFault(
					"request_conflict",
					"Schedule revision does not match expectedRevision",
				);
			}

			const priorState = schedule.state;
			let resultingState = priorState;
			let nextFireAt = schedule.next_fire_at;
			let revision = schedule.revision;
			let changed = false;
			let definition = schedule.definition;
			let prompt = schedule.prompt;
			let label = schedule.label;
			let deliveryMode = schedule.delivery_mode;
			let fields = scheduleDefinitionFields(schedule.definition, normalized.now);
			let scheduleChanged = false;

			if (priorState === "completed" || priorState === "cancelled") {
				resultingState = priorState;
				nextFireAt = null;
			} else if (normalized.action.kind === "pause") {
				if (priorState === "active") {
					resultingState = "paused";
					nextFireAt = null;
					changed = true;
				}
			} else if (normalized.action.kind === "resume") {
				if (priorState === "paused") {
					resultingState = "active";
					nextFireAt = nextAgentSessionScheduleAfterResume(schedule.definition, normalized.now);
					changed = true;
				}
			} else {
				const action = normalized.action;
				if (action.schedule !== undefined) {
					definition = agentSessionScheduleDefinitionFromSpec(action.schedule, normalized.now);
					fields = scheduleDefinitionFields(definition, normalized.now);
					scheduleChanged = canonicalJson(definition) !== canonicalJson(schedule.definition);
					if (scheduleChanged) changed = true;
				}
				if (action.input !== undefined) {
					prompt = { text: action.input.text };
					if (prompt.text !== schedule.prompt.text) changed = true;
				}
				if (Object.hasOwn(action, "label")) {
					label = normalizeAgentSessionScheduleLabel(action.label);
					if (label !== schedule.label) changed = true;
				}
				if (action.deliveryMode !== undefined) {
					if (action.deliveryMode !== "steer" && action.deliveryMode !== "follow_up") {
						throw new AgentSessionScheduleFault("request_invalid", "Schedule delivery mode is unsupported");
					}
					deliveryMode = action.deliveryMode;
					if (deliveryMode !== schedule.delivery_mode) changed = true;
				}
				if (scheduleChanged && schedule.state === "active") nextFireAt = fields.nextFireAt;
				if (scheduleChanged && schedule.state === "paused") nextFireAt = null;
			}

			const disposition: AgentSessionScheduleControlReceiptV1["disposition"] =
				priorState === "completed" || priorState === "cancelled"
					? "already_terminal"
					: changed
						? "applied"
						: "no_change";
			if (changed) revision = schedule.revision + 1;
			if (changed) {
				await tx.execute({
					sql: `UPDATE agent_session_schedules
						 SET kind = ?, fire_at = ?, interval_ms = ?, cron_expression = ?, timezone = ?,
						     prompt_json = ?, revision = ?, label = ?, delivery_mode = ?, state = ?,
						     next_fire_at = ?, updated_at = ?
					       WHERE session_id = ? AND schedule_id = ? AND revision = ?`,
					args: [
						fields.kind,
						fields.fireAt,
						fields.intervalMs,
						fields.cronExpression,
						fields.timezone,
						canonicalJson(prompt),
						revision,
						label,
						deliveryMode,
						resultingState,
						nextFireAt,
						normalized.now,
						sessionId,
						normalized.scheduleId,
						schedule.revision,
					],
				});
			}
			const receipt: AgentSessionScheduleControlReceiptV1 = {
				schema: "choreograph.agent-session-schedule-control-receipt.v1",
				requestId: normalized.requestId,
				scheduleId: normalized.scheduleId,
				requestDigest,
				priorRevision: schedule.revision,
				resultingRevision: revision,
				disposition,
				priorState,
				resultingState,
				nextFireAt: nextFireAt === null ? null : agentSessionScheduleTimestampIso(nextFireAt),
				committedAt: agentSessionScheduleTimestampIso(normalized.now),
			};
			await tx.execute({
				sql: `INSERT INTO agent_session_schedule_controls
					(control_id, session_id, schedule_id, request_id, request_digest, client_id, action_json,
					 prior_revision, resulting_revision, disposition, prior_state, resulting_state, next_fire_at, committed_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				args: [
					stableAgentSessionScheduleControlId(sessionId, normalized.requestId),
					sessionId,
					normalized.scheduleId,
					normalized.requestId,
					requestDigest,
					normalized.clientId,
					canonicalJson(normalized.action),
					schedule.revision,
					revision,
					disposition,
					priorState,
					resultingState,
					nextFireAt,
					normalized.now,
				],
			});
			if (disposition === "applied") {
				const payload: AgentSessionScheduleUpdatedPayloadV1 = {
					schema: "choreograph.agent-session-schedule-updated.v1",
					scheduleId: normalized.scheduleId,
					requestId: normalized.requestId,
					priorRevision: schedule.revision,
					resultingRevision: revision,
					action: normalizedAgentSessionScheduleControlAction(
						normalized.action,
						definition,
						prompt,
						label,
						deliveryMode,
					),
					priorState,
					resultingState,
					nextFireAt: nextFireAt === null ? null : agentSessionScheduleTimestampIso(nextFireAt),
				};
				await appendAgentSessionEventTx(tx, sessionId, {
					type: "schedule.updated",
					ts: normalized.now,
					causationId: normalized.requestId,
					payload,
				});
			}
			return {
				schedule: (await readAgentSessionScheduleTx(tx, sessionId, normalized.scheduleId))!,
				receipt,
				applied: disposition === "applied",
			};
		}, "CAS");
	}

	async cancelAgentSessionSchedule(
		sessionId: string,
		scheduleId: string,
		input: CancelAgentSessionScheduleInput,
	): Promise<{
		schedule: AgentSessionScheduleRecord;
		cancellation: AgentSessionScheduleCancellationRecord;
		applied: boolean;
	}> {
		const normalized = validateAgentSessionScheduleCancelInput(scheduleId, input);
		const requestDigest = digestJson({
			schema: "choreograph.agent-session-schedule-cancel.v1",
			sessionId,
			scheduleId: normalized.scheduleId,
			clientId: normalized.clientId,
			reason: normalized.reason,
		});
		return this.tx(async (tx) => {
			const replay = await tx.execute({
				sql: `SELECT * FROM agent_session_schedule_cancellations
				      WHERE session_id = ? AND request_id = ?`,
				args: [sessionId, normalized.requestId],
			});
			if (replay.rows[0]) {
				const cancellation = rowToAgentSessionScheduleCancellation(replay.rows[0]);
				if (cancellation.request_digest !== requestDigest || cancellation.schedule_id !== normalized.scheduleId) {
					throw new AgentSessionScheduleFault(
						"request_conflict",
						`Schedule cancellation ${normalized.requestId} changed on replay`,
					);
				}
				const schedule = await readAgentSessionScheduleTx(tx, sessionId, normalized.scheduleId);
				if (!schedule) throw new Error("Schedule cancellation replay lost its schedule");
				return { schedule, cancellation, applied: false };
			}
			await fenceAgentSessionScheduleClockTx(tx, normalized.now);
			const schedule = await readAgentSessionScheduleTx(tx, sessionId, normalized.scheduleId);
			if (!schedule) {
				throw new AgentSessionScheduleFault(
					"schedule_not_found",
					`Agent Session schedule not found: ${sessionId}/${normalized.scheduleId}`,
				);
			}
			const disposition: AgentSessionScheduleCancellationDisposition =
				schedule.state === "active" || schedule.state === "paused"
					? "cancelled"
					: schedule.state === "completed"
						? "fire_preceded"
						: "already_terminal";
			if (disposition === "cancelled") {
				const cancelled = await tx.execute({
					sql: `UPDATE agent_session_schedules
					         SET state = 'cancelled', next_fire_at = NULL, cancel_reason = ?,
					             cancelled_at = ?, updated_at = ?
					       WHERE session_id = ? AND schedule_id = ? AND state IN ('active', 'paused')
					       RETURNING schedule_id`,
					args: [normalized.reason, normalized.now, normalized.now, sessionId, normalized.scheduleId],
				});
				if (!cancelled.rows[0]) {
					throw new AgentSessionScheduleFault("request_conflict", "Schedule cancellation lost first-wins CAS");
				}
				await appendAgentSessionEventTx(tx, sessionId, {
					type: "schedule.cancelled",
					ts: normalized.now,
					causationId: normalized.requestId,
					payload: {
						schema: "choreograph.agent-session-schedule-cancelled.v1",
						scheduleId: normalized.scheduleId,
						requestId: normalized.requestId,
						reason: "requested",
					},
				});
			}
			const cancellation: AgentSessionScheduleCancellationRecord = {
				cancellation_id: stableAgentSessionScheduleCancellationId(
					sessionId,
					normalized.scheduleId,
					normalized.requestId,
				),
				session_id: sessionId,
				schedule_id: normalized.scheduleId,
				request_id: normalized.requestId,
				request_digest: requestDigest,
				client_id: normalized.clientId,
				reason: normalized.reason,
				disposition,
				created_at: normalized.now,
			};
			await tx.execute({
				sql: `INSERT INTO agent_session_schedule_cancellations
				        (cancellation_id, session_id, schedule_id, request_id, request_digest,
				         client_id, reason, disposition, created_at)
				      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				args: [
					cancellation.cancellation_id,
					cancellation.session_id,
					cancellation.schedule_id,
					cancellation.request_id,
					cancellation.request_digest,
					cancellation.client_id,
					cancellation.reason,
					cancellation.disposition,
					cancellation.created_at,
				],
			});
			return {
				schedule: (await readAgentSessionScheduleTx(tx, sessionId, normalized.scheduleId))!,
				cancellation,
				applied: disposition === "cancelled",
			};
		}, "CAS");
	}

	async readAgentSessionSchedule(sessionId: string, scheduleId: string): Promise<AgentSessionScheduleRecord | null> {
		const result = await this.read({
			sql: "SELECT * FROM agent_session_schedules WHERE session_id = ? AND schedule_id = ?",
			args: [sessionId, scheduleId],
		});
		return result.rows[0] ? rowToAgentSessionSchedule(result.rows[0]) : null;
	}

	async listAgentSessionSchedules(sessionId: string): Promise<AgentSessionScheduleRecord[]> {
		const result = await this.read({
			sql: "SELECT * FROM agent_session_schedules WHERE session_id = ? ORDER BY created_at, schedule_id",
			args: [sessionId],
		});
		return result.rows.map(rowToAgentSessionSchedule);
	}

	/**
	 * Read one immutable binding by the digest a schedule/fires pin.  The caller
	 * must still verify it against the current durable Session identity before
	 * adapter minting or spawn.
	 */
	async readAgentSessionScheduleGrantBinding(
		sessionId: string,
		digest: string,
	): Promise<AgentSessionScheduleGrantBindingRecord | null> {
		const result = await this.read({
			sql: `SELECT session_id, digest, binding_json, captured_at
			      FROM agent_session_schedule_grant_bindings
			     WHERE session_id = ? AND digest = ?`,
			args: [sessionId, digest],
		});
		return result.rows[0] ? rowToAgentSessionScheduleGrantBinding(result.rows[0]) : null;
	}

	async listAgentSessionScheduleFires(
		sessionId: string,
		scheduleId?: string,
	): Promise<AgentSessionScheduleFireRecord[]> {
		const result = await this.read({
			sql: `SELECT fire.*, work.state, work.attempt, work.consumer, work.claim_token,
			             work.claimed_at, work.claim_expires_at, work.heartbeat_at,
			             work.not_before, work.last_error, work.completed_at
			        FROM agent_session_schedule_fires AS fire
			        JOIN agent_session_schedule_fire_work AS work ON work.fire_id = fire.fire_id
			       WHERE fire.session_id = ? ${scheduleId === undefined ? "" : "AND fire.schedule_id = ?"}
			       ORDER BY fire.created_at, fire.schedule_id, fire.ordinal`,
			args: scheduleId === undefined ? [sessionId] : [sessionId, scheduleId],
		});
		return result.rows.map(rowToAgentSessionScheduleFire);
	}

	async listAgentSessionScheduleFireAuthorityAttempts(
		fireId: string,
	): Promise<AgentSessionScheduleFireAuthorityAttemptRecord[]> {
		const result = await this.read({
			sql: `SELECT * FROM agent_session_schedule_fire_authority_attempts WHERE fire_id = ? ORDER BY attempt`,
			args: [fireId],
		});
		return result.rows.map(rowToAgentSessionScheduleFireAuthorityAttempt);
	}

	async claimDueAgentSessionScheduleFire(input: {
		readonly consumer: string;
		readonly leaseMs: number;
		readonly now: number;
	}): Promise<AgentSessionScheduleFireClaim | null> {
		const claim = validateAgentSessionScheduleClaimInput(input);
		return this.tx(async (tx) => {
			await fenceAgentSessionScheduleClockTx(tx, claim.now);
			await autoCancelTerminalAgentSessionSchedulesTx(tx, claim.now);
			const ready = await tx.execute({
				sql: `SELECT fire_id FROM agent_session_schedule_fire_work
				       WHERE (state = 'pending' AND not_before <= ?)
				          OR (state = 'claimed' AND claim_expires_at <= ?)
				       ORDER BY not_before ASC, fire_id ASC LIMIT 1`,
				args: [claim.now, claim.now],
			});
			if (ready.rows[0]) {
				return claimExistingAgentSessionScheduleFireTx(tx, String(ready.rows[0].fire_id), claim);
			}

			const due = await tx.execute({
				sql: `SELECT schedule.*
				        FROM agent_session_schedules AS schedule
				        JOIN agent_sessions AS session ON session.session_id = schedule.session_id
				       WHERE schedule.state = 'active' AND schedule.next_fire_at <= ?
				         AND session.lifecycle_state = 'open'
				         AND NOT EXISTS (
				           SELECT 1 FROM agent_materializations AS latest
				            WHERE latest.session_id = schedule.session_id
				              AND latest.generation = (
				                SELECT MAX(candidate.generation) FROM agent_materializations AS candidate
				                 WHERE candidate.session_id = schedule.session_id
				              )
				              AND latest.state IN ('quiescing', 'quiescent')
				         )
				       ORDER BY schedule.next_fire_at ASC, schedule.created_at ASC,
				                schedule.session_id ASC, schedule.schedule_id ASC LIMIT 1`,
				args: [claim.now],
			});
			if (!due.rows[0]) return null;
			const schedule = rowToAgentSessionSchedule(due.rows[0]);
			const session = await readAgentSessionTx(tx, schedule.session_id);
			if (!session) throw new AgentSessionScheduleFault("session_not_found", "Due schedule lost its Session");
			const externalAuthority = await agentSessionScheduleExternalAuthorityRequirementTx(tx, session);
			try {
				if (externalAuthority && schedule.grant_snapshot_digest === null) {
					throw new Error(`external authority has no schedule grant snapshot: ${externalAuthority}`);
				}
				if (schedule.grant_snapshot_digest !== null) {
					await verifyAgentSessionScheduleGrantBindingTx(tx, session, schedule.grant_snapshot_digest, claim.now);
				}
			} catch {
				await cancelActiveAgentSessionScheduleByHostTx(
					tx,
					schedule.session_id,
					schedule.schedule_id,
					"authority_revoked",
					claim.now,
				);
				return null;
			}
			const coalesced = coalesceAgentSessionSchedule(schedule, claim.now);
			const ordinal = schedule.fire_count;
			const fireId = stableAgentSessionScheduleFireId(schedule.session_id, schedule.schedule_id, ordinal);
			const commandId = stableAgentSessionScheduleCommandId(fireId);
			const materialization = await ensureAgentSessionScheduleMaterializationTx(
				tx,
				session,
				stableAgentSessionScheduleActivationId(fireId),
				claim.now,
			);
			if (!materialization) return null;
			const commandName: "prompt" | "steer" | "follow_up" =
				materialization.state === "running" ? schedule.delivery_mode : "prompt";
			const command = await insertAgentSessionScheduleCommandTx(tx, session, {
				commandId,
				idempotencyKey: `schedule-fire:${fireId}`,
				name: commandName,
				input: schedule.prompt,
				clientId: schedule.client_id,
				targetGeneration: materialization.generation,
				now: claim.now,
			});
			await tx.execute({
				sql: `INSERT INTO agent_session_schedule_fires
				        (fire_id, session_id, schedule_id, ordinal, scheduled_at,
					         coalesced_through_at, coalesced_count, grant_snapshot_digest, requested_delivery_mode, command_name, command_id,
				         target_generation, activation_id, created_at)
					  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				args: [
					fireId,
					schedule.session_id,
					schedule.schedule_id,
					ordinal,
					coalesced.scheduledAt,
					coalesced.coalescedThroughAt,
					coalesced.coalescedCount,
					schedule.grant_snapshot_digest,
					schedule.delivery_mode,
					commandName,
					commandId,
					materialization.generation,
					materialization.activation_id,
					claim.now,
				],
			});
			const advanced = await tx.execute({
				sql: `UPDATE agent_session_schedules
				         SET state = ?, next_fire_at = ?, fire_count = fire_count + 1,
				             updated_at = ?, completed_at = ?
				       WHERE session_id = ? AND schedule_id = ? AND state = 'active'
				         AND next_fire_at = ? AND fire_count = ?
				       RETURNING schedule_id`,
				args: [
					coalesced.nextFireAt === null ? "completed" : "active",
					coalesced.nextFireAt,
					claim.now,
					coalesced.nextFireAt === null ? claim.now : null,
					schedule.session_id,
					schedule.schedule_id,
					schedule.next_fire_at,
					ordinal,
				],
			});
			if (!advanced.rows[0]) {
				throw new AgentSessionScheduleFault("request_conflict", "Due schedule lost its first-wins CAS");
			}
			const claimToken = randomUUID();
			await tx.execute({
				sql: `INSERT INTO agent_session_schedule_fire_work
				        (fire_id, state, attempt, consumer, claim_token, claimed_at,
				         claim_expires_at, heartbeat_at, not_before)
				      VALUES (?, 'claimed', 1, ?, ?, ?, ?, ?, ?)`,
				args: [
					fireId,
					claim.consumer,
					claimToken,
					claim.now,
					checkedScheduleSum(claim.now, claim.leaseMs),
					claim.now,
					claim.now,
				],
			});
			await appendAgentSessionEventTx(tx, schedule.session_id, {
				type: "schedule.fired",
				ts: claim.now,
				causationId: fireId,
				commandId,
				payload: {
					schema: "choreograph.agent-session-schedule-fired.v1",
					scheduleId: schedule.schedule_id,
					fireId,
					commandId,
					scheduledAt: agentSessionScheduleTimestampIso(coalesced.scheduledAt),
					claimedAt: agentSessionScheduleTimestampIso(claim.now),
					nextFireAt:
						coalesced.nextFireAt === null ? null : agentSessionScheduleTimestampIso(coalesced.nextFireAt),
				},
			});
			return {
				fire: (await readAgentSessionScheduleFireTx(tx, fireId))!,
				command,
				claimed: true,
			};
		}, "CAS");
	}

	async readNextAgentSessionScheduleDueAt(now: number): Promise<number | null> {
		validateAgentSessionScheduleTimestamp(now, "schedule availability time");
		const result = await this.read({
			sql: `SELECT MIN(available_at) AS available_at FROM (
			        SELECT CASE
			                 WHEN session.lifecycle_state IN ('closed', 'faulted') OR schedule.next_fire_at <= ? THEN ?
			                 ELSE schedule.next_fire_at
			               END AS available_at
			          FROM agent_session_schedules AS schedule
			          JOIN agent_sessions AS session ON session.session_id = schedule.session_id
			         WHERE schedule.state = 'active'
			        UNION ALL
			        SELECT CASE
			                 WHEN state = 'pending' THEN CASE WHEN not_before <= ? THEN ? ELSE not_before END
			                 WHEN state = 'claimed' THEN CASE WHEN claim_expires_at <= ? THEN ? ELSE claim_expires_at END
			               END AS available_at
			          FROM agent_session_schedule_fire_work WHERE state IN ('pending', 'claimed')
			      ) WHERE available_at IS NOT NULL`,
			args: [now, now, now, now, now, now],
		});
		const value = result.rows[0]?.available_at;
		return value == null ? null : requiredProjectionInteger(value, "schedule next availability");
	}

	async renewAgentSessionScheduleFireLease(
		fireId: string,
		input: RenewAgentSessionScheduleFireLeaseInput,
	): Promise<AgentSessionScheduleFireRecord> {
		const fence = validateAgentSessionScheduleLeaseInput(input);
		return this.tx(async (tx) => {
			await fenceAgentSessionScheduleClockTx(tx, fence.now);
			const updated = await tx.execute({
				sql: `UPDATE agent_session_schedule_fire_work
				         SET heartbeat_at = ?, claim_expires_at = ?
				       WHERE fire_id = ? AND state = 'claimed' AND consumer = ? AND claim_token = ?
				         AND claim_expires_at > ? AND heartbeat_at <= ?
				         AND ? >= claim_expires_at
				       RETURNING fire_id`,
				args: [
					fence.now,
					checkedScheduleSum(fence.now, fence.leaseMs),
					fireId,
					fence.consumer,
					fence.claimToken,
					fence.now,
					fence.now,
					checkedScheduleSum(fence.now, fence.leaseMs),
				],
			});
			if (!updated.rows[0]) {
				throw new AgentSessionScheduleFault("lease_lost", `Schedule fire ${fireId} lost its lease`);
			}
			return (await readAgentSessionScheduleFireTx(tx, fireId))!;
		}, "CAS");
	}

	async settleAgentSessionScheduleFire(
		fireId: string,
		input: SettleAgentSessionScheduleFireInput,
	): Promise<AgentSessionScheduleFireRecord> {
		const settlement = validateAgentSessionScheduleSettlementInput(input);
		return this.tx(async (tx) => {
			await fenceAgentSessionScheduleClockTx(tx, settlement.now);
			const current = await readAgentSessionScheduleFireTx(tx, fireId);
			if (!current) {
				throw new AgentSessionScheduleFault("schedule_not_found", `Schedule fire not found: ${fireId}`);
			}
			if (
				current.state !== "claimed" ||
				current.consumer !== settlement.consumer ||
				current.claim_token !== settlement.claimToken
			) {
				throw new AgentSessionScheduleFault("lease_lost", `Schedule fire ${fireId} lease token is stale`);
			}
			if (current.claim_expires_at === null || current.claim_expires_at <= settlement.now) {
				throw new AgentSessionScheduleFault("lease_expired", `Schedule fire ${fireId} lease expired`);
			}
			if (settlement.outcome === "completed") {
				const durableCompletion = await tx.execute({
					sql: `SELECT command.state AS command_state,
					             materialization.state AS materialization_state,
					             materialization.sandbox_id AS materialization_sandbox_id,
					             materialization.activation_id AS materialization_activation_id
					        FROM agent_session_schedule_fires AS fire
					        JOIN agent_session_commands AS command ON command.command_id = fire.command_id
					        JOIN agent_materializations AS materialization
					          ON materialization.session_id = fire.session_id
					         AND materialization.generation = fire.target_generation
					         AND materialization.activation_id = fire.activation_id
					       WHERE fire.fire_id = ?`,
					args: [fireId],
				});
				if (
					String(durableCompletion.rows[0]?.command_state ?? "") !== "completed" ||
					String(durableCompletion.rows[0]?.materialization_state ?? "") === "claimed" ||
					String(durableCompletion.rows[0]?.materialization_sandbox_id ?? "") ===
						`claim:${String(durableCompletion.rows[0]?.materialization_activation_id ?? "")}`
				) {
					throw new AgentSessionScheduleFault(
						"materialization_conflict",
						"Schedule fire completion requires an activated body and durable prompt command completion",
					);
				}
			}
			if (settlement.outcome === "terminal_failure") {
				const durableFailure = await tx.execute({
					sql: `SELECT materialization.state AS materialization_state,
					             session.lifecycle_state AS lifecycle_state
					        FROM agent_session_schedule_fires AS fire
					        JOIN agent_materializations AS materialization
					          ON materialization.session_id = fire.session_id
					         AND materialization.generation = fire.target_generation
					         AND materialization.activation_id = fire.activation_id
					        JOIN agent_sessions AS session ON session.session_id = fire.session_id
					       WHERE fire.fire_id = ?`,
					args: [fireId],
				});
				const materializationState = String(durableFailure.rows[0]?.materialization_state ?? "");
				const lifecycleState = String(durableFailure.rows[0]?.lifecycle_state ?? "");
				if (
					(materializationState !== "faulted" && materializationState !== "cancelled") ||
					(lifecycleState !== "faulted" && lifecycleState !== "closed")
				) {
					throw new AgentSessionScheduleFault(
						"materialization_conflict",
						"Terminal schedule failure requires terminal materialization and Session testimony",
					);
				}
			}
			const state =
				settlement.outcome === "completed"
					? "completed"
					: settlement.outcome === "terminal_failure"
						? "failed"
						: "pending";
			const retryAt = settlement.outcome === "retryable_failure" ? settlement.retryAt : current.not_before;
			const error = settlement.outcome === "completed" ? null : settlement.error;
			const updated = await tx.execute({
				sql: `UPDATE agent_session_schedule_fire_work
				         SET state = ?, consumer = NULL, claim_token = NULL, claimed_at = NULL,
				             claim_expires_at = NULL, heartbeat_at = NULL, not_before = ?,
				             last_error = ?, completed_at = ?
				       WHERE fire_id = ? AND state = 'claimed' AND consumer = ? AND claim_token = ?
				         AND claim_expires_at > ? AND heartbeat_at <= ?
				       RETURNING fire_id`,
				args: [
					state,
					retryAt,
					error,
					state === "pending" ? null : settlement.now,
					fireId,
					settlement.consumer,
					settlement.claimToken,
					settlement.now,
					settlement.now,
				],
			});
			if (!updated.rows[0]) {
				throw new AgentSessionScheduleFault("lease_lost", `Schedule fire ${fireId} settlement lost its lease`);
			}
			return (await readAgentSessionScheduleFireTx(tx, fireId))!;
		}, "CAS");
	}

	/** Atomically terminalize an unembodied claimed fire whose current grant fence failed. */
	async rejectAgentSessionScheduleFireAuthority(input: {
		readonly fireId: string;
		readonly consumer: string;
		readonly claimToken: string;
		readonly outcome: "rejected";
		readonly grantDigest?: string;
		readonly revision?: string | number;
		readonly code: string;
		readonly now: number;
	}): Promise<void> {
		await this.tx(async (tx) => {
			await fenceAgentSessionScheduleClockTx(tx, input.now);
			const fire = await readAgentSessionScheduleFireTx(tx, input.fireId);
			if (
				!fire ||
				fire.state !== "claimed" ||
				fire.consumer !== input.consumer ||
				fire.claim_token !== input.claimToken ||
				fire.claim_expires_at === null ||
				fire.claim_expires_at <= input.now ||
				fire.heartbeat_at === null ||
				fire.heartbeat_at > input.now ||
				fire.claim_expires_at === null ||
				fire.claim_expires_at <= input.now ||
				fire.heartbeat_at === null ||
				fire.heartbeat_at > input.now
			) {
				throw new AgentSessionScheduleFault("lease_lost", "Schedule authority rejection lost its fire lease");
			}
			await tx.execute({
				sql: `INSERT INTO agent_session_schedule_fire_authority_attempts
				      (fire_id, attempt, outcome, grant_digest, revision, code, checked_at)
				      VALUES (?, ?, ?, ?, ?, ?, ?)`,
				args: [
					input.fireId,
					fire.attempt,
					input.outcome,
					input.grantDigest ?? null,
					input.revision === undefined ? null : String(input.revision),
					input.code,
					input.now,
				],
			});
			const materializationResult = await tx.execute({
				sql: `SELECT state, sandbox_id FROM agent_materializations WHERE session_id = ? AND generation = ? AND activation_id = ?`,
				args: [fire.session_id, fire.target_generation, fire.activation_id],
			});
			const materializationState = String(materializationResult.rows[0]?.state ?? "");
			const materializationSandboxId = String(materializationResult.rows[0]?.sandbox_id ?? "");
			if (materializationState === "claimed" && materializationSandboxId === `claim:${fire.activation_id}`) {
				const tombstoned = await tx.execute({
					sql: `UPDATE agent_materializations SET state = 'authority_revoked', updated_at = ? WHERE session_id = ? AND generation = ? AND state = 'claimed' AND sandbox_id = ?`,
					args: [input.now, fire.session_id, fire.target_generation, materializationSandboxId],
				});
				if (tombstoned.rowsAffected !== 1)
					throw new AgentSessionScheduleFault("lease_lost", "Schedule authority sentinel changed");
			} else if (materializationState !== "running") {
				throw new AgentSessionScheduleFault("lease_lost", "Schedule authority target changed before settlement");
			}
			const session = await readAgentSessionTx(tx, fire.session_id);
			if (!session)
				throw new AgentSessionScheduleFault("session_not_found", "Schedule authority rejection lost its Session");
			await cancelQueuedAgentSessionCommandTx(
				tx,
				session,
				fire.command_id,
				input.code,
				input.now,
				"choreograph.schedule-authority",
			);
			await cancelActiveAgentSessionScheduleByHostTx(
				tx,
				fire.session_id,
				fire.schedule_id,
				"authority_revoked",
				input.now,
			);
			const updated = await tx.execute({
				sql: `UPDATE agent_session_schedule_fire_work SET state = 'failed', consumer = NULL, claim_token = NULL, claimed_at = NULL, claim_expires_at = NULL, heartbeat_at = NULL, last_error = ?, completed_at = ? WHERE fire_id = ? AND state = 'claimed' AND consumer = ? AND claim_token = ?`,
				args: [input.code, input.now, input.fireId, input.consumer, input.claimToken],
			});
			if (updated.rowsAffected !== 1)
				throw new AgentSessionScheduleFault("lease_lost", "Schedule authority rejection lost its fire lease");
		}, "CAS");
	}

	async recordAgentSessionScheduleFireAuthorityAccepted(input: {
		readonly fireId: string;
		readonly consumer: string;
		readonly claimToken: string;
		readonly grantDigest: string;
		readonly revision: string | number;
		readonly now: number;
	}): Promise<void> {
		await this.tx(async (tx) => {
			const fire = await readAgentSessionScheduleFireTx(tx, input.fireId);
			if (
				!fire ||
				fire.state !== "claimed" ||
				fire.consumer !== input.consumer ||
				fire.claim_token !== input.claimToken ||
				fire.claim_expires_at === null ||
				fire.claim_expires_at <= input.now ||
				fire.heartbeat_at === null ||
				fire.heartbeat_at > input.now
			) {
				throw new AgentSessionScheduleFault("lease_lost", "Schedule authority acceptance lost its fire lease");
			}
			await tx.execute({
				sql: `INSERT INTO agent_session_schedule_fire_authority_attempts
				      (fire_id, attempt, outcome, grant_digest, revision, code, checked_at)
				      VALUES (?, ?, 'accepted', ?, ?, 'ok', ?)`,
				args: [input.fireId, fire.attempt, input.grantDigest, String(input.revision), input.now],
			});
		}, "CAS");
	}

	async recordAgentSessionScheduleFireAuthorityUnavailable(input: {
		readonly fireId: string;
		readonly consumer: string;
		readonly claimToken: string;
		readonly code: string;
		readonly now: number;
	}): Promise<void> {
		await this.tx(async (tx) => {
			await fenceAgentSessionScheduleClockTx(tx, input.now);
			const fire = await readAgentSessionScheduleFireTx(tx, input.fireId);
			if (
				!fire ||
				fire.state !== "claimed" ||
				fire.consumer !== input.consumer ||
				fire.claim_token !== input.claimToken
			)
				throw new AgentSessionScheduleFault(
					"lease_lost",
					"Schedule authority availability check lost its fire lease",
				);
			await tx.execute({
				sql: `INSERT INTO agent_session_schedule_fire_authority_attempts (fire_id, attempt, outcome, grant_digest, revision, code, checked_at) VALUES (?, ?, 'unavailable', NULL, NULL, ?, ?)`,
				args: [input.fireId, fire.attempt, input.code, input.now],
			});
		}, "CAS");
	}

	async submitAgentSessionCommand(
		sessionId: string,
		input: SubmitAgentSessionCommandInput,
	): Promise<{
		record: AgentSessionCommandRecord;
		duplicate: boolean;
		driver: string | null;
		accepted: boolean;
	} | null> {
		return this.tx(async (tx) => {
			const session = await readAgentSessionTx(tx, sessionId);
			if (!session) return null;
			const commandId = input.commandId.trim();
			const idempotencyKey = input.idempotencyKey.trim();
			const clientId = input.clientId.trim();
			if (!commandId || !idempotencyKey || !clientId) {
				throw new AgentSessionCommandConflictError("commandId, idempotencyKey, and clientId are required");
			}
			const commandDigest = digestAgentSessionCommand(input.name, input.payload);
			const existingByKey = await tx.execute({
				sql: "SELECT * FROM agent_session_commands WHERE session_id = ? AND idempotency_key = ?",
				args: [sessionId, idempotencyKey],
			});
			if (existingByKey.rows[0]) {
				const record = rowToAgentSessionCommand(existingByKey.rows[0]);
				if (record.command_digest !== commandDigest || record.command_id !== commandId) {
					throw new AgentSessionCommandConflictError("idempotency key already names a different command");
				}
				return {
					record,
					duplicate: true as const,
					driver: currentSessionDriver(session.document_json),
					accepted: record.state !== "rejected",
				};
			}
			const existingById = await tx.execute({
				sql: "SELECT * FROM agent_session_commands WHERE command_id = ?",
				args: [commandId],
			});
			if (existingById.rows[0]) {
				throw new AgentSessionCommandConflictError("commandId already belongs to another command");
			}

			const document = agentSessionDocumentFromJson(session.document_json);
			const control = normalizeAgentSessionControl(document);
			let driverLease = parseDriverLease(control.driverLease);
			const requireDriver = input.requireDriver !== false;
			const latestResult = await tx.execute({
				sql: "SELECT * FROM agent_materializations WHERE session_id = ? ORDER BY generation DESC LIMIT 1",
				args: [sessionId],
			});
			const latest = latestResult.rows[0] ? rowToAgentMaterialization(latestResult.rows[0]) : undefined;
			const targetGeneration =
				input.targetGeneration ??
				(latest?.state === "passivated" ? latest.generation + 1 : (latest?.generation ?? 0));
			if (!Number.isSafeInteger(targetGeneration) || targetGeneration < 0) {
				throw new AgentSessionCommandConflictError("target generation must be a non-negative safe integer");
			}
			if (requireDriver && driverLease && driverLease.holder !== clientId) {
				const reason = `agent session is driven by ${driverLease.holder}`;
				const record = await insertRejectedAgentSessionCommandTx(tx, sessionId, document, control, {
					...input,
					commandId,
					idempotencyKey,
					clientId,
					commandDigest,
					targetGeneration,
					reason,
					code: "not_driver",
				});
				return { record, duplicate: false as const, driver: driverLease.holder, accepted: false };
			}
			if (requireDriver && !driverLease) {
				driverLease = makeDriverLease(clientId, input.now, input.now, null);
				control.driverLease = driverLease;
			}
			await tx.execute({
				sql: `INSERT INTO agent_session_commands
					(command_id, session_id, idempotency_key, command_digest, name, payload_json,
					 client_id, target_generation, state, submitted_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
				args: [
					commandId,
					sessionId,
					idempotencyKey,
					commandDigest,
					input.name,
					JSON.stringify(input.payload),
					clientId,
					targetGeneration,
					input.now,
				],
			});
			if (isPrimeGoalCommandName(input.name)) {
				await registerPrimeGoalCommandTx(
					tx,
					sessionId,
					{
						commandId,
						idempotencyKey,
						name: input.name,
					},
					input.now,
				);
			}
			const commandSummary = asRecord(control.commandSummary);
			control.commandSummary = {
				submitted: Number(commandSummary.submitted ?? 0) + 1,
				completed: Number(commandSummary.completed ?? 0),
				failed: Number(commandSummary.failed ?? 0),
				rejected: Number(commandSummary.rejected ?? 0),
				cancelled: Number(commandSummary.cancelled ?? 0),
				lastCommandId: commandId,
				lastCommandName: input.name,
				lastCommandState: "queued",
				targetGeneration,
			};
			document.control = control;
			const documentOp = await appendAgentSessionDocumentOpTx(tx, sessionId, {
				ts: input.now,
				actor: clientId,
				kind: "command.accepted",
				patch: { op: "command.enqueue", commandId, name: input.name, targetGeneration },
				document,
			});
			await tx.execute({
				sql: "UPDATE agent_sessions SET document_json = ?, updated_at = ? WHERE session_id = ?",
				args: [JSON.stringify(documentOp.document), input.now, sessionId],
			});
			await appendAgentSessionEventTx(tx, sessionId, {
				type: "command.accepted",
				ts: input.now,
				payload: { commandId, name: input.name, targetGeneration, documentRevision: documentOp.rev },
			});
			const inserted = await tx.execute({
				sql: "SELECT * FROM agent_session_commands WHERE command_id = ?",
				args: [commandId],
			});
			return {
				record: rowToAgentSessionCommand(inserted.rows[0]!),
				duplicate: false as const,
				driver: driverLease?.holder ?? null,
				accepted: true,
			};
		}, "CAS");
	}

	/** Claim the one physical wake needed by an already-admitted queued command. */
	async claimAgentSessionCommandActivation(input: {
		readonly consumer: string;
		readonly leaseMs: number;
		readonly now: number;
	}): Promise<AgentSessionCommandActivationClaim | null> {
		const consumer = requiredChildRunText(input.consumer, "command activation consumer", 256);
		validatePositiveChildRunInteger(input.leaseMs, "command activation lease duration");
		validateChildRunTimestamp(input.now, "command activation claim time");
		for (let refused = 0; refused < MAX_REFUSED_COMMAND_ACTIVATIONS_PER_CLAIM; refused += 1) {
			try {
				return await this.claimAgentSessionCommandActivationOnce(consumer, input);
			} catch (error) {
				if (!(error instanceof AgentSessionCommandActivationRefused)) throw error;
				await this.refuseAgentSessionCommandActivation(error, input.now);
			}
		}
		return null;
	}

	/**
	 * Settle a command whose regrow its predecessor can never permit, in the store's own vocabulary (as an authority
	 * rejection does): the queued command is cancelled with the refusal as its error, with the document op and the
	 * `command.cancelled` event, and any live activation work is failed with the same reason.
	 */
	private async refuseAgentSessionCommandActivation(
		refusal: AgentSessionCommandActivationRefused,
		now: number,
	): Promise<void> {
		const reason = `regrow_refused: ${refusal.fault.message}`;
		await this.tx(async (tx) => {
			const command = await readAgentSessionCommandTx(tx, refusal.commandId);
			if (!command) return;
			if (command.state === "queued") {
				const session = await readAgentSessionTx(tx, command.session_id);
				if (session) {
					await cancelQueuedAgentSessionCommandTx(
						tx,
						session,
						refusal.commandId,
						reason,
						now,
						"choreograph.command-activation",
					);
				}
			}
			await terminalizeAgentSessionCommandActivationWorkTx(tx, refusal.commandId, "failed", reason, now);
		}, "CAS");
	}

	private async claimAgentSessionCommandActivationOnce(
		consumer: string,
		input: { readonly leaseMs: number; readonly now: number },
	): Promise<AgentSessionCommandActivationClaim | null> {
		return this.tx(async (tx) => {
			await tx.execute({
				sql: `UPDATE agent_session_command_activation_work
				         SET state = 'pending', consumer = NULL, claim_token = NULL, claimed_at = NULL,
				             claim_expires_at = NULL, heartbeat_at = NULL
				       WHERE state = 'claimed' AND claim_expires_at <= ?`,
				args: [input.now],
			});

			const candidates = await tx.execute({
				sql: `SELECT work.*
				        FROM agent_session_command_activation_work AS work
				        JOIN agent_session_commands AS command ON command.command_id = work.command_id
				        JOIN agent_sessions AS session ON session.session_id = work.session_id
				       WHERE work.state = 'pending' AND work.not_before <= ?
				         AND session.lifecycle_state = 'open'
				       ORDER BY work.not_before ASC, command.submitted_at ASC, work.command_id ASC
				       LIMIT 32`,
				args: [input.now],
			});
			for (const candidateRow of candidates.rows) {
				const candidate = rowToAgentSessionCommandActivation(candidateRow);
				const command = await readAgentSessionCommandTx(tx, candidate.command_id);
				if (!command) {
					throw new AgentSessionCommandActivationFault("not_found", "command activation lost its command");
				}
				if (["completed", "failed", "cancelled", "rejected"].includes(command.state)) {
					await terminalizeAgentSessionCommandActivationWorkTx(
						tx,
						candidate.command_id,
						command.state === "completed" ? "completed" : "failed",
						command.error,
						input.now,
					);
					continue;
				}
				const prepared = await refusingRegrow(candidate.command_id, () =>
					prepareAgentSessionCommandActivationAttemptTx(tx, candidate, command, input.now),
				);
				if (!prepared) continue;
				return claimAgentSessionCommandActivationWorkTx(tx, prepared, command, {
					consumer,
					leaseMs: input.leaseMs,
					now: input.now,
				});
			}

			const admitted = await tx.execute({
				sql: `SELECT command.*
				        FROM agent_session_commands AS command
				        JOIN agent_sessions AS session ON session.session_id = command.session_id
				        JOIN agent_materializations AS materialization
				          ON materialization.session_id = command.session_id
				         AND materialization.generation = (
				           SELECT MAX(latest.generation) FROM agent_materializations AS latest
				            WHERE latest.session_id = command.session_id
				         )
				       WHERE command.state = 'queued'
					         AND command.name IN ('prompt', 'follow_up', 'steer', 'goal.get', 'goal.create', 'goal.complete')
				         AND session.lifecycle_state = 'open'
				         AND session.family_root_session_id = session.session_id
				         AND (
				           materialization.state IN ('passivated', 'authority_revoked')
				           OR (materialization.state = 'faulted' AND materialization.recoverable = 1)
				         )
				         AND command.target_generation <= materialization.generation + 1
				         AND NOT EXISTS (
				           SELECT 1 FROM agent_session_command_activation_work AS active_work
				            WHERE active_work.session_id = command.session_id
				              AND active_work.state IN ('pending', 'claimed')
				         )
				         AND NOT EXISTS (
				           SELECT 1 FROM agent_session_schedule_fires AS fire WHERE fire.command_id = command.command_id
				         )
				       ORDER BY command.submitted_at ASC, command.command_id ASC
				       LIMIT 1`,
			});
			if (!admitted.rows[0]) return null;
			const command = rowToAgentSessionCommand(admitted.rows[0]);
			const latestResult = await tx.execute({
				sql: "SELECT * FROM agent_materializations WHERE session_id = ? ORDER BY generation DESC LIMIT 1",
				args: [command.session_id],
			});
			const latest = latestResult.rows[0] ? rowToAgentMaterialization(latestResult.rows[0]) : null;
			if (!latest) return null;
			const targetGeneration = latest.generation + 1;
			const activationId = agentSessionCommandActivationId(command.session_id, command.command_id, targetGeneration);
			await refusingRegrow(command.command_id, () =>
				claimAgentMaterializationTx(tx, command.session_id, {
					generation: targetGeneration,
					activationId,
					now: input.now,
				}),
			);
			const grant = await tx.execute({
				sql: `SELECT digest FROM agent_session_schedule_grant_bindings
				       WHERE session_id = ? ORDER BY captured_at DESC, digest ASC LIMIT 1`,
				args: [command.session_id],
			});
			await tx.execute({
				sql: `INSERT INTO agent_session_command_activation_work
				        (command_id, session_id, target_generation, activation_id, grant_snapshot_digest,
				         state, attempt, not_before)
				      VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
				args: [
					command.command_id,
					command.session_id,
					targetGeneration,
					activationId,
					grant.rows[0] ? String(grant.rows[0].digest) : null,
					input.now,
				],
			});
			const created = await readAgentSessionCommandActivationTx(tx, command.command_id);
			if (!created) throw new Error("command activation work was not created");
			return claimAgentSessionCommandActivationWorkTx(tx, created, command, {
				consumer,
				leaseMs: input.leaseMs,
				now: input.now,
			});
		}, "CAS");
	}

	async readAgentSessionCommandActivation(commandId: string): Promise<AgentSessionCommandActivationRecord | null> {
		const result = await this.read({
			sql: "SELECT * FROM agent_session_command_activation_work WHERE command_id = ?",
			args: [commandId],
		});
		return result.rows[0] ? rowToAgentSessionCommandActivation(result.rows[0]) : null;
	}

	async readNextAgentSessionCommandActivationDueAt(now: number): Promise<number | null> {
		validateChildRunTimestamp(now, "command activation availability time");
		const result = await this.read({
			sql: `SELECT MIN(available_at) AS available_at FROM (
			        SELECT CASE
			                 WHEN work.state = 'pending' THEN CASE WHEN work.not_before <= ? THEN ? ELSE work.not_before END
			                 WHEN work.state = 'claimed' THEN CASE WHEN work.claim_expires_at <= ? THEN ? ELSE work.claim_expires_at END
			               END AS available_at
			          FROM agent_session_command_activation_work AS work
			          JOIN agent_session_commands AS command ON command.command_id = work.command_id
			          JOIN agent_sessions AS session ON session.session_id = work.session_id
			         WHERE work.state IN ('pending', 'claimed')
			           AND session.lifecycle_state = 'open'
			           AND command.state NOT IN ('completed', 'failed', 'cancelled', 'rejected')
			           AND (
			             work.state = 'claimed'
			             OR EXISTS (
			               SELECT 1 FROM agent_materializations AS exact_target
			                WHERE exact_target.session_id = work.session_id
			                  AND exact_target.generation = work.target_generation
			                  AND exact_target.activation_id = work.activation_id
			                  AND exact_target.state = 'claimed'
			                  AND exact_target.sandbox_id = 'claim:' || work.activation_id
			             )
			             OR EXISTS (
			               SELECT 1 FROM agent_materializations AS latest
			                WHERE latest.session_id = work.session_id
			                  AND latest.generation = (
			                    SELECT MAX(candidate.generation) FROM agent_materializations AS candidate
			                     WHERE candidate.session_id = work.session_id
			                  )
			                  AND (
			                    latest.state IN ('passivated', 'authority_revoked')
			                    OR (latest.state = 'faulted' AND latest.recoverable = 1)
			                  )
			             )
			           )
			        UNION ALL
			        SELECT ? AS available_at
			          FROM agent_session_commands AS command
			          JOIN agent_sessions AS session ON session.session_id = command.session_id
			          JOIN agent_materializations AS materialization
			            ON materialization.session_id = command.session_id
			           AND materialization.generation = (
			             SELECT MAX(latest.generation) FROM agent_materializations AS latest
			              WHERE latest.session_id = command.session_id
			           )
			         WHERE command.state = 'queued' AND command.name IN ('prompt', 'follow_up', 'steer')
			           AND session.lifecycle_state = 'open'
			           AND session.family_root_session_id = session.session_id
			           AND (
			             materialization.state IN ('passivated', 'authority_revoked')
			             OR (materialization.state = 'faulted' AND materialization.recoverable = 1)
			           )
			           AND command.target_generation <= materialization.generation + 1
			           AND NOT EXISTS (
			             SELECT 1 FROM agent_session_command_activation_work AS work
			              WHERE work.session_id = command.session_id
			                AND work.state IN ('pending', 'claimed')
			           )
			           AND NOT EXISTS (
			             SELECT 1 FROM agent_session_schedule_fires AS fire WHERE fire.command_id = command.command_id
			           )
			         LIMIT 1
			      ) WHERE available_at IS NOT NULL`,
			args: [now, now, now, now, now],
		});
		const value = result.rows[0]?.available_at;
		return value == null ? null : requiredProjectionInteger(value, "command activation next availability");
	}

	async renewAgentSessionCommandActivationLease(
		commandId: string,
		input: RenewAgentSessionCommandActivationLeaseInput,
	): Promise<AgentSessionCommandActivationRecord> {
		const fence = validateAgentSessionCommandActivationLeaseInput(input, true);
		return this.tx(async (tx) => {
			const updated = await tx.execute({
				sql: `UPDATE agent_session_command_activation_work
				         SET heartbeat_at = ?, claim_expires_at = ?
				       WHERE command_id = ? AND state = 'claimed' AND consumer = ? AND claim_token = ?
				         AND claim_expires_at > ? AND heartbeat_at <= ?
				         AND EXISTS (
				           SELECT 1 FROM agent_sessions AS session
				            WHERE session.session_id = agent_session_command_activation_work.session_id
				              AND session.lifecycle_state = 'open'
				         )`,
				args: [
					fence.now,
					checkedBudgetSum(fence.now, fence.leaseMs),
					commandId,
					fence.consumer,
					fence.claimToken,
					fence.now,
					fence.now,
				],
			});
			if (updated.rowsAffected !== 1) {
				throw new AgentSessionCommandActivationFault("lease_lost", "command activation lease was lost");
			}
			const work = await readAgentSessionCommandActivationTx(tx, commandId);
			if (!work) throw new AgentSessionCommandActivationFault("not_found", "command activation vanished");
			await tx.execute({
				sql: `UPDATE agent_materialization_supervision SET heartbeat_at = ?
				       WHERE session_id = ? AND generation = ? AND activation_id = ?
				         AND recovery_token IS NULL AND heartbeat_at <= ?`,
				args: [fence.now, work.session_id, work.target_generation, work.activation_id, fence.now],
			});
			return work;
		}, "CAS");
	}

	async settleAgentSessionCommandActivation(
		commandId: string,
		input: SettleAgentSessionCommandActivationInput,
	): Promise<AgentSessionCommandActivationRecord> {
		const fence = validateAgentSessionCommandActivationLeaseInput(input, false);
		return this.tx(async (tx) => {
			const current = await readAgentSessionCommandActivationTx(tx, commandId);
			if (!current) throw new AgentSessionCommandActivationFault("not_found", "command activation was not found");
			assertAgentSessionCommandActivationLease(current, fence);
			const command = await readAgentSessionCommandTx(tx, commandId);
			if (!command) throw new AgentSessionCommandActivationFault("not_found", "command activation lost its command");
			const materialization = await readAgentMaterializationTx(tx, current.session_id, current.target_generation);
			if (input.outcome === "completed") {
				if (command.state !== "completed" || !materialization || materialization.state === "claimed") {
					throw new AgentSessionCommandActivationFault(
						"materialization_conflict",
						"command activation completion requires a durable result and an embodied materialization",
					);
				}
			}
			if (input.outcome === "terminal_failure") {
				if (!["failed", "cancelled", "rejected"].includes(command.state) && materialization?.state !== "faulted") {
					throw new AgentSessionCommandActivationFault(
						"materialization_conflict",
						"terminal command activation failure requires durable command or body failure testimony",
					);
				}
			}
			const state =
				input.outcome === "completed" ? "completed" : input.outcome === "terminal_failure" ? "failed" : "pending";
			const retryAt = input.outcome === "retryable_failure" ? input.retryAt : current.not_before;
			const error = input.outcome === "completed" ? null : input.error;
			const updated = await tx.execute({
				sql: `UPDATE agent_session_command_activation_work
				         SET state = ?, consumer = NULL, claim_token = NULL, claimed_at = NULL,
				             claim_expires_at = NULL, heartbeat_at = NULL, not_before = ?,
				             last_error = ?, completed_at = ?
				       WHERE command_id = ? AND state = 'claimed' AND consumer = ? AND claim_token = ?
				         AND claim_expires_at > ?`,
				args: [
					state,
					retryAt,
					error,
					state === "pending" ? null : fence.now,
					commandId,
					fence.consumer,
					fence.claimToken,
					fence.now,
				],
			});
			if (updated.rowsAffected !== 1) {
				throw new AgentSessionCommandActivationFault("lease_lost", "command activation settlement lost its lease");
			}
			return (await readAgentSessionCommandActivationTx(tx, commandId))!;
		}, "CAS");
	}

	async recordAgentSessionCommandActivationAuthority(input: {
		readonly commandId: string;
		readonly consumer: string;
		readonly claimToken: string;
		readonly outcome: "accepted" | "unavailable";
		readonly grantDigest?: string;
		readonly revision?: string | number;
		readonly code: string;
		readonly now: number;
	}): Promise<void> {
		await this.tx(async (tx) => {
			const work = await readAgentSessionCommandActivationTx(tx, input.commandId);
			if (!work) throw new AgentSessionCommandActivationFault("not_found", "command activation was not found");
			assertAgentSessionCommandActivationLease(work, {
				consumer: input.consumer,
				claimToken: input.claimToken,
				now: input.now,
			});
			await tx.execute({
				sql: `INSERT INTO agent_session_command_activation_authority_attempts
				        (command_id, attempt, outcome, grant_digest, revision, code, checked_at)
				      VALUES (?, ?, ?, ?, ?, ?, ?)`,
				args: [
					input.commandId,
					work.attempt,
					input.outcome,
					input.grantDigest ?? null,
					input.revision === undefined ? null : String(input.revision),
					input.code,
					input.now,
				],
			});
		}, "CAS");
	}

	async rejectAgentSessionCommandActivationAuthority(input: {
		readonly commandId: string;
		readonly consumer: string;
		readonly claimToken: string;
		readonly grantDigest?: string;
		readonly revision?: string | number;
		readonly code: string;
		readonly now: number;
	}): Promise<void> {
		await this.tx(async (tx) => {
			const work = await readAgentSessionCommandActivationTx(tx, input.commandId);
			if (!work) throw new AgentSessionCommandActivationFault("not_found", "command activation was not found");
			assertAgentSessionCommandActivationLease(work, {
				consumer: input.consumer,
				claimToken: input.claimToken,
				now: input.now,
			});
			await tx.execute({
				sql: `INSERT INTO agent_session_command_activation_authority_attempts
				        (command_id, attempt, outcome, grant_digest, revision, code, checked_at)
				      VALUES (?, ?, 'rejected', ?, ?, ?, ?)`,
				args: [
					input.commandId,
					work.attempt,
					input.grantDigest ?? null,
					input.revision === undefined ? null : String(input.revision),
					input.code,
					input.now,
				],
			});
			const materialization = await readAgentMaterializationTx(tx, work.session_id, work.target_generation);
			if (
				!materialization ||
				materialization.activation_id !== work.activation_id ||
				materialization.state !== "claimed" ||
				materialization.sandbox_id !== `claim:${work.activation_id}`
			) {
				throw new AgentSessionCommandActivationFault(
					"materialization_conflict",
					"authority rejection requires the exact unembodied command activation",
				);
			}
			await tx.execute({
				sql: `UPDATE agent_materializations SET state = 'authority_revoked', updated_at = ?
				       WHERE session_id = ? AND generation = ? AND activation_id = ? AND state = 'claimed'`,
				args: [input.now, work.session_id, work.target_generation, work.activation_id],
			});
			await releaseAgentSessionChildGenerationOccupancyTx(tx, work.session_id, work.target_generation, input.now);
			const session = await readAgentSessionTx(tx, work.session_id);
			if (!session) throw new AgentSessionCommandActivationFault("not_found", "command activation lost its Session");
			await cancelQueuedAgentSessionCommandTx(
				tx,
				session,
				input.commandId,
				input.code,
				input.now,
				"choreograph.command-activation-authority",
			);
			await terminalizeAgentSessionCommandActivationWorkTx(tx, input.commandId, "failed", input.code, input.now);
		}, "CAS");
	}

	async cancelAgentSessionCommand(
		sessionId: string,
		commandId: string,
		input: { clientId: string; now: number },
	): Promise<{ record: AgentSessionCommandRecord; duplicate: boolean; driver: string | null } | null> {
		return this.tx(async (tx) => {
			const session = await readAgentSessionTx(tx, sessionId);
			if (!session) return null;
			const normalizedCommandId = commandId.trim();
			const clientId = input.clientId.trim();
			if (!normalizedCommandId || !clientId) {
				throw new AgentSessionCommandConflictError("commandId and clientId are required");
			}
			const document = agentSessionDocumentFromJson(session.document_json);
			const control = normalizeAgentSessionControl(document);
			let driverLease = parseDriverLease(control.driverLease);
			if (driverLease && driverLease.holder !== clientId) {
				throw new AgentSessionCommandConflictError(`agent session is driven by ${driverLease.holder}`);
			}
			if (!driverLease) {
				driverLease = makeDriverLease(clientId, input.now, input.now, null);
				control.driverLease = driverLease;
			}
			const found = await tx.execute({
				sql: "SELECT * FROM agent_session_commands WHERE command_id = ? AND session_id = ?",
				args: [normalizedCommandId, sessionId],
			});
			if (!found.rows[0]) return null;
			const current = rowToAgentSessionCommand(found.rows[0]);
			if (current.state === "cancelled") {
				return { record: current, duplicate: true as const, driver: driverLease.holder };
			}
			if (current.state !== "queued") {
				throw new AgentSessionCommandConflictError(`command is already ${current.state}`);
			}
			const activation = await readAgentSessionCommandActivationTx(tx, normalizedCommandId);
			if (activation && (activation.state === "pending" || activation.state === "claimed")) {
				const materialization = await readAgentMaterializationTx(
					tx,
					activation.session_id,
					activation.target_generation,
				);
				if (
					!materialization ||
					materialization.activation_id !== activation.activation_id ||
					materialization.state !== "claimed" ||
					materialization.sandbox_id !== `claim:${activation.activation_id}`
				) {
					throw new AgentSessionCommandConflictError("command activation has already crossed its body boundary");
				}
				await tx.execute({
					sql: `DELETE FROM agent_materialization_supervision
					       WHERE session_id = ? AND generation = ? AND activation_id = ? AND recovery_token IS NULL`,
					args: [activation.session_id, activation.target_generation, activation.activation_id],
				});
				await tx.execute({
					sql: `DELETE FROM agent_materializations
					       WHERE session_id = ? AND generation = ? AND activation_id = ?
					         AND state = 'claimed' AND sandbox_id = 'claim:' || activation_id`,
					args: [activation.session_id, activation.target_generation, activation.activation_id],
				});
				await releaseAgentSessionChildGenerationOccupancyTx(
					tx,
					activation.session_id,
					activation.target_generation,
					input.now,
				);
				await terminalizeAgentSessionCommandActivationWorkTx(
					tx,
					normalizedCommandId,
					"failed",
					"cancelled by session driver",
					input.now,
				);
			}
			await tx.execute({
				sql: `UPDATE agent_session_commands
					SET state = 'cancelled', error = ?, completed_at = ?
					WHERE command_id = ? AND session_id = ? AND state = 'queued'`,
				args: ["cancelled by session driver", input.now, normalizedCommandId, sessionId],
			});
			const commandSummary = asRecord(control.commandSummary);
			control.commandSummary = {
				...commandSummary,
				cancelled: Number(commandSummary.cancelled ?? 0) + 1,
				lastCommandId: normalizedCommandId,
				lastCommandName: current.name,
				lastCommandState: "cancelled",
			};
			document.control = control;
			const documentOp = await appendAgentSessionDocumentOpTx(tx, sessionId, {
				ts: input.now,
				actor: clientId,
				kind: "command.cancelled",
				patch: { op: "command.cancel", commandId: normalizedCommandId, name: current.name },
				document,
			});
			await tx.execute({
				sql: "UPDATE agent_sessions SET document_json = ?, updated_at = ? WHERE session_id = ?",
				args: [JSON.stringify(documentOp.document), input.now, sessionId],
			});
			await appendAgentSessionEventTx(tx, sessionId, {
				type: "command.cancelled",
				ts: input.now,
				payload: {
					commandId: normalizedCommandId,
					name: current.name,
					documentRevision: documentOp.rev,
				},
			});
			const updated = await tx.execute({
				sql: "SELECT * FROM agent_session_commands WHERE command_id = ?",
				args: [normalizedCommandId],
			});
			return {
				record: rowToAgentSessionCommand(updated.rows[0]!),
				duplicate: false as const,
				driver: driverLease.holder,
			};
		}, "CAS");
	}

	async claimAgentSessionCommandsForDelivery(
		sessionId: string,
		generation: number,
		now: number,
	): Promise<AgentSessionCommandRecord[]> {
		return this.tx(async (tx) => {
			const pending = await tx.execute({
				sql: `SELECT * FROM agent_session_commands
					WHERE session_id = ?
					  AND ((state = 'queued' AND target_generation <= ?)
					    OR (state = 'delivered' AND delivery_generation < ?))
					ORDER BY submitted_at ASC, command_id ASC`,
				args: [sessionId, generation, generation],
			});
			const claimed: AgentSessionCommandRecord[] = [];
			for (const row of pending.rows) {
				const record = rowToAgentSessionCommand(row);
				await tx.execute({
					sql: `UPDATE agent_session_commands
						SET state = 'delivered', delivery_generation = ?, delivered_at = ?
						WHERE command_id = ? AND state IN ('queued', 'delivered')`,
					args: [generation, now, record.command_id],
				});
				claimed.push({ ...record, state: "delivered", delivery_generation: generation, delivered_at: now });
			}
			return claimed;
		}, "CAS");
	}

	/**
	 * Claim one exact, already-authorized command for delivery. This is the
	 * shutdown passivation lane: after public admission closes the supervisor may
	 * still deliver its own deterministic quiesce command, but it cannot sweep or
	 * execute arbitrary queued commands.
	 */
	async claimExactAgentSessionCommandForDelivery(
		sessionId: string,
		generation: number,
		commandId: string,
		now: number,
	): Promise<AgentSessionCommandRecord | null> {
		return this.tx(async (tx) => {
			const pending = await tx.execute({
				sql: `SELECT * FROM agent_session_commands
					WHERE command_id = ? AND session_id = ?
					  AND ((state = 'queued' AND target_generation <= ?)
					    OR (state = 'delivered' AND delivery_generation < ?))`,
				args: [commandId, sessionId, generation, generation],
			});
			if (!pending.rows[0]) return null;
			const record = rowToAgentSessionCommand(pending.rows[0]);
			const updated = await tx.execute({
				sql: `UPDATE agent_session_commands
					SET state = 'delivered', delivery_generation = ?, delivered_at = ?
					WHERE command_id = ? AND session_id = ?
					  AND ((state = 'queued' AND target_generation <= ?)
					    OR (state = 'delivered' AND delivery_generation < ?))`,
				args: [generation, now, commandId, sessionId, generation, generation],
			});
			if (updated.rowsAffected !== 1) return null;
			return { ...record, state: "delivered", delivery_generation: generation, delivered_at: now };
		}, "CAS");
	}

	async releaseAgentSessionCommandDelivery(commandId: string, generation: number): Promise<void> {
		await this.write(
			{
				sql: `UPDATE agent_session_commands
				SET state = 'queued', delivery_generation = NULL, delivered_at = NULL
				WHERE command_id = ? AND state = 'delivered' AND delivery_generation = ?`,
				args: [commandId, generation],
			},
			"CAS",
		);
	}

	/**
	 * Admit the opaque Prime frame only when a delivered H command is waiting for
	 * its mutating witness.  Historical or model-originated goal updates remain
	 * on the legacy mirror path.
	 */
	async recordPrimeGoalUpdatedWitness(input: {
		readonly sessionId: string;
		readonly generation: number;
		readonly activationId: string;
		readonly workerSequence: number;
		readonly now: number;
	}): Promise<boolean> {
		return this.tx(async (tx) => {
			const projection = await readAgentSessionGoalProjectionTx(tx, input.sessionId);
			if (!projection) return false;
			const delivered = await tx.execute({
				sql: `SELECT command_id FROM agent_session_commands
				      WHERE session_id = ? AND state = 'delivered' AND delivery_generation = ?
				        AND name IN ('goal.create', 'goal.complete') LIMIT 1`,
				args: [input.sessionId, input.generation],
			});
			if (!delivered.rows[0]) return false;
			await assertLiveLatestMaterializationActivationTx(tx, input.sessionId, input.generation, input.activationId);
			const reduced = reducePrimeGoalWorkerMessage(projection.handoff_state, {
				type: "goal.updated",
				sessionId: input.sessionId,
				generation: input.generation,
				workerSequence: input.workerSequence,
			});
			await writeAgentSessionGoalProjectionTx(tx, {
				...projection,
				handoff_state: reduced.state,
				updated_at: input.now,
			});
			return true;
		}, "CAS");
	}

	/**
	 * The one H1 settlement transaction.  It consumes the strict command result,
	 * persists handoff/reducer receipts, appends the reducer-owned goal.updated
	 * fact at most once, and completes the durable command together.
	 */
	async settlePrimeGoalCommandResult(input: {
		readonly sessionId: string;
		readonly generation: number;
		readonly activationId: string;
		readonly workerSequence: number;
		readonly commandId: string;
		readonly commandName: "goal.get" | "goal.create" | "goal.complete";
		readonly status: "completed" | "failed";
		readonly result?: PrimeGoalHostResponseV1;
		readonly error?: string;
		readonly now: number;
	}): Promise<AgentSessionCommandRecord> {
		return this.tx(async (tx) => {
			await assertLiveLatestMaterializationActivationTx(tx, input.sessionId, input.generation, input.activationId);
			const command = await readAgentSessionCommandTx(tx, input.commandId);
			if (!command || command.session_id !== input.sessionId || command.name !== input.commandName) {
				throw new AgentSessionGenerationFault("Goal result does not match its durable command");
			}
			const projection = await readAgentSessionGoalProjectionTx(tx, input.sessionId);
			if (!projection) throw new AgentSessionGenerationFault("Goal command has no registered H1 projection");
			const handoff = reducePrimeGoalWorkerMessage(projection.handoff_state, {
				type: "command.result",
				sessionId: input.sessionId,
				generation: input.generation,
				workerSequence: input.workerSequence,
				commandId: input.commandId,
				commandName: input.commandName,
				status: input.status,
				...(input.result === undefined ? {} : { result: input.result }),
				...(input.error === undefined ? {} : { error: input.error }),
			});
			let reducerState = projection.reducer_state;
			if (handoff.reducerInput) {
				const reduction = reduceGoalOperation(
					reducerState,
					goalReducerOperationFromPrime(handoff.reducerInput, input.now),
				);
				reducerState = reduction.state;
				if (reduction.emission) {
					const event = await appendAgentSessionEventTx(tx, input.sessionId, {
						type: reduction.emission.type,
						ts: input.now,
						causationId: reduction.emission.causationId,
						commandId: reduction.emission.commandId,
						payload: reduction.emission.payload,
					});
					reducerState = withGoalReducerEventSequence(
						reducerState,
						handoff.reducerInput.idempotencyKey,
						event.seq,
					);
				}
			}
			await writeAgentSessionGoalProjectionTx(tx, {
				...projection,
				reducer_state: reducerState,
				handoff_state: handoff.state,
				updated_at: input.now,
			});
			const completed = await completeAgentSessionCommandTx(tx, input.commandId, input.generation, {
				status: input.status,
				...(input.result === undefined ? {} : { result: input.result }),
				...(input.error === undefined ? {} : { error: input.error }),
				now: input.now,
			});
			if (!completed) throw new AgentSessionGenerationFault("Goal command vanished before settlement");
			return completed;
		}, "CAS");
	}

	async readAgentSessionGoalProjection(sessionId: string): Promise<AgentSessionGoalProjectionRecord | null> {
		const result = await this.read({
			sql: "SELECT * FROM agent_session_goal_projections WHERE session_id = ?",
			args: [sessionId],
		});
		return result.rows[0] ? rowToAgentSessionGoalProjection(result.rows[0]) : null;
	}

	async completeAgentSessionCommand(
		commandId: string,
		generation: number,
		input: { status: "completed" | "failed"; result?: unknown; error?: string; now: number },
	): Promise<AgentSessionCommandRecord | null> {
		return this.tx((tx) => completeAgentSessionCommandTx(tx, commandId, generation, input), "CAS");
	}

	async readAgentSessionCommand(commandId: string): Promise<AgentSessionCommandRecord | null> {
		const result = await this.read({
			sql: "SELECT * FROM agent_session_commands WHERE command_id = ?",
			args: [commandId],
		});
		return result.rows[0] ? rowToAgentSessionCommand(result.rows[0]) : null;
	}

	async listAgentSessionCommands(sessionId: string): Promise<AgentSessionCommandRecord[]> {
		const result = await this.read({
			sql: "SELECT * FROM agent_session_commands WHERE session_id = ? ORDER BY submitted_at ASC, command_id ASC",
			args: [sessionId],
		});
		return result.rows.map(rowToAgentSessionCommand);
	}

	async getWorkflowControl(runId: string): Promise<WorkflowControlRecord | null> {
		const result = await this.read({ sql: "SELECT * FROM workflow_controls WHERE run_id = ?", args: [runId] });
		return result.rows[0] ? rowToWorkflowControl(result.rows[0]) : null;
	}

	async claimWorkflowDriver(
		runId: string,
		input: { clientId: string; now: number; claimTs?: number; expectedRevision?: number },
	): Promise<WorkflowControlMutationResult | null> {
		return this.tx(async (tx) => {
			const current = await readWorkflowControlTx(tx, runId);
			if (!current) return null;
			if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
				return controlMutation(current, false, "revision_conflict");
			}
			const candidate = makeDriverLease(input.clientId, input.claimTs ?? input.now, input.now, current.driverLease);
			if (
				current.driverLease &&
				current.driverLease.holder !== input.clientId &&
				!driverLeaseBeats(candidate, current.driverLease)
			) {
				return controlMutation(current, false, "stale_claim");
			}
			if (
				current.driverLease &&
				current.driverLease.holder === input.clientId &&
				!driverLeaseBeats(candidate, current.driverLease)
			) {
				return controlMutation(current, true);
			}
			const updated = await updateWorkflowControlTx(tx, current, {
				driverLease: candidate,
				updatedAt: input.now,
			});
			return controlMutation(updated, true);
		}, "CAS");
	}

	async releaseWorkflowDriver(
		runId: string,
		input: { clientId: string; now: number; expectedRevision?: number },
	): Promise<WorkflowControlMutationResult | null> {
		return this.tx(async (tx) => {
			const current = await readWorkflowControlTx(tx, runId);
			if (!current) return null;
			if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
				return controlMutation(current, false, "revision_conflict");
			}
			if (!current.driverLease) return controlMutation(current, false);
			if (current.driverLease.holder !== input.clientId) {
				return controlMutation(current, false, "not_driver");
			}
			const updated = await updateWorkflowControlTx(tx, current, {
				driverLease: null,
				updatedAt: input.now,
			});
			return controlMutation(updated, true);
		}, "CAS");
	}

	async queueWorkflowBeatAmendment(
		runId: string,
		input: {
			clientId: string;
			amendmentId: string;
			kind: WorkflowBeatAmendmentKind;
			targetBeatId?: string;
			payload?: unknown;
			expectedRevision: number;
			leaseEpoch: number;
			now: number;
		},
	): Promise<WorkflowControlMutationResult | null> {
		const payload = normalizeWorkflowAmendmentPayload(input.kind, input.payload);
		return this.tx(async (tx) => {
			const current = await readWorkflowControlTx(tx, runId);
			if (!current) return null;
			if (!current.driverLease || current.driverLease.holder !== input.clientId) {
				return controlMutation(current, false, "not_driver");
			}
			if (current.driverLease.epoch !== input.leaseEpoch) {
				return controlMutation(current, false, "lease_epoch_mismatch");
			}
			if (current.revision !== input.expectedRevision) {
				return controlMutation(current, false, "revision_conflict");
			}

			const targetBeatId = input.targetBeatId?.trim() || undefined;
			const candidate: WorkflowBeatAmendment = {
				id: requiredControlId(input.amendmentId, "amendmentId"),
				clientId: input.clientId,
				kind: input.kind,
				...(targetBeatId ? { targetBeatId } : {}),
				payload,
				ts: input.now,
				leaseEpoch: input.leaseEpoch,
				state: "pending",
			};
			const existing = current.amendments.find((amendment) => amendment.id === candidate.id);
			if (existing) {
				const same =
					canonicalControlJson(amendmentIdentity(existing)) === canonicalControlJson(amendmentIdentity(candidate));
				return controlMutation(current, same, same ? undefined : "amendment_conflict");
			}

			const updated = await updateWorkflowControlTx(tx, current, {
				amendments: [...current.amendments, candidate],
				updatedAt: input.now,
			});
			return controlMutation(updated, true);
		}, "CAS");
	}

	async planWorkflowBeats(
		runId: string,
		input: {
			pendingBeatIds: string[];
			now: number;
			allowedAmendments?: readonly WorkflowBeatAmendmentKind[];
		},
	): Promise<WorkflowBeatDecision | null> {
		const pendingBeatIds = normalizePendingBeatIds(input.pendingBeatIds);
		const allowedAmendments = normalizeAllowedWorkflowAmendments(input.allowedAmendments);
		return this.tx(async (tx) => {
			const current = await readWorkflowControlTx(tx, runId);
			if (!current) return null;
			const paused = await pauseWorkflowAtBeatIfRequested(tx, runId, {
				kind: "before-beat",
				beatId: pendingBeatIds[0],
				ts: input.now,
			});
			let order = [...pendingBeatIds];
			const amendments = current.amendments.map((amendment) => ({ ...amendment }));
			const appliedAmendmentIds: string[] = [];
			const rejectedAmendmentIds: string[] = [];
			if (!paused) {
				for (const amendment of amendments) {
					if (amendment.state !== "pending" || amendment.kind !== "reorder") continue;
					if (amendment.targetBeatId && amendment.targetBeatId !== order[0]) continue;
					if (allowedAmendments && !allowedAmendments.has("reorder")) {
						rejectAmendment(amendment, input.now, order[0], "reorder is outside this workflow definition policy");
						rejectedAmendmentIds.push(amendment.id);
						continue;
					}
					const proposed = Array.isArray(amendment.payload.order)
						? amendment.payload.order.filter((value): value is string => typeof value === "string")
						: [];
					if (!sameStringSet(proposed, order)) {
						rejectAmendment(
							amendment,
							input.now,
							order[0],
							"reorder must be an exact permutation of pending beats",
						);
						rejectedAmendmentIds.push(amendment.id);
						continue;
					}
					order = [...proposed];
					applyAmendment(amendment, input.now, order[0]);
					appliedAmendmentIds.push(amendment.id);
				}
			}
			const updated = await updateWorkflowControlTx(tx, current, {
				amendments,
				currentBeat: { kind: "plan", pendingBeatIds: order, ts: input.now },
				updatedAt: input.now,
			});
			return {
				schema: "choreograph.workflow-beat-decision.v1",
				runId,
				revision: updated.revision,
				stage: "plan",
				action: paused ? "pause" : "continue",
				order,
				directives: [],
				appliedAmendmentIds,
				rejectedAmendmentIds,
			};
		}, "CAS");
	}

	async enterWorkflowBeat(
		runId: string,
		input: {
			beatId: string;
			pendingBeatIds: string[];
			parameters: Record<string, unknown>;
			modelUse: "none" | "inference" | "agentic";
			now: number;
			allowedAmendments?: readonly WorkflowBeatAmendmentKind[];
		},
	): Promise<WorkflowBeatDecision | null> {
		const beatId = requiredControlId(input.beatId, "beatId");
		const pendingBeatIds = normalizePendingBeatIds(input.pendingBeatIds);
		const allowedAmendments = normalizeAllowedWorkflowAmendments(input.allowedAmendments);
		if (pendingBeatIds[0] !== beatId) throw invalidControl("beatId must be the first pending beat");
		return this.tx(async (tx) => {
			const current = await readWorkflowControlTx(tx, runId);
			if (!current) return null;
			const paused = await pauseWorkflowAtBeatIfRequested(tx, runId, {
				kind: "before-beat",
				beatId,
				ts: input.now,
			});
			let action: WorkflowBeatDecision["action"] = paused ? "pause" : "continue";
			let parameters = canonicalControlValue(input.parameters) as Record<string, unknown>;
			const directives: string[] = [];
			const amendments = current.amendments.map((amendment) => ({ ...amendment }));
			const appliedAmendmentIds: string[] = [];
			const rejectedAmendmentIds: string[] = [];
			if (!paused) {
				for (const amendment of amendments) {
					if (amendment.state !== "pending" || amendment.kind === "reorder") continue;
					if (amendment.targetBeatId && amendment.targetBeatId !== beatId) continue;
					if (allowedAmendments && !allowedAmendments.has(amendment.kind)) {
						rejectAmendment(
							amendment,
							input.now,
							beatId,
							`${amendment.kind} is outside this workflow definition policy`,
						);
						rejectedAmendmentIds.push(amendment.id);
						continue;
					}
					if (amendment.kind === "skip") {
						action = "skip";
						applyAmendment(amendment, input.now, beatId);
						appliedAmendmentIds.push(amendment.id);
						continue;
					}
					if (amendment.kind === "reparameterize") {
						parameters = {
							...parameters,
							...asRecord(amendment.payload.parameters),
							...(typeof parameters.id === "string" ? { id: parameters.id } : {}),
						};
						applyAmendment(amendment, input.now, beatId);
						appliedAmendmentIds.push(amendment.id);
						continue;
					}
					if (amendment.kind === "directive") {
						if (input.modelUse === "none") {
							if (amendment.targetBeatId) {
								rejectAmendment(amendment, input.now, beatId, "target beat has no model-use stage");
								rejectedAmendmentIds.push(amendment.id);
							}
							continue;
						}
						directives.push(String(amendment.payload.text));
						applyAmendment(amendment, input.now, beatId);
						appliedAmendmentIds.push(amendment.id);
					}
				}
			}
			const updated = await updateWorkflowControlTx(tx, current, {
				amendments,
				currentBeat: { kind: "before-beat", beatId, pendingBeatIds, ts: input.now },
				updatedAt: input.now,
			});
			return {
				schema: "choreograph.workflow-beat-decision.v1",
				runId,
				revision: updated.revision,
				stage: "enter",
				beatId,
				action,
				parameters,
				directives,
				appliedAmendmentIds,
				rejectedAmendmentIds,
			};
		}, "CAS");
	}

	async completeWorkflowBeat(
		runId: string,
		input: { beatId: string; now: number },
	): Promise<WorkflowBeatDecision | null> {
		const beatId = requiredControlId(input.beatId, "beatId");
		return this.tx(async (tx) => {
			const current = await readWorkflowControlTx(tx, runId);
			if (!current) return null;
			const updated = await updateWorkflowControlTx(tx, current, {
				currentBeat: { kind: "after-beat", beatId, ts: input.now },
				updatedAt: input.now,
			});
			await tx.execute({
				sql: "UPDATE workflow_instances SET frontier_json = ?, updated_at = ? WHERE run_id = ?",
				args: [
					JSON.stringify({ kind: "after-beat", beatId, ts: input.now } satisfies WorkflowFrontier),
					input.now,
					runId,
				],
			});
			return {
				schema: "choreograph.workflow-beat-decision.v1",
				runId,
				revision: updated.revision,
				stage: "complete",
				beatId,
				action: "continue",
				directives: [],
				appliedAmendmentIds: [],
				rejectedAmendmentIds: [],
			};
		}, "CAS");
	}
}

export function parseAgentSessionResult(record: AgentSessionRecord): AgentNodeResult | undefined {
	if (!record.result_json) return undefined;
	const parsed = parseJson(record.result_json);
	return parsed && typeof parsed === "object" ? (parsed as AgentNodeResult) : undefined;
}

/**
 * Choreograph modes v1: the mode ref a durable Session was bound to, read from
 * its pinned Agent Ontology binding (absent ⇒ the Session runs without a mode).
 */
export function pinnedAgentSessionModeRef(session: AgentSessionRecord): AgentModeRefV1 | undefined {
	const source = asRecord(agentSessionDocumentFromJson(session.document_json).source);
	const binding = asRecord(source.agentOntologyBinding);
	if (binding.mode === undefined) return undefined;
	validateAgentModeRef(binding.mode);
	return binding.mode;
}

/** The tools a Session was handed at its start (`source.includeTools`), when its document names them. */
export function agentSessionIncludeTools(session: AgentSessionRecord): string[] | undefined {
	const source = asRecord(agentSessionDocumentFromJson(session.document_json).source);
	return Array.isArray(source.includeTools)
		? source.includeTools.filter((tool): tool is string => typeof tool === "string")
		: undefined;
}

export function agentNodeSpecForScheduledActivation(
	session: AgentSessionRecord,
	activation: { readonly generation: number; readonly activationId: string },
): ScheduledActivationAgentNodeSpec {
	try {
		return reconstructResidentCommandActivationAgentNodeSpec(session, activation, true);
	} catch (cause) {
		throw new AgentSessionScheduleFault(
			"materialization_conflict",
			`Agent Session ${session.session_id} cannot reconstruct its scheduled activation`,
			cause,
		);
	}
}

export function agentNodeSpecForCommandActivation(
	session: AgentSessionRecord,
	activation: { readonly generation: number; readonly activationId: string },
): ScheduledActivationAgentNodeSpec {
	try {
		return reconstructResidentCommandActivationAgentNodeSpec(session, activation, false);
	} catch {
		throw new AgentSessionCommandActivationFault(
			"materialization_conflict",
			`Agent Session ${session.session_id} cannot reconstruct its command activation`,
		);
	}
}

const SCHEDULED_ROOT_SOURCE_FIELDS = new Set([
	"kind",
	"runId",
	"workflowName",
	"graphId",
	"nodeKey",
	"label",
	"phaseIndex",
	"prompt",
	"systemPrompt",
	"agentId",
	"model",
	"provider",
	"graphAccess",
	"toolMode",
	"excludeTools",
	"includeTools",
	"strictToolManifest",
	"interactionMode",
	"schema",
	"maxTurns",
	"agentType",
	"poolMode",
	"capabilities",
	"contentAuthority",
	"verifiedExecutionCapsule",
	"runtimeBinding",
	"runtimeBindingDigest",
	"agentOntologyBinding",
	"agentOntologyBindingDigest",
	"initialGoal",
	"seed",
	"pricing",
]);

function reconstructResidentCommandActivationAgentNodeSpec(
	session: AgentSessionRecord,
	activation: { readonly generation: number; readonly activationId: string },
	requireScheduleAuthority: boolean,
): ScheduledActivationAgentNodeSpec {
	if (!activation || typeof activation !== "object" || Array.isArray(activation)) {
		throw new Error("scheduled activation coordinates must be an object");
	}
	const activationFields = Object.keys(activation).sort();
	if (
		activationFields.length !== 2 ||
		activationFields[0] !== "activationId" ||
		activationFields[1] !== "generation"
	) {
		throw new Error("scheduled activation coordinates contain unknown fields");
	}
	if (!Number.isSafeInteger(activation.generation) || activation.generation < 0) {
		throw new Error("scheduled activation generation must be a non-negative safe integer");
	}
	if (
		typeof activation.activationId !== "string" ||
		!activation.activationId.trim() ||
		activation.activationId.length > 256 ||
		activation.activationId.includes("\0")
	) {
		throw new Error("scheduled activation id is invalid");
	}
	if (session.lifecycle_state !== "open") throw new Error("scheduled activation Session is not open");
	if (session.family_root_session_id !== session.session_id) {
		throw new Error("scheduled activation requires a root Agent Session");
	}

	let document: unknown;
	try {
		document = JSON.parse(session.document_json);
	} catch (cause) {
		throw new Error("scheduled activation document is not valid JSON", { cause });
	}
	const documentRecord = exactScheduledActivationRecord(document, "Agent Session document");
	if (documentRecord.schema !== "choreograph.agent-session-document.v1") {
		throw new Error("scheduled activation document schema is unsupported");
	}
	if (documentRecord.sessionId !== session.session_id) {
		throw new Error("scheduled activation document Session id diverges from its row");
	}
	const source = exactScheduledActivationRecord(documentRecord.source, "Agent Session source");
	const unknownSourceFields = Object.keys(source).filter((field) => !SCHEDULED_ROOT_SOURCE_FIELDS.has(field));
	if (unknownSourceFields.length > 0) {
		throw new Error(`scheduled activation source contains unknown fields: ${unknownSourceFields.sort().join(", ")}`);
	}
	if (source.kind !== "workflow-node") throw new Error("scheduled activation source is not a root workflow node");
	for (const [field, expected] of [
		["runId", session.run_id],
		["workflowName", session.workflow_name],
		["graphId", session.graph_id],
		["nodeKey", session.node_key],
		["label", session.label],
		["phaseIndex", session.phase_index],
		["model", session.model],
	] as const) {
		if (source[field] !== expected) throw new Error(`scheduled activation source.${field} diverges from its row`);
	}
	const prompt = scheduledActivationRequiredString(source.prompt, "source.prompt");
	const provider = scheduledActivationRequiredString(source.provider, "source.provider");
	const agentId = scheduledActivationRequiredString(source.agentId, "source.agentId");
	if (session.agent_id !== agentId) throw new Error("scheduled activation agent id diverges from its row");

	const runtime = source.runtimeBinding;
	validateResolvedAgentRuntimeBinding(runtime);
	const runtimeDigest = digestAgentRuntimeBinding(runtime);
	if (source.runtimeBindingDigest !== runtimeDigest) {
		throw new Error("scheduled activation runtime binding digest is invalid");
	}
	if (runtime.kind !== "prime") {
		throw new Error("resident command activation requires a Prime runtime");
	}
	if (requireScheduleAuthority && runtime.constraints.allowSchedules !== true) {
		throw new Error("scheduled activation runtime authority does not allow Prime schedules");
	}
	const ontology = source.agentOntologyBinding;
	validateAgentOntologyBinding(ontology);
	const ontologyDigest = digestAgentOntologyBinding(ontology);
	if (source.agentOntologyBindingDigest !== ontologyDigest) {
		throw new Error("scheduled activation ontology binding digest is invalid");
	}
	assertAgentOntologyRuntimeMatch(ontology, { agentId, runtimeProfileRef: runtime.profileRef });

	const runtimeProjection = exactScheduledActivationRecord(documentRecord.runtime, "Agent Session runtime projection");
	if (runtimeProjection.kind !== "prime" || runtimeProjection.bindingDigest !== runtimeDigest) {
		throw new Error("scheduled activation runtime projection diverges from its pinned binding");
	}
	assertScheduledActivationMeaningfulObjects(session, documentRecord, runtimeDigest, ontologyDigest, agentId);

	const graphAccess = scheduledActivationOptionalEnum(source, "graphAccess", ["read", "write"] as const);
	const toolMode = scheduledActivationOptionalEnum(source, "toolMode", ["dynamic", "curated", "none"] as const);
	const excludeTools = scheduledActivationOptionalToolNames(source, "excludeTools");
	const includeTools = scheduledActivationOptionalToolNames(source, "includeTools");
	if (excludeTools && includeTools && excludeTools.some((tool) => includeTools.includes(tool))) {
		throw new Error("scheduled activation tool include and exclude bindings overlap");
	}
	const strictToolManifest = scheduledActivationOptionalBoolean(source, "strictToolManifest");
	const interactionMode = scheduledActivationOptionalEnum(source, "interactionMode", ["headless", "headed"] as const);
	const systemPrompt = scheduledActivationOptionalString(source, "systemPrompt", true);
	const agentType = scheduledActivationOptionalString(source, "agentType", false);
	const poolMode = scheduledActivationOptionalEnum(source, "poolMode", ["pooled", "differentiated"] as const);
	const maxTurns = scheduledActivationOptionalPositiveInteger(source, "maxTurns");
	if (maxTurns !== undefined && maxTurns > runtime.constraints.maxTurns) {
		throw new Error("scheduled activation node turn budget widens its runtime binding");
	}
	const schema = scheduledActivationOptionalSchema(source);
	const capabilities = scheduledActivationOptionalCapabilities(source);
	const initialGoal = scheduledActivationOptionalInitialGoal(source);
	const seed = scheduledActivationOptionalSeed(source);
	const pricing = scheduledActivationOptionalPricing(source, session.model, provider);
	const contentAuthority = scheduledActivationContentAuthority(source, systemPrompt);

	return {
		nodeKey: session.node_key,
		sessionId: session.session_id,
		depth: 0,
		sandboxGeneration: activation.generation,
		invocationId: activation.activationId,
		awaitInitialCommand: true,
		label: session.label,
		phaseIndex: session.phase_index,
		prompt,
		...(systemPrompt === undefined ? {} : { systemPrompt }),
		agentId,
		...(graphAccess === undefined ? {} : { graphAccess }),
		model: session.model,
		provider,
		graphId: session.graph_id,
		...(toolMode === undefined ? {} : { toolMode }),
		...(excludeTools === undefined ? {} : { excludeTools }),
		...(includeTools === undefined ? {} : { includeTools }),
		...(strictToolManifest === undefined ? {} : { strictToolManifest }),
		...(interactionMode === undefined ? {} : { interactionMode }),
		...(schema === undefined ? {} : { schema }),
		...(maxTurns === undefined ? {} : { maxTurns }),
		runtime,
		runtimeBindingDigest: runtimeDigest,
		ontology,
		ontologyBindingDigest: ontologyDigest,
		...(initialGoal === undefined ? {} : { initialGoal }),
		...(seed === undefined ? {} : { seed }),
		...(pricing === undefined ? {} : { pricing }),
		...(agentType === undefined ? {} : { agentType }),
		...(poolMode === undefined ? {} : { poolMode }),
		...(capabilities === undefined ? {} : { capabilities }),
		...contentAuthority,
	};
}

function scheduledActivationContentAuthority(
	source: Record<string, unknown>,
	systemPrompt: string | undefined,
): Pick<AgentNodeSpec, "contentAuthority" | "verifiedExecutionCapsule"> {
	const binding = source.contentAuthority;
	const capsule = source.verifiedExecutionCapsule;
	if (binding === undefined && capsule === undefined) return {};
	if (!binding || !capsule) {
		throw new Error("scheduled activation content authority is partial");
	}
	const typedBinding = binding as ContentAuthorityBindingV1;
	const typedCapsule = capsule as VerifiedExecutionCapsuleV1;
	assertContentAuthorityBinding(typedBinding);
	assertVerifiedExecutionCapsuleReplay(typedCapsule, typedBinding.prompt.finalPromptUtf8);
	if (
		systemPrompt !== typedBinding.prompt.finalPromptUtf8 ||
		typedCapsule.prompt.finalPromptDigest !== typedBinding.prompt.finalPromptDigest
	) {
		throw new Error("scheduled activation prompt differs from its sealed content authority");
	}
	return { contentAuthority: typedBinding, verifiedExecutionCapsule: typedCapsule };
}

function assertScheduledActivationMeaningfulObjects(
	session: AgentSessionRecord,
	document: Record<string, unknown>,
	runtimeBindingDigest: string,
	ontologyBindingDigest: string,
	agentId: string,
): void {
	const meaningfulObjects = exactScheduledActivationRecord(
		document.meaningfulObjects,
		"Agent Session Meaningful Objects",
	);
	const agentSession = meaningfulObjects.agentSession;
	const workflow = meaningfulObjects.workflow;
	const workflowNode = meaningfulObjects.workflowNode;
	validateMeaningfulObjectRef(agentSession, "agent-session");
	validateMeaningfulObjectRef(workflow, "workflow");
	validateMeaningfulObjectRef(workflowNode, "workflow-node");

	const identity = {
		sessionId: session.session_id,
		runId: session.run_id,
		workflowName: session.workflow_name,
		graphId: session.graph_id,
		nodeKey: session.node_key,
		agentId,
		runtimeBindingDigest,
		ontologyBindingDigest,
	};
	const expectedAgentSession = createMeaningfulObjectRef({
		kind: "agent-session",
		ownerPrincipal: session.graph_owner_principal,
		graphId: session.graph_id,
		objectId: session.session_id,
		version: "1",
		value: identity,
	});
	const expectedWorkflow = createMeaningfulObjectRef({
		kind: "workflow",
		ownerPrincipal: session.graph_owner_principal,
		graphId: session.graph_id,
		objectId: session.workflow_name,
		version: session.run_id,
		value: { workflowName: session.workflow_name, runId: session.run_id },
	});
	const expectedWorkflowNode = createMeaningfulObjectRef({
		kind: "workflow-node",
		ownerPrincipal: session.graph_owner_principal,
		graphId: session.graph_id,
		objectId: `${session.run_id}:${session.node_key}`,
		version: workflowNode.version,
		value: identity,
	});
	for (const [label, actual, expected] of [
		["agentSession", agentSession, expectedAgentSession],
		["workflow", workflow, expectedWorkflow],
		["workflowNode", workflowNode, expectedWorkflowNode],
	] as const) {
		if (canonicalJson(actual) !== canonicalJson(expected)) {
			throw new Error(`scheduled activation Meaningful Object ${label} is invalid`);
		}
	}
}

function exactScheduledActivationRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function scheduledActivationRequiredString(value: unknown, label: string, allowEmpty = false): string {
	if (
		typeof value !== "string" ||
		(!allowEmpty && !value.trim()) ||
		value.length > 64 * 1024 ||
		value.includes("\0")
	) {
		throw new Error(`${label} is invalid`);
	}
	return value;
}

function scheduledActivationOptionalString(
	record: Record<string, unknown>,
	field: string,
	allowEmpty: boolean,
): string | undefined {
	if (!Object.hasOwn(record, field)) return undefined;
	return scheduledActivationRequiredString(record[field], `source.${field}`, allowEmpty);
}

function scheduledActivationOptionalEnum<const Value extends string>(
	record: Record<string, unknown>,
	field: string,
	allowed: readonly Value[],
): Value | undefined {
	if (!Object.hasOwn(record, field)) return undefined;
	const value = record[field];
	if (typeof value !== "string" || !allowed.includes(value as Value)) {
		throw new Error(`source.${field} is unsupported`);
	}
	return value as Value;
}

function scheduledActivationOptionalToolNames(
	record: Record<string, unknown>,
	field: "excludeTools" | "includeTools",
): string[] | undefined {
	if (!Object.hasOwn(record, field)) return undefined;
	const value = record[field];
	if (!Array.isArray(value) || value.length > 256) throw new Error(`source.${field} is invalid`);
	const result: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		const tool = scheduledActivationRequiredString(item, `source.${field} item`);
		if (tool !== tool.trim() || tool.length > 256 || seen.has(tool)) {
			throw new Error(`source.${field} contains an invalid or duplicate tool name`);
		}
		seen.add(tool);
		result.push(tool);
	}
	return result;
}

function scheduledActivationOptionalBoolean(record: Record<string, unknown>, field: string): boolean | undefined {
	if (!Object.hasOwn(record, field)) return undefined;
	if (typeof record[field] !== "boolean") throw new Error(`source.${field} must be a boolean`);
	return record[field];
}

function scheduledActivationOptionalPositiveInteger(
	record: Record<string, unknown>,
	field: string,
): number | undefined {
	if (!Object.hasOwn(record, field)) return undefined;
	const value = record[field];
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		throw new Error(`source.${field} must be a positive safe integer`);
	}
	return value as number;
}

function scheduledActivationOptionalSchema(record: Record<string, unknown>): unknown {
	if (!Object.hasOwn(record, "schema")) return undefined;
	const value = record.schema;
	if (typeof value !== "boolean" && (typeof value !== "object" || value === null || Array.isArray(value))) {
		throw new Error("source.schema must be a JSON Schema object or boolean");
	}
	return value;
}

function scheduledActivationOptionalCapabilities(
	record: Record<string, unknown>,
): AgentNodeSpec["capabilities"] | undefined {
	if (!Object.hasOwn(record, "capabilities")) return undefined;
	const value = exactScheduledActivationRecord(record.capabilities, "source.capabilities");
	const capabilities: NonNullable<AgentNodeSpec["capabilities"]> = {};
	for (const [rawName, rawDescriptor] of Object.entries(value)) {
		const name = scheduledActivationRequiredString(rawName, "source.capabilities name");
		if (name !== name.trim() || name.length > 256) {
			throw new Error("source.capabilities contains an invalid capability name");
		}
		const descriptor = exactScheduledActivationRecord(rawDescriptor, `source.capabilities.${name}`);
		const unknown = Object.keys(descriptor).filter(
			(field) => !["kind", "engine", "boundOrigin", "storageStateRef", "accessLevel"].includes(field),
		);
		if (unknown.length > 0) {
			throw new Error(`source.capabilities.${name} contains unknown fields: ${unknown.sort().join(", ")}`);
		}
		if (descriptor.kind !== "web") {
			throw new Error(`source.capabilities.${name}.kind is unsupported`);
		}
		const engine = scheduledActivationOptionalEnum(descriptor, "engine", ["chromium", "camoufox"] as const);
		const boundOrigin = scheduledActivationOptionalString(descriptor, "boundOrigin", false);
		const storageStateRef = scheduledActivationOptionalString(descriptor, "storageStateRef", false);
		const accessLevel = scheduledActivationOptionalEnum(descriptor, "accessLevel", ["ro", "rw"] as const);
		capabilities[name] = {
			kind: "web",
			...(engine === undefined ? {} : { engine }),
			...(boundOrigin === undefined ? {} : { boundOrigin }),
			...(storageStateRef === undefined ? {} : { storageStateRef }),
			...(accessLevel === undefined ? {} : { accessLevel }),
		};
	}
	return capabilities;
}

/** The seed reference a regrown Session carries; a malformed one refuses the regrow. */
function scheduledActivationOptionalSeed(record: Record<string, unknown>): AgentSeedRefV1 | undefined {
	if (!Object.hasOwn(record, "seed")) return undefined;
	return parseAgentSeedRef(record.seed, "source.seed");
}

/** The rate card a regrown Session is priced by; a malformed card, or one for another model, refuses the regrow. */
function scheduledActivationOptionalPricing(
	record: Record<string, unknown>,
	model: string,
	provider: string,
): RateCardV1 | undefined {
	if (!Object.hasOwn(record, "pricing")) return undefined;
	const card = parseRateCard(record.pricing, "source.pricing");
	assertRateCardBelongsTo(card, model, provider, "source.pricing");
	return card;
}

/** A rate card prices one model at one provider; applied to another it would bill a price nobody stated. */
function assertRateCardBelongsTo(card: RateCardV1, model: string, provider: string, label: string): void {
	if (card.model !== model || card.provider !== provider.trim().toLowerCase()) {
		throw new Error(`${label} is a rate card for ${card.provider}/${card.model}, not ${provider}/${model}`);
	}
}

function scheduledActivationOptionalInitialGoal(
	record: Record<string, unknown>,
): AgentNodeSpec["initialGoal"] | undefined {
	if (!Object.hasOwn(record, "initialGoal")) return undefined;
	const value = exactScheduledActivationRecord(record.initialGoal, "source.initialGoal");
	const unknown = Object.keys(value).filter((field) => !["objective", "tokenBudget"].includes(field));
	if (unknown.length > 0) throw new Error(`source.initialGoal contains unknown fields: ${unknown.sort().join(", ")}`);
	const objective = scheduledActivationRequiredString(value.objective, "source.initialGoal.objective");
	const tokenBudget = scheduledActivationOptionalPositiveInteger(value, "tokenBudget");
	return { objective, ...(tokenBudget === undefined ? {} : { tokenBudget }) };
}

interface ChildAdmissionDocumentSource {
	readonly kind: "child-admission";
	readonly parentSessionId: string;
	readonly relationId: string;
	readonly admissionId: string;
	readonly childRunId: string;
	readonly requestId: string;
	readonly causationId: string;
	readonly childName: string;
	readonly depth: number;
}

function buildAgentSessionDocument(
	input: BeginAgentSessionInput,
	childSource?: ChildAdmissionDocumentSource,
): Record<string, unknown> {
	const semantic = requireExecutableSessionBinding(input.spec);
	const identity = {
		sessionId: input.sessionId,
		runId: input.runId,
		workflowName: input.workflowName,
		graphId: input.graphId,
		...(childSource ? {} : { nodeKey: input.nodeKey }),
		agentId: input.spec.agentId,
		runtimeBindingDigest: semantic.runtimeDigest,
		ontologyBindingDigest: semantic.ontologyDigest,
	};
	const agentSession = createMeaningfulObjectRef({
		kind: "agent-session",
		ownerPrincipal: input.graphOwnerPrincipal,
		graphId: input.graphId,
		objectId: input.sessionId,
		version: "1",
		value: identity,
	});
	const workflow = createMeaningfulObjectRef({
		kind: "workflow",
		ownerPrincipal: input.graphOwnerPrincipal,
		graphId: input.graphId,
		objectId: input.workflowName,
		version: input.runId,
		value: { workflowName: input.workflowName, runId: input.runId },
	});
	const meaningfulObjects = childSource
		? {
				workflow,
				agentSession,
				...input.spec.ontology?.objects,
			}
		: {
				workflow,
				workflowNode: createMeaningfulObjectRef({
					kind: "workflow-node",
					ownerPrincipal: input.graphOwnerPrincipal,
					graphId: input.graphId,
					objectId: `${input.runId}:${input.nodeKey}`,
					version: input.spec.invocationId ?? "attempt-1",
					value: identity,
				}),
				agentSession,
				...input.spec.ontology?.objects,
			};
	const source = childSource
		? {
				kind: "child-admission",
				parentSessionId: childSource.parentSessionId,
				relationId: childSource.relationId,
				admissionId: childSource.admissionId,
				childRunId: childSource.childRunId,
				requestId: childSource.requestId,
				causationId: childSource.causationId,
				childName: childSource.childName,
				depth: childSource.depth,
				workflowOrigin: {
					runId: input.runId,
					workflowName: input.workflowName,
					graphId: input.graphId,
				},
				...agentNodeSpecDocumentSourceFields(input.spec, semantic),
			}
		: {
				kind: "workflow-node",
				runId: input.runId,
				workflowName: input.workflowName,
				graphId: input.graphId,
				nodeKey: input.nodeKey,
				label: input.spec.label,
				phaseIndex: input.spec.phaseIndex,
				...agentNodeSpecDocumentSourceFields(input.spec, semantic),
			};
	return {
		schema: "choreograph.agent-session-document.v1",
		sessionId: input.sessionId,
		meaningfulObjects,
		source,
		transcript: {
			order: [],
			items: {},
		},
		control: {
			schema: "choreograph.agent-session-control.v1",
			driverLease: null,
			permissionRequests: {},
			commandSummary: {},
		},
		runtime: {
			status: "queued",
			sandboxId: null,
			sandboxGeneration: 0,
			kind: semantic.runtime.kind,
			bindingDigest: input.spec.runtimeBindingDigest,
		},
		view: {
			panes: [
				{ id: "transcript", kind: "transcript" },
				{ id: "notebook", kind: "compute.cell", readOnly: true },
				{ id: "control", kind: "control" },
			],
		},
		compute: {
			schema: "choreograph.notebook-projection.v1",
			order: [],
			cells: {},
		},
		forks: [],
		frontier: input.frontier,
	};
}

function agentNodeSpecDocumentSourceFields(
	spec: AgentNodeSpec,
	semantic: {
		readonly runtime: NonNullable<AgentNodeSpec["runtime"]>;
		readonly ontology: NonNullable<AgentNodeSpec["ontology"]>;
		readonly runtimeDigest: string;
		readonly ontologyDigest: string;
	},
): Record<string, unknown> {
	return {
		prompt: spec.prompt,
		model: spec.model,
		...(spec.systemPrompt === undefined ? {} : { systemPrompt: spec.systemPrompt }),
		...(spec.agentId === undefined ? {} : { agentId: spec.agentId }),
		...(spec.provider === undefined ? {} : { provider: spec.provider }),
		...(spec.graphAccess === undefined ? {} : { graphAccess: spec.graphAccess }),
		...(spec.toolMode === undefined ? {} : { toolMode: spec.toolMode }),
		...(spec.excludeTools === undefined ? {} : { excludeTools: [...spec.excludeTools] }),
		...(spec.includeTools === undefined ? {} : { includeTools: [...spec.includeTools] }),
		...(spec.strictToolManifest === undefined ? {} : { strictToolManifest: spec.strictToolManifest }),
		...(spec.interactionMode === undefined ? {} : { interactionMode: spec.interactionMode }),
		...(spec.schema === undefined ? {} : { schema: spec.schema }),
		...(spec.maxTurns === undefined ? {} : { maxTurns: spec.maxTurns }),
		...(spec.agentType === undefined ? {} : { agentType: spec.agentType }),
		...(spec.poolMode === undefined ? {} : { poolMode: spec.poolMode }),
		...(spec.capabilities === undefined ? {} : { capabilities: spec.capabilities }),
		...(spec.contentAuthority === undefined ? {} : { contentAuthority: spec.contentAuthority }),
		...(spec.verifiedExecutionCapsule === undefined
			? {}
			: { verifiedExecutionCapsule: spec.verifiedExecutionCapsule }),
		...(spec.initialGoal === undefined
			? {}
			: {
					initialGoal: {
						objective: spec.initialGoal.objective,
						...(spec.initialGoal.tokenBudget === undefined ? {} : { tokenBudget: spec.initialGoal.tokenBudget }),
					},
				}),
		// A reference to the earlier conversation a continued chat carries (digest, size, counts),
		// validated and normalized here, never its bytes.
		...(spec.seed === undefined ? {} : { seed: parseAgentSeedRef(spec.seed, "spec.seed") }),
		// The rate card the Session is priced by: validated, normalized and checked to price THIS model, or the
		// Session is not begun. Every reader of a price reads it back from here.
		...(spec.pricing === undefined ? {} : { pricing: pricingPinForSpec(spec) }),
		runtimeBinding: semantic.runtime,
		runtimeBindingDigest: semantic.runtimeDigest,
		agentOntologyBinding: semantic.ontology,
		agentOntologyBindingDigest: semantic.ontologyDigest,
	};
}

function pricingPinForSpec(spec: AgentNodeSpec): RateCardV1 {
	const card = parseRateCard(spec.pricing, "spec.pricing");
	assertRateCardBelongsTo(card, spec.model, spec.provider ?? "openrouter", "spec.pricing");
	return card;
}

function requireExecutableSessionBinding(spec: AgentNodeSpec): {
	runtime: NonNullable<AgentNodeSpec["runtime"]>;
	ontology: NonNullable<AgentNodeSpec["ontology"]>;
	runtimeDigest: string;
	ontologyDigest: string;
} {
	if (!spec.runtime) throw new Error("Agent session requires a resolved runtime binding");
	validateResolvedAgentRuntimeBinding(spec.runtime);
	const runtimeDigest = digestAgentRuntimeBinding(spec.runtime);
	if (spec.runtimeBindingDigest !== runtimeDigest) {
		throw new Error("Agent session runtime binding digest is absent or invalid");
	}
	if (!spec.ontology) throw new Error("Agent session requires a complete Agent Ontology binding");
	validateAgentOntologyBinding(spec.ontology);
	const ontologyDigest = digestAgentOntologyBinding(spec.ontology);
	if (spec.ontologyBindingDigest !== ontologyDigest) {
		throw new Error("Agent session ontology binding digest is absent or invalid");
	}
	assertAgentOntologyRuntimeMatch(spec.ontology, {
		agentId: spec.agentId,
		runtimeProfileRef: spec.runtime.profileRef,
	});
	assertContentAuthorityNodeSpec(spec);
	return { runtime: spec.runtime, ontology: spec.ontology, runtimeDigest, ontologyDigest };
}

function assertSessionBindingsStable(existing: AgentSessionRecord, spec: AgentNodeSpec): void {
	const document = agentSessionDocumentFromJson(existing.document_json);
	const source = asRecord(document.source);
	for (const [binding, field, actual] of [
		["runtime", "runtimeBindingDigest", spec.runtimeBindingDigest],
		["ontology", "agentOntologyBindingDigest", spec.ontologyBindingDigest],
	] as const) {
		const expected = source[field];
		if (typeof expected !== "string") continue;
		if (expected !== actual) {
			throw new AgentSessionBindingConflictError(existing.session_id, binding, expected, actual);
		}
	}
	const existingCapsule = source.verifiedExecutionCapsule;
	if (existingCapsule !== undefined || spec.verifiedExecutionCapsule !== undefined) {
		if (!existingCapsule || !spec.verifiedExecutionCapsule) {
			throw new Error("Agent session cannot add or remove its content-authority capsule after creation");
		}
		const persisted = existingCapsule as VerifiedExecutionCapsuleV1;
		assertVerifiedExecutionCapsuleReplay(persisted, persisted.prompt.finalPromptUtf8);
		if (persisted.digest !== spec.verifiedExecutionCapsule.digest) {
			throw new Error("Agent session cannot change its sealed content-authority capsule");
		}
	}
}

function assertContentAuthorityNodeSpec(spec: AgentNodeSpec): void {
	if (spec.contentAuthority === undefined && spec.verifiedExecutionCapsule === undefined) return;
	if (!spec.contentAuthority || !spec.verifiedExecutionCapsule) {
		throw new Error("I-authoritative Agent Session requires both the explicit binding and sealed capsule");
	}
	assertContentAuthorityBinding(spec.contentAuthority);
	assertVerifiedExecutionCapsuleReplay(spec.verifiedExecutionCapsule, spec.contentAuthority.prompt.finalPromptUtf8);
	if (
		spec.verifiedExecutionCapsule.prompt.finalPromptDigest !== spec.contentAuthority.prompt.finalPromptDigest ||
		spec.systemPrompt !== spec.contentAuthority.prompt.finalPromptUtf8
	) {
		throw new Error("I-authoritative Agent Session prompt differs from its sealed content-authority receipt");
	}
}

type RuntimeTx = {
	execute(statement: { sql: string; args: unknown[] }): Promise<{ rows: Row[]; rowsAffected: number }>;
};

/**
 * What `this.tx` hands a transaction body, typed as libSQL types it. `RuntimeTx` above is the older, looser shape
 * and does not accept this one (its `args: unknown[]` is not libSQL's `InValue[]`); a helper written against the
 * real type is checked against the real type, so the newer helpers take this.
 */
type StoreTx = Pick<Transaction, "execute">;

function isPrimeGoalCommandName(value: AgentSessionCommandName): value is "goal.get" | "goal.create" | "goal.complete" {
	return value === "goal.get" || value === "goal.create" || value === "goal.complete";
}

async function registerPrimeGoalCommandTx(
	tx: RuntimeTx,
	sessionId: string,
	command: {
		readonly commandId: string;
		readonly idempotencyKey: string;
		readonly name: "goal.get" | "goal.create" | "goal.complete";
	},
	now: number,
): Promise<void> {
	const current = await readAgentSessionGoalProjectionTx(tx, sessionId);
	const reduced = registerPrimeGoalCommand(current?.handoff_state ?? emptyPrimeGoalHandoffState(), command);
	await writeAgentSessionGoalProjectionTx(tx, {
		session_id: sessionId,
		reducer_state: current?.reducer_state ?? emptyGoalReducerState(),
		handoff_state: reduced.state,
		updated_at: now,
	});
}

async function readAgentSessionGoalProjectionTx(
	tx: RuntimeTx,
	sessionId: string,
): Promise<AgentSessionGoalProjectionRecord | null> {
	const result = await tx.execute({
		sql: "SELECT * FROM agent_session_goal_projections WHERE session_id = ?",
		args: [sessionId],
	});
	return result.rows[0] ? rowToAgentSessionGoalProjection(result.rows[0]) : null;
}

async function writeAgentSessionGoalProjectionTx(
	tx: RuntimeTx,
	record: AgentSessionGoalProjectionRecord,
): Promise<void> {
	await tx.execute({
		sql: `INSERT INTO agent_session_goal_projections
			(session_id, reducer_state_json, handoff_state_json, updated_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(session_id) DO UPDATE SET
				reducer_state_json = excluded.reducer_state_json,
				handoff_state_json = excluded.handoff_state_json,
				updated_at = excluded.updated_at`,
		args: [
			record.session_id,
			canonicalJson(record.reducer_state),
			canonicalJson(record.handoff_state),
			record.updated_at,
		],
	});
}

function goalReducerOperationFromPrime(input: PrimeGoalReducerInput, now: number): GoalReducerOperation {
	const goal = input.response.goal;
	if (!goal?.goal_id) throw new AgentSessionGenerationFault("Goal command response has no canonical goal_id");
	const at =
		input.commandName === "goal.create" ? (goal.created_at ?? goal.updated_at ?? now) : (goal.updated_at ?? now);
	if (input.commandName === "goal.create") {
		return {
			kind: "goal.create",
			idempotencyKey: input.idempotencyKey,
			commandId: input.commandId,
			goalId: goal.goal_id,
			objective: goal.objective,
			...(goal.token_budget === undefined ? {} : { tokenBudget: goal.token_budget }),
			at,
		};
	}
	if (goal.status !== "complete") {
		throw new AgentSessionGenerationFault("goal.complete response is not terminal complete");
	}
	return {
		kind: "goal.complete",
		idempotencyKey: input.idempotencyKey,
		commandId: input.commandId,
		goalId: goal.goal_id,
		...(input.response.completion_budget_report === null ? {} : { reason: input.response.completion_budget_report }),
		at,
	};
}

function withGoalReducerEventSequence(
	state: GoalReducerState,
	idempotencyKey: string,
	eventSequence: number,
): GoalReducerState {
	const receipt = state.receipts[idempotencyKey];
	if (!receipt) throw new AgentSessionGenerationFault("Goal reducer emission has no durable receipt");
	return { ...state, receipts: { ...state.receipts, [idempotencyKey]: { ...receipt, eventSequence } } };
}

async function completeAgentSessionCommandTx(
	tx: RuntimeTx,
	commandId: string,
	generation: number,
	input: { status: "completed" | "failed"; result?: unknown; error?: string; now: number },
): Promise<AgentSessionCommandRecord | null> {
	const current = await readAgentSessionCommandTx(tx, commandId);
	if (!current) return null;
	if (["completed", "failed", "cancelled", "rejected"].includes(current.state)) return current;
	if (current.state !== "delivered" || current.delivery_generation !== generation) {
		throw new AgentSessionGenerationFault("Command result belongs to a stale or undelivered generation");
	}
	await tx.execute({
		sql: `UPDATE agent_session_commands
			SET state = ?, result_json = ?, error = ?, completed_at = ?
			WHERE command_id = ? AND state = 'delivered' AND delivery_generation = ?`,
		args: [
			input.status,
			input.result === undefined ? null : JSON.stringify(input.result),
			input.error ?? null,
			input.now,
			commandId,
			generation,
		],
	});
	const session = await readAgentSessionTx(tx, current.session_id);
	if (session) {
		const stored = agentSessionDocumentFromJson(session.document_json);
		const control = normalizeAgentSessionControl(stored);
		const commandSummary = asRecord(control.commandSummary);
		control.commandSummary = {
			...commandSummary,
			completed: Number(commandSummary.completed ?? 0) + (input.status === "completed" ? 1 : 0),
			failed: Number(commandSummary.failed ?? 0) + (input.status === "failed" ? 1 : 0),
			lastCommandId: commandId,
			lastCommandName: current.name,
			lastCommandState: input.status,
			deliveryGeneration: generation,
		};
		// The person's message carries the moment it was sent and the reply the moment
		// it completed (D4); a regrown generation's node result that only repeats this
		// reply is removed so the transcript holds each reply once (D3).
		const document = appendCommandTranscript(stored, {
			sessionId: current.session_id,
			commandId,
			commandName: current.name,
			payload: current.payload,
			submittedAt: current.submitted_at,
			generation,
			status: input.status,
			result: input.result,
			error: input.error,
			completedAt: input.now,
			model: session.model,
		});
		document.control = control;
		const documentOp = await appendAgentSessionDocumentOpTx(tx, current.session_id, {
			ts: input.now,
			actor: "choreograph.agent-worker",
			kind: `command.${input.status}`,
			patch: { op: "command.complete", commandId, name: current.name, status: input.status, generation },
			document,
		});
		await tx.execute({
			sql: "UPDATE agent_sessions SET document_json = ?, updated_at = ? WHERE session_id = ?",
			args: [JSON.stringify(documentOp.document), input.now, current.session_id],
		});
		await appendAgentSessionEventTx(tx, current.session_id, {
			type: `command.${input.status}`,
			ts: input.now,
			payload: { commandId, name: current.name, generation, error: input.error },
		});
	}
	const updated = await tx.execute({
		sql: "SELECT * FROM agent_session_commands WHERE command_id = ?",
		args: [commandId],
	});
	return rowToAgentSessionCommand(updated.rows[0]!);
}

async function readAgentSessionCommandTx(tx: RuntimeTx, commandId: string): Promise<AgentSessionCommandRecord | null> {
	const result = await tx.execute({
		sql: "SELECT * FROM agent_session_commands WHERE command_id = ?",
		args: [commandId],
	});
	return result.rows[0] ? rowToAgentSessionCommand(result.rows[0]) : null;
}

async function readAgentSessionCommandActivationTx(
	tx: RuntimeTx,
	commandId: string,
): Promise<AgentSessionCommandActivationRecord | null> {
	const result = await tx.execute({
		sql: "SELECT * FROM agent_session_command_activation_work WHERE command_id = ?",
		args: [commandId],
	});
	return result.rows[0] ? rowToAgentSessionCommandActivation(result.rows[0]) : null;
}

/** Re-throw a regrow refusal with the command it belongs to, so the claim can settle that command and go on. */
async function refusingRegrow<T>(commandId: string, attempt: () => Promise<T>): Promise<T> {
	try {
		return await attempt();
	} catch (error) {
		if (error instanceof AgentSessionRegrowRefusedFault)
			throw new AgentSessionCommandActivationRefused(commandId, error);
		throw error;
	}
}

async function prepareAgentSessionCommandActivationAttemptTx(
	tx: RuntimeTx,
	work: AgentSessionCommandActivationRecord,
	command: AgentSessionCommandRecord,
	now: number,
): Promise<AgentSessionCommandActivationRecord | null> {
	const current = await readAgentMaterializationTx(tx, work.session_id, work.target_generation);
	if (
		current?.activation_id === work.activation_id &&
		current.state === "claimed" &&
		current.sandbox_id === `claim:${work.activation_id}`
	) {
		return work;
	}
	if (current?.activation_id === work.activation_id && current.state === "running") return null;

	const latestResult = await tx.execute({
		sql: "SELECT * FROM agent_materializations WHERE session_id = ? ORDER BY generation DESC LIMIT 1",
		args: [work.session_id],
	});
	const latest = latestResult.rows[0] ? rowToAgentMaterialization(latestResult.rows[0]) : null;
	if (!latest || command.target_generation > latest.generation + 1) return null;
	if (
		latest.state !== "passivated" &&
		latest.state !== "authority_revoked" &&
		!(latest.state === "faulted" && latest.recoverable === true)
	) {
		return null;
	}
	const targetGeneration = latest.generation + 1;
	const activationId = agentSessionCommandActivationId(work.session_id, work.command_id, targetGeneration);
	await claimAgentMaterializationTx(tx, work.session_id, {
		generation: targetGeneration,
		activationId,
		now,
	});
	const updated = await tx.execute({
		sql: `UPDATE agent_session_command_activation_work
		       SET target_generation = ?, activation_id = ?
		       WHERE command_id = ? AND state = 'pending' AND target_generation = ? AND activation_id = ?`,
		args: [targetGeneration, activationId, work.command_id, work.target_generation, work.activation_id],
	});
	if (updated.rowsAffected !== 1) return null;
	return readAgentSessionCommandActivationTx(tx, work.command_id);
}

async function claimAgentSessionCommandActivationWorkTx(
	tx: RuntimeTx,
	work: AgentSessionCommandActivationRecord,
	command: AgentSessionCommandRecord,
	input: { readonly consumer: string; readonly leaseMs: number; readonly now: number },
): Promise<AgentSessionCommandActivationClaim | null> {
	const claimToken = randomUUID();
	const updated = await tx.execute({
		sql: `UPDATE agent_session_command_activation_work
		       SET state = 'claimed', attempt = attempt + 1, consumer = ?, claim_token = ?, claimed_at = ?,
		           claim_expires_at = ?, heartbeat_at = ?, last_error = NULL
		       WHERE command_id = ? AND state = 'pending' AND not_before <= ?`,
		args: [
			input.consumer,
			claimToken,
			input.now,
			checkedBudgetSum(input.now, input.leaseMs),
			input.now,
			work.command_id,
			input.now,
		],
	});
	if (updated.rowsAffected !== 1) return null;
	const activation = await readAgentSessionCommandActivationTx(tx, work.command_id);
	if (!activation) throw new Error("claimed command activation vanished");
	return { activation, command };
}

async function terminalizeAgentSessionCommandActivationWorkTx(
	tx: RuntimeTx,
	commandId: string,
	state: "completed" | "failed",
	error: string | null,
	now: number,
): Promise<void> {
	await tx.execute({
		sql: `UPDATE agent_session_command_activation_work
		       SET state = ?, consumer = NULL, claim_token = NULL, claimed_at = NULL,
		           claim_expires_at = NULL, heartbeat_at = NULL, last_error = ?, completed_at = ?
		       WHERE command_id = ? AND state IN ('pending', 'claimed')`,
		args: [state, error, now, commandId],
	});
}

function validateAgentSessionCommandActivationLeaseInput<
	Input extends AgentSessionCommandActivationLeaseInput & { readonly leaseMs?: number },
>(input: Input, requireLeaseMs: boolean): Input {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new AgentSessionCommandActivationFault("request_invalid", "command activation lease must be an object");
	}
	requiredChildRunText(input.consumer, "command activation consumer", 256);
	requiredChildRunText(input.claimToken, "command activation claim token", 256);
	validateChildRunTimestamp(input.now, "command activation lease time");
	if (requireLeaseMs) validatePositiveChildRunInteger(input.leaseMs, "command activation lease duration");
	return input;
}

function assertAgentSessionCommandActivationLease(
	work: AgentSessionCommandActivationRecord,
	input: AgentSessionCommandActivationLeaseInput,
): void {
	if (work.state !== "claimed" || work.consumer !== input.consumer || work.claim_token !== input.claimToken) {
		throw new AgentSessionCommandActivationFault("lease_lost", "command activation lease token is stale");
	}
	if (work.claim_expires_at === null || work.claim_expires_at <= input.now) {
		throw new AgentSessionCommandActivationFault("lease_expired", "command activation lease expired");
	}
	if (work.heartbeat_at === null || work.heartbeat_at > input.now) {
		throw new AgentSessionCommandActivationFault("lease_lost", "command activation heartbeat is invalid");
	}
}

const AGENT_SESSION_SCHEDULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const AGENT_SESSION_SCHEDULE_PROMPT_MAX_BYTES = 64 * 1024;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const GREGORIAN_CYCLE_DAYS = 146_097;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

interface ParsedAgentSessionCron {
	readonly expression: string;
	readonly minutes: readonly number[];
	readonly hours: readonly number[];
	readonly daysOfMonth: ReadonlySet<number>;
	readonly months: ReadonlySet<number>;
	readonly daysOfWeek: ReadonlySet<number>;
}

function validateAgentSessionScheduleCreateInput(
	input: CreateAgentSessionScheduleInput,
): CreateAgentSessionScheduleInput & { readonly options: Required<AgentSessionScheduleCreationOptionsV1> } {
	if (!input || typeof input !== "object") {
		throw new AgentSessionScheduleFault("request_invalid", "Schedule create input must be an object");
	}
	const requestId = requiredAgentSessionScheduleId(input.requestId, "schedule requestId");
	const scheduleId = requiredAgentSessionScheduleId(input.scheduleId, "scheduleId");
	const clientId = requiredAgentSessionScheduleText(input.clientId, "schedule clientId", 256);
	validateAgentSessionScheduleTimestamp(input.now, "schedule create time");
	if (!input.prompt || typeof input.prompt !== "object" || Array.isArray(input.prompt)) {
		throw new AgentSessionScheduleFault("request_invalid", "Schedule prompt must be an object");
	}
	if (Object.keys(input.prompt).some((field) => field !== "text")) {
		throw new AgentSessionScheduleFault("request_invalid", "G1 schedule prompt supports only text");
	}
	const text = requiredAgentSessionScheduleText(
		input.prompt.text,
		"schedule prompt.text",
		AGENT_SESSION_SCHEDULE_PROMPT_MAX_BYTES,
	);
	const definition = normalizeAgentSessionScheduleDefinition(input.definition, input.now);
	const options = normalizeAgentSessionScheduleCreationOptions(input.options);
	return { requestId, scheduleId, definition, prompt: { text }, clientId, now: input.now, options };
}

function normalizeAgentSessionScheduleCreationOptions(
	value: AgentSessionScheduleCreationOptionsV1 | undefined,
): Required<AgentSessionScheduleCreationOptionsV1> {
	if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
		throw new AgentSessionScheduleFault("request_invalid", "Schedule creation options must be an object");
	}
	if (
		value &&
		Object.keys(value).some((field) => !["source", "label", "deliveryMode", "grantSnapshotDigest"].includes(field))
	) {
		throw new AgentSessionScheduleFault("request_invalid", "Schedule creation options contain unknown fields");
	}
	const source = value?.source ?? "internal";
	if (source !== "internal" && source !== "public" && source !== "rlm_heartbeat") {
		throw new AgentSessionScheduleFault("request_invalid", "Schedule source is unsupported");
	}
	const rawLabel = value?.label ?? null;
	if (rawLabel !== null && typeof rawLabel !== "string") {
		throw new AgentSessionScheduleFault("request_invalid", "Schedule label must be a string or null");
	}
	const label = rawLabel === null ? null : rawLabel.trim();
	if (label !== null && new TextEncoder().encode(label).byteLength > 512) {
		throw new AgentSessionScheduleFault("request_invalid", "Schedule label is too large");
	}
	const deliveryMode = value?.deliveryMode ?? "steer";
	if (deliveryMode !== "steer" && deliveryMode !== "follow_up") {
		throw new AgentSessionScheduleFault("request_invalid", "Schedule delivery mode is unsupported");
	}
	const grantSnapshotDigest = value?.grantSnapshotDigest ?? null;
	if (
		grantSnapshotDigest !== null &&
		(typeof grantSnapshotDigest !== "string" || !/^[0-9a-f]{64}$/.test(grantSnapshotDigest))
	) {
		throw new AgentSessionScheduleFault(
			"request_invalid",
			"Schedule grant snapshot digest must be canonical lowercase hex",
		);
	}
	return { source, label: label || null, deliveryMode, grantSnapshotDigest };
}

function validateAgentSessionScheduleControlInput(
	input: AgentSessionScheduleControlInput,
): AgentSessionScheduleControlInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new AgentSessionScheduleFault("request_invalid", "Schedule control input must be an object");
	}
	if (input.schema !== "choreograph.agent-session-schedule-control.v1") {
		throw new AgentSessionScheduleFault("request_invalid", "Schedule control schema is unsupported");
	}
	const requestId = requiredAgentSessionScheduleId(input.requestId, "schedule control requestId");
	const scheduleId = requiredAgentSessionScheduleId(input.scheduleId, "schedule control scheduleId");
	const clientId = requiredAgentSessionScheduleText(input.clientId, "schedule control clientId", 256);
	validateAgentSessionScheduleTimestamp(input.now, "schedule control time");
	if (input.expectedRevision !== undefined)
		validateNonNegativeAgentSessionScheduleInteger(input.expectedRevision, "expectedRevision");
	if (!input.action || typeof input.action !== "object" || Array.isArray(input.action)) {
		throw new AgentSessionScheduleFault("request_invalid", "Schedule control action must be an object");
	}
	if (input.action.kind === "pause" || input.action.kind === "resume") {
		if (Object.keys(input.action).length !== 1)
			throw new AgentSessionScheduleFault("request_invalid", "Pause/resume action has unknown fields");
	} else if (input.action.kind === "update") {
		const keys = Object.keys(input.action);
		if (keys.some((key) => !["kind", "schedule", "input", "label", "deliveryMode"].includes(key))) {
			throw new AgentSessionScheduleFault("request_invalid", "Schedule update action has unknown fields");
		}
		if (!keys.some((key) => key !== "kind"))
			throw new AgentSessionScheduleFault("request_invalid", "Schedule update has no changes");
		if (input.action.input !== undefined) {
			if (
				!input.action.input ||
				typeof input.action.input !== "object" ||
				Array.isArray(input.action.input) ||
				Object.keys(input.action.input).some((key) => key !== "text")
			) {
				throw new AgentSessionScheduleFault("request_invalid", "Schedule update input supports only text");
			}
			requiredAgentSessionScheduleText(
				input.action.input.text,
				"schedule update input.text",
				AGENT_SESSION_SCHEDULE_PROMPT_MAX_BYTES,
			);
		}
		if (
			Object.hasOwn(input.action, "label") &&
			input.action.label !== null &&
			typeof input.action.label !== "string"
		) {
			throw new AgentSessionScheduleFault("request_invalid", "Schedule label must be a string or null");
		}
		if (
			input.action.deliveryMode !== undefined &&
			input.action.deliveryMode !== "steer" &&
			input.action.deliveryMode !== "follow_up"
		) {
			throw new AgentSessionScheduleFault("request_invalid", "Schedule delivery mode is unsupported");
		}
	} else {
		throw new AgentSessionScheduleFault("request_invalid", "Schedule control action is unsupported");
	}
	return { ...input, requestId, scheduleId, clientId };
}

function validateNonNegativeAgentSessionScheduleInteger(value: unknown, label: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new AgentSessionScheduleFault("request_invalid", `${label} must be a non-negative safe integer`);
	}
}

function normalizeAgentSessionScheduleLabel(value: string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	const normalized = value.trim();
	if (new TextEncoder().encode(normalized).byteLength > 512) {
		throw new AgentSessionScheduleFault("request_invalid", "Schedule label is too large");
	}
	return normalized || null;
}

function normalizedAgentSessionScheduleControlAction(
	action: AgentSessionScheduleControlRequestV1["action"],
	definition: AgentSessionScheduleDefinition,
	prompt: AgentSessionSchedulePrompt,
	label: string | null,
	deliveryMode: "steer" | "follow_up",
): AgentSessionScheduleControlRequestV1["action"] {
	if (action.kind === "pause" || action.kind === "resume") return action;
	return {
		kind: "update",
		...(action.schedule === undefined ? {} : { schedule: agentSessionScheduleContractSpec(definition) }),
		...(action.input === undefined ? {} : { input: { text: prompt.text } }),
		...(Object.hasOwn(action, "label") ? { label } : {}),
		...(action.deliveryMode === undefined ? {} : { deliveryMode }),
	};
}

/**
 * The one public conversion from the model-facing UTC schedule contract into
 * the durable scheduler definition.  Production adapters must use this rather
 * than recreate calendar or ISO parsing at their own boundary.
 */
export function agentSessionScheduleDefinitionFromSpec(
	spec: AgentSessionScheduleSpecV1,
	now: number,
): AgentSessionScheduleDefinition {
	if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
		throw new AgentSessionScheduleFault("request_invalid", "Schedule update definition must be an object");
	}
	if (spec.kind === "interval") {
		validateExactScheduleFields(spec, ["kind", "expression", "timeZone", "intervalMs"]);
		const firstFireAt = Date.parse(spec.expression);
		if (!Number.isSafeInteger(firstFireAt))
			throw new AgentSessionScheduleFault("request_invalid", "Interval expression must be an ISO timestamp");
		return normalizeAgentSessionScheduleDefinition(
			{ kind: "interval", firstFireAt, intervalMs: spec.intervalMs },
			now,
		);
	}
	validateExactScheduleFields(spec, ["kind", "expression", "timeZone"]);
	if (spec.kind === "cron")
		return normalizeAgentSessionScheduleDefinition(
			{ kind: "cron", expression: spec.expression, timezone: "UTC" },
			now,
		);
	const fireAt = Date.parse(spec.expression);
	if (!Number.isSafeInteger(fireAt))
		throw new AgentSessionScheduleFault("request_invalid", "Once expression must be an ISO timestamp");
	return normalizeAgentSessionScheduleDefinition({ kind: "once", fireAt }, now);
}

/**
 * The heartbeat skill expresses intervals as durations (`every 5m`), whereas
 * the public schedule contract expresses an interval's first fire as ISO. The
 * host, not the model, fixes that first-fire coordinate at committed mutation
 * time. Heartbeats are recurring: one-shot input is deliberately rejected.
 */
export function agentSessionHeartbeatScheduleDefinitionFromSpec(
	spec: AgentSessionScheduleSpecV1,
	now: number,
): AgentSessionScheduleDefinition {
	if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
		throw new AgentSessionScheduleFault("request_invalid", "Heartbeat schedule must be an object");
	}
	if (spec.kind === "interval") {
		validateExactScheduleFields(spec, ["kind", "expression", "timeZone", "intervalMs"]);
		if (spec.timeZone !== "UTC") {
			throw new AgentSessionScheduleFault("request_invalid", "Heartbeat interval timezone must be UTC");
		}
		return normalizeAgentSessionScheduleDefinition(
			{ kind: "interval", firstFireAt: checkedScheduleSum(now, spec.intervalMs), intervalMs: spec.intervalMs },
			now,
		);
	}
	if (spec.kind === "cron") {
		validateExactScheduleFields(spec, ["kind", "expression", "timeZone"]);
		if (spec.timeZone !== "UTC") {
			throw new AgentSessionScheduleFault("request_invalid", "Heartbeat cron timezone must be UTC");
		}
		return normalizeAgentSessionScheduleDefinition(
			{ kind: "cron", expression: spec.expression, timezone: "UTC" },
			now,
		);
	}
	throw new AgentSessionScheduleFault("request_invalid", "Heartbeat schedules must recur");
}

function nextAgentSessionScheduleAfterResume(definition: AgentSessionScheduleDefinition, now: number): number {
	if (definition.kind === "once") return Math.max(definition.fireAt, now);
	if (definition.kind === "interval") return checkedScheduleSum(now, definition.intervalMs);
	return nextAgentSessionCronAtOrAfter(parseAgentSessionCron(definition.expression), now);
}

function validateAgentSessionScheduleCancelInput(
	scheduleId: string,
	input: CancelAgentSessionScheduleInput,
): Required<CancelAgentSessionScheduleInput> & { readonly scheduleId: string } {
	if (!input || typeof input !== "object") {
		throw new AgentSessionScheduleFault("request_invalid", "Schedule cancellation input must be an object");
	}
	validateAgentSessionScheduleTimestamp(input.now, "schedule cancellation time");
	return {
		scheduleId: requiredAgentSessionScheduleId(scheduleId, "scheduleId"),
		requestId: requiredAgentSessionScheduleId(input.requestId, "schedule cancellation requestId"),
		clientId: requiredAgentSessionScheduleText(input.clientId, "schedule cancellation clientId", 256),
		reason: requiredAgentSessionScheduleText(input.reason ?? "requested", "schedule cancellation reason", 2048),
		now: input.now,
	};
}

function normalizeAgentSessionScheduleDefinition(
	value: AgentSessionScheduleDefinition,
	now: number,
): AgentSessionScheduleDefinition {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new AgentSessionScheduleFault("request_invalid", "Schedule definition must be an object");
	}
	if (value.kind === "once") {
		validateExactScheduleFields(value, ["kind", "fireAt"]);
		validateAgentSessionScheduleTimestamp(value.fireAt, "once fireAt");
		return { kind: "once", fireAt: value.fireAt };
	}
	if (value.kind === "interval") {
		validateExactScheduleFields(value, ["kind", "firstFireAt", "intervalMs"]);
		validateAgentSessionScheduleTimestamp(value.firstFireAt, "interval firstFireAt");
		validatePositiveAgentSessionScheduleInteger(value.intervalMs, "interval intervalMs");
		if (value.intervalMs < 10_000) {
			throw new AgentSessionScheduleFault("request_invalid", "Interval schedule intervalMs must be at least 10000");
		}
		checkedScheduleSum(value.firstFireAt, value.intervalMs);
		return { kind: "interval", firstFireAt: value.firstFireAt, intervalMs: value.intervalMs };
	}
	if (value.kind === "cron") {
		validateExactScheduleFields(value, ["kind", "expression", "timezone"]);
		if (value.timezone !== "UTC") {
			throw new AgentSessionScheduleFault("request_invalid", "G1 cron timezone must be UTC");
		}
		const parsed = parseAgentSessionCron(value.expression);
		// Validate that the numeric expression has at least one real Gregorian occurrence.
		nextAgentSessionCronAtOrAfter(parsed, now);
		return { kind: "cron", expression: parsed.expression, timezone: "UTC" };
	}
	throw new AgentSessionScheduleFault("request_invalid", "Schedule definition kind is unsupported");
}

function validateExactScheduleFields(value: object, expected: readonly string[]): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
		throw new AgentSessionScheduleFault(
			"request_invalid",
			`Schedule definition fields must be exactly ${wanted.join(", ")}`,
		);
	}
}

function scheduleDefinitionFields(
	definition: AgentSessionScheduleDefinition,
	now: number,
): {
	readonly kind: AgentSessionScheduleDefinition["kind"];
	readonly fireAt: number | null;
	readonly intervalMs: number | null;
	readonly cronExpression: string | null;
	readonly timezone: "UTC" | null;
	readonly nextFireAt: number;
} {
	if (definition.kind === "once") {
		return {
			kind: "once",
			fireAt: definition.fireAt,
			intervalMs: null,
			cronExpression: null,
			timezone: null,
			nextFireAt: definition.fireAt,
		};
	}
	if (definition.kind === "interval") {
		return {
			kind: "interval",
			fireAt: definition.firstFireAt,
			intervalMs: definition.intervalMs,
			cronExpression: null,
			timezone: null,
			nextFireAt: definition.firstFireAt,
		};
	}
	return {
		kind: "cron",
		fireAt: null,
		intervalMs: null,
		cronExpression: definition.expression,
		timezone: "UTC",
		nextFireAt: nextAgentSessionCronAtOrAfter(parseAgentSessionCron(definition.expression), now),
	};
}

function agentSessionScheduleContractSpec(definition: AgentSessionScheduleDefinition):
	| { readonly kind: "once"; readonly expression: string; readonly timeZone: "UTC" }
	| {
			readonly kind: "interval";
			readonly expression: string;
			readonly timeZone: "UTC";
			readonly intervalMs: number;
	  }
	| { readonly kind: "cron"; readonly expression: string; readonly timeZone: "UTC" } {
	if (definition.kind === "once") {
		return {
			kind: "once",
			expression: agentSessionScheduleTimestampIso(definition.fireAt),
			timeZone: "UTC",
		};
	}
	if (definition.kind === "interval") {
		return {
			kind: "interval",
			expression: agentSessionScheduleTimestampIso(definition.firstFireAt),
			timeZone: "UTC",
			intervalMs: definition.intervalMs,
		};
	}
	return { kind: "cron", expression: definition.expression, timeZone: "UTC" };
}

function agentSessionScheduleTimestampIso(timestamp: number): string {
	validateAgentSessionScheduleTimestamp(timestamp, "schedule testimony timestamp");
	return new Date(timestamp).toISOString();
}

function validateAgentSessionScheduleClaimInput(input: {
	readonly consumer: string;
	readonly leaseMs: number;
	readonly now: number;
}): { readonly consumer: string; readonly leaseMs: number; readonly now: number } {
	if (!input || typeof input !== "object") {
		throw new AgentSessionScheduleFault("request_invalid", "Schedule fire claim must be an object");
	}
	const consumer = requiredAgentSessionScheduleText(input.consumer, "schedule consumer", 256);
	validatePositiveAgentSessionScheduleInteger(input.leaseMs, "schedule leaseMs");
	validateAgentSessionScheduleTimestamp(input.now, "schedule claim time");
	checkedScheduleSum(input.now, input.leaseMs);
	return { consumer, leaseMs: input.leaseMs, now: input.now };
}

function validateAgentSessionScheduleLeaseInput(
	input: RenewAgentSessionScheduleFireLeaseInput,
): RenewAgentSessionScheduleFireLeaseInput {
	if (!input || typeof input !== "object") {
		throw new AgentSessionScheduleFault("request_invalid", "Schedule fire lease must be an object");
	}
	const consumer = requiredAgentSessionScheduleText(input.consumer, "schedule consumer", 256);
	const claimToken = requiredAgentSessionScheduleText(input.claimToken, "schedule claimToken", 256);
	validatePositiveAgentSessionScheduleInteger(input.leaseMs, "schedule leaseMs");
	validateAgentSessionScheduleTimestamp(input.now, "schedule lease time");
	checkedScheduleSum(input.now, input.leaseMs);
	return { consumer, claimToken, leaseMs: input.leaseMs, now: input.now };
}

function validateAgentSessionScheduleSettlementInput(
	input: SettleAgentSessionScheduleFireInput,
): SettleAgentSessionScheduleFireInput {
	if (!input || typeof input !== "object") {
		throw new AgentSessionScheduleFault("request_invalid", "Schedule fire settlement must be an object");
	}
	const consumer = requiredAgentSessionScheduleText(input.consumer, "schedule consumer", 256);
	const claimToken = requiredAgentSessionScheduleText(input.claimToken, "schedule claimToken", 256);
	validateAgentSessionScheduleTimestamp(input.now, "schedule settlement time");
	if (input.outcome === "completed") return { consumer, claimToken, now: input.now, outcome: "completed" };
	if (input.outcome === "terminal_failure") {
		return {
			consumer,
			claimToken,
			now: input.now,
			outcome: "terminal_failure",
			error: requiredAgentSessionScheduleText(input.error, "schedule terminal error", 2048),
		};
	}
	if (input.outcome === "retryable_failure") {
		validateAgentSessionScheduleTimestamp(input.retryAt, "schedule retryAt");
		if (input.retryAt < input.now) {
			throw new AgentSessionScheduleFault("request_invalid", "Schedule retryAt cannot predate settlement");
		}
		return {
			consumer,
			claimToken,
			now: input.now,
			outcome: "retryable_failure",
			error: requiredAgentSessionScheduleText(input.error, "schedule retryable error", 2048),
			retryAt: input.retryAt,
		};
	}
	throw new AgentSessionScheduleFault("request_invalid", "Schedule fire settlement outcome is unsupported");
}

function requiredAgentSessionScheduleId(value: unknown, label: string): string {
	if (typeof value !== "string" || !AGENT_SESSION_SCHEDULE_ID_PATTERN.test(value)) {
		throw new AgentSessionScheduleFault("request_invalid", `${label} must be a bounded stable identifier`);
	}
	return value;
}

function requiredAgentSessionScheduleText(value: unknown, label: string, maxBytes: number): string {
	if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maxBytes) {
		throw new AgentSessionScheduleFault("request_invalid", `${label} must be non-empty and bounded`);
	}
	return value;
}

function validateAgentSessionScheduleTimestamp(value: unknown, label: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_DATE_TIMESTAMP_MS) {
		throw new AgentSessionScheduleFault(
			"request_invalid",
			`${label} must be a UTC-representable millisecond integer`,
		);
	}
}

function validatePositiveAgentSessionScheduleInteger(value: unknown, label: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw new AgentSessionScheduleFault("request_invalid", `${label} must be a positive safe integer`);
	}
}

function checkedScheduleSum(left: number, right: number): number {
	const sum = left + right;
	if (!Number.isSafeInteger(sum)) {
		throw new AgentSessionScheduleFault("request_invalid", "Schedule time arithmetic exceeded safe integer range");
	}
	return sum;
}

async function fenceAgentSessionScheduleClockTx(tx: RuntimeTx, now: number): Promise<void> {
	validateAgentSessionScheduleTimestamp(now, "schedule host time");
	const fenced = await tx.execute({
		sql: `UPDATE agent_session_schedule_clock SET last_now = ?
		      WHERE singleton = 1 AND last_now <= ? RETURNING last_now`,
		args: [now, now],
	});
	if (!fenced.rows[0]) {
		const current = await tx.execute({
			sql: "SELECT last_now FROM agent_session_schedule_clock WHERE singleton = 1",
			args: [],
		});
		throw new AgentSessionScheduleFault(
			"clock_regression",
			`Schedule host time ${String(now)} predates durable fence ${String(current.rows[0]?.last_now)}`,
		);
	}
}

async function readAgentSessionScheduleTx(
	tx: RuntimeTx,
	sessionId: string,
	scheduleId: string,
): Promise<AgentSessionScheduleRecord | null> {
	const result = await tx.execute({
		sql: "SELECT * FROM agent_session_schedules WHERE session_id = ? AND schedule_id = ?",
		args: [sessionId, scheduleId],
	});
	return result.rows[0] ? rowToAgentSessionSchedule(result.rows[0]) : null;
}

async function readAgentSessionScheduleFireTx(
	tx: RuntimeTx,
	fireId: string,
): Promise<AgentSessionScheduleFireRecord | null> {
	const result = await tx.execute({
		sql: `SELECT fire.*, work.state, work.attempt, work.consumer, work.claim_token,
		             work.claimed_at, work.claim_expires_at, work.heartbeat_at,
		             work.not_before, work.last_error, work.completed_at
		        FROM agent_session_schedule_fires AS fire
		        JOIN agent_session_schedule_fire_work AS work ON work.fire_id = fire.fire_id
		       WHERE fire.fire_id = ?`,
		args: [fireId],
	});
	return result.rows[0] ? rowToAgentSessionScheduleFire(result.rows[0]) : null;
}

async function claimExistingAgentSessionScheduleFireTx(
	tx: RuntimeTx,
	fireId: string,
	claim: { readonly consumer: string; readonly leaseMs: number; readonly now: number },
): Promise<AgentSessionScheduleFireClaim | null> {
	const claimToken = randomUUID();
	const updated = await tx.execute({
		sql: `UPDATE agent_session_schedule_fire_work
		         SET state = 'claimed', attempt = attempt + 1, consumer = ?, claim_token = ?,
		             claimed_at = ?, claim_expires_at = ?, heartbeat_at = ?
		       WHERE fire_id = ? AND ((state = 'pending' AND not_before <= ?)
		          OR (state = 'claimed' AND claim_expires_at <= ?))
		       RETURNING fire_id`,
		args: [
			claim.consumer,
			claimToken,
			claim.now,
			checkedScheduleSum(claim.now, claim.leaseMs),
			claim.now,
			fireId,
			claim.now,
			claim.now,
		],
	});
	if (!updated.rows[0]) return null;
	const fire = await readAgentSessionScheduleFireTx(tx, fireId);
	if (!fire) throw new Error(`Claimed schedule fire vanished: ${fireId}`);
	const commandResult = await tx.execute({
		sql: "SELECT * FROM agent_session_commands WHERE command_id = ?",
		args: [fire.command_id],
	});
	if (!commandResult.rows[0]) throw new Error(`Schedule fire command vanished: ${fire.command_id}`);
	return { fire, command: rowToAgentSessionCommand(commandResult.rows[0]), claimed: true };
}

/**
 * G1 has no scheduler-owned external capability grant snapshot. Preserve the
 * original descriptors, but never reinterpret them as restart authority.
 */
async function agentSessionScheduleExternalAuthorityRequirementTx(
	tx: RuntimeTx,
	session: AgentSessionRecord,
): Promise<string | null> {
	let spec: ScheduledActivationAgentNodeSpec;
	try {
		spec = reconstructResidentCommandActivationAgentNodeSpec(
			session,
			{
				generation: 0,
				activationId: "schedule-authority-validation",
			},
			true,
		);
	} catch {
		return "durable root execution spec is not reconstructable";
	}
	const nodeCapabilities = Object.keys(spec.capabilities ?? {}).sort();
	if (nodeCapabilities.length > 0) {
		return `node capability descriptors (${nodeCapabilities.join(", ")})`;
	}
	if (spec.includeTools && spec.includeTools.length > 0) return `node tool includes (${spec.includeTools.join(", ")})`;

	const workflow = await tx.execute({
		sql: "SELECT inputs_json FROM workflow_instances WHERE run_id = ?",
		args: [session.run_id],
	});
	if (!workflow.rows[0]) return "durable workflow authority is missing";
	let inputs: unknown;
	try {
		inputs = JSON.parse(String(workflow.rows[0].inputs_json));
	} catch {
		return "durable workflow inputs are invalid";
	}
	if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) return "durable workflow inputs are invalid";
	const inputRecord = inputs as Record<string, unknown>;
	if (!Object.hasOwn(inputRecord, "hostContext")) return null;
	const hostContext = inputRecord.hostContext;
	if (!hostContext || typeof hostContext !== "object" || Array.isArray(hostContext)) return null;
	const host = hostContext as Record<string, unknown>;
	if (host.schema !== "sophia.domain-agent-host-context.v1") return null;
	if (!host.toolbelt || typeof host.toolbelt !== "object" || Array.isArray(host.toolbelt)) {
		return "durable Domain Agent toolbelt is invalid";
	}
	const toolbelt = host.toolbelt as Record<string, unknown>;
	if (!Array.isArray(toolbelt.capabilities) || !Array.isArray(toolbelt.tools)) {
		return "durable Domain Agent toolbelt is incomplete";
	}
	for (const capability of toolbelt.capabilities) {
		if (!capability || typeof capability !== "object" || Array.isArray(capability)) {
			return "durable Domain Agent capability declaration is invalid";
		}
		const name = (capability as Record<string, unknown>).capability;
		if (typeof name !== "string" || !name.trim()) {
			return "durable Domain Agent capability name is invalid";
		}
		return `durable Domain Agent capability '${name}'`;
	}
	for (const tool of toolbelt.tools) {
		if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
			return "durable Domain Agent tool declaration is invalid";
		}
		const toolRecord = tool as Record<string, unknown>;
		if (toolRecord.available !== true) continue;
		const capability = toolRecord.capability;
		if (typeof capability !== "string" || !capability.trim()) {
			return "durable available Domain Agent tool capability is invalid";
		}
		return `durable available Domain Agent tool requires capability '${capability}'`;
	}
	return null;
}

/**
 * Bind only the already-persisted Domain host context at first Session creation.
 * No runner closure, request payload, environment value, or live adapter enters
 * this transaction.  A non-Domain workflow remains eligible only for the G1
 * text-only scheduler path.
 */
async function deriveAgentSessionScheduleGrantBindingTx(
	tx: RuntimeTx,
	identity: {
		readonly runId: string;
		readonly agentId: string;
		readonly runtimeBindingDigest: string;
		readonly agentOntologyDigest: string;
		readonly ownerUserId: string;
		readonly graphOwnerPrincipal: string;
		readonly graphId: string;
	},
): Promise<AgentSessionScheduleGrantBindingV1 | null> {
	const workflow = await tx.execute({
		sql: "SELECT inputs_json FROM workflow_instances WHERE run_id = ?",
		args: [identity.runId],
	});
	if (!workflow.rows[0]) throw new Error(`Agent Session ${identity.runId} has no durable workflow inputs`);
	let inputs: unknown;
	try {
		inputs = JSON.parse(String(workflow.rows[0].inputs_json));
	} catch (cause) {
		throw new Error("Agent Session durable workflow inputs are invalid", { cause });
	}
	if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
		throw new Error("Agent Session durable workflow inputs are invalid");
	}
	const hostContext = (inputs as Record<string, unknown>).hostContext;
	if (hostContext === undefined || hostContext === null) return null;
	if (!hostContext || typeof hostContext !== "object" || Array.isArray(hostContext)) return null;
	const host = hostContext as Record<string, unknown>;
	if (host.schema !== "sophia.domain-agent-host-context.v1") return null;
	// A Domain run can host non-pilot nodes; never lend its pilot grant to a
	// differently identified Session merely because they share workflow inputs.
	if (host.agentId !== identity.agentId) return null;
	const grant = host.grant;
	const toolbelt = host.toolbelt;
	const grantAuthorityGraphId =
		grant && typeof grant === "object" && !Array.isArray(grant)
			? (grant as Record<string, unknown>).authorityGraphId
			: undefined;
	const capturedAt =
		toolbelt && typeof toolbelt === "object" && !Array.isArray(toolbelt)
			? (toolbelt as Record<string, unknown>).resolvedAt
			: undefined;
	if (
		typeof host.grantDocumentId !== "string" ||
		typeof host.grantAuthorityOwnerPrincipal !== "string" ||
		typeof grantAuthorityGraphId !== "string" ||
		typeof capturedAt !== "number"
	) {
		throw new Error("Domain host context cannot produce a durable schedule grant binding");
	}
	const candidate = bindAgentSessionScheduleGrantSnapshot({
		schema: "choreograph.agent-session-schedule-grant-snapshot.v1",
		agentId: identity.agentId,
		runtimeBindingDigest: identity.runtimeBindingDigest,
		agentOntologyDigest: identity.agentOntologyDigest,
		ownerUserId: identity.ownerUserId,
		graphOwnerPrincipal: identity.graphOwnerPrincipal,
		graphId: identity.graphId,
		grantAuthorityGraphId,
		grantAuthorityOwnerPrincipal: host.grantAuthorityOwnerPrincipal,
		grantDocumentId: host.grantDocumentId,
		grant: grant as AgentSessionScheduleGrantSnapshotV1["grant"],
		toolbelt: toolbelt as AgentSessionScheduleGrantSnapshotV1["toolbelt"],
		capturedAt,
	});
	const binding = parseAgentSessionScheduleGrantBinding(candidate);
	verifyAgentSessionScheduleGrantBinding(binding, { ...identity, now: capturedAt });
	return binding;
}

async function verifyAgentSessionScheduleGrantBindingTx(
	tx: RuntimeTx,
	session: AgentSessionRecord,
	digest: string,
	now: number,
): Promise<AgentSessionScheduleGrantSnapshotV1> {
	const row = await tx.execute({
		sql: `SELECT session_id, digest, binding_json, captured_at
		      FROM agent_session_schedule_grant_bindings
		     WHERE session_id = ? AND digest = ?`,
		args: [session.session_id, digest],
	});
	if (!row.rows[0]) throw new Error("Session-bound schedule grant snapshot is missing");
	const binding = rowToAgentSessionScheduleGrantBinding(row.rows[0]);
	const semantic = readAgentSessionSemanticBinding(session);
	return verifyAgentSessionScheduleGrantBinding(binding.binding, {
		agentId: session.agent_id ?? "",
		runtimeBindingDigest: digestAgentRuntimeBinding(semantic.runtime),
		agentOntologyDigest: digestAgentOntologyBinding(semantic.ontology),
		ownerUserId: session.owner_user_id,
		graphOwnerPrincipal: session.graph_owner_principal,
		graphId: session.graph_id,
		now,
	});
}

async function soleAgentSessionScheduleGrantBindingDigestTx(tx: RuntimeTx, sessionId: string): Promise<string | null> {
	const result = await tx.execute({
		sql: `SELECT digest FROM agent_session_schedule_grant_bindings
		      WHERE session_id = ? ORDER BY captured_at, digest LIMIT 2`,
		args: [sessionId],
	});
	if (result.rows.length !== 1) return null;
	return String(result.rows[0]!.digest);
}

async function autoCancelTerminalAgentSessionSchedulesTx(
	tx: RuntimeTx,
	now: number,
	sessionId?: string,
): Promise<void> {
	const terminal = await tx.execute({
		sql: `SELECT schedule.session_id, schedule.schedule_id, session.lifecycle_state
		        FROM agent_session_schedules AS schedule
		        JOIN agent_sessions AS session ON session.session_id = schedule.session_id
		       WHERE schedule.state IN ('active', 'paused') AND session.lifecycle_state IN ('closed', 'faulted')
		         ${sessionId === undefined ? "" : "AND schedule.session_id = ?"}
		       ORDER BY schedule.session_id, schedule.schedule_id`,
		args: sessionId === undefined ? [] : [sessionId],
	});
	if (terminal.rows.length > 0) await fenceAgentSessionScheduleClockTx(tx, now);
	for (const row of terminal.rows) {
		const scheduleSessionId = String(row.session_id);
		const scheduleId = String(row.schedule_id);
		const lifecycleState = String(row.lifecycle_state);
		const reason: AgentSessionScheduleCancellationReason =
			lifecycleState === "closed" ? "session_closed" : "session_faulted";
		await cancelActiveAgentSessionScheduleByHostTx(tx, scheduleSessionId, scheduleId, reason, now);
	}
}

async function cancelActiveAgentSessionScheduleByHostTx(
	tx: RuntimeTx,
	sessionId: string,
	scheduleId: string,
	reason: Exclude<AgentSessionScheduleCancellationReason, "requested">,
	now: number,
): Promise<void> {
	const requestId =
		reason === "authority_revoked"
			? stableAgentSessionScheduleAuthorityCancellationRequestId(sessionId, scheduleId)
			: stableAgentSessionScheduleTerminalCancellationRequestId(sessionId, scheduleId, reason);
	const clientId = "choreograph.scheduler";
	const requestDigest = digestJson({
		schema: "choreograph.agent-session-schedule-cancel.v1",
		sessionId,
		scheduleId,
		clientId,
		reason,
	});
	const replay = await tx.execute({
		sql: `SELECT * FROM agent_session_schedule_cancellations
		      WHERE session_id = ? AND request_id = ?`,
		args: [sessionId, requestId],
	});
	if (replay.rows[0]) {
		const cancellation = rowToAgentSessionScheduleCancellation(replay.rows[0]);
		if (cancellation.schedule_id !== scheduleId || cancellation.request_digest !== requestDigest) {
			throw new AgentSessionScheduleFault("request_conflict", "Automatic schedule cancellation changed on replay");
		}
		return;
	}
	const cancelled = await tx.execute({
		sql: `UPDATE agent_session_schedules
		         SET state = 'cancelled', next_fire_at = NULL, cancel_reason = ?,
		             cancelled_at = ?, updated_at = ?
		       WHERE session_id = ? AND schedule_id = ? AND state IN ('active', 'paused')
		       RETURNING schedule_id`,
		args: [reason, now, now, sessionId, scheduleId],
	});
	if (!cancelled.rows[0]) return;
	await tx.execute({
		sql: `INSERT INTO agent_session_schedule_cancellations
		        (cancellation_id, session_id, schedule_id, request_id, request_digest,
		         client_id, reason, disposition, created_at)
		      VALUES (?, ?, ?, ?, ?, ?, ?, 'cancelled', ?)`,
		args: [
			stableAgentSessionScheduleCancellationId(sessionId, scheduleId, requestId),
			sessionId,
			scheduleId,
			requestId,
			requestDigest,
			clientId,
			reason,
			now,
		],
	});
	await appendAgentSessionEventTx(tx, sessionId, {
		type: "schedule.cancelled",
		ts: now,
		causationId: requestId,
		payload: {
			schema: "choreograph.agent-session-schedule-cancelled.v1",
			scheduleId,
			requestId,
			reason,
		},
	});
}

async function ensureAgentSessionScheduleMaterializationTx(
	tx: RuntimeTx,
	session: AgentSessionRecord,
	candidateActivationId: string,
	now: number,
): Promise<AgentMaterializationRecord | null> {
	const latestResult = await tx.execute({
		sql: "SELECT * FROM agent_materializations WHERE session_id = ? ORDER BY generation DESC LIMIT 1",
		args: [session.session_id],
	});
	const latest = latestResult.rows[0] ? rowToAgentMaterialization(latestResult.rows[0]) : null;
	if (latest?.state === "quiescing" || latest?.state === "quiescent") return null;
	if (latest && (latest.state === "claimed" || latest.state === "running")) {
		try {
			await assertLiveLatestMaterializationActivationTx(
				tx,
				session.session_id,
				latest.generation,
				latest.activation_id,
			);
		} catch (cause) {
			throw new AgentSessionScheduleFault(
				"materialization_conflict",
				"The latest live schedule target is fenced for recovery",
				cause,
			);
		}
		return latest;
	}
	const generation = latest ? latest.generation + 1 : 0;
	try {
		const claimed = await claimAgentMaterializationTx(tx, session.session_id, {
			generation,
			activationId: candidateActivationId,
			now,
		});
		await tx.execute({
			sql: `INSERT INTO agent_session_kernel_launches
			        (session_id, generation, activation_id, sandbox_id, state, attempt,
			         created_at, updated_at, body_observed_at, terminal_at)
			      VALUES (?, ?, ?, NULL, 'not_requested', 0, ?, ?, NULL, NULL)
			      ON CONFLICT(session_id, generation) DO NOTHING`,
			args: [session.session_id, generation, claimed.activation_id, now, now],
		});
		return claimed;
	} catch (cause) {
		throw new AgentSessionScheduleFault(
			"materialization_conflict",
			`Schedule could not reserve materialization generation ${String(generation)}`,
			cause,
		);
	}
}

async function cancelQueuedAgentSessionCommandTx(
	tx: RuntimeTx,
	session: AgentSessionRecord,
	commandId: string,
	code: string,
	now: number,
	actor: string,
): Promise<void> {
	const found = await tx.execute({
		sql: "SELECT * FROM agent_session_commands WHERE command_id = ? AND session_id = ?",
		args: [commandId, session.session_id],
	});
	if (!found.rows[0])
		throw new AgentSessionScheduleFault("schedule_not_found", "Schedule authority command is missing");
	const command = rowToAgentSessionCommand(found.rows[0]);
	if (command.state !== "queued")
		throw new AgentSessionScheduleFault("lease_lost", "Schedule authority command is no longer queued");
	await tx.execute({
		sql: "UPDATE agent_session_commands SET state = 'cancelled', error = ?, completed_at = ? WHERE command_id = ? AND state = 'queued'",
		args: [code, now, commandId],
	});
	const document = agentSessionDocumentFromJson(session.document_json);
	const control = normalizeAgentSessionControl(document);
	const summary = asRecord(control.commandSummary);
	control.commandSummary = {
		...summary,
		cancelled: Number(summary.cancelled ?? 0) + 1,
		lastCommandId: commandId,
		lastCommandName: command.name,
		lastCommandState: "cancelled",
	};
	document.control = control;
	const op = await appendAgentSessionDocumentOpTx(tx, session.session_id, {
		ts: now,
		actor,
		kind: "command.cancelled",
		patch: { op: "command.cancel", commandId, name: command.name },
		document,
	});
	await tx.execute({
		sql: "UPDATE agent_sessions SET document_json = ?, updated_at = ? WHERE session_id = ?",
		args: [JSON.stringify(op.document), now, session.session_id],
	});
	await appendAgentSessionEventTx(tx, session.session_id, {
		type: "command.cancelled",
		ts: now,
		payload: { commandId, name: command.name, documentRevision: op.rev },
	});
}

/**
 * Session cancellation owns any still-live command wake before the cascade can
 * close the resident Session.  An unbound generation is an OS launch intent,
 * not body testimony, so remove it exactly.  Once a body is bound, leave its
 * materialization untouched: the activation observes the cancelled command,
 * reaps the body, and ordinary stale recovery records the cancellation.
 */
async function cancelLiveAgentSessionCommandActivationForSessionTx(
	tx: RuntimeTx,
	session: AgentSessionRecord,
	reason: string,
	now: number,
): Promise<void> {
	const active = await tx.execute({
		sql: `SELECT * FROM agent_session_command_activation_work
		       WHERE session_id = ? AND state IN ('pending', 'claimed')
		       ORDER BY not_before ASC, command_id ASC LIMIT 1`,
		args: [session.session_id],
	});
	if (!active.rows[0]) return;
	const work = rowToAgentSessionCommandActivation(active.rows[0]);
	const command = await readAgentSessionCommandTx(tx, work.command_id);
	if (!command) {
		throw new AgentSessionCommandActivationFault("not_found", "Session cancellation lost its command activation");
	}
	const materialization = await readAgentMaterializationTx(tx, work.session_id, work.target_generation);
	if (
		materialization?.activation_id === work.activation_id &&
		materialization.state === "claimed" &&
		materialization.sandbox_id === `claim:${work.activation_id}`
	) {
		await tx.execute({
			sql: `DELETE FROM agent_materialization_supervision
			       WHERE session_id = ? AND generation = ? AND activation_id = ? AND recovery_token IS NULL`,
			args: [work.session_id, work.target_generation, work.activation_id],
		});
		const removed = await tx.execute({
			sql: `DELETE FROM agent_materializations
			       WHERE session_id = ? AND generation = ? AND activation_id = ?
			         AND state = 'claimed' AND sandbox_id = 'claim:' || activation_id`,
			args: [work.session_id, work.target_generation, work.activation_id],
		});
		if (removed.rowsAffected !== 1) {
			throw new AgentSessionCommandActivationFault(
				"materialization_conflict",
				"Session cancellation lost its unbound command activation",
			);
		}
		await releaseAgentSessionChildGenerationOccupancyTx(tx, work.session_id, work.target_generation, now);
	}

	if (command.state === "completed") {
		await terminalizeAgentSessionCommandActivationWorkTx(tx, work.command_id, "completed", null, now);
		return;
	}
	if (command.state === "failed" || command.state === "cancelled" || command.state === "rejected") {
		await terminalizeAgentSessionCommandActivationWorkTx(tx, work.command_id, "failed", command.error, now);
		return;
	}
	if (command.state !== "queued" && command.state !== "delivered") {
		throw new AgentSessionCommandActivationFault(
			"materialization_conflict",
			`Session cancellation cannot settle command activation from ${command.state}`,
		);
	}
	const cancelled = await tx.execute({
		sql: `UPDATE agent_session_commands
		       SET state = 'cancelled', error = ?, completed_at = ?
		       WHERE command_id = ? AND session_id = ? AND state IN ('queued', 'delivered')`,
		args: [reason, now, command.command_id, session.session_id],
	});
	if (cancelled.rowsAffected !== 1) {
		throw new AgentSessionCommandActivationFault(
			"materialization_conflict",
			"Session cancellation lost its command first-wins fence",
		);
	}
	const document = agentSessionDocumentFromJson(session.document_json);
	const control = normalizeAgentSessionControl(document);
	const summary = asRecord(control.commandSummary);
	control.commandSummary = {
		...summary,
		cancelled: Number(summary.cancelled ?? 0) + 1,
		lastCommandId: command.command_id,
		lastCommandName: command.name,
		lastCommandState: "cancelled",
	};
	document.control = control;
	const op = await appendAgentSessionDocumentOpTx(tx, session.session_id, {
		ts: now,
		actor: "choreograph.session-cancellation",
		kind: "command.cancelled",
		patch: { op: "command.cancel", commandId: command.command_id, name: command.name },
		document,
	});
	await tx.execute({
		sql: "UPDATE agent_sessions SET document_json = ?, updated_at = ? WHERE session_id = ?",
		args: [JSON.stringify(op.document), now, session.session_id],
	});
	await appendAgentSessionEventTx(tx, session.session_id, {
		type: "command.cancelled",
		ts: now,
		payload: { commandId: command.command_id, name: command.name, documentRevision: op.rev },
	});
	await terminalizeAgentSessionCommandActivationWorkTx(tx, work.command_id, "failed", reason, now);
}

async function insertAgentSessionScheduleCommandTx(
	tx: RuntimeTx,
	session: AgentSessionRecord,
	input: {
		readonly commandId: string;
		readonly idempotencyKey: string;
		readonly name: "prompt" | "steer" | "follow_up";
		readonly input: AgentSessionSchedulePrompt;
		readonly clientId: string;
		readonly targetGeneration: number;
		readonly now: number;
	},
): Promise<AgentSessionCommandRecord> {
	const commandDigest = digestAgentSessionCommand(input.name, input.input);
	const collision = await tx.execute({
		sql: `SELECT * FROM agent_session_commands
		      WHERE command_id = ? OR (session_id = ? AND idempotency_key = ?)`,
		args: [input.commandId, session.session_id, input.idempotencyKey],
	});
	if (collision.rows[0]) {
		throw new AgentSessionScheduleFault("request_conflict", "Schedule fire command identity already exists");
	}
	await tx.execute({
		sql: `INSERT INTO agent_session_commands
		        (command_id, session_id, idempotency_key, command_digest, name, payload_json,
		         client_id, target_generation, state, submitted_at)
		      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
		args: [
			input.commandId,
			session.session_id,
			input.idempotencyKey,
			commandDigest,
			input.name,
			canonicalJson(input.input),
			input.clientId,
			input.targetGeneration,
			input.now,
		],
	});
	const document = agentSessionDocumentFromJson(session.document_json);
	const control = normalizeAgentSessionControl(document);
	const commandSummary = asRecord(control.commandSummary);
	control.commandSummary = {
		submitted: Number(commandSummary.submitted ?? 0) + 1,
		completed: Number(commandSummary.completed ?? 0),
		failed: Number(commandSummary.failed ?? 0),
		rejected: Number(commandSummary.rejected ?? 0),
		cancelled: Number(commandSummary.cancelled ?? 0),
		lastCommandId: input.commandId,
		lastCommandName: input.name,
		lastCommandState: "queued",
		targetGeneration: input.targetGeneration,
	};
	document.control = control;
	const documentOp = await appendAgentSessionDocumentOpTx(tx, session.session_id, {
		ts: input.now,
		actor: input.clientId,
		kind: "command.accepted",
		patch: {
			op: "command.enqueue",
			commandId: input.commandId,
			name: input.name,
			targetGeneration: input.targetGeneration,
		},
		document,
	});
	await tx.execute({
		sql: "UPDATE agent_sessions SET document_json = ?, updated_at = ? WHERE session_id = ?",
		args: [JSON.stringify(documentOp.document), input.now, session.session_id],
	});
	await appendAgentSessionEventTx(tx, session.session_id, {
		type: "command.accepted",
		ts: input.now,
		payload: {
			commandId: input.commandId,
			name: input.name,
			targetGeneration: input.targetGeneration,
			documentRevision: documentOp.rev,
		},
	});
	const inserted = await tx.execute({
		sql: "SELECT * FROM agent_session_commands WHERE command_id = ?",
		args: [input.commandId],
	});
	return rowToAgentSessionCommand(inserted.rows[0]!);
}

function coalesceAgentSessionSchedule(
	schedule: AgentSessionScheduleRecord,
	now: number,
): {
	readonly scheduledAt: number;
	readonly coalescedThroughAt: number;
	readonly coalescedCount: number;
	readonly nextFireAt: number | null;
} {
	const scheduledAt = schedule.next_fire_at;
	if (scheduledAt === null || scheduledAt > now) {
		throw new AgentSessionScheduleFault("request_conflict", "Schedule is not due for coalescing");
	}
	if (schedule.definition.kind === "once") {
		return { scheduledAt, coalescedThroughAt: scheduledAt, coalescedCount: 1, nextFireAt: null };
	}
	if (schedule.definition.kind === "interval") {
		const elapsed = now - scheduledAt;
		const coalescedCount = Math.floor(elapsed / schedule.definition.intervalMs) + 1;
		if (!Number.isSafeInteger(coalescedCount)) {
			throw new AgentSessionScheduleFault("request_invalid", "Interval coalescing count overflowed");
		}
		const coalescedThroughAt = scheduledAt + (coalescedCount - 1) * schedule.definition.intervalMs;
		const nextFireAt = checkedScheduleSum(coalescedThroughAt, schedule.definition.intervalMs);
		return { scheduledAt, coalescedThroughAt, coalescedCount, nextFireAt };
	}
	const parsed = parseAgentSessionCron(schedule.definition.expression);
	const coalesced = countAgentSessionCronOccurrences(parsed, scheduledAt, now);
	return {
		scheduledAt,
		coalescedThroughAt: coalesced.last,
		coalescedCount: coalesced.count,
		nextFireAt: nextAgentSessionCronAtOrAfter(parsed, checkedScheduleSum(now, 1)),
	};
}

function parseAgentSessionCron(expression: unknown): ParsedAgentSessionCron {
	const normalized = typeof expression === "string" ? expression.trim().replace(/\s+/g, " ") : "";
	const fields = normalized.split(" ");
	if (fields.length !== 5) {
		throw new AgentSessionScheduleFault("request_invalid", "Cron expression must contain exactly five fields");
	}
	return {
		expression: normalized,
		minutes: parseAgentSessionCronField(fields[0]!, 0, 59, "minute"),
		hours: parseAgentSessionCronField(fields[1]!, 0, 23, "hour"),
		daysOfMonth: new Set(parseAgentSessionCronField(fields[2]!, 1, 31, "day-of-month")),
		months: new Set(parseAgentSessionCronField(fields[3]!, 1, 12, "month")),
		daysOfWeek: new Set(
			parseAgentSessionCronField(fields[4]!, 0, 7, "day-of-week").map((value) => (value === 7 ? 0 : value)),
		),
	};
}

function parseAgentSessionCronField(field: string, min: number, max: number, label: string): number[] {
	const values = new Set<number>();
	for (const part of field.split(",")) {
		if (!part) throw new AgentSessionScheduleFault("request_invalid", `Cron ${label} contains an empty item`);
		const [base, rawStep, ...extra] = part.split("/");
		if (extra.length > 0 || !base) {
			throw new AgentSessionScheduleFault("request_invalid", `Cron ${label} has an invalid step`);
		}
		const step = rawStep === undefined ? 1 : Number(rawStep);
		if (!Number.isSafeInteger(step) || step < 1) {
			throw new AgentSessionScheduleFault("request_invalid", `Cron ${label} step must be positive`);
		}
		let start: number;
		let end: number;
		if (base === "*") {
			start = min;
			end = max;
		} else if (base.includes("-")) {
			const range = base.split("-");
			if (range.length !== 2) {
				throw new AgentSessionScheduleFault("request_invalid", `Cron ${label} range is invalid`);
			}
			start = Number(range[0]);
			end = Number(range[1]);
		} else {
			start = Number(base);
			end = rawStep === undefined ? start : max;
		}
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < min || end > max || start > end) {
			throw new AgentSessionScheduleFault("request_invalid", `Cron ${label} value is outside ${min}..${max}`);
		}
		for (let value = start; value <= end; value += step) values.add(value);
	}
	return [...values].sort((left, right) => left - right);
}

function nextAgentSessionCronAtOrAfter(parsed: ParsedAgentSessionCron, at: number): number {
	validateAgentSessionScheduleTimestamp(at, "cron search time");
	const start = Math.ceil(at / MINUTE_MS) * MINUTE_MS;
	if (!Number.isSafeInteger(start) || !Number.isFinite(new Date(start).getTime())) {
		throw new AgentSessionScheduleFault("request_invalid", "Cron search time is outside the UTC calendar range");
	}
	let day = Math.floor(start / DAY_MS) * DAY_MS;
	for (let offset = 0; offset <= GREGORIAN_CYCLE_DAYS; offset += 1, day += DAY_MS) {
		const date = new Date(day);
		if (!Number.isFinite(date.getTime())) break;
		if (!agentSessionCronMatchesDay(parsed, date)) continue;
		for (const hour of parsed.hours) {
			for (const minute of parsed.minutes) {
				const candidate = day + hour * 60 * MINUTE_MS + minute * MINUTE_MS;
				if (candidate >= start) return candidate;
			}
		}
	}
	throw new AgentSessionScheduleFault("request_invalid", "Cron expression has no Gregorian UTC occurrence");
}

function countAgentSessionCronOccurrences(
	parsed: ParsedAgentSessionCron,
	from: number,
	through: number,
): { readonly count: number; readonly last: number } {
	let count = 0;
	let last = -1;
	const firstDay = Math.floor(from / DAY_MS) * DAY_MS;
	const lastDay = Math.floor(through / DAY_MS) * DAY_MS;
	for (let day = firstDay; day <= lastDay; day += DAY_MS) {
		const date = new Date(day);
		if (!Number.isFinite(date.getTime()) || !agentSessionCronMatchesDay(parsed, date)) continue;
		for (const hour of parsed.hours) {
			for (const minute of parsed.minutes) {
				const candidate = day + hour * 60 * MINUTE_MS + minute * MINUTE_MS;
				if (candidate < from || candidate > through) continue;
				count += 1;
				if (!Number.isSafeInteger(count)) {
					throw new AgentSessionScheduleFault("request_invalid", "Cron coalescing count overflowed");
				}
				last = candidate;
			}
		}
	}
	if (count < 1 || last < from) {
		throw new AgentSessionScheduleFault("request_conflict", "Cron schedule due time is not an occurrence");
	}
	return { count, last };
}

function agentSessionCronMatchesDay(parsed: ParsedAgentSessionCron, date: Date): boolean {
	return (
		parsed.months.has(date.getUTCMonth() + 1) &&
		parsed.daysOfMonth.has(date.getUTCDate()) &&
		parsed.daysOfWeek.has(date.getUTCDay())
	);
}

function stableAgentSessionScheduleFireId(sessionId: string, scheduleId: string, ordinal: number): string {
	return `asf_${createHash("sha256")
		.update(canonicalJson({ kind: "agent_session_schedule_fire", sessionId, scheduleId, ordinal }))
		.digest("hex")}`;
}

function stableAgentSessionScheduleCommandId(fireId: string): string {
	return `asc_${createHash("sha256")
		.update(canonicalJson({ kind: "agent_session_schedule_command", fireId }))
		.digest("hex")}`;
}

function stableAgentSessionScheduleActivationId(fireId: string): string {
	return `act_schedule_${createHash("sha256")
		.update(canonicalJson({ kind: "agent_session_schedule_activation", fireId }))
		.digest("hex")
		.slice(0, 32)}`;
}

function stableAgentSessionScheduleTerminalCancellationRequestId(
	sessionId: string,
	scheduleId: string,
	reason: "session_closed" | "session_faulted",
): string {
	return `ascr_${createHash("sha256")
		.update(canonicalJson({ kind: "agent_session_schedule_terminal_cancellation", sessionId, scheduleId, reason }))
		.digest("hex")}`;
}

function stableAgentSessionScheduleAuthorityCancellationRequestId(sessionId: string, scheduleId: string): string {
	return `ascr_${createHash("sha256")
		.update(
			canonicalJson({
				kind: "agent_session_schedule_authority_cancellation",
				sessionId,
				scheduleId,
				reason: "authority_revoked",
			}),
		)
		.digest("hex")}`;
}

function stableAgentSessionScheduleCancellationId(sessionId: string, scheduleId: string, requestId: string): string {
	return `ascn_${createHash("sha256")
		.update(canonicalJson({ kind: "agent_session_schedule_cancellation", sessionId, scheduleId, requestId }))
		.digest("hex")}`;
}

function stableAgentSessionScheduleControlId(sessionId: string, requestId: string): string {
	return `asctrl_${createHash("sha256")
		.update(canonicalJson({ kind: "agent_session_schedule_control", sessionId, requestId }))
		.digest("hex")}`;
}

interface HostResolvedChildAuthority {
	readonly parentRuntime: AgentRuntimeBindingV2;
	readonly parentOntology: AgentOntologyBindingV1;
	readonly childRuntime: AgentRuntimeBindingV2;
	readonly childOntology: AgentOntologyBindingV1;
	readonly provider: string;
	readonly model: string;
	readonly systemPrompt: string;
	readonly includeTools: readonly string[];
}

const CHILD_BUDGET_KEYS = [
	"maxTurns",
	"maxWallTimeMs",
	"maxTokens",
	"maxCostUsdMicros",
	"maxArtifactBytes",
] as const satisfies ReadonlyArray<keyof AgentRuntimeConstraintsV2>;

const CHILD_ADMISSION_REQUEST_FIELDS = new Set([
	"requestId",
	"parentGeneration",
	"parentActivationId",
	"parentSandboxId",
	"prompt",
	"requestedName",
	"requestedModel",
	"causationId",
	"now",
]);
const CHILD_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const CHILD_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const CHILD_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CHILD_PROMPT_MAX_BYTES = 64 * 1024;

const AGENT_SESSION_BUDGET_DIMENSIONS = [
	"turns",
	"wallTimeMs",
	"tokens",
	"costUsdMicros",
	"artifactBytes",
] as const satisfies readonly AgentSessionBudgetDimension[];

const ZERO_AGENT_SESSION_BUDGET: AgentSessionBudgetVectorV1 = Object.freeze({
	turns: 0,
	wallTimeMs: 0,
	tokens: 0,
	costUsdMicros: 0,
	artifactBytes: 0,
});

function budgetVectorFromConstraints(constraints: AgentRuntimeConstraintsV2): AgentSessionBudgetVectorV1 {
	return validateAgentSessionBudgetVector(
		{
			turns: constraints.maxTurns,
			wallTimeMs: constraints.maxWallTimeMs,
			tokens: constraints.maxTokens,
			costUsdMicros: constraints.maxCostUsdMicros,
			artifactBytes: constraints.maxArtifactBytes,
		},
		"runtime budget",
	);
}

function budgetVectorFromChildSlice(slice: AgentSessionChildBudgetSliceV1): AgentSessionBudgetVectorV1 {
	return validateAgentSessionBudgetVector(
		{
			turns: slice.maxTurns,
			wallTimeMs: slice.maxWallTimeMs,
			tokens: slice.maxTokens,
			costUsdMicros: slice.maxCostUsdMicros,
			artifactBytes: slice.maxArtifactBytes,
		},
		"child budget slice",
	);
}

function validateAgentSessionBudgetVector(value: unknown, label: string): AgentSessionBudgetVectorV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new AgentSessionBudgetFault("request_invalid", `${label} must be an object`);
	}
	const record = value as Record<string, unknown>;
	const unknown = Object.keys(record).filter(
		(key) => !AGENT_SESSION_BUDGET_DIMENSIONS.includes(key as AgentSessionBudgetDimension),
	);
	if (unknown.length > 0) {
		throw new AgentSessionBudgetFault("request_invalid", `${label} has unsupported fields: ${unknown.join(", ")}`);
	}
	for (const dimension of AGENT_SESSION_BUDGET_DIMENSIONS) {
		validateBudgetInteger(record[dimension], `${label}.${dimension}`);
	}
	return {
		turns: record.turns as number,
		wallTimeMs: record.wallTimeMs as number,
		tokens: record.tokens as number,
		costUsdMicros: record.costUsdMicros as number,
		artifactBytes: record.artifactBytes as number,
	};
}

function validateBudgetInteger(value: unknown, label: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new AgentSessionBudgetFault("request_invalid", `${label} must be a non-negative safe integer`);
	}
}

function validatePositiveBudgetInteger(value: unknown, label: string): asserts value is number {
	validateBudgetInteger(value, label);
	if ((value as number) < 1) {
		throw new AgentSessionBudgetFault("request_invalid", `${label} must be positive`);
	}
}

function checkedBudgetSum(left: number, right: number): number {
	const value = left + right;
	if (!Number.isSafeInteger(value)) {
		throw new AgentSessionBudgetFault("arithmetic_overflow", "budget arithmetic exceeded safe integer range");
	}
	return value;
}

function checkedBudgetDifference(left: number, right: number): number {
	const value = left - right;
	if (!Number.isSafeInteger(value)) {
		throw new AgentSessionBudgetFault("arithmetic_overflow", "budget arithmetic exceeded safe integer range");
	}
	return value;
}

function budgetVectorsEqual(left: AgentSessionBudgetVectorV1, right: AgentSessionBudgetVectorV1): boolean {
	return AGENT_SESSION_BUDGET_DIMENSIONS.every((dimension) => left[dimension] === right[dimension]);
}

function negateAgentSessionBudget(value: AgentSessionBudgetVectorV1): AgentSessionBudgetVectorV1 {
	return {
		turns: -value.turns,
		wallTimeMs: -value.wallTimeMs,
		tokens: -value.tokens,
		costUsdMicros: -value.costUsdMicros,
		artifactBytes: -value.artifactBytes,
	};
}

function availableAgentSessionBudget(account: AgentSessionBudgetAccountRecord): AgentSessionBudgetVectorV1 {
	return Object.fromEntries(
		AGENT_SESSION_BUDGET_DIMENSIONS.map((dimension) => [
			dimension,
			Math.max(
				0,
				checkedBudgetDifference(
					account.limit[dimension],
					checkedBudgetSum(account.reserved[dimension], account.spent[dimension]),
				),
			),
		]),
	) as unknown as AgentSessionBudgetVectorV1;
}

function exhaustedAgentSessionBudgetDimensions(
	account: AgentSessionBudgetAccountRecord,
): AgentSessionBudgetDimension[] {
	return AGENT_SESSION_BUDGET_DIMENSIONS.filter(
		(dimension) => checkedBudgetSum(account.reserved[dimension], account.spent[dimension]) > account.limit[dimension],
	);
}

function budgetDimensionsExceedingAvailable(
	account: AgentSessionBudgetAccountRecord,
	requested: AgentSessionBudgetVectorV1,
): AgentSessionBudgetDimension[] {
	const available = availableAgentSessionBudget(account);
	return AGENT_SESSION_BUDGET_DIMENSIONS.filter((dimension) => requested[dimension] > available[dimension]);
}

async function openAgentSessionBudgetAccountTx(
	tx: RuntimeTx,
	sessionId: string,
	limit: AgentSessionBudgetVectorV1,
	now: number,
): Promise<AgentSessionBudgetAccountRecord> {
	validateBudgetInteger(now, "budget account creation time");
	const existing = await tx.execute({
		sql: "SELECT * FROM agent_session_budget_accounts WHERE session_id = ?",
		args: [sessionId],
	});
	if (existing.rows[0]) {
		return requireAgentSessionBudgetAccountTx(tx, sessionId, limit);
	}
	await tx.execute({
		sql: `INSERT INTO agent_session_budget_accounts
		        (session_id, limit_turns, limit_wall_time_ms, limit_tokens,
		         limit_cost_usd_micros, limit_artifact_bytes, created_at, updated_at)
		      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		args: [
			sessionId,
			limit.turns,
			limit.wallTimeMs,
			limit.tokens,
			limit.costUsdMicros,
			limit.artifactBytes,
			now,
			now,
		],
	});
	const entryId = agentSessionBudgetEntryId(sessionId, "account_opened", sessionId);
	await tx.execute({
		sql: `INSERT INTO agent_session_budget_entries
		        (entry_id, session_id, ordinal, kind, reference_id,
		         reserved_turns_delta, reserved_wall_time_ms_delta, reserved_tokens_delta,
		         reserved_cost_usd_micros_delta, reserved_artifact_bytes_delta,
		         spent_turns_delta, spent_wall_time_ms_delta, spent_tokens_delta,
		         spent_cost_usd_micros_delta, spent_artifact_bytes_delta, detail_json, created_at)
		      VALUES (?, ?, 0, 'account_opened', ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?)`,
		args: [
			entryId,
			sessionId,
			sessionId,
			canonicalJson({ schema: "choreograph.agent-session-budget-opened.v1", limit }),
			now,
		],
	});
	await appendAgentSessionEventTx(tx, sessionId, {
		type: "budget.ledger_updated",
		ts: now,
		payload: {
			schema: "choreograph.agent-session-budget-ledger-updated.v1",
			entryId,
			kind: "account_opened",
			referenceId: sessionId,
			accountRevision: 0,
			reservedDelta: ZERO_AGENT_SESSION_BUDGET,
			spentDelta: ZERO_AGENT_SESSION_BUDGET,
		},
	});
	return requireAgentSessionBudgetAccountTx(tx, sessionId, limit);
}

async function requireAgentSessionBudgetAccountTx(
	tx: RuntimeTx,
	sessionId: string,
	expectedLimit?: AgentSessionBudgetVectorV1,
): Promise<AgentSessionBudgetAccountRecord> {
	const result = await tx.execute({
		sql: "SELECT * FROM agent_session_budget_accounts WHERE session_id = ?",
		args: [sessionId],
	});
	if (!result.rows[0]) {
		throw new AgentSessionBudgetFault("account_not_found", `Agent Session budget account not found: ${sessionId}`);
	}
	const account = rowToAgentSessionBudgetAccount(result.rows[0]);
	if (expectedLimit && !budgetVectorsEqual(account.limit, expectedLimit)) {
		throw new AgentSessionBudgetFault(
			"request_conflict",
			`Agent Session budget account ${sessionId} diverges from its pinned runtime binding`,
			{ expected: expectedLimit, actual: account.limit },
		);
	}
	return account;
}

async function applyAgentSessionBudgetLedgerEntryTx(
	tx: RuntimeTx,
	input: {
		readonly sessionId: string;
		readonly kind: AgentSessionBudgetLedgerEntryKind;
		readonly referenceId: string;
		readonly reservedDelta: AgentSessionBudgetVectorV1;
		readonly spentDelta: AgentSessionBudgetVectorV1;
		readonly detail: unknown;
		readonly now: number;
		readonly allowExhaustion?: boolean;
	},
): Promise<AgentSessionBudgetLedgerEntryRecord> {
	const account = await requireAgentSessionBudgetAccountTx(tx, input.sessionId);
	validateBudgetInteger(input.now, "budget ledger entry time");
	const reserved = {} as Record<AgentSessionBudgetDimension, number>;
	const spent = {} as Record<AgentSessionBudgetDimension, number>;
	for (const dimension of AGENT_SESSION_BUDGET_DIMENSIONS) {
		const reservedValue = checkedBudgetSum(account.reserved[dimension], input.reservedDelta[dimension]);
		const spentValue = checkedBudgetSum(account.spent[dimension], input.spentDelta[dimension]);
		if (reservedValue < 0 || spentValue < 0) {
			throw new AgentSessionBudgetFault("request_conflict", `budget ledger entry would make ${dimension} negative`);
		}
		if (!input.allowExhaustion && checkedBudgetSum(reservedValue, spentValue) > account.limit[dimension]) {
			throw new AgentSessionBudgetFault("budget_exhausted", `budget ledger entry exceeds ${dimension} capacity`);
		}
		reserved[dimension] = reservedValue;
		spent[dimension] = spentValue;
	}
	const exhausted =
		account.exhausted ||
		AGENT_SESSION_BUDGET_DIMENSIONS.some(
			(dimension) => checkedBudgetSum(reserved[dimension], spent[dimension]) > account.limit[dimension],
		);
	const revision = checkedBudgetSum(account.revision, 1);
	await tx.execute({
		sql: `UPDATE agent_session_budget_accounts SET
		        reserved_turns = ?, reserved_wall_time_ms = ?, reserved_tokens = ?,
		        reserved_cost_usd_micros = ?, reserved_artifact_bytes = ?,
		        spent_turns = ?, spent_wall_time_ms = ?, spent_tokens = ?,
		        spent_cost_usd_micros = ?, spent_artifact_bytes = ?,
		        exhausted = ?, revision = ?, updated_at = ?
		      WHERE session_id = ? AND revision = ?`,
		args: [
			reserved.turns,
			reserved.wallTimeMs,
			reserved.tokens,
			reserved.costUsdMicros,
			reserved.artifactBytes,
			spent.turns,
			spent.wallTimeMs,
			spent.tokens,
			spent.costUsdMicros,
			spent.artifactBytes,
			exhausted ? 1 : 0,
			revision,
			input.now,
			input.sessionId,
			account.revision,
		],
	});
	const entryId = agentSessionBudgetEntryId(input.sessionId, input.kind, input.referenceId);
	await tx.execute({
		sql: `INSERT INTO agent_session_budget_entries
		        (entry_id, session_id, ordinal, kind, reference_id,
		         reserved_turns_delta, reserved_wall_time_ms_delta, reserved_tokens_delta,
		         reserved_cost_usd_micros_delta, reserved_artifact_bytes_delta,
		         spent_turns_delta, spent_wall_time_ms_delta, spent_tokens_delta,
		         spent_cost_usd_micros_delta, spent_artifact_bytes_delta, detail_json, created_at)
		      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		args: [
			entryId,
			input.sessionId,
			revision,
			input.kind,
			input.referenceId,
			input.reservedDelta.turns,
			input.reservedDelta.wallTimeMs,
			input.reservedDelta.tokens,
			input.reservedDelta.costUsdMicros,
			input.reservedDelta.artifactBytes,
			input.spentDelta.turns,
			input.spentDelta.wallTimeMs,
			input.spentDelta.tokens,
			input.spentDelta.costUsdMicros,
			input.spentDelta.artifactBytes,
			canonicalJson(input.detail),
			input.now,
		],
	});
	await appendAgentSessionEventTx(tx, input.sessionId, {
		type: "budget.ledger_updated",
		ts: input.now,
		payload: {
			schema: "choreograph.agent-session-budget-ledger-updated.v1",
			entryId,
			kind: input.kind,
			referenceId: input.referenceId,
			accountRevision: revision,
			reservedDelta: input.reservedDelta,
			spentDelta: input.spentDelta,
		},
	});
	return {
		entry_id: entryId,
		session_id: input.sessionId,
		ordinal: revision,
		kind: input.kind,
		reference_id: input.referenceId,
		reserved_delta: input.reservedDelta,
		spent_delta: input.spentDelta,
		detail: input.detail,
		created_at: input.now,
	};
}

function agentSessionBudgetEntryId(
	sessionId: string,
	kind: AgentSessionBudgetLedgerEntryKind,
	referenceId: string,
): string {
	return `ble_${createHash("sha256").update(canonicalJson({ sessionId, kind, referenceId })).digest("hex")}`;
}

async function requireAgentSessionBudgetEntryTx(
	tx: RuntimeTx,
	sessionId: string,
	kind: AgentSessionBudgetLedgerEntryKind,
	referenceId: string,
): Promise<AgentSessionBudgetLedgerEntryRecord> {
	const result = await tx.execute({
		sql: `SELECT * FROM agent_session_budget_entries
		      WHERE session_id = ? AND kind = ? AND reference_id = ?`,
		args: [sessionId, kind, referenceId],
	});
	if (!result.rows[0]) throw new Error(`budget ledger entry is missing: ${sessionId}/${kind}/${referenceId}`);
	return rowToAgentSessionBudgetLedgerEntry(result.rows[0]);
}

function validateInferenceReservationInput(
	input: ReserveAgentSessionInferenceBudgetInput,
): ReserveAgentSessionInferenceBudgetInput {
	if (!input || typeof input !== "object") {
		throw new AgentSessionBudgetFault("request_invalid", "inference reservation input must be an object");
	}
	validateBudgetInteger(input.generation, "inference generation");
	validateBudgetInteger(input.now, "inference reservation time");
	validateBudgetInteger(input.estimatedInputTokens, "estimatedInputTokens");
	validatePositiveBudgetInteger(input.requestedOutputTokens, "requestedOutputTokens");
	const activationId = requiredBoundedText(input.activationId, "activationId", 256);
	const sandboxId = requiredBoundedText(input.sandboxId, "sandboxId", 256);
	const requestId = requiredBoundedText(input.requestId, "requestId", 256);
	const requestDigest = requiredBoundedText(input.requestDigest, "requestDigest", 256);
	const causationId = requiredBoundedText(input.causationId, "causationId", 256);
	const provider = requiredBoundedText(input.provider, "provider", 128);
	const model = requiredBoundedText(input.model, "model", 256);
	if (
		input.pricingVersion !== staticPricingVersion() &&
		!RATE_CARD_VERSION_PATTERN.test(String(input.pricingVersion))
	) {
		throw new AgentSessionBudgetFault(
			"request_invalid",
			`pricingVersion must be the static table ${staticPricingVersion()} or a catalogue rate-card version (cat:<12 hex>@<time>)`,
		);
	}
	if (input.fundingSource !== undefined && input.fundingSource !== "platform" && input.fundingSource !== "user")
		throw new AgentSessionBudgetFault("request_invalid", "Invalid inference funding source");
	if (input.fundingSource === "user" && provider !== "openrouter")
		throw new AgentSessionBudgetFault("request_invalid", "User funding requires OpenRouter");
	return {
		fundingSource: input.fundingSource,
		generation: input.generation,
		activationId,
		sandboxId,
		requestId,
		requestDigest,
		causationId,
		provider,
		model,
		estimatedInputTokens: input.estimatedInputTokens,
		requestedOutputTokens: input.requestedOutputTokens,
		pricingVersion: input.pricingVersion,
		now: input.now,
	};
}

function validateInferenceFenceInput(input: AgentSessionInferenceFenceInput): AgentSessionInferenceFenceInput {
	if (!input || typeof input !== "object") {
		throw new AgentSessionBudgetFault("request_invalid", "inference fence must be an object");
	}
	validateBudgetInteger(input.generation, "inference generation");
	validateBudgetInteger(input.now, "inference mutation time");
	return {
		generation: input.generation,
		activationId: requiredBoundedText(input.activationId, "activationId", 256),
		sandboxId: requiredBoundedText(input.sandboxId, "sandboxId", 256),
		requestId: requiredBoundedText(input.requestId, "requestId", 256),
		requestDigest: requiredBoundedText(input.requestDigest, "requestDigest", 256),
		now: input.now,
	};
}

function requiredBoundedText(value: unknown, label: string, maxBytes: number): string {
	if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maxBytes) {
		throw new AgentSessionBudgetFault("request_invalid", `${label} must be non-empty and at most ${maxBytes} bytes`);
	}
	return value;
}

function digestInferenceReservationInput(input: ReserveAgentSessionInferenceBudgetInput): string {
	return digestJson({
		...(input.fundingSource === "user" ? { fundingSource: "user" } : {}),
		generation: input.generation,
		activationId: input.activationId,
		sandboxId: input.sandboxId,
		requestId: input.requestId,
		requestDigest: input.requestDigest,
		causationId: input.causationId,
		provider: input.provider,
		model: input.model,
		pricingVersion: input.pricingVersion,
		estimatedInputTokens: input.estimatedInputTokens,
		requestedOutputTokens: input.requestedOutputTokens,
	});
}

function digestJson(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function agentSessionInferenceOperationId(sessionId: string, generation: number, requestId: string): string {
	return `asi_${createHash("sha256")
		.update(canonicalJson({ kind: "agent_session_inference", sessionId, generation, requestId }))
		.digest("hex")}`;
}

/**
 * The rate card pinned in a Session document's `source`, or undefined for a legacy Session. A pin that is not a
 * card is a fault, never a reason to price around it.
 */
function pinnedRateCardTx(source: Record<string, unknown>): RateCardV1 | undefined {
	try {
		return rateCardFromSessionSource(source);
	} catch (cause) {
		throw new AgentSessionBudgetFault(
			"request_invalid",
			"the Agent Session's pricing pin is not a valid rate card",
			cause,
		);
	}
}

/** What a call on this Session must be priced by: the pin, and the version that pin is stamped with. */
function requireRateCardBindingTx(
	source: Record<string, unknown>,
	binding: { readonly provider: string; readonly model: string },
): { readonly rateCard: RateCardV1 | undefined; readonly pricingVersion: string } {
	const rateCard = pinnedRateCardTx(source);
	if (rateCard && (rateCard.model !== binding.model || rateCard.provider !== binding.provider.trim().toLowerCase())) {
		throw new AgentSessionBudgetFault(
			"request_conflict",
			"inference provider/model diverges from the rate card pinned on the Agent Session",
		);
	}
	return { rateCard, pricingVersion: rateCard?.version ?? staticPricingVersion() };
}

async function requireExactRunningMaterializationTx(
	tx: RuntimeTx,
	sessionId: string,
	input: Pick<
		ReserveAgentSessionInferenceBudgetInput,
		"generation" | "activationId" | "sandboxId" | "provider" | "model" | "pricingVersion"
	>,
): Promise<{ readonly materialization: AgentMaterializationRecord; readonly rateCard: RateCardV1 | undefined }> {
	const session = await readAgentSessionTx(tx, sessionId);
	if (!session) throw new AgentSessionBudgetFault("materialization_stale", "inference Session does not exist");
	const source = asRecord(agentSessionDocumentFromJson(session.document_json).source);
	if (source.provider !== input.provider || source.model !== input.model || session.model !== input.model) {
		throw new AgentSessionBudgetFault(
			"request_conflict",
			"inference provider/model diverges from the pinned Agent Session binding",
		);
	}
	// The Session's price is a pinned fact: a call is reserved at the version the pin carries (a catalogue card's,
	// or the static table's for a legacy Session), or not at all. A reservation priced any other way would be
	// refused as a conflict when it settled and its usage would never reach the ledger.
	const binding = requireRateCardBindingTx(source, input);
	if (input.pricingVersion !== binding.pricingVersion) {
		throw new AgentSessionBudgetFault(
			"request_conflict",
			`inference pricingVersion ${input.pricingVersion} is not the version the Agent Session is pinned to (${binding.pricingVersion})`,
		);
	}
	const result = await tx.execute({
		sql: "SELECT * FROM agent_materializations WHERE session_id = ? ORDER BY generation DESC LIMIT 1",
		args: [sessionId],
	});
	const materialization = result.rows[0] ? rowToAgentMaterialization(result.rows[0]) : null;
	if (
		!materialization ||
		materialization.generation !== input.generation ||
		materialization.activation_id !== input.activationId ||
		materialization.sandbox_id !== input.sandboxId ||
		materialization.state !== "running"
	) {
		throw new AgentSessionBudgetFault(
			"materialization_stale",
			"inference reservation does not belong to the exact running materialization",
		);
	}
	return { materialization, rateCard: binding.rateCard };
}

function maximalAffordableOutputTokens(input: {
	readonly provider: string;
	readonly model: string;
	readonly estimatedInputTokens: number;
	readonly requestedOutputTokens: number;
	readonly available: AgentSessionBudgetVectorV1;
	readonly rateCard?: RateCardV1;
}): number {
	const tokenCeiling = Math.min(
		input.requestedOutputTokens,
		Math.max(0, checkedBudgetDifference(input.available.tokens, input.estimatedInputTokens)),
	);
	if (tokenCeiling < 1 || input.available.turns < 1) return 0;
	let low = 0;
	let high = tokenCeiling;
	while (low < high) {
		const candidate = Math.ceil((low + high) / 2);
		const cost = projectedInferenceBudgetCost(
			input.model,
			input.provider,
			input.estimatedInputTokens,
			candidate,
			input.rateCard,
		);
		if (cost <= input.available.costUsdMicros) low = candidate;
		else high = candidate - 1;
	}
	return low;
}

function projectedInferenceBudgetCost(
	model: string,
	provider: string,
	estimatedInputTokens: number,
	outputTokens: number,
	rateCard?: RateCardV1,
): number {
	if (model.startsWith("mock:")) return 0;
	const priced = (prompt: { input: number; cacheRead: number; cacheWrite: number }): number =>
		priceInferenceCall({
			card: rateCard,
			model,
			provider,
			tokens: { ...prompt, output: outputTokens },
		}).totalCostMicroUsd;
	const asInput = priced({ input: estimatedInputTokens, cacheRead: 0, cacheWrite: 0 });
	// A bound, not a guess: the prompt is read as input tokens, and, when a provider finds nothing cached, as cache
	// writes, which some models charge more for than input (Anthropic's are a quarter dearer). A Session priced from
	// the catalogue holds the dearest reading. A legacy Session keeps the reading it always had, byte for byte.
	const cost = rateCard
		? Math.max(
				asInput,
				priced({ input: 0, cacheRead: 0, cacheWrite: estimatedInputTokens }),
				priced({ input: 0, cacheRead: estimatedInputTokens, cacheWrite: 0 }),
			)
		: asInput;
	validateBudgetInteger(cost, "projected inference cost");
	return cost;
}

async function requireAgentSessionInferenceReservationTx(
	tx: RuntimeTx,
	operationId: string,
): Promise<AgentSessionInferenceReservationRecord> {
	const result = await tx.execute({
		sql: "SELECT * FROM agent_session_inference_reservations WHERE operation_id = ?",
		args: [operationId],
	});
	if (!result.rows[0]) {
		throw new AgentSessionBudgetFault("reservation_not_found", `inference reservation not found: ${operationId}`);
	}
	return rowToAgentSessionInferenceReservation(result.rows[0]);
}

function assertInferenceReservationFence(
	reservation: AgentSessionInferenceReservationRecord,
	input: AgentSessionInferenceFenceInput,
): void {
	if (
		reservation.generation !== input.generation ||
		reservation.activation_id !== input.activationId ||
		reservation.sandbox_id !== input.sandboxId ||
		reservation.request_id !== input.requestId ||
		reservation.request_digest !== input.requestDigest
	) {
		throw new AgentSessionBudgetFault(
			"request_conflict",
			`inference operation ${reservation.operation_id} fence diverged from its reservation`,
		);
	}
}

const AGENT_SESSION_INFERENCE_BILLING_FIELDS = new Set([
	"fundingSource",
	"eventId",
	"ts",
	"userId",
	"graphId",
	"sandboxId",
	"template",
	"sessionId",
	"generation",
	"inferenceOperationId",
	"requestId",
	"childRunId",
	"allocationId",
	"provider",
	"model",
	"modelPriced",
	"reason",
	"inputTokens",
	"outputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
	"totalTokens",
	"inputCostMicroUsd",
	"outputCostMicroUsd",
	"cacheReadCostMicroUsd",
	"cacheWriteCostMicroUsd",
	"providerCostMicroUsd",
	"providerReportedCostMicroUsd",
	"providerGenerationId",
	"pricingBasis",
	"cardCostMicroUsd",
	"cardProviderCostMicroUsd",
	"markupMicroUsd",
	"costMicroUsd",
	"pricingVersion",
	"pricedDefault",
]);

async function readAgentSessionInferenceBillingProvenanceTx(
	tx: RuntimeTx,
	sessionId: string,
): Promise<AgentSessionInferenceBillingProvenance> {
	const result = await tx.execute({
		sql: `SELECT session.owner_user_id, session.graph_id,
		             admission.child_run_id, admission.budget_allocation_id
		        FROM agent_sessions AS session
		        LEFT JOIN agent_session_child_admissions AS admission
		          ON admission.child_session_id = session.session_id
		       WHERE session.session_id = ?`,
		args: [sessionId],
	});
	const row = result.rows[0];
	if (!row) throw new AgentSessionBudgetFault("materialization_stale", "inference Session does not exist");
	return {
		userId: requiredProjectionString(row.owner_user_id, `inference Session ${sessionId} owner`),
		graphId: requiredProjectionString(row.graph_id, `inference Session ${sessionId} graph`),
		childRunId: nullableString(row.child_run_id),
		allocationId: nullableString(row.budget_allocation_id),
	};
}

async function validateBillingOutboxPayloadTx(
	tx: RuntimeTx,
	value: AgentSessionInferenceBillingEvent,
	reservation: AgentSessionInferenceReservationRecord,
	usage: AgentSessionBudgetVectorV1,
): Promise<AgentSessionInferenceBillingEvent> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new AgentSessionBudgetFault("request_invalid", "billingEvent must be a JSON object");
	}
	const record = value as unknown as Record<string, unknown>;
	const provenance = await readAgentSessionInferenceBillingProvenanceTx(tx, reservation.session_id);
	const pricedSession = await readAgentSessionTx(tx, reservation.session_id);
	if (!pricedSession) throw new AgentSessionBudgetFault("materialization_stale", "inference Session does not exist");
	const pricing = requireRateCardBindingTx(
		asRecord(agentSessionDocumentFromJson(pricedSession.document_json).source),
		{
			provider: reservation.provider,
			model: reservation.model,
		},
	);
	if (reservation.pricing_version !== pricing.pricingVersion) {
		throw new AgentSessionBudgetFault(
			"request_conflict",
			"the reservation was priced by a version the Agent Session is not pinned to",
		);
	}
	if ((value.fundingSource ?? "platform") !== reservation.funding_source)
		throw new AgentSessionBudgetFault(
			"request_conflict",
			"billingEvent funding diverges from reserved credential source",
		);
	const unknown = Object.keys(record).filter((key) => !AGENT_SESSION_INFERENCE_BILLING_FIELDS.has(key));
	if (unknown.length > 0) {
		throw new AgentSessionBudgetFault(
			"request_invalid",
			`billingEvent contains unsupported fields: ${unknown.join(", ")}`,
		);
	}
	const exact = {
		eventId: reservation.operation_id,
		sessionId: reservation.session_id,
		generation: reservation.generation,
		inferenceOperationId: reservation.operation_id,
		requestId: reservation.request_id,
		sandboxId: reservation.sandbox_id,
		provider: reservation.provider,
		model: reservation.model,
		pricingVersion: reservation.pricing_version,
		userId: provenance.userId,
		graphId: provenance.graphId,
		childRunId: provenance.childRunId,
		allocationId: provenance.allocationId,
	} as const;
	for (const [field, expected] of Object.entries(exact)) {
		if (record[field] !== expected) {
			throw new AgentSessionBudgetFault(
				"request_conflict",
				`billingEvent.${field} diverges from inference operation ${reservation.operation_id}`,
			);
		}
	}
	validateBudgetInteger(record.ts, "billingEvent.ts");
	for (const field of [
		"inputTokens",
		"outputTokens",
		"cacheReadTokens",
		"cacheWriteTokens",
		"totalTokens",
		"inputCostMicroUsd",
		"outputCostMicroUsd",
		"cacheReadCostMicroUsd",
		"cacheWriteCostMicroUsd",
		"providerCostMicroUsd",
		"markupMicroUsd",
		"costMicroUsd",
	] as const) {
		validateBudgetInteger(record[field], `billingEvent.${field}`);
	}
	if (record.providerReportedCostMicroUsd !== undefined && record.providerReportedCostMicroUsd !== null) {
		validateBudgetInteger(record.providerReportedCostMicroUsd, "billingEvent.providerReportedCostMicroUsd");
	}
	if (record.providerGenerationId !== undefined && record.providerGenerationId !== null) {
		requiredBoundedText(record.providerGenerationId, "billingEvent.providerGenerationId", 200);
	}
	for (const field of ["modelPriced"] as const) requiredBoundedText(record[field], `billingEvent.${field}`, 256);
	for (const field of ["userId", "graphId", "template", "reason", "childRunId", "allocationId"] as const) {
		if (record[field] !== null && record[field] !== undefined && typeof record[field] !== "string") {
			throw new AgentSessionBudgetFault("request_invalid", `billingEvent.${field} must be a string or null`);
		}
	}
	if (typeof record.pricedDefault !== "boolean") {
		throw new AgentSessionBudgetFault("request_invalid", "billingEvent.pricedDefault must be boolean");
	}
	// The third reader of the pinned price. It must be `priceInferenceCall`, with the Session's card: any other way of
	// pricing the call here would disagree with the settlement and refuse every event of a catalogue-priced Session.
	const deterministicCost = priceInferenceCall({
		card: pricing.rateCard,
		model: reservation.model,
		provider: reservation.provider,
		tokens: {
			input: record.inputTokens as number,
			output: record.outputTokens as number,
			cacheRead: record.cacheReadTokens as number,
			cacheWrite: record.cacheWriteTokens as number,
		},
	});
	// The pricing basis (2026-10-01): `card` and `fallback-card` must be the card's figure, exactly as before;
	// `fallback-actual` must be the provider's reported charge plus the card's markup, itemized in the card's proportions
	// (`priceAtProviderReport`), re-derived here from the reported charge. Either way the card's own figure is kept on
	// the event and must be the card's.
	const basis = record.pricingBasis;
	if (
		basis !== undefined &&
		basis !== null &&
		basis !== "card" &&
		basis !== "fallback-actual" &&
		basis !== "fallback-card"
	) {
		throw new AgentSessionBudgetFault("request_invalid", "billingEvent.pricingBasis is not a basis this host knows");
	}
	let pricedCost = deterministicCost;
	if (basis !== undefined && basis !== null) {
		if (!pricing.rateCard) {
			throw new AgentSessionBudgetFault(
				"request_conflict",
				"a pricing basis belongs only to a Session priced from a card",
			);
		}
		if (
			record.cardCostMicroUsd !== deterministicCost.totalCostMicroUsd ||
			record.cardProviderCostMicroUsd !== deterministicCost.providerCostMicroUsd
		) {
			throw new AgentSessionBudgetFault(
				"request_conflict",
				"billingEvent card figures diverge from the pinned card",
			);
		}
		if (basis === "fallback-actual") {
			validateBudgetInteger(record.providerReportedCostMicroUsd, "billingEvent.providerReportedCostMicroUsd");
			pricedCost = priceAtProviderReport(
				deterministicCost,
				record.providerReportedCostMicroUsd as number,
				pricing.rateCard.markupBps,
			);
		}
	} else if (record.cardCostMicroUsd != null || record.cardProviderCostMicroUsd != null) {
		throw new AgentSessionBudgetFault("request_invalid", "billingEvent card figures need a pricing basis");
	}
	const deterministicPricingTruth = {
		modelPriced: deterministicCost.modelPriced,
		inputCostMicroUsd: pricedCost.inputCostMicroUsd,
		outputCostMicroUsd: pricedCost.outputCostMicroUsd,
		cacheReadCostMicroUsd: pricedCost.cacheReadCostMicroUsd,
		cacheWriteCostMicroUsd: pricedCost.cacheWriteCostMicroUsd,
		providerCostMicroUsd: pricedCost.providerCostMicroUsd,
		markupMicroUsd: pricedCost.markupMicroUsd,
		costMicroUsd: pricedCost.totalCostMicroUsd,
		pricedDefault: deterministicCost.pricedDefault,
	} as const;
	for (const [field, expected] of Object.entries(deterministicPricingTruth)) {
		if (record[field] !== expected) {
			throw new AgentSessionBudgetFault(
				"request_conflict",
				`billingEvent.${field} diverges from pinned deterministic pricing`,
			);
		}
	}
	const itemizedProviderCost = checkedBudgetSum(
		checkedBudgetSum(record.inputCostMicroUsd as number, record.outputCostMicroUsd as number),
		checkedBudgetSum(record.cacheReadCostMicroUsd as number, record.cacheWriteCostMicroUsd as number),
	);
	if (itemizedProviderCost !== record.providerCostMicroUsd) {
		throw new AgentSessionBudgetFault("request_conflict", "billingEvent provider cost breakdown does not add up");
	}
	if (
		checkedBudgetSum(record.providerCostMicroUsd as number, record.markupMicroUsd as number) !== record.costMicroUsd
	) {
		throw new AgentSessionBudgetFault("request_conflict", "billingEvent total cost does not add up");
	}
	const accountedTokens = Math.max(
		record.totalTokens as number,
		checkedBudgetSum(record.inputTokens as number, record.outputTokens as number),
	);
	if (usage.turns !== 1 || usage.tokens !== accountedTokens || usage.costUsdMicros !== record.costMicroUsd) {
		throw new AgentSessionBudgetFault(
			"request_conflict",
			"billingEvent token/cost truth diverges from the authoritative budget settlement",
		);
	}
	try {
		canonicalJson(record);
	} catch (cause) {
		throw new AgentSessionBudgetFault("request_invalid", "billingEvent must be canonical JSON", cause);
	}
	return value;
}

async function requireAgentSessionInferenceBillingOutboxTx(
	tx: RuntimeTx,
	operationId: string,
): Promise<AgentSessionInferenceBillingOutboxRecord> {
	const result = await tx.execute({
		sql: "SELECT * FROM agent_session_inference_billing_outbox WHERE operation_id = ?",
		args: [operationId],
	});
	if (!result.rows[0]) throw new Error(`inference billing outbox is missing: ${operationId}`);
	return rowToAgentSessionInferenceBillingOutbox(result.rows[0]);
}

async function claimAgentMaterializationTx(
	tx: RuntimeTx,
	sessionId: string,
	input: { readonly generation: number; readonly activationId: string; readonly now: number },
): Promise<AgentMaterializationRecord> {
	if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
		throw new AgentSessionGenerationFault("Materialization generation must be a non-negative integer");
	}
	const session = await readAgentSessionTx(tx, sessionId);
	if (!session) throw new Error(`Agent session not found: ${sessionId}`);
	const result = await tx.execute({
		sql: "SELECT * FROM agent_materializations WHERE session_id = ? ORDER BY generation DESC LIMIT 1",
		args: [sessionId],
	});
	const latest = result.rows[0] ? rowToAgentMaterialization(result.rows[0]) : undefined;
	if (session.lifecycle_state === "closed" || session.lifecycle_state === "faulted") {
		throw new AgentSessionGenerationFault(`A ${session.lifecycle_state} Session cannot claim a materialization`);
	}
	if (latest?.generation === input.generation) {
		if (latest.activation_id !== input.activationId) {
			throw new AgentSessionGenerationFault(
				`Generation ${String(input.generation)} was already claimed by another activation`,
			);
		}
		await assertLiveLatestMaterializationActivationTx(tx, sessionId, input.generation, input.activationId);
		return latest;
	}
	if (session.lifecycle_state === "closing") {
		throw new AgentSessionGenerationFault("A closing Session cannot claim a new materialization generation");
	}
	if (latest) {
		if (input.generation !== latest.generation + 1) {
			throw new AgentSessionGenerationFault(
				`Generation ${String(input.generation)} does not immediately follow ${String(latest.generation)}`,
			);
		}
		const authorityTombstone =
			latest.state === "authority_revoked" && latest.checkpoint_id === null && latest.kernel_checkpoint_id === null;
		const resumablePredecessor =
			latest.state === "passivated" ||
			(latest.state === "faulted" && latest.recoverable === true) ||
			authorityTombstone;
		if (!resumablePredecessor || (!authorityTombstone && !latest.checkpoint_id)) {
			throw new AgentSessionRegrowRefusedFault(
				"A new generation requires a memory-committed passivated or recoverably faulted predecessor",
			);
		}
		const semanticRuntime = readAgentSessionSemanticBinding(session).runtime;
		if (semanticRuntime.kind !== "prime") {
			throw new AgentSessionRegrowRefusedFault("one-shot simple Session cannot regrow a materialization");
		}
		const predecessorBody = await tx.execute({
			sql: "SELECT role, state FROM agent_session_body_states WHERE session_id = ? AND generation = ?",
			args: [sessionId, latest.generation],
		});
		if (authorityTombstone) {
			if (
				predecessorBody.rows.length !== 0 ||
				!(await hasExactUnboundKernelTerminalTx(tx, sessionId, latest.generation))
			) {
				throw new AgentSessionRegrowRefusedFault("Authority-revoked regrow requires an exact no-body tombstone");
			}
		} else {
			const predecessorKernel = predecessorBody.rows.find((row) => row.role === "kernel");
			// A Session whose binding grants no persistent kernel never had one (workspace chat): the absence of a
			// kernel row is its exact kernel testimony, and its memory checkpoint is what it regrows from.
			const kernelless =
				semanticRuntime.constraints.allowPersistentKernel === false && predecessorKernel === undefined;
			const predecessorKernelState = String(predecessorKernel?.state ?? "");
			const allowedKernelStates =
				latest.state === "passivated" ? ["released", "shutdown"] : ["faulted", "released", "shutdown"];
			if (!kernelless && !allowedKernelStates.includes(predecessorKernelState)) {
				throw new AgentSessionRegrowRefusedFault(
					"Prime regrow requires exact terminal predecessor kernel testimony",
				);
			}
		}
		const occupied = await tx.execute({
			sql: `SELECT 1 AS found FROM agent_session_child_generation_occupancy
			      WHERE child_session_id = ? AND state = 'occupied' LIMIT 1`,
			args: [sessionId],
		});
		if (occupied.rows[0]) {
			throw new AgentSessionGenerationFault("Prime regrow cannot overlap a live predecessor body");
		}
	} else if (input.generation !== 0) {
		throw new AgentSessionGenerationFault("The first materialization must be generation zero");
	}
	await occupyAgentSessionChildGenerationTx(tx, sessionId, input.generation, input.now);
	await tx.execute({
		sql: `INSERT INTO agent_materializations
		        (session_id, generation, sandbox_id, activation_id, state, created_at, updated_at)
		      VALUES (?, ?, ?, ?, 'claimed', ?, ?)`,
		args: [sessionId, input.generation, `claim:${input.activationId}`, input.activationId, input.now, input.now],
	});
	await tx.execute({
		sql: `INSERT INTO agent_materialization_supervision
		        (session_id, generation, activation_id, heartbeat_at)
		      VALUES (?, ?, ?, ?)`,
		args: [sessionId, input.generation, input.activationId, input.now],
	});
	return (await readAgentMaterializationTx(tx, sessionId, input.generation))!;
}

async function readAgentMaterializationTx(
	tx: RuntimeTx,
	sessionId: string,
	generation: number,
): Promise<AgentMaterializationRecord | null> {
	const result = await tx.execute({
		sql: "SELECT * FROM agent_materializations WHERE session_id = ? AND generation = ?",
		args: [sessionId, generation],
	});
	return result.rows[0] ? rowToAgentMaterialization(result.rows[0]) : null;
}

async function requireAgentMaterializationRecoveryClaimTx(
	tx: RuntimeTx,
	sessionId: string,
	generation: number,
	claimed: boolean,
): Promise<AgentMaterializationRecoveryClaim> {
	const result = await tx.execute({
		sql: `SELECT materialization.*, session.lifecycle_state,
		             supervision.recovery_attempt, supervision.recovery_consumer,
			     supervision.recovery_token, supervision.recovery_expires_at,
			     run.child_run_id, outcome.status AS durable_outcome_status,
			     kernel_state.state AS kernel_state,
			     kernel_launch.state AS kernel_launch_state,
			     kernel_launch.sandbox_id AS kernel_launch_sandbox_id
		        FROM agent_materializations AS materialization
		        JOIN agent_materialization_supervision AS supervision
		          ON supervision.session_id = materialization.session_id
		         AND supervision.generation = materialization.generation
		        JOIN agent_sessions AS session ON session.session_id = materialization.session_id
		   LEFT JOIN agent_session_child_runs AS run ON run.child_session_id = materialization.session_id
		   LEFT JOIN agent_session_run_outcomes AS outcome
		          ON outcome.session_id = materialization.session_id AND outcome.outcome_id = run.child_run_id
		   LEFT JOIN agent_session_body_states AS kernel_state
		          ON kernel_state.session_id = materialization.session_id
		         AND kernel_state.generation = materialization.generation
		         AND kernel_state.role = 'kernel'
		   LEFT JOIN agent_session_kernel_launches AS kernel_launch
		          ON kernel_launch.session_id = materialization.session_id
		         AND kernel_launch.generation = materialization.generation
		       WHERE materialization.session_id = ? AND materialization.generation = ?`,
		args: [sessionId, generation],
	});
	if (!result.rows[0]) throw new AgentSessionChildRunFault("run_not_found", "materialization recovery claim vanished");
	const row = result.rows[0];
	const recoveryConsumer = nullableString(row.recovery_consumer);
	const recoveryToken = nullableString(row.recovery_token);
	const recoveryExpiresAt = nullableNumber(row.recovery_expires_at);
	const durableOutcomeStatus = nullableString(row.durable_outcome_status);
	const kernelState = nullableString(row.kernel_state);
	const kernelLaunchState = nullableString(row.kernel_launch_state);
	if (durableOutcomeStatus !== null && durableOutcomeStatus !== "completed" && durableOutcomeStatus !== "failed") {
		throw new AgentSessionChildRunFault("terminal_conflict", "materialization recovery outcome status is invalid");
	}
	if (kernelState !== null && !isAgentSessionKernelState(kernelState)) {
		throw new AgentSessionChildRunFault("terminal_conflict", "materialization recovery kernel state is invalid");
	}
	if (
		kernelLaunchState !== null &&
		!["not_requested", "launching", "bound", "failed_unbound"].includes(kernelLaunchState)
	) {
		throw new AgentSessionChildRunFault(
			"terminal_conflict",
			"materialization recovery kernel launch state is invalid",
		);
	}
	if (!recoveryConsumer || !recoveryToken || recoveryExpiresAt === null) {
		throw new AgentSessionChildRunFault("lease_lost", "materialization recovery claim is not active");
	}
	return {
		materialization: rowToAgentMaterialization(row),
		child_run_id: nullableString(row.child_run_id),
		durable_outcome_status: durableOutcomeStatus,
		kernel_state: kernelState,
		kernel_launch_state: kernelLaunchState as AgentMaterializationRecoveryClaim["kernel_launch_state"],
		kernel_launch_sandbox_id: nullableString(row.kernel_launch_sandbox_id),
		lifecycle_state: requiredAgentSessionLifecycleState(row.lifecycle_state, "recovery Session state"),
		recovery_attempt: Number(row.recovery_attempt),
		recovery_consumer: recoveryConsumer,
		recovery_token: recoveryToken,
		recovery_expires_at: recoveryExpiresAt,
		claimed,
	};
}

async function requireAgentSessionChildClosureWorkClaimTx(
	tx: RuntimeTx,
	closureId: string,
	claimed: boolean,
): Promise<AgentSessionChildClosureWorkClaim> {
	const result = await tx.execute({
		sql: `SELECT work.*, request.request_id, request.request_digest, request.actor_json,
		             request.reason, request.disposition, request.created_at AS request_created_at,
		             run.*, session.*, materialization.*,
		             work.child_run_id AS work_child_run_id, work.attempt AS work_attempt,
		             work.consumer AS work_consumer, work.cleanup_token AS work_cleanup_token,
		             work.claim_expires_at AS work_claim_expires_at,
		             run.child_run_id AS run_child_run_id,
		             run.child_session_id AS run_child_session_id,
		             run.parent_session_id AS run_parent_session_id,
		             run.admission_id AS run_admission_id,
		             run.state AS run_state, run.attempt AS run_attempt,
		             run.consumer AS run_consumer, run.claim_token AS run_claim_token,
		             run.claimed_at AS run_claimed_at, run.claim_expires_at AS run_claim_expires_at,
		             run.heartbeat_at AS run_heartbeat_at,
		             run.materialization_generation AS run_materialization_generation,
		             run.materialized_at AS run_materialized_at, run.result_json AS run_result_json,
		             run.error AS run_error, run.terminal_digest AS run_terminal_digest,
		             run.created_at AS run_created_at, run.terminal_at AS run_terminal_at,
		             session.session_id AS child_session_record_id,
		             session.created_at AS session_created_at, session.updated_at AS session_updated_at,
		             materialization.session_id AS materialization_session_id,
		             materialization.generation AS materialization_record_generation,
		             materialization.state AS materialization_record_state,
		             materialization.created_at AS materialization_created_at,
		             materialization.updated_at AS materialization_updated_at
		        FROM agent_session_child_closure_work AS work
		        JOIN agent_session_child_closure_requests AS request ON request.closure_id = work.closure_id
		        JOIN agent_session_child_runs AS run ON run.child_run_id = work.child_run_id
		        JOIN agent_sessions AS session ON session.session_id = run.child_session_id
		        JOIN agent_materializations AS materialization
		          ON materialization.session_id = run.child_session_id
		         AND materialization.generation = (
		           SELECT MAX(latest.generation) FROM agent_materializations AS latest
		            WHERE latest.session_id = run.child_session_id
		         )
		       WHERE work.closure_id = ? AND work.state = 'claimed'`,
		args: [closureId],
	});
	if (!result.rows[0]) throw new AgentSessionChildRunFault("lease_lost", "child closure work is not claimed");
	const row = result.rows[0];
	const request = rowToAgentSessionChildClosureRequest({
		closure_id: row.closure_id,
		child_run_id: row.work_child_run_id,
		request_id: row.request_id,
		request_digest: row.request_digest,
		actor_json: row.actor_json,
		reason: row.reason,
		disposition: row.disposition,
		created_at: row.request_created_at,
	});
	const run = rowToAgentSessionChildRun({
		child_run_id: row.run_child_run_id,
		admission_id: row.run_admission_id,
		parent_session_id: row.run_parent_session_id,
		child_session_id: row.run_child_session_id,
		state: row.run_state,
		attempt: row.run_attempt,
		consumer: row.run_consumer,
		claim_token: row.run_claim_token,
		claimed_at: row.run_claimed_at,
		claim_expires_at: row.run_claim_expires_at,
		heartbeat_at: row.run_heartbeat_at,
		materialization_generation: row.run_materialization_generation,
		materialized_at: row.run_materialized_at,
		result_json: row.run_result_json,
		error: row.run_error,
		terminal_digest: row.run_terminal_digest,
		created_at: row.run_created_at,
		terminal_at: row.run_terminal_at,
	});
	const session = rowToAgentSession({
		...row,
		session_id: row.child_session_record_id,
		created_at: row.session_created_at,
		updated_at: row.session_updated_at,
	});
	const materialization = rowToAgentMaterialization({
		...row,
		session_id: row.materialization_session_id,
		generation: row.materialization_record_generation,
		state: row.materialization_record_state,
		created_at: row.materialization_created_at,
		updated_at: row.materialization_updated_at,
	});
	return {
		request,
		run,
		session,
		materialization,
		attempt: Number(row.work_attempt),
		consumer: String(row.work_consumer),
		cleanup_token: String(row.work_cleanup_token),
		claim_expires_at: Number(row.work_claim_expires_at),
		claimed,
	};
}

async function assertActiveMaterializationRecoveryLeaseTx(
	tx: RuntimeTx,
	sessionId: string,
	generation: number,
	input: { readonly consumer: string; readonly recoveryToken: string; readonly now: number },
): Promise<void> {
	const result = await tx.execute({
		sql: `SELECT 1 AS found FROM agent_materialization_supervision
		      WHERE session_id = ? AND generation = ? AND recovery_consumer = ? AND recovery_token = ?
		        AND recovery_expires_at > ? AND recovery_heartbeat_at <= ? AND recovered_at IS NULL`,
		args: [sessionId, generation, input.consumer, input.recoveryToken, input.now, input.now],
	});
	if (!result.rows[0]) throw new AgentSessionChildRunFault("lease_lost", "materialization recovery lease is stale");
}

async function assertActiveMaterializationActivationTx(
	tx: RuntimeTx,
	sessionId: string,
	generation: number,
	activationId: string,
): Promise<void> {
	const canonicalActivationId = requiredChildRunText(activationId, "materialization activation id", 256);
	const result = await tx.execute({
		sql: `SELECT 1 AS found
		        FROM agent_materializations AS materialization
		        JOIN agent_materialization_supervision AS supervision
		          ON supervision.session_id = materialization.session_id
		         AND supervision.generation = materialization.generation
		         AND supervision.activation_id = materialization.activation_id
		       WHERE materialization.session_id = ? AND materialization.generation = ?
		         AND materialization.activation_id = ? AND supervision.recovery_token IS NULL
		         AND supervision.recovered_at IS NULL`,
		args: [sessionId, generation, canonicalActivationId],
	});
	if (!result.rows[0]) {
		throw new AgentSessionChildRunFault(
			"lease_lost",
			"materialization activation was replaced or fenced for recovery",
		);
	}
}

async function assertLiveLatestMaterializationActivationTx(
	tx: RuntimeTx,
	sessionId: string,
	generation: number,
	activationId: string,
): Promise<void> {
	const canonicalActivationId = requiredChildRunText(activationId, "materialization activation id", 256);
	const result = await tx.execute({
		sql: `SELECT 1 AS found
		        FROM agent_materializations AS materialization
		        JOIN agent_materialization_supervision AS supervision
		          ON supervision.session_id = materialization.session_id
		         AND supervision.generation = materialization.generation
		         AND supervision.activation_id = materialization.activation_id
		       WHERE materialization.session_id = ? AND materialization.generation = ?
		         AND materialization.activation_id = ? AND supervision.recovery_token IS NULL
		         AND supervision.recovered_at IS NULL
		         AND materialization.state IN ('claimed', 'running', 'quiescing', 'quiescent')
		         AND materialization.generation = (
		           SELECT MAX(latest.generation) FROM agent_materializations AS latest
		            WHERE latest.session_id = materialization.session_id
		         )`,
		args: [sessionId, generation, canonicalActivationId],
	});
	if (!result.rows[0]) {
		throw new AgentSessionChildRunFault("lease_lost", "materialization activation is not the latest live generation");
	}
}

async function assertLatestMaterializationActivationTx(
	tx: RuntimeTx,
	sessionId: string,
	generation: number,
	activationId: string,
): Promise<void> {
	const canonicalActivationId = requiredChildRunText(activationId, "materialization activation id", 256);
	const result = await tx.execute({
		sql: `SELECT 1 AS found
		        FROM agent_materializations AS materialization
		        JOIN agent_materialization_supervision AS supervision
		          ON supervision.session_id = materialization.session_id
		         AND supervision.generation = materialization.generation
		         AND supervision.activation_id = materialization.activation_id
		       WHERE materialization.session_id = ? AND materialization.generation = ?
		         AND materialization.activation_id = ? AND supervision.recovery_token IS NULL
		         AND supervision.recovered_at IS NULL
		         AND materialization.generation = (
		           SELECT MAX(latest.generation) FROM agent_materializations AS latest
		            WHERE latest.session_id = materialization.session_id
		         )`,
		args: [sessionId, generation, canonicalActivationId],
	});
	if (!result.rows[0]) {
		throw new AgentSessionChildRunFault(
			"lease_lost",
			"materialization activation is no longer the latest cleanup authority",
		);
	}
}

async function assertMaterializationNotRecoveryFencedTx(
	tx: RuntimeTx,
	sessionId: string,
	generation: number,
): Promise<void> {
	const result = await tx.execute({
		sql: `SELECT 1 AS found FROM agent_materialization_supervision
		      WHERE session_id = ? AND generation = ? AND recovery_token IS NULL AND recovered_at IS NULL`,
		args: [sessionId, generation],
	});
	if (!result.rows[0]) {
		throw new AgentSessionChildRunFault("lease_lost", "materialization generation is fenced for recovery");
	}
}

async function assertPersistentKernelSessionTx(tx: RuntimeTx, sessionId: string): Promise<void> {
	const session = await readAgentSessionTx(tx, sessionId);
	if (!session || readAgentSessionSemanticBinding(session).runtime.kind !== "prime") {
		throw new AgentSessionGenerationFault("Kernel body testimony is only valid for a persistent Prime Session");
	}
}

async function assertMaterializationRecoveryLeaseIdentityTx(
	tx: RuntimeTx,
	sessionId: string,
	generation: number,
	input: { readonly consumer: string; readonly recoveryToken: string },
): Promise<void> {
	const result = await tx.execute({
		sql: `SELECT 1 AS found FROM agent_materialization_supervision
		      WHERE session_id = ? AND generation = ? AND recovery_consumer = ? AND recovery_token = ?`,
		args: [sessionId, generation, input.consumer, input.recoveryToken],
	});
	if (!result.rows[0]) {
		throw new AgentSessionChildRunFault("lease_lost", "materialization recovery fence identity is stale");
	}
}

async function completeAgentMaterializationRecoveryTx(
	tx: RuntimeTx,
	sessionId: string,
	generation: number,
	now: number,
): Promise<void> {
	const updated = await tx.execute({
		sql: `UPDATE agent_materialization_supervision
		         SET recovered_at = ?
		       WHERE session_id = ? AND generation = ? AND recovered_at IS NULL
		         AND recovery_heartbeat_at <= ?`,
		args: [now, sessionId, generation, now],
	});
	if (updated.rowsAffected !== 1) {
		const replay = await tx.execute({
			sql: `SELECT recovered_at FROM agent_materialization_supervision
			      WHERE session_id = ? AND generation = ? AND recovered_at IS NOT NULL`,
			args: [sessionId, generation],
		});
		if (!replay.rows[0]) {
			throw new AgentSessionChildRunFault("lease_lost", "materialization recovery completion lost its fence");
		}
	}
}

async function hasCancellingChildRunTx(tx: RuntimeTx, childSessionId: string): Promise<boolean> {
	const result = await tx.execute({
		sql: "SELECT 1 AS found FROM agent_session_child_runs WHERE child_session_id = ? AND state = 'cancelling'",
		args: [childSessionId],
	});
	return result.rows[0] !== undefined;
}

/**
 * A hosted simple child's immutable logical outcome owns Session closure. Its
 * physical worker may still fault, but that body testimony must not install the
 * standalone irrecoverable-fault cascade ahead of exact child-run settlement.
 */
async function hasHostedSimpleLogicalOutcomeTx(tx: RuntimeTx, childSessionId: string): Promise<boolean> {
	const result = await tx.execute({
		sql: `SELECT session.document_json, session.session_id, admission.runtime_binding_digest
		        FROM agent_session_child_runs AS run
		        JOIN agent_session_run_outcomes AS outcome
		          ON outcome.session_id = run.child_session_id
		         AND outcome.outcome_id = run.child_run_id
		        JOIN agent_sessions AS session ON session.session_id = run.child_session_id
		        JOIN agent_session_child_admissions AS admission ON admission.child_run_id = run.child_run_id
		       WHERE run.child_session_id = ?
		       LIMIT 1`,
		args: [childSessionId],
	});
	if (!result.rows[0]) return false;
	return (
		childRuntimeKindFromDocument(
			String(result.rows[0].document_json),
			String(result.rows[0].session_id),
			String(result.rows[0].runtime_binding_digest),
		) === "simple"
	);
}

async function assertHostedChildMaterializationOutcomeTx(
	tx: RuntimeTx,
	childSessionId: string,
	generation: number,
	to: "passivated" | "completed" | "faulted" | "cancelled",
): Promise<void> {
	const result = await tx.execute({
		sql: "SELECT * FROM agent_session_child_runs WHERE child_session_id = ?",
		args: [childSessionId],
	});
	if (!result.rows[0]) {
		const session = await readAgentSessionTx(tx, childSessionId);
		if (!session) return;
		const runtimeKind = readAgentSessionSemanticBinding(session).runtime.kind;
		if (runtimeKind === "simple" && to === "passivated") {
			throw new AgentSessionChildRunFault("terminal_conflict", "one-shot simple Session cannot passivate");
		}
		if (runtimeKind === "simple" && (to === "completed" || to === "cancelled")) {
			const outcome = await tx.execute({
				sql: `SELECT status FROM agent_session_run_outcomes
				      WHERE session_id = ? ORDER BY created_at DESC, outcome_id DESC LIMIT 1`,
				args: [childSessionId],
			});
			const cancellation =
				to === "cancelled"
					? await tx.execute({
							sql: `SELECT 1 AS found
							        FROM agent_session_descendant_cascade_members AS member
							        JOIN agent_session_descendant_cascades AS cascade ON cascade.cascade_id = member.cascade_id
							       WHERE member.session_id = ? AND cascade.state = 'active'
							         AND (cascade.cause = 'explicit_cancel' OR member.depth > 0)
							       LIMIT 1`,
							args: [childSessionId],
						})
					: null;
			if (
				(!outcome.rows[0] && !cancellation?.rows[0]) ||
				(to === "cancelled"
					? Boolean(outcome.rows[0]) && String(outcome.rows[0].status) !== "cancelled"
					: !["completed", "failed"].includes(String(outcome.rows[0].status)))
			) {
				throw new AgentSessionChildRunFault(
					"terminal_conflict",
					"healthy one-shot body exit requires immutable logical outcome testimony",
				);
			}
		}
		return;
	}
	const run = rowToAgentSessionChildRun(result.rows[0]);
	if (run.materialization_generation !== generation && !isTerminalAgentSessionChildRunState(run.state)) {
		throw new AgentSessionChildRunFault(
			"materialization_conflict",
			"nonterminal child run does not own this materialization generation",
		);
	}
	if (isTerminalAgentSessionChildRunState(run.state)) {
		if (to === "passivated") return;
		if (to === "faulted") return;
		if (to !== "completed" && to !== "cancelled") return;
		const closure = await tx.execute({
			sql: `SELECT 1 AS found FROM agent_session_child_closure_requests
			      WHERE child_run_id = ? AND disposition = 'closure_pending'`,
			args: [run.child_run_id],
		});
		if (closure.rows[0]) return;
		throw new AgentSessionChildRunFault(
			"cancellation_conflict",
			`resident child body ${to} requires durable closure intent`,
		);
	}
	if (to === "passivated") {
		throw new AgentSessionChildRunFault("terminal_conflict", "child passivation requires a terminal logical run");
	}
	if (to === "completed") {
		const outcome = await tx.execute({
			sql: `SELECT status FROM agent_session_run_outcomes
			      WHERE session_id = ? AND outcome_id = ?`,
			args: [childSessionId, run.child_run_id],
		});
		if (!outcome.rows[0] || !["completed", "failed"].includes(String(outcome.rows[0].status))) {
			throw new AgentSessionChildRunFault(
				"terminal_conflict",
				"healthy child body exit requires immutable logical outcome testimony",
			);
		}
	}
	if (to === "cancelled") {
		const cancellation = await tx.execute({
			sql: `SELECT 1 AS found FROM agent_session_child_cancellation_requests
			      WHERE child_run_id = ? AND disposition = 'cancellation_pending'`,
			args: [run.child_run_id],
		});
		if (run.state !== "cancelling" || !cancellation.rows[0]) {
			throw new AgentSessionChildRunFault(
				"cancellation_conflict",
				"child body cancellation requires the durable cancelling run fence",
			);
		}
		return;
	}
	if (to === "faulted" && run.state === "cancelling") {
		const cancellation = await tx.execute({
			sql: `SELECT 1 AS found FROM agent_session_child_cancellation_requests
			      WHERE child_run_id = ? AND disposition = 'cancellation_pending' LIMIT 1`,
			args: [run.child_run_id],
		});
		if (cancellation.rows[0]) return;
	}
	if (run.state !== "claimed") {
		throw new AgentSessionChildRunFault(
			"terminal_conflict",
			`child body ${to} conflicts with ${run.state} run ownership`,
		);
	}
}

async function requireAgentSessionChildRunTx(tx: RuntimeTx, childRunId: string): Promise<AgentSessionChildRunRecord> {
	const result = await tx.execute({
		sql: "SELECT * FROM agent_session_child_runs WHERE child_run_id = ?",
		args: [childRunId],
	});
	if (!result.rows[0]) {
		throw new AgentSessionChildRunFault("run_not_found", `Agent Session child run not found: ${childRunId}`);
	}
	return rowToAgentSessionChildRun(result.rows[0]);
}

async function requireChildSessionForRunTx(
	tx: RuntimeTx,
	run: AgentSessionChildRunRecord,
): Promise<AgentSessionRecord> {
	const child = await readAgentSessionTx(tx, run.child_session_id);
	if (!child) throw new Error(`Agent Session child run ${run.child_run_id} has no child Session`);
	return child;
}

async function requireChildAdmissionForRunTx(
	tx: RuntimeTx,
	run: AgentSessionChildRunRecord,
): Promise<AgentSessionChildAdmissionRecord> {
	const result = await tx.execute({
		sql: "SELECT * FROM agent_session_child_admissions WHERE admission_id = ?",
		args: [run.admission_id],
	});
	if (!result.rows[0]) throw new Error(`Agent Session child run ${run.child_run_id} has no admission`);
	return rowToAgentSessionChildAdmission(result.rows[0]);
}

async function requireChildAllocationForRunTx(
	tx: RuntimeTx,
	childRunId: string,
): Promise<AgentSessionChildBudgetAllocationRecord> {
	const result = await tx.execute({
		sql: `SELECT allocation.* FROM agent_session_child_budget_allocations AS allocation
		      JOIN agent_session_child_runs AS run ON run.admission_id = allocation.admission_id
		      WHERE run.child_run_id = ?`,
		args: [childRunId],
	});
	if (!result.rows[0]) throw new Error(`Agent Session child run ${childRunId} has no budget allocation`);
	return rowToAgentSessionChildBudgetAllocation(result.rows[0]);
}

function assertChildRunLeaseIdentity(
	run: AgentSessionChildRunRecord,
	fence: Pick<AgentSessionChildRunLeaseFence, "consumer" | "claimToken">,
): void {
	if (run.consumer !== fence.consumer || run.claim_token !== fence.claimToken) {
		throw new AgentSessionChildRunFault("lease_lost", `child run ${run.child_run_id} lease token is stale`);
	}
}

function assertActiveChildRunLease(
	run: AgentSessionChildRunRecord,
	fence: AgentSessionChildRunLeaseFence,
	states: readonly AgentSessionChildRunState[],
): void {
	assertChildRunLeaseIdentity(run, fence);
	if (!states.includes(run.state)) {
		throw new AgentSessionChildRunFault(
			"lease_lost",
			`child run ${run.child_run_id} is ${run.state}, not ${states.join("|")}`,
		);
	}
	if (run.claim_expires_at === null || run.claim_expires_at <= fence.now) {
		throw new AgentSessionChildRunFault("lease_expired", `child run ${run.child_run_id} lease expired`);
	}
	if (run.heartbeat_at === null || run.heartbeat_at > fence.now) {
		throw new AgentSessionChildRunFault(
			"lease_lost",
			`child run ${run.child_run_id} settlement predates its heartbeat`,
		);
	}
}

async function requireChildRunExpectedMaterializationTx(
	tx: RuntimeTx,
	run: AgentSessionChildRunRecord,
	input: Pick<
		SettleAgentSessionChildRunInput,
		"materializationGeneration" | "materializationState" | "status" | "now"
	>,
): Promise<AgentMaterializationRecord> {
	if (run.materialized_at === null || run.materialization_generation !== input.materializationGeneration) {
		throw new AgentSessionChildRunFault(
			"materialization_conflict",
			`child run ${run.child_run_id} settlement does not bind its admitted materialization`,
		);
	}
	const materialization = await readAgentMaterializationTx(tx, run.child_session_id, input.materializationGeneration);
	if (!materialization || materialization.state !== input.materializationState) {
		throw new AgentSessionChildRunFault(
			"materialization_conflict",
			`child run ${run.child_run_id} materialization state changed before settlement`,
		);
	}
	if (materialization.updated_at > input.now) {
		throw new AgentSessionChildRunFault("materialization_conflict", "child settlement predates body testimony");
	}
	if (
		(input.status === "completed" && !["running", "completed"].includes(materialization.state)) ||
		(input.status === "failed" && !["running", "completed", "faulted"].includes(materialization.state)) ||
		(input.status === "cancelled" && !["cancelled", "faulted"].includes(materialization.state))
	) {
		throw new AgentSessionChildRunFault(
			"materialization_conflict",
			`child run ${run.child_run_id} ${input.status} result conflicts with ${materialization.state} body truth`,
		);
	}
	return materialization;
}

async function assertChildRunLogicalOutcomeTx(
	tx: RuntimeTx,
	run: AgentSessionChildRunRecord,
	settlement: Pick<SettleAgentSessionChildRunInput, "status" | "result" | "error">,
	materialization: AgentMaterializationRecord,
): Promise<void> {
	if (settlement.status === "cancelled") {
		const cancellation = await tx.execute({
			sql: `SELECT reason FROM agent_session_child_cancellation_requests
			      WHERE child_run_id = ? AND disposition = 'cancellation_pending'
			      ORDER BY created_at ASC, request_id ASC LIMIT 1`,
			args: [run.child_run_id],
		});
		if (!cancellation.rows[0]) {
			throw new AgentSessionChildRunFault(
				"cancellation_conflict",
				"cancelled child settlement requires immutable cancellation intent",
			);
		}
		if (settlement.result !== undefined) {
			throw new AgentSessionChildRunFault(
				"terminal_conflict",
				"cancelled child settlement cannot carry a result payload",
			);
		}
		if (settlement.error !== String(cancellation.rows[0].reason)) {
			throw new AgentSessionChildRunFault(
				"terminal_conflict",
				"cancelled child settlement error must equal its immutable cancellation reason",
			);
		}
		return;
	}
	const outcome = await tx.execute({
		sql: `SELECT status, result_json FROM agent_session_run_outcomes
		      WHERE session_id = ? AND outcome_id = ?`,
		args: [run.child_session_id, run.child_run_id],
	});
	if (!outcome.rows[0]) {
		if (
			settlement.status === "failed" &&
			materialization.state === "faulted" &&
			settlement.result === undefined &&
			settlement.error === `materialization fault: ${String(materialization.fault_kind)}`
		)
			return;
		throw new AgentSessionChildRunFault(
			"terminal_conflict",
			"child settlement requires immutable logical outcome testimony",
		);
	}
	if (String(outcome.rows[0].status) !== settlement.status) {
		throw new AgentSessionChildRunFault(
			"terminal_conflict",
			"child settlement status diverges from immutable logical outcome testimony",
		);
	}
	const durableResult = JSON.parse(String(outcome.rows[0].result_json));
	if (settlement.result === undefined || canonicalJson(settlement.result) !== canonicalJson(durableResult)) {
		throw new AgentSessionChildRunFault(
			"terminal_conflict",
			"child settlement result diverges from immutable logical outcome testimony",
		);
	}
}

async function hasExactUnboundKernelTerminalTx(tx: RuntimeTx, sessionId: string, generation: number): Promise<boolean> {
	const launch = await tx.execute({
		sql: "SELECT state FROM agent_session_kernel_launches WHERE session_id = ? AND generation = ?",
		args: [sessionId, generation],
	});
	const state = nullableString(launch.rows[0]?.state);
	return state === "not_requested" || state === "failed_unbound";
}

async function requireReleasedChildRunOccupancyTx(
	tx: RuntimeTx,
	run: AgentSessionChildRunRecord,
	materialization: AgentMaterializationRecord,
): Promise<void> {
	const latest = await tx.execute({
		sql: "SELECT MAX(generation) AS generation FROM agent_materializations WHERE session_id = ?",
		args: [run.child_session_id],
	});
	if (Number(latest.rows[0]?.generation) !== materialization.generation) {
		throw new AgentSessionChildRunFault(
			"materialization_conflict",
			`child run ${run.child_run_id} cannot close against a stale materialization generation`,
		);
	}
	const result = await tx.execute({
		sql: `SELECT * FROM agent_session_child_generation_occupancy
		      WHERE child_session_id = ? AND generation = ?`,
		args: [run.child_session_id, materialization.generation],
	});
	if (!result.rows[0] || rowToAgentSessionChildGenerationOccupancy(result.rows[0]).state !== "released") {
		throw new AgentSessionChildRunFault(
			"materialization_conflict",
			`child run ${run.child_run_id} cannot close while its generation occupies capacity`,
		);
	}
	const liveOccupancy = await tx.execute({
		sql: `SELECT 1 AS found FROM agent_session_child_generation_occupancy
		      WHERE child_session_id = ? AND state = 'occupied' LIMIT 1`,
		args: [run.child_session_id],
	});
	if (liveOccupancy.rows[0]) {
		throw new AgentSessionChildRunFault(
			"materialization_conflict",
			`child run ${run.child_run_id} cannot close while any generation occupies capacity`,
		);
	}
	const body = await tx.execute({
		sql: `SELECT role, state FROM agent_session_body_states
		      WHERE session_id = ? AND generation = ?`,
		args: [run.child_session_id, materialization.generation],
	});
	const workerState = body.rows.find((row) => row.role === "worker")?.state;
	if (workerState !== materialization.state) {
		throw new AgentSessionChildRunFault(
			"materialization_conflict",
			`child run ${run.child_run_id} lacks exact terminal worker testimony`,
		);
	}
	const child = await requireChildSessionForRunTx(tx, run);
	const runtimeKind = readAgentSessionSemanticBinding(child).runtime.kind;
	const kernelState = body.rows.find((row) => row.role === "kernel")?.state;
	if (runtimeKind === "simple") {
		if (kernelState !== undefined) {
			throw new AgentSessionChildRunFault(
				"materialization_conflict",
				`simple child run ${run.child_run_id} cannot carry fabricated kernel testimony`,
			);
		}
		return;
	}
	// The launch ledger, not raw row absence, proves this Prime generation never
	// crossed the kernel process bind boundary. Any terminal worker/materialization
	// may close without inventing a kernel body under that exact no-bind fact;
	// once a kernel row exists it remains subject to the compatibility fence.
	if (
		kernelState === undefined &&
		["passivated", "completed", "faulted", "cancelled"].includes(materialization.state) &&
		(await hasExactUnboundKernelTerminalTx(tx, run.child_session_id, materialization.generation))
	)
		return;
	const allowedKernelStates: Readonly<
		Record<"passivated" | "completed" | "faulted" | "cancelled", readonly string[]>
	> = {
		passivated: ["released", "shutdown"],
		completed: ["shutdown"],
		faulted: ["faulted", "shutdown", "released"],
		cancelled: ["cancelled", "shutdown"],
	};
	if (
		!["passivated", "completed", "faulted", "cancelled"].includes(materialization.state) ||
		!allowedKernelStates[materialization.state as keyof typeof allowedKernelStates].includes(String(kernelState))
	) {
		throw new AgentSessionChildRunFault(
			"materialization_conflict",
			`resident child run ${run.child_run_id} lacks consistent terminal kernel testimony`,
		);
	}
}

async function assertChildCancellationActorTx(
	tx: RuntimeTx,
	run: AgentSessionChildRunRecord,
	actor: AgentSessionChildCancellationActor,
): Promise<void> {
	if (actor.kind === "session_cascade") {
		const cascade = await tx.execute({
			sql: `SELECT 1 AS found
			        FROM agent_session_descendant_cascades AS cascade
			        JOIN agent_session_descendant_cascade_members AS member
			          ON member.cascade_id = cascade.cascade_id
			       WHERE cascade.cascade_id = ? AND cascade.root_session_id = ? AND cascade.cause_digest = ?
			         AND cascade.state = 'active' AND member.session_id = ? AND member.child_run_id = ?`,
			args: [actor.cascadeId, actor.rootSessionId, actor.causeDigest, run.child_session_id, run.child_run_id],
		});
		if (!cascade.rows[0]) {
			throw new AgentSessionChildRunFault("authority_invalid", "child control cascade authority is stale");
		}
		return;
	}
	if (actor.parentSessionId !== run.parent_session_id) {
		throw new AgentSessionChildRunFault("authority_invalid", "child cancellation actor is not its durable parent");
	}
	await assertActiveMaterializationActivationTx(tx, actor.parentSessionId, actor.generation, actor.activationId);
	const parent = await readAgentSessionTx(tx, actor.parentSessionId);
	if (!parent || parent.lifecycle_state !== "open") {
		throw new AgentSessionChildRunFault("authority_invalid", "child control requires an open parent Session");
	}
	const materialization = await readAgentMaterializationTx(tx, actor.parentSessionId, actor.generation);
	if (
		!materialization ||
		materialization.activation_id !== actor.activationId ||
		materialization.sandbox_id !== actor.sandboxId ||
		materialization.state !== "running"
	) {
		throw new AgentSessionChildRunFault(
			"authority_invalid",
			"child cancellation actor is not the exact running parent materialization",
		);
	}
}

async function decideAgentSessionChildCancellationTx(
	tx: RuntimeTx,
	run: AgentSessionChildRunRecord,
	reason: string,
	now: number,
): Promise<{ disposition: AgentSessionChildCancellationDisposition; applied: boolean }> {
	if (await agentSessionChildTerminalPrecededTx(tx, run)) {
		return { disposition: "terminal_preceded", applied: false };
	}
	if (run.materialized_at === null) {
		await cancelPreMaterializationChildRunTx(tx, run, reason, now);
		return { disposition: "cancelled_before_materialization", applied: true };
	}
	if (run.state === "claimed") {
		const updated = await tx.execute({
			sql: "UPDATE agent_session_child_runs SET state = 'cancelling' WHERE child_run_id = ? AND state = 'claimed'",
			args: [run.child_run_id],
		});
		if (updated.rowsAffected !== 1) {
			throw new AgentSessionChildRunFault("cancellation_conflict", "child cancellation lost its first-wins CAS");
		}
		await tx.execute({
			sql: `UPDATE agent_sessions SET lifecycle_state = 'closing', updated_at = ?
			      WHERE session_id = ? AND lifecycle_terminal_digest IS NULL`,
			args: [now, run.child_session_id],
		});
		return { disposition: "cancellation_pending", applied: true };
	}
	return { disposition: "cancellation_pending", applied: false };
}

async function agentSessionChildTerminalPrecededTx(tx: RuntimeTx, run: AgentSessionChildRunRecord): Promise<boolean> {
	const boundMaterialization =
		run.materialization_generation === null
			? null
			: await readAgentMaterializationTx(tx, run.child_session_id, run.materialization_generation);
	const bodyPrecededCancellation =
		boundMaterialization !== null &&
		["passivated", "completed", "faulted", "cancelled"].includes(boundMaterialization.state);
	const outcomePrecededCancellation = await tx.execute({
		sql: "SELECT 1 AS found FROM agent_session_run_outcomes WHERE session_id = ? AND outcome_id = ?",
		args: [run.child_session_id, run.child_run_id],
	});
	return Boolean(
		isTerminalAgentSessionChildRunState(run.state) || bodyPrecededCancellation || outcomePrecededCancellation.rows[0],
	);
}

async function installAgentSessionCascadeRunControlTx(
	tx: RuntimeTx,
	cascade: AgentSessionDescendantCascadeRecord,
	run: AgentSessionChildRunRecord,
	now: number,
): Promise<void> {
	const actor: AgentSessionChildCancellationActor = {
		kind: "session_cascade",
		rootSessionId: cascade.root_session_id,
		cascadeId: cascade.cascade_id,
		causeDigest: cascade.cause_digest,
	};
	const requestId = `cascade-${cascade.cascade_id.slice(4)}`;
	const requestDigest = digestJson({
		schema: "choreograph.agent-session-child-cancellation.v1",
		childRunId: run.child_run_id,
		reason: cascade.reason,
		actor,
	});
	if (isTerminalAgentSessionChildRunState(run.state)) {
		const closed = await readAgentSessionTx(tx, run.child_session_id);
		if (closed?.lifecycle_state === "closed") return;
		const prior = await tx.execute({
			sql: "SELECT 1 AS found FROM agent_session_child_closure_requests WHERE child_run_id = ?",
			args: [run.child_run_id],
		});
		if (prior.rows[0]) return;
		const closureId = childClosureId(run.child_run_id, requestId);
		await tx.execute({
			sql: `INSERT INTO agent_session_child_closure_requests
			        (closure_id, child_run_id, request_id, request_digest, actor_json,
			         reason, disposition, created_at)
			      VALUES (?, ?, ?, ?, ?, ?, 'closure_pending', ?)`,
			args: [closureId, run.child_run_id, requestId, requestDigest, JSON.stringify(actor), cascade.reason, now],
		});
		await tx.execute({
			sql: `INSERT INTO agent_session_child_closure_work
			        (closure_id, child_run_id, state, created_at, updated_at)
			      VALUES (?, ?, 'pending', ?, ?)`,
			args: [closureId, run.child_run_id, now, now],
		});
		return;
	}
	const prior = await readAgentSessionChildCancellationRequestTx(tx, run.child_run_id, requestId);
	if (prior) return;
	const { disposition } = await decideAgentSessionChildCancellationTx(tx, run, cascade.reason, now);
	await insertAgentSessionChildCancellationRequestTx(tx, {
		cancellation_id: childCancellationId(run.child_run_id, requestId),
		child_run_id: run.child_run_id,
		request_id: requestId,
		request_digest: requestDigest,
		actor,
		reason: cascade.reason,
		disposition,
		observed_run_state: run.state,
		created_at: now,
	});
}

async function cancelPreMaterializationChildRunTx(
	tx: RuntimeTx,
	run: AgentSessionChildRunRecord,
	reason: string,
	now: number,
): Promise<void> {
	const placeholder = await tx.execute({
		sql: `SELECT materialization.session_id, materialization.generation, materialization.activation_id,
		             materialization.sandbox_id, materialization.state
		      FROM agent_materializations AS materialization
		      WHERE materialization.session_id = ?
		      ORDER BY materialization.generation DESC LIMIT 1`,
		args: [run.child_session_id],
	});
	if (placeholder.rows[0]) {
		const row = placeholder.rows[0];
		const activationId = String(row.activation_id);
		if (
			Number(row.generation) !== 0 ||
			String(row.state) !== "claimed" ||
			String(row.sandbox_id) !== `claim:${activationId}`
		) {
			throw new AgentSessionChildRunFault(
				"materialization_conflict",
				"pre-materialization cancellation found an admitted worker body",
			);
		}
		const bodies = await tx.execute({
			sql: "SELECT 1 AS found FROM agent_session_body_states WHERE session_id = ? AND generation = 0 LIMIT 1",
			args: [run.child_session_id],
		});
		if (bodies.rows[0]) {
			throw new AgentSessionChildRunFault(
				"materialization_conflict",
				"pre-materialization cancellation cannot erase body testimony",
			);
		}
		await tx.execute({
			sql: `DELETE FROM agent_materialization_supervision
			      WHERE session_id = ? AND generation = 0 AND activation_id = ? AND recovery_token IS NULL`,
			args: [run.child_session_id, activationId],
		});
		const deleted = await tx.execute({
			sql: `DELETE FROM agent_materializations
			      WHERE session_id = ? AND generation = 0 AND activation_id = ?
			        AND state = 'claimed' AND sandbox_id = ?`,
			args: [run.child_session_id, activationId, `claim:${activationId}`],
		});
		if (deleted.rowsAffected !== 1) {
			throw new AgentSessionChildRunFault(
				"materialization_conflict",
				"launch placeholder cancellation lost its CAS",
			);
		}
	}
	const admission = await requireChildAdmissionForRunTx(tx, run);
	const allocation = await requireChildAllocationForRunTx(tx, run.child_run_id);
	if (allocation.state !== "reserved") {
		throw new AgentSessionChildRunFault(
			"accounting_blocked",
			"pre-materialization cancellation requires a reserved child allocation",
		);
	}
	const childAccount = await requireAgentSessionBudgetAccountTx(
		tx,
		run.child_session_id,
		budgetVectorFromChildSlice(allocation.budget),
	);
	if (
		AGENT_SESSION_BUDGET_DIMENSIONS.some(
			(dimension) => childAccount.reserved[dimension] !== 0 || childAccount.spent[dimension] !== 0,
		)
	) {
		throw new AgentSessionChildRunFault(
			"accounting_blocked",
			"pre-materialization cancellation cannot release a non-zero child account",
		);
	}
	await releaseAgentSessionChildGenerationOccupancyTx(tx, run.child_session_id, 0, now);
	await applyAgentSessionBudgetLedgerEntryTx(tx, {
		sessionId: run.parent_session_id,
		kind: "child_released",
		referenceId: allocation.allocation_id,
		reservedDelta: negateAgentSessionBudget(budgetVectorFromChildSlice(allocation.budget)),
		spentDelta: ZERO_AGENT_SESSION_BUDGET,
		detail: {
			schema: "choreograph.agent-session-budget-child-released.v1",
			allocationId: allocation.allocation_id,
			childSessionId: run.child_session_id,
			reason: "cancelled_before_materialization",
		},
		now,
	});
	await tx.execute({
		sql: `UPDATE agent_session_child_budget_allocations
		         SET state = 'released', settled_at = ?
		       WHERE allocation_id = ? AND state = 'reserved'`,
		args: [now, allocation.allocation_id],
	});
	const terminalDigest = digestChildRunTerminal({
		childRunId: run.child_run_id,
		status: "cancelled",
		terminalPolicy: "close",
		materializationGeneration: null,
		materializationState: "not_materialized",
		result: null,
		error: reason,
	});
	await tx.execute({
		sql: `UPDATE agent_session_child_runs
		         SET state = 'cancelled', error = ?, terminal_digest = ?, terminal_at = ?
		       WHERE child_run_id = ? AND state IN ('queued', 'claimed') AND materialized_at IS NULL`,
		args: [reason, terminalDigest, now, run.child_run_id],
	});
	await terminalizeAgentSessionLifecycleTx(tx, run.child_session_id, "closed", run.child_run_id, now);
	await tx.execute({
		sql: "UPDATE agent_sessions SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE session_id = ?",
		args: [now, now, run.child_session_id],
	});
	await appendAgentSessionEventTx(tx, run.parent_session_id, {
		type: "child.run.cancelled",
		ts: now,
		payload: agentSessionChildRunResultPayload({
			run,
			admission,
			allocation,
			status: "cancelled",
			terminalPolicy: "close",
			materialization: null,
			result: null,
			error: reason,
			recovered: false,
		}),
	});
	await appendAgentSessionEventTx(tx, run.child_session_id, {
		type: "session.closed",
		ts: now,
		payload: {
			schema: "choreograph.agent-session-lifecycle.v1",
			sessionId: run.child_session_id,
			state: "closed",
			childRunId: run.child_run_id,
		},
	});
}

async function reopenRecoverableAgentSessionTx(tx: RuntimeTx, sessionId: string, now: number): Promise<void> {
	await tx.execute({
		sql: `UPDATE agent_sessions SET lifecycle_state = 'open', updated_at = ?
		      WHERE session_id = ? AND lifecycle_terminal_digest IS NULL
		        AND NOT EXISTS (
		          SELECT 1 FROM agent_session_admission_fences AS fence
		          JOIN agent_session_descendant_cascades AS cascade ON cascade.cascade_id = fence.cascade_id
		         WHERE fence.session_id = agent_sessions.session_id AND cascade.state = 'active'
		        )`,
		args: [now, sessionId],
	});
}

async function finalizeStandalonePrimeFaultIfReadyTx(
	tx: RuntimeTx,
	sessionId: string,
	generation: number,
	now: number,
): Promise<void> {
	const session = await readAgentSessionTx(tx, sessionId);
	if (!session || readAgentSessionSemanticBinding(session).runtime.kind !== "prime") return;
	const child = await tx.execute({
		sql: "SELECT 1 AS found FROM agent_session_child_admissions WHERE child_session_id = ?",
		args: [sessionId],
	});
	if (child.rows[0]) return;
	const latest = await tx.execute({
		sql: "SELECT * FROM agent_materializations WHERE session_id = ? ORDER BY generation DESC LIMIT 1",
		args: [sessionId],
	});
	if (!latest.rows[0]) return;
	const materialization = rowToAgentMaterialization(latest.rows[0]);
	if (materialization.generation !== generation || materialization.state !== "faulted") return;
	const terminalCascade = await tx.execute({
		sql: "SELECT cause, state FROM agent_session_descendant_cascades WHERE root_session_id = ?",
		args: [sessionId],
	});
	if (String(terminalCascade.rows[0]?.cause ?? "") === "explicit_cancel") {
		return;
	}
	const bodies = await tx.execute({
		sql: "SELECT role, state FROM agent_session_body_states WHERE session_id = ? AND generation = ?",
		args: [sessionId, generation],
	});
	if (bodies.rows.find((row) => row.role === "worker")?.state !== "faulted") return;
	const kernelState = bodies.rows.find((row) => row.role === "kernel")?.state;
	if (kernelState === undefined) {
		if (!(await hasExactUnboundKernelTerminalTx(tx, sessionId, generation))) return;
	} else if (!["faulted", "shutdown", "released"].includes(String(kernelState))) return;
	if (materialization.recoverable) {
		if (session.lifecycle_terminal_digest === null) {
			await reopenRecoverableAgentSessionTx(tx, sessionId, now);
		}
	} else if (session.lifecycle_state !== "faulted") {
		if (await hasOpenAgentSessionDescendantsTx(tx, sessionId)) return;
		const outcome = await tx.execute({
			sql: "SELECT 1 AS found FROM agent_session_run_outcomes WHERE session_id = ? LIMIT 1",
			args: [sessionId],
		});
		if (!outcome.rows[0]) {
			await tx.execute({
				sql: "UPDATE agent_sessions SET status = 'failed', completed_at = ?, updated_at = ? WHERE session_id = ?",
				args: [now, now, sessionId],
			});
		}
		await terminalizeAgentSessionLifecycleTx(
			tx,
			sessionId,
			"faulted",
			`materialization:${sessionId}:${String(generation)}`,
			now,
		);
		await appendAgentSessionEventTx(tx, sessionId, {
			type: "session.faulted",
			ts: now,
			payload: {
				schema: "choreograph.agent-session-lifecycle.v1",
				sessionId,
				state: "faulted",
				generation,
				faultKind: materialization.fault_kind,
				recoverable: false,
			},
		});
	}
	await completeAgentMaterializationRecoveryIfActiveTx(tx, sessionId, generation, now);
}

async function finalizeStandaloneCascadeCancellationIfReadyTx(
	tx: RuntimeTx,
	sessionId: string,
	generation: number,
	now: number,
): Promise<void> {
	const cascade = await tx.execute({
		sql: `SELECT cascade.* FROM agent_session_descendant_cascades AS cascade
		      JOIN agent_session_descendant_cascade_members AS member ON member.cascade_id = cascade.cascade_id
		      WHERE member.session_id = ? AND cascade.state = 'active'
		        AND (cascade.cause = 'explicit_cancel' OR member.depth > 0)
		      ORDER BY cascade.created_at ASC, cascade.cascade_id ASC LIMIT 1`,
		args: [sessionId],
	});
	if (!cascade.rows[0]) return;
	const session = await readAgentSessionTx(tx, sessionId);
	if (!session) return;
	if (session.lifecycle_state === "closed") {
		await completeAgentSessionDescendantCascadesIfReadyTx(tx, sessionId, now);
		return;
	}
	const admitted = await tx.execute({
		sql: "SELECT 1 AS found FROM agent_session_child_admissions WHERE child_session_id = ?",
		args: [sessionId],
	});
	if (admitted.rows[0]) return;
	const latest = await tx.execute({
		sql: "SELECT * FROM agent_materializations WHERE session_id = ? ORDER BY generation DESC LIMIT 1",
		args: [sessionId],
	});
	if (!latest.rows[0]) return;
	const materialization = rowToAgentMaterialization(latest.rows[0]);
	if (materialization.generation !== generation) return;
	if (!["passivated", "completed", "faulted", "cancelled"].includes(materialization.state)) return;
	const bodies = await tx.execute({
		sql: "SELECT role, state FROM agent_session_body_states WHERE session_id = ? AND generation = ?",
		args: [sessionId, generation],
	});
	if (bodies.rows.find((row) => row.role === "worker")?.state !== materialization.state) return;
	const runtimeKind = readAgentSessionSemanticBinding(session).runtime.kind;
	const kernelState = bodies.rows.find((row) => row.role === "kernel")?.state;
	if (runtimeKind === "simple") {
		if (kernelState !== undefined) return;
	} else {
		const allowed: Readonly<Record<"passivated" | "completed" | "faulted" | "cancelled", readonly string[]>> = {
			passivated: ["released", "shutdown"],
			completed: ["shutdown"],
			faulted: ["faulted", "released", "shutdown"],
			cancelled: ["cancelled", "shutdown"],
		};
		if (kernelState === undefined) {
			if (!(await hasExactUnboundKernelTerminalTx(tx, sessionId, generation))) return;
		} else if (!allowed[materialization.state as keyof typeof allowed].includes(String(kernelState))) return;
	}
	if (await hasOpenAgentSessionDescendantsTx(tx, sessionId)) return;
	const cascadeRecord = rowToAgentSessionDescendantCascade(cascade.rows[0]);
	const outcome = await tx.execute({
		sql: "SELECT 1 AS found FROM agent_session_run_outcomes WHERE session_id = ? LIMIT 1",
		args: [sessionId],
	});
	if (!outcome.rows[0]) {
		await tx.execute({
			sql: "UPDATE agent_sessions SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE session_id = ?",
			args: [now, now, sessionId],
		});
	}
	await terminalizeAgentSessionLifecycleTx(tx, sessionId, "closed", cascadeRecord.cascade_id, now, {
		allowFaultTombstone: true,
	});
	await appendAgentSessionEventTx(tx, sessionId, {
		type: "session.closed",
		ts: now,
		payload: {
			schema: "choreograph.agent-session-lifecycle.v1",
			sessionId,
			state: "closed",
			generation,
			cascadeId: cascadeRecord.cascade_id,
		},
	});
	await completeAgentMaterializationRecoveryIfActiveTx(tx, sessionId, generation, now);
}

async function ensureAgentSessionDescendantCascadeTx(
	tx: RuntimeTx,
	rootSessionId: string,
	input: {
		readonly cause: "explicit_cancel" | "irrecoverable_fault";
		readonly causeDigest: string;
		readonly reason: string;
		readonly now: number;
	},
): Promise<AgentSessionDescendantCascadeRecord> {
	const winner = await tx.execute({
		sql: "SELECT * FROM agent_session_descendant_cascades WHERE root_session_id = ?",
		args: [rootSessionId],
	});
	if (winner.rows[0]) return rowToAgentSessionDescendantCascade(winner.rows[0]);
	const cascadeId = `adc_${createHash("sha256")
		.update(canonicalJson({ rootSessionId, cause: input.cause, causeDigest: input.causeDigest }))
		.digest("hex")
		.slice(0, 32)}`;
	await tx.execute({
		sql: `INSERT INTO agent_session_descendant_cascades
		        (cascade_id, root_session_id, cause, cause_digest, reason, state, created_at)
		      VALUES (?, ?, ?, ?, ?, 'active', ?)`,
		args: [cascadeId, rootSessionId, input.cause, input.causeDigest, input.reason, input.now],
	});
	const members = await tx.execute({
		sql: `WITH RECURSIVE subtree(session_id, depth) AS (
		        SELECT ?, 0
		        UNION ALL
		        SELECT relation.child_session_id, subtree.depth + 1
		          FROM agent_session_relations AS relation
		          JOIN subtree ON relation.parent_session_id = subtree.session_id
		      )
		      SELECT subtree.session_id, subtree.depth, session.lifecycle_state,
		             run.child_run_id, run.state AS run_state
		        FROM subtree
		        JOIN agent_sessions AS session ON session.session_id = subtree.session_id
		   LEFT JOIN agent_session_child_runs AS run ON run.child_session_id = subtree.session_id
		       ORDER BY subtree.depth DESC, subtree.session_id ASC`,
		args: [rootSessionId],
	});
	const actor: AgentSessionChildCancellationActor = {
		kind: "session_cascade",
		rootSessionId,
		cascadeId,
		causeDigest: input.causeDigest,
	};
	const requestId = `cascade-${cascadeId.slice(4)}`;
	for (const row of members.rows) {
		const sessionId = String(row.session_id);
		const depth = Number(row.depth);
		const childRunId = nullableString(row.child_run_id);
		const lifecycleState = requiredAgentSessionLifecycleState(row.lifecycle_state, "cascade member Session state");
		const runState = nullableAgentSessionChildRunState(row.run_state, "cascade member run state");
		const action =
			depth === 0
				? "root"
				: lifecycleState === "closed" || !childRunId || !runState
					? "none"
					: isTerminalAgentSessionChildRunState(runState)
						? "close"
						: "cancel";
		await tx.execute({
			sql: `INSERT OR IGNORE INTO agent_session_admission_fences
			        (session_id, cascade_id, cause_digest, closed_at) VALUES (?, ?, ?, ?)`,
			args: [sessionId, cascadeId, input.causeDigest, input.now],
		});
		if (lifecycleState === "open") {
			await tx.execute({
				sql: "UPDATE agent_sessions SET lifecycle_state = 'closing', updated_at = ? WHERE session_id = ? AND lifecycle_state = 'open'",
				args: [input.now, sessionId],
			});
		}
		await tx.execute({
			sql: `INSERT INTO agent_session_descendant_cascade_members
			        (cascade_id, session_id, child_run_id, depth, action, created_at)
			      VALUES (?, ?, ?, ?, ?, ?)`,
			args: [cascadeId, sessionId, childRunId, depth, action, input.now],
		});
		if (!childRunId || !runState || action === "none" || action === "root") continue;
		if (await hasOpenAgentSessionDescendantsTx(tx, sessionId)) continue;
		const requestDigest = digestJson({
			schema: "choreograph.agent-session-child-cancellation.v1",
			childRunId,
			reason: input.reason,
			actor,
		});
		if (action === "cancel") {
			const prior = await readAgentSessionChildCancellationRequestTx(tx, childRunId, requestId);
			if (prior) continue;
			const run = await requireAgentSessionChildRunTx(tx, childRunId);
			const { disposition } = await decideAgentSessionChildCancellationTx(tx, run, input.reason, input.now);
			await insertAgentSessionChildCancellationRequestTx(tx, {
				cancellation_id: childCancellationId(childRunId, requestId),
				child_run_id: childRunId,
				request_id: requestId,
				request_digest: requestDigest,
				actor,
				reason: input.reason,
				disposition,
				observed_run_state: run.state,
				created_at: input.now,
			});
		} else {
			const prior = await tx.execute({
				sql: "SELECT 1 AS found FROM agent_session_child_closure_requests WHERE child_run_id = ?",
				args: [childRunId],
			});
			if (prior.rows[0]) continue;
			const closureId = childClosureId(childRunId, requestId);
			await tx.execute({
				sql: `INSERT INTO agent_session_child_closure_requests
				        (closure_id, child_run_id, request_id, request_digest, actor_json,
				         reason, disposition, created_at)
				      VALUES (?, ?, ?, ?, ?, ?, 'closure_pending', ?)`,
				args: [closureId, childRunId, requestId, requestDigest, JSON.stringify(actor), input.reason, input.now],
			});
			await tx.execute({
				sql: `INSERT INTO agent_session_child_closure_work
				        (closure_id, child_run_id, state, created_at, updated_at)
				      VALUES (?, ?, 'pending', ?, ?)`,
				args: [closureId, childRunId, input.now, input.now],
			});
			await tx.execute({
				sql: `UPDATE agent_sessions SET lifecycle_state = 'closing', updated_at = ?
				      WHERE session_id = ? AND lifecycle_terminal_digest IS NULL`,
				args: [input.now, sessionId],
			});
		}
	}
	await advanceAgentSessionDescendantCascadeTx(tx, cascadeId, input.now);
	await completeAgentSessionDescendantCascadesIfReadyTx(tx, rootSessionId, input.now);
	const created = await tx.execute({
		sql: "SELECT * FROM agent_session_descendant_cascades WHERE cascade_id = ?",
		args: [cascadeId],
	});
	return rowToAgentSessionDescendantCascade(created.rows[0]!);
}

async function advanceAgentSessionDescendantCascadeTx(tx: RuntimeTx, cascadeId: string, now: number): Promise<void> {
	const cascadeResult = await tx.execute({
		sql: "SELECT * FROM agent_session_descendant_cascades WHERE cascade_id = ?",
		args: [cascadeId],
	});
	if (!cascadeResult.rows[0]) throw new AgentSessionChildRunFault("run_not_found", "descendant cascade is missing");
	const cascade = rowToAgentSessionDescendantCascade(cascadeResult.rows[0]);
	if (cascade.state === "completed") return;
	const members = await tx.execute({
		sql: `SELECT member.session_id, member.depth, session.lifecycle_state,
		             run.child_run_id
		        FROM agent_session_descendant_cascade_members AS member
		        JOIN agent_sessions AS session ON session.session_id = member.session_id
		   LEFT JOIN agent_session_child_runs AS run ON run.child_session_id = member.session_id
		       WHERE member.cascade_id = ?
		       ORDER BY member.depth DESC, member.session_id ASC`,
		args: [cascadeId],
	});
	for (const row of members.rows) {
		const sessionId = String(row.session_id);
		const depth = Number(row.depth);
		if (String(row.lifecycle_state) === "closed") continue;
		if (await hasOpenAgentSessionDescendantsTx(tx, sessionId)) continue;
		const childRunId = nullableString(row.child_run_id);
		if (depth === 0 && cascade.cause === "irrecoverable_fault") continue;
		if (childRunId) {
			await installAgentSessionCascadeRunControlTx(
				tx,
				cascade,
				await requireAgentSessionChildRunTx(tx, childRunId),
				now,
			);
		} else {
			await finalizeNoBodyCascadeMemberIfReadyTx(tx, cascade, sessionId, now);
		}
	}
	if (!(await hasOpenAgentSessionDescendantsTx(tx, cascade.root_session_id))) {
		const latest = await tx.execute({
			sql: "SELECT generation FROM agent_materializations WHERE session_id = ? ORDER BY generation DESC LIMIT 1",
			args: [cascade.root_session_id],
		});
		if (latest.rows[0]) {
			const generation = Number(latest.rows[0].generation);
			await finalizeStandaloneSimpleSessionIfReadyTx(tx, cascade.root_session_id, generation, now);
			await finalizeTerminalResidentChildFaultIfReadyTx(tx, cascade.root_session_id, generation, now);
			await finalizeStandalonePrimeFaultIfReadyTx(tx, cascade.root_session_id, generation, now);
			await finalizeStandaloneCascadeCancellationIfReadyTx(tx, cascade.root_session_id, generation, now);
		}
	}
	await completeAgentSessionDescendantCascadesIfReadyTx(tx, cascade.root_session_id, now);
}

async function finalizeNoBodyCascadeMemberIfReadyTx(
	tx: RuntimeTx,
	cascade: AgentSessionDescendantCascadeRecord,
	sessionId: string,
	now: number,
): Promise<void> {
	if (await hasOpenAgentSessionDescendantsTx(tx, sessionId)) return;
	const materialization = await tx.execute({
		sql: "SELECT 1 AS found FROM agent_materializations WHERE session_id = ? LIMIT 1",
		args: [sessionId],
	});
	if (materialization.rows[0]) return;
	const admitted = await tx.execute({
		sql: "SELECT 1 AS found FROM agent_session_child_admissions WHERE child_session_id = ?",
		args: [sessionId],
	});
	if (admitted.rows[0]) return;
	const session = await readAgentSessionTx(tx, sessionId);
	if (!session || session.lifecycle_state === "closed") return;
	const outcome = await tx.execute({
		sql: "SELECT 1 AS found FROM agent_session_run_outcomes WHERE session_id = ? LIMIT 1",
		args: [sessionId],
	});
	if (!outcome.rows[0]) {
		await tx.execute({
			sql: "UPDATE agent_sessions SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE session_id = ?",
			args: [now, now, sessionId],
		});
	}
	await terminalizeAgentSessionLifecycleTx(tx, sessionId, "closed", cascade.cascade_id, now, {
		allowFaultTombstone: true,
	});
	await appendAgentSessionEventTx(tx, sessionId, {
		type: "session.closed",
		ts: now,
		payload: {
			schema: "choreograph.agent-session-lifecycle.v1",
			sessionId,
			state: "closed",
			cascadeId: cascade.cascade_id,
			body: "not_materialized",
		},
	});
}

async function advanceAgentSessionCascadesContainingMemberTx(
	tx: RuntimeTx,
	sessionId: string,
	now: number,
): Promise<void> {
	const cascades = await tx.execute({
		sql: `SELECT cascade.cascade_id
		        FROM agent_session_descendant_cascade_members AS member
		        JOIN agent_session_descendant_cascades AS cascade ON cascade.cascade_id = member.cascade_id
		       WHERE member.session_id = ? AND cascade.state = 'active'`,
		args: [sessionId],
	});
	for (const row of cascades.rows) {
		await advanceAgentSessionDescendantCascadeTx(tx, String(row.cascade_id), now);
	}
}

async function hasOpenAgentSessionDescendantsTx(tx: RuntimeTx, sessionId: string): Promise<boolean> {
	const result = await tx.execute({
		sql: `WITH RECURSIVE descendants(session_id) AS (
		        SELECT child_session_id FROM agent_session_relations WHERE parent_session_id = ?
		        UNION ALL
		        SELECT relation.child_session_id
		          FROM agent_session_relations AS relation
		          JOIN descendants ON relation.parent_session_id = descendants.session_id
		      )
		      SELECT 1 AS found FROM descendants
		      JOIN agent_sessions AS session ON session.session_id = descendants.session_id
		      WHERE session.lifecycle_state NOT IN ('closed') LIMIT 1`,
		args: [sessionId],
	});
	return result.rows[0] !== undefined;
}

async function requireClosedAgentSessionDescendantsTx(tx: RuntimeTx, sessionId: string): Promise<void> {
	if (await hasOpenAgentSessionDescendantsTx(tx, sessionId)) {
		throw new AgentSessionChildRunFault(
			"materialization_conflict",
			"Session cannot close before its durable descendant cascade completes bottom-up",
		);
	}
}

async function terminalizeAgentSessionLifecycleTx(
	tx: RuntimeTx,
	sessionId: string,
	state: "closed" | "faulted",
	referenceId: string,
	now: number,
	options: { readonly allowFaultTombstone?: boolean } = {},
): Promise<void> {
	const session = await readAgentSessionTx(tx, sessionId);
	if (!session) throw new Error(`Agent Session not found: ${sessionId}`);
	const digest = digestJson({
		schema: "choreograph.agent-session-lifecycle-terminal.v1",
		sessionId,
		state,
		referenceId,
	});
	await requireClosedAgentSessionDescendantsTx(tx, sessionId);
	const replay = await tx.execute({
		sql: "SELECT transition_digest, to_state FROM agent_session_lifecycle_transitions WHERE session_id = ? AND reference_id = ?",
		args: [sessionId, referenceId],
	});
	if (replay.rows[0]) {
		if (String(replay.rows[0].transition_digest) !== digest || String(replay.rows[0].to_state) !== state) {
			throw new AgentSessionChildRunFault(
				"terminal_conflict",
				`Agent Session ${sessionId} lifecycle transition replay changed testimony`,
			);
		}
		await advanceAgentSessionCascadesContainingMemberTx(tx, sessionId, now);
		await completeAgentSessionDescendantCascadesIfReadyTx(tx, sessionId, now);
		return;
	}
	if (session.lifecycle_state === state) {
		throw new AgentSessionChildRunFault(
			"terminal_conflict",
			`Agent Session ${sessionId} already reached ${state} under different terminal testimony`,
		);
	}
	if (session.lifecycle_state === "closed") {
		throw new AgentSessionChildRunFault("terminal_conflict", `Agent Session ${sessionId} is already closed`);
	}
	if (session.lifecycle_state === "faulted" && (state !== "closed" || !options.allowFaultTombstone)) {
		throw new AgentSessionChildRunFault(
			"terminal_conflict",
			`Agent Session ${sessionId} fault can only advance through explicit closure`,
		);
	}
	const ordinalResult = await tx.execute({
		sql: "SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM agent_session_lifecycle_transitions WHERE session_id = ?",
		args: [sessionId],
	});
	const ordinal = Number(ordinalResult.rows[0]?.ordinal ?? 0);
	await tx.execute({
		sql: `INSERT INTO agent_session_lifecycle_transitions
		        (session_id, ordinal, from_state, to_state, reference_id, transition_digest, created_at)
		      VALUES (?, ?, ?, ?, ?, ?, ?)`,
		args: [sessionId, ordinal, session.lifecycle_state, state, referenceId, digest, now],
	});
	await tx.execute({
		sql: `UPDATE agent_sessions
		         SET lifecycle_state = ?, lifecycle_terminal_digest = ?, updated_at = ?
		       WHERE session_id = ?`,
		args: [state, digest, now, sessionId],
	});
	await autoCancelTerminalAgentSessionSchedulesTx(tx, now, sessionId);
	await advanceAgentSessionCascadesContainingMemberTx(tx, sessionId, now);
	await completeAgentSessionDescendantCascadesIfReadyTx(tx, sessionId, now);
}

async function completeAgentSessionDescendantCascadesIfReadyTx(
	tx: RuntimeTx,
	rootSessionId: string,
	now: number,
): Promise<void> {
	await tx.execute({
		sql: `UPDATE agent_session_descendant_cascades
		         SET state = 'completed', completed_at = ?
		       WHERE root_session_id = ? AND state = 'active'
		         AND NOT EXISTS (
		           SELECT 1 FROM agent_session_descendant_cascade_members AS member
		           JOIN agent_sessions AS session ON session.session_id = member.session_id
		          WHERE member.cascade_id = agent_session_descendant_cascades.cascade_id
		            AND member.depth > 0 AND session.lifecycle_state <> 'closed'
		         )
		         AND EXISTS (
		           SELECT 1 FROM agent_sessions AS root
		            WHERE root.session_id = agent_session_descendant_cascades.root_session_id
			              AND ((agent_session_descendant_cascades.cause = 'explicit_cancel' AND root.lifecycle_state = 'closed')
			                OR (agent_session_descendant_cascades.cause = 'irrecoverable_fault'
			                    AND root.lifecycle_state IN ('closed', 'faulted')))
		         )`,
		args: [now, rootSessionId],
	});
}

async function finalizeStandaloneSimpleSessionIfReadyTx(
	tx: RuntimeTx,
	sessionId: string,
	generation: number,
	now: number,
): Promise<void> {
	const session = await readAgentSessionTx(tx, sessionId);
	if (!session || session.lifecycle_state === "closed" || session.lifecycle_state === "faulted") return;
	if (readAgentSessionSemanticBinding(session).runtime.kind !== "simple") return;
	const child = await tx.execute({
		sql: "SELECT 1 AS found FROM agent_session_child_admissions WHERE child_session_id = ?",
		args: [sessionId],
	});
	if (child.rows[0]) return;
	const outcome = await tx.execute({
		sql: "SELECT outcome_id FROM agent_session_run_outcomes WHERE session_id = ? ORDER BY created_at DESC, outcome_id DESC LIMIT 1",
		args: [sessionId],
	});
	const latest = await tx.execute({
		sql: "SELECT * FROM agent_materializations WHERE session_id = ? ORDER BY generation DESC LIMIT 1",
		args: [sessionId],
	});
	if (!latest.rows[0]) return;
	const materialization = rowToAgentMaterialization(latest.rows[0]);
	if (materialization.generation !== generation) return;
	if (!["completed", "faulted", "cancelled"].includes(materialization.state)) return;
	if (!outcome.rows[0] && materialization.state !== "faulted") return;
	const bodies = await tx.execute({
		sql: "SELECT role, state FROM agent_session_body_states WHERE session_id = ? AND generation = ?",
		args: [sessionId, generation],
	});
	if (bodies.rows.some((row) => row.role === "kernel")) {
		throw new AgentSessionChildRunFault(
			"materialization_conflict",
			"standalone simple Session cannot close with fabricated kernel testimony",
		);
	}
	if (bodies.rows.find((row) => row.role === "worker")?.state !== materialization.state) {
		throw new AgentSessionChildRunFault(
			"materialization_conflict",
			"standalone simple Session lacks exact terminal worker testimony",
		);
	}
	const cancellation = await tx.execute({
		sql: `SELECT cascade.cascade_id
		        FROM agent_session_descendant_cascade_members AS member
		        JOIN agent_session_descendant_cascades AS cascade ON cascade.cascade_id = member.cascade_id
		       WHERE member.session_id = ? AND cascade.state = 'active'
		         AND (cascade.cause = 'explicit_cancel' OR member.depth > 0)
		       ORDER BY cascade.created_at ASC, cascade.cascade_id ASC LIMIT 1`,
		args: [sessionId],
	});
	const cancellationCascadeId = nullableString(cancellation.rows[0]?.cascade_id);
	const lifecycleState =
		cancellationCascadeId === null &&
		materialization.state === "faulted" &&
		(!materialization.recoverable || !outcome.rows[0])
			? "faulted"
			: "closed";
	const outcomeId = outcome.rows[0] ? String(outcome.rows[0].outcome_id) : "body-fault-before-outcome";
	const referenceId = cancellationCascadeId ?? `standalone:${String(generation)}:${outcomeId}`;
	if (!outcome.rows[0] && (lifecycleState === "faulted" || cancellationCascadeId !== null)) {
		await tx.execute({
			sql: "UPDATE agent_sessions SET status = ?, completed_at = ?, updated_at = ? WHERE session_id = ?",
			args: [cancellationCascadeId === null ? "failed" : "cancelled", now, now, sessionId],
		});
	}
	await terminalizeAgentSessionLifecycleTx(tx, sessionId, lifecycleState, referenceId, now);
	await appendAgentSessionEventTx(tx, sessionId, {
		type: lifecycleState === "faulted" ? "session.faulted" : "session.closed",
		ts: now,
		payload: {
			schema: "choreograph.agent-session-lifecycle.v1",
			sessionId,
			state: lifecycleState,
			generation,
			outcomeId,
			...(materialization.state === "faulted"
				? { faultKind: materialization.fault_kind, recoverable: materialization.recoverable }
				: {}),
		},
	});
	await completeAgentMaterializationRecoveryIfActiveTx(tx, sessionId, generation, now);
}

async function finalizeTerminalResidentChildFaultIfReadyTx(
	tx: RuntimeTx,
	childSessionId: string,
	generation: number,
	now: number,
): Promise<void> {
	const runResult = await tx.execute({
		sql: "SELECT * FROM agent_session_child_runs WHERE child_session_id = ?",
		args: [childSessionId],
	});
	if (!runResult.rows[0]) return;
	const run = rowToAgentSessionChildRun(runResult.rows[0]);
	if (!isTerminalAgentSessionChildRunState(run.state)) return;
	const session = await requireChildSessionForRunTx(tx, run);
	if (session.lifecycle_state === "closed") return;
	const materialization = await readAgentMaterializationTx(tx, childSessionId, generation);
	if (!materialization || materialization.state !== "faulted") return;
	const latest = await tx.execute({
		sql: "SELECT MAX(generation) AS generation FROM agent_materializations WHERE session_id = ?",
		args: [childSessionId],
	});
	if (Number(latest.rows[0]?.generation) !== generation) return;
	const body = await tx.execute({
		sql: "SELECT role, state FROM agent_session_body_states WHERE session_id = ? AND generation = ?",
		args: [childSessionId, generation],
	});
	const workerState = body.rows.find((row) => row.role === "worker")?.state;
	const kernelState = body.rows.find((row) => row.role === "kernel")?.state;
	if (workerState !== "faulted") return;
	if (kernelState === undefined) {
		if (!(await hasExactUnboundKernelTerminalTx(tx, childSessionId, generation))) return;
	} else if (!["faulted", "shutdown", "released"].includes(String(kernelState))) return;
	const occupied = await tx.execute({
		sql: `SELECT 1 AS found FROM agent_session_child_generation_occupancy
		      WHERE child_session_id = ? AND state = 'occupied' LIMIT 1`,
		args: [childSessionId],
	});
	if (occupied.rows[0]) return;
	await requireReleasedChildRunOccupancyTx(tx, run, materialization);
	if (materialization.recoverable) {
		await completeAgentMaterializationRecoveryIfActiveTx(tx, childSessionId, generation, now);
		return;
	}
	if (await hasOpenAgentSessionDescendantsTx(tx, run.child_session_id)) return;
	const admission = await requireChildAdmissionForRunTx(tx, run);
	const allocation = await requireChildAllocationForRunTx(tx, run.child_run_id);
	await closeExecutedChildAllocationTx(tx, admission, allocation, now);
	const lifecycleState = agentMaterializationFaultRequiresSessionFault(materialization.fault_kind)
		? "faulted"
		: "closed";
	if (session.lifecycle_state === lifecycleState) {
		await completeAgentMaterializationRecoveryIfActiveTx(tx, childSessionId, generation, now);
		return;
	}
	await terminalizeAgentSessionLifecycleTx(
		tx,
		childSessionId,
		lifecycleState,
		`resident-fault:${String(generation)}`,
		now,
	);
	await appendAgentSessionEventTx(tx, childSessionId, {
		type: lifecycleState === "faulted" ? "session.faulted" : "session.closed",
		ts: now,
		payload: {
			schema: "choreograph.agent-session-lifecycle.v1",
			sessionId: childSessionId,
			state: lifecycleState,
			generation,
			faultKind: materialization.fault_kind,
			recoverable: false,
		},
	});
	await completeAgentMaterializationRecoveryIfActiveTx(tx, childSessionId, generation, now);
}

function agentMaterializationFaultRequiresSessionFault(faultKind: AgentMaterializationFaultKind | null): boolean {
	return faultKind === "replay_divergence" || faultKind === "host_invariant";
}

async function completeAgentMaterializationRecoveryIfActiveTx(
	tx: RuntimeTx,
	sessionId: string,
	generation: number,
	now: number,
): Promise<void> {
	const recovery = await tx.execute({
		sql: `SELECT 1 AS found FROM agent_materialization_supervision
		      WHERE session_id = ? AND generation = ? AND recovery_token IS NOT NULL AND recovered_at IS NULL`,
		args: [sessionId, generation],
	});
	if (recovery.rows[0]) await completeAgentMaterializationRecoveryTx(tx, sessionId, generation, now);
}

async function readAgentSessionChildCancellationRequestTx(
	tx: RuntimeTx,
	childRunId: string,
	requestId: string,
): Promise<AgentSessionChildCancellationRequestRecord | null> {
	const result = await tx.execute({
		sql: `SELECT * FROM agent_session_child_cancellation_requests
		      WHERE child_run_id = ? AND request_id = ?`,
		args: [childRunId, requestId],
	});
	return result.rows[0] ? rowToAgentSessionChildCancellationRequest(result.rows[0]) : null;
}

async function insertAgentSessionChildCancellationRequestTx(
	tx: RuntimeTx,
	request: AgentSessionChildCancellationRequestRecord,
): Promise<void> {
	await tx.execute({
		sql: `INSERT INTO agent_session_child_cancellation_requests
		        (cancellation_id, child_run_id, request_id, request_digest, actor_json,
		         reason, disposition, observed_run_state, created_at)
		      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		args: [
			request.cancellation_id,
			request.child_run_id,
			request.request_id,
			request.request_digest,
			JSON.stringify(request.actor),
			request.reason,
			request.disposition,
			request.observed_run_state,
			request.created_at,
		],
	});
}

async function occupyAgentSessionChildGenerationTx(
	tx: RuntimeTx,
	childSessionId: string,
	generation: number,
	now: number,
): Promise<AgentSessionChildGenerationOccupancyRecord | null> {
	const relationResult = await tx.execute({
		sql: "SELECT * FROM agent_session_relations WHERE child_session_id = ?",
		args: [childSessionId],
	});
	if (!relationResult.rows[0]) return null;
	const relation = rowToAgentSessionChildRelation(relationResult.rows[0]);
	const admissionResult = await tx.execute({
		sql: "SELECT 1 AS found FROM agent_session_child_admissions WHERE child_session_id = ?",
		args: [childSessionId],
	});
	if (!admissionResult.rows[0]) return null;
	const existingResult = await tx.execute({
		sql: `SELECT * FROM agent_session_child_generation_occupancy
		      WHERE child_session_id = ? AND generation = ?`,
		args: [childSessionId, generation],
	});
	if (existingResult.rows[0]) {
		const existing = rowToAgentSessionChildGenerationOccupancy(existingResult.rows[0]);
		if (existing.state !== "occupied") {
			throw new AgentSessionGenerationFault(`Child generation ${generation} occupancy was already released`);
		}
		return existing;
	}
	const later = await tx.execute({
		sql: `SELECT generation FROM agent_session_child_generation_occupancy
		      WHERE child_session_id = ? AND generation > ? ORDER BY generation ASC LIMIT 1`,
		args: [childSessionId, generation],
	});
	if (later.rows[0]) throw new AgentSessionGenerationFault("A later child generation already owns capacity");
	const parent = await readAgentSessionTx(tx, relation.parent_session_id);
	if (!parent) throw new AgentSessionGenerationFault("Child occupancy has no durable parent Session");
	const parentSemantic = readAgentSessionSemanticBinding(parent);
	const occupied = await tx.execute({
		sql: `SELECT COUNT(*) AS count FROM agent_session_child_generation_occupancy
		      WHERE parent_session_id = ? AND state = 'occupied'`,
		args: [relation.parent_session_id],
	});
	if (Number(occupied.rows[0]?.count ?? 0) >= parentSemantic.runtime.constraints.maxConcurrentChildren) {
		throw new AgentSessionGenerationFault("Parent maxConcurrentChildren capacity is exhausted");
	}
	await tx.execute({
		sql: `INSERT INTO agent_session_child_generation_occupancy
		        (parent_session_id, child_session_id, generation, state, acquired_at)
		      VALUES (?, ?, ?, 'occupied', ?)`,
		args: [relation.parent_session_id, childSessionId, generation, now],
	});
	return {
		parent_session_id: relation.parent_session_id,
		child_session_id: childSessionId,
		generation,
		state: "occupied",
		acquired_at: now,
		released_at: null,
	};
}

async function releaseAgentSessionChildGenerationOccupancyTx(
	tx: RuntimeTx,
	childSessionId: string,
	generation: number,
	now: number,
): Promise<AgentSessionChildGenerationOccupancyRecord | null> {
	const admissionResult = await tx.execute({
		sql: "SELECT 1 AS found FROM agent_session_child_admissions WHERE child_session_id = ?",
		args: [childSessionId],
	});
	if (!admissionResult.rows[0]) return null;
	const result = await tx.execute({
		sql: `SELECT * FROM agent_session_child_generation_occupancy
		      WHERE child_session_id = ? AND generation = ?`,
		args: [childSessionId, generation],
	});
	if (!result.rows[0]) {
		throw new AgentSessionGenerationFault("Hosted child generation has no durable occupancy record");
	}
	const existing = rowToAgentSessionChildGenerationOccupancy(result.rows[0]);
	if (existing.state === "released") return existing;
	await tx.execute({
		sql: `UPDATE agent_session_child_generation_occupancy
		         SET state = 'released', released_at = ?
		       WHERE child_session_id = ? AND generation = ? AND state = 'occupied'`,
		args: [now, childSessionId, generation],
	});
	return { ...existing, state: "released", released_at: now };
}

async function closeExecutedChildAllocationTx(
	tx: RuntimeTx,
	admission: AgentSessionChildAdmissionRecord,
	allocation: AgentSessionChildBudgetAllocationRecord,
	now: number,
): Promise<AgentSessionChildBudgetAllocationRecord> {
	if (allocation.allocation_id !== admission.budget_allocation_id) {
		throw new AgentSessionChildRunFault("accounting_blocked", "child allocation does not match its admission");
	}
	if (allocation.state === "settled") return allocation;
	if (allocation.state !== "reserved") {
		if (allocation.state !== "accounting_hold") {
			throw new AgentSessionBudgetFault("reservation_state_conflict", "executed child allocation was released");
		}
	}
	const childAccount = await requireAgentSessionBudgetAccountTx(
		tx,
		admission.child_session_id,
		budgetVectorFromChildSlice(allocation.budget),
	);
	if (AGENT_SESSION_BUDGET_DIMENSIONS.some((dimension) => childAccount.reserved[dimension] !== 0)) {
		if (allocation.state === "reserved") {
			await tx.execute({
				sql: `UPDATE agent_session_child_budget_allocations
				         SET state = 'accounting_hold', hold_reason = 'unresolved_child_reservations', held_at = ?
				       WHERE allocation_id = ? AND state = 'reserved'`,
				args: [now, allocation.allocation_id],
			});
		}
		return {
			...allocation,
			state: "accounting_hold",
			hold_reason: "unresolved_child_reservations",
			held_at: allocation.held_at ?? now,
		};
	}
	const before = await requireAgentSessionBudgetAccountTx(tx, admission.parent_session_id);
	await applyAgentSessionBudgetLedgerEntryTx(tx, {
		sessionId: admission.parent_session_id,
		kind: "child_settled",
		referenceId: admission.budget_allocation_id,
		reservedDelta: negateAgentSessionBudget(budgetVectorFromChildSlice(allocation.budget)),
		spentDelta: childAccount.spent,
		detail: {
			schema: "choreograph.agent-session-budget-child-settled.v1",
			allocationId: admission.budget_allocation_id,
			childSessionId: admission.child_session_id,
			usage: childAccount.spent,
		},
		now,
		allowExhaustion: true,
	});
	await tx.execute({
		sql: `UPDATE agent_session_child_budget_allocations
		         SET state = 'settled', hold_reason = NULL, settled_at = ?
		       WHERE allocation_id = ? AND state IN ('reserved', 'accounting_hold')`,
		args: [now, admission.budget_allocation_id],
	});
	const account = await requireAgentSessionBudgetAccountTx(tx, admission.parent_session_id);
	if (!before.exhausted && account.exhausted) {
		await appendAgentSessionEventTx(tx, admission.parent_session_id, {
			type: "budget.exhausted",
			ts: now,
			payload: {
				schema: "choreograph.agent-session-budget-exhausted.v1",
				allocationId: admission.budget_allocation_id,
				dimensions: exhaustedAgentSessionBudgetDimensions(account),
			},
		});
	}
	return {
		...allocation,
		state: "settled",
		hold_reason: null,
		settled_at: now,
	};
}

function validateChildAdmissionRequest(input: AdmitAgentSessionChildInput): AdmitAgentSessionChildInput {
	if (!input || typeof input !== "object") {
		throw new AgentSessionChildAdmissionFault("request_invalid", "child request must be an object");
	}
	const unknownFields = Object.keys(input).filter((field) => !CHILD_ADMISSION_REQUEST_FIELDS.has(field));
	if (unknownFields.length > 0) {
		throw new AgentSessionChildAdmissionFault(
			"request_invalid",
			`child request contains unsupported fields: ${unknownFields.join(", ")}`,
		);
	}
	if (typeof input.requestId !== "string" || !CHILD_REQUEST_ID_PATTERN.test(input.requestId)) {
		throw new AgentSessionChildAdmissionFault(
			"request_invalid",
			"requestId must be a 1-128 character bounded identifier",
		);
	}
	if (typeof input.causationId !== "string" || !CHILD_REQUEST_ID_PATTERN.test(input.causationId)) {
		throw new AgentSessionChildAdmissionFault(
			"request_invalid",
			"causationId must be a 1-128 character bounded identifier",
		);
	}
	if (!Number.isSafeInteger(input.parentGeneration) || input.parentGeneration < 0) {
		throw new AgentSessionChildAdmissionFault(
			"request_invalid",
			"parentGeneration must be a non-negative safe integer",
		);
	}
	if (typeof input.parentActivationId !== "string" || !CHILD_REQUEST_ID_PATTERN.test(input.parentActivationId)) {
		throw new AgentSessionChildAdmissionFault(
			"request_invalid",
			"parentActivationId must be a bounded materialization identifier",
		);
	}
	if (typeof input.parentSandboxId !== "string" || !CHILD_REQUEST_ID_PATTERN.test(input.parentSandboxId)) {
		throw new AgentSessionChildAdmissionFault(
			"request_invalid",
			"parentSandboxId must be a bounded sandbox identifier",
		);
	}
	if (
		typeof input.prompt !== "string" ||
		!input.prompt.trim() ||
		Buffer.byteLength(input.prompt, "utf8") > CHILD_PROMPT_MAX_BYTES
	) {
		throw new AgentSessionChildAdmissionFault(
			"request_invalid",
			`prompt must be non-empty and no larger than ${CHILD_PROMPT_MAX_BYTES} UTF-8 bytes`,
		);
	}
	if (
		input.requestedName !== undefined &&
		(typeof input.requestedName !== "string" || !CHILD_NAME_PATTERN.test(input.requestedName))
	) {
		throw new AgentSessionChildAdmissionFault(
			"request_invalid",
			"requestedName must be 1-64 characters from [A-Za-z0-9_-]",
		);
	}
	if (
		input.requestedModel !== undefined &&
		(typeof input.requestedModel !== "string" || !CHILD_MODEL_ID_PATTERN.test(input.requestedModel))
	) {
		throw new AgentSessionChildAdmissionFault(
			"request_invalid",
			"requestedModel must be a 1-256 character bounded model identifier",
		);
	}
	if (!Number.isSafeInteger(input.now) || input.now < 0) {
		throw new AgentSessionChildAdmissionFault("request_invalid", "now must be a non-negative epoch millisecond");
	}
	return {
		requestId: input.requestId,
		parentGeneration: input.parentGeneration,
		parentActivationId: input.parentActivationId,
		parentSandboxId: input.parentSandboxId,
		prompt: input.prompt,
		...(input.requestedName === undefined ? {} : { requestedName: input.requestedName }),
		...(input.requestedModel === undefined ? {} : { requestedModel: input.requestedModel }),
		causationId: input.causationId,
		now: input.now,
	};
}

function validateChildRunClaimInput(input: ClaimAgentSessionChildRunInput): ClaimAgentSessionChildRunInput {
	if (!input || typeof input !== "object") {
		throw new AgentSessionChildRunFault("not_claimable", "child run claim must be an object");
	}
	const consumer = requiredChildRunText(input.consumer, "child run consumer", 256);
	validateChildRunTimestamp(input.now, "child run claim time");
	validatePositiveChildRunInteger(input.leaseMs, "child run lease duration");
	checkedBudgetSum(input.now, input.leaseMs);
	return { consumer, leaseMs: input.leaseMs, now: input.now };
}

function validateChildRunLeaseInput(input: RenewAgentSessionChildRunLeaseInput): RenewAgentSessionChildRunLeaseInput {
	if (!input || typeof input !== "object") {
		throw new AgentSessionChildRunFault("lease_lost", "child run lease renewal must be an object");
	}
	const consumer = requiredChildRunText(input.consumer, "child run consumer", 256);
	const claimToken = requiredChildRunText(input.claimToken, "child run claim token", 256);
	validateChildRunTimestamp(input.now, "child run lease renewal time");
	validatePositiveChildRunInteger(input.leaseMs, "child run lease duration");
	checkedBudgetSum(input.now, input.leaseMs);
	return { consumer, claimToken, leaseMs: input.leaseMs, now: input.now };
}

function validateChildRunMaterializationInput(
	input: ClaimAgentSessionChildMaterializationInput,
): ClaimAgentSessionChildMaterializationInput {
	if (!input || typeof input !== "object") {
		throw new AgentSessionChildRunFault("materialization_conflict", "child materialization fence must be an object");
	}
	const consumer = requiredChildRunText(input.consumer, "child run consumer", 256);
	const claimToken = requiredChildRunText(input.claimToken, "child run claim token", 256);
	const activationId = requiredChildRunText(input.activationId, "child activation id", 256);
	validateChildRunTimestamp(input.now, "child materialization claim time");
	if (input.generation !== 0) {
		throw new AgentSessionChildRunFault(
			"materialization_conflict",
			"the admitted child run owns exactly generation zero",
		);
	}
	return { consumer, claimToken, generation: input.generation, activationId, now: input.now };
}

function validateChildRunSettlementInput(
	childRunId: string,
	input: SettleAgentSessionChildRunInput,
): SettleAgentSessionChildRunInput & {
	readonly resultJson: string | null;
	readonly terminalDigest: string;
	readonly error: string | null;
} {
	if (!input || typeof input !== "object") {
		throw new AgentSessionChildRunFault("terminal_conflict", "child run settlement must be an object");
	}
	const consumer = requiredChildRunText(input.consumer, "child run consumer", 256);
	const claimToken = requiredChildRunText(input.claimToken, "child run claim token", 256);
	if (!["completed", "failed", "cancelled"].includes(input.status)) {
		throw new AgentSessionChildRunFault("terminal_conflict", "child run terminal status is invalid");
	}
	if (input.terminalPolicy !== "keep_open" && input.terminalPolicy !== "close") {
		throw new AgentSessionChildRunFault("terminal_conflict", "child run terminal policy is invalid");
	}
	if (!Number.isSafeInteger(input.materializationGeneration) || input.materializationGeneration < 0) {
		throw new AgentSessionChildRunFault("materialization_conflict", "child materialization generation is invalid");
	}
	if (!isAgentMaterializationState(input.materializationState)) {
		throw new AgentSessionChildRunFault("materialization_conflict", "child materialization state is invalid");
	}
	validateChildRunTimestamp(input.now, "child run settlement time");
	const error =
		input.error === undefined
			? input.status === "failed"
				? "child execution failed"
				: input.status === "cancelled"
					? "child execution cancelled"
					: null
			: requiredChildRunText(input.error, "child run terminal error", 2048);
	const result = input.result ?? null;
	let resultJson: string | null;
	try {
		resultJson = input.result === undefined ? null : JSON.stringify(input.result);
		canonicalJson(result);
	} catch (cause) {
		throw new AgentSessionChildRunFault("terminal_conflict", "child run result must be canonical JSON", cause);
	}
	const terminalDigest = digestChildRunTerminal({
		childRunId,
		status: input.status,
		terminalPolicy: input.terminalPolicy,
		materializationGeneration: input.materializationGeneration,
		materializationState: input.materializationState,
		result,
		error,
	});
	return { ...input, consumer, claimToken, resultJson, terminalDigest, error };
}

function validateChildCancellationInput(
	childRunId: string,
	input: RequestAgentSessionChildCancellationInput,
): RequestAgentSessionChildCancellationInput & { readonly requestDigest: string } {
	if (!input || typeof input !== "object") {
		throw new AgentSessionChildRunFault("cancellation_conflict", "child cancellation must be an object");
	}
	const requestId = requiredChildRunText(input.requestId, "child cancellation request id", 128);
	const reason = requiredChildRunText(input.reason, "child cancellation reason", 2048);
	validateChildRunTimestamp(input.now, "child cancellation time");
	const actor = input.actor;
	if (!actor || typeof actor !== "object") {
		throw new AgentSessionChildRunFault("authority_invalid", "child cancellation actor is invalid");
	}
	let normalizedActor: AgentSessionChildCancellationActor;
	if (actor.kind === "parent_materialization") {
		if (!Number.isSafeInteger(actor.generation) || actor.generation < 0) {
			throw new AgentSessionChildRunFault("authority_invalid", "child cancellation generation is invalid");
		}
		normalizedActor = {
			kind: "parent_materialization",
			parentSessionId: requiredChildRunText(actor.parentSessionId, "cancellation parent Session", 256),
			generation: actor.generation,
			activationId: requiredChildRunText(actor.activationId, "cancellation parent activation", 256),
			sandboxId: requiredChildRunText(actor.sandboxId, "cancellation parent sandbox", 256),
		};
	} else if (actor.kind === "session_cascade") {
		normalizedActor = {
			kind: "session_cascade",
			rootSessionId: requiredChildRunText(actor.rootSessionId, "cascade root Session", 256),
			cascadeId: requiredChildRunText(actor.cascadeId, "cascade id", 128),
			causeDigest: requiredChildRunText(actor.causeDigest, "cascade cause digest", 256),
		};
	} else {
		throw new AgentSessionChildRunFault("authority_invalid", "child cancellation actor kind is invalid");
	}
	const requestDigest = digestJson({
		schema: "choreograph.agent-session-child-cancellation.v1",
		childRunId,
		reason,
		actor: normalizedActor,
	});
	return { requestId, actor: normalizedActor, reason, now: input.now, requestDigest };
}

function digestChildRunTerminal(input: {
	readonly childRunId: string;
	readonly status: "completed" | "failed" | "cancelled";
	readonly terminalPolicy: "keep_open" | "close";
	readonly materializationGeneration: number | null;
	readonly materializationState: AgentMaterializationState | "not_materialized";
	readonly result: unknown;
	readonly error: string | null;
}): string {
	return digestJson({ schema: "choreograph.agent-session-child-run-terminal.v1", ...input });
}

function agentSessionChildRunResultPayload(input: {
	readonly run: AgentSessionChildRunRecord;
	readonly admission: AgentSessionChildAdmissionRecord;
	readonly allocation: AgentSessionChildBudgetAllocationRecord;
	readonly status: "completed" | "failed" | "cancelled";
	readonly terminalPolicy: "keep_open" | "close";
	readonly materialization: { readonly generation: number; readonly state: AgentMaterializationState } | null;
	readonly result: unknown;
	readonly error: string | null;
	readonly recovered: boolean;
}): Record<string, unknown> {
	return {
		schema: "choreograph.agent-session-child-run-result.v1",
		childRunId: input.run.child_run_id,
		admissionId: input.run.admission_id,
		parentSessionId: input.run.parent_session_id,
		childSessionId: input.run.child_session_id,
		childName: input.admission.child_name,
		status: input.status,
		terminalPolicy: input.terminalPolicy,
		budgetAllocationId: input.allocation.allocation_id,
		materialization: input.materialization,
		result: input.result,
		error: input.error,
		recovered: input.recovered,
	};
}

function childCancellationId(childRunId: string, requestId: string): string {
	return `acc_${createHash("sha256")
		.update(canonicalJson({ kind: "child_cancellation", childRunId, requestId }))
		.digest("hex")}`;
}

function childClosureId(childRunId: string, requestId: string): string {
	return `acl_${createHash("sha256")
		.update(canonicalJson({ kind: "child_closure", childRunId, requestId }))
		.digest("hex")}`;
}

function requiredChildRunText(value: unknown, label: string, maxBytes: number): string {
	if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maxBytes) {
		throw new AgentSessionChildRunFault("terminal_conflict", `${label} must be non-empty and bounded`);
	}
	return value;
}

function requireTypedGraphOwnerPrincipal(value: unknown): string {
	return requireCanonicalGraphOwnerPrincipal(value, "durable graph owner principal");
}

function requireCanonicalAgentSessionChildRunId(value: unknown): string {
	if (typeof value !== "string" || !/^acr_[0-9a-f]{24}$/.test(value)) {
		throw new AgentSessionChildRunFault(
			"authority_invalid",
			"child control target must be an exact canonical child run id",
		);
	}
	return value;
}

function validateChildRunTimestamp(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new AgentSessionChildRunFault("terminal_conflict", `${label} must be a non-negative safe integer`);
	}
}

function validatePositiveChildRunInteger(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new AgentSessionChildRunFault("terminal_conflict", `${label} must be a positive safe integer`);
	}
}

function validateChildRunRecoveryLimit(value: number | undefined): number {
	const limit = value ?? 100;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
		throw new AgentSessionChildRunFault("not_claimable", "child recovery limit must be between 1 and 1000");
	}
	return limit;
}

function childAdmissionRequestDigest(input: AdmitAgentSessionChildInput): string {
	return `sha256:${createHash("sha256")
		.update(
			canonicalJson({
				parentGeneration: input.parentGeneration,
				parentActivationId: input.parentActivationId,
				parentSandboxId: input.parentSandboxId,
				prompt: input.prompt,
				requestedName: input.requestedName ?? null,
				requestedModel: input.requestedModel ?? null,
				causationId: input.causationId,
			}),
		)
		.digest("hex")}`;
}

export function stableAgentSessionChildId(parentSessionId: string, requestId: string): string {
	const digest = createHash("sha256")
		.update(canonicalJson({ kind: "agent_session_child", parentSessionId, requestId }))
		.digest("hex")
		.slice(0, 24);
	return `ags_${digest}`;
}

export function stableAgentSessionChildRunId(parentSessionId: string, requestId: string): string {
	const digest = createHash("sha256")
		.update(canonicalJson({ kind: "agent_session_child_run", parentSessionId, requestId }))
		.digest("hex")
		.slice(0, 24);
	return `acr_${digest}`;
}

function stableAgentSessionChildName(parentSessionId: string, requestId: string): string {
	const digest = createHash("sha256")
		.update(canonicalJson({ kind: "agent_session_child_name", parentSessionId, requestId }))
		.digest("hex")
		.slice(0, 12);
	return `child-${digest}`;
}

function childAdmissionId(parentSessionId: string, requestId: string): string {
	const digest = createHash("sha256")
		.update(canonicalJson({ kind: "agent_session_child_admission", parentSessionId, requestId }))
		.digest("hex");
	return `asa_${digest}`;
}

function childBudgetAllocationId(admissionId: string): string {
	return `asb_${createHash("sha256")
		.update(canonicalJson({ kind: "child_budget", admissionId }))
		.digest("hex")}`;
}

async function denyChildSpawnRequestTx(
	tx: RuntimeTx,
	parentSessionId: string,
	request: AdmitAgentSessionChildInput,
	requestDigest: string,
	denialCode: string,
	denialMessage: string,
): Promise<DeniedAgentSessionChildResult> {
	const decision: AgentSessionChildSpawnRequestRecord = {
		parent_session_id: parentSessionId,
		request_id: request.requestId,
		request_digest: requestDigest,
		decision: "denied",
		admission_id: null,
		child_session_id: null,
		child_run_id: null,
		denial_code: denialCode,
		denial_message: denialMessage,
		created_at: request.now,
	};
	await insertChildSpawnRequestTx(tx, decision);
	await appendAgentSessionEventTx(tx, parentSessionId, {
		type: "child.spawn_requested",
		ts: request.now,
		payload: {
			schema: "choreograph.agent-session-child-spawn-requested.v1",
			requestId: request.requestId,
			causationId: request.causationId,
			decision: "denied",
			denial: { code: denialCode, message: denialMessage },
		},
	});
	return { decision: "denied", request: decision, created: true };
}

async function insertChildSpawnRequestTx(tx: RuntimeTx, request: AgentSessionChildSpawnRequestRecord): Promise<void> {
	await tx.execute({
		sql: `
			INSERT INTO agent_session_child_spawn_requests
				(parent_session_id, request_id, request_digest, decision, admission_id,
				 child_session_id, child_run_id, denial_code, denial_message, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
		args: [
			request.parent_session_id,
			request.request_id,
			request.request_digest,
			request.decision,
			request.admission_id,
			request.child_session_id,
			request.child_run_id,
			request.denial_code,
			request.denial_message,
			request.created_at,
		],
	});
}

async function insertAgentSessionChildRunTx(tx: RuntimeTx, run: AgentSessionChildRunRecord): Promise<void> {
	await tx.execute({
		sql: `
			INSERT INTO agent_session_child_runs
				(child_run_id, admission_id, parent_session_id, child_session_id, state,
				 attempt, consumer, claim_token, claimed_at, claim_expires_at, heartbeat_at,
				 materialization_generation, materialized_at, result_json, error, terminal_digest,
				 created_at, terminal_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
		args: [
			run.child_run_id,
			run.admission_id,
			run.parent_session_id,
			run.child_session_id,
			run.state,
			run.attempt,
			run.consumer,
			run.claim_token,
			run.claimed_at,
			run.claim_expires_at,
			run.heartbeat_at,
			run.materialization_generation,
			run.materialized_at,
			run.result === null || run.result === undefined ? null : JSON.stringify(run.result),
			run.error,
			run.terminal_digest,
			run.created_at,
			run.terminal_at,
		],
	});
}

async function requireBoundKernelBodyTx(
	tx: RuntimeTx,
	sessionId: string,
	generation: number,
	activationId: string,
): Promise<void> {
	const authority = await tx.execute({
		sql: `SELECT launch.state AS launch_state, body.state AS body_state
		        FROM agent_session_kernel_launches AS launch
		   LEFT JOIN agent_session_body_states AS body
		          ON body.session_id = launch.session_id AND body.generation = launch.generation
		         AND body.role = 'kernel'
		       WHERE launch.session_id = ? AND launch.generation = ? AND launch.activation_id = ?`,
		args: [sessionId, generation, activationId],
	});
	if (String(authority.rows[0]?.launch_state ?? "") !== "bound" || authority.rows[0]?.body_state == null) {
		throw new AgentSessionGenerationFault(
			"Kernel testimony requires an exact observed-spawn bind and an existing body row",
		);
	}
}

async function upsertAgentSessionBodyStateTx(
	tx: RuntimeTx,
	input: {
		readonly sessionId: string;
		readonly generation: number;
		readonly role: AgentSessionBodyRole;
		readonly state: string;
		readonly now: number;
	},
): Promise<AgentSessionBodyStateRecord> {
	if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
		throw new AgentSessionGenerationFault("Body generation must be a non-negative integer");
	}
	if (!Number.isSafeInteger(input.now) || input.now < 0) {
		throw new AgentSessionGenerationFault("Body testimony time must be a non-negative integer");
	}
	if (
		(input.role === "worker" && !isAgentWorkerBodyState(input.state)) ||
		(input.role === "kernel" && !isAgentSessionKernelState(input.state))
	) {
		throw new AgentSessionGenerationFault(`Unsupported ${input.role} body state: ${input.state}`);
	}
	const existingResult = await tx.execute({
		sql: `SELECT * FROM agent_session_body_states
		      WHERE session_id = ? AND generation = ? AND role = ?`,
		args: [input.sessionId, input.generation, input.role],
	});
	const existing = existingResult.rows[0] ? rowToAgentSessionBodyState(existingResult.rows[0]) : null;
	if (existing) {
		if (input.now < existing.updated_at) {
			throw new AgentSessionGenerationFault(`${input.role} body testimony cannot move backward in time`);
		}
		if (input.now === existing.updated_at && input.state === existing.state) return existing;
		if (input.state === existing.state) return existing;
		if (!isLegalAgentSessionBodyTransition(input.role, existing.state, input.state)) {
			throw new AgentSessionGenerationFault(
				`${input.role} body testimony cannot transition from ${existing.state} to ${input.state}`,
			);
		}
		await tx.execute({
			sql: `UPDATE agent_session_body_states SET state = ?, updated_at = ?
			      WHERE session_id = ? AND generation = ? AND role = ?`,
			args: [input.state, input.now, input.sessionId, input.generation, input.role],
		});
	} else {
		await tx.execute({
			sql: `INSERT INTO agent_session_body_states (session_id, generation, role, state, updated_at)
			      VALUES (?, ?, ?, ?, ?)`,
			args: [input.sessionId, input.generation, input.role, input.state, input.now],
		});
	}
	return {
		session_id: input.sessionId,
		generation: input.generation,
		role: input.role,
		state: input.state,
		updated_at: input.now,
	};
}

async function loadAcceptedChildAdmissionTx(
	tx: RuntimeTx,
	request: AgentSessionChildSpawnRequestRecord,
	created: boolean,
): Promise<AcceptedAgentSessionChildResult> {
	if (request.decision !== "accepted" || !request.admission_id || !request.child_session_id || !request.child_run_id) {
		throw new Error("cannot load an accepted child from a denied spawn decision");
	}
	const [admissionResult, relationResult, allocationResult, runResult] = await Promise.all([
		tx.execute({
			sql: "SELECT * FROM agent_session_child_admissions WHERE admission_id = ?",
			args: [request.admission_id],
		}),
		tx.execute({
			sql: `SELECT relation.* FROM agent_session_relations AS relation
			       JOIN agent_session_child_admissions AS admission ON admission.relation_id = relation.relation_id
			      WHERE admission.admission_id = ?`,
			args: [request.admission_id],
		}),
		tx.execute({
			sql: "SELECT * FROM agent_session_child_budget_allocations WHERE admission_id = ?",
			args: [request.admission_id],
		}),
		tx.execute({
			sql: "SELECT * FROM agent_session_child_runs WHERE child_run_id = ?",
			args: [request.child_run_id],
		}),
	]);
	const child = await readAgentSessionTx(tx, request.child_session_id);
	if (
		!child ||
		!admissionResult.rows[0] ||
		!relationResult.rows[0] ||
		!allocationResult.rows[0] ||
		!runResult.rows[0]
	) {
		throw new Error(`accepted child request ${request.request_id} is not internally complete`);
	}
	const admission = rowToAgentSessionChildAdmission(admissionResult.rows[0]);
	const relationDepth = await agentSessionDepthTx(tx, child.session_id);
	if (admission.depth !== relationDepth) {
		throw new Error(`accepted child request ${request.request_id} has divergent relation depth`);
	}
	return {
		decision: "accepted",
		request,
		child,
		relation: rowToAgentSessionChildRelation(relationResult.rows[0]),
		admission,
		allocation: rowToAgentSessionChildBudgetAllocation(allocationResult.rows[0]),
		run: rowToAgentSessionChildRun(runResult.rows[0]),
		spec: agentNodeSpecFromChildSession(child, request.child_run_id, relationDepth),
		created,
	};
}

function readAgentSessionSemanticBinding(record: AgentSessionRecord): {
	runtime: AgentRuntimeBindingV2;
	ontology: AgentOntologyBindingV1;
} {
	const source = asRecord(agentSessionDocumentFromJson(record.document_json).source);
	const runtime = source.runtimeBinding;
	const ontology = source.agentOntologyBinding;
	try {
		validateResolvedAgentRuntimeBinding(runtime);
		validateAgentOntologyBinding(ontology);
		assertAgentOntologyRuntimeMatch(ontology, {
			agentId: record.agent_id ?? undefined,
			runtimeProfileRef: runtime.profileRef,
		});
	} catch (cause) {
		throw new AgentSessionChildAdmissionFault(
			"children_not_granted",
			"the parent Session does not carry a complete trusted semantic binding",
			cause,
		);
	}
	return { runtime, ontology };
}

function childRuntimeKindFromDocument(
	documentJson: string,
	childSessionId: string,
	expectedRuntimeBindingDigest: string,
): AgentRuntimeKind {
	const source = asRecord(agentSessionDocumentFromJson(documentJson).source);
	if (source.kind !== "child-admission") {
		throw new Error(`family child ${childSessionId} is not backed by a durable child admission document`);
	}
	const runtime = source.runtimeBinding;
	try {
		validateResolvedAgentRuntimeBinding(runtime);
	} catch (cause) {
		throw new Error(`family child ${childSessionId} has an invalid durable runtime binding`, { cause });
	}
	const actualDigest = digestAgentRuntimeBinding(runtime);
	if (actualDigest !== expectedRuntimeBindingDigest || source.runtimeBindingDigest !== expectedRuntimeBindingDigest) {
		throw new Error(`family child ${childSessionId} runtime binding diverges from its immutable admission`);
	}
	return runtime.kind;
}

/** The mode IRI pinned on a Session document's ontology binding, if any. */
function projectionModeIriFromDocument(documentJson: string): string | undefined {
	const source = asRecord(agentSessionDocumentFromJson(documentJson).source);
	const mode = asRecord(asRecord(source.agentOntologyBinding).mode);
	return typeof mode.iri === "string" && isModeIri(mode.iri) ? mode.iri : undefined;
}

function modeIriField(modeIri: string | undefined): { readonly modeIri?: string } {
	return modeIri ? { modeIri } : {};
}

function familyRootProjectionConstraintsFromDocument(
	documentJson: string,
	rootSessionId: string,
): Pick<AgentRuntimeBindingV2["constraints"], "maxChildren" | "maxConcurrentChildren" | "maxCostUsdMicros"> {
	const source = asRecord(agentSessionDocumentFromJson(documentJson).source);
	const runtime = source.runtimeBinding;
	try {
		validateResolvedAgentRuntimeBinding(runtime);
	} catch (cause) {
		throw new Error(`family root ${rootSessionId} has an invalid durable runtime binding`, { cause });
	}
	return {
		maxChildren: runtime.constraints.maxChildren,
		maxConcurrentChildren: runtime.constraints.maxConcurrentChildren,
		maxCostUsdMicros: runtime.constraints.maxCostUsdMicros,
	};
}

function agentNodeSpecFromChildSession(
	record: AgentSessionRecord,
	childRunId: string,
	relationDepth: number,
): AgentNodeSpec {
	const document = agentSessionDocumentFromJson(record.document_json);
	const source = asRecord(document.source);
	if (source.kind !== "child-admission" || source.childRunId !== childRunId) {
		throw new Error(`Agent Session ${record.session_id} is not the source for child run ${childRunId}`);
	}
	if (!Number.isSafeInteger(relationDepth) || relationDepth < 1 || source.depth !== relationDepth) {
		throw new Error(`Agent Session child ${record.session_id} has a divergent relation depth`);
	}
	const semantic = readAgentSessionSemanticBinding(record);
	const includeTools = Array.isArray(source.includeTools)
		? source.includeTools.filter((tool): tool is string => typeof tool === "string" && !!tool.trim())
		: [];
	if (!Array.isArray(source.includeTools) || includeTools.length !== source.includeTools.length) {
		throw new Error(`Agent Session child ${record.session_id} has an invalid tool include binding`);
	}
	const systemPrompt = childSourceText(source.systemPrompt, "systemPrompt");
	const contentAuthority = scheduledActivationContentAuthority(source, systemPrompt);
	return {
		nodeKey: record.node_key,
		sessionId: record.session_id,
		invocationId: childRunId,
		label: childSourceText(source.childName, "childName"),
		phaseIndex: record.phase_index,
		depth: relationDepth,
		prompt: childSourceText(source.prompt, "prompt"),
		systemPrompt,
		agentId: semantic.ontology.subject.agentId,
		graphAccess: "read",
		model: childSourceText(source.model, "model"),
		provider: childSourceText(source.provider, "provider"),
		graphId: record.graph_id,
		toolMode: "dynamic",
		includeTools,
		strictToolManifest: true,
		maxTurns: semantic.runtime.constraints.maxTurns,
		runtime: semantic.runtime,
		runtimeBindingDigest: digestAgentRuntimeBinding(semantic.runtime),
		ontology: semantic.ontology,
		ontologyBindingDigest: digestAgentOntologyBinding(semantic.ontology),
		agentType: "domain-agent-emanation",
		...contentAuthority,
	};
}

function childSourceText(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`child source.${field} must be a non-empty string`);
	return value;
}

async function readHostResolvedChildAuthorityTx(
	tx: RuntimeTx,
	parent: AgentSessionRecord,
): Promise<HostResolvedChildAuthority | null> {
	const result = await tx.execute({
		sql: "SELECT inputs_json FROM workflow_instances WHERE run_id = ?",
		args: [parent.run_id],
	});
	if (!result.rows[0]) return null;
	const inputs = asRecord(parseJson(String(result.rows[0].inputs_json)));
	const host = asRecord(inputs.hostContext);
	if (host.schema !== "sophia.domain-agent-host-context.v1") return null;
	const runtimes = asRecord(host.runtimes);
	const ontologies = asRecord(host.ontologies);
	const emanation = asRecord(host.emanation);
	const parentRuntime = runtimes.pilot;
	const childRuntime = runtimes.emanation;
	const parentOntology = ontologies.pilot;
	const childOntology = ontologies.emanation;
	try {
		validateResolvedAgentRuntimeBinding(parentRuntime);
		validateResolvedAgentRuntimeBinding(childRuntime);
		validateAgentOntologyBinding(parentOntology);
		validateAgentOntologyBinding(childOntology);
		assertAgentOntologyRuntimeMatch(parentOntology, {
			agentId: parent.agent_id ?? undefined,
			runtimeProfileRef: parentRuntime.profileRef,
		});
		assertAgentOntologyRuntimeMatch(childOntology, {
			agentId: parent.agent_id ?? undefined,
			runtimeProfileRef: childRuntime.profileRef,
		});
	} catch {
		return null;
	}
	if ((childRuntime.kind !== "simple" && childRuntime.kind !== "prime") || emanation.enabled !== true) return null;
	if (
		childOntology.subject.agentId !== parentOntology.subject.agentId ||
		childOntology.subject.registeredName !== parentOntology.subject.registeredName
	) {
		return null;
	}
	const provider = typeof emanation.provider === "string" ? emanation.provider.trim() : "";
	const model = typeof emanation.model === "string" ? emanation.model.trim() : "";
	const systemPrompt = typeof host.systemPrompt === "string" ? host.systemPrompt.trim() : "";
	if (!provider || !model || !systemPrompt) return null;
	if (!Array.isArray(host.emanationToolInclude)) return null;
	const includeTools = host.emanationToolInclude.filter(
		(tool): tool is string => typeof tool === "string" && !!tool.trim(),
	);
	if (includeTools.length !== host.emanationToolInclude.length || new Set(includeTools).size !== includeTools.length) {
		return null;
	}
	const toolbelt = asRecord(host.toolbelt);
	if (!Array.isArray(toolbelt.tools)) return null;
	const grantedReadTools = new Set(
		toolbelt.tools
			.filter(
				(tool): tool is Record<string, unknown> =>
					typeof tool === "object" &&
					tool !== null &&
					!Array.isArray(tool) &&
					tool.available === true &&
					tool.access === "read",
			)
			.map((tool) => tool.name)
			.filter((name): name is string => typeof name === "string" && !!name.trim()),
	);
	if (includeTools.some((tool) => !grantedReadTools.has(tool))) return null;
	return {
		parentRuntime,
		parentOntology,
		childRuntime,
		childOntology,
		provider,
		model,
		systemPrompt: `${systemPrompt}\n\nThis embodiment is a bounded read-only emanation.`,
		includeTools,
	};
}

function deriveChildSemanticBinding(input: {
	parentRuntime: AgentRuntimeBindingV2;
	childRuntime: AgentRuntimeBindingV2;
	childOntology: AgentOntologyBindingV1;
}): {
	runtime: AgentRuntimeBindingV2;
	runtimeBindingDigest: string;
	ontology: AgentOntologyBindingV1;
	ontologyBindingDigest: string;
	budget: AgentSessionChildBudgetSliceV1;
} {
	let runtime: AgentRuntimeBindingV2;
	try {
		runtime = resolveAgentRuntimeBinding(
			{
				kind: input.childRuntime.kind,
				bundle: input.childRuntime.bundle,
				profileRef: input.childRuntime.profileRef,
			},
			{
				bundles: { simple: input.childRuntime.bundle, prime: input.childRuntime.bundle },
				profile: input.childRuntime,
			},
		);
	} catch (cause) {
		throw new AgentSessionChildAdmissionFault(
			"binding_widening",
			"host-resolved child runtime binding is invalid",
			cause,
		);
	}
	assertChildRuntimeSubset(input.parentRuntime.constraints, runtime.constraints, runtime.kind);
	const runtimeBindingDigest = digestAgentRuntimeBinding(runtime);
	const ontologyBindingDigest = digestAgentOntologyBinding(input.childOntology);
	return {
		runtime,
		runtimeBindingDigest,
		ontology: input.childOntology,
		ontologyBindingDigest,
		budget: {
			schema: "choreograph.agent-session-child-budget.v1",
			maxTurns: runtime.constraints.maxTurns,
			maxWallTimeMs: runtime.constraints.maxWallTimeMs,
			maxTokens: runtime.constraints.maxTokens,
			maxCostUsdMicros: runtime.constraints.maxCostUsdMicros,
			maxArtifactBytes: runtime.constraints.maxArtifactBytes,
		},
	};
}

function assertChildRuntimeSubset(
	parent: AgentRuntimeConstraintsV2,
	child: AgentRuntimeConstraintsV2,
	runtimeKind: AgentRuntimeKind,
): void {
	const numeric = [
		"maxTurns",
		"maxWallTimeMs",
		"maxTokens",
		"maxCostUsdMicros",
		"maxChildren",
		"maxChildDepth",
		"maxConcurrentChildren",
		"maxArtifactBytes",
		"idlePassivateMs",
	] as const satisfies ReadonlyArray<keyof AgentRuntimeConstraintsV2>;
	const booleans = [
		"allowPersistentKernel",
		"allowAutonomousContinuation",
		"allowSchedules",
		"allowWorkflowProposals",
	] as const satisfies ReadonlyArray<keyof AgentRuntimeConstraintsV2>;
	const widened = [
		...numeric.filter((key) => child[key] > parent[key]),
		...booleans.filter((key) => child[key] && !parent[key]),
	];
	const remainingDepthInvalid = child.maxChildDepth > Math.max(0, parent.maxChildDepth - 1);
	if (widened.length > 0 || remainingDepthInvalid || (runtimeKind === "prime" && !parent.allowPersistentKernel)) {
		throw new AgentSessionChildAdmissionFault(
			"binding_widening",
			"the host-resolved child binding is not an attenuated subset with one fewer remaining child depth",
			{
				widened,
				parentRemainingChildDepth: parent.maxChildDepth,
				childRemainingChildDepth: child.maxChildDepth,
			},
		);
	}
}

async function agentSessionDepthTx(tx: RuntimeTx, sessionId: string): Promise<number> {
	const result = await tx.execute({
		sql: `
			WITH RECURSIVE ancestors(session_id, depth) AS (
				SELECT parent_session_id, 1
				  FROM agent_session_relations
				 WHERE child_session_id = ?
				UNION ALL
				SELECT relation.parent_session_id, ancestors.depth + 1
				  FROM agent_session_relations AS relation
				  JOIN ancestors ON relation.child_session_id = ancestors.session_id
			)
			SELECT COALESCE(MAX(depth), 0) AS depth FROM ancestors
		`,
		args: [sessionId],
	});
	return Number(result.rows[0]?.depth ?? 0);
}

async function insertNewAgentSessionTx(
	tx: RuntimeTx,
	input: BeginAgentSessionInput,
	childSource?: ChildAdmissionDocumentSource,
	familyRootSessionId: string = input.sessionId,
): Promise<AgentSessionRecord> {
	const semantic = requireExecutableSessionBinding(input.spec);
	const graphOwnerPrincipal = requireTypedGraphOwnerPrincipal(input.graphOwnerPrincipal);
	const eventPayload = {
		nodeKey: input.nodeKey,
		label: input.spec.label,
		phaseIndex: input.spec.phaseIndex,
		runtimeKind: semantic.runtime.kind,
		runtimeBindingDigest: semantic.runtimeDigest,
		ontologyBindingDigest: semantic.ontologyDigest,
	};
	const document = buildAgentSessionDocument(input, childSource);
	const documentOp = await appendAgentSessionDocumentOpTx(tx, input.sessionId, {
		ts: input.now,
		actor: "choreograph.workflow-runtime",
		kind: "session.created",
		patch: { op: "document.create", source: document.source, frontier: input.frontier },
		document,
	});
	await tx.execute({
		sql: `
			INSERT INTO agent_sessions
				(session_id, run_id, owner_user_id, graph_owner_principal, graph_id, workflow_name, node_key,
				 label, phase_index, agent_id, model, family_root_session_id, status, lifecycle_state, frontier_json,
				 document_json, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'open', ?, ?, ?, ?)
		`,
		args: [
			input.sessionId,
			input.runId,
			input.ownerUserId,
			graphOwnerPrincipal,
			input.graphId,
			input.workflowName,
			input.nodeKey,
			input.spec.label,
			input.spec.phaseIndex,
			input.spec.agentId ?? null,
			input.spec.model,
			familyRootSessionId,
			JSON.stringify(input.frontier),
			JSON.stringify(documentOp.document),
			input.now,
			input.now,
		],
	});
	await appendAgentSessionEventTx(tx, input.sessionId, {
		type: "session.queued",
		ts: input.now,
		payload: { ...eventPayload, documentRevision: documentOp.rev, documentChangeId: documentOp.change_id },
	});
	await openAgentSessionBudgetAccountTx(
		tx,
		input.sessionId,
		budgetVectorFromConstraints(semantic.runtime.constraints),
		input.now,
	);
	const record = await readAgentSessionTx(tx, input.sessionId);
	if (!record) throw new Error(`insertNewAgentSessionTx: failed to read ${input.sessionId}`);
	return record;
}

function updateAgentSessionDocument(
	documentJson: string,
	result: AgentNodeResult,
	frontier: WorkflowFrontier,
	context: { readonly sessionId: string; readonly generation: number; readonly now: number },
): Record<string, unknown> {
	const document = parseJson(documentJson);
	const base = document && typeof document === "object" ? (document as Record<string, unknown>) : {};
	const eventId = `result:${result.invocationId ?? result.sessionId ?? result.label}`;
	const status = result.state === "error" ? "failed" : "completed";
	const meaningfulObjects = asRecord(base.meaningfulObjects);
	const checkpoint = result.agentCheckpoint;
	const checkpointRef = checkpoint?.object;
	// The reply is stamped with the time the outcome was committed and its generation (D4), and a
	// regrown generation's result that only repeats its durable command's reply is not written (D3).
	const withTranscript = appendNodeResultTranscript(base, {
		sessionId: context.sessionId,
		eventId,
		output: result.output,
		state: result.state,
		model: result.model,
		tokens: result.tokens,
		toolCalls: result.toolCalls,
		...(checkpointRef ? { checkpointRef } : {}),
		generation: context.generation,
		now: context.now,
	});
	return {
		...withTranscript,
		frontier,
		meaningfulObjects: checkpointRef ? { ...meaningfulObjects, agentCheckpoint: checkpointRef } : meaningfulObjects,
		runtime: {
			...asRecord(base.runtime),
			status,
			...(checkpoint ? { checkpoint: checkpointRef, checkpointSequence: checkpoint.manifest.sessionSequence } : {}),
		},
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function agentSessionDocumentFromJson(documentJson: string): Record<string, unknown> {
	const parsed = parseJson(documentJson);
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function normalizeAgentSessionControl(document: Record<string, unknown>): Record<string, unknown> {
	const control = asRecord(document.control);
	return {
		schema: typeof control.schema === "string" ? control.schema : "choreograph.agent-session-control.v1",
		driverLease: control.driverLease ?? null,
		permissionRequests: asRecord(control.permissionRequests),
		commandSummary: asRecord(control.commandSummary),
	};
}

function currentSessionDriver(documentJson: string): string | null {
	return (
		parseDriverLease(normalizeAgentSessionControl(agentSessionDocumentFromJson(documentJson)).driverLease)?.holder ??
		null
	);
}

function digestAgentSessionCommand(name: AgentSessionCommandName, payload: Record<string, unknown>): string {
	return `sha256:${createHash("sha256").update(canonicalJson({ name, payload })).digest("hex")}`;
}

function agentSessionChildRelationId(parentSessionId: string, childSessionId: string): string {
	const digest = createHash("sha256")
		.update(canonicalJson({ kind: "parent_child", parentSessionId, childSessionId }))
		.digest("hex");
	return `asr_${digest}`;
}

function parseDriverLease(value: unknown): AgentSessionDriverLease | null {
	const record = asRecord(value);
	const holder =
		typeof record.holder === "string"
			? record.holder
			: typeof record.clientId === "string"
				? record.clientId
				: undefined;
	if (!holder) return null;
	const claimTs = typeof record.claimTs === "number" ? record.claimTs : Number(record.claimTs ?? record.ts ?? 0);
	const claimedAt =
		typeof record.claimedAt === "number" ? record.claimedAt : Number(record.claimedAt ?? claimTs ?? Date.now());
	const epoch = typeof record.epoch === "number" ? record.epoch : Number(record.epoch ?? 0);
	return {
		holder,
		clientId: typeof record.clientId === "string" ? record.clientId : holder,
		claimTs: Number.isFinite(claimTs) ? claimTs : 0,
		claimedAt: Number.isFinite(claimedAt) ? claimedAt : 0,
		epoch: Number.isFinite(epoch) ? epoch : 0,
	};
}

function makeDriverLease(
	clientId: string,
	claimTs: number,
	claimedAt: number,
	previous: AgentSessionDriverLease | null,
): AgentSessionDriverLease {
	return {
		holder: clientId,
		clientId,
		claimTs,
		claimedAt,
		epoch: (previous?.epoch ?? 0) + 1,
	};
}

function driverLeaseBeats(candidate: AgentSessionDriverLease, current: AgentSessionDriverLease): boolean {
	if (candidate.claimTs !== current.claimTs) return candidate.claimTs > current.claimTs;
	return candidate.holder < current.holder;
}

function controlMutation(
	control: WorkflowControlRecord,
	applied: boolean,
	reason?: WorkflowControlMutationResult["reason"],
): WorkflowControlMutationResult {
	return {
		control,
		applied,
		driver: control.driverLease?.holder ?? null,
		...(reason ? { reason } : {}),
	};
}

async function readWorkflowControlTx(
	tx: { execute(statement: { sql: string; args: unknown[] }): Promise<{ rows: Row[] }> },
	runId: string,
): Promise<WorkflowControlRecord | null> {
	const result = await tx.execute({ sql: "SELECT * FROM workflow_controls WHERE run_id = ?", args: [runId] });
	return result.rows[0] ? rowToWorkflowControl(result.rows[0]) : null;
}

async function updateWorkflowControlTx(
	tx: { execute(statement: { sql: string; args: unknown[] }): Promise<{ rows: Row[] }> },
	current: WorkflowControlRecord,
	changes: {
		driverLease?: AgentSessionDriverLease | null;
		amendments?: WorkflowBeatAmendment[];
		currentBeat?: WorkflowBeatControlPoint | null;
		updatedAt: number;
	},
): Promise<WorkflowControlRecord> {
	const driverLease = changes.driverLease === undefined ? current.driverLease : changes.driverLease;
	const amendments = changes.amendments ?? current.amendments;
	const currentBeat = changes.currentBeat === undefined ? current.currentBeat : changes.currentBeat;
	const result = await tx.execute({
		sql: `
			UPDATE workflow_controls
			   SET revision = revision + 1,
			       driver_json = ?,
			       amendments_json = ?,
			       current_beat_json = ?,
			       updated_at = ?
			 WHERE run_id = ? AND revision = ?
			 RETURNING *
		`,
		args: [
			driverLease ? JSON.stringify(driverLease) : null,
			JSON.stringify(amendments),
			currentBeat ? JSON.stringify(currentBeat) : null,
			changes.updatedAt,
			current.runId,
			current.revision,
		],
	});
	if (!result.rows[0]) {
		throw new Error(`workflow control CAS lost for '${current.runId}' at revision ${current.revision}`);
	}
	return rowToWorkflowControl(result.rows[0]);
}

async function pauseWorkflowAtBeatIfRequested(
	tx: { execute(statement: { sql: string; args: unknown[] }): Promise<{ rows: Row[] }> },
	runId: string,
	frontier: WorkflowFrontier,
): Promise<boolean> {
	const result = await tx.execute({
		sql: "SELECT status, pause_requested_at FROM workflow_instances WHERE run_id = ?",
		args: [runId],
	});
	const row = result.rows[0];
	if (!row) return false;
	const paused = row.status === "pausing" || row.status === "paused" || row.pause_requested_at != null;
	if (!paused) return false;
	await tx.execute({
		sql: `
			UPDATE workflow_instances
			   SET status = 'paused', frontier_json = ?, updated_at = ?
			 WHERE run_id = ?
		`,
		args: [JSON.stringify(frontier), frontier.ts, runId],
	});
	return true;
}

function normalizeWorkflowAmendmentPayload(kind: WorkflowBeatAmendmentKind, value: unknown): Record<string, unknown> {
	const payload = value === undefined ? {} : asRecord(value);
	if (value !== undefined && (typeof value !== "object" || value === null || Array.isArray(value))) {
		throw invalidControl("amendment payload must be an object");
	}
	const keys = Object.keys(payload).sort();
	if (kind === "skip") {
		if (keys.length !== 0) throw invalidControl("skip payload must be empty");
		return {};
	}
	if (kind === "reorder") {
		if (canonicalControlJson(keys) !== canonicalControlJson(["order"])) {
			throw invalidControl("reorder payload must contain exactly order");
		}
		return { order: normalizePendingBeatIds(payload.order) };
	}
	if (kind === "reparameterize") {
		if (canonicalControlJson(keys) !== canonicalControlJson(["parameters"])) {
			throw invalidControl("reparameterize payload must contain exactly parameters");
		}
		const parameters = asRecord(payload.parameters);
		if (typeof payload.parameters !== "object" || payload.parameters === null || Array.isArray(payload.parameters)) {
			throw invalidControl("reparameterize parameters must be an object");
		}
		assertNoAuthorityMutation(parameters);
		const normalized = canonicalControlValue(parameters) as Record<string, unknown>;
		if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > 64 * 1024) {
			throw invalidControl("reparameterize payload exceeds 64 KiB");
		}
		return { parameters: normalized };
	}
	if (kind === "directive") {
		if (canonicalControlJson(keys) !== canonicalControlJson(["text"])) {
			throw invalidControl("directive payload must contain exactly text");
		}
		const text = typeof payload.text === "string" ? payload.text.trim() : "";
		if (!text || text.length > 4000) throw invalidControl("directive text must contain 1..4000 characters");
		return { text };
	}
	throw invalidControl(`unsupported amendment kind '${String(kind)}'`);
}

const AMENDMENT_AUTHORITY_KEYS = new Set([
	"actorref",
	"approvalpolicy",
	"authority",
	"budget",
	"budgets",
	"capability",
	"capabilities",
	"credential",
	"credentials",
	"effect",
	"effects",
	"grant",
	"grantdocumentid",
	"grantid",
	"grantref",
	"grants",
	"graphaccess",
	"graphid",
	"graphowner",
	"graphownerprincipal",
	"includeTools".toLowerCase(),
	"maxturns",
	"model",
	"operation",
	"ownerprincipal",
	"owneruserid",
	"provider",
	"quota",
	"quotas",
	"secret",
	"secrets",
	"stricttoolmanifest",
	"token",
	"tool",
	"toolbelt",
	"toolmode",
	"tools",
]);

function assertNoAuthorityMutation(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) assertNoAuthorityMutation(item);
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		const rawKey = key.toLowerCase();
		const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
		if (rawKey === "__proto__" || rawKey === "prototype" || rawKey === "constructor") {
			throw invalidControl(`reparameterize cannot mutate structural field '${key}'`);
		}
		if (
			AMENDMENT_AUTHORITY_KEYS.has(normalized) ||
			[
				"accesslevel",
				"approval",
				"authority",
				"budget",
				"capability",
				"credential",
				"dangerousop",
				"effect",
				"grant",
				"maxtoken",
				"maxturn",
				"minimumrole",
				"model",
				"operation",
				"provider",
				"quota",
				"secret",
				"token",
				"tool",
			].some((prefix) => normalized.startsWith(prefix))
		) {
			throw invalidControl(`reparameterize cannot mutate authority field '${key}'`);
		}
		assertNoAuthorityMutation(child);
	}
}

function normalizeAllowedWorkflowAmendments(
	value: readonly WorkflowBeatAmendmentKind[] | undefined,
): ReadonlySet<WorkflowBeatAmendmentKind> | undefined {
	if (value === undefined) return undefined;
	const known = new Set<WorkflowBeatAmendmentKind>(["skip", "reorder", "reparameterize", "directive"]);
	if (value.some((kind) => !known.has(kind))) {
		throw invalidControl("allowed workflow amendments contain an unsupported kind");
	}
	return new Set(value);
}

function normalizePendingBeatIds(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
		throw invalidControl("pending beat ids must contain 1..256 entries");
	}
	const ids = value.map((candidate) => requiredControlId(candidate, "beatId"));
	if (new Set(ids).size !== ids.length) throw invalidControl("pending beat ids must be unique");
	return ids;
}

function requiredControlId(value: unknown, label: string): string {
	const normalized = typeof value === "string" ? value.trim() : "";
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
		throw invalidControl(`${label} must be a stable 1..128 character identifier`);
	}
	return normalized;
}

function invalidControl(message: string): Error {
	return Object.assign(new Error(message), { status: 400, code: "workflow_control_invalid" });
}

function canonicalControlValue(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw invalidControl("control payload numbers must be finite");
		return value;
	}
	if (Array.isArray(value)) return value.map(canonicalControlValue);
	if (value && typeof value === "object") {
		const output: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const child = (value as Record<string, unknown>)[key];
			if (child === undefined) continue;
			output[key] = canonicalControlValue(child);
		}
		return output;
	}
	throw invalidControl("control payload must be JSON-compatible");
}

function canonicalControlJson(value: unknown): string {
	return JSON.stringify(canonicalControlValue(value));
}

function amendmentIdentity(amendment: WorkflowBeatAmendment): Record<string, unknown> {
	return {
		id: amendment.id,
		clientId: amendment.clientId,
		kind: amendment.kind,
		targetBeatId: amendment.targetBeatId,
		payload: amendment.payload,
		leaseEpoch: amendment.leaseEpoch,
	};
}

function sameStringSet(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((value) => right.includes(value));
}

function applyAmendment(amendment: WorkflowBeatAmendment, now: number, beatId?: string): void {
	amendment.state = "applied";
	amendment.appliedAt = now;
	if (beatId) amendment.appliedBeatId = beatId;
}

function rejectAmendment(
	amendment: WorkflowBeatAmendment,
	now: number,
	beatId: string | undefined,
	reason: string,
): void {
	amendment.state = "rejected";
	amendment.appliedAt = now;
	if (beatId) amendment.appliedBeatId = beatId;
	amendment.rejection = reason;
}

async function appendAgentSessionDocumentOpTx(
	tx: { execute(statement: { sql: string; args: unknown[] }): Promise<{ rows: Row[] }> },
	sessionId: string,
	input: {
		ts: number;
		actor: string;
		kind: string;
		patch: unknown;
		document: Record<string, unknown>;
	},
): Promise<AgentSessionDocumentOp> {
	const next = await tx.execute({
		sql: "SELECT COALESCE(MAX(rev), 0) + 1 AS next_rev FROM agent_session_document_ops WHERE session_id = ?",
		args: [sessionId],
	});
	const rev = Number(next.rows[0]?.next_rev ?? 1);
	if (!Number.isFinite(rev) || rev < 1) {
		throw new Error(`appendAgentSessionDocumentOpTx: invalid revision ${String(next.rows[0]?.next_rev)}`);
	}
	const patchJson = JSON.stringify(input.patch ?? {});
	const changeId = makeDocumentChangeId(sessionId, rev, input.kind, input.actor, input.ts, patchJson);
	const document = stampAgentSessionDocument(input.document, {
		sessionId,
		rev,
		changeId,
		ts: input.ts,
		actor: input.actor,
	});
	const documentJson = JSON.stringify(document);
	await tx.execute({
		sql: `
			INSERT INTO agent_session_document_ops
				(session_id, rev, change_id, ts, actor, kind, patch_json, document_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`,
		args: [sessionId, rev, changeId, input.ts, input.actor, input.kind, patchJson, documentJson],
	});
	return {
		session_id: sessionId,
		rev,
		change_id: changeId,
		ts: input.ts,
		actor: input.actor,
		kind: input.kind,
		patch: input.patch ?? {},
		document,
	};
}

function stampAgentSessionDocument(
	document: Record<string, unknown>,
	input: { sessionId: string; rev: number; changeId: string; ts: number; actor: string },
): Record<string, unknown> {
	return {
		...document,
		collab: {
			...asRecord(document.collab),
			schema: "choreograph.agent-session-collab.v1",
			backend: "oplog",
			crdt: "loro",
			roomId: `choreograph:agent-session:${input.sessionId}`,
			revision: input.rev,
			changeId: input.changeId,
			updatedAt: input.ts,
			actor: input.actor,
		},
	};
}

function makeDocumentChangeId(
	sessionId: string,
	rev: number,
	kind: string,
	actor: string,
	ts: number,
	patchJson: string,
): string {
	const digest = createHash("sha256")
		.update(`${sessionId}\n${rev}\n${kind}\n${actor}\n${ts}\n${patchJson}`)
		.digest("hex")
		.slice(0, 24);
	return `chg_${rev}_${digest}`;
}

async function readAgentSessionTx(
	tx: { execute(statement: { sql: string; args: unknown[] }): Promise<{ rows: Row[] }> },
	sessionId: string,
): Promise<AgentSessionRecord | null> {
	const result = await tx.execute({ sql: "SELECT * FROM agent_sessions WHERE session_id = ?", args: [sessionId] });
	const row = result.rows[0];
	return row ? rowToAgentSession(row) : null;
}

async function appendAgentSessionEventTx(
	tx: { execute(statement: { sql: string; args: unknown[] }): Promise<{ rows: Row[] }> },
	sessionId: string,
	event: { type: string; ts: number; causationId?: string; commandId?: string; payload?: unknown },
): Promise<AgentSessionEvent> {
	const result = await tx.execute({
		sql: `
			INSERT INTO agent_session_events
				(session_id, seq, ts, type, causation_id, command_id, payload_json)
			SELECT ?, COALESCE(MAX(seq), -1) + 1, ?, ?, ?, ?, ?
			  FROM agent_session_events
			 WHERE session_id = ?
			RETURNING seq
		`,
		args: [
			sessionId,
			event.ts,
			event.type,
			event.causationId ?? null,
			event.commandId ?? null,
			event.payload === undefined ? null : JSON.stringify(event.payload),
			sessionId,
		],
	});
	const seq = result.rows[0]?.seq;
	if (typeof seq !== "number") {
		throw new Error(`appendAgentSessionEventTx: expected numeric seq, got ${String(seq)}`);
	}
	if (isChatActivityEvent(event.type, event.payload)) {
		// A person did something, or an assistant finished something: the chat's
		// `lastActivityAt` moves, and never backwards. A Session with no catalogue
		// row is not a listed chat, so the statement matches nothing.
		await tx.execute({
			sql: "UPDATE chat_session_catalogue SET last_activity_at = MAX(last_activity_at, ?) WHERE session_id = ?",
			args: [event.ts, sessionId],
		});
	}
	return {
		session_id: sessionId,
		seq,
		ts: event.ts,
		type: event.type,
		causation_id: event.causationId ?? null,
		command_id: event.commandId ?? null,
		payload: event.payload,
	};
}

async function insertRejectedAgentSessionCommandTx(
	tx: { execute(statement: { sql: string; args: unknown[] }): Promise<{ rows: Row[] }> },
	sessionId: string,
	document: Record<string, unknown>,
	control: Record<string, unknown>,
	input: {
		commandId: string;
		idempotencyKey: string;
		commandDigest: string;
		name: AgentSessionCommandName;
		payload: Record<string, unknown>;
		clientId: string;
		targetGeneration: number;
		now: number;
		code: string;
		reason: string;
	},
): Promise<AgentSessionCommandRecord> {
	await tx.execute({
		sql: `INSERT INTO agent_session_commands
			(command_id, session_id, idempotency_key, command_digest, name, payload_json,
			 client_id, target_generation, state, error, submitted_at, completed_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rejected', ?, ?, ?)`,
		args: [
			input.commandId,
			sessionId,
			input.idempotencyKey,
			input.commandDigest,
			input.name,
			JSON.stringify(input.payload),
			input.clientId,
			input.targetGeneration,
			`${input.code}: ${input.reason}`,
			input.now,
			input.now,
		],
	});
	const commandSummary = asRecord(control.commandSummary);
	control.commandSummary = {
		submitted: Number(commandSummary.submitted ?? 0) + 1,
		completed: Number(commandSummary.completed ?? 0),
		failed: Number(commandSummary.failed ?? 0),
		rejected: Number(commandSummary.rejected ?? 0) + 1,
		cancelled: Number(commandSummary.cancelled ?? 0),
		lastCommandId: input.commandId,
		lastCommandName: input.name,
		lastCommandState: "rejected",
		targetGeneration: input.targetGeneration,
	};
	document.control = control;
	const documentOp = await appendAgentSessionDocumentOpTx(tx, sessionId, {
		ts: input.now,
		actor: input.clientId,
		kind: "command.rejected",
		patch: {
			op: "command.reject",
			commandId: input.commandId,
			name: input.name,
			code: input.code,
			reason: input.reason,
		},
		document,
	});
	await tx.execute({
		sql: "UPDATE agent_sessions SET document_json = ?, updated_at = ? WHERE session_id = ?",
		args: [JSON.stringify(documentOp.document), input.now, sessionId],
	});
	await appendAgentSessionEventTx(tx, sessionId, {
		type: "command.rejected",
		ts: input.now,
		payload: {
			commandId: input.commandId,
			name: input.name,
			code: input.code,
			reason: input.reason,
			documentRevision: documentOp.rev,
		},
	});
	const inserted = await tx.execute({
		sql: "SELECT * FROM agent_session_commands WHERE command_id = ?",
		args: [input.commandId],
	});
	return rowToAgentSessionCommand(inserted.rows[0]!);
}

function rowToWorkflowInstance(row: Row): WorkflowInstanceRecord {
	return {
		run_id: String(row.run_id),
		workflow_name: String(row.workflow_name),
		graph_id: String(row.graph_id),
		owner_user_id: String(row.owner_user_id),
		status: String(row.status) as WorkflowRuntimeStatus,
		source_sha256: nullableString(row.source_sha256),
		source_text: nullableString(row.source_text),
		inputs_json: String(row.inputs_json),
		resume_from_run_id: nullableString(row.resume_from_run_id),
		frontier_json: nullableString(row.frontier_json),
		pause_requested_at: nullableNumber(row.pause_requested_at),
		pause_reason: nullableString(row.pause_reason),
		stop_requested_at: nullableNumber(row.stop_requested_at),
		stop_requested_by: nullableString(row.stop_requested_by),
		stop_reason: nullableString(row.stop_reason),
		started_at: Number(row.started_at),
		updated_at: Number(row.updated_at),
		ended_at: nullableNumber(row.ended_at),
		payload_json: nullableString(row.payload_json),
	};
}

function rowToWorkflowControl(row: Row): WorkflowControlRecord {
	const amendments = parseJson(row.amendments_json);
	const currentBeat = parseJson(row.current_beat_json);
	return {
		runId: String(row.run_id),
		revision: Number(row.revision),
		driverLease: parseDriverLease(parseJson(row.driver_json)),
		amendments: Array.isArray(amendments) ? (amendments as WorkflowBeatAmendment[]) : [],
		currentBeat:
			currentBeat && typeof currentBeat === "object" && !Array.isArray(currentBeat)
				? (currentBeat as WorkflowBeatControlPoint)
				: null,
		updatedAt: Number(row.updated_at),
	};
}

/**
 * The correlated test "some Session still needs this seed", for statements over `chat_seeds`. A claim counts
 * while its Session is open or closing; one left by a Session that has closed, faulted or gone is garbage that
 * only waits for `reapChatSeeds`, and is not a reason to serve an expired seed or to spare a renewed one.
 */
const CHAT_SEED_HAS_CLAIM_SQL = `SELECT 1 FROM chat_seed_claims c
	JOIN agent_sessions a ON a.session_id = c.session_id AND a.lifecycle_state IN ('open', 'closing')
	WHERE c.owner_user_id = chat_seeds.owner_user_id AND c.digest = chat_seeds.digest`;

/**
 * Give a seed a new `expiresAt`, and start it over as unclaimed when no live Session claims it: a seed that
 * lost every Session and is put or admitted again is fresh, not an orphan to be reaped a moment later.
 */
async function renewChatSeedTx(tx: StoreTx, ownerUserId: string, digest: string, expiresAt: number): Promise<void> {
	await tx.execute({
		sql: `UPDATE chat_seeds
			SET expires_at = ?,
			    first_claimed_at = CASE
			      WHEN EXISTS (${CHAT_SEED_HAS_CLAIM_SQL}) THEN first_claimed_at
			      ELSE NULL
			    END
			WHERE owner_user_id = ? AND digest = ?`,
		args: [expiresAt, ownerUserId, digest],
	});
}

export interface ChatSeedClaimInput {
	readonly sessionId: string;
	readonly ownerUserId: string;
	readonly digest: string;
	/** When given, must equal the stored byte count (the invocation states what it thinks it claims). */
	readonly bytes?: number;
	readonly now: number;
}

/** The claim, inside the caller's transaction: `beginAgentSession` writes it with the Session. */
async function claimChatSeedTx(tx: StoreTx, input: ChatSeedClaimInput): Promise<void> {
	const session = await tx.execute({
		sql: "SELECT owner_user_id FROM agent_sessions WHERE session_id = ?",
		args: [input.sessionId],
	});
	if (!session.rows[0] || String(session.rows[0].owner_user_id) !== input.ownerUserId) {
		throw new ChatSeedFault("seed_claim_invalid", "the Session does not exist or is not this owner's");
	}
	const prior = await tx.execute({
		sql: "SELECT owner_user_id, digest FROM chat_seed_claims WHERE session_id = ?",
		args: [input.sessionId],
	});
	if (prior.rows[0]) {
		const sameClaim =
			String(prior.rows[0].owner_user_id) === input.ownerUserId && String(prior.rows[0].digest) === input.digest;
		if (sameClaim) return;
		throw new ChatSeedFault("seed_claim_conflict", "the Session already claimed a different seed");
	}
	const seed = await tx.execute({
		sql: `SELECT bytes, expires_at, EXISTS (${CHAT_SEED_HAS_CLAIM_SQL}) AS claimed
			FROM chat_seeds WHERE owner_user_id = ? AND digest = ?`,
		args: [input.ownerUserId, input.digest],
	});
	const row = seed.rows[0];
	if (!row || (Number(row.claimed) !== 1 && Number(row.expires_at) <= input.now)) {
		throw new ChatSeedFault("seed_not_found", "no such seed for this owner, or it has expired");
	}
	if (input.bytes !== undefined && Number(row.bytes) !== input.bytes) {
		throw new ChatSeedFault("seed_bytes_mismatch", "the seed's size is not the size the invocation named");
	}
	await tx.execute({
		sql: "INSERT INTO chat_seed_claims (session_id, owner_user_id, digest, claimed_at) VALUES (?, ?, ?, ?)",
		args: [input.sessionId, input.ownerUserId, input.digest, input.now],
	});
	await tx.execute({
		sql: `UPDATE chat_seeds SET first_claimed_at = COALESCE(first_claimed_at, ?)
			WHERE owner_user_id = ? AND digest = ?`,
		args: [input.now, input.ownerUserId, input.digest],
	});
}

/**
 * The catalogue row for a Session that is being created, or undefined when it is
 * not a chat. A chat is a headed root Session (whichever built-in workflow
 * started it). The title is the explicit one the host supplied, else the first
 * user message; the row never holds a transcript.
 */
function chatCatalogueRecordForNewSession(
	input: BeginAgentSessionInput,
	graphOwnerPrincipal: string,
): ChatSessionCatalogueRecord | undefined {
	if (input.spec.interactionMode !== "headed" || !CHAT_WORKFLOW_NAMES.has(input.workflowName)) return undefined;
	const explicitTitle = normalizeExplicitChatTitle(input.spec.chat?.title);
	return {
		session_id: input.sessionId,
		run_id: input.runId,
		owner_user_id: input.ownerUserId,
		graph_owner_principal: graphOwnerPrincipal,
		graph_id: input.graphId,
		workflow_name: input.workflowName,
		title: explicitTitle ?? deriveChatTitle(input.spec.prompt),
		title_source: explicitTitle === undefined ? "first-message" : "explicit",
		model: input.spec.model,
		provider: input.spec.provider ?? "",
		continues_json: input.spec.seed ? JSON.stringify(input.spec.seed.continuesConversation) : null,
		seed_window_json: input.spec.seed ? JSON.stringify(input.spec.seed.window) : null,
		created_at: input.now,
		last_activity_at: input.now,
	};
}

async function insertChatSessionCatalogueTx(tx: StoreTx, record: ChatSessionCatalogueRecord): Promise<void> {
	await tx.execute({
		sql: `INSERT INTO chat_session_catalogue
				(session_id, run_id, owner_user_id, graph_owner_principal, graph_id, workflow_name,
				 title, title_source, model, provider, continues_json, seed_window_json,
				 created_at, last_activity_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(session_id) DO NOTHING`,
		args: [
			record.session_id,
			record.run_id,
			record.owner_user_id,
			record.graph_owner_principal,
			record.graph_id,
			record.workflow_name,
			record.title,
			record.title_source,
			record.model,
			record.provider,
			record.continues_json,
			record.seed_window_json,
			record.created_at,
			record.last_activity_at,
		],
	});
}

function isChatTitleSource(value: string): value is ChatTitleSource {
	return value === "explicit" || value === "first-message" || value === "backfill";
}

function rowToChatSessionCatalogue(row: Row): ChatSessionCatalogueRecord {
	const titleSource = String(row.title_source);
	if (!isChatTitleSource(titleSource)) throw new Error(`invalid chat title source: ${titleSource}`);
	return {
		session_id: String(row.session_id),
		run_id: String(row.run_id),
		owner_user_id: String(row.owner_user_id),
		graph_owner_principal: String(row.graph_owner_principal),
		graph_id: String(row.graph_id),
		workflow_name: String(row.workflow_name),
		title: String(row.title),
		title_source: titleSource,
		model: String(row.model),
		provider: String(row.provider),
		continues_json: nullableString(row.continues_json),
		seed_window_json: nullableString(row.seed_window_json),
		created_at: Number(row.created_at),
		last_activity_at: Number(row.last_activity_at),
	};
}

function rowToChatSessionListRow(row: Row): ChatSessionListRow {
	return {
		...rowToChatSessionCatalogue(row),
		session_status: String(row.session_status),
		session_lifecycle_state: String(row.session_lifecycle_state),
	};
}

function rowToAgentSession(row: Row): AgentSessionRecord {
	const status = String(row.status);
	if (!isAgentSessionStatus(status)) throw new Error(`invalid Agent Session outcome: ${status}`);
	const lifecycleState = String(row.lifecycle_state);
	if (!isAgentSessionLifecycleState(lifecycleState)) {
		throw new Error(`invalid Agent Session lifecycle state: ${lifecycleState}`);
	}
	return {
		session_id: String(row.session_id),
		run_id: String(row.run_id),
		owner_user_id: String(row.owner_user_id),
		graph_owner_principal: requireTypedGraphOwnerPrincipal(row.graph_owner_principal),
		graph_id: String(row.graph_id),
		workflow_name: String(row.workflow_name),
		node_key: String(row.node_key),
		label: String(row.label),
		phase_index: Number(row.phase_index),
		agent_id: nullableString(row.agent_id),
		sandbox_id: nullableString(row.sandbox_id),
		model: String(row.model),
		family_root_session_id: String(row.family_root_session_id),
		status,
		lifecycle_state: lifecycleState,
		frontier_json: nullableString(row.frontier_json),
		result_json: nullableString(row.result_json),
		lifecycle_terminal_digest: nullableString(row.lifecycle_terminal_digest),
		document_json: String(row.document_json),
		created_at: Number(row.created_at),
		updated_at: Number(row.updated_at),
		completed_at: nullableNumber(row.completed_at),
	};
}

function rowToAgentSessionChildRelation(row: Row): AgentSessionChildRelationRecord {
	return {
		relation_id: String(row.relation_id),
		relation_kind: "parent_child",
		parent_session_id: String(row.parent_session_id),
		child_session_id: String(row.child_session_id),
		owner_user_id: String(row.owner_user_id),
		graph_id: String(row.graph_id),
		causation_id: nullableString(row.causation_id),
		created_at: Number(row.created_at),
	};
}

function rowToAgentSessionBodyState(row: Row): AgentSessionBodyStateRecord {
	const role = String(row.role);
	if (role !== "worker" && role !== "kernel") throw new Error(`invalid Agent Session body role: ${role}`);
	const state = String(row.state);
	if (
		(role === "worker" && !isAgentWorkerBodyState(state)) ||
		(role === "kernel" && !isAgentSessionKernelState(state))
	) {
		throw new Error(`invalid ${role} body state: ${state}`);
	}
	return {
		session_id: String(row.session_id),
		generation: Number(row.generation),
		role,
		state,
		updated_at: Number(row.updated_at),
	};
}

function rowToAgentSessionChildAdmission(row: Row): AgentSessionChildAdmissionRecord {
	const budget = parseJson(String(row.budget_json));
	if (!isChildBudgetSlice(budget)) {
		throw new Error(`Agent Session child admission ${String(row.admission_id)} has an invalid budget receipt`);
	}
	return {
		admission_id: String(row.admission_id),
		parent_session_id: String(row.parent_session_id),
		request_id: String(row.request_id),
		request_digest: String(row.request_digest),
		child_session_id: String(row.child_session_id),
		child_run_id: String(row.child_run_id),
		relation_id: String(row.relation_id),
		child_name: String(row.child_name),
		depth: Number(row.depth),
		runtime_binding_digest: String(row.runtime_binding_digest),
		ontology_binding_digest: String(row.ontology_binding_digest),
		budget_allocation_id: String(row.budget_allocation_id),
		budget,
		created_at: Number(row.created_at),
	};
}

function rowToAgentSessionChildSpawnRequest(row: Row): AgentSessionChildSpawnRequestRecord {
	const decision = String(row.decision);
	if (decision !== "accepted" && decision !== "denied") throw new Error(`invalid child spawn decision: ${decision}`);
	return {
		parent_session_id: String(row.parent_session_id),
		request_id: String(row.request_id),
		request_digest: String(row.request_digest),
		decision,
		admission_id: nullableString(row.admission_id),
		child_session_id: nullableString(row.child_session_id),
		child_run_id: nullableString(row.child_run_id),
		denial_code: nullableString(row.denial_code),
		denial_message: nullableString(row.denial_message),
		created_at: Number(row.created_at),
	};
}

function rowToAgentSessionChildBudgetAllocation(row: Row): AgentSessionChildBudgetAllocationRecord {
	const budget = parseJson(String(row.budget_json));
	if (!isChildBudgetSlice(budget)) throw new Error(`invalid child budget allocation: ${String(row.allocation_id)}`);
	const state = String(row.state);
	if (state !== "reserved" && state !== "accounting_hold" && state !== "settled" && state !== "released") {
		throw new Error(`invalid child budget allocation state: ${state}`);
	}
	const holdReason = nullableString(row.hold_reason);
	if (
		(state === "accounting_hold" && holdReason !== "unresolved_child_reservations") ||
		(state !== "accounting_hold" && holdReason !== null)
	) {
		throw new Error(`invalid child budget allocation hold: ${String(row.allocation_id)}`);
	}
	return {
		allocation_id: String(row.allocation_id),
		admission_id: String(row.admission_id),
		parent_session_id: String(row.parent_session_id),
		child_session_id: String(row.child_session_id),
		state,
		budget,
		hold_reason: holdReason as AgentSessionChildBudgetAllocationRecord["hold_reason"],
		created_at: Number(row.created_at),
		held_at: nullableNumber(row.held_at),
		settled_at: nullableNumber(row.settled_at),
	};
}

function rowToAgentSessionBudgetAccount(row: Row): AgentSessionBudgetAccountRecord {
	const account: AgentSessionBudgetAccountRecord = {
		session_id: String(row.session_id),
		limit: budgetVectorFromRow(row, "limit"),
		reserved: budgetVectorFromRow(row, "reserved"),
		spent: budgetVectorFromRow(row, "spent"),
		exhausted: Number(row.exhausted) === 1,
		revision: Number(row.revision),
		created_at: Number(row.created_at),
		updated_at: Number(row.updated_at),
	};
	validateBudgetInteger(account.revision, "budget account revision");
	validateBudgetInteger(account.created_at, "budget account creation time");
	validateBudgetInteger(account.updated_at, "budget account update time");
	return account;
}

function budgetVectorFromRow(row: Row, prefix: "limit" | "reserved" | "spent"): AgentSessionBudgetVectorV1 {
	return validateAgentSessionBudgetVector(
		{
			turns: Number(row[`${prefix}_turns`]),
			wallTimeMs: Number(row[`${prefix}_wall_time_ms`]),
			tokens: Number(row[`${prefix}_tokens`]),
			costUsdMicros: Number(row[`${prefix}_cost_usd_micros`]),
			artifactBytes: Number(row[`${prefix}_artifact_bytes`]),
		},
		`${prefix} budget row`,
	);
}

function rowToAgentSessionBudgetLedgerEntry(row: Row): AgentSessionBudgetLedgerEntryRecord {
	const kind = String(row.kind) as AgentSessionBudgetLedgerEntryKind;
	if (
		![
			"account_opened",
			"child_allocated",
			"child_settled",
			"child_released",
			"inference_reserved",
			"inference_settled",
			"inference_indeterminate",
			"inference_released",
		].includes(kind)
	) {
		throw new Error(`invalid Agent Session budget ledger kind: ${kind}`);
	}
	const ordinal = Number(row.ordinal);
	const createdAt = Number(row.created_at);
	validateBudgetInteger(ordinal, "budget ledger ordinal");
	validateBudgetInteger(createdAt, "budget ledger creation time");
	return {
		entry_id: String(row.entry_id),
		session_id: String(row.session_id),
		ordinal,
		kind,
		reference_id: String(row.reference_id),
		reserved_delta: signedBudgetVectorFromRow(row, "reserved"),
		spent_delta: signedBudgetVectorFromRow(row, "spent"),
		detail: parseJson(row.detail_json),
		created_at: createdAt,
	};
}

function signedBudgetVectorFromRow(row: Row, prefix: "reserved" | "spent"): AgentSessionBudgetVectorV1 {
	const vector = {
		turns: Number(row[`${prefix}_turns_delta`]),
		wallTimeMs: Number(row[`${prefix}_wall_time_ms_delta`]),
		tokens: Number(row[`${prefix}_tokens_delta`]),
		costUsdMicros: Number(row[`${prefix}_cost_usd_micros_delta`]),
		artifactBytes: Number(row[`${prefix}_artifact_bytes_delta`]),
	};
	for (const [dimension, value] of Object.entries(vector)) {
		if (!Number.isSafeInteger(value)) throw new Error(`invalid signed budget delta ${dimension}`);
	}
	return vector;
}

function rowToAgentSessionInferenceReservation(row: Row): AgentSessionInferenceReservationRecord {
	const state = String(row.state) as AgentSessionInferenceReservationState;
	if (!["reserved", "settled", "indeterminate", "released"].includes(state)) {
		throw new Error(`invalid inference reservation state: ${state}`);
	}
	const budget = validateAgentSessionBudgetVector(parseJson(row.budget_json), "inference reservation budget");
	const usageValue = row.usage_json == null ? null : parseJson(row.usage_json);
	const usage = usageValue === null ? null : validateAgentSessionBudgetVector(usageValue, "inference usage");
	return {
		funding_source: row.funding_source === "user" ? "user" : "platform",
		operation_id: String(row.operation_id),
		session_id: String(row.session_id),
		generation: Number(row.generation),
		activation_id: String(row.activation_id),
		sandbox_id: String(row.sandbox_id),
		request_id: String(row.request_id),
		request_digest: String(row.request_digest),
		reservation_digest: String(row.reservation_digest),
		causation_id: String(row.causation_id),
		provider: String(row.provider),
		model: String(row.model),
		pricing_version: String(row.pricing_version),
		estimated_input_tokens: Number(row.estimated_input_tokens),
		max_output_tokens: Number(row.max_output_tokens),
		state,
		budget,
		usage,
		reason: nullableString(row.reason),
		created_at: Number(row.created_at),
		updated_at: Number(row.updated_at),
		terminal_at: nullableNumber(row.terminal_at),
	};
}

function rowToAgentSessionInferenceBillingOutbox(row: Row): AgentSessionInferenceBillingOutboxRecord {
	const state = String(row.state) as AgentSessionInferenceBillingOutboxRecord["state"];
	if (!["pending", "claimed", "delivered"].includes(state)) {
		throw new Error(`invalid inference billing outbox state: ${state}`);
	}
	const payload = parseJson(row.payload_json);
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error(`invalid inference billing outbox payload: ${String(row.operation_id)}`);
	}
	return {
		operation_id: String(row.operation_id),
		session_id: String(row.session_id),
		payload: payload as AgentSessionInferenceBillingEvent,
		payload_digest: String(row.payload_digest),
		state,
		consumer: nullableString(row.consumer),
		claim_token: nullableString(row.claim_token),
		claimed_at: nullableNumber(row.claimed_at),
		claim_expires_at: nullableNumber(row.claim_expires_at),
		delivered_at: nullableNumber(row.delivered_at),
		created_at: Number(row.created_at),
	};
}

function rowToAgentSessionChildGenerationOccupancy(row: Row): AgentSessionChildGenerationOccupancyRecord {
	const state = String(row.state);
	if (state !== "occupied" && state !== "released") throw new Error(`invalid child occupancy state: ${state}`);
	return {
		parent_session_id: String(row.parent_session_id),
		child_session_id: String(row.child_session_id),
		generation: Number(row.generation),
		state,
		acquired_at: Number(row.acquired_at),
		released_at: nullableNumber(row.released_at),
	};
}

function rowToAgentSessionChildRun(row: Row): AgentSessionChildRunRecord {
	const state = String(row.state) as AgentSessionChildRunState;
	if (!["queued", "claimed", "cancelling", "completed", "failed", "cancelled"].includes(state)) {
		throw new Error(`invalid Agent Session child run state: ${state}`);
	}
	return {
		child_run_id: String(row.child_run_id),
		admission_id: String(row.admission_id),
		parent_session_id: String(row.parent_session_id),
		child_session_id: String(row.child_session_id),
		state,
		attempt: Number(row.attempt),
		consumer: nullableString(row.consumer),
		claim_token: nullableString(row.claim_token),
		claimed_at: nullableNumber(row.claimed_at),
		claim_expires_at: nullableNumber(row.claim_expires_at),
		heartbeat_at: nullableNumber(row.heartbeat_at),
		materialization_generation: nullableNumber(row.materialization_generation),
		materialized_at: nullableNumber(row.materialized_at),
		result: parseJson(row.result_json),
		error: nullableString(row.error),
		terminal_digest: nullableString(row.terminal_digest),
		created_at: Number(row.created_at),
		terminal_at: nullableNumber(row.terminal_at),
	};
}

function rowToAgentSessionChildCancellationRequest(row: Row): AgentSessionChildCancellationRequestRecord {
	const actor = parseJson(row.actor_json);
	if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
		throw new Error(`invalid child cancellation actor: ${String(row.cancellation_id)}`);
	}
	const candidate = actor as Record<string, unknown>;
	const validParent =
		candidate.kind === "parent_materialization" &&
		typeof candidate.parentSessionId === "string" &&
		Number.isSafeInteger(candidate.generation) &&
		typeof candidate.activationId === "string" &&
		typeof candidate.sandboxId === "string";
	const validCascade =
		candidate.kind === "session_cascade" &&
		typeof candidate.rootSessionId === "string" &&
		typeof candidate.cascadeId === "string" &&
		typeof candidate.causeDigest === "string";
	if (!validParent && !validCascade) {
		throw new Error(`invalid child cancellation actor: ${String(row.cancellation_id)}`);
	}
	const disposition = String(row.disposition);
	if (
		disposition !== "cancelled_before_materialization" &&
		disposition !== "cancellation_pending" &&
		disposition !== "terminal_preceded"
	) {
		throw new Error(`invalid child cancellation disposition: ${disposition}`);
	}
	const observedRunState = nullableAgentSessionChildRunState(
		row.observed_run_state,
		"child cancellation observed run state",
	);
	if (!observedRunState) throw new Error("child cancellation observed run state is missing");
	return {
		cancellation_id: String(row.cancellation_id),
		child_run_id: String(row.child_run_id),
		request_id: String(row.request_id),
		request_digest: String(row.request_digest),
		actor: candidate as unknown as AgentSessionChildCancellationActor,
		reason: String(row.reason),
		disposition,
		observed_run_state: observedRunState,
		created_at: Number(row.created_at),
	};
}

function rowToAgentSessionChildClosureRequest(row: Row): AgentSessionChildClosureRequestRecord {
	const actor = rowToAgentSessionChildCancellationRequest({
		...row,
		cancellation_id: row.closure_id,
		disposition: "terminal_preceded",
		observed_run_state: "completed",
	}).actor;
	const disposition = String(row.disposition);
	if (disposition !== "closure_pending" && disposition !== "already_closed") {
		throw new Error(`invalid child closure disposition: ${disposition}`);
	}
	return {
		closure_id: String(row.closure_id),
		child_run_id: String(row.child_run_id),
		request_id: String(row.request_id),
		request_digest: String(row.request_digest),
		actor,
		reason: String(row.reason),
		disposition,
		created_at: Number(row.created_at),
	};
}

function rowToAgentSessionDescendantCascade(row: Row): AgentSessionDescendantCascadeRecord {
	const cause = String(row.cause);
	const state = String(row.state);
	if (cause !== "explicit_cancel" && cause !== "irrecoverable_fault") {
		throw new Error(`invalid descendant cascade cause: ${cause}`);
	}
	if (state !== "active" && state !== "completed") throw new Error(`invalid descendant cascade state: ${state}`);
	return {
		cascade_id: String(row.cascade_id),
		root_session_id: String(row.root_session_id),
		cause,
		cause_digest: String(row.cause_digest),
		reason: String(row.reason),
		state,
		created_at: Number(row.created_at),
		completed_at: nullableNumber(row.completed_at),
	};
}

function rowToAgentSessionChildClosureReceipt(row: Row): AgentSessionChildClosureReceiptRecord {
	const materializationState = String(row.materialization_state);
	if (!["passivated", "completed", "faulted", "cancelled"].includes(materializationState)) {
		throw new Error(`invalid child closure materialization state: ${materializationState}`);
	}
	const allocationState = String(row.allocation_state);
	if (!["accounting_hold", "settled", "released"].includes(allocationState)) {
		throw new Error(`invalid child closure allocation state: ${allocationState}`);
	}
	return {
		closure_id: String(row.closure_id),
		child_run_id: String(row.child_run_id),
		materialization_generation: Number(row.materialization_generation),
		materialization_state: materializationState as AgentSessionChildClosureReceiptRecord["materialization_state"],
		session_state: "closed",
		allocation_state: allocationState as AgentSessionChildBudgetAllocationRecord["state"],
		receipt_digest: String(row.receipt_digest),
		created_at: Number(row.created_at),
	};
}

function rowToAgentSessionChildControl(row: Row): AgentSessionChildControlRecord {
	const runState = nullableAgentSessionChildRunState(row.run_state, "child control run state");
	if (!runState) throw new Error("child control run state is missing");
	return {
		child_session_id: String(row.child_session_id),
		child_run_id: String(row.child_run_id),
		child_name: String(row.child_name),
		model: String(row.model),
		run_state: runState,
		session_state: requiredAgentSessionLifecycleState(row.session_state, "child control Session state"),
	};
}

function rowToAgentSessionFamilyProjectionOutbox(row: Row): AgentSessionFamilyProjectionOutboxRecord {
	const state = String(row.state);
	if (state !== "pending" && state !== "claimed" && state !== "delivered") {
		throw new Error(`invalid family projection outbox state: ${state}`);
	}
	const workKind = String(row.work_kind);
	if (workKind !== "project" && workKind !== "retire") {
		throw new Error(`invalid family projection outbox work kind: ${workKind}`);
	}
	return {
		root_session_id: String(row.root_session_id),
		work_kind: workKind,
		desired_revision: Number(row.desired_revision),
		delivered_revision: Number(row.delivered_revision),
		delivered_projection_revision: Number(row.delivered_projection_revision),
		state,
		claimed_revision: nullableNumber(row.claimed_revision),
		claimed_projection_revision: nullableNumber(row.claimed_projection_revision),
		consumer: nullableString(row.consumer),
		claim_token: nullableString(row.claim_token),
		claimed_at: nullableNumber(row.claimed_at),
		claim_expires_at: nullableNumber(row.claim_expires_at),
		heartbeat_at: nullableNumber(row.heartbeat_at),
		not_before: Number(row.not_before),
		last_error: nullableString(row.last_error),
		updated_at: Number(row.updated_at),
	};
}

function rowToAgentSessionChildRunRecovery(row: Row): AgentSessionChildRunRecoveryRecord {
	const run = rowToAgentSessionChildRun(row);
	const allocation = rowToAgentSessionChildBudgetAllocation({
		allocation_id: row.allocation_record_id,
		admission_id: run.admission_id,
		parent_session_id: run.parent_session_id,
		child_session_id: run.child_session_id,
		state: row.allocation_state,
		budget_json: row.allocation_budget_json,
		hold_reason: row.allocation_hold_reason,
		created_at: row.allocation_created_at,
		held_at: row.allocation_held_at,
		settled_at: row.allocation_settled_at,
	});
	const materialization = row.materialization_session_id
		? rowToAgentMaterialization({
				session_id: row.materialization_session_id,
				generation: row.materialization_record_generation,
				sandbox_id: row.materialization_sandbox_id,
				activation_id: row.materialization_activation_id,
				state: row.materialization_record_state,
				fault_kind: row.materialization_fault_kind,
				recoverable: row.materialization_recoverable,
				checkpoint_id: row.materialization_checkpoint_id,
				kernel_checkpoint_id: row.materialization_kernel_checkpoint_id,
				created_at: row.materialization_created_at,
				updated_at: row.materialization_updated_at,
				passivated_at: row.materialization_passivated_at,
			})
		: null;
	const reason: AgentSessionChildRunRecoveryRecord["reason"] =
		allocation.state === "accounting_hold"
			? "accounting_held"
			: run.state === "cancelling"
				? "cancellation_pending"
				: run.materialized_at === null
					? "claimable"
					: "materialized_lease_expired";
	return { run, allocation, materialization, reason };
}

function isChildBudgetSlice(value: unknown): value is AgentSessionChildBudgetSliceV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		candidate.schema === "choreograph.agent-session-child-budget.v1" &&
		CHILD_BUDGET_KEYS.every(
			(key) => typeof candidate[key] === "number" && Number.isSafeInteger(candidate[key]) && candidate[key] >= 0,
		)
	);
}

function rowToAgentMaterialization(row: Row): AgentMaterializationRecord {
	const state = String(row.state);
	if (!isAgentMaterializationState(state)) throw new Error(`invalid materialization state: ${state}`);
	const faultKind = nullableString(row.fault_kind);
	const recoverable = row.recoverable == null ? null : Number(row.recoverable) === 1;
	if (
		(state === "faulted" && (!isAgentMaterializationFaultKind(faultKind) || recoverable === null)) ||
		(state !== "faulted" && (faultKind !== null || recoverable !== null))
	) {
		throw new Error(`invalid materialization fault testimony: ${String(row.session_id)}:${String(row.generation)}`);
	}
	return {
		session_id: String(row.session_id),
		generation: Number(row.generation),
		sandbox_id: String(row.sandbox_id),
		activation_id: String(row.activation_id),
		state,
		fault_kind: faultKind as AgentMaterializationFaultKind | null,
		recoverable,
		checkpoint_id: nullableString(row.checkpoint_id),
		kernel_checkpoint_id: nullableString(row.kernel_checkpoint_id),
		created_at: Number(row.created_at),
		updated_at: Number(row.updated_at),
		passivated_at: nullableNumber(row.passivated_at),
	};
}

function rowToAgentSessionSchedule(row: Row): AgentSessionScheduleRecord {
	const kind = String(row.kind);
	let definition: AgentSessionScheduleDefinition;
	if (kind === "once") {
		definition = { kind: "once", fireAt: requiredProjectionInteger(row.fire_at, "once fireAt") };
	} else if (kind === "interval") {
		const intervalMs = requiredProjectionInteger(row.interval_ms, "interval intervalMs");
		if (intervalMs < 10_000) throw new Error("interval intervalMs must be at least 10000");
		definition = {
			kind: "interval",
			firstFireAt: requiredProjectionInteger(row.fire_at, "interval firstFireAt"),
			intervalMs,
		};
	} else if (kind === "cron") {
		if (row.timezone !== "UTC") throw new Error(`invalid schedule timezone: ${String(row.timezone)}`);
		definition = {
			kind: "cron",
			expression: parseAgentSessionCron(row.cron_expression).expression,
			timezone: "UTC",
		};
	} else {
		throw new Error(`invalid Agent Session schedule kind: ${kind}`);
	}
	const prompt = parseJson(row.prompt_json);
	if (
		!prompt ||
		typeof prompt !== "object" ||
		Array.isArray(prompt) ||
		typeof (prompt as Record<string, unknown>).text !== "string"
	) {
		throw new Error(`invalid Agent Session schedule prompt: ${String(row.schedule_id)}`);
	}
	const state = String(row.state);
	if (state !== "active" && state !== "paused" && state !== "completed" && state !== "cancelled") {
		throw new Error(`invalid Agent Session schedule state: ${state}`);
	}
	const source = String(row.source ?? "internal");
	if (source !== "internal" && source !== "public" && source !== "rlm_heartbeat") {
		throw new Error(`invalid Agent Session schedule source: ${source}`);
	}
	const deliveryMode = String(row.delivery_mode ?? "steer");
	if (deliveryMode !== "steer" && deliveryMode !== "follow_up") {
		throw new Error(`invalid Agent Session schedule delivery mode: ${deliveryMode}`);
	}
	const grantSnapshotDigest = nullableString(row.grant_snapshot_digest);
	if (grantSnapshotDigest !== null && !/^[0-9a-f]{64}$/.test(grantSnapshotDigest)) {
		throw new Error(`invalid Agent Session schedule grant snapshot digest: ${String(row.schedule_id)}`);
	}
	return {
		schedule_id: String(row.schedule_id),
		session_id: String(row.session_id),
		create_request_id: String(row.create_request_id),
		create_request_digest: String(row.create_request_digest),
		definition,
		prompt: { text: String((prompt as Record<string, unknown>).text) },
		client_id: String(row.client_id),
		revision: Number(row.revision ?? 0),
		source,
		label: normalizeAgentSessionScheduleLabel(nullableString(row.label)),
		delivery_mode: deliveryMode,
		grant_snapshot_digest: grantSnapshotDigest,
		state,
		next_fire_at: nullableNumber(row.next_fire_at),
		fire_count: Number(row.fire_count),
		cancel_reason: nullableString(row.cancel_reason),
		created_at: Number(row.created_at),
		updated_at: Number(row.updated_at),
		completed_at: nullableNumber(row.completed_at),
		cancelled_at: nullableNumber(row.cancelled_at),
	};
}

function rowToAgentSessionScheduleControlReceipt(row: Row): AgentSessionScheduleControlReceiptV1 {
	const disposition = String(row.disposition);
	if (disposition !== "applied" && disposition !== "no_change" && disposition !== "already_terminal") {
		throw new Error(`invalid Agent Session schedule control disposition: ${disposition}`);
	}
	return {
		schema: "choreograph.agent-session-schedule-control-receipt.v1",
		requestId: String(row.request_id),
		scheduleId: String(row.schedule_id),
		requestDigest: String(row.request_digest),
		priorRevision: Number(row.prior_revision),
		resultingRevision: Number(row.resulting_revision),
		disposition,
		priorState: String(row.prior_state) as AgentSessionScheduleState,
		resultingState: String(row.resulting_state) as AgentSessionScheduleState,
		nextFireAt:
			nullableNumber(row.next_fire_at) === null ? null : agentSessionScheduleTimestampIso(Number(row.next_fire_at)),
		committedAt: agentSessionScheduleTimestampIso(Number(row.committed_at)),
	};
}

function rowToAgentSessionScheduleCancellation(row: Row): AgentSessionScheduleCancellationRecord {
	const disposition = String(row.disposition);
	if (disposition !== "cancelled" && disposition !== "fire_preceded" && disposition !== "already_terminal") {
		throw new Error(`invalid Agent Session schedule cancellation disposition: ${disposition}`);
	}
	return {
		cancellation_id: String(row.cancellation_id),
		session_id: String(row.session_id),
		schedule_id: String(row.schedule_id),
		request_id: String(row.request_id),
		request_digest: String(row.request_digest),
		client_id: String(row.client_id),
		reason: String(row.reason),
		disposition,
		created_at: Number(row.created_at),
	};
}

function rowToAgentSessionScheduleFire(row: Row): AgentSessionScheduleFireRecord {
	const state = String(row.state);
	if (state !== "pending" && state !== "claimed" && state !== "completed" && state !== "failed") {
		throw new Error(`invalid Agent Session schedule fire state: ${state}`);
	}
	const requestedDeliveryMode = String(row.requested_delivery_mode ?? "steer");
	if (requestedDeliveryMode !== "steer" && requestedDeliveryMode !== "follow_up") {
		throw new Error(`invalid Agent Session schedule requested delivery mode: ${requestedDeliveryMode}`);
	}
	const commandName = String(row.command_name ?? "prompt");
	if (commandName !== "prompt" && commandName !== "steer" && commandName !== "follow_up") {
		throw new Error(`invalid Agent Session schedule command name: ${commandName}`);
	}
	return {
		fire_id: String(row.fire_id),
		schedule_id: String(row.schedule_id),
		session_id: String(row.session_id),
		ordinal: Number(row.ordinal),
		scheduled_at: Number(row.scheduled_at),
		coalesced_through_at: Number(row.coalesced_through_at),
		coalesced_count: Number(row.coalesced_count),
		grant_snapshot_digest: nullableString(row.grant_snapshot_digest),
		requested_delivery_mode: requestedDeliveryMode,
		command_name: commandName,
		command_id: String(row.command_id),
		target_generation: Number(row.target_generation),
		activation_id: String(row.activation_id),
		created_at: Number(row.created_at),
		state,
		attempt: Number(row.attempt),
		consumer: nullableString(row.consumer),
		claim_token: nullableString(row.claim_token),
		claimed_at: nullableNumber(row.claimed_at),
		claim_expires_at: nullableNumber(row.claim_expires_at),
		heartbeat_at: nullableNumber(row.heartbeat_at),
		not_before: Number(row.not_before),
		last_error: nullableString(row.last_error),
		completed_at: nullableNumber(row.completed_at),
	};
}

function rowToAgentSessionScheduleFireAuthorityAttempt(row: Row): AgentSessionScheduleFireAuthorityAttemptRecord {
	const outcome = String(row.outcome);
	if (outcome !== "accepted" && outcome !== "rejected" && outcome !== "unavailable") {
		throw new Error(`invalid schedule authority attempt outcome: ${outcome}`);
	}
	const digest = nullableString(row.grant_digest);
	if (digest !== null && !/^[0-9a-f]{64}$/.test(digest)) throw new Error("invalid schedule authority attempt digest");
	const revision = nullableString(row.revision);
	const code = String(row.code);
	const checkedAt = Number(row.checked_at);
	if (
		!Number.isSafeInteger(checkedAt) ||
		checkedAt < 0 ||
		!code ||
		code.length > 128 ||
		(revision !== null && revision.length > 256)
	) {
		throw new Error("invalid schedule authority attempt record");
	}
	return {
		fire_id: String(row.fire_id),
		attempt: Number(row.attempt),
		outcome,
		grant_digest: digest,
		revision,
		code,
		checked_at: checkedAt,
	};
}

function rowToAgentSessionScheduleGrantBinding(row: Row): AgentSessionScheduleGrantBindingRecord {
	const binding = parseAgentSessionScheduleGrantBinding(parseJson(row.binding_json));
	const digest = String(row.digest);
	if (binding.digest !== digest)
		throw new Error("durable Agent Session schedule grant binding digest diverged from its row");
	const capturedAt = Number(row.captured_at);
	if (!Number.isFinite(capturedAt) || capturedAt !== binding.snapshot.capturedAt) {
		throw new Error("durable Agent Session schedule grant binding capture time diverged from its row");
	}
	return {
		session_id: String(row.session_id),
		digest,
		binding,
		captured_at: capturedAt,
	};
}

function rowToAgentSessionCommand(row: Row): AgentSessionCommandRecord {
	return {
		command_id: String(row.command_id),
		session_id: String(row.session_id),
		idempotency_key: String(row.idempotency_key),
		command_digest: String(row.command_digest),
		name: String(row.name) as AgentSessionCommandName,
		payload: asRecord(parseJson(row.payload_json)),
		client_id: String(row.client_id),
		target_generation: Number(row.target_generation),
		delivery_generation: nullableNumber(row.delivery_generation),
		state: String(row.state) as AgentSessionCommandState,
		result: parseJson(row.result_json),
		error: nullableString(row.error),
		submitted_at: Number(row.submitted_at),
		delivered_at: nullableNumber(row.delivered_at),
		completed_at: nullableNumber(row.completed_at),
	};
}

function rowToAgentSessionGoalProjection(row: Row): AgentSessionGoalProjectionRecord {
	const reducerState = parseJson(row.reducer_state_json);
	const handoffState = parseJson(row.handoff_state_json);
	const updatedAt = Number(row.updated_at);
	assertGoalReducerProjectionState(reducerState);
	assertPrimeGoalHandoffProjectionState(handoffState);
	assertGoalProjectionSafeInteger(updatedAt, "updated_at");
	return {
		session_id: String(row.session_id),
		reducer_state: reducerState,
		handoff_state: handoffState,
		updated_at: updatedAt,
	};
}

/** Treat projection JSON as untrusted durable input; never revive it by cast alone. */
function assertGoalReducerProjectionState(value: unknown): asserts value is GoalReducerState {
	const state = goalProjectionRecord(value, "reducer_state");
	assertGoalProjectionKeys(
		state,
		["schema", "goals", "currentGoalId", "receipts", "hostBudgetExhausted"],
		"reducer_state",
	);
	if (state.schema !== "choreograph.agent-session-goal.v1")
		throw new Error("invalid Agent Session goal reducer schema");
	const goals = goalProjectionRecord(state.goals, "reducer_state.goals");
	const receipts = goalProjectionRecord(state.receipts, "reducer_state.receipts");
	if (state.currentGoalId !== null) {
		assertGoalProjectionIdentifier(state.currentGoalId, "reducer_state.currentGoalId");
		if (!Object.hasOwn(goals, state.currentGoalId)) throw new Error("current goal is absent from goal projection");
	}
	if (typeof state.hostBudgetExhausted !== "boolean") throw new Error("invalid goal projection budget state");
	for (const [goalId, value] of Object.entries(goals)) {
		assertGoalProjectionIdentifier(goalId, "goal id");
		const goal = goalProjectionRecord(value, `goal '${goalId}'`);
		assertGoalProjectionKeys(
			goal,
			[
				"goalId",
				"objective",
				"tokenBudget",
				"tokensUsed",
				"timeUsedSeconds",
				"continuationsUsed",
				"status",
				"revision",
				"createdAt",
				"updatedAt",
				"terminalCommandId",
				"lastReason",
			],
			`goal '${goalId}'`,
			["terminalCommandId", "lastReason"],
		);
		if (goal.goalId !== goalId) throw new Error("goal projection key does not match goal id");
		assertGoalProjectionString(goal.objective, "goal objective");
		if (!goal.objective.trim() || goal.objective.includes("\0") || [...goal.objective].length > 4_000) {
			throw new Error("invalid goal projection objective");
		}
		if (goal.tokenBudget !== null) assertGoalProjectionPositiveInteger(goal.tokenBudget, "goal token budget");
		for (const field of ["tokensUsed", "timeUsedSeconds", "continuationsUsed", "createdAt", "updatedAt"] as const) {
			assertGoalProjectionSafeInteger(goal[field], `goal ${field}`);
		}
		if (goal.updatedAt < goal.createdAt) throw new Error("goal projection timestamp regressed");
		assertGoalProjectionPositiveInteger(goal.revision, "goal revision");
		if (!["active", "paused", "budget_limited", "complete", "error"].includes(String(goal.status))) {
			throw new Error("invalid goal projection status");
		}
		if (goal.terminalCommandId !== undefined)
			assertGoalProjectionIdentifier(goal.terminalCommandId, "terminal command id");
		if (goal.lastReason !== undefined) assertGoalProjectionString(goal.lastReason, "goal reason");
	}
	for (const [idempotencyKey, value] of Object.entries(receipts)) {
		assertGoalProjectionIdentifier(idempotencyKey, "goal receipt idempotency key");
		const receipt = goalProjectionRecord(value, `goal receipt '${idempotencyKey}'`);
		assertGoalProjectionKeys(
			receipt,
			["idempotencyKey", "operationDigest", "goalId", "revision", "eventSequence"],
			`goal receipt '${idempotencyKey}'`,
		);
		if (receipt.idempotencyKey !== idempotencyKey) throw new Error("goal receipt key does not match idempotency key");
		assertGoalProjectionDigest(receipt.operationDigest, "goal receipt digest");
		assertGoalProjectionIdentifier(receipt.goalId, "goal receipt goal id");
		if (!Object.hasOwn(goals, receipt.goalId)) throw new Error("goal receipt references an absent goal");
		assertGoalProjectionPositiveInteger(receipt.revision, "goal receipt revision");
		if (receipt.eventSequence !== null)
			assertGoalProjectionSafeInteger(receipt.eventSequence, "goal receipt event sequence");
	}
}

function assertPrimeGoalHandoffProjectionState(value: unknown): asserts value is PrimeGoalHandoffState {
	const state = goalProjectionRecord(value, "handoff_state");
	assertGoalProjectionKeys(
		state,
		["schema", "commands", "idempotencyKeys", "workerReceipts", "pendingGoalUpdate", "terminalGoals"],
		"handoff_state",
	);
	if (state.schema !== "choreograph.prime-goal-command-handoff.v1")
		throw new Error("invalid Agent Session goal handoff schema");
	const commands = goalProjectionRecord(state.commands, "handoff_state.commands");
	const idempotencyKeys = goalProjectionRecord(state.idempotencyKeys, "handoff_state.idempotencyKeys");
	for (const [commandId, value] of Object.entries(commands)) {
		assertGoalProjectionIdentifier(commandId, "handoff command id");
		const command = goalProjectionRecord(value, `handoff command '${commandId}'`);
		assertGoalProjectionKeys(
			command,
			["commandId", "idempotencyKey", "name", "resultDigest"],
			`handoff command '${commandId}'`,
			["resultDigest"],
		);
		if (command.commandId !== commandId) throw new Error("handoff command key does not match command id");
		assertGoalProjectionIdentifier(command.idempotencyKey, "handoff idempotency key");
		if (!["goal.get", "goal.create", "goal.complete"].includes(String(command.name))) {
			throw new Error("invalid handoff goal command name");
		}
		if (command.resultDigest !== undefined) assertGoalProjectionDigest(command.resultDigest, "handoff result digest");
	}
	for (const [idempotencyKey, commandId] of Object.entries(idempotencyKeys)) {
		assertGoalProjectionIdentifier(idempotencyKey, "handoff idempotency key");
		assertGoalProjectionIdentifier(commandId, "handoff command id");
		const command = commands[commandId];
		if (!command || goalProjectionRecord(command, "handoff command").idempotencyKey !== idempotencyKey) {
			throw new Error("handoff idempotency index is inconsistent");
		}
	}
	const workerReceipts = goalProjectionRecord(state.workerReceipts, "handoff_state.workerReceipts");
	for (const [receiptKey, value] of Object.entries(workerReceipts)) {
		assertGoalProjectionIdentifier(receiptKey, "handoff worker receipt key");
		const receipt = goalProjectionRecord(value, `handoff worker receipt '${receiptKey}'`);
		assertGoalProjectionKeys(receipt, ["digest"], `handoff worker receipt '${receiptKey}'`);
		assertGoalProjectionDigest(receipt.digest, "handoff worker receipt digest");
	}
	if (state.pendingGoalUpdate !== null) {
		const witness = goalProjectionRecord(state.pendingGoalUpdate, "handoff goal witness");
		assertGoalProjectionKeys(witness, ["sessionId", "generation", "workerSequence"], "handoff goal witness");
		assertGoalProjectionIdentifier(witness.sessionId, "handoff witness session id");
		assertGoalProjectionSafeInteger(witness.generation, "handoff witness generation");
		assertGoalProjectionSafeInteger(witness.workerSequence, "handoff witness worker sequence");
	}
	const terminalGoals = goalProjectionRecord(state.terminalGoals, "handoff_state.terminalGoals");
	for (const [goalId, commandId] of Object.entries(terminalGoals)) {
		assertGoalProjectionIdentifier(goalId, "handoff terminal goal id");
		assertGoalProjectionIdentifier(commandId, "handoff terminal command id");
		const command = commands[commandId];
		if (!command || goalProjectionRecord(command, "handoff terminal command").name !== "goal.complete") {
			throw new Error("handoff terminal ownership is inconsistent");
		}
	}
}

function goalProjectionRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid Agent Session ${label}`);
	return value as Record<string, unknown>;
}

function assertGoalProjectionKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	label: string,
	optional: readonly string[] = [],
): void {
	if (
		Object.keys(value).some((key) => !allowed.includes(key)) ||
		allowed.some((key) => !optional.includes(key) && !Object.hasOwn(value, key))
	) {
		throw new Error(`invalid Agent Session ${label} keys`);
	}
}

function assertGoalProjectionString(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.includes("\0")) throw new Error(`invalid Agent Session ${label}`);
}

function assertGoalProjectionIdentifier(value: unknown, label: string): asserts value is string {
	assertGoalProjectionString(value, label);
	if (!value.trim()) throw new Error(`invalid Agent Session ${label}`);
}

function assertGoalProjectionSafeInteger(value: unknown, label: string): asserts value is number {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid Agent Session ${label}`);
}

function assertGoalProjectionPositiveInteger(value: unknown, label: string): asserts value is number {
	assertGoalProjectionSafeInteger(value, label);
	if (value < 1) throw new Error(`invalid Agent Session ${label}`);
}

function assertGoalProjectionDigest(value: unknown, label: string): void {
	if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
		throw new Error(`invalid Agent Session ${label}`);
	}
}

function rowToAgentSessionCommandActivation(row: Row): AgentSessionCommandActivationRecord {
	const state = String(row.state);
	if (state !== "pending" && state !== "claimed" && state !== "completed" && state !== "failed") {
		throw new Error(`invalid Agent Session command activation state: ${state}`);
	}
	const targetGeneration = Number(row.target_generation);
	const attempt = Number(row.attempt);
	const notBefore = Number(row.not_before);
	if (
		!Number.isSafeInteger(targetGeneration) ||
		targetGeneration < 0 ||
		!Number.isSafeInteger(attempt) ||
		attempt < 0 ||
		!Number.isSafeInteger(notBefore) ||
		notBefore < 0
	) {
		throw new Error("invalid Agent Session command activation coordinates");
	}
	return {
		command_id: String(row.command_id),
		session_id: String(row.session_id),
		target_generation: targetGeneration,
		activation_id: String(row.activation_id),
		grant_snapshot_digest: nullableString(row.grant_snapshot_digest),
		state,
		attempt,
		consumer: nullableString(row.consumer),
		claim_token: nullableString(row.claim_token),
		claimed_at: nullableNumber(row.claimed_at),
		claim_expires_at: nullableNumber(row.claim_expires_at),
		heartbeat_at: nullableNumber(row.heartbeat_at),
		not_before: notBefore,
		last_error: nullableString(row.last_error),
		completed_at: nullableNumber(row.completed_at),
	};
}

function rowToEffectIdempotency(row: Row): EffectIdempotencyRecord {
	return {
		idempotency_key: String(row.idempotency_key),
		proposal_digest: String(row.proposal_digest),
		run_id: String(row.run_id),
		status: String(row.status) as EffectIdempotencyRecord["status"],
		receipt: parseJson(row.receipt_json),
		claimed_at: Number(row.claimed_at),
		completed_at: nullableNumber(row.completed_at),
	};
}

function rowToDomainSourceTurn(row: Row): DomainSourceTurnRecord {
	return {
		turn_id: String(row.turn_id),
		turn_digest: String(row.turn_digest),
		source_ref: String(row.source_ref),
		source_digest: String(row.source_digest),
		trigger_digest: String(row.trigger_digest),
		context_digest: String(row.context_digest),
		owner_principal: String(row.owner_principal),
		graph_id: String(row.graph_id),
		agent_id: String(row.agent_id),
		actor_ref: String(row.actor_ref),
		auth_method: String(row.auth_method) as DomainSourceTurnRecord["auth_method"],
		trigger_adapter: nullableString(row.trigger_adapter),
		first_invocation_id: String(row.first_invocation_id),
		turn: parseJson(row.turn_json),
		created_at: Number(row.created_at),
		updated_at: Number(row.updated_at),
	};
}

function rowToEffectHandoff(row: Row): EffectHandoffRecord {
	return {
		idempotency_key: String(row.idempotency_key),
		execution_digest: String(row.execution_digest),
		proposal_digest: String(row.proposal_digest),
		run_id: String(row.run_id),
		graph_id: String(row.graph_id),
		agent_id: String(row.agent_id),
		actor_ref: String(row.actor_ref),
		grant_id: String(row.grant_id),
		grant_document_id: String(row.grant_document_id),
		grant_authority_graph_id: String(row.grant_authority_graph_id),
		grant_authority_owner_principal: String(row.grant_authority_owner_principal),
		grant_digest: String(row.grant_digest),
		definition_digest: nullableString(row.definition_digest),
		source_turn_id: nullableString(row.source_turn_id),
		source_turn_digest: nullableString(row.source_turn_digest),
		source_owner_principal: nullableString(row.source_owner_principal),
		source_turn: parseJson(row.source_turn_json),
		capability: String(row.capability),
		operation: String(row.operation),
		proposal: parseJson(row.proposal_json),
		trigger: parseJson(row.trigger_json),
		approval: parseJson(row.approval_json),
		effect_index: Number(row.effect_index),
		state: String(row.state) as EffectHandoffState,
		attempt: Number(row.attempt),
		consumer: nullableString(row.consumer),
		claim_token: nullableString(row.claim_token),
		lease_expires_at: nullableNumber(row.lease_expires_at),
		not_before: Number(row.not_before),
		completion: parseJson(row.completion_json),
		created_at: Number(row.created_at),
		updated_at: Number(row.updated_at),
		completed_at: nullableNumber(row.completed_at),
	};
}

function rowToAgentSessionEvent(row: Row): AgentSessionEvent {
	return {
		session_id: String(row.session_id),
		seq: Number(row.seq),
		ts: Number(row.ts),
		type: String(row.type),
		causation_id: nullableString(row.causation_id),
		command_id: nullableString(row.command_id),
		payload: parseJson(row.payload_json),
	};
}

function rowToExecutionCell(row: Row): ExecutionCellRecord {
	return {
		session_id: String(row.session_id),
		ordinal: Number(row.ordinal),
		cell_ref: String(row.cell_ref),
		lease_id: String(row.lease_id),
		kernel_sandbox_id: String(row.kernel_sandbox_id),
		input_id: String(row.input_id),
		code: String(row.code),
		status: String(row.status),
		execution_count: row.execution_count == null ? null : Number(row.execution_count),
		outputs_json: String(row.outputs_json),
		generation: Number(row.generation),
		host_requests_json: String(row.host_requests_json),
		cell_digest: String(row.cell_digest),
		started_at: Number(row.started_at),
		completed_at: Number(row.completed_at),
		duration_ms: Number(row.duration_ms),
	};
}

function executionCellRecordMatchesCell(record: ExecutionCellRecord, cell: ExecutionCell): boolean {
	return (
		record.session_id === cell.sessionId &&
		record.ordinal === cell.ordinal &&
		record.cell_ref === cell.cellRef &&
		record.lease_id === cell.leaseId &&
		record.kernel_sandbox_id === cell.kernelSandboxId &&
		record.input_id === cell.inputId &&
		record.code === cell.code &&
		record.status === cell.status &&
		record.execution_count === (cell.executionCount ?? null) &&
		canonicalJson(JSON.parse(record.outputs_json)) === canonicalJson(cell.outputs) &&
		record.generation === cell.generation &&
		canonicalJson(JSON.parse(record.host_requests_json)) === canonicalJson(cell.hostRequests) &&
		record.cell_digest === cell.cellDigest &&
		record.started_at === cell.startedAt &&
		record.completed_at === cell.completedAt &&
		record.duration_ms === cell.durationMs
	);
}

function rowToAgentSessionDocumentOp(row: Row): AgentSessionDocumentOp {
	const document = parseJson(row.document_json);
	return {
		session_id: String(row.session_id),
		rev: Number(row.rev),
		change_id: String(row.change_id),
		ts: Number(row.ts),
		actor: String(row.actor),
		kind: String(row.kind),
		patch: parseJson(row.patch_json),
		document:
			document && typeof document === "object" && !Array.isArray(document)
				? (document as Record<string, unknown>)
				: {},
	};
}

function nullableString(value: unknown): string | null {
	return value == null ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
	return value == null ? null : Number(value);
}

function requiredProjectionString(value: unknown, label: string): string {
	if (value == null) throw new Error(`${label} is missing`);
	const text = String(value);
	if (!text) throw new Error(`${label} is empty`);
	return text;
}

function requiredProjectionInteger(value: unknown, label: string): number {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is not a non-negative integer`);
	return number;
}

function requiredProjectionBoolean(value: unknown, label: string): boolean {
	const number = Number(value);
	if (number !== 0 && number !== 1) throw new Error(`${label} is not a boolean`);
	return number === 1;
}

function requiredAgentSessionLifecycleState(value: unknown, label: string): AgentSessionLifecycleState {
	const state = requiredProjectionString(value, label);
	if (!isAgentSessionLifecycleState(state)) throw new Error(`${label} is invalid: ${state}`);
	return state;
}

function nullableAgentSessionChildRunState(value: unknown, label: string): AgentSessionChildRunState | null {
	if (value == null) return null;
	const state = String(value);
	if (!["queued", "claimed", "cancelling", "completed", "failed", "cancelled"].includes(state)) {
		throw new Error(`${label} is invalid: ${state}`);
	}
	return state as AgentSessionChildRunState;
}

function requiredAllocationHoldReason(
	value: unknown,
	label: string,
): AgentSessionChildBudgetAllocationRecord["hold_reason"] {
	if (value !== "unresolved_child_reservations") throw new Error(`${label} is invalid`);
	return value;
}

function requiredMaterializationFaultKind(value: unknown, label: string): AgentMaterializationFaultKind {
	const kind = requiredProjectionString(value, label);
	if (!isAgentMaterializationFaultKind(kind)) throw new Error(`${label} is invalid: ${kind}`);
	return kind;
}

function projectionMaterializationFacts(
	row: Row,
	prefix: "root" | "",
	label: string,
): Pick<
	AgentSessionFamilyProjectionRoot,
	| "materializationState"
	| "materializationGeneration"
	| "materializationFaultKind"
	| "materializationRecoverable"
	| "workerState"
	| "kernelState"
> {
	const key = (name: string) => (prefix ? `${prefix}_${name}` : name);
	const materializationState = nullableString(row[key("materialization_state")]);
	if (materializationState !== null && !isAgentMaterializationState(materializationState)) {
		throw new Error(`${label} has invalid materialization state`);
	}
	const materializationGeneration =
		row[key("materialization_generation")] == null
			? null
			: requiredProjectionInteger(row[key("materialization_generation")], `${label} materialization generation`);
	if ((materializationState === null) !== (materializationGeneration === null)) {
		throw new Error(`${label} materialization state/generation must be present together`);
	}
	const workerState = nullableString(row[key("worker_state")]);
	if (workerState !== null && !isAgentMaterializationState(workerState)) {
		throw new Error(`${label} has invalid worker state`);
	}
	const kernelState = nullableString(row[key("kernel_state")]);
	if (kernelState !== null && !isAgentSessionKernelState(kernelState)) {
		throw new Error(`${label} has invalid kernel state`);
	}
	if (workerState === null) {
		if (kernelState !== null) throw new Error(`${label} exposes kernel testimony without its worker body`);
		return {
			materializationState: null,
			materializationGeneration: null,
			materializationFaultKind: null,
			materializationRecoverable: null,
			workerState: null,
			kernelState: null,
		};
	}
	if (materializationState === null || materializationGeneration === null) {
		throw new Error(`${label} exposes worker testimony without its materialization`);
	}
	const rawFaultKind = nullableString(row[key("materialization_fault_kind")]);
	const rawRecoverable = row[key("materialization_recoverable")];
	if (materializationState === "faulted") {
		return {
			materializationState,
			materializationGeneration,
			materializationFaultKind: requiredMaterializationFaultKind(rawFaultKind, `${label} fault kind`),
			materializationRecoverable: requiredProjectionBoolean(rawRecoverable, `${label} recoverable`),
			workerState: workerState as AgentMaterializationState | null,
			kernelState: kernelState as AgentSessionKernelState | null,
		};
	}
	if (rawFaultKind !== null || rawRecoverable != null)
		throw new Error(`${label} exposes fault testimony while not faulted`);
	return {
		materializationState: materializationState as AgentMaterializationState | null,
		materializationGeneration,
		materializationFaultKind: null,
		materializationRecoverable: null,
		workerState: workerState as AgentMaterializationState | null,
		kernelState: kernelState as AgentSessionKernelState | null,
	};
}

function isAgentSessionChildAllocationState(value: string): value is AgentSessionChildBudgetAllocationRecord["state"] {
	return value === "reserved" || value === "accounting_hold" || value === "settled" || value === "released";
}

function isAgentMaterializationState(value: string): value is AgentMaterializationState {
	return [
		"claimed",
		"running",
		"quiescing",
		"quiescent",
		"passivated",
		"completed",
		"faulted",
		"cancelled",
		"authority_revoked",
	].includes(value);
}

function isAgentWorkerBodyState(value: string): value is Exclude<AgentMaterializationState, "authority_revoked"> {
	return isAgentMaterializationState(value) && value !== "authority_revoked";
}

function isAgentSessionStatus(value: string): value is AgentSessionStatus {
	return (
		value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "cancelled"
	);
}

function isAgentSessionLifecycleState(value: string): value is AgentSessionLifecycleState {
	return value === "open" || value === "closing" || value === "closed" || value === "faulted";
}

function isAgentMaterializationFaultKind(value: string | null): value is AgentMaterializationFaultKind {
	return (
		value !== null &&
		[
			"worker_spawn",
			"worker_exit",
			"worker_timeout",
			"worker_oom",
			"worker_protocol",
			"kernel_fault",
			"quiescence_fault",
			"checkpoint_fault",
			"replay_divergence",
			"host_invariant",
		].includes(value)
	);
}

function isAgentSessionKernelState(value: string): value is AgentSessionKernelState {
	return (
		value === "running" ||
		value === "released" ||
		value === "shutdown" ||
		value === "faulted" ||
		value === "cancelled"
	);
}

function isTerminalAgentSessionChildRunState(state: AgentSessionChildRunState): boolean {
	return state === "completed" || state === "failed" || state === "cancelled";
}

function agentMaterializationTransitionEventType(state: AgentMaterializationState): string | null {
	if (state === "faulted") return "runtime.fault";
	if (state === "quiescing" || state === "quiescent" || state === "passivated") return `runtime.${state}`;
	return null;
}

function isLegalAgentSessionBodyTransition(
	role: AgentSessionBodyRole,
	from: AgentSessionBodyStateRecord["state"],
	to: string,
): boolean {
	if (role === "kernel") {
		const legal: Record<AgentSessionKernelState, readonly AgentSessionKernelState[]> = {
			running: ["released", "shutdown", "faulted", "cancelled"],
			// `released` detaches the current worker from a retained kernel. It may
			// become `running` only through the record-time live-materialization fence
			// above; terminal transitions remain one-way.
			released: ["running", "shutdown", "faulted", "cancelled"],
			shutdown: [],
			faulted: [],
			cancelled: [],
		};
		return legal[from as AgentSessionKernelState]?.includes(to as AgentSessionKernelState) ?? false;
	}
	const legal: Record<AgentMaterializationState, readonly AgentMaterializationState[]> = {
		claimed: ["running", "completed", "faulted", "cancelled", "authority_revoked"],
		running: ["quiescing", "quiescent", "passivated", "completed", "faulted", "cancelled"],
		quiescing: ["quiescent", "faulted", "cancelled"],
		quiescent: ["passivated", "faulted", "cancelled"],
		passivated: [],
		completed: [],
		faulted: [],
		cancelled: [],
		authority_revoked: [],
	};
	return legal[from as AgentMaterializationState]?.includes(to as AgentMaterializationState) ?? false;
}

function parseJson(value: unknown): unknown {
	if (typeof value !== "string" || value.length === 0) {
		return undefined;
	}
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function validatePhanesPrivacyRetirementScope(scope: PhanesPrivacyRetirementScope): void {
	if (!/^[0-9a-f]{32}$/.test(scope.activeEpochId)) throw new Error("active Phanes privacy epoch is invalid");
	if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(scope.homeGraphId)) {
		throw new Error("Phanes home graph id is invalid");
	}
	if (!scope.ownerUserId.trim() || !scope.graphOwnerPrincipal.trim() || !scope.workflowName.trim()) {
		throw new Error("Phanes privacy retirement scope is incomplete");
	}
}

function privacyEpochFromWorkflowInputs(serialized: string): string | undefined {
	let inputs: unknown;
	try {
		inputs = JSON.parse(serialized);
	} catch {
		return undefined;
	}
	if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) return undefined;
	const record = inputs as Record<string, unknown>;
	for (const candidate of [record.hostContext, record.schemaInput]) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
		const trigger = (candidate as Record<string, unknown>).trigger;
		if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) continue;
		const epoch = (trigger as Record<string, unknown>).datasetEpoch;
		if (!epoch || typeof epoch !== "object" || Array.isArray(epoch)) continue;
		const epochId = (epoch as Record<string, unknown>).epochId;
		if (typeof epochId === "string" && /^[0-9a-f]{32}$/.test(epochId)) return epochId;
	}
	return undefined;
}

function privacyEpochFromSourceRef(sourceRef: string): string | undefined {
	return /^urn:phanes:dataset-epoch:([0-9a-f]{32}):source-event:/.exec(sourceRef)?.[1];
}

function sqlPlaceholders(count: number): string {
	if (!Number.isInteger(count) || count < 1) throw new Error("SQL placeholder count must be positive");
	return Array.from({ length: count }, () => "?").join(", ");
}
