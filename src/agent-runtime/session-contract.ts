import {
	AGENT_SESSION_SCHEDULE_UPDATED_PAYLOAD_SCHEMA,
	type AgentSessionScheduleControlActionV1,
	type AgentSessionScheduleUpdatedPayloadV1,
} from "./agent-session-schedule-control.js";

export { AGENT_SESSION_SCHEDULE_UPDATED_PAYLOAD_SCHEMA };

export const AGENT_SESSION_EVENT_SCHEMA = "choreograph.agent-session-event.v1" as const;
export const AGENT_SESSION_COMMAND_SCHEMA = "choreograph.agent-session-command.v1" as const;
export const AGENT_SESSION_SCHEDULE_CREATED_PAYLOAD_SCHEMA = "choreograph.agent-session-schedule-created.v1" as const;
export const AGENT_SESSION_SCHEDULE_FIRED_PAYLOAD_SCHEMA = "choreograph.agent-session-schedule-fired.v1" as const;
export const AGENT_SESSION_SCHEDULE_CANCELLED_PAYLOAD_SCHEMA =
	"choreograph.agent-session-schedule-cancelled.v1" as const;

export type AgentSessionVisibility = "public" | "driver" | "host";

export interface AgentSessionActorV1 {
	readonly principalId: string;
	readonly agentId?: string;
	readonly observerId?: string;
}

export interface AgentSessionSandboxGenerationV1 {
	readonly id: string;
	readonly generation: number;
	readonly workerSequence?: number;
}

export type AgentSessionScheduleKindV1 = "once" | "interval" | "cron";

/** G1 is deliberately UTC-only; widening timezone support requires a new reviewed contract. */
export type AgentSessionScheduleSpecV1 =
	| {
			readonly kind: "interval";
			readonly expression: string;
			readonly timeZone: "UTC";
			readonly intervalMs: number;
	  }
	| {
			readonly kind: Exclude<AgentSessionScheduleKindV1, "interval">;
			readonly expression: string;
			readonly timeZone: "UTC";
	  };

export interface AgentSessionScheduledInputV1 {
	readonly text: string;
	readonly attachmentRefs?: readonly string[];
}

export interface AgentSessionScheduleCreatedPayloadV1 {
	readonly schema: typeof AGENT_SESSION_SCHEDULE_CREATED_PAYLOAD_SCHEMA;
	readonly scheduleId: string;
	readonly requestId: string;
	readonly schedule: AgentSessionScheduleSpecV1;
	readonly input: AgentSessionScheduledInputV1;
	readonly nextFireAt: string;
}

export interface AgentSessionScheduleFiredPayloadV1 {
	readonly schema: typeof AGENT_SESSION_SCHEDULE_FIRED_PAYLOAD_SCHEMA;
	readonly scheduleId: string;
	readonly fireId: string;
	readonly commandId: string;
	readonly scheduledAt: string;
	readonly claimedAt: string;
	readonly nextFireAt: string | null;
}

export type AgentSessionScheduleCancellationReasonV1 =
	| "requested"
	| "session_closed"
	| "session_faulted"
	| "authority_revoked";

export interface AgentSessionScheduleCancelledPayloadV1 {
	readonly schema: typeof AGENT_SESSION_SCHEDULE_CANCELLED_PAYLOAD_SCHEMA;
	readonly scheduleId: string;
	readonly requestId: string;
	readonly reason: AgentSessionScheduleCancellationReasonV1;
}

export interface AgentSessionEventPayloadsV1 {
	readonly "schedule.created": AgentSessionScheduleCreatedPayloadV1;
	readonly "schedule.fired": AgentSessionScheduleFiredPayloadV1;
	readonly "schedule.cancelled": AgentSessionScheduleCancelledPayloadV1;
	readonly "schedule.updated": AgentSessionScheduleUpdatedPayloadV1;
}

export type AgentSessionEventPayloadV1<Type extends AgentSessionEventTypeV1> =
	Type extends keyof AgentSessionEventPayloadsV1 ? AgentSessionEventPayloadsV1[Type] : unknown;

