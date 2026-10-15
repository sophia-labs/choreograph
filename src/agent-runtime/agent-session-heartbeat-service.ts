import {
	AGENT_SESSION_SCHEDULE_CONTROL_SCHEMA,
	type AgentSessionScheduleControlActionV1,
	type AgentSessionScheduleControlRequestV1,
	type AgentSessionScheduleCreationOptionsV1,
} from "./agent-session-schedule-control.js";
import type { RlmHostError, RlmHostErrorClass } from "./rlm-control-contract.js";
import {
	parseRlmHeartbeatListResult,
	parseRlmHeartbeatMutationResult,
	parseRlmHeartbeatRequest,
	RlmHeartbeatContractFault,
	type RlmHeartbeatListResult,
	type RlmHeartbeatMutationResult,
	type RlmHeartbeatRequest,
} from "./rlm-heartbeat-contract.js";
import type { AgentSessionScheduleSpecV1 } from "./session-contract.js";

/** The complete live-lease context from which a kernel heartbeat derives authority. */
export interface AgentSessionHeartbeatParentContext {
	readonly sessionId: string;
	readonly generation: number;
	readonly activationId: string;
	readonly ownerUserId: string;
	readonly graphOwnerPrincipal: string;
	readonly graphId: string;
	readonly agentId: string;
}

/** Host-derived invocation coordinates. No coordinate is accepted from the model payload. */
export interface AgentSessionHeartbeatInvocation extends AgentSessionHeartbeatParentContext {
	readonly requestId: string;
	readonly clientId: string;
	readonly now: number;
}

export interface AgentSessionHeartbeatListInput extends AgentSessionHeartbeatInvocation {
	readonly includeInactive: boolean;
}

export interface AgentSessionHeartbeatCreateInput extends AgentSessionHeartbeatInvocation {
	readonly schedule: AgentSessionScheduleSpecV1;
	readonly input: { readonly text: string };
	readonly options: AgentSessionScheduleCreationOptionsV1;
}

export interface AgentSessionHeartbeatControlInput extends AgentSessionHeartbeatInvocation {
	readonly control: AgentSessionScheduleControlRequestV1;
}

export interface AgentSessionHeartbeatCancelInput extends AgentSessionHeartbeatInvocation {
	readonly scheduleId: string;
}

/**
 * The store adapter for the model-facing heartbeat surface. Implementations own
 * transactions and state-machine semantics; this service owns only parsing,
 * normalization, authority derivation, and projection validation.
 */
export interface AgentSessionHeartbeatPort {
	list(input: AgentSessionHeartbeatListInput): Promise<unknown>;
	create(input: AgentSessionHeartbeatCreateInput): Promise<unknown>;
	control(input: AgentSessionHeartbeatControlInput): Promise<unknown>;
	cancel(input: AgentSessionHeartbeatCancelInput): Promise<unknown>;
}

export class AgentSessionHeartbeatHostRequestFault extends Error {
	readonly structured: RlmHostError;

	constructor(
		readonly code: string,
		readonly errorClass: RlmHostErrorClass,
		message: string,
		readonly retryable = false,
	) {
		super(boundMessage(message));
		this.name = "AgentSessionHeartbeatHostRequestFault";
		this.structured = {
			code: boundedCode(code),
			class: errorClass,
			message: this.message,
			retryable,
		};
	}
}

export interface NormalizedRlmHeartbeatInterval {
	readonly kind: "interval";
	readonly expression: string;
	readonly timeZone: "UTC";
	readonly intervalMs: number;
}

export interface NormalizedRlmHeartbeatCron {
	readonly kind: "cron";
	readonly expression: string;
	readonly timeZone: "UTC";
}

export type NormalizedRlmHeartbeatSchedule = NormalizedRlmHeartbeatInterval | NormalizedRlmHeartbeatCron;

const DEFAULT_INTERVAL = "every 5m";
const MIN_INTERVAL_MS = 10_000;
const MAX_REQUEST_ID_CHARS = 128;
const MAX_AUTHORITY_TEXT_CHARS = 512;
const MAX_ERROR_CHARS = 4_096;
const DURATION = /^(?:every|each)?\s*([1-9][0-9]*)\s*([smh])$/iu;
const CRON_FIELD = /^[0-9*/,-]+$/u;
const CRON_RANGES = [
	[0, 59],
	[0, 23],
	[1, 31],
	[1, 12],
	[0, 7],
] as const;

