import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AgentSessionHeartbeatHostRequestFault,
	type AgentSessionHeartbeatPort,
	AgentSessionHeartbeatService,
	normalizeRlmHeartbeatSchedule,
} from "../agent-runtime/agent-session-heartbeat-service.js";
import { AGENT_SESSION_SCHEDULE_CONTROL_SCHEMA } from "../agent-runtime/agent-session-schedule-control.js";

describe("AgentSessionHeartbeatService", () => {
	it("dispatches all four operations with derived authority and exact request/client testimony", async () => {
		const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
		const port = fakePort(calls);
		const service = new AgentSessionHeartbeatService({ port });
		const parent = {
			sessionId: "session-1",
			generation: 3,
			activationId: "activation-1",
			ownerUserId: "ada",
			graphOwnerPrincipal: "user:ada",
			graphId: "graph-1",
			agentId: "agent-1",
		};

		await service.handle({
			requestId: "req-list",
			payload: { type: "rlm_heartbeat.list", include_inactive: true },
			parent,
			now: 100,
		});
		await service.handle({
			requestId: "req-create",
			payload: {
				type: "rlm_heartbeat.create",
				instruction: "Check",
				interval: "30s",
				label: "  ",
				delivery_mode: "follow_up",
			},
			parent,
			now: 100,
		});
		await service.handle({
			requestId: "req-update",
			payload: { type: "rlm_heartbeat.update", id: "hb-1", status: "pause" },
			parent,
			now: 100,
		});
		await service.handle({
			requestId: "req-delete",
			payload: { type: "rlm_heartbeat.delete", id: "hb-1" },
			parent,
			now: 100,
		});

		assert.deepEqual(
			calls.map(({ name }) => name),
			["list", "create", "control", "cancel"],
		);
		for (const [index, call] of calls.entries()) {
			assert.equal(call.input.sessionId, "session-1");
			assert.equal(call.input.generation, 3);
			assert.equal(call.input.activationId, "activation-1");
			assert.equal(call.input.ownerUserId, "ada");
			assert.equal(call.input.graphOwnerPrincipal, "user:ada");
			assert.equal(call.input.graphId, "graph-1");
			assert.equal(call.input.agentId, "agent-1");
			assert.equal(call.input.requestId, ["req-list", "req-create", "req-update", "req-delete"][index]);
			assert.equal(call.input.clientId, "rlm_heartbeat:agent-1:activation-1");
		}
		assert.deepEqual(calls[1].input.options, {
			source: "rlm_heartbeat",
			label: null,
			deliveryMode: "follow_up",
			grantSnapshotDigest: null,
		});
		assert.deepEqual(calls[2].input.control, {
			schema: AGENT_SESSION_SCHEDULE_CONTROL_SCHEMA,
			requestId: "req-update",
			scheduleId: "hb-1",
			action: { kind: "pause" },
		});
	});

	it("normalizes Prime recurring examples, defaults to five minutes, floors at ten seconds, and rejects one-shot forms", () => {
		assert.deepEqual(normalizeRlmHeartbeatSchedule(undefined), {
			kind: "interval",
			expression: "every 5m",
			timeZone: "UTC",
			intervalMs: 300_000,
		});
		assert.equal(normalizeRlmHeartbeatSchedule("each 2h").intervalMs, 7_200_000);
		assert.equal(normalizeRlmHeartbeatSchedule("30s").intervalMs, 30_000);
		assert.deepEqual(normalizeRlmHeartbeatSchedule("*/15 * * * *"), {
			kind: "cron",
			expression: "*/15 * * * *",
			timeZone: "UTC",
		});
		for (const interval of ["1s", "once 2026-01-01", "in 5m", "at 10:00"]) {
			assert.throws(() => normalizeRlmHeartbeatSchedule(interval), AgentSessionHeartbeatHostRequestFault);
		}
	});

	it("preserves exact update semantics, including label clearing and delivery default", async () => {
		let captured: Record<string, unknown> | undefined;
		const service = new AgentSessionHeartbeatService({
			port: {
				list: async () => ({ heartbeats: [] }),
				create: async (input) => {
					captured = input as unknown as Record<string, unknown>;
					return { heartbeat: validRecord() };
				},
				control: async (input) => {
					captured = input as unknown as Record<string, unknown>;
					return { heartbeat: null };
				},
				cancel: async () => ({ heartbeat: null }),
			},
		});
		const parent = validParent();
		await service.handle({
			requestId: "create",
			payload: { type: "rlm_heartbeat.create", instruction: "x" },
			parent,
			now: 1,
		});
		assert.deepEqual(captured?.options, {
			source: "rlm_heartbeat",
			deliveryMode: "steer",
			grantSnapshotDigest: null,
		});
		await service.handle({
			requestId: "update",
			payload: { type: "rlm_heartbeat.update", id: "hb-1", label: "", interval: "10s" },
			parent,
			now: 1,
		});
		assert.deepEqual(captured?.control, {
			schema: AGENT_SESSION_SCHEDULE_CONTROL_SCHEMA,
			requestId: "update",
			scheduleId: "hb-1",
			action: {
				kind: "update",
				label: null,
				schedule: { kind: "interval", expression: "every 10s", timeZone: "UTC", intervalMs: 10_000 },
			},
		});
	});

	it("fails closed for malformed fields, arbitrary authority, and mixed pause mutations", async () => {
		let invoked = false;
		const service = new AgentSessionHeartbeatService({
			port: {
				list: async () => {
					invoked = true;
					return { heartbeats: [] };
				},
				create: async () => ({ heartbeat: validRecord() }),
				control: async () => ({ heartbeat: null }),
				cancel: async () => ({ heartbeat: null }),
			},
		});
		const parent = validParent();
		await assert.rejects(
			service.handle({
				requestId: "bad",
				payload: { type: "rlm_heartbeat.list", include_inactive: false, sessionId: "evil" },
				parent,
				now: 1,
			}),
			(error: unknown) =>
				error instanceof AgentSessionHeartbeatHostRequestFault && error.structured.class === "invalid",
		);
		await assert.rejects(
			service.handle({
				requestId: "bad",
				payload: { type: "rlm_heartbeat.update", id: "hb-1", status: "pause", label: "x" },
				parent,
				now: 1,
			}),
			(error: unknown) =>
				error instanceof AgentSessionHeartbeatHostRequestFault && error.structured.class === "invalid",
		);
		assert.equal(invoked, false);
	});

	it("poisons malformed port results and passes replay results through the contract parser", async () => {
		const record = validRecord();
		let calls = 0;
		const service = new AgentSessionHeartbeatService({
			port: {
				list: async () => {
					calls += 1;
					return calls === 1 ? { heartbeats: [record] } : { poison: true };
				},
				create: async () => ({ heartbeat: null }),
				control: async () => ({ heartbeat: null }),
				cancel: async () => ({ heartbeat: null }),
			},
		});
		const parent = validParent();
		assert.deepEqual(
			await service.handle({
				requestId: "same",
				payload: { type: "rlm_heartbeat.list", include_inactive: false },
				parent,
				now: 1,
			}),
			{ heartbeats: [record] },
		);
		await assert.rejects(
			service.handle({
				requestId: "same",
				payload: { type: "rlm_heartbeat.list", include_inactive: false },
				parent,
				now: 1,
			}),
			(error: unknown) =>
				error instanceof AgentSessionHeartbeatHostRequestFault && error.structured.class === "internal",
		);
	});
});

