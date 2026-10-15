/**
 * The body's own pieces, checked against the host's real code where the host is the judge: the runtime state it
 * writes is validated by the host's `validatePrimeRuntimeState`, and every bridge message it sends goes through the
 * host's `parsePrimeHostBridgeMessage` (the bridge checks before writing).
 */

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PRIME_HOST_PROTOCOL_VERSION } from "../../../src/agent-runtime/host-protocol.js";
import { validatePrimeRuntimeState } from "../../../src/agent-runtime/result-validation.js";
import type { AgentSpawnRequest } from "../../../src/wire-protocol.js";
import { HostBridge } from "../src/bridge.js";
import { assistantEventFor, HOST_API, hostContextFor, streamThroughHost, wireModelFor } from "../src/host-provider.js";
import { assertRestorableState, runtimeState } from "../src/state.js";
import { refuseWhatThisBodyCannotDo, systemPromptFor } from "../src/worker.js";

const request = {
	spawn_id: "spawn-1",
	session_id: "ags_1",
	generation: 1,
	intent: "x",
	wards: { require_done_tool: true },
	mnemosyne: { mcp_url: "disabled", session_token: "disabled", graph_scope: { default_graph_id: "g" } },
	medium: "conversation",
	model: "google/gemini-2.5-flash",
	agent_id: "agent-0123456789abcdef",
	depth: 0,
	runtime_binding: {
		constraints: { allowAutonomousContinuation: false, allowPersistentKernel: false, maxTurns: 4, maxTokens: 1000 },
	},
	runtime_binding_digest: `sha256:${"a".repeat(64)}`,
	agent_ontology: {
		subject: { registeredName: "tester" },
		objects: Object.fromEntries(
			["geist", "prompt", "harness", "toolGrant"].map((key) => [
				key,
				{ ownerPrincipal: "user:o", graphId: "g", objectId: key, version: "1", digest: "sha256:d" },
			]),
		),
	},
	agent_ontology_binding_digest: `sha256:${"b".repeat(64)}`,
} as unknown as AgentSpawnRequest;

describe("the body's request handling", () => {
	it("refuses what only the hosted Prime body can do, at activation", () => {
		refuseWhatThisBodyCannotDo(request);
		assert.throws(
			() => refuseWhatThisBodyCannotDo({ ...request, initial_goal: { objective: "x" } }),
			/a goal needs the hosted Prime agent body/,
		);
		assert.throws(() => refuseWhatThisBodyCannotDo({ ...request, medium: "code" }), /"code" medium/);
		assert.throws(
			() =>
				refuseWhatThisBodyCannotDo({
					...request,
					runtime_binding: {
						...request.runtime_binding,
						constraints: { ...request.runtime_binding.constraints, allowAutonomousContinuation: true },
					},
				}),
			/autonomous continuation/,
		);
	});

	it("asks the host for the request's model and states the completion contract in the prompt", () => {
		const wire = wireModelFor({ ...request, provider: "openrouter" });
		assert.equal(wire.id, "google/gemini-2.5-flash");
		assert.equal(wire.provider, "openrouter");
		assert.equal(wire.api, "openai-completions");
		assert.notEqual(wire.api, HOST_API);
		const prompt = systemPromptFor(request);
		assert.match(prompt, /You are tester/);
		assert.match(prompt, /call the `done` tool exactly once/);
		assert.match(prompt, new RegExp(`Agent Ontology binding: sha256:${"b".repeat(64)}`));
	});
});

