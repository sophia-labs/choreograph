import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ModelCapabilityError, OpenRouterModelCatalog, type TrustedModelDescriptor } from "../model-catalog.js";
import type { OpenRouterCatalogPayload, OpenRouterModelRow } from "../openrouter.js";
import { SandboxStore } from "../sandbox-store.js";
import { SandboxSpawner } from "../spawner.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

const NOW = Date.parse("2026-07-31T18:00:00.000Z");

describe("OpenRouterModelCatalog", () => {
	it("persists a validated snapshot and serves it as last-known-good when refresh fails", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "choreograph-model-catalog-"));
		const snapshotPath = join(tempDir, "openrouter.json");
		try {
			const live = catalog([
				row({
					id: "thinkingmachines/inkling",
					canonical_id: "thinkingmachines/inkling-20260715",
					name: "Inkling",
					context_length: 1_048_576,
					max_completion_tokens: 65_536,
					supported_parameters: ["tools", "reasoning", "reasoning_effort"],
					supports_tools: true,
					live_available: true,
				}),
			]);
			const first = new OpenRouterModelCatalog({
				snapshotPath,
				now: () => NOW,
				refreshOnInit: false,
				refreshIntervalMs: 0,
				loadCatalog: async ({ includeLive }) => (includeLive ? live : catalog([row()])),
			});
			await first.initialize();
			await first.refresh();
			const firstView = await first.list({ query: "Inkling" });
			assert.equal(firstView.models.length, 1);
			assert.equal(firstView.cache.source, "live");
			assert.equal(firstView.cache.state, "fresh");
			const persisted = JSON.parse(await readFile(snapshotPath, "utf8"));
			assert.equal(persisted.schema_version, 1);
			assert.equal(persisted.digest, firstView.cache.digest);
			first.close();

			const second = new OpenRouterModelCatalog({
				snapshotPath,
				now: () => NOW + 60 * 60_000,
				ttlMs: 1_000,
				refreshOnInit: false,
				refreshIntervalMs: 0,
				loadCatalog: async () => {
					throw new Error("provider offline");
				},
			});
			await second.initialize();
			await assert.rejects(second.refresh(), /provider offline/);
			const fallback = await second.list({ query: "Inkling" });
			assert.equal(fallback.models[0]?.id, "thinkingmachines/inkling");
			assert.equal(fallback.cache.source, "disk");
			assert.equal(fallback.cache.state, "stale");
			assert.match(fallback.cache.last_error ?? "", /provider offline/);
			second.close();
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("deduplicates concurrent refreshes", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "choreograph-model-catalog-"));
		try {
			let release!: (value: OpenRouterCatalogPayload) => void;
			const deferred = new Promise<OpenRouterCatalogPayload>((resolve) => {
				release = resolve;
			});
			let calls = 0;
			const service = new OpenRouterModelCatalog({
				snapshotPath: join(tempDir, "openrouter.json"),
				refreshOnInit: false,
				refreshIntervalMs: 0,
				loadCatalog: async () => {
					calls += 1;
					return deferred;
				},
			});
			const left = service.refresh();
			const right = service.refresh();
			assert.equal(calls, 1);
			release(catalog([row({ live_available: true })]));
			const [leftSnapshot, rightSnapshot] = await Promise.all([left, right]);
			assert.equal(leftSnapshot.digest, rightSnapshot.digest);
			assert.equal(calls, 1);
			service.close();
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("refreshes an unknown id once and normalizes Inkling for the sandbox", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "choreograph-model-catalog-"));
		try {
			let liveCalls = 0;
			const service = new OpenRouterModelCatalog({
				snapshotPath: join(tempDir, "openrouter.json"),
				refreshOnInit: false,
				refreshIntervalMs: 0,
				loadCatalog: async ({ includeLive }) => {
					if (!includeLive) return catalog([row()]);
					liveCalls += 1;
					return catalog([
						row({
							id: "thinkingmachines/inkling",
							canonical_id: "thinkingmachines/inkling-20260715",
							name: "Inkling",
							prompt_price: 0.000001,
							completion_price: 0.00000405,
							context_length: 1_048_576,
							max_completion_tokens: 65_536,
							supported_parameters: ["tools", "reasoning", "reasoning_effort"],
							supports_tools: true,
							live_available: true,
							catalog_available: false,
						}),
					]);
				},
			});
			await service.initialize();
			const descriptor = await service.resolveModel("openrouter", "thinkingmachines/inkling", {
				requireTools: true,
			});
			assert.equal(liveCalls, 1);
			assert.equal(descriptor?.canonicalId, "thinkingmachines/inkling-20260715");
			assert.equal(descriptor?.contextWindow, 1_048_576);
			assert.equal(descriptor?.maxTokens, 65_536);
			assert.equal(descriptor?.reasoning, true);
			assert.equal(descriptor?.supportsTools, true);
			assert.equal(descriptor?.cost.input, 1);
			assert.equal(descriptor?.cost.output, 4.05);
			service.close();
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("fails closed when an agent model explicitly lacks tool support", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "choreograph-model-catalog-"));
		try {
			const service = new OpenRouterModelCatalog({
				snapshotPath: join(tempDir, "openrouter.json"),
				refreshOnInit: false,
				refreshIntervalMs: 0,
				loadCatalog: async ({ includeLive }) =>
					includeLive
						? catalog([
								row({
									id: "thinkingmachines/inkling-small",
									canonical_id: "thinkingmachines/inkling-small-20260730",
									supported_parameters: ["reasoning"],
									supports_tools: false,
									live_available: true,
								}),
							])
						: catalog([row()]),
			});
			await service.initialize();
			await assert.rejects(
				service.resolveModel("openrouter", "thinkingmachines/inkling-small", { requireTools: true }),
				(error: unknown) =>
					error instanceof ModelCapabilityError &&
					error.code === "model_capability_missing" &&
					error.capability === "tools",
			);
			service.close();
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("mints the descriptor at the shared spawner seam and ignores a client-provided overlay", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "choreograph-model-catalog-"));
		const store = new SandboxStore(join(tempDir, "sandboxes.sqlite"));
		try {
			const trusted = inklingDescriptor();
			const semantic = makeTestAgentSemanticBinding({ registeredName: "model-catalog-agent" });
			let call: { provider: string; modelId: string; options?: { requireTools?: boolean } } | undefined;
			const spawner = new SandboxSpawner(store, { parentPath: "/sys/fs/cgroup/test", version: 2 } as never, {
				modelCatalog: {
					async resolveModel(provider, modelId, options) {
						call = { provider, modelId, options };
						return trusted;
					},
				},
			});
			const malicious = { ...trusted, contextWindow: 1 };
			const { request } = await (spawner as any).buildAgentRequest(
				"sandbox-catalog-test",
				{ template: "agent" },
				{
					mode: "agent",
					model: "thinkingmachines/inkling",
					provider: "openrouter",
					session_id: "session-model-catalog-agent",
					generation: 0,
					agent_id: semantic.agentId,
					runtime_binding: semantic.runtime,
					runtime_binding_digest: semantic.runtimeBindingDigest,
					agent_ontology: semantic.ontology,
					agent_ontology_binding_digest: semantic.ontologyBindingDigest,
					request: { model_descriptor: malicious },
				},
			);
			assert.deepEqual(call, {
				provider: "openrouter",
				modelId: "thinkingmachines/inkling",
				options: { requireTools: true },
			});
			assert.equal(request.model_descriptor, trusted);
			assert.equal(request.model_descriptor.contextWindow, 1_048_576);
		} finally {
			store.close();
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});