/** Normalize the recurring subset accepted by Prime's bundled heartbeat skill. */
export function normalizeRlmHeartbeatSchedule(value: string | undefined): NormalizedRlmHeartbeatSchedule {
	const expression = typeof value === "undefined" ? DEFAULT_INTERVAL : boundedText(value, "interval", 256);
	const duration = DURATION.exec(expression);
	if (duration) {
		const amount = Number(duration[1]);
		const unit = duration[2].toLowerCase();
		const multiplier = unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
		const intervalMs = amount * multiplier;
		if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS) {
			throw new AgentSessionHeartbeatHostRequestFault(
				"rlm_heartbeat_interval_invalid",
				"invalid",
				"Heartbeat interval must be at least 10 seconds",
			);
		}
		return { kind: "interval", expression: `every ${amount}${unit}`, timeZone: "UTC", intervalMs };
	}

	const fields = expression.split(/\s+/u);
	if (fields.length === 5) {
		for (const [index, field] of fields.entries()) validateCronField(field, CRON_RANGES[index]);
		return { kind: "cron", expression: fields.join(" "), timeZone: "UTC" };
	}

	throw new AgentSessionHeartbeatHostRequestFault(
		"rlm_heartbeat_schedule_invalid",
		"invalid",
		"Heartbeat schedule must be a recurring duration or five-field UTC cron expression",
	);
}

export class AgentSessionHeartbeatService {
	private readonly port: AgentSessionHeartbeatPort;

	constructor(options: { readonly port: AgentSessionHeartbeatPort }) {
		this.port = options.port;
	}

	async handle(input: {
		readonly requestId: string;
		readonly payload: unknown;
		readonly parent: AgentSessionHeartbeatParentContext;
		readonly now: number;
	}): Promise<RlmHeartbeatListResult | RlmHeartbeatMutationResult> {
		const requestId = requireRequestId(input.requestId);
		const parent = validateParent(input.parent);
		const now = validateNow(input.now);
		let request: RlmHeartbeatRequest;
		try {
			request = parseRlmHeartbeatRequest(input.payload);
		} catch (error) {
			throw contractFault(error);
		}

		const invocation: AgentSessionHeartbeatInvocation = {
			...parent,
			requestId,
			clientId: heartbeatClientId(parent),
			now,
		};
		try {
			switch (request.type) {
				case "rlm_heartbeat.list":
					return durableListResult(
						await this.port.list({ ...invocation, includeInactive: request.include_inactive }),
					);
				case "rlm_heartbeat.create":
					return durableMutationResult(
						await this.port.create({
							...invocation,
							schedule: normalizeRlmHeartbeatSchedule(request.interval),
							input: { text: request.instruction },
							options: {
								source: "rlm_heartbeat",
								...(normalizedLabel(request.label) === undefined
									? {}
									: { label: normalizedLabel(request.label) }),
								deliveryMode: request.delivery_mode ?? "steer",
								grantSnapshotDigest: null,
							},
						}),
					);
				case "rlm_heartbeat.update":
					return durableMutationResult(
						await this.port.control({ ...invocation, control: controlRequest(request, requestId) }),
					);
				case "rlm_heartbeat.delete":
					return durableMutationResult(await this.port.cancel({ ...invocation, scheduleId: request.id }));
			}
		} catch (error) {
			throw hostFault(error);
		}
	}
}

function controlRequest(
	request: Extract<RlmHeartbeatRequest, { readonly type: "rlm_heartbeat.update" }>,
	requestId: string,
): AgentSessionScheduleControlRequestV1 {
	const suppliedStatus = request.status !== undefined;
	const changed: AgentSessionScheduleControlActionV1 = suppliedStatus
		? (() => {
				if (
					request.instruction !== undefined ||
					request.interval !== undefined ||
					request.label !== undefined ||
					request.delivery_mode !== undefined
				) {
					throw new AgentSessionHeartbeatHostRequestFault(
						"rlm_heartbeat_update_invalid",
						"invalid",
						"Heartbeat pause or resume cannot be combined with another update",
					);
				}
				return { kind: request.status === "pause" ? "pause" : "resume" };
			})()
		: {
				kind: "update",
				...(request.instruction === undefined ? {} : { input: { text: request.instruction } }),
				...(request.interval === undefined ? {} : { schedule: normalizeRlmHeartbeatSchedule(request.interval) }),
				...(request.label === undefined ? {} : { label: normalizedLabel(request.label) }),
				...(request.delivery_mode === undefined ? {} : { deliveryMode: request.delivery_mode }),
			};
	return {
		schema: AGENT_SESSION_SCHEDULE_CONTROL_SCHEMA,
		requestId,
		scheduleId: request.id,
		action: changed,
	};
}

