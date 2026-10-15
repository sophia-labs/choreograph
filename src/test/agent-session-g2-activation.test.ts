import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSessionHeartbeatService } from "../agent-runtime/agent-session-heartbeat-service.js";
import { SandboxSpawner } from "../spawner.js";
import { grantDigest } from "../workflow/agent-tool-grant.js";

const parent = {
	sessionId: "session-1",
	generation: 3,
	activationId: "activation-1",
	ownerUserId: "owner-1",
	graphOwnerPrincipal: "owner-1",
	graphId: "graph-1",
	agentId: "agent-1",
};

const heartbeat = {
	id: "schedule-1",
	revision: 0,
	status: "active",
	label: null,
	delivery_mode: "steer",
	instruction: "check in",
	schedule: "every 5m",
	created_at: "2026-08-08T00:00:00.000Z",
	updated_at: "2026-08-08T00:00:00.000Z",
	next_run_at: "2026-08-08T00:05:00.000Z",
	last_run_at: null,
	last_error: null,
	run_count: 0,
};

function service(calls: string[]) {
	return new AgentSessionHeartbeatService({
		port: {
			list: async () => {
				calls.push("list");
				return { heartbeats: [heartbeat] };
			},
			create: async () => {
				calls.push("create");
				return { heartbeat };
			},
			control: async () => {
				calls.push("update");
				return { heartbeat };
			},
			cancel: async () => {
				calls.push("delete");
				return { heartbeat: { ...heartbeat, status: "cancelled", next_run_at: null } };
			},
		},
	});
}

test("heartbeat dispatch derives parent coordinates and rejects forged payload coordinates", async () => {
	const calls: string[] = [];
	const host = service(calls);
	await assert.rejects(
		host.handle({
			requestId: "request-1",
			payload: { type: "rlm_heartbeat.list", include_inactive: false, session_id: "forged" },
			parent,
			now: Date.now(),
		}),
	);
	assert.deepEqual(calls, []);
	const result = await host.handle({
		requestId: "request-2",
		payload: { type: "rlm_heartbeat.list", include_inactive: false },
		parent,
		now: Date.now(),
	});
	assert.deepEqual(calls, ["list"]);
	assert.equal(result.heartbeats[0]?.id, "schedule-1");
});

test("heartbeat list/create/update/delete dispatches exactly once", async () => {
	const calls: string[] = [];
	const host = service(calls);
	await host.handle({
		requestId: "list",
		payload: { type: "rlm_heartbeat.list", include_inactive: true },
		parent,
		now: Date.now(),
	});
	await host.handle({
		requestId: "create",
		payload: { type: "rlm_heartbeat.create", instruction: "check in" },
		parent,
		now: Date.now(),
	});
	await host.handle({
		requestId: "update",
		payload: { type: "rlm_heartbeat.update", id: "schedule-1", instruction: "updated" },
		parent,
		now: Date.now(),
	});
	await host.handle({
		requestId: "delete",
		payload: { type: "rlm_heartbeat.delete", id: "schedule-1" },
		parent,
		now: Date.now(),
	});
	assert.deepEqual(calls, ["list", "create", "update", "delete"]);
});

test("missing durable grant remains zero-spawn and is represented by a structured host fault", async () => {
	const host = new AgentSessionHeartbeatService({
		port: {
			list: async () => ({ heartbeats: [] }),
			create: async () => {
				throw new Error("grant binding unavailable");
			},
			control: async () => ({ heartbeat: null }),
			cancel: async () => ({ heartbeat: null }),
		},
	});
	await assert.rejects(
		host.handle({
			requestId: "create",
			payload: { type: "rlm_heartbeat.create", instruction: "x" },
			parent,
			now: Date.now(),
		}),
	);
});

test("heartbeat normalization preserves ten-second intervals and default first-fire timing", async () => {
	let captured: { intervalMs: number; expression: string } | undefined;
	const now = Date.parse("2026-08-08T00:00:00.000Z");
	const host = new AgentSessionHeartbeatService({
		port: {
			list: async () => ({ heartbeats: [] }),
			create: async (input) => {
				captured = input.schedule;
				return { heartbeat };
			},
			control: async () => ({ heartbeat }),
			cancel: async () => ({ heartbeat: null }),
		},
	});
	await host.handle({
		requestId: "ten-seconds",
		payload: { type: "rlm_heartbeat.create", instruction: "check", interval: "10s" },
		parent,
		now,
	});
	assert.deepEqual(captured, { kind: "interval", expression: "every 10s", timeZone: "UTC", intervalMs: 10_000 });
	await host.handle({
		requestId: "default",
		payload: { type: "rlm_heartbeat.create", instruction: "check" },
		parent,
		now,
	});
	assert.equal(captured?.expression, "every 5m");
});