function catalog(models: OpenRouterModelRow[]): OpenRouterCatalogPayload {
	return {
		provider: "openrouter",
		fetched_at: new Date(NOW).toISOString(),
		auth_configured: false,
		catalog_count: models.filter((model) => model.catalog_available).length,
		live_count: models.filter((model) => model.live_available).length,
		models,
	};
}

function row(overrides: Partial<OpenRouterModelRow> = {}): OpenRouterModelRow {
	return {
		id: "google/gemini-2.5-flash",
		canonical_id: null,
		name: "Gemini 2.5 Flash",
		description: null,
		created: null,
		prompt_price: null,
		completion_price: null,
		request_price: null,
		image_price: null,
		cache_read_price: null,
		cache_write_price: null,
		pricing_raw: null,
		context_length: 1_048_576,
		max_completion_tokens: 65_536,
		input_modalities: ["text", "image"],
		output_modalities: ["text"],
		supported_parameters: null,
		supports_tools: null,
		reasoning: true,
		api: "openai-completions",
		base_url: "https://openrouter.ai/api/v1",
		catalog_cost_per_million: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
		live_available: false,
		catalog_available: true,
		...overrides,
	};
}

function inklingDescriptor(): TrustedModelDescriptor {
	return {
		id: "thinkingmachines/inkling",
		canonicalId: "thinkingmachines/inkling-20260715",
		name: "Inkling",
		api: "openai-completions",
		provider: "openrouter",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 4.05, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		supportedParameters: ["tools", "reasoning", "reasoning_effort"],
		supportsTools: true,
		catalogDigest: "c".repeat(64),
		catalogFetchedAt: new Date(NOW).toISOString(),
	};
}
