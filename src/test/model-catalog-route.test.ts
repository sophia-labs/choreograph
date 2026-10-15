import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routeRequest } from "../orchestrator.js";

describe("GET /api/models dynamic catalog route", () => {
	it("serves the trusted cached view and preserves query/sort/limit", async () => {
		let received: unknown;
		const modelCatalog = {
			async list(options: unknown) {
				received = options;
				return {
					provider: "openrouter",
					fetched_at: "2026-07-31T18:00:00.000Z",
					auth_configured: false,
					catalog_count: 1,
					live_count: 1,
					models: [{ id: "thinkingmachines/inkling" }],
					cache: {
						state: "fresh",
						source: "live",
						age_ms: 10,
						ttl_ms: 900_000,
						digest: "d".repeat(64),
						refreshing: false,
					},
				};
			},
		};
		const request = {
			method: "GET",
			url: "/api/models?q=inkling&sort=prompt_price&limit=7",
			headers: { host: "localhost" },
		};
		let body = "";
		const response = {
			statusCode: 0,
			setHeader() {},
			end(chunk: string) {
				body = chunk;
			},
		};

		await routeRequest(request as never, response as never, { modelCatalog } as never);

		assert.equal(response.statusCode, 200);
		assert.deepEqual(received, { query: "inkling", sort: "prompt_price", limit: 7 });
		const payload = JSON.parse(body);
		assert.equal(payload.models[0].id, "thinkingmachines/inkling");
		assert.equal(payload.cache.source, "live");
	});
});