export interface AgentSessionEventEnvelopeV1<Type extends AgentSessionEventTypeV1 = AgentSessionEventTypeV1> {
	readonly schema: typeof AGENT_SESSION_EVENT_SCHEMA;
	readonly eventId: string;
	readonly sessionId: string;
	readonly sequence: number;
	readonly sandbox?: AgentSessionSandboxGenerationV1;
	readonly type: Type;
	readonly payloadVersion: number;
	readonly occurredAt: string;
	readonly committedAt: string;
	readonly actor: AgentSessionActorV1;
	readonly causationId?: string;
	readonly correlationId: string;
	readonly commandId?: string;
	readonly visibility: AgentSessionVisibility;
	readonly payload: AgentSessionEventPayloadV1<Type>;
}

export const AGENT_SESSION_EVENT_TYPES = [
	"command.accepted",
	"command.rejected",
	"command.completed",
	"command.failed",
	"command.cancelled",
	"input.prompt",
	"input.follow_up",
	"input.steer",
	"turn.started",
	"turn.completed",
	"turn.failed",
	"message.delta",
	"message.completed",
	"reasoning.delta",
	"tool.started",
	"tool.completed",
	"tool.failed",
	"capability.called",
	"goal.updated",
	"schedule.created",
	"schedule.fired",
	"schedule.cancelled",
	"schedule.updated",
	"compaction.started",
	"compaction.completed",
	"refine.completed",
	"refine.failed",
	"recap.updated",
	"workflow.proposed",
	"workflow.accepted",
	"workflow.rejected",
	"budget.ledger_updated",
	"budget.exhausted",
	"compute.cell",
	"runtime.bound",
	"runtime.quiescing",
	"runtime.quiescent",
	"runtime.passivated",
	"runtime.resumed",
	"runtime.fault",
	"kernel.checkpointed",
	"child.spawn_requested",
	"child.created",
	"child.run.completed",
	"child.run.failed",
	"child.run.cancelled",
] as const;

export type AgentSessionEventTypeV1 = (typeof AGENT_SESSION_EVENT_TYPES)[number];

/**
 * Design annex only. These names came from the pre-ratification vocabulary but
 * have no production-ratified envelope emitter. Durable stores may stage facts
 * under these names while an implementation bite is still being integrated,
 * but they are deliberately excluded from
 * {@link AgentSessionEventTypeV1} and rejected by the v1 envelope validator
 * until an implementation bite gives each one an evidence-producing source.
 */
export const DRAFT_AGENT_SESSION_EVENT_TYPES = [
	"session.created",
	"session.closed",
	"session.faulted",
	"permission.resolved",
	"runtime.ready",
	"reasoning.completed",
	"tool.requested",
	"tool.permission_required",
	"tool.progress",
	"model.requested",
	"model.usage",
	"model.failed",
	"goal.created",
	"goal.completed",
	"child.message",
	"refine.started",
	"refine.proposed",
	"artifact.published",
	"workspace.checkpointed",
] as const;

export type DraftAgentSessionEventType = (typeof DRAFT_AGENT_SESSION_EVENT_TYPES)[number];

export interface AgentSessionCommandPayloadsV1 {
	prompt: {
		readonly text: string;
		readonly attachmentRefs?: readonly string[];
	};
	steer: {
		readonly text: string;
	};
	follow_up: {
		readonly text: string;
	};
	abort: {
		readonly reason?: string;
	};
	"permission.resolve": {
		readonly permissionRequestId: string;
		readonly decision: "allow_once" | "allow_session" | "deny";
		readonly reason?: string;
	};
	compact: {
		readonly reason?: string;
	};
	"goal.create": {
		readonly objective: string;
		readonly tokenBudget?: number;
	};
	"goal.get": Record<string, never>;
	"goal.complete": Record<string, never>;
	"goal.update": {
		readonly goalId: string;
		readonly objective?: string;
		readonly status?: "active" | "complete" | "blocked" | "cancelled";
	};
	"schedule.create": {
		readonly scheduleId: string;
		readonly schedule: AgentSessionScheduleSpecV1;
		readonly input: AgentSessionScheduledInputV1;
		readonly nextFireAt: string;
	};
	"schedule.cancel": {
		readonly scheduleId: string;
	};
	"model.change": {
		readonly model: string;
	};
	quiesce: {
		readonly reason?: string;
	};
}

