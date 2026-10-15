import type { AgentSpawnRequest, AgentSpawnResult } from "../wire-protocol.js";
import type { PrimeRuntimeStateV2 } from "./result-validation.js";
import type { AgentSessionEventTypeV1 } from "./session-contract.js";

const PRIME_GOAL_OBJECTIVE_MAX_CHARS = 4_000;
const PRIME_GOAL_ID_MAX_CHARS = 512;
const PRIME_COMPLETION_BUDGET_REPORT_MAX_CHARS = 4_000;

export type PrimeSerializedGoalV1 = {
	readonly goal_id?: string;
	readonly objective: string;
	readonly status: "active" | "paused" | "budget_limited" | "complete" | "error";
	readonly token_budget?: number;
	readonly tokens_used: number;
	readonly time_used_seconds: number;
	readonly created_at?: number;
	readonly updated_at?: number;
};

export type PrimeGoalHostResponseV1 = {
	readonly goal: PrimeSerializedGoalV1 | null;
	readonly remaining_tokens: number | null;
	readonly completion_budget_report: string | null;
};

export const PRIME_HOST_PROTOCOL_VERSION = "choreograph.prime-host-bridge.v1" as const;

export interface PrimeHostMessageContextV1 {
	readonly protocol: typeof PRIME_HOST_PROTOCOL_VERSION;
	readonly messageId: string;
	readonly sessionId: string;
	readonly sandboxId: string;
	readonly generation: number;
	readonly correlationId: string;
	readonly causationId?: string;
	readonly commandId?: string;
	readonly deadlineMs?: number;
}

export type PrimeHostSpawnRequestV1 = AgentSpawnRequest & {
	/**
	 * Materialize the resident runtime without inventing an initial turn. The
	 * first durable input.prompt command produces both the runtime result and
	 * its command result.
	 */
	readonly await_initial_command?: true;
};

export interface PrimeHostCommandPayloads {
	"runtime.initialize": {
		readonly request: PrimeHostSpawnRequestV1;
		readonly sessionRevision: number;
	};
	"runtime.restore": {
		readonly request: PrimeHostSpawnRequestV1;
		readonly sessionRevision: number;
		readonly state: PrimeRuntimeStateV2;
	};
	"input.prompt": {
		readonly text: string;
		readonly attachmentRefs?: readonly string[];
	};
	"input.steer": {
		readonly text: string;
	};
	"input.follow_up": {
		readonly text: string;
	};
	"input.abort": {
		readonly reason?: string;
	};
	"permission.resolve": {
		readonly permissionRequestId: string;
		readonly decision: "allow_once" | "allow_session" | "deny";
		readonly reason?: string;
	};
	"compact.request": {
		readonly reason: "manual" | "context_pressure" | "passivation";
	};
	"model.change": {
		readonly model: string;
	};
	"runtime.quiesce": {
		readonly reason: "idle" | "shutdown" | "migration" | "budget" | "operator";
		readonly drainDeadlineMs: number;
	};
	"runtime.snapshot": {
		readonly reason: "manual" | "passivation" | "migration";
	};
	"runtime.shutdown": {
		readonly reason: string;
	};
	"goal.get": Record<string, never>;
	"goal.create": {
		readonly objective: string;
		readonly tokenBudget?: number;
	};
	"goal.complete": Record<string, never>;
}

export type PrimeHostCommandName = keyof PrimeHostCommandPayloads;

export type PrimeHostCommandV1 = {
	[Name in PrimeHostCommandName]: PrimeHostMessageContextV1 & {
		readonly direction: "host_to_worker";
		readonly kind: "command";
		readonly name: Name;
		readonly payload: PrimeHostCommandPayloads[Name];
	};
}[PrimeHostCommandName];

