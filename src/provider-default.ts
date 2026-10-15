/**
 * Provider default — the LAST-RESORT env-gated provider literal.
 *
 * Kept as a pure host-side helper so provider resolution never imports an
 * agent runtime.
 *
 * This is the "degrades to a LAST-RESORT default only" leg of the north star:
 * AGENT_LLM_PROVIDER is the floor, NOT the per-request control surface.
 *
 * PURE / no-import: a literal set + a single env read. No Pi, no I/O.
 */

/** Provider literals the host egress registry understands. */
export const KNOWN_PROVIDERS = ["openrouter", "deepseek", "lmstudio", "anthropic"] as const;

/** A provider literal accepted by the host egress registry. */
export type AgentLlmProvider = (typeof KNOWN_PROVIDERS)[number];

/**
 * Read AGENT_LLM_PROVIDER → a known provider literal (default "openrouter").
 *
 * DEFAULT-PRESERVED: unset / unrecognized ⇒ "openrouter" (the S6 behavior,
 * byte-unchanged). This is the env-default floor of `resolveInferenceBinding`.
 */
export function resolveAgentLlmProvider(env: NodeJS.ProcessEnv = process.env): AgentLlmProvider {
	const p = env.AGENT_LLM_PROVIDER;
	return p === "deepseek" || p === "lmstudio" || p === "anthropic" ? p : "openrouter";
}