export type AgentSessionCommandNameV1 = keyof AgentSessionCommandPayloadsV1;

export type AgentSessionCommandV1 = {
	[Name in AgentSessionCommandNameV1]: {
		readonly schema: typeof AGENT_SESSION_COMMAND_SCHEMA;
		readonly commandId: string;
		readonly idempotencyKey: string;
		readonly sessionId: string;
		readonly expectedRevision?: number;
		readonly expectedGeneration?: number;
		readonly actor: AgentSessionActorV1;
		readonly driverLeaseId?: string;
		readonly submittedAt: string;
		readonly deadlineMs?: number;
		readonly name: Name;
		readonly payload: AgentSessionCommandPayloadsV1[Name];
	};
}[AgentSessionCommandNameV1];

export class AgentSessionContractFault extends Error {
	readonly code = "agent_session_contract_invalid";

	constructor(
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "AgentSessionContractFault";
	}
}

const EVENT_TYPES = new Set<string>(AGENT_SESSION_EVENT_TYPES);
const COMMAND_NAMES = new Set<string>([
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"permission.resolve",
	"compact",
	"goal.create",
	"goal.get",
	"goal.complete",
	"goal.update",
	"schedule.create",
	"schedule.cancel",
	"model.change",
	"quiesce",
]);

export function validateAgentSessionEventEnvelope(value: unknown): asserts value is AgentSessionEventEnvelopeV1 {
	if (!isRecord(value)) throw contractFault("session event must be an object");
	if (value.schema !== AGENT_SESSION_EVENT_SCHEMA) throw contractFault("session event schema is unsupported");
	for (const key of ["eventId", "sessionId", "correlationId"] as const) assertString(value[key], key);
	assertInteger(value.sequence, "sequence", 0);
	assertInteger(value.payloadVersion, "payloadVersion", 1);
	assertTimestamp(value.occurredAt, "occurredAt");
	assertTimestamp(value.committedAt, "committedAt");
	if (!EVENT_TYPES.has(String(value.type)))
		throw contractFault("session event type is unsupported", { type: value.type });
	if (!["public", "driver", "host"].includes(String(value.visibility))) {
		throw contractFault("session event visibility is unsupported");
	}
	validateActor(value.actor);
	if (value.sandbox !== undefined) validateSandbox(value.sandbox);
	optionalString(value.causationId, "causationId");
	optionalString(value.commandId, "commandId");
	if (!Object.hasOwn(value, "payload")) throw contractFault("session event payload is required");
	validateEventPayload(String(value.type), value);
}

export function validateAgentSessionCommand(value: unknown): asserts value is AgentSessionCommandV1 {
	if (!isRecord(value)) throw contractFault("session command must be an object");
	if (value.schema !== AGENT_SESSION_COMMAND_SCHEMA) throw contractFault("session command schema is unsupported");
	for (const key of ["commandId", "idempotencyKey", "sessionId"] as const) assertString(value[key], key);
	if (!COMMAND_NAMES.has(String(value.name)))
		throw contractFault("session command name is unsupported", { name: value.name });
	validateActor(value.actor);
	assertTimestamp(value.submittedAt, "submittedAt");
	if (value.expectedRevision !== undefined) assertInteger(value.expectedRevision, "expectedRevision", 0);
	if (value.expectedGeneration !== undefined) assertInteger(value.expectedGeneration, "expectedGeneration", 0);
	if (value.deadlineMs !== undefined) assertInteger(value.deadlineMs, "deadlineMs", 1);
	optionalString(value.driverLeaseId, "driverLeaseId");
	if (!isRecord(value.payload)) throw contractFault("session command payload must be an object");
	validateCommandPayload(String(value.name), value.payload);
}