export interface PrimeWorkerRequestPayloads {
	"inference.request": {
		readonly requestId: string;
		readonly model: unknown;
		readonly context: unknown;
	};
	"capability.request": {
		readonly requestId: string;
		readonly capability: string;
		readonly tool: string;
		readonly args: Record<string, unknown>;
		readonly idempotencyKey?: string;
	};
	"kernel.request": {
		readonly requestId: string;
		readonly operation: "acquire" | "execute" | "interrupt" | "release" | "shutdown";
		readonly leaseId?: string;
		readonly code?: string;
		readonly internal?: boolean;
	};
	"request.cancel": {
		readonly requestId: string;
		readonly targetRequestId: string;
		readonly reason?: string;
	};
	"artifact.put": {
		readonly requestId: string;
		readonly mediaType: string;
		readonly byteLength: number;
		readonly contentDigest: string;
		readonly transferRef: string;
	};
	"artifact.get": {
		readonly requestId: string;
		readonly artifactId: string;
	};
	"workspace.checkpoint": {
		readonly requestId: string;
		readonly reason: string;
	};
	"kernel.checkpoint": {
		readonly requestId: string;
		readonly reason: string;
	};
	"workflow.propose": {
		readonly requestId: string;
		readonly proposalId: string;
		readonly runId: string;
		readonly expectedRevision: number;
		readonly proposal: unknown;
	};
	"session.append": {
		readonly requestId: string;
		readonly entryId: string;
		readonly entry: unknown;
	};
}

export type PrimeWorkerRequestName = keyof PrimeWorkerRequestPayloads;

export type PrimeWorkerRequestV1 = {
	[Name in PrimeWorkerRequestName]: PrimeHostMessageContextV1 & {
		readonly direction: "worker_to_host";
		readonly kind: "request";
		readonly workerSequence: number;
		readonly name: Name;
		readonly payload: PrimeWorkerRequestPayloads[Name];
	};
}[PrimeWorkerRequestName];

export const PRIME_WORKER_EVENT_NAMES = [
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
	"goal.updated",
	"compaction.started",
	"compaction.completed",
	"refine.completed",
	"refine.failed",
	"recap.updated",
	"budget.exhausted",
] as const satisfies readonly AgentSessionEventTypeV1[];

export type PrimeWorkerEventName = (typeof PRIME_WORKER_EVENT_NAMES)[number];

export interface PrimeWorkerEventV1 extends PrimeHostMessageContextV1 {
	readonly direction: "worker_to_host";
	readonly kind: "event";
	readonly workerSequence: number;
	readonly name: PrimeWorkerEventName;
	readonly payload: unknown;
}

export interface PrimeHostResponseV1 extends PrimeHostMessageContextV1 {
	readonly direction: "host_to_worker";
	readonly kind: "response";
	readonly requestId: string;
	readonly ok: boolean;
	readonly result?: unknown;
	readonly error?: PrimeHostErrorV1;
}

export interface PrimeWorkerResultV1 extends PrimeHostMessageContextV1 {
	readonly direction: "worker_to_host";
	readonly kind: "result";
	readonly workerSequence: number;
	readonly name: "runtime.result";
	readonly payload: { readonly result: AgentSpawnResult };
}

export interface PrimeCommandResultV1 extends PrimeHostMessageContextV1 {
	readonly direction: "worker_to_host";
	readonly kind: "result";
	readonly workerSequence: number;
	readonly name: "command.result";
	readonly commandId: string;
	readonly payload: {
		readonly commandId: string;
		readonly commandName:
			| "input.prompt"
			| "input.follow_up"
			| "input.steer"
			| "input.abort"
			| "runtime.quiesce"
			| "goal.get"
			| "goal.create"
			| "goal.complete";
		readonly status: "completed" | "failed";
		readonly result?: AgentSpawnResult | PrimeGoalHostResponseV1;
		readonly error?: string;
	};
}

export interface PrimeHostErrorV1 {
	readonly code: string;
	readonly class:
		| "invalid"
		| "denied"
		| "not_found"
		| "conflict"
		| "cancelled"
		| "deadline"
		| "budget"
		| "unavailable"
		| "internal";
	readonly message: string;
	readonly retryable: boolean;
	readonly details?: unknown;
}

