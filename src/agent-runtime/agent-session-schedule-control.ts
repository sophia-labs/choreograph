import type { AgentSessionScheduleSpecV1 } from "./session-contract.js";

export const AGENT_SESSION_SCHEDULE_CONTROL_SCHEMA = "choreograph.agent-session-schedule-control.v1" as const;
export const AGENT_SESSION_SCHEDULE_CONTROL_RECEIPT_SCHEMA =
	"choreograph.agent-session-schedule-control-receipt.v1" as const;
export const AGENT_SESSION_SCHEDULE_UPDATED_PAYLOAD_SCHEMA = "choreograph.agent-session-schedule-updated.v1" as const;

export type AgentSessionScheduleDeliveryModeV1 = "steer" | "follow_up";
export type AgentSessionScheduleSourceV1 = "internal" | "public" | "rlm_heartbeat";
export type AgentSessionScheduleLifecycleStateV1 = "active" | "paused" | "completed" | "cancelled";
export type AgentSessionScheduleControlDispositionV1 = "applied" | "no_change" | "already_terminal";

/** Optional G2 authority/presentation fields layered onto the G1 create input. */
export interface AgentSessionScheduleCreationOptionsV1 {
	readonly source?: AgentSessionScheduleSourceV1;
	readonly label?: string | null;
	readonly deliveryMode?: AgentSessionScheduleDeliveryModeV1;
	/** Null is permitted only for the existing G1 host-tool-free path. */
	readonly grantSnapshotDigest?: string | null;
}

/** G2 remains text-only; scheduled attachment authority is a later reviewed widening. */
export interface AgentSessionScheduleControlInputV1 {
	readonly text: string;
}

/**
 * One future-only mutation. A fire created before this control commits retains
 * its immutable instruction, delivery, grant, generation, and activation.
 */
export type AgentSessionScheduleControlActionV1 =
	| {
			readonly kind: "update";
			readonly schedule?: AgentSessionScheduleSpecV1;
			readonly input?: AgentSessionScheduleControlInputV1;
			/** Empty or null clears the presentation-only label. */
			readonly label?: string | null;
			readonly deliveryMode?: AgentSessionScheduleDeliveryModeV1;
	  }
	| { readonly kind: "pause" }
	| { readonly kind: "resume" };

/** Actor and clock testimony are host-derived and therefore absent from caller bytes. */
export interface AgentSessionScheduleControlRequestV1 {
	readonly schema: typeof AGENT_SESSION_SCHEDULE_CONTROL_SCHEMA;
	readonly requestId: string;
	readonly scheduleId: string;
	readonly expectedRevision?: number;
	readonly action: AgentSessionScheduleControlActionV1;
}

/** Immutable idempotency/first-wins testimony for one control request. */
export interface AgentSessionScheduleControlReceiptV1 {
	readonly schema: typeof AGENT_SESSION_SCHEDULE_CONTROL_RECEIPT_SCHEMA;
	readonly requestId: string;
	readonly scheduleId: string;
	readonly requestDigest: string;
	readonly priorRevision: number;
	readonly resultingRevision: number;
	readonly disposition: AgentSessionScheduleControlDispositionV1;
	readonly priorState: AgentSessionScheduleLifecycleStateV1;
	readonly resultingState: AgentSessionScheduleLifecycleStateV1;
	readonly nextFireAt: string | null;
	readonly committedAt: string;
}

/** Canonical applied-control testimony emitted only by the durable store transaction. */
export interface AgentSessionScheduleUpdatedPayloadV1 {
	readonly schema: typeof AGENT_SESSION_SCHEDULE_UPDATED_PAYLOAD_SCHEMA;
	readonly scheduleId: string;
	readonly requestId: string;
	readonly priorRevision: number;
	readonly resultingRevision: number;
	/** Exact normalized control admitted by the durable transaction. */
	readonly action: AgentSessionScheduleControlActionV1;
	readonly priorState: AgentSessionScheduleLifecycleStateV1;
	readonly resultingState: AgentSessionScheduleLifecycleStateV1;
	readonly nextFireAt: string | null;
}
