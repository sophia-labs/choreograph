/**
 * Trace span helpers and attribute conventions.
 *
 * Span attribute conventions:
 *   sandbox.id            — sandbox identifier (span-level only, not on metrics)
 *   sandbox.template      — sandbox template name
 *   sandbox.terminal_state — final exit state
 *   agent.run_id          — agent run identifier
 *   agent.session_id      — session identifier
 *   agent.model           — LLM model name
 *   agent.tool_profile    — tool profile (chat, agent, full)
 *   agent.outcome         — run outcome (terminated, truncated, error)
 *
 * PROD-8: API keys and session tokens MUST NOT appear in span attributes.
 */

import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("sandbox-mgmt");

/** Keys that must never appear in span attributes (PROD-8). */
const REDACTED_KEYS = new Set([
	"api_key",
	"apiKey",
	"openrouter_api_key",
	"session_token",
	"token",
	"authorization",
	"secret",
	"password",
	"credential",
]);

/**
 * Execute `fn` inside a traced span.
 *
 * Attributes are sanitized: any key matching REDACTED_KEYS is stripped.
 * On error, the span status is set to ERROR and the exception is recorded.
 */
export async function traceSpan<T>(
	name: string,
	attributes: Record<string, string | number | boolean>,
	fn: (span: Span) => Promise<T>,
): Promise<T> {
	return tracer.startActiveSpan(name, async (span) => {
		const safe = sanitizeAttributes(attributes);
		for (const [key, value] of Object.entries(safe)) {
			span.setAttribute(key, value);
		}

		try {
			const result = await fn(span);
			span.setStatus({ code: SpanStatusCode.OK });
			return result;
		} catch (error) {
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: error instanceof Error ? error.message : String(error),
			});
			span.recordException(error instanceof Error ? error : new Error(String(error)));
			throw error;
		} finally {
			span.end();
		}
	});
}

/**
 * Strip redacted keys from attributes. Case-insensitive matching.
 */
function sanitizeAttributes(
	attributes: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
	const result: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(attributes)) {
		if (!REDACTED_KEYS.has(key.toLowerCase())) {
			result[key] = value;
		}
	}
	return result;
}