export type PrimeHostBridgeMessageV1 =
	| PrimeHostCommandV1
	| PrimeWorkerRequestV1
	| PrimeWorkerEventV1
	| PrimeHostResponseV1
	| PrimeWorkerResultV1
	| PrimeCommandResultV1;

export class PrimeHostProtocolFault extends Error {
	readonly code = "prime_host_protocol_invalid";

	constructor(
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "PrimeHostProtocolFault";
	}
}

const HOST_COMMAND_NAMES = new Set<string>([
	"runtime.initialize",
	"runtime.restore",
	"input.prompt",
	"input.steer",
	"input.follow_up",
	"input.abort",
	"permission.resolve",
	"compact.request",
	"model.change",
	"runtime.quiesce",
	"runtime.snapshot",
	"runtime.shutdown",
	"goal.get",
	"goal.create",
	"goal.complete",
]);

const WORKER_REQUEST_NAMES = new Set<string>([
	"inference.request",
	"capability.request",
	"kernel.request",
	"request.cancel",
	"artifact.put",
	"artifact.get",
	"workspace.checkpoint",
	"kernel.checkpoint",
	"workflow.propose",
	"session.append",
]);

const WORKER_EVENT_NAMES = new Set<string>(PRIME_WORKER_EVENT_NAMES);

/**
 * Strictly validate the transport envelope before message-specific code sees it.
 * Payload validation stays at the named handler boundary so schemas can evolve
 * independently while unknown directions, kinds, names, and generations fail.
 */
