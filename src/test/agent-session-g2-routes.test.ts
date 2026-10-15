import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { digestAgentRuntimeBinding } from "../agent-runtime/profile.js";
import { routeRequest } from "../orchestrator.js";
import { AgentSessionScheduleFault, WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

function request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
	const raw = body === undefined ? "" : JSON.stringify(body);
	return {
		method,
		url,
		headers: { host: "localhost", "x-internal-service": "test-secret", "x-user-id": "owner", ...headers },
		on() {},
		async *[Symbol.asyncIterator]() {
			if (raw) yield Buffer.from(raw);
		},
	} as unknown as IncomingMessage;
}

function response() {
	let body = "";
	let statusCode = 0;
	return {
		get body() {
			return JSON.parse(body || "null") as Record<string, unknown>;
		},
		get statusCode() {
			return statusCode;
		},
		set statusCode(value: number) {
			statusCode = value;
		},
		setHeader() {},
		end(value?: string) {
			body = value ?? "";
		},
	} as unknown as ServerResponse & { body: Record<string, unknown>; statusCode: number };
}

async function seed(runtime: WorkflowRuntimeStore, owner = "owner") {
	const semantic = makeTestAgentSemanticBinding({
		graphId: "g2-route",
		kind: "prime",
		registeredName: "g2-route-agent",
	});
	const runtimeBinding = {
		...semantic.runtime,
		constraints: { ...semantic.runtime.constraints, allowSchedules: true },
	};
	const spec: AgentNodeSpec = {
		label: "route-agent",
		phaseIndex: 1,
		prompt: "route",
		model: "mock:done",
		provider: "openrouter",
		graphId: "g2-route",
		sessionId: "session-route",
		toolMode: "none",
		agentId: semantic.agentId,
		runtime: runtimeBinding,
		runtimeBindingDigest: digestAgentRuntimeBinding(runtimeBinding),
		ontology: semantic.ontology,
		ontologyBindingDigest: semantic.ontologyBindingDigest,
	};
	await runtime.createWorkflowInstance({
		runId: "run-route",
		workflowName: "route",
		graphId: "g2-route",
		ownerUserId: owner,
		inputs: {},
		startedAt: 1,
	});
	await runtime.beginAgentSession({
		sessionId: "session-route",
		runId: "run-route",
		workflowName: "route",
		graphId: "g2-route",
		ownerUserId: owner,
		graphOwnerPrincipal: "user:g2",
		spec,
		nodeKey: "1:route",
		frontier: { kind: "before-node", sessionId: "session-route", ts: 1 },
		now: 1,
	});
}

