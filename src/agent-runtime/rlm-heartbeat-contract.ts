export const RLM_HEARTBEAT_LIMITS = {
	instructionUtf8Bytes: 65_536,
	intervalChars: 256,
	labelChars: 128,
	idChars: 128,
	errorChars: 4_096,
} as const;

export type RlmHeartbeatDeliveryMode = "steer" | "follow_up";
export type RlmHeartbeatStatus = "active" | "paused" | "cancelled";
export type RlmHeartbeatStatusUpdate = "pause" | "resume";

export type RlmHeartbeatRequest =
	| { readonly type: "rlm_heartbeat.list"; readonly include_inactive: boolean }
	| {
			readonly type: "rlm_heartbeat.create";
			readonly instruction: string;
			readonly interval?: string;
			readonly label?: string;
			readonly delivery_mode?: RlmHeartbeatDeliveryMode;
	  }
	| {
			readonly type: "rlm_heartbeat.update";
			readonly id: string;
			readonly instruction?: string;
			readonly interval?: string;
			readonly label?: string;
			readonly status?: RlmHeartbeatStatusUpdate;
			readonly delivery_mode?: RlmHeartbeatDeliveryMode;
	  }
	| { readonly type: "rlm_heartbeat.delete"; readonly id: string };

/** Exact model-facing projection. Mutable fire-work leases and authority bytes never cross this boundary. */
export interface RlmHeartbeatRecord {
	readonly id: string;
	readonly revision: number;
	readonly status: RlmHeartbeatStatus;
	readonly label: string | null;
	readonly delivery_mode: RlmHeartbeatDeliveryMode;
	readonly instruction: string;
	readonly schedule: string;
	readonly created_at: string;
	readonly updated_at: string;
	readonly next_run_at: string | null;
	readonly last_run_at: string | null;
	readonly last_error: string | null;
	readonly run_count: number;
}

export interface RlmHeartbeatListResult {
	readonly heartbeats: readonly RlmHeartbeatRecord[];
}

export interface RlmHeartbeatMutationResult {
	readonly heartbeat: RlmHeartbeatRecord | null;
}

const HEARTBEAT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const HEARTBEAT_STATUSES = new Set<RlmHeartbeatStatus>(["active", "paused", "cancelled"]);
const DELIVERY_MODES = new Set<RlmHeartbeatDeliveryMode>(["steer", "follow_up"]);

export function parseRlmHeartbeatRequest(value: unknown): RlmHeartbeatRequest {
	const record = exactRecord(value, "RLM heartbeat request");
	switch (record.type) {
		case "rlm_heartbeat.list":
			exactKeys(record, ["type", "include_inactive"], "rlm_heartbeat.list request");
			if (typeof record.include_inactive !== "boolean") {
				throw fault("rlm_heartbeat.list include_inactive must be boolean");
			}
			return { type: "rlm_heartbeat.list", include_inactive: record.include_inactive };
		case "rlm_heartbeat.create": {
			exactKeys(
				record,
				["type", "instruction", "interval", "label", "delivery_mode"],
				"rlm_heartbeat.create request",
				true,
			);
			return {
				type: "rlm_heartbeat.create",
				instruction: boundedInstruction(record.instruction, "rlm_heartbeat.create instruction"),
				...(record.interval === undefined
					? {}
					: {
							interval: boundedText(
								record.interval,
								"rlm_heartbeat.create interval",
								RLM_HEARTBEAT_LIMITS.intervalChars,
							),
						}),
				...(record.label === undefined ? {} : { label: boundedLabel(record.label, "rlm_heartbeat.create label") }),
				...(record.delivery_mode === undefined
					? {}
					: { delivery_mode: deliveryMode(record.delivery_mode, "rlm_heartbeat.create delivery_mode") }),
			};
		}
		case "rlm_heartbeat.update": {
			exactKeys(
				record,
				["type", "id", "instruction", "interval", "label", "status", "delivery_mode"],
				"rlm_heartbeat.update request",
				true,
			);
			const hasMutation = ["instruction", "interval", "label", "status", "delivery_mode"].some(
				(key) => record[key] !== undefined,
			);
			if (!hasMutation) throw fault("rlm_heartbeat.update requires at least one field to update");
			return {
				type: "rlm_heartbeat.update",
				id: heartbeatId(record.id, "rlm_heartbeat.update id"),
				...(record.instruction === undefined
					? {}
					: { instruction: boundedInstruction(record.instruction, "rlm_heartbeat.update instruction") }),
				...(record.interval === undefined
					? {}
					: {
							interval: boundedText(
								record.interval,
								"rlm_heartbeat.update interval",
								RLM_HEARTBEAT_LIMITS.intervalChars,
							),
						}),
				...(record.label === undefined ? {} : { label: boundedLabel(record.label, "rlm_heartbeat.update label") }),
				...(record.status === undefined ? {} : { status: statusUpdate(record.status) }),
				...(record.delivery_mode === undefined
					? {}
					: { delivery_mode: deliveryMode(record.delivery_mode, "rlm_heartbeat.update delivery_mode") }),
			};
		}
		case "rlm_heartbeat.delete":
			exactKeys(record, ["type", "id"], "rlm_heartbeat.delete request");
			return { type: "rlm_heartbeat.delete", id: heartbeatId(record.id, "rlm_heartbeat.delete id") };
		default:
			throw fault(`unsupported RLM heartbeat request type: ${JSON.stringify(record.type)}`);
	}
}

