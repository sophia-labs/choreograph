import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	PRIME_HOST_PROTOCOL_VERSION,
	PrimeHostProtocolFault,
	parsePrimeHostBridgeMessage,
	primeHostDedupeKey,
} from "../agent-runtime/host-protocol.js";

function context() {
	return {
		protocol: PRIME_HOST_PROTOCOL_VERSION,
		messageId: "msg-1",
		sessionId: "ags-1",
		sandboxId: "sbx-1",
		generation: 2,
		correlationId: "corr-1",
	};
}

describe("Prime host bridge v1", () => {
	it("accepts a typed prompt command", () => {
		const parsed = parsePrimeHostBridgeMessage({
			...context(),
			direction: "host_to_worker",
			kind: "command",
			name: "input.prompt",
			payload: { text: "hello" },
			commandId: "cmd-1",
		});
		assert.equal(parsed.kind, "command");
		assert.equal(parsed.name, "input.prompt");
	});

	it("accepts the bridge initialize and terminal-result handshake", () => {
		const request = {
			spawn_id: "sbx-1",
			session_id: "ags-1",
			generation: 2,
			intent: "hello",
		};
		const initialize = parsePrimeHostBridgeMessage({
			...context(),
			direction: "host_to_worker",
			kind: "command",
			name: "runtime.initialize",
			payload: { request, sessionRevision: 0 },
		});
		assert.equal(initialize.kind, "command");
		assert.equal(initialize.name, "runtime.initialize");

		const result = parsePrimeHostBridgeMessage({
			...context(),
			messageId: "msg-result-1",
			causationId: "msg-1",
			direction: "worker_to_host",
			kind: "result",
			workerSequence: 0,
			name: "runtime.result",
			payload: { result: { spawn_id: "sbx-1", status: "terminated", output: "done", turns: 1 } },
		});
		assert.equal(result.kind, "result");
		assert.equal(result.name, "runtime.result");
		assert.equal(primeHostDedupeKey(result), "ags-1:2:0");
	});

	it("accepts only a strict resident-command opt-in on initialize and restore", () => {
		const request = {
			spawn_id: "sbx-1",
			session_id: "ags-1",
			generation: 2,
			intent: "the durable prompt will arrive separately",
			await_initial_command: true,
		};
		for (const [name, extra] of [
			["runtime.initialize", {}],
			["runtime.restore", { state: {} }],
		] as const) {
			const parsed = parsePrimeHostBridgeMessage({
				...context(),
				direction: "host_to_worker",
				kind: "command",
				name,
				payload: { request, sessionRevision: 1, ...extra },
			});
			assert.equal(parsed.kind, "command");
			assert.equal(parsed.name, name);
		}

		for (const invalid of [false, "true", null]) {
			assert.throws(
				() =>
					parsePrimeHostBridgeMessage({
						...context(),
						direction: "host_to_worker",
						kind: "command",
						name: "runtime.initialize",
						payload: { request: { ...request, await_initial_command: invalid }, sessionRevision: 1 },
					}),
				PrimeHostProtocolFault,
			);
		}
	});

	it("rejects the retired schedule delivery command in favor of durable input.prompt", () => {
		assert.throws(
			() =>
				parsePrimeHostBridgeMessage({
					...context(),
					direction: "host_to_worker",
					kind: "command",
					name: "schedule.deliver",
					payload: { scheduleId: "sch-1", deliveryId: "fire-1", firedAt: 0 },
				}),
			PrimeHostProtocolFault,
		);
	});

	it("accepts a worker capability request and derives its generation fence key", () => {
		const parsed = parsePrimeHostBridgeMessage({
			...context(),
			direction: "worker_to_host",
			kind: "request",
			workerSequence: 7,
			name: "capability.request",
			payload: {
				requestId: "req-1",
				capability: "mnemosyne",
				tool: "search_documents",
				args: { query: "Prime" },
			},
		});
		assert.equal(parsed.kind, "request");
		assert.equal(primeHostDedupeKey(parsed), "ags-1:2:7");
	});

	it("accepts only typed leased-kernel operations", () => {
		const parsed = parsePrimeHostBridgeMessage({
			...context(),
			correlationId: "prime-kernel-1",
			direction: "worker_to_host",
			kind: "request",
			workerSequence: 8,
			name: "kernel.request",
			payload: { requestId: "prime-kernel-1", operation: "execute", leaseId: "kls-1", code: "1 + 1" },
		});
		assert.equal(parsed.kind, "request");
		assert.equal(parsed.name, "kernel.request");
		assert.throws(
			() =>
				parsePrimeHostBridgeMessage({
					...context(),
					direction: "worker_to_host",
					kind: "request",
					workerSequence: 8,
					name: "kernel.request",
					payload: { requestId: "prime-kernel-2", operation: "shell", code: "rm -rf /" },
				}),
			PrimeHostProtocolFault,
		);
	});

	it("accepts a correlated cancellation request", () => {
		const parsed = parsePrimeHostBridgeMessage({
			...context(),
			messageId: "msg-cancel-1",
			correlationId: "prime-cancel-1",
			direction: "worker_to_host",
			kind: "request",
			workerSequence: 8,
			name: "request.cancel",
			payload: {
				requestId: "prime-cancel-1",
				targetRequestId: "prime-gate-0",
				reason: "caller aborted",
			},
		});
		assert.equal(parsed.kind, "request");
		assert.equal(parsed.name, "request.cancel");
		assert.equal(parsed.payload.targetRequestId, "prime-gate-0");
	});

	it("accepts a correlated inference request carrying the exact asserted wire model", () => {
		const parsed = parsePrimeHostBridgeMessage({
			...context(),
			messageId: "msg-inference-1",
			correlationId: "prime-llm-0",
			direction: "worker_to_host",
			kind: "request",
			workerSequence: 8,
			name: "inference.request",
			payload: {
				requestId: "prime-llm-0",
				model: { id: "mock:done", provider: "openrouter", api: "openai-completions" },
				context: { messages: [] },
			},
		});
		assert.equal(parsed.kind, "request");
		assert.equal(parsed.name, "inference.request");
		assert.equal(parsed.correlationId, "prime-llm-0");
		assert.equal(primeHostDedupeKey(parsed), "ags-1:2:8");
	});

	it("accepts only ratified worker-originated semantic events", () => {
		const parsed = parsePrimeHostBridgeMessage({
			...context(),
			messageId: "msg-event-1",
			direction: "worker_to_host",
			kind: "event",
			workerSequence: 9,
			name: "turn.started",
			payload: { turn: 1 },
		});
		assert.equal(parsed.kind, "event");
		assert.equal(parsed.name, "turn.started");
		assert.throws(
			() =>
				parsePrimeHostBridgeMessage({
					...context(),
					messageId: "msg-event-draft",
					direction: "worker_to_host",
					kind: "event",
					workerSequence: 10,
					name: "runtime.ready",
					payload: {},
				}),
			PrimeHostProtocolFault,
		);
		assert.throws(
			() =>
				parsePrimeHostBridgeMessage({
					...context(),
					messageId: "msg-event-local-child-update",
					direction: "worker_to_host",
					kind: "event",
					workerSequence: 11,
					name: "child.message",
					payload: { childId: "local-rlm-child", status: "complete" },
				}),
			PrimeHostProtocolFault,
		);
		assert.throws(
			() =>
				parsePrimeHostBridgeMessage({
					...context(),
					messageId: "msg-host-child-message",
					direction: "host_to_worker",
					kind: "command",
					name: "child.message",
					payload: { childSessionId: "ags-child", deliveryId: "delivery-1", message: "hello" },
				}),
			PrimeHostProtocolFault,
		);
	});

	it("rejects unknown versions, names, generations, and malformed payloads", () => {
		const base = {
			...context(),
			direction: "host_to_worker",
			kind: "command",
			name: "input.prompt",
			payload: { text: "hello" },
		};
		assert.throws(() => parsePrimeHostBridgeMessage({ ...base, protocol: "v0" }), PrimeHostProtocolFault);
		assert.throws(() => parsePrimeHostBridgeMessage({ ...base, name: "host.shell" }), PrimeHostProtocolFault);
		assert.throws(() => parsePrimeHostBridgeMessage({ ...base, generation: -1 }), PrimeHostProtocolFault);
		assert.throws(() => parsePrimeHostBridgeMessage({ ...base, payload: { text: "" } }), PrimeHostProtocolFault);
	});

	it("requires structured errors on failed responses", () => {
		assert.throws(
			() =>
				parsePrimeHostBridgeMessage({
					...context(),
					direction: "host_to_worker",
					kind: "response",
					requestId: "req-1",
					ok: false,
					error: "denied",
				}),
			PrimeHostProtocolFault,
		);
		const parsed = parsePrimeHostBridgeMessage({
			...context(),
			direction: "host_to_worker",
			kind: "response",
			requestId: "req-1",
			ok: false,
			error: {
				code: "capability_denied",
				class: "denied",
				message: "not granted",
				retryable: false,
			},
		});
		assert.equal(parsed.kind, "response");
		assert.equal(parsed.ok, false);
	});

	it("accepts strict goal commands and goal command results", () => {
		for (const [name, payload] of [
			["goal.get", {}],
			["goal.create", { objective: "ship H1", tokenBudget: 100 }],
			["goal.complete", {}],
		] as const) {
			const parsed = parsePrimeHostBridgeMessage({
				...context(),
				direction: "host_to_worker",
				kind: "command",
				name,
				commandId: `cmd-${name}`,
				payload,
			});
			assert.equal(parsed.name, name);
		}
		const result = parsePrimeHostBridgeMessage({
			...context(),
			direction: "worker_to_host",
			kind: "result",
			workerSequence: 12,
			name: "command.result",
			commandId: "cmd-goal.get",
			payload: {
				commandId: "cmd-goal.get",
				commandName: "goal.get",
				status: "completed",
				result: {
					goal: {
						goal_id: "g-1",
						objective: "ship H1",
						status: "active",
						token_budget: 100,
						tokens_used: 25,
						time_used_seconds: 3,
						created_at: 10,
						updated_at: 20,
					},
					remaining_tokens: 75,
					completion_budget_report: null,
				},
			},
		});
		assert.equal(result.kind, "result");
	});

	it("rejects goal wire adversaries and invalid command result shapes", () => {
		const command = (name: string, payload: unknown, commandId = "cmd") => ({
			...context(),
			direction: "host_to_worker",
			kind: "command",
			name,
			commandId,
			payload,
		});
		for (const invalid of [
			command("goal.get", { extra: true }),
			command("goal.create", { objective: "x", tokenBudget: 0 }),
			command("goal.create", { objective: "x\0y" }),
			command("goal.create", { objective: "x".repeat(4_001) }),
			(() => {
				const missing = command("goal.complete", {});
				delete (missing as Record<string, unknown>).commandId;
				return missing;
			})(),
		])
			assert.throws(() => parsePrimeHostBridgeMessage(invalid), PrimeHostProtocolFault);

		const base = {
			...context(),
			direction: "worker_to_host",
			kind: "result",
			workerSequence: 13,
			name: "command.result",
			commandId: "cmd",
			payload: { commandId: "cmd", commandName: "goal.get", status: "completed" },
		};
		const goal = {
			goal_id: "g-1",
			objective: "ship H1",
			status: "active",
			token_budget: 100,
			tokens_used: 25,
			time_used_seconds: 3,
			created_at: 10,
			updated_at: 20,
		};
		const goalResponse = { goal, remaining_tokens: 75, completion_budget_report: null };
		for (const payload of [
			{ ...base.payload, result: undefined },
			{ ...base.payload, result: { goal: null, remaining_tokens: 0, completion_budget_report: null } },
			{
				...base.payload,
				result: {
					goal: { objective: "x", status: "active", tokens_used: 2, time_used_seconds: 0, token_budget: 1 },
					remaining_tokens: 1,
					completion_budget_report: null,
				},
			},
			{
				...base.payload,
				status: "failed",
				result: { goal: null, remaining_tokens: null, completion_budget_report: null },
				error: "nope",
			},
			{
				...base.payload,
				commandName: "input.prompt",
				result: { goal: null, remaining_tokens: null, completion_budget_report: null },
			},
			{
				...base.payload,
				result: {
					goal: { objective: "x", status: "active", tokens_used: 0, time_used_seconds: 0, extra: 1 },
					remaining_tokens: null,
					completion_budget_report: null,
				},
			},
			{ ...base.payload, result: { ...goalResponse, goal: { ...goal, status: "idle" } } },
			{ ...base.payload, result: { ...goalResponse, goal: { ...goal, token_budget: 0 } } },
			{ ...base.payload, result: { ...goalResponse, goal: { ...goal, created_at: -1 } } },
			{ ...base.payload, result: { ...goalResponse, goal: { ...goal, updated_at: Number.MAX_SAFE_INTEGER + 1 } } },
			{ ...base.payload, result: { ...goalResponse, goal: { ...goal, objective: "bad\0goal" } } },
			{ ...base.payload, result: { ...goalResponse, goal: { ...goal, goal_id: "x".repeat(513) } } },
			{ ...base.payload, result: { ...goalResponse, completion_budget_report: "x".repeat(4_001) } },
			{ ...base.payload, result: goalResponse, error: "completed commands cannot carry errors" },
			{ ...base.payload, result: goalResponse, unexpected: true },
		])
			assert.throws(() => parsePrimeHostBridgeMessage({ ...base, payload }), PrimeHostProtocolFault);
	});
});