function durableListResult(value: unknown): RlmHeartbeatListResult {
	try {
		return parseRlmHeartbeatListResult(value);
	} catch (error) {
		throw resultPoison(error);
	}
}

function durableMutationResult(value: unknown): RlmHeartbeatMutationResult {
	try {
		return parseRlmHeartbeatMutationResult(value);
	} catch (error) {
		throw resultPoison(error);
	}
}

function resultPoison(error: unknown): AgentSessionHeartbeatHostRequestFault {
	const message =
		error instanceof RlmHeartbeatContractFault ? error.message : "Host returned an invalid heartbeat result";
	return new AgentSessionHeartbeatHostRequestFault("rlm_heartbeat_result_invalid", "internal", message);
}

function contractFault(error: unknown): AgentSessionHeartbeatHostRequestFault {
	if (error instanceof AgentSessionHeartbeatHostRequestFault) return error;
	if (error instanceof RlmHeartbeatContractFault) {
		return new AgentSessionHeartbeatHostRequestFault("rlm_heartbeat_contract_invalid", "invalid", error.message);
	}
	return new AgentSessionHeartbeatHostRequestFault(
		"rlm_heartbeat_contract_invalid",
		"invalid",
		"Heartbeat request is invalid",
	);
}

function hostFault(error: unknown): AgentSessionHeartbeatHostRequestFault {
	if (error instanceof AgentSessionHeartbeatHostRequestFault) return error;
	if (error instanceof RlmHeartbeatContractFault) return contractFault(error);
	const structured = structuredFault(error);
	if (structured) {
		return new AgentSessionHeartbeatHostRequestFault(
			structured.code,
			structured.errorClass,
			publicFaultMessage(structured.errorClass),
			structured.retryable,
		);
	}
	return new AgentSessionHeartbeatHostRequestFault(
		"rlm_heartbeat_internal",
		"internal",
		"Heartbeat host operation failed",
	);
}

function structuredFault(
	error: unknown,
): { readonly code: string; readonly errorClass: RlmHostErrorClass; readonly retryable: boolean } | null {
	if (!error || typeof error !== "object") return null;
	const value = error as Record<string, unknown>;
	const nested = value.structured;
	if (nested && typeof nested === "object") {
		const candidate = nested as Record<string, unknown>;
		const errorClass = candidate.class;
		if (typeof candidate.code === "string" && isHostErrorClass(errorClass)) {
			return { code: candidate.code, errorClass, retryable: candidate.retryable === true };
		}
	}
	const errorClass = value.errorClass;
	if (typeof value.code === "string" && isHostErrorClass(errorClass)) {
		return { code: value.code, errorClass, retryable: value.retryable === true };
	}
	const code = typeof value.code === "string" ? value.code : "";
	const reason = typeof value.reason === "string" ? value.reason : "";
	const lower = `${code} ${reason}`.toLowerCase();
	if (lower.includes("not_found") || lower.includes("notfound"))
		return { code, errorClass: "not_found", retryable: false };
	if (lower.includes("denied") || lower.includes("authority")) return { code, errorClass: "denied", retryable: false };
	if (lower.includes("conflict")) return { code, errorClass: "conflict", retryable: false };
	if (lower.includes("unavailable") || lower.includes("lease") || lower.includes("timeout")) {
		return { code, errorClass: "unavailable", retryable: true };
	}
	if (lower.includes("invalid") || lower.includes("request")) return { code, errorClass: "invalid", retryable: false };
	return null;
}

function publicFaultMessage(errorClass: RlmHostErrorClass): string {
	return {
		invalid: "Heartbeat request is invalid",
		denied: "Heartbeat operation denied",
		conflict: "Heartbeat operation conflicted with another durable operation",
		not_found: "Heartbeat was not found",
		unavailable: "Heartbeat host is temporarily unavailable",
		internal: "Heartbeat host operation failed",
	}[errorClass];
}

