export type RlmRunState = "queued" | "claimed" | "cancelling" | "completed" | "failed" | "cancelled";
export type RlmOpenSessionState = "open" | "closing" | "faulted";
export type RlmCancellationDisposition = "observed" | "not_required";

export const RLM_CONTROL_LIMITS = {
	promptUtf8Bytes: 65_536,
	nameChars: 64,
	modelChars: 256,
	targetChars: 256,
	idChars: 256,
	errorCodeChars: 128,
	errorMessageChars: 4_096,
} as const;

export const RLM_CHILD_SESSION_ID_PATTERN = "^ags_[0-9a-f]{24}$";
export const RLM_CHILD_RUN_ID_PATTERN = "^acr_[0-9a-f]{24}$";

export interface RlmSpawnHandle {
	readonly child_session_id: string;
	readonly child_run_id: string;
	readonly name: string;
	readonly model: string;
}

export interface RlmSubagent extends RlmSpawnHandle {
	readonly run_state: RlmRunState;
	readonly session_state: RlmOpenSessionState;
}

export interface RlmSubagentClosure extends RlmSpawnHandle {
	readonly prior_run_state: RlmRunState;
	readonly final_run_state: RlmRunState;
	readonly session_state: "closed";
	readonly cancellation: RlmCancellationDisposition;
}

export interface RlmListSubagentsResult {
	readonly subagents: readonly RlmSubagent[];
}

export interface RlmDeleteSubagentResult {
	readonly closure: RlmSubagentClosure;
}

export type RlmHostErrorClass = "invalid" | "denied" | "conflict" | "not_found" | "unavailable" | "internal";

export interface RlmHostError {
	readonly code: string;
	readonly class: RlmHostErrorClass;
	readonly message: string;
	readonly retryable: boolean;
}

export type RlmControlRequest =
	| {
			readonly type: "rlm.run";
			readonly prompt: string;
			readonly kwargs: { readonly name?: string; readonly model?: string };
	  }
	| { readonly type: "rlm.list_subagents" }
	| { readonly type: "rlm.delete_subagent"; readonly target: string };

const RUN_STATES = new Set<RlmRunState>(["queued", "claimed", "cancelling", "completed", "failed", "cancelled"]);
const OPEN_SESSION_STATES = new Set<RlmOpenSessionState>(["open", "closing", "faulted"]);
export const RLM_HOST_ERROR_CLASSES = [
	"invalid",
	"denied",
	"conflict",
	"not_found",
	"unavailable",
	"internal",
] as const satisfies readonly RlmHostErrorClass[];
const ERROR_CLASSES = new Set<RlmHostErrorClass>(RLM_HOST_ERROR_CLASSES);
const HANDLE_KEYS = ["child_session_id", "child_run_id", "name", "model"] as const;
const CHILD_SESSION_ID_PATTERN = new RegExp(RLM_CHILD_SESSION_ID_PATTERN);
const CHILD_RUN_ID_PATTERN = new RegExp(RLM_CHILD_RUN_ID_PATTERN);
const LIVE_RUN_STATES = new Set<RlmRunState>(["queued", "claimed", "cancelling"]);
const TERMINAL_RUN_STATES = new Set<RlmRunState>(["completed", "failed", "cancelled"]);

export function parseRlmControlRequest(value: unknown): RlmControlRequest {
	const record = exactRecord(value, "RLM control request");
	if (record.type === "rlm.run") {
		exactKeys(record, ["type", "prompt", "kwargs"], "rlm.run request");
		const prompt = boundedPrompt(record.prompt);
		const kwargs = exactRecord(record.kwargs, "rlm.run kwargs");
		exactKeys(kwargs, ["name", "model"], "rlm.run kwargs", true);
		return {
			type: "rlm.run",
			prompt,
			kwargs: {
				...(kwargs.name === undefined ? {} : { name: boundedName(kwargs.name, "rlm.run name") }),
				...(kwargs.model === undefined ? {} : { model: boundedModel(kwargs.model, "rlm.run model") }),
			},
		};
	}
	if (record.type === "rlm.list_subagents") {
		exactKeys(record, ["type"], "rlm.list_subagents request");
		return { type: "rlm.list_subagents" };
	}
	if (record.type === "rlm.delete_subagent") {
		exactKeys(record, ["type", "target"], "rlm.delete_subagent request");
		const target = boundedPrintable(record.target, "rlm.delete_subagent target", RLM_CONTROL_LIMITS.targetChars);
		if (!CHILD_RUN_ID_PATTERN.test(target)) {
			throw new RlmControlContractFault("rlm.delete_subagent target must be an immutable child run id");
		}
		return {
			type: "rlm.delete_subagent",
			target,
		};
	}
	throw new RlmControlContractFault(`unsupported RLM control request type: ${JSON.stringify(record.type)}`);
}