test("SandboxSpawner heartbeat dispatch bounds a durable-read failure to one response", async () => {
	const responses: unknown[] = [];
	let reads = 0;
	const spawner = Object.create(SandboxSpawner.prototype) as SandboxSpawner;
	const host = spawner as any;
	const request = {
		session_id: "session-1",
		generation: 3,
		mnemosyne: { graph_scope: { default_graph_owner: "owner-1", default_graph_id: "graph-1" } },
	};
	const agentActive = {
		isAgentRun: true,
		hostWorkAdmissionClosed: false,
		agentRequest: request,
		record: { sandbox_id: "agent-1" },
		process: {},
	};
	host.shuttingDown = false;
	host.active = new Map([["agent-1", agentActive]]);
	host.executionService = {
		getLeaseForKernel: () => ({
			sessionId: "session-1",
			generation: 3,
			activationId: "activation-1",
			ownerUserId: "owner-1",
			agentSandboxId: "agent-1",
		}),
		recordHostRequest: () => undefined,
	};
	host.workflowRuntime = {
		readAgentSession: async () => {
			reads++;
			throw new Error("SQLITE secret should not cross the bridge");
		},
		readAgentMaterialization: async () => undefined,
	};
	host.writeWorkerMessage = (_process: unknown, message: unknown) => {
		if ((message as { kind?: string }).kind === "kernel_host_response") responses.push(message);
	};
	await (spawner as any).handleKernelHostRequest(
		"kernel-1",
		{
			request_id: "request-1",
			input_id: "input-1",
			payload: { type: "rlm_heartbeat.list", include_inactive: false },
		},
		{ process: {} },
	);
	assert.equal(reads, 1);
	assert.equal(responses.length, 1);
	assert.equal((responses[0] as any).error.code, "rlm_heartbeat_unavailable");
	assert.equal((responses[0] as any).error.message.includes("SQLITE"), false);
});

function sandboxHost(overrides: Record<string, unknown> = {}) {
	const host = Object.create(SandboxSpawner.prototype) as any;
	const agentActive = {
		isAgentRun: true,
		hostWorkAdmissionClosed: false,
		agentRequest: {
			session_id: "session-1",
			generation: 3,
			mnemosyne: { graph_scope: { default_graph_owner: "owner-1", default_graph_id: "graph-1" } },
		},
		record: { sandbox_id: "agent-1" },
		process: {},
	};
	host.shuttingDown = false;
	host.active = new Map([["agent-1", agentActive]]);
	host.executionService = {
		getLeaseForKernel: () => ({
			sessionId: "session-1",
			generation: 3,
			activationId: "activation-1",
			ownerUserId: "owner-1",
			agentSandboxId: "agent-1",
		}),
		recordHostRequest: () => undefined,
	};
	host.writeWorkerMessage = (_process: unknown, message: unknown) => {
		host.responses.push(message);
	};
	host.responses = [];
	Object.assign(host, overrides);
	return host;
}

test("SandboxSpawner heartbeat derives every authority coordinate from durable parent rows", async () => {
	const captured: unknown[] = [];
	const host = sandboxHost();
	host.workflowRuntime = {
		readAgentSession: async () => ({
			sandbox_id: "agent-1",
			owner_user_id: "owner-1",
			graph_owner_principal: "owner-1",
			graph_id: "graph-1",
			agent_id: "agent-1",
		}),
		readAgentMaterialization: async () => ({
			generation: 3,
			activation_id: "activation-1",
			state: "running",
			sandbox_id: "agent-1",
		}),
	};
	host.heartbeatService = new AgentSessionHeartbeatService({
		port: {
			list: async (input) => {
				captured.push(input);
				return { heartbeats: [] };
			},
			create: async () => ({ heartbeat: null }),
			control: async () => ({ heartbeat: null }),
			cancel: async () => ({ heartbeat: null }),
		},
	});
	await host.handleKernelHostRequest(
		"kernel-1",
		{
			request_id: "request-1",
			input_id: "input-1",
			payload: {
				type: "rlm_heartbeat.list",
				include_inactive: false,
			},
		},
		{ process: {} },
	);
	assert.equal(captured.length, 1);
	assert.equal((captured[0] as any).sessionId, "session-1");
	assert.equal((captured[0] as any).generation, 3);
	assert.equal((captured[0] as any).activationId, "activation-1");
	assert.equal((captured[0] as any).ownerUserId, "owner-1");
	assert.equal((captured[0] as any).graphId, "graph-1");
	assert.equal((captured[0] as any).agentId, "agent-1");
	assert.equal(host.responses.length, 1);
});

