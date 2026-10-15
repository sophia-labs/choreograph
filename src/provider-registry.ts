/**
 * Provider registry — the provider-keyed egress map for the orchestrator's LLM
 * proxy.
 *
 * CA-1 / shared substrate (Stage I). This is the "provider-PLUGGABLE egress, not
 * an OpenRouter-shaped pipe" leg of the agent-subject control surface. The
 * orchestrator's `handleLlmRequest` (the host-mediated LLM proxy) dispatches on
 * the `provider` carried per-request by the worker's resolved model, looking up
 * the egress `{ baseUrl, keyEnv }` here. An UNKNOWN provider is the only 400.
 *
 * Note on baseUrl: Pi's own catalog (`getModel(provider, id)`) already stamps the
 * correct `baseUrl` onto the resolved model (verified: deepseek →
 * https://api.deepseek.com, openrouter → https://openrouter.ai/api/v1), and Pi's
 * `streamSimple` uses `model.baseUrl`. So this registry's `baseUrl` is the
 * AUTHORITATIVE proxy-side value (used for the orchestrator's own routing/logging
 * and as the egress contract); it is intentionally identical to Pi's catalog so
 * the two never disagree. `keyEnv` is the load-bearing field: it tells the proxy
 * WHICH env var holds the key for that provider (DEEPSEEK_API_KEY vs
 * OPENROUTER_API_KEY), which is exactly what the old hardcoded-OpenRouter egress
 * got wrong for a deepseek model.
 *
 * PURE / no-import: declares data + two pure lookups. No Pi, no I/O, no network.
 */

export type ProviderCredentialBinding = { readonly kind: "environment"; readonly keyEnv: string };

/** One provider's egress contract: where to send and how the host resolves credentials. */
export interface ProviderEntry {
	/** The provider's API base URL (matches Pi's catalog baseUrl for that provider). */
	readonly baseUrl: string;
	readonly credential: ProviderCredentialBinding;
	/** Compatibility/readability alias for environment-backed providers. */
	readonly keyEnv?: string;
}

/**
 * The known providers' egress contracts. KEYED BY PROVIDER. This is the registry
 * the orchestrator dispatches over: a provider present here is routed to its
 * `baseUrl` with its `keyEnv` key; a provider absent here is rejected (400/unknown).
 *
 * Mirrors Pi's `env-api-keys.js` mapping for the providers choreograph speaks
 * (deepseek → DEEPSEEK_API_KEY, openrouter → OPENROUTER_API_KEY) so the proxy's
 * key resolution and Pi's internal `getEnvApiKey` never disagree.
 */
export const PROVIDER_REGISTRY: Record<string, ProviderEntry> = {
	openrouter: {
		baseUrl: "https://openrouter.ai/api/v1",
		credential: { kind: "environment", keyEnv: "OPENROUTER_API_KEY" },
		keyEnv: "OPENROUTER_API_KEY",
	},
	deepseek: {
		baseUrl: "https://api.deepseek.com",
		credential: { kind: "environment", keyEnv: "DEEPSEEK_API_KEY" },
		keyEnv: "DEEPSEEK_API_KEY",
	},
	// Local-dev inference (LM Studio serving an OpenAI-compatible endpoint on the
	// host Mac). `host.lima.internal` is the guest→host name inside the Lima VM,
	// where the orchestrator runs in local dev; the egress is unreachable from the
	// EC2 target by construction. LM Studio ignores the bearer key, but the proxy
	// requires keyEnv to be set — use a dummy value (e.g. LMSTUDIO_API_KEY=lm-studio).
	lmstudio: {
		baseUrl: "http://host.lima.internal:1234/v1",
		credential: { kind: "environment", keyEnv: "LMSTUDIO_API_KEY" },
		keyEnv: "LMSTUDIO_API_KEY",
	},
	// Anthropic first-party. The env var may hold EITHER an API key (sk-ant-api…)
	// or a Claude subscription OAuth access token (sk-ant-oat…): Pi's anthropic
	// provider detects the oat prefix and switches to Bearer auth + the
	// oauth-2025-04-20 beta + Claude Code identity headers on its own. OAuth
	// tokens are short-lived — re-mint and restart when the egress starts 401ing.
	anthropic: {
		baseUrl: "https://api.anthropic.com",
		credential: { kind: "environment", keyEnv: "ANTHROPIC_OAUTH_TOKEN" },
		keyEnv: "ANTHROPIC_OAUTH_TOKEN",
	},
};

/** True iff `p` is a provider the egress can route (present in the registry). */
export function isKnownProvider(p: string): boolean {
	return Object.hasOwn(PROVIDER_REGISTRY, p);
}

/** The egress contract for `p`, or `undefined` when `p` is not a known provider. */
export function resolveProviderEntry(p: string): ProviderEntry | undefined {
	return isKnownProvider(p) ? PROVIDER_REGISTRY[p] : undefined;
}