describe("Agent Session G2 schedule routes", () => {
	it("authenticates, projects safely, and preserves mutation idempotency", async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "g2-route-"));
		const runtime = new WorkflowRuntimeStore(join(dir, "runtime.sqlite"));
		await runtime.init();
		await seed(runtime);
		const wakes = { count: 0 };
		const ctx = { runtime, spawner: { wakeDurableSupervision: () => wakes.count++ } };
		const previousSecret = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "test-secret";
		t.after(() => {
			if (previousSecret === undefined) delete process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
			else process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = previousSecret;
			runtime.close();
			rmSync(dir, { recursive: true, force: true });
		});

		const unauth = response();
		await routeRequest(
			request("POST", "/api/agent-sessions/session-route/schedules", {}, { "x-internal-service": "" }),
			unauth,
			ctx as never,
		);
		assert.equal(unauth.statusCode, 401);

		const created = response();
		const fireAt = Date.now() + 60_000;
		await routeRequest(
			request("POST", "/api/agent-sessions/session-route/schedules", {
				requestId: "create-1",
				scheduleId: "schedule-1",
				definition: { kind: "once", fireAt },
				prompt: { text: "hello" },
				label: "public",
			}),
			created,
			ctx as never,
		);
		assert.equal(created.statusCode, 201, JSON.stringify(created.body));
		assert.equal((created.body.schedule as Record<string, unknown>).grant_snapshot_digest, undefined);
		assert.equal((created.body.schedule as Record<string, unknown>).create_request_digest, undefined);
		assert.equal((created.body.schedule as Record<string, unknown>).client_id, undefined);
		assert.equal((created.body.schedule as Record<string, unknown>).request_digest, undefined);
		assert.equal(wakes.count, 1);

		const replay = response();
		await routeRequest(
			request("POST", "/api/agent-sessions/session-route/schedules", {
				requestId: "create-1",
				scheduleId: "schedule-1",
				definition: { kind: "once", fireAt },
				prompt: { text: "hello" },
				label: "public",
			}),
			replay,
			ctx as never,
		);
		assert.equal(replay.statusCode, 200);
		assert.equal(wakes.count, 1);

		const paused = response();
		await routeRequest(
			request("PATCH", "/api/agent-sessions/session-route/schedules/schedule-1", {
				schema: "choreograph.agent-session-schedule-control.v1",
				requestId: "pause-1",
				action: { kind: "pause" },
			}),
			paused,
			ctx as never,
		);
		assert.equal(paused.statusCode, 200);
		assert.equal((paused.body.receipt as Record<string, unknown>).requestDigest, undefined);
		assert.equal(wakes.count, 2);
		const pauseReplay = response();
		await routeRequest(
			request("PATCH", "/api/agent-sessions/session-route/schedules/schedule-1", {
				schema: "choreograph.agent-session-schedule-control.v1",
				requestId: "pause-1",
				action: { kind: "pause" },
			}),
			pauseReplay,
			ctx as never,
		);
		assert.equal(pauseReplay.statusCode, 200);
		assert.equal(wakes.count, 2);

		const resumed = response();
		await routeRequest(
			request("PATCH", "/api/agent-sessions/session-route/schedules/schedule-1", {
				schema: "choreograph.agent-session-schedule-control.v1",
				requestId: "resume-1",
				action: { kind: "resume" },
			}),
			resumed,
			ctx as never,
		);
		assert.equal(resumed.statusCode, 200);
		assert.equal(wakes.count, 3);

		const cancelled = response();
		await routeRequest(
			request("POST", "/api/agent-sessions/session-route/schedules/schedule-1/cancel", {
				requestId: "cancel-1",
				reason: "done",
			}),
			cancelled,
			ctx as never,
		);
		assert.equal(cancelled.statusCode, 202);
		assert.equal((cancelled.body.cancellation as Record<string, unknown>).request_digest, undefined);
		assert.equal((cancelled.body.cancellation as Record<string, unknown>).client_id, undefined);
		assert.equal(wakes.count, 4);

		const cancelReplay = response();
		await routeRequest(
			request("POST", "/api/agent-sessions/session-route/schedules/schedule-1/cancel", {
				requestId: "cancel-1",
				reason: "done",
			}),
			cancelReplay,
			ctx as never,
		);
		assert.equal(cancelReplay.statusCode, 200);
		assert.equal(wakes.count, 4);

		const invalidRead = response();
		await routeRequest(
			request("GET", "/api/agent-sessions/session-route/schedules/schedule-1/cancel"),
			invalidRead,
			ctx as never,
		);
		assert.equal(invalidRead.statusCode, 404);

		const missing = response();
		await routeRequest(request("GET", "/api/agent-sessions/session-route/schedules/missing"), missing, ctx as never);
		assert.equal(missing.statusCode, 404);

		const invalid = response();
		await routeRequest(
			request("POST", "/api/agent-sessions/session-route/schedules", {
				requestId: "bad",
				scheduleId: "bad",
				definition: {},
				prompt: {},
			}),
			invalid,
			ctx as never,
		);
		assert.equal(invalid.statusCode, 400);

		const runtimeAny = runtime as any;
		for (const [reason, status] of [
			["lease_lost", 503],
			["lease_expired", 503],
			["materialization_conflict", 409],
		] as const) {
			const original = runtimeAny.createAgentSessionSchedule;
			runtimeAny.createAgentSessionSchedule = async () => {
				throw new AgentSessionScheduleFault(reason, reason);
			};
			const fault = response();
			await routeRequest(
				request("POST", "/api/agent-sessions/session-route/schedules", {
					requestId: `fault-${reason}`,
					scheduleId: `fault-${reason}`,
					definition: { kind: "once", fireAt },
					prompt: { text: "x" },
				}),
				fault,
				ctx as never,
			);
			assert.equal(fault.statusCode, status);
			runtimeAny.createAgentSessionSchedule = original;
		}

		const listed = response();
		await routeRequest(request("GET", "/api/agent-sessions/session-route/schedules"), listed, ctx as never);
		assert.equal(listed.statusCode, 200);
		assert.equal((listed.body.schedules as unknown[]).length, 1);

		const wrongOwner = response();
		await routeRequest(
			request("GET", "/api/agent-sessions/session-route/schedules", undefined, { "x-user-id": "other" }),
			wrongOwner,
			ctx as never,
		);
		assert.equal(wrongOwner.statusCode, 403);
	});
});
