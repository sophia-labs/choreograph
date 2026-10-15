import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fullPrecisionEndpoint } from "../chat-precision.js";
import { OpenRouterEndpointsCatalog } from "../model-endpoints.js";

/**
 * The host reads each voice's providers from OpenRouter's public `GET /api/v1/models/{id}/endpoints` (no key), keeps
 * them on disk so a restart does not start blind, and reads a listing again once it is older than its time to live.
 * Real HTTP: a local server stands in for OpenRouter, answering with listings OpenRouter gave on 2026-10-01.
 */

const FIXTURE = JSON.parse(
	readFileSync(new URL("./fixtures/openrouter-endpoints-20261001.json", import.meta.url), "utf8"),
) as { models: Record<string, unknown> };

async function withOpenRouter(run: (baseUrl: string, seen: string[]) => Promise<void>): Promise<void> {
	const seen: string[] = [];
	const server = createServer((request: IncomingMessage, response) => {
		const path = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
		seen.push(path);
		const match = /^\/api\/v1\/models\/(.+)\/endpoints$/.exec(path);
		const data = match ? FIXTURE.models[match[1]] : undefined;
		if (!data) {
			response.writeHead(404, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "Model not found", code: 404 } }));
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ data }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	try {
		await run(`http://127.0.0.1:${port}/api/v1`, seen);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

describe("the providers of each voice", () => {
	it("reads each voice's listing, keeps it on disk, and serves it after a restart without reading again", async () => {
		const dir = await mkdtemp(join(tmpdir(), "endpoints-"));
		const clock = Date.parse("2026-10-01T22:00:00.000Z");
		try {
			await withOpenRouter(async (baseUrl, seen) => {
				const first = new OpenRouterEndpointsCatalog({
					snapshotPath: join(dir, "endpoints.json"),
					baseUrl,
					spacingMs: 0,
					now: () => clock,
				});
				await first.initialize();
				const result = await first.refresh([
					"moonshotai/kimi-k2.6",
					"google/gemini-2.5-flash",
					"vendor/not-listed",
					"~moonshotai/kimi-latest",
				]);
				assert.deepEqual(result, { read: 2, missing: 1, failed: 0, skipped: 1 });
				assert.deepEqual(
					seen,
					[
						"/api/v1/models/moonshotai/kimi-k2.6/endpoints",
						"/api/v1/models/google/gemini-2.5-flash/endpoints",
						"/api/v1/models/vendor/not-listed/endpoints",
					],
					"an alias has no listing of its own: not asked",
				);
				const kimi = first.endpoints("moonshotai/kimi-k2.6");
				assert.ok(kimi);
				assert.equal(fullPrecisionEndpoint(kimi)?.provider, "StreamLake");
				assert.equal(kimi.fetchedAt, "2026-10-01T22:00:00.000Z");

				const second = new OpenRouterEndpointsCatalog({
					snapshotPath: join(dir, "endpoints.json"),
					baseUrl,
					spacingMs: 0,
					now: () => clock,
				});
				await second.initialize();
				assert.equal(second.endpoints("moonshotai/kimi-k2.6")?.endpoints.length, kimi.endpoints.length);
				const again = await second.refresh(["moonshotai/kimi-k2.6"]);
				assert.deepEqual(
					again,
					{ read: 0, missing: 0, failed: 0, skipped: 1 },
					"a listing younger than its time to live is not read again",
				);
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reads a listing again once it is older than its time to live, and offers nothing from one older than a day", async () => {
		const dir = await mkdtemp(join(tmpdir(), "endpoints-"));
		let clock = Date.parse("2026-10-01T22:00:00.000Z");
		try {
			await withOpenRouter(async (baseUrl) => {
				const catalog = new OpenRouterEndpointsCatalog({
					snapshotPath: join(dir, "e.json"),
					baseUrl,
					spacingMs: 0,
					ttlMs: 3_600_000,
					now: () => clock,
				});
				await catalog.initialize();
				await catalog.refresh(["moonshotai/kimi-k2.6"]);
				clock += 2 * 3_600_000;
				assert.ok(catalog.endpoints("moonshotai/kimi-k2.6"), "stale for reading, still a price for a day");
				assert.deepEqual(await catalog.refresh(["moonshotai/kimi-k2.6"]), {
					read: 1,
					missing: 0,
					failed: 0,
					skipped: 0,
				});
				clock += 25 * 3_600_000;
				assert.equal(
					catalog.endpoints("moonshotai/kimi-k2.6"),
					undefined,
					"a listing older than a day is not a price",
				);
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("stops a run at the first rate-limit answer and keeps what it had", async () => {
		const dir = await mkdtemp(join(tmpdir(), "endpoints-"));
		const server = createServer((_request, response) => {
			response.writeHead(429, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "rate limited", code: 429 } }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		try {
			const catalog = new OpenRouterEndpointsCatalog({
				snapshotPath: join(dir, "e.json"),
				baseUrl: `http://127.0.0.1:${port}/api/v1`,
				spacingMs: 0,
			});
			await catalog.initialize();
			assert.deepEqual(await catalog.refresh(["a/one", "b/two", "c/three"]), {
				read: 0,
				missing: 0,
				failed: 1,
				skipped: 2,
			});
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(dir, { recursive: true, force: true });
		}
	});
});
