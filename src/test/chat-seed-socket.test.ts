import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { CHAT_SEED_MAX_BYTES, CHAT_SEED_SCHEMA } from "../chat-seed.js";
import { handleChatSeedPut } from "../chat-seed-routes.js";
import { withRuntime } from "./chat-runtime-fixture.js";

/**
 * The seed door over a real socket. The in-memory route harness cannot say whether a server that answers an
 * oversized body before reading it leaves the connection fit for the next request, or resets it under a
 * client that is still sending (which a browser reports as a network error, not as the 413 it was sent).
 */

const SMALL_SEED = Buffer.from(
	JSON.stringify({ schema: CHAT_SEED_SCHEMA, messages: [{ role: "user", text: "hello", occurredAt: null }] }),
);

interface Reply {
	readonly status: number;
	readonly body: string;
}

/** `declared: false` sends no Content-Length, so the client streams the body chunked. */
function send(agent: http.Agent, port: number, body: Buffer, declared = true): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const request = http.request(
			{
				agent,
				method: "POST",
				host: "127.0.0.1",
				port,
				path: "/api/chat-seeds",
				headers: declared ? { "content-length": String(body.length) } : {},
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () =>
					resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
				);
				response.on("error", reject);
			},
		);
		request.on("error", reject);
		request.write(body);
		request.end();
	});
}

/**
 * `connections()` is what the SERVER saw: how many TCP connections were opened to it. The client's own
 * `reusedSocket` flag is not evidence (an agent that queues the second request until the first socket frees
 * reports false for a socket it did reuse); the server's count is.
 */
async function withSeedDoor(
	run: (port: number, agent: http.Agent, connections: () => number) => Promise<void>,
): Promise<void> {
	await withRuntime(async (runtime) => {
		const server = http.createServer((request, response) => {
			handleChatSeedPut({ runtime, request, response, ownerUserId: "user-a" }).catch((error: unknown) => {
				response.statusCode = 500;
				response.end(String(error));
			});
		});
		let opened = 0;
		server.on("connection", () => {
			opened += 1;
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
		try {
			await run((server.address() as AddressInfo).port, agent, () => opened);
		} finally {
			agent.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
}

describe("the seed door over a real socket", () => {
	it("answers a body declared over the cap with 413 the client can read, and serves the next request on the same connection", async () => {
		await withSeedDoor(async (port, agent, connections) => {
			const over = Buffer.alloc(CHAT_SEED_MAX_BYTES + 400_000, 0x20);
			const refused = await send(agent, port, over);
			assert.equal(refused.status, 413);
			assert.equal(JSON.parse(refused.body).error.code, "seed_too_large");
			const next = await send(agent, port, SMALL_SEED);
			assert.equal(next.status, 201, next.body);
			assert.equal(connections(), 1, "one connection served the refusal and the request after it");
		});
	});

	it("answers a streamed body past the cap with 413 once it has drained it, and keeps the connection too", async () => {
		await withSeedDoor(async (port, agent, connections) => {
			const over = Buffer.alloc(CHAT_SEED_MAX_BYTES + 400_000, 0x20);
			const refused = await send(agent, port, over, false);
			assert.equal(refused.status, 413);
			assert.equal(JSON.parse(refused.body).error.code, "seed_too_large");
			const next = await send(agent, port, SMALL_SEED);
			assert.equal(next.status, 201, next.body);
			assert.equal(connections(), 1, "one connection served the refusal and the request after it");
		});
	});
});
