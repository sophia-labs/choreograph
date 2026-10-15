export const INTERNAL_STAGE_KINDS = ["transcription"] as const;
export type InternalStageKind = (typeof INTERNAL_STAGE_KINDS)[number];

export const INTERNAL_STAGE_STATES = [
	"queued",
	"running",
	"succeeded",
	"failed_retryable",
	"failed_terminal",
	"cancelled",
] as const;
export type InternalStageState = (typeof INTERNAL_STAGE_STATES)[number];

export interface InternalStageSubmission {
	schema_version: 1;
	job_id: string;
	stage: InternalStageKind;
	input_digest: string;
	input: Record<string, unknown>;
	parameters: Record<string, unknown>;
}

export interface InternalStageStatus {
	job_id: string;
	stage: InternalStageKind;
	state: InternalStageState;
	input_digest: string;
	attempt: number;
	model: string;
	sandbox_id?: string;
	result_digest?: string;
	error?: string;
	created_at: string;
	updated_at: string;
}

export interface InternalStageJob extends InternalStageStatus {
	input: Record<string, unknown>;
	parameters: Record<string, unknown>;
}

export interface RetryRequest {
	expected_attempt: number;
	idempotency_key: string;
}

export class InternalJobRequestError extends Error {
	constructor(
		message: string,
		readonly statusCode = 400,
	) {
		super(message);
	}
}

export class InternalStageInputValidationError extends Error {}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function parseInternalStageSubmission(value: unknown): InternalStageSubmission {
	const body = requireObject(value, "request body");
	requireExactKeys(
		body,
		new Set(["schema_version", "job_id", "stage", "input_digest", "input", "parameters"]),
		"request body",
	);
	if (body.schema_version !== 1) {
		throw new InternalJobRequestError("schema_version must be 1");
	}
	const jobId = requireCanonicalJobId(body.job_id);
	const stage = requireInternalStageKind(body.stage);
	const inputDigest = requireSha256(body.input_digest, "input_digest");
	const input = requireObject(body.input, "input");
	const parameters = body.parameters == null ? {} : requireObject(body.parameters, "parameters");
	return {
		schema_version: 1,
		job_id: jobId,
		stage,
		input_digest: inputDigest,
		input,
		parameters,
	};
}

export function parseRetryRequest(value: unknown): RetryRequest {
	const body = requireObject(value, "retry body");
	requireExactKeys(body, new Set(["expected_attempt", "idempotency_key"]), "retry body");
	if (!Number.isInteger(body.expected_attempt) || Number(body.expected_attempt) < 1) {
		throw new InternalJobRequestError("expected_attempt must be a positive integer");
	}
	if (typeof body.idempotency_key !== "string" || !IDEMPOTENCY_PATTERN.test(body.idempotency_key)) {
		throw new InternalJobRequestError("idempotency_key must contain 1-128 safe characters");
	}
	return {
		expected_attempt: Number(body.expected_attempt),
		idempotency_key: body.idempotency_key,
	};
}

export function requireInternalStageKind(value: unknown): InternalStageKind {
	if (typeof value !== "string" || !(INTERNAL_STAGE_KINDS as readonly string[]).includes(value)) {
		throw new InternalJobRequestError(`unsupported stage: ${String(value)}`);
	}
	return value as InternalStageKind;
}

export function requireCanonicalJobId(value: unknown): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
		throw new InternalJobRequestError("job_id must be a canonical lowercase UUID");
	}
	return value;
}

export function requireSha256(value: unknown, field: string): string {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
		throw new InternalJobRequestError(`${field} must be a lowercase SHA-256 digest`);
	}
	return value;
}

export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
			left.localeCompare(right),
		);
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
	}
	const encoded = JSON.stringify(value);
	if (encoded === undefined) {
		throw new InternalJobRequestError("request contains a value that cannot be represented as JSON");
	}
	return encoded;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new InternalJobRequestError(`${field} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, expected: Set<string>, field: string): void {
	const unexpected = Object.keys(value).filter((key) => !expected.has(key));
	if (unexpected.length > 0) {
		throw new InternalJobRequestError(`${field} contains unsupported fields: ${unexpected.sort().join(", ")}`);
	}
}