test("SandboxSpawner rejects stale materialization and leaves generic capability path unfenced", async () => {
	let reads = 0;
	const host = sandboxHost();
	host.workflowRuntime = {
		readAgentSession: async () => {
			reads++;
			return null;
		},
		readAgentMaterialization: async () => null,
	};
	await host.handleKernelHostRequest(
		"kernel-1",
		{
			request_id: "stale",
			input_id: "input-1",
			payload: { type: "rlm_heartbeat.list", include_inactive: false },
		},
		{ process: {} },
	);
	assert.equal(reads, 1);
	assert.equal(host.responses.length, 1);
	assert.equal(host.responses[0].error.code, "agent_session_generation_stale");

	const generic = sandboxHost({
		workflowRuntime: {
			readAgentSession: async () => {
				reads++;
			},
		},
	});
	await generic.handleKernelHostRequest(
		"kernel-1",
		{
			request_id: "generic",
			input_id: "input-2",
			payload: { capability: "missing", tool: "missing", args: {} },
		},
		{ process: {} },
	);
	assert.equal(reads, 1);
	assert.equal(generic.responses.length, 1);
});

test("scheduled external grant rebind accepts a revision-only reread and fences drift before spawn", async () => {
	const grant = {
		schema: "sophia.agent-toolbelt-grant.v1" as const,
		grantId: "grant-1",
		subjectAgentId: "agent-1",
		issuedBy: "user:owner-1",
		authorityGraphId: "grant-graph",
		issuedAt: 1,
		status: "active" as const,
		capabilities: [
			{
				capability: "mnemosyne",
				operations: ["recall"],
				access: "read" as const,
				approvalPolicy: "ordinary" as const,
				fence: {},
				quota: {},
			},
		],
		sourceRefs: ["urn:grant:1"],
	};
	const snapshot = {
		grant,
		toolbelt: {
			grantDigest: grantDigest(grant),
			tools: [{ name: "recall", capability: "mnemosyne", available: true, destructive: false }],
			capabilities: grant.capabilities,
		},
		grantAuthorityGraphId: "grant-graph",
		grantDocumentId: "grant-doc",
		grantAuthorityOwnerPrincipal: "user:owner-1",
	};
	const spawner = Object.create(SandboxSpawner.prototype) as SandboxSpawner;
	const host = spawner as any;
	host.workflowRuntime = {
		readAgentSessionScheduleGrantBinding: async () => ({ binding: { snapshot } }),
		recordAgentSessionScheduleFireAuthorityAccepted: async () => undefined,
	};
	const input = {
		fire: {
			grant_snapshot_digest: "a".repeat(64),
			session_id: "session-1",
			fire_id: "fire-1",
			consumer: "scheduler",
			claim_token: "claim-1",
		},
	};
	const session = { agent_id: "agent-1" };
	host.currentGrantReader = {
		readCurrentGrant: async () => ({
			canonicalBytes: JSON.stringify(grant),
			digest: grantDigest(grant),
			revision: 2,
		}),
	};
	const policy = await host.rebindCurrentScheduleGrant(session, input);
	assert.deepEqual(policy.exactTools, { mnemosyne: ["recall"] });
	host.currentGrantReader = {
		readCurrentGrant: async () => ({
			canonicalBytes: JSON.stringify({ ...grant, status: "revoked" }),
			digest: "b".repeat(64),
			revision: 3,
		}),
	};
	await assert.rejects(host.rebindCurrentScheduleGrant(session, input), /schedule_grant_current_mismatch/);
	host.currentGrantReader = { readCurrentGrant: async () => Promise.reject(new Error("gateway unavailable")) };
	await assert.rejects(host.rebindCurrentScheduleGrant(session, input), /schedule_grant_current_unavailable/);
});