export function parsePrimeHostBridgeMessage(value: unknown): PrimeHostBridgeMessageV1 {
	if (!isRecord(value)) throw protocolFault("bridge message must be an object");
	assertExactString(value.protocol, PRIME_HOST_PROTOCOL_VERSION, "protocol");
	for (const field of ["messageId", "sessionId", "sandboxId", "correlationId"] as const) {
		assertNonEmptyString(value[field], field);
	}
	assertNonNegativeInteger(value.generation, "generation");
	optionalNonEmptyString(value.causationId, "causationId");
	optionalNonEmptyString(value.commandId, "commandId");
	if (value.deadlineMs !== undefined) assertPositiveInteger(value.deadlineMs, "deadlineMs");

	if (value.direction === "host_to_worker" && value.kind === "command") {
		assertKnownName(value.name, HOST_COMMAND_NAMES, "host command");
		if (["goal.get", "goal.create", "goal.complete"].includes(String(value.name))) {
			assertNonEmptyString(value.commandId, `${String(value.name)} commandId`);
		}
		if (!isRecord(value.payload)) throw protocolFault("host command payload must be an object");
		validateHostCommandPayload(String(value.name), value.payload);
		return value as unknown as PrimeHostCommandV1;
	}
	if (value.direction === "worker_to_host" && value.kind === "request") {
		assertNonNegativeInteger(value.workerSequence, "workerSequence");
		assertKnownName(value.name, WORKER_REQUEST_NAMES, "worker request");
		if (!isRecord(value.payload)) throw protocolFault("worker request payload must be an object");
		validateWorkerRequestPayload(String(value.name), value.payload);
		return value as unknown as PrimeWorkerRequestV1;
	}
	if (value.direction === "worker_to_host" && value.kind === "event") {
		assertNonNegativeInteger(value.workerSequence, "workerSequence");
		assertKnownName(value.name, WORKER_EVENT_NAMES, "worker event");
		if (["input.prompt", "input.follow_up", "input.steer"].includes(String(value.name))) {
			assertNonEmptyString(value.commandId, `${String(value.name)} event commandId`);
		}
		if (!Object.hasOwn(value, "payload")) throw protocolFault("worker event payload is required");
		validateWorkerEventPayload(String(value.name), value.payload);
		return value as unknown as PrimeWorkerEventV1;
	}
	if (value.direction === "host_to_worker" && value.kind === "response") {
		assertNonEmptyString(value.requestId, "requestId");
		if (typeof value.ok !== "boolean") throw protocolFault("response ok must be boolean");
		if (value.ok && value.error !== undefined) throw protocolFault("successful response cannot contain an error");
		if (!value.ok) validateHostError(value.error);
		return value as unknown as PrimeHostResponseV1;
	}
	if (value.direction === "worker_to_host" && value.kind === "result") {
		assertNonNegativeInteger(value.workerSequence, "workerSequence");
		if (value.name === "runtime.result") {
			if (!isRecord(value.payload) || !isRecord(value.payload.result)) {
				throw protocolFault("worker result payload.result must be an object");
			}
			return value as unknown as PrimeWorkerResultV1;
		}
		if (value.name === "command.result") {
			assertNonEmptyString(value.commandId, "commandId");
			if (!isRecord(value.payload)) throw protocolFault("command result payload must be an object");
			assertKnownKeys(
				value.payload,
				["commandId", "commandName", "status", "result", "error"],
				"command result payload",
			);
			assertNonEmptyString(value.payload.commandId, "payload.commandId");
			if (value.payload.commandId !== value.commandId) throw protocolFault("command result ids do not match");
			if (
				![
					"input.prompt",
					"input.follow_up",
					"input.steer",
					"input.abort",
					"runtime.quiesce",
					"goal.get",
					"goal.create",
					"goal.complete",
				].includes(String(value.payload.commandName))
			) {
				throw protocolFault("payload.commandName is unsupported");
			}
			if (!["completed", "failed"].includes(String(value.payload.status))) {
				throw protocolFault("payload.status is unsupported");
			}
			const goalCommand = ["goal.get", "goal.create", "goal.complete"].includes(String(value.payload.commandName));
			if (value.payload.result !== undefined && !isRecord(value.payload.result)) {
				throw protocolFault("payload.result must be an object");
			}
			if (value.payload.status === "completed" && value.payload.error !== undefined) {
				throw protocolFault("completed command result cannot contain an error");
			}
			if (value.payload.status === "failed") {
				if (value.payload.result !== undefined)
					throw protocolFault("failed command result cannot contain a result");
				assertNonEmptyString(value.payload.error, "failed command result error");
			}
			if (goalCommand && value.payload.status === "completed" && value.payload.result === undefined) {
				throw protocolFault("completed goal command result requires a goal response");
			}
			if (goalCommand && value.payload.result !== undefined) validatePrimeGoalHostResponse(value.payload.result);
			if (!goalCommand && value.payload.result !== undefined && isPrimeGoalHostResponse(value.payload.result)) {
				throw protocolFault("non-goal command result cannot contain a goal response");
			}
			optionalNonEmptyString(value.payload.error, "payload.error");
			return value as unknown as PrimeCommandResultV1;
		}
		throw protocolFault("worker result name is unsupported", { name: value.name });
	}
	throw protocolFault("unsupported bridge direction/kind", {
		direction: value.direction,
		kind: value.kind,
	});
}

export function primeHostDedupeKey(
	message: PrimeWorkerRequestV1 | PrimeWorkerEventV1 | PrimeWorkerResultV1 | PrimeCommandResultV1,
): string {
	return [message.sessionId, String(message.generation), String(message.workerSequence)].join(":");
}