export function parseRlmHeartbeatListResult(value: unknown): RlmHeartbeatListResult {
	const record = exactRecord(value, "rlm_heartbeat.list result");
	exactKeys(record, ["heartbeats"], "rlm_heartbeat.list result");
	if (!Array.isArray(record.heartbeats)) throw fault("rlm_heartbeat.list heartbeats must be an array");
	return { heartbeats: record.heartbeats.map((heartbeat) => parseHeartbeat(heartbeat)) };
}

export function parseRlmHeartbeatMutationResult(value: unknown): RlmHeartbeatMutationResult {
	const record = exactRecord(value, "RLM heartbeat mutation result");
	exactKeys(record, ["heartbeat"], "RLM heartbeat mutation result");
	return { heartbeat: record.heartbeat === null ? null : parseHeartbeat(record.heartbeat) };
}

export class RlmHeartbeatContractFault extends Error {
	readonly code = "rlm_heartbeat_contract_invalid";
	readonly retryable = false;

	constructor(message: string) {
		super(message);
		this.name = "RlmHeartbeatContractFault";
	}
}

function parseHeartbeat(value: unknown): RlmHeartbeatRecord {
	const record = exactRecord(value, "RLM heartbeat record");
	exactKeys(
		record,
		[
			"id",
			"revision",
			"status",
			"label",
			"delivery_mode",
			"instruction",
			"schedule",
			"created_at",
			"updated_at",
			"next_run_at",
			"last_run_at",
			"last_error",
			"run_count",
		],
		"RLM heartbeat record",
	);
	if (typeof record.status !== "string" || !HEARTBEAT_STATUSES.has(record.status as RlmHeartbeatStatus)) {
		throw fault("RLM heartbeat status is invalid");
	}
	if (record.label !== null && typeof record.label !== "string") throw fault("RLM heartbeat label is invalid");
	if (record.last_error !== null && typeof record.last_error !== "string") {
		throw fault("RLM heartbeat last_error is invalid");
	}
	const label = record.label === null ? null : boundedLabel(record.label, "RLM heartbeat label");
	if (label === "") throw fault("RLM heartbeat label must be null rather than blank");
	const nextRunAt = nullableTimestamp(record.next_run_at, "RLM heartbeat next_run_at");
	if (record.status === "active" && nextRunAt === null) throw fault("active RLM heartbeat requires next_run_at");
	if (record.status !== "active" && nextRunAt !== null) {
		throw fault("inactive RLM heartbeat must not carry next_run_at");
	}
	return {
		id: heartbeatId(record.id, "RLM heartbeat id"),
		revision: nonNegativeInteger(record.revision, "RLM heartbeat revision"),
		status: record.status as RlmHeartbeatStatus,
		label,
		delivery_mode: deliveryMode(record.delivery_mode, "RLM heartbeat delivery_mode"),
		instruction: boundedInstruction(record.instruction, "RLM heartbeat instruction"),
		schedule: boundedText(record.schedule, "RLM heartbeat schedule", RLM_HEARTBEAT_LIMITS.intervalChars),
		created_at: timestamp(record.created_at, "RLM heartbeat created_at"),
		updated_at: timestamp(record.updated_at, "RLM heartbeat updated_at"),
		next_run_at: nextRunAt,
		last_run_at: nullableTimestamp(record.last_run_at, "RLM heartbeat last_run_at"),
		last_error:
			record.last_error === null
				? null
				: boundedText(record.last_error, "RLM heartbeat last_error", RLM_HEARTBEAT_LIMITS.errorChars),
		run_count: nonNegativeInteger(record.run_count, "RLM heartbeat run_count"),
	};
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw fault(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[], label: string, optional = false): void {
	const allowed = new Set(keys);
	const actual = Object.keys(record);
	if (actual.some((key) => !allowed.has(key))) throw fault(`${label} contains unknown fields`);
	if (!optional && keys.some((key) => !(key in record))) throw fault(`${label} is missing required fields`);
	if (optional && !("type" in record)) throw fault(`${label} is missing type`);
}

function boundedInstruction(value: unknown, label: string): string {
	if (typeof value !== "string") throw fault(`${label} must be a string`);
	const text = value.trim();
	if (!text) throw fault(`${label} must be non-empty`);
	if (/\u0000/u.test(text)) throw fault(`${label} must not contain NUL`);
	if (new TextEncoder().encode(text).byteLength > RLM_HEARTBEAT_LIMITS.instructionUtf8Bytes) {
		throw fault(`${label} exceeds ${RLM_HEARTBEAT_LIMITS.instructionUtf8Bytes} UTF-8 bytes`);
	}
	return text;
}

function boundedLabel(value: unknown, label: string): string {
	if (typeof value !== "string") throw fault(`${label} must be a string`);
	const normalized = value.trim();
	if (normalized.length > RLM_HEARTBEAT_LIMITS.labelChars) {
		throw fault(`${label} exceeds ${RLM_HEARTBEAT_LIMITS.labelChars} characters`);
	}
	return normalized;
}

function boundedText(value: unknown, label: string, maxChars: number): string {
	if (typeof value !== "string") throw fault(`${label} must be a string`);
	const normalized = value.trim();
	if (!normalized) throw fault(`${label} must be non-empty`);
	if (normalized.length > maxChars) throw fault(`${label} exceeds ${maxChars} characters`);
	if (/[^\x20-\x7e\n\r\t]/u.test(normalized)) throw fault(`${label} must contain bounded printable text`);
	return normalized;
}

function heartbeatId(value: unknown, label: string): string {
	const id = boundedText(value, label, RLM_HEARTBEAT_LIMITS.idChars);
	if (!HEARTBEAT_ID_PATTERN.test(id)) throw fault(`${label} is non-canonical`);
	return id;
}

function deliveryMode(value: unknown, label: string): RlmHeartbeatDeliveryMode {
	if (typeof value !== "string" || !DELIVERY_MODES.has(value as RlmHeartbeatDeliveryMode)) {
		throw fault(`${label} must be steer or follow_up`);
	}
	return value as RlmHeartbeatDeliveryMode;
}

function statusUpdate(value: unknown): RlmHeartbeatStatusUpdate {
	if (value !== "pause" && value !== "resume") throw fault("rlm_heartbeat.update status must be pause or resume");
	return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw fault(`${label} must be a non-negative safe integer`);
	}
	return value;
}

function timestamp(value: unknown, label: string): string {
	if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) {
		throw fault(`${label} must be an ISO timestamp`);
	}
	if (new Date(value).toISOString() !== value) throw fault(`${label} must be a canonical UTC timestamp`);
	return value;
}

function nullableTimestamp(value: unknown, label: string): string | null {
	return value === null ? null : timestamp(value, label);
}

function fault(message: string): RlmHeartbeatContractFault {
	return new RlmHeartbeatContractFault(message);
}