function validateParent(value: AgentSessionHeartbeatParentContext): AgentSessionHeartbeatParentContext {
	if (!value || typeof value !== "object") {
		throw new AgentSessionHeartbeatHostRequestFault(
			"rlm_heartbeat_parent_invalid",
			"invalid",
			"Heartbeat parent context is invalid",
		);
	}
	for (const [key, text] of Object.entries(value)) {
		if (key === "generation") continue;
		if (typeof text !== "string" || !text.trim() || text.length > MAX_AUTHORITY_TEXT_CHARS) {
			throw new AgentSessionHeartbeatHostRequestFault(
				"rlm_heartbeat_parent_invalid",
				"invalid",
				"Heartbeat parent context is invalid",
			);
		}
	}
	if (!Number.isSafeInteger(value.generation) || value.generation < 0) {
		throw new AgentSessionHeartbeatHostRequestFault(
			"rlm_heartbeat_parent_invalid",
			"invalid",
			"Heartbeat parent context is invalid",
		);
	}
	return value;
}

function validateNow(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new AgentSessionHeartbeatHostRequestFault(
			"rlm_heartbeat_clock_invalid",
			"invalid",
			"Heartbeat clock is invalid",
		);
	}
	return value;
}

function requireRequestId(value: string): string {
	return boundedText(value, "request id", MAX_REQUEST_ID_CHARS);
}

function heartbeatClientId(parent: AgentSessionHeartbeatParentContext): string {
	return `rlm_heartbeat:${parent.agentId}:${parent.activationId}`;
}

function normalizedLabel(value: string | undefined): string | null | undefined {
	if (value === undefined) return undefined;
	const label = value.trim();
	return label === "" ? null : label;
}

function validateCronField(value: string, range: readonly [number, number]): void {
	if (!CRON_FIELD.test(value)) {
		throw new AgentSessionHeartbeatHostRequestFault(
			"rlm_heartbeat_cron_invalid",
			"invalid",
			"Heartbeat cron expression is invalid",
		);
	}
	for (const atom of value.split(",")) {
		const [base, step] = atom.split("/");
		if (step !== undefined && (!/^\d+$/u.test(step) || Number(step) < 1)) {
			throw new AgentSessionHeartbeatHostRequestFault(
				"rlm_heartbeat_cron_invalid",
				"invalid",
				"Heartbeat cron expression is invalid",
			);
		}
		if (base === "*") continue;
		const values = base.split("-");
		if (values.length > 2 || values.some((item) => !/^\d+$/u.test(item))) {
			throw new AgentSessionHeartbeatHostRequestFault(
				"rlm_heartbeat_cron_invalid",
				"invalid",
				"Heartbeat cron expression is invalid",
			);
		}
		const numbers = values.map(Number);
		if (
			numbers.some((item) => item < range[0] || item > range[1]) ||
			(numbers.length === 2 && numbers[0] > numbers[1])
		) {
			throw new AgentSessionHeartbeatHostRequestFault(
				"rlm_heartbeat_cron_invalid",
				"invalid",
				"Heartbeat cron expression is invalid",
			);
		}
	}
}

function boundedText(value: unknown, label: string, maxChars: number): string {
	if (typeof value !== "string") {
		throw new AgentSessionHeartbeatHostRequestFault(
			"rlm_heartbeat_request_invalid",
			"invalid",
			`${label} is invalid`,
		);
	}
	const normalized = value.trim();
	if (!normalized || normalized.length > maxChars || /\u0000/u.test(normalized)) {
		throw new AgentSessionHeartbeatHostRequestFault(
			"rlm_heartbeat_request_invalid",
			"invalid",
			`${label} is invalid`,
		);
	}
	return normalized;
}

function isHostErrorClass(value: unknown): value is RlmHostErrorClass {
	return (
		value === "invalid" ||
		value === "denied" ||
		value === "conflict" ||
		value === "not_found" ||
		value === "unavailable" ||
		value === "internal"
	);
}

function boundedCode(value: string): string {
	return value.replace(/[^A-Za-z0-9._:-]/gu, "_").slice(0, 128) || "rlm_heartbeat_internal";
}

function boundMessage(value: string): string {
	return value.length <= MAX_ERROR_CHARS ? value : value.slice(0, MAX_ERROR_CHARS);
}
