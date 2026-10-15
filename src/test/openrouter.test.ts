import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeOpenRouterModelCatalogs } from "../openrouter.js";

describe("mergeOpenRouterModelCatalogs()", () => {
	it("keeps routeable live ids distinct when variants share a canonical slug", () => {
		const models = mergeOpenRouterModelCatalogs(
			[
				{
					id: "arcee-ai/trinity-mini",
					name: "Trinity Mini",
					api: "openai-completions",
					provider: "openrouter",
					baseUrl: "https://openrouter.ai/api/v1",
					reasoning: true,
					input: ["text"],
					cost: { input: 0.045, output: 0.15, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 131072,
					maxTokens: 131072,
				},
				{
					id: "arcee-ai/trinity-mini:free",
					name: "Trinity Mini (free)",
					api: "openai-completions",
					provider: "openrouter",
					baseUrl: "https://openrouter.ai/api/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 131072,
					maxTokens: 4096,
				},
			],
			[
				{
					id: "arcee-ai/trinity-mini",
					canonical_slug: "arcee-ai/trinity-mini-20251201",
					name: "Trinity Mini",
					pricing: { prompt: "0.000000045", completion: "0.00000015" },
					context_length: 131072,
					top_provider: { max_completion_tokens: 131072 },
					supported_parameters: ["tools"],
				},
				{
					id: "arcee-ai/trinity-mini:free",
					canonical_slug: "arcee-ai/trinity-mini-20251201",
					name: "Trinity Mini (free)",
					pricing: { prompt: "0", completion: "0" },
					context_length: 131072,
					top_provider: { max_completion_tokens: 4096 },
					supported_parameters: ["tools"],
				},
			],
		);

		const ids = models.map((model) => model.id).sort();
		assert.deepEqual(ids, ["arcee-ai/trinity-mini", "arcee-ai/trinity-mini:free"]);

		const freeModel = models.find((model) => model.id === "arcee-ai/trinity-mini:free");
		assert.equal(freeModel?.canonical_id, "arcee-ai/trinity-mini-20251201");
		assert.equal(freeModel?.supports_tools, true);
	});

	it("deduplicates canonical catalog matches onto the live route id", () => {
		const models = mergeOpenRouterModelCatalogs(
			[
				{
					id: "vendor/example-model",
					name: "Example Model",
					api: "openai-completions",
					provider: "openrouter",
					baseUrl: "https://openrouter.ai/api/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32000,
					maxTokens: 2048,
				},
			],
			[
				{
					id: "vendor/example-model:free",
					canonical_slug: "vendor/example-model",
					name: "Example Model (free)",
					pricing: { prompt: "0", completion: "0" },
					context_length: 32000,
				},
			],
		);

		assert.equal(models.length, 1);
		assert.equal(models[0]?.id, "vendor/example-model:free");
		assert.equal(models[0]?.canonical_id, "vendor/example-model");
		assert.equal(models[0]?.catalog_available, true);
		assert.equal(models[0]?.live_available, true);
	});
});