export function parseRlmSpawnHandle(value: unknown): RlmSpawnHandle {
	const record = exactRecord(value, "rlm.run result");
	exactKeys(record, HANDLE_KEYS, "rlm.run result");
	return parseHandle(record, "rlm.run result");
}

export function parseRlmListSubagentsResult(value: unknown): RlmListSubagentsResult {
	const record = exactRecord(value, "rlm.list_subagents result");
	exactKeys(record, ["subagents"], "rlm.list_subagents result");
	if (!Array.isArray(record.subagents)) {
		throw new RlmControlContractFault("rlm.list_subagents subagents must be an array");
	}
	return { subagents: record.subagents.map((entry) => parseSubagent(entry)) };
}

export function parseRlmDeleteSubagentResult(value: unknown): RlmDeleteSubagentResult {
	const record = exactRecord(value, "rlm.delete_subagent result");
	exactKeys(record, ["closure"], "rlm.delete_subagent result");
	return { closure: parseClosure(record.closure) };
}

export function parseRlmHostError(value: unknown): RlmHostError {
	const record = exactRecord(value, "RLM host error");
	exactKeys(record, ["code", "class", "message", "retryable"], "RLM host error");
	const errorClass = record.class;
	if (typeof errorClass !== "string" || !ERROR_CLASSES.has(errorClass as RlmHostErrorClass)) {
		throw new RlmControlContractFault("RLM host error class is invalid");
	}
	if (typeof record.retryable !== "boolean") {
		throw new RlmControlContractFault("RLM host error retryable must be boolean");
	}
	return {
		code: boundedErrorCode(record.code),
		class: errorClass as RlmHostErrorClass,
		message: boundedPrintable(record.message, "RLM host error message", RLM_CONTROL_LIMITS.errorMessageChars),
		retryable: record.retryable,
	};
}

export class RlmControlContractFault extends Error {
	readonly code = "rlm_control_contract_invalid";
	readonly retryable = false;

	constructor(message: string) {
		super(message);
		this.name = "RlmControlContractFault";
	}
}

function parseSubagent(value: unknown): RlmSubagent {
	const record = exactRecord(value, "rlm.list_subagents entry");
	if ("status" in record) throw new RlmControlContractFault("rlm.list_subagents rejects legacy status");
	if ("close_state" in record) throw new RlmControlContractFault("rlm.list_subagents rejects legacy close_state");
	exactKeys(record, [...HANDLE_KEYS, "run_state", "session_state"], "rlm.list_subagents entry");
	const runState = parseRunState(record.run_state, "rlm.list_subagents run_state");
	const sessionState = record.session_state;
	if (typeof sessionState !== "string" || !OPEN_SESSION_STATES.has(sessionState as RlmOpenSessionState)) {
		throw new RlmControlContractFault("rlm.list_subagents session_state is invalid");
	}
	return {
		...parseHandle(record, "rlm.list_subagents entry"),
		run_state: runState,
		session_state: sessionState as RlmOpenSessionState,
	};
}