describe("the model, through the host", () => {
	it("hands the host a pi transcript's prompt and tools as a plain request", () => {
		const transcript = normalizeContext({
			systemPrompt: "Be brief.",
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools: [
				{
					name: "search_documents",
					description: "Search",
					parameters: { type: "object", properties: { query: { type: "string" } } } as never,
				},
			],
		});
		const host = hostContextFor(transcript);
		assert.equal(host.systemPrompt, "Be brief.");
		assert.deepEqual(
			host.messages.map((message) => (message as { role: string }).role),
			["user"],
		);
		assert.equal((host.tools?.[0] as { name: string }).name, "search_documents");
		assert.deepEqual(JSON.parse(JSON.stringify(host)), host);
	});

	it("rebuilds the host's streamed tool call as pi's assistant message", () => {
		const partial = {
			role: "assistant" as const,
			content: [],
			api: "openai-completions",
			provider: "openrouter",
			model: "m",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 1,
		};
		assistantEventFor({ type: "start" }, partial);
		assistantEventFor({ type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "done" }, partial);
		assistantEventFor({ type: "toolcall_delta", contentIndex: 0, delta: '{"summary":' }, partial);
		assistantEventFor({ type: "toolcall_delta", contentIndex: 0, delta: '"ok"}' }, partial);
		const end = assistantEventFor({ type: "toolcall_end", contentIndex: 0 }, partial);
		assert.equal(end?.type, "toolcall_end");
		const usage = {
			input: 3,
			output: 4,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 7,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
		};
		const done = assistantEventFor({ type: "done", reason: "toolUse", usage }, partial);
		assert.equal(done?.type, "done");
		assert.deepEqual(partial.content, [{ type: "toolCall", id: "c1", name: "done", arguments: { summary: "ok" } }]);
		assert.equal(partial.usage.totalTokens, 7);
	});

	it("sends the call over the bridge in the host's grammar and ends the stream on the host's answer", async () => {
		const toBody = new PassThrough();
		const fromBody = new PassThrough();
		const lines: Record<string, unknown>[] = [];
		fromBody.on("data", (chunk: Buffer) => {
			for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) lines.push(JSON.parse(line));
		});
		const bridge = new HostBridge(toBody, fromBody, () => {});
		const activated = bridge.readActivation();
		const context = { sessionId: "ags_1", sandboxId: "spawn-1", generation: 1 };
		toBody.write(
			`${JSON.stringify({
				protocol: PRIME_HOST_PROTOCOL_VERSION,
				messageId: "runtime.initialize:spawn-1:1",
				...context,
				correlationId: "materialization:spawn-1:1",
				direction: "host_to_worker",
				kind: "command",
				name: "runtime.initialize",
				payload: { request: { ...request, spawn_id: "spawn-1" }, sessionRevision: 0 },
			})}\n`,
		);
		await activated;
		const stream = streamThroughHost(
			bridge,
			wireModelFor(request),
			normalizeContext({ systemPrompt: "p", messages: [{ role: "user", content: "hi", timestamp: 1 }] }),
		);
		await new Promise((done) => setImmediate(done));
		const sent = lines.find((line) => line.name === "inference.request") as {
			payload: { requestId: string; model: { id: string }; context: { systemPrompt: string } };
		};
		assert.equal(sent.payload.model.id, "google/gemini-2.5-flash");
		assert.equal(sent.payload.context.systemPrompt, "p");
		const reply = (event: unknown) =>
			toBody.write(
				`${JSON.stringify({
					protocol: PRIME_HOST_PROTOCOL_VERSION,
					messageId: `host.response:${Math.random()}`,
					...context,
					correlationId: sent.payload.requestId,
					direction: "host_to_worker",
					kind: "response",
					requestId: sent.payload.requestId,
					ok: true,
					result: { kind: "inference.chunk", event },
				})}\n`,
			);
		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		reply({ type: "start" });
		reply({ type: "text_start", contentIndex: 0 });
		reply({ type: "text_delta", contentIndex: 0, delta: "hello" });
		reply({ type: "text_end", contentIndex: 0 });
		reply({ type: "done", reason: "stop", usage });
		const message = await stream.result();
		assert.equal(message.stopReason, "stop");
		assert.deepEqual(message.content, [{ type: "text", text: "hello" }]);
		assert.equal(message.provider, "openrouter");
		bridge.close();
	});
});

describe("the runtime state", () => {
	it("is a checkpoint the host accepts, and one the body accepts back", () => {
		const session = SessionManager.inMemory("/tmp/w");
		session.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		const state = runtimeState(request, session, 7, new Date(0));
		validatePrimeRuntimeState(state, request);
		assert.equal(state.entries.length, 1);
		const next = { ...request, generation: 2 };
		assertRestorableState(state, next, 7);
		assert.throws(() => assertRestorableState(state, request, 7), /earlier generation/);
		assert.throws(() => assertRestorableState({ ...state, entries: [] }, next, 7), /digest/);
		const restored = SessionManager.inMemory("/tmp/w", undefined, [
			state.sessionHeader as never,
			...(state.entries as never[]),
		]);
		assert.equal(restored.getEntries().length, 1);
		assert.equal(restored.getHeader()?.id, (state.sessionHeader as { id: string }).id);
	});
});