function validateHostCommandPayload(name: string, payload: Record<string, unknown>): void {
	switch (name) {
		case "runtime.initialize":
			assertNonNegativeInteger(payload.sessionRevision, "payload.sessionRevision");
			validatePrimeHostSpawnRequest(payload.request);
			return;
		case "runtime.restore":
			assertNonNegativeInteger(payload.sessionRevision, "payload.sessionRevision");
			validatePrimeHostSpawnRequest(payload.request);
			if (!isRecord(payload.state)) throw protocolFault("payload.state must be an object");
			return;
		case "input.prompt":
		case "input.steer":
		case "input.follow_up":
			assertNonEmptyString(payload.text, "payload.text");
			return;
		case "input.abort":
		case "runtime.shutdown":
			optionalNonEmptyString(payload.reason, "payload.reason");
			return;
		case "goal.get":
		case "goal.complete":
			assertKnownKeys(payload, [], `${name} payload`);
			return;
		case "goal.create":
			assertKnownKeys(payload, ["objective", "tokenBudget"], "goal.create payload");
			assertGoalText(payload.objective, "goal.create payload.objective", PRIME_GOAL_OBJECTIVE_MAX_CHARS);
			if (payload.tokenBudget !== undefined)
				assertPositiveInteger(payload.tokenBudget, "goal.create payload.tokenBudget");
			return;
		case "permission.resolve":
			assertNonEmptyString(payload.permissionRequestId, "payload.permissionRequestId");
			if (!["allow_once", "allow_session", "deny"].includes(String(payload.decision))) {
				throw protocolFault("payload.decision is invalid");
			}
			return;
		case "compact.request":
			if (!["manual", "context_pressure", "passivation"].includes(String(payload.reason))) {
				throw protocolFault("payload.reason is invalid");
			}
			return;
		case "model.change":
			assertNonEmptyString(payload.model, "payload.model");
			return;
		case "runtime.quiesce":
			if (!["idle", "shutdown", "migration", "budget", "operator"].includes(String(payload.reason))) {
				throw protocolFault("payload.reason is invalid");
			}
			assertPositiveInteger(payload.drainDeadlineMs, "payload.drainDeadlineMs");
			return;
		case "runtime.snapshot":
			if (!["manual", "passivation", "migration"].includes(String(payload.reason))) {
				throw protocolFault("payload.reason is invalid");
			}
			return;
		default:
			throw protocolFault("unhandled host command", { name });
	}
}

function validatePrimeHostSpawnRequest(value: unknown): asserts value is PrimeHostSpawnRequestV1 {
	if (!isRecord(value)) throw protocolFault("payload.request must be an object");
	if (Object.hasOwn(value, "await_initial_command") && value.await_initial_command !== true) {
		throw protocolFault("payload.request.await_initial_command must be true when present");
	}
}

function validateWorkerRequestPayload(name: string, payload: Record<string, unknown>): void {
	assertNonEmptyString(payload.requestId, "payload.requestId");
	switch (name) {
		case "inference.request":
			if (!isRecord(payload.model)) throw protocolFault("payload.model must be an object");
			if (!Object.hasOwn(payload, "context")) throw protocolFault("payload.context is required");
			return;
		case "capability.request":
			assertNonEmptyString(payload.capability, "payload.capability");
			assertNonEmptyString(payload.tool, "payload.tool");
			if (!isRecord(payload.args)) throw protocolFault("payload.args must be an object");
			optionalNonEmptyString(payload.idempotencyKey, "payload.idempotencyKey");
			return;
		case "kernel.request":
			assertNonEmptyString(payload.requestId, "payload.requestId");
			if (!["acquire", "execute", "interrupt", "release", "shutdown"].includes(String(payload.operation))) {
				throw protocolFault("payload.operation is not a supported kernel operation");
			}
			optionalNonEmptyString(payload.leaseId, "payload.leaseId");
			if (payload.code !== undefined && typeof payload.code !== "string") {
				throw protocolFault("payload.code must be a string");
			}
			if (payload.internal !== undefined && typeof payload.internal !== "boolean") {
				throw protocolFault("payload.internal must be a boolean");
			}
			if (payload.operation === "execute" && typeof payload.code !== "string") {
				throw protocolFault("kernel execute requires payload.code");
			}
			return;
		case "request.cancel":
			assertNonEmptyString(payload.targetRequestId, "payload.targetRequestId");
			optionalNonEmptyString(payload.reason, "payload.reason");
			return;
		case "artifact.put":
			assertNonEmptyString(payload.mediaType, "payload.mediaType");
			assertNonNegativeInteger(payload.byteLength, "payload.byteLength");
			assertNonEmptyString(payload.contentDigest, "payload.contentDigest");
			assertNonEmptyString(payload.transferRef, "payload.transferRef");
			return;
		case "artifact.get":
			assertNonEmptyString(payload.artifactId, "payload.artifactId");
			return;
		case "workspace.checkpoint":
		case "kernel.checkpoint":
			assertNonEmptyString(payload.reason, "payload.reason");
			return;
		case "workflow.propose":
			assertNonEmptyString(payload.proposalId, "payload.proposalId");
			assertNonEmptyString(payload.runId, "payload.runId");
			assertNonNegativeInteger(payload.expectedRevision, "payload.expectedRevision");
			if (!Object.hasOwn(payload, "proposal")) throw protocolFault("payload.proposal is required");
			return;
		case "session.append":
			assertNonEmptyString(payload.entryId, "payload.entryId");
			if (!Object.hasOwn(payload, "entry")) throw protocolFault("payload.entry is required");
			return;
		default:
			throw protocolFault("unhandled worker request", { name });
	}
}

