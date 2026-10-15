/**
 * Why a tool call failed, for the host's log: an error code where one can be read and the first part of the message,
 * never the call's content.
 *
 * The durable Session record keeps a failed call as `{tool, isError}` only, and the host used to log nothing but
 * `error=true` under the sandbox id, so a chat tool failure left no reason anywhere (live, 2026-10-07: the Writer's
 * `write_document` failed and nobody could say why). What is kept:
 * - the text of the error, from the worker's rendered result (`{content: [{type: "text", text}]}`) or the cell's answer;
 * - cut before the worker's echo of the arguments ("Received arguments:"), which carries content;
 * - quoted runs of 48 characters or more elided, whitespace collapsed, control characters dropped, at most 300 characters;
 * - a code from a structured error (`code`, `error.code`), a mode denial (`mode_denied(reason)`) or the worker's argument
 *   validation.
 */

export interface ToolErrorSummaryV1 {
	readonly code?: string;
	readonly message: string;
}

const MAX_MESSAGE_CHARS = 300;
const CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function parseJson(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{")) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function textParts(value: Record<string, unknown>): string | undefined {
	if (!Array.isArray(value.content)) return undefined;
	const parts = value.content.flatMap((part) => {
		const entry = record(part);
		return entry?.type === "text" && typeof entry.text === "string" ? [entry.text] : [];
	});
	return parts.length > 0 ? parts.join("\n") : undefined;
}

function codeOf(value: Record<string, unknown> | undefined): string | undefined {
	if (!value) return undefined;
	for (const candidate of [value.code, record(value.error)?.code]) {
		if (typeof candidate === "string" && CODE.test(candidate)) return candidate;
		if (typeof candidate === "number" && Number.isSafeInteger(candidate)) return String(candidate);
	}
	return undefined;
}

/** The error text of a failed call's result: the worker's rendered tool result, an MCP result, or plain text. */
function errorText(result: unknown): { text: string; structured?: Record<string, unknown> } {
	let value: unknown = result;
	if (typeof value === "string") value = parseJson(value) ?? value;
	const object = record(value);
	if (!object) return { text: typeof value === "string" ? value : "" };
	const text = textParts(object);
	if (text === undefined) {
		const error = record(object.error);
		const message = typeof object.message === "string" ? object.message : error?.message;
		return { text: typeof message === "string" ? message : "", structured: object };
	}
	// A cell's error text may itself be a JSON error object.
	const inner = record(parseJson(text));
	if (inner) {
		const error = record(inner.error);
		const message = typeof inner.message === "string" ? inner.message : error?.message;
		return { text: typeof message === "string" ? message : text, structured: inner };
	}
	return { text, structured: object };
}

export function toolErrorSummary(result: unknown): ToolErrorSummaryV1 {
	const { text, structured } = errorText(result);
	const argumentsEcho = text.search(/Received arguments\s*:/);
	const message = (argumentsEcho >= 0 ? text.slice(0, argumentsEcho) : text)
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
		.replace(/"[^"]{48,}"|'[^']{48,}'/g, '"…"')
		.replace(/\s+/g, " ")
		.trim();
	const bounded =
		[...message].length > MAX_MESSAGE_CHARS ? `${[...message].slice(0, MAX_MESSAGE_CHARS).join("")}…` : message;
	const denied = /mode_denied\(([a-z_]{1,48})\)/.exec(message)?.[1];
	const code =
		codeOf(structured) ??
		(denied ? `mode_denied:${denied}` : undefined) ??
		(/^Validation failed for tool /.test(message) ? "argument_validation" : undefined);
	return { ...(code ? { code } : {}), message: bounded || "(no error text)" };
}

/** One log line for a failed chat tool call: ids, tool, code and the bounded message. */
export function toolFailureLogLine(input: {
	readonly where: "worker" | "cell";
	readonly sessionId?: string;
	readonly sandboxId: string;
	readonly tool: string;
	readonly result: unknown;
}): string {
	const summary = toolErrorSummary(input.result);
	return `[chat] WARN: tool failed (${input.where}): session=${input.sessionId ?? "-"} sandbox=${input.sandboxId.slice(0, 8)} tool=${input.tool} code=${summary.code ?? "-"} message=${JSON.stringify(summary.message)}`;
}