export function agentSessionWorkerDedupeKey(event: AgentSessionEventEnvelopeV1): string | undefined {
	if (!event.sandbox || event.sandbox.workerSequence === undefined) return undefined;
	return [
		event.sessionId,
		event.sandbox.id,
		String(event.sandbox.generation),
		String(event.sandbox.workerSequence),
	].join(":");
}

function validateCommandPayload(name: string, payload: Record<string, unknown>): void {
	switch (name) {
		case "prompt":
		case "steer":
		case "follow_up":
			assertString(payload.text, "payload.text");
			return;
		case "abort":
		case "compact":
		case "quiesce":
			optionalString(payload.reason, "payload.reason");
			return;
		case "permission.resolve":
			assertString(payload.permissionRequestId, "payload.permissionRequestId");
			if (!["allow_once", "allow_session", "deny"].includes(String(payload.decision))) {
				throw contractFault("payload.decision is unsupported");
			}
			return;
		case "goal.create":
			assertKnownKeys(payload, ["objective", "tokenBudget"], "payload");
			assertString(payload.objective, "payload.objective");
			if (payload.objective.includes("\0") || [...payload.objective].length > 4_000) {
				throw contractFault("payload.objective is not a bounded goal objective");
			}
			if (payload.tokenBudget !== undefined) assertInteger(payload.tokenBudget, "payload.tokenBudget", 1);
			return;
		case "goal.get":
		case "goal.complete":
			assertKnownKeys(payload, [], "payload");
			return;
		case "goal.update":
			assertString(payload.goalId, "payload.goalId");
			optionalString(payload.objective, "payload.objective");
			if (
				payload.status !== undefined &&
				!["active", "complete", "blocked", "cancelled"].includes(String(payload.status))
			) {
				throw contractFault("payload.status is unsupported");
			}
			return;
		case "schedule.create":
			assertKnownKeys(payload, ["scheduleId", "schedule", "input", "nextFireAt"], "payload");
			assertString(payload.scheduleId, "payload.scheduleId");
			validateScheduleSpec(payload.schedule, "payload.schedule");
			validateScheduledInput(payload.input, "payload.input");
			assertTimestamp(payload.nextFireAt, "payload.nextFireAt");
			return;
		case "schedule.cancel":
			assertKnownKeys(payload, ["scheduleId"], "payload");
			assertString(payload.scheduleId, "payload.scheduleId");
			return;
		case "model.change":
			assertString(payload.model, "payload.model");
			return;
		default:
			throw contractFault("unhandled session command", { name });
	}
}