function validateWorkerEventPayload(name: string, value: unknown): void {
	if (!isRecord(value)) throw protocolFault(`worker event ${name} payload must be an object`);
	switch (name) {
		case "input.prompt":
		case "input.follow_up":
		case "input.steer":
			assertNonEmptyString(value.text, "payload.text");
			optionalNonEmptyString(value.clientId, "payload.clientId");
			return;
		case "turn.started":
		case "turn.completed":
			assertNonNegativeInteger(value.turn, "payload.turn");
			return;
		case "turn.failed":
			assertNonEmptyString(value.message, "payload.message");
			return;
		case "message.delta":
		case "reasoning.delta":
			if (typeof value.delta !== "string") throw protocolFault("payload.delta must be a string");
			return;
		case "message.completed":
			if (typeof value.output !== "string") throw protocolFault("payload.output must be a string");
			return;
		case "tool.started":
			assertNonEmptyString(value.tool, "payload.tool");
			if (!isRecord(value.args)) throw protocolFault("payload.args must be an object");
			return;
		case "tool.completed":
		case "tool.failed":
			assertNonEmptyString(value.tool, "payload.tool");
			if (typeof value.result !== "string") throw protocolFault("payload.result must be a string");
			return;
		case "budget.exhausted":
			if (typeof value.output !== "string") throw protocolFault("payload.output must be a string");
			assertNonNegativeInteger(value.turns, "payload.turns");
			return;
		case "goal.updated":
		case "compaction.started":
		case "compaction.completed":
		case "refine.completed":
		case "refine.failed":
		case "recap.updated":
			return;
		default:
			throw protocolFault("unhandled worker event", { name });
	}
}

function validateHostError(value: unknown): asserts value is PrimeHostErrorV1 {
	if (!isRecord(value)) throw protocolFault("failed response requires an error object");
	assertNonEmptyString(value.code, "error.code");
	assertNonEmptyString(value.message, "error.message");
	if (
		![
			"invalid",
			"denied",
			"not_found",
			"conflict",
			"cancelled",
			"deadline",
			"budget",
			"unavailable",
			"internal",
		].includes(String(value.class))
	) {
		throw protocolFault("error.class is invalid");
	}
	if (typeof value.retryable !== "boolean") throw protocolFault("error.retryable must be boolean");
}

function assertKnownName(value: unknown, names: ReadonlySet<string>, label: string): asserts value is string {
	assertNonEmptyString(value, "name");
	if (!names.has(value)) throw protocolFault(`unknown ${label}`, { name: value });
}

function assertExactString(value: unknown, expected: string, label: string): void {
	if (value !== expected) throw protocolFault(`${label} is unsupported`, { expected, actual: value });
}

function assertKnownKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	const allowed = new Set(keys);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw protocolFault(`${label} contains unsupported field`, { key });
	}
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) throw protocolFault(`${label} is required`);
}

