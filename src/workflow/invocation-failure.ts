/**
 * Honest invocation failures.
 *
 * Before a run exists, an invocation can fail because the graph is not
 * configured for it (no Domain Agent definition, a bad manifest, a grant that
 * does not verify), because the caller may not do it, or because a dependency
 * is down. Each of those is a definite outcome with a stable machine code; none
 * of them is an internal server error. Clients rely on the difference: a 4xx or
 * a coded 5xx here means no run was started, so nothing "may have committed".
 *
 * Every failed invocation is also logged as one structured line with no
 * request body, no tokens and a bounded, redacted message.
 */

import { InvocationFault } from "./invocation.js";

export interface ClassifiedInvocationFailure {
	readonly status: number;
	readonly code: string;
	readonly message: string;
	readonly details?: unknown;
}

/** Error families whose `code` is a stable, public configuration/authority verdict. */
const CODED_FAMILIES = new Set([
	"DomainAgentConfigError",
	"PromptGraphError",
	"GrantValidationError",
	"TriggerConsentError",
	"DomainSourceTurnError",
	"AgentModeError",
	"AgentRuntimeBindingFault",
	"AgentOntologyBindingFault",
	"MeaningfulObjectRefFault",
]);

const STABLE_CODE = /^[a-z][a-z0-9_]{1,63}$/;

/** Default HTTP status for a coded configuration/authority failure. */
export function statusForFailureCode(code: string): number {
	if (code === "domain_agent_not_provisioned") return 404;
	if (code === "toolbelt_denied" || code.endsWith("_denied") || code === "mode_not_permitted") return 403;
	if (code.endsWith("_unavailable")) return 503;
	if (code.endsWith("_not_found")) return 404;
	return 409;
}

/**
 * Map anything thrown before (or while) starting a run to a status and code.
 * Unknown errors stay 500, but still carry a code so the client can tell a
 * pre-run failure from a lost response.
 */
export function classifyInvocationFailure(
	error: unknown,
	fallbackCode = "invocation_failed",
): ClassifiedInvocationFailure {
	if (error instanceof InvocationFault) {
		return {
			status: error.status,
			code: error.code,
			message: error.message,
			...(error.details === undefined ? {} : { details: jsonSafe(error.details) }),
		};
	}
	const record = error !== null && typeof error === "object" ? (error as Record<string, unknown>) : {};
	const message = error instanceof Error ? error.message : String(error);
	const explicitStatus =
		typeof record.status === "number" && record.status >= 400 && record.status < 600 ? record.status : undefined;
	const code = typeof record.code === "string" && STABLE_CODE.test(record.code) ? record.code : undefined;
	const family = error instanceof Error ? error.name : "";
	if (code && CODED_FAMILIES.has(family)) {
		return {
			status: explicitStatus ?? statusForFailureCode(code),
			code,
			message,
			...(record.details === undefined ? {} : { details: jsonSafe(record.details) }),
		};
	}
	if (explicitStatus !== undefined) {
		return {
			status: explicitStatus,
			code: code ?? (explicitStatus < 500 ? "invalid_request" : fallbackCode),
			message,
		};
	}
	return { status: 500, code: fallbackCode, message };
}

/** The wire body: the same `{ error: { code, message, details? } }` envelope InvocationFault uses. */
export function invocationFailureBody(failure: ClassifiedInvocationFailure): {
	error: { code: string; message: string; details?: unknown };
} {
	return {
		error: {
			code: failure.code,
			message: failure.message,
			...(failure.details === undefined ? {} : { details: failure.details }),
		},
	};
}

export interface InvocationFailureLogFields {
	readonly stage: string;
	readonly status: number;
	readonly code: string;
	readonly message: string;
	readonly workflow?: string;
	readonly graphId?: string;
	readonly invocationId?: string;
	readonly runId?: string;
	readonly ownerUserId?: string;
}

/** One JSON line per failed invocation. Never pass request bodies or headers here. */
export function formatInvocationFailureLog(fields: InvocationFailureLogFields): string {
	const line: Record<string, unknown> = { event: "invocation_failed" };
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined) continue;
		line[key] = typeof value === "string" ? redactForLog(value) : value;
	}
	return `[invocation] ${JSON.stringify(line)}`;
}

export function logInvocationFailure(
	fields: InvocationFailureLogFields,
	sink: (line: string) => void = (line) => console.error(line),
): void {
	sink(formatInvocationFailureLog(fields));
}

/** Bound and scrub a message: bearer tokens, JWTs and provider keys never reach the log. */
export function redactForLog(text: string, maxLength = 500): string {
	const scrubbed = text
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
		.replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, "[redacted-jwt]")
		.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted-key]")
		.replace(/([?&](?:token|key|secret|signature|X-Amz-Signature)=)[^&\s]+/gi, "$1[redacted]");
	return scrubbed.length > maxLength ? `${scrubbed.slice(0, maxLength)}…` : scrubbed;
}

/** Details cross the wire as JSON; Error causes become their message only. */
function jsonSafe(value: unknown): unknown {
	try {
		return JSON.parse(
			JSON.stringify(value, (_key, inner: unknown) =>
				inner instanceof Error ? { name: inner.name, message: redactForLog(inner.message) } : inner,
			),
		) as unknown;
	} catch {
		return undefined;
	}
}
