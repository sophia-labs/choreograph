import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { proxyLlmRequest } from "../openrouter.js";
import type { ProxyAssistantMessageEvent } from "../wire-protocol.js";

/**
 * The host can audit what a call really cost only if it keeps the provider's own name for the call. OpenRouter answers
 * every completion with a generation id (`gen-…`, the `id` of each streamed chunk); its generation record
 * (`GET /api/v1/generation?id=…`) then says which upstream provider served the call and what it charged. Pi keeps that
 * id on its final message (`responseId`); the host's proxy event dropped it, so on 2026-10-01 no call of the voices
 * release could be audited (price-gap/FINDINGS.md). The `usage.cost` Pi reports is Pi's own arithmetic over a static
 * price table, never the provider's charge, and is not what OpenRouter billed.
 *
 * Real Pi, real HTTP: a local server stands in for OpenRouter and streams a completion with a generation id.
 */

const GEN_ID = "gen-1790893024-TZYksidy0cQRoBKpJHBH";

async function eventsFor(
	model: Record<string, unknown>,
): Promise<{ events: ProxyAssistantMessageEvent[]; body: string }> {
	let body = "";
	const server = createServer((request: IncomingMessage, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			body = Buffer.concat(chunks).toString("utf8");
			response.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (value: Record<string, unknown>) => response.write(`data: ${JSON.stringify(value)}\n\n`);
			chunk({
				id: GEN_ID,
				provider: "Baidu",
				model: "moonshotai/kimi-k2.6",
				object: "chat.completion.chunk",
				created: 1,
				choices: [{ index: 0, delta: { role: "assistant", content: "OK" } }],
			});
			chunk({
				id: GEN_ID,
				provider: "Baidu",
				model: "moonshotai/kimi-k2.6",
				object: "chat.completion.chunk",
				created: 1,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 1,
					total_tokens: 11,
					cost: 0.0000062,
					prompt_tokens_details: { cached_tokens: 0 },
				},
			});
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	try {
		const events: ProxyAssistantMessageEvent[] = [];
		for await (const event of proxyLlmRequest(
			{ ...model, baseUrl: `http://127.0.0.1:${port}/api/v1` },
			{ systemPrompt: "You are a test.", messages: [{ role: "user", content: "Say OK.", timestamp: Date.now() }] },
			{ apiKey: "test-key" },
		)) {
			events.push(event);
		}
		return { events, body };
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

const KIMI = {
	id: "moonshotai/kimi-k2.6",
	name: "MoonshotAI: Kimi K2.6",
	api: "openai-completions",
	provider: "openrouter",
	reasoning: true,
	input: ["text"],
	cost: { input: 0.68, output: 3.41, cacheRead: 0.34, cacheWrite: 0 },
	contextWindow: 262_144,
	maxTokens: 4_096,
};

describe("the provider's generation id reaches the host", () => {
	it("is carried on the terminal event, so the call can be looked up in the provider's own record", async () => {
		const { events } = await eventsFor(KIMI);
		const done = events.find((event) => event.type === "done");
		assert.ok(done, `a terminal event: ${JSON.stringify(events.map((event) => event.type))}`);
		assert.equal((done as { responseId?: string }).responseId, GEN_ID);
	});
});
