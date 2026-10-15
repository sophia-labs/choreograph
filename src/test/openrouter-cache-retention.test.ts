import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { proxyLlmRequest } from "../openrouter.js";

/**
 * A Session priced from the catalogue is billed cache writes at the listed (five-minute) write price, because that is
 * the only kind of cache write the host ever asks for. Pi (the provider library the host calls) asks for a ONE-HOUR
 * write, which OpenRouter's Anthropic models charge more for, when `PI_CACHE_RETENTION=long` is in the host's
 * environment. The ledger has no one-hour count, so that setting would quietly bill every write too low. The host
 * therefore names the retention itself and is not at the mercy of its environment.
 *
 * Real Pi, real HTTP: a local server stands in for OpenRouter and keeps the request body Pi sent.
 */

async function requestBodyFor(model: Record<string, unknown>, env: Record<string, string>): Promise<string> {
	const received: string[] = [];
	const server = createServer((request: IncomingMessage, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			received.push(Buffer.concat(chunks).toString("utf8"));
			response.writeHead(400, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "a test server that only listens", code: 400 } }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	const saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
	Object.assign(process.env, env);
	try {
		const events: unknown[] = [];
		for await (const event of proxyLlmRequest(
			{ ...model, baseUrl: `http://127.0.0.1:${port}/api/v1` },
			{ systemPrompt: "You are a test.", messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
			{ apiKey: "test-key" },
		)) {
			events.push(event);
		}
		assert.ok(events.length > 0, "Pi answered (with the error the server gave)");
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	assert.equal(received.length >= 1, true, "a request reached the provider");
	return received[0];
}

const SONNET = {
	id: "anthropic/claude-sonnet-4.5",
	name: "Anthropic: Claude Sonnet 4.5",
	api: "openai-completions",
	provider: "openrouter",
	reasoning: false,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 4_096,
};

describe("the provider call asks for the five-minute cache, whatever the host's environment says", () => {
	it("marks the cache without a time to live when Pi is left to itself", async () => {
		const body = await requestBodyFor(SONNET, { PI_CACHE_RETENTION: "short" });
		const marks = body.match(/"cache_control":\{[^}]*\}/g) ?? [];
		assert.ok(marks.length > 0, "an Anthropic model on OpenRouter is asked to cache");
		assert.ok(
			marks.every((mark) => !mark.includes("ttl")),
			marks.join(" "),
		);
	});

	it("still asks for no time to live when the environment says PI_CACHE_RETENTION=long", async () => {
		const body = await requestBodyFor(SONNET, { PI_CACHE_RETENTION: "long" });
		const marks = body.match(/"cache_control":\{[^}]*\}/g) ?? [];
		assert.ok(marks.length > 0);
		assert.ok(
			marks.every((mark) => !mark.includes("ttl") && !mark.includes("1h")),
			`a one-hour write would be billed at the five-minute price: ${marks.join(" ")}`,
		);
	});
});