function assertGoalText(value: unknown, label: string, maxChars: number): asserts value is string {
	assertNonEmptyString(value, label);
	if (value.includes("\0")) throw protocolFault(`${label} must not contain NUL`);
	if ([...value].length > maxChars) throw protocolFault(`${label} must be at most ${String(maxChars)} characters`);
}

function validatePrimeGoalHostResponse(value: Record<string, unknown>): asserts value is PrimeGoalHostResponseV1 {
	assertKnownKeys(value, ["goal", "remaining_tokens", "completion_budget_report"], "goal response");
	for (const key of ["goal", "remaining_tokens", "completion_budget_report"] as const) {
		if (!Object.hasOwn(value, key)) throw protocolFault(`goal response.${key} is required`);
	}
	if (value.goal === null) {
		if (value.remaining_tokens !== null || value.completion_budget_report !== null) {
			throw protocolFault("empty goal response must have null budget fields");
		}
		return;
	}
	if (!isRecord(value.goal)) throw protocolFault("goal response.goal must be an object or null");
	assertKnownKeys(
		value.goal,
		[
			"goal_id",
			"objective",
			"status",
			"token_budget",
			"tokens_used",
			"time_used_seconds",
			"created_at",
			"updated_at",
		],
		"goal response.goal",
	);
	for (const key of ["objective", "status", "tokens_used", "time_used_seconds"] as const) {
		if (!Object.hasOwn(value.goal, key)) throw protocolFault(`goal response.goal.${key} is required`);
	}
	assertGoalText(value.goal.objective, "goal response.goal.objective", PRIME_GOAL_OBJECTIVE_MAX_CHARS);
	if (!["active", "paused", "budget_limited", "complete", "error"].includes(String(value.goal.status))) {
		throw protocolFault("goal response.goal.status is unsupported");
	}
	assertNonNegativeInteger(value.goal.tokens_used, "goal response.goal.tokens_used");
	assertNonNegativeInteger(value.goal.time_used_seconds, "goal response.goal.time_used_seconds");
	if (value.goal.goal_id !== undefined)
		assertGoalText(value.goal.goal_id, "goal response.goal.goal_id", PRIME_GOAL_ID_MAX_CHARS);
	if (value.goal.token_budget !== undefined)
		assertPositiveInteger(value.goal.token_budget, "goal response.goal.token_budget");
	if (value.goal.created_at !== undefined)
		assertNonNegativeInteger(value.goal.created_at, "goal response.goal.created_at");
	if (value.goal.updated_at !== undefined)
		assertNonNegativeInteger(value.goal.updated_at, "goal response.goal.updated_at");
	if (value.remaining_tokens !== null)
		assertNonNegativeInteger(value.remaining_tokens, "goal response.remaining_tokens");
	if (value.completion_budget_report !== null) {
		assertGoalText(
			value.completion_budget_report,
			"goal response.completion_budget_report",
			PRIME_COMPLETION_BUDGET_REPORT_MAX_CHARS,
		);
	}
	if (value.goal.token_budget === undefined && value.remaining_tokens !== null) {
		throw protocolFault("unbudgeted goal response must have null remaining_tokens");
	}
	if (
		value.goal.token_budget !== undefined &&
		value.remaining_tokens !== Math.max(0, value.goal.token_budget - value.goal.tokens_used)
	) {
		throw protocolFault("goal response.remaining_tokens does not match the goal budget");
	}
}

function isPrimeGoalHostResponse(value: Record<string, unknown>): boolean {
	return ["goal", "remaining_tokens", "completion_budget_report"].every((key) => Object.hasOwn(value, key));
}

function optionalNonEmptyString(value: unknown, label: string): void {
	if (value !== undefined) assertNonEmptyString(value, label);
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw protocolFault(`${label} must be a non-negative safe integer`);
	}
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
	assertNonNegativeInteger(value, label);
	if (value < 1) throw protocolFault(`${label} must be positive`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function protocolFault(message: string, details?: unknown): PrimeHostProtocolFault {
	return new PrimeHostProtocolFault(message, details);
}
