/**
 * CA-1 / shared substrate — the provider-keyed egress dispatch (NO NETWORK).
 *
 * NO MOCKS. This drives:
 *   - the REAL provider registry (`src/provider-registry.ts`): each known
 *     provider's `{ baseUrl, keyEnv }`, the known-set guard, and unknown→reject.
 *   - the REAL Pi `@earendil-works/pi-ai` `getModel` catalog: the deepseek model
 *     a real spawn would resolve carries provider=deepseek + the api.deepseek.com
 *     baseUrl, so the registry's deepseek entry MATCHES Pi's catalog (the two
 *     never disagree — the load-bearing grounding).
 *   - the REAL egress `proxyLlmRequest`'s PRE-STREAM guards: unknown provider and
 *     missing key both throw BEFORE any socket opens. (The happy-path stream IS
 *     the live bring-up turn, NOT here — pulling it would dial the provider.)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getModel } from "@earendil-works/pi-ai";
import { proxyLlmRequest } from "../openrouter.js";
import { isKnownProvider, PROVIDER_REGISTRY, resolveProviderEntry } from "../provider-registry.js";

describe("CA-1 substrate — provider registry dispatch", () => {
	it("provider=deepseek → api.deepseek.com + DEEPSEEK_API_KEY keyEnv", () => {
		const entry = resolveProviderEntry("deepseek");
		assert.ok(entry, "deepseek must be a known provider");
		assert.equal(entry.baseUrl, "https://api.deepseek.com");
		assert.equal(entry.keyEnv, "DEEPSEEK_API_KEY");
	});

	it("provider=openrouter → openrouter.ai + OPENROUTER_API_KEY keyEnv", () => {
		const entry = resolveProviderEntry("openrouter");
		assert.ok(entry, "openrouter must be a known provider");
		assert.equal(entry.baseUrl, "https://openrouter.ai/api/v1");
		assert.equal(entry.keyEnv, "OPENROUTER_API_KEY");
	});

	it("an unknown provider is NOT known and resolves to undefined (the only rejection)", () => {
		assert.equal(isKnownProvider("totally-not-a-provider"), false);
		assert.equal(resolveProviderEntry("totally-not-a-provider"), undefined);
		assert.equal(isKnownProvider("deepseek"), true);
		assert.equal(isKnownProvider("openrouter"), true);
	});

	it("the registry's baseUrl matches Pi's REAL catalog for the same provider (no disagreement)", () => {
		// A real spawn resolves the model via Pi's getModel; the egress reads the
		// provider off that model. The registry baseUrl MUST equal the catalog's.
		const ds = getModel("deepseek", "deepseek-v4-flash" as never) as
			| { provider?: string; baseUrl?: string }
			| undefined;
		assert.ok(ds, "Pi must resolve a real deepseek catalog model");
		assert.equal(ds.provider, "deepseek");
		assert.equal(ds.baseUrl, PROVIDER_REGISTRY.deepseek.baseUrl);

		const or = getModel("openrouter", "google/gemini-2.5-flash" as never) as
			| { provider?: string; baseUrl?: string }
			| undefined;
		assert.ok(or, "Pi must resolve a real openrouter catalog model");
		assert.equal(or.provider, "openrouter");
		assert.equal(or.baseUrl, PROVIDER_REGISTRY.openrouter.baseUrl);
	});
});

describe("CA-1 substrate — proxyLlmRequest pre-stream guards (no socket)", () => {
	it("an UNKNOWN provider on the model is rejected before any stream opens", async () => {
		const model = { id: "x", provider: "totally-not-a-provider", api: "openai-completions", baseUrl: "http://nope" };
		await assert.rejects(
			() => drainFirst(proxyLlmRequest(model, { messages: [] }, { env: { TOTALLY_NOT_A_PROVIDER_API_KEY: "k" } })),
			/Unsupported LLM provider: "totally-not-a-provider"/,
		);
	});

	it("a known provider with a MISSING key is rejected before any stream opens", async () => {
		// deepseek model, but DEEPSEEK_API_KEY absent from the supplied env → throws
		// the keyEnv-specific error, never reaching streamSimple / the network.
		const model = getModel("deepseek", "deepseek-v4-flash" as never);
		await assert.rejects(
			() => drainFirst(proxyLlmRequest(model, { messages: [] }, { env: {} })),
			/DEEPSEEK_API_KEY is required/,
		);
	});

	it("a known openrouter provider with a missing key is rejected with its keyEnv name", async () => {
		const model = getModel("openrouter", "google/gemini-2.5-flash" as never);
		await assert.rejects(
			() => drainFirst(proxyLlmRequest(model, { messages: [] }, { env: {} })),
			/OPENROUTER_API_KEY is required/,
		);
	});
});

/**
 * Pull the FIRST value from the egress async generator. The pre-stream guards
 * throw on the first `next()` (before `streamSimple`), so this surfaces them
 * without ever opening a socket. We never reach a real chunk in these cases.
 */
async function drainFirst(gen: AsyncGenerator<unknown>): Promise<void> {
	await gen.next();
}