function validateEventPayload(type: string, envelope: Record<string, unknown>): void {
	if (
		type !== "schedule.created" &&
		type !== "schedule.fired" &&
		type !== "schedule.cancelled" &&
		type !== "schedule.updated"
	)
		return;
	assertString(envelope.causationId, `${type} causationId`);
	if (!isRecord(envelope.payload)) throw contractFault(`${type} payload must be an object`);
	const payload = envelope.payload;
	if (type === "schedule.created") {
		assertKnownKeys(payload, ["schema", "scheduleId", "requestId", "schedule", "input", "nextFireAt"], type);
		if (payload.schema !== AGENT_SESSION_SCHEDULE_CREATED_PAYLOAD_SCHEMA) {
			throw contractFault(`${type} payload schema is unsupported`);
		}
		assertString(payload.scheduleId, `${type} payload.scheduleId`);
		assertRequestCausation(envelope, payload, type);
		validateScheduleSpec(payload.schedule, `${type} payload.schedule`);
		validateScheduledInput(payload.input, `${type} payload.input`);
		assertTimestamp(payload.nextFireAt, `${type} payload.nextFireAt`);
		return;
	}
	if (type === "schedule.fired") {
		assertKnownKeys(
			payload,
			["schema", "scheduleId", "fireId", "commandId", "scheduledAt", "claimedAt", "nextFireAt"],
			type,
		);
		if (payload.schema !== AGENT_SESSION_SCHEDULE_FIRED_PAYLOAD_SCHEMA) {
			throw contractFault(`${type} payload schema is unsupported`);
		}
		assertString(payload.scheduleId, `${type} payload.scheduleId`);
		assertString(payload.fireId, `${type} payload.fireId`);
		assertString(payload.commandId, `${type} payload.commandId`);
		assertString(envelope.commandId, `${type} commandId`);
		if (payload.commandId !== envelope.commandId) throw contractFault(`${type} commandId does not match its payload`);
		if (payload.fireId !== envelope.causationId) throw contractFault(`${type} causationId must equal payload.fireId`);
		assertTimestamp(payload.scheduledAt, `${type} payload.scheduledAt`);
		assertTimestamp(payload.claimedAt, `${type} payload.claimedAt`);
		if (payload.nextFireAt !== null) assertTimestamp(payload.nextFireAt, `${type} payload.nextFireAt`);
		return;
	}
	if (type === "schedule.updated") {
		assertKnownKeys(
			payload,
			[
				"schema",
				"scheduleId",
				"requestId",
				"priorRevision",
				"resultingRevision",
				"action",
				"priorState",
				"resultingState",
				"nextFireAt",
			],
			type,
		);
		if (payload.schema !== AGENT_SESSION_SCHEDULE_UPDATED_PAYLOAD_SCHEMA) {
			throw contractFault(`${type} payload schema is unsupported`);
		}
		assertString(payload.scheduleId, `${type} payload.scheduleId`);
		assertRequestCausation(envelope, payload, type);
		assertInteger(payload.priorRevision, `${type} payload.priorRevision`, 0);
		assertInteger(payload.resultingRevision, `${type} payload.resultingRevision`, 1);
		if (payload.resultingRevision !== payload.priorRevision + 1) {
			throw contractFault(`${type} must advance the schedule revision exactly once`);
		}
		validateScheduleControlAction(payload.action, `${type} payload.action`);
		if (payload.priorState !== "active" && payload.priorState !== "paused") {
			throw contractFault(`${type} payload.priorState is unsupported`);
		}
		if (payload.resultingState !== "active" && payload.resultingState !== "paused") {
			throw contractFault(`${type} payload.resultingState is unsupported`);
		}
		if (payload.action.kind === "pause") {
			if (payload.priorState !== "active" || payload.resultingState !== "paused" || payload.nextFireAt !== null) {
				throw contractFault(`${type} pause testimony is inconsistent`);
			}
		} else if (payload.action.kind === "resume") {
			if (payload.priorState !== "paused" || payload.resultingState !== "active") {
				throw contractFault(`${type} resume testimony is inconsistent`);
			}
		} else if (payload.priorState !== payload.resultingState) {
			throw contractFault(`${type} update cannot change lifecycle state`);
		}
		if (payload.nextFireAt !== null) assertTimestamp(payload.nextFireAt, `${type} payload.nextFireAt`);
		if ((payload.resultingState === "active") !== (payload.nextFireAt !== null)) {
			throw contractFault(`${type} nextFireAt does not match resulting lifecycle state`);
		}
		return;
	}

	assertKnownKeys(payload, ["schema", "scheduleId", "requestId", "reason"], type);
	if (payload.schema !== AGENT_SESSION_SCHEDULE_CANCELLED_PAYLOAD_SCHEMA) {
		throw contractFault(`${type} payload schema is unsupported`);
	}
	assertString(payload.scheduleId, `${type} payload.scheduleId`);
	assertRequestCausation(envelope, payload, type);
	if (!["requested", "session_closed", "session_faulted", "authority_revoked"].includes(String(payload.reason))) {
		throw contractFault(`${type} payload.reason is unsupported`);
	}
}

function assertRequestCausation(
	envelope: Record<string, unknown>,
	payload: Record<string, unknown>,
	type: "schedule.created" | "schedule.cancelled" | "schedule.updated",
): void {
	assertString(payload.requestId, `${type} payload.requestId`);
	if (envelope.commandId !== undefined) throw contractFault(`${type} must not name an activation command`);
	if (payload.requestId !== envelope.causationId) throw contractFault(`${type} causationId must equal requestId`);
}