function fakePort(calls: Array<{ name: string; input: Record<string, unknown> }>): AgentSessionHeartbeatPort {
	const record = validRecord();
	return {
		list: async (input) => {
			calls.push({ name: "list", input: input as unknown as Record<string, unknown> });
			return { heartbeats: [record] };
		},
		create: async (input) => {
			calls.push({ name: "create", input: input as unknown as Record<string, unknown> });
			return { heartbeat: record };
		},
		control: async (input) => {
			calls.push({ name: "control", input: input as unknown as Record<string, unknown> });
			return { heartbeat: record };
		},
		cancel: async (input) => {
			calls.push({ name: "cancel", input: input as unknown as Record<string, unknown> });
			return { heartbeat: null };
		},
	};
}

function validParent() {
	return {
		sessionId: "session-1",
		generation: 0,
		activationId: "activation-1",
		ownerUserId: "ada",
		graphOwnerPrincipal: "user:ada",
		graphId: "graph-1",
		agentId: "agent-1",
	};
}

function validRecord() {
	return {
		id: "hb-1",
		revision: 0,
		status: "active" as const,
		label: null,
		delivery_mode: "steer" as const,
		instruction: "Check",
		schedule: "every 5m",
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		next_run_at: "2026-01-01T00:05:00.000Z",
		last_run_at: null,
		last_error: null,
		run_count: 0,
	};
}