function parseClosure(value: unknown): RlmSubagentClosure {
	const record = exactRecord(value, "rlm.delete_subagent closure");
	if ("status" in record || "error" in record || "close_state" in record) {
		throw new RlmControlContractFault("rlm.delete_subagent rejects legacy closure fields");
	}
	exactKeys(
		record,
		[...HANDLE_KEYS, "prior_run_state", "final_run_state", "session_state", "cancellation"],
		"rlm.delete_subagent closure",
	);
	const priorRunState = parseRunState(record.prior_run_state, "rlm.delete_subagent prior_run_state");
	const finalRunState = parseRunState(record.final_run_state, "rlm.delete_subagent final_run_state");
	if (record.session_state !== "closed") {
		throw new RlmControlContractFault("rlm.delete_subagent session_state must be closed");
	}
	if (record.cancellation !== "observed" && record.cancellation !== "not_required") {
		throw new RlmControlContractFault("rlm.delete_subagent cancellation is invalid");
	}
	if (record.cancellation === "observed") {
		if (!LIVE_RUN_STATES.has(priorRunState) || finalRunState !== "cancelled") {
			throw new RlmControlContractFault(
				"observed cancellation chronology requires a queued, claimed, or cancelling prior run and a cancelled final run",
			);
		}
	} else if (!TERMINAL_RUN_STATES.has(priorRunState) || finalRunState !== priorRunState) {
		throw new RlmControlContractFault(
			"not_required cancellation chronology requires an unchanged completed, failed, or cancelled terminal run",
		);
	}
	return {
		...parseHandle(record, "rlm.delete_subagent closure"),
		prior_run_state: priorRunState,
		final_run_state: finalRunState,
		session_state: "closed",
		cancellation: record.cancellation,
	};
}

function parseRunState(value: unknown, label: string): RlmRunState {
	if (typeof value !== "string" || !RUN_STATES.has(value as RlmRunState)) {
		throw new RlmControlContractFault(`${label} is invalid`);
	}
	return value as RlmRunState;
}

function parseHandle(record: Record<string, unknown>, label: string): RlmSpawnHandle {
	const childSessionId = boundedPrintable(
		record.child_session_id,
		`${label} child_session_id`,
		RLM_CONTROL_LIMITS.idChars,
	);
	if (!CHILD_SESSION_ID_PATTERN.test(childSessionId)) {
		throw new RlmControlContractFault(`${label} child_session_id is non-canonical`);
	}
	const childRunId = boundedPrintable(record.child_run_id, `${label} child_run_id`, RLM_CONTROL_LIMITS.idChars);
	if (!CHILD_RUN_ID_PATTERN.test(childRunId)) {
		throw new RlmControlContractFault(`${label} child_run_id is non-canonical`);
	}
	return {
		child_session_id: childSessionId,
		child_run_id: childRunId,
		name: boundedName(record.name, `${label} name`),
		model: boundedModel(record.model, `${label} model`),
	};
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RlmControlContractFault(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string, optional = false): void {
	const actual = Object.keys(record).sort();
	const expected = [...allowed].sort();
	const unknown = actual.filter((key) => !expected.includes(key));
	const missing = optional ? [] : expected.filter((key) => !actual.includes(key));
	if (unknown.length > 0 || missing.length > 0) {
		throw new RlmControlContractFault(
			`${label} fields are non-canonical (unknown=${unknown.join(",") || "none"}; missing=${missing.join(",") || "none"})`,
		);
	}
}

function boundedPrompt(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new RlmControlContractFault("rlm.run prompt must be non-empty");
	}
	if (new TextEncoder().encode(value).byteLength > RLM_CONTROL_LIMITS.promptUtf8Bytes) {
		throw new RlmControlContractFault(`rlm.run prompt exceeds ${RLM_CONTROL_LIMITS.promptUtf8Bytes} UTF-8 bytes`);
	}
	return value;
}

function boundedPrintable(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maximum || !/^[\x20-\x7e]+$/.test(value)) {
		throw new RlmControlContractFault(`${label} must be printable ASCII with 1..${maximum} characters`);
	}
	return value;
}

function boundedName(value: unknown, label: string): string {
	const name = boundedPrintable(value, label, RLM_CONTROL_LIMITS.nameChars);
	if (!/^[A-Za-z0-9_-]+$/.test(name)) {
		throw new RlmControlContractFault(`${label} must match [A-Za-z0-9_-]+`);
	}
	return name;
}

function boundedModel(value: unknown, label: string): string {
	return boundedPrintable(value, label, RLM_CONTROL_LIMITS.modelChars);
}

function boundedErrorCode(value: unknown): string {
	const code = boundedPrintable(value, "RLM host error code", RLM_CONTROL_LIMITS.errorCodeChars);
	if (!/^[A-Za-z0-9_.-]+$/.test(code)) {
		throw new RlmControlContractFault("RLM host error code contains invalid characters");
	}
	return code;
}