function validateScheduleControlAction(
	value: unknown,
	label: string,
): asserts value is AgentSessionScheduleControlActionV1 {
	if (!isRecord(value)) throw contractFault(`${label} must be an object`);
	if (value.kind === "pause" || value.kind === "resume") {
		assertKnownKeys(value, ["kind"], label);
		return;
	}
	if (value.kind !== "update") throw contractFault(`${label}.kind is unsupported`);
	assertKnownKeys(value, ["kind", "schedule", "input", "label", "deliveryMode"], label);
	if (Object.keys(value).length === 1) throw contractFault(`${label} must name a changed field`);
	if (value.schedule !== undefined) validateScheduleSpec(value.schedule, `${label}.schedule`);
	if (value.input !== undefined) {
		if (!isRecord(value.input)) throw contractFault(`${label}.input must be an object`);
		assertKnownKeys(value.input, ["text"], `${label}.input`);
		assertString(value.input.text, `${label}.input.text`);
	}
	if (value.label !== undefined && value.label !== null) assertString(value.label, `${label}.label`);
	if (value.deliveryMode !== undefined && value.deliveryMode !== "steer" && value.deliveryMode !== "follow_up") {
		throw contractFault(`${label}.deliveryMode is unsupported`);
	}
}

function validateScheduleSpec(value: unknown, label: string): asserts value is AgentSessionScheduleSpecV1 {
	if (!isRecord(value)) throw contractFault(`${label} must be an object`);
	assertKnownKeys(value, ["kind", "expression", "timeZone", "intervalMs"], label);
	if (!(["once", "interval", "cron"] as const).includes(value.kind as AgentSessionScheduleKindV1)) {
		throw contractFault(`${label}.kind is unsupported`);
	}
	assertString(value.expression, `${label}.expression`);
	if (value.timeZone !== "UTC") throw contractFault(`${label}.timeZone must be UTC`);
	if (value.kind === "interval") {
		assertInteger(value.intervalMs, `${label}.intervalMs`, 10_000);
	} else if (Object.hasOwn(value, "intervalMs")) {
		throw contractFault(`${label}.intervalMs is only valid for interval schedules`);
	}
}

function validateScheduledInput(value: unknown, label: string): asserts value is AgentSessionScheduledInputV1 {
	if (!isRecord(value)) throw contractFault(`${label} must be an object`);
	assertKnownKeys(value, ["text", "attachmentRefs"], label);
	assertString(value.text, `${label}.text`);
	if (value.attachmentRefs === undefined) return;
	if (!Array.isArray(value.attachmentRefs)) throw contractFault(`${label}.attachmentRefs must be an array`);
	for (const [index, ref] of value.attachmentRefs.entries()) assertString(ref, `${label}.attachmentRefs[${index}]`);
}

function validateActor(value: unknown): asserts value is AgentSessionActorV1 {
	if (!isRecord(value)) throw contractFault("actor must be an object");
	assertString(value.principalId, "actor.principalId");
	optionalString(value.agentId, "actor.agentId");
	optionalString(value.observerId, "actor.observerId");
}

function validateSandbox(value: unknown): asserts value is AgentSessionSandboxGenerationV1 {
	if (!isRecord(value)) throw contractFault("sandbox must be an object");
	assertString(value.id, "sandbox.id");
	assertInteger(value.generation, "sandbox.generation", 0);
	if (value.workerSequence !== undefined) assertInteger(value.workerSequence, "sandbox.workerSequence", 0);
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
	assertString(value, label);
	if (Number.isNaN(Date.parse(value))) throw contractFault(`${label} must be an ISO timestamp`);
}

function assertString(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) throw contractFault(`${label} is required`);
}

function optionalString(value: unknown, label: string): void {
	if (value !== undefined) assertString(value, label);
}

function assertKnownKeys(value: object, allowed: readonly string[], label: string): void {
	const names = new Set(allowed);
	const unknown = Object.keys(value).filter((key) => !names.has(key));
	if (unknown.length > 0) throw contractFault(`${label} contains unknown fields`, { unknown });
}

function assertInteger(value: unknown, label: string, minimum: number): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
		throw contractFault(`${label} must be a safe integer >= ${String(minimum)}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contractFault(message: string, details?: unknown): AgentSessionContractFault {
	return new AgentSessionContractFault(message, details);
}
