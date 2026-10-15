import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { routeRequest } from "../orchestrator.js";
import type { SandboxStore } from "../sandbox-store.js";
import type { SessionStore } from "../session-store.js";
import type { SandboxSpawner } from "../spawner.js";
import { JournalStore } from "../workflow/journal-store.js";
import { RunTelemetryEmitter } from "../workflow/run-telemetry.js";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import type { AgentNodeResult, AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

class InspectableWorkflowRuntimeStore extends WorkflowRuntimeStore {
	raw(sql: string, args: unknown[] = []) {
		return this.db.execute({ sql, args });
	}
}

function tmpStores(): { runtime: InspectableWorkflowRuntimeStore; journal: JournalStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "workflow-runtime-routes-test-"));
	return {
		runtime: new InspectableWorkflowRuntimeStore(join(dir, "runtime.sqlite")),
		journal: new JournalStore(join(dir, "journal.sqlite")),
		dir,
	};
}

async function seedAttachableSession(
	runtime: WorkflowRuntimeStore,
	opts: { finish?: boolean; bindSandbox?: boolean } = {},
): Promise<void> {
	await runtime.createWorkflowInstance({
		runId: "wfr-vehicle",
		workflowName: "vehicle-coupling-smoke",
		graphId: "g1",
		ownerUserId: "user-1",
		sourceSha256: "sha",
		sourceText: "export const meta = {}",
		inputs: { config: { graphId: "g1", model: "mock:done" }, args: {} },
		startedAt: 1000,
	});

	const semantic = makeTestAgentSemanticBinding({ graphId: "g1", registeredName: "vehicle-smoke-agent" });
	const spec: AgentNodeSpec = {
		label: "vehicle-agent",
		phaseIndex: 1,
		prompt: "ride along",
		model: "mock:done",
		graphId: "g1",
		toolMode: "none",
		agentType: "vehicle-smoke-agent",
		...semantic,
	};
	await runtime.beginAgentSession({
		sessionId: "ags-vehicle",
		runId: "wfr-vehicle",
		workflowName: "vehicle-coupling-smoke",
		graphId: "g1",
		ownerUserId: "user-1",
		graphOwnerPrincipal: "user:graph-owner-1",
		spec,
		nodeKey: "1:vehicle-agent",
		frontier: {
			kind: "before-node",
			nodeKey: "1:vehicle-agent",
			sessionId: "ags-vehicle",
			label: "vehicle-agent",
			phaseIndex: 1,
			ts: 1001,
		},
		now: 1001,
	});

	const activationId = "ags-vehicle:attempt-1";
	if (opts.bindSandbox || opts.finish !== false) {
		await runtime.claimAgentMaterialization("ags-vehicle", {
			generation: 0,
			activationId,
			now: 1009,
		});
		await runtime.bindAgentSandbox("ags-vehicle", {
			sandboxId: "sandbox-vehicle",
			generation: 0,
			activationId,
			now: 1010,
		});
	}

	if (opts.finish === false) {
		return;
	}

	const result: AgentNodeResult = {
		nodeKey: "1:vehicle-agent",
		sessionId: "ags-vehicle",
		invocationId: "ags-vehicle:attempt-1",
		label: "vehicle-agent",
		phaseIndex: 1,
		state: "done",
		output: "PASS",
		model: "mock:done",
		turns: 1,
		toolCalls: 0,
		tokens: 10,
		queuedAt: 1001,
		startedAt: 1010,
		durationMs: 100,
		agentType: "vehicle-smoke-agent",
	};
	await runtime.finishAgentSession("ags-vehicle", {
		result,
		status: "completed",
		generation: 0,
		activationId,
		now: 1200,
		frontier: {
			kind: "after-node",
			nodeKey: "1:vehicle-agent",
			sessionId: "ags-vehicle",
			label: "vehicle-agent",
			phaseIndex: 1,
			ts: 1200,
		},
	});
	await runtime.finishAgentMaterialization("ags-vehicle", 0, {
		activationId,
		from: "running",
		to: "completed",
		now: 1201,
	});
	await runtime.markWorkflowFinished("wfr-vehicle", {
		status: "completed",
		endedAt: 1250,
		frontier: { kind: "run-finished", ts: 1250 },
	});
}

function makeTestCtx(
	runtime: WorkflowRuntimeStore,
	journal: JournalStore,
	overrides: { spawner?: Partial<SandboxSpawner> } = {},
) {
	const telemetry = new RunTelemetryEmitter();
	journal.setTelemetryEmitter(telemetry);
	return {
		store: { get: () => undefined, list: () => [] } as unknown as SandboxStore,
		sessions: {} as unknown as SessionStore,
		spawner: {
			wakeDurableSupervision() {},
			...overrides.spawner,
		} as unknown as SandboxSpawner,
		eventBus: undefined,
		journal,
		runtime,
		telemetry,
	};
}

function mockRequest(opts: { method?: string; url: string; headers?: Record<string, string>; body?: unknown }) {
	const body = opts.body === undefined ? "" : JSON.stringify(opts.body);
	return {
		method: opts.method ?? "GET",
		url: opts.url,
		headers: {
			host: "localhost:3456",
			"x-internal-service": "dev-secret",
			"x-user-id": "user-1",
			...opts.headers,
		},
		on() {},
		async *[Symbol.asyncIterator]() {
			if (body) yield Buffer.from(body);
		},
	} as unknown as IncomingMessage;
}

function mockResponse() {
	const chunks: string[] = [];
	let statusCode = 0;
	let ended = false;
	const headers: Record<string, string | number> = {};
	return {
		get output() {
			return chunks.join("");
		},
		get headers() {
			return headers;
		},
		get ended() {
			return ended;
		},
		get writableNeedDrain() {
			return false;
		},
		get statusCode() {
			return statusCode;
		},
		set statusCode(value: number) {
			statusCode = value;
		},
		setHeader(name: string, value: string | number) {
			headers[name.toLowerCase()] = value;
		},
		writeHead(code: number, hdrs: Record<string, string>) {
			statusCode = code;
			Object.assign(headers, hdrs);
		},
		write(chunk: string) {
			chunks.push(chunk);
			return true;
		},
		end(chunk?: string) {
			if (chunk) chunks.push(chunk);
			ended = true;
		},
		setTimeout() {},
		on() {},
	} as unknown as ServerResponse & {
		output: string;
		headers: Record<string, string | number>;
		ended: boolean;
		statusCode: number;
	};
}

describe("Vehicle-facing workflow runtime routes", () => {
	it("returns a run-scoped attach index with agent-session ids", async (t) => {
		const { runtime, journal, dir } = tmpStores();
		t.after(() => {
			runtime.close();
			journal.close();
			rmSync(dir, { recursive: true, force: true });
		});
		await runtime.init();
		await journal.init();
		await seedAttachableSession(runtime);

		const previousSecret = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "dev-secret";
		t.after(() => {
			if (previousSecret === undefined) {
				delete process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
			} else {
				process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = previousSecret;
			}
		});

		const req = mockRequest({ url: "/api/workflows/runs/wfr-vehicle/agents" });
		const res = mockResponse();
		await routeRequest(req, res, makeTestCtx(runtime, journal) as never);

		assert.equal(res.statusCode, 200);
		const body = JSON.parse(res.output);
		assert.equal(body.run.runId, "wfr-vehicle");
		assert.equal(body.run.status, "completed");
		assert.equal(body.agents.length, 1);
		assert.equal(body.agents[0].sessionId, "ags-vehicle");
		assert.equal(body.agents[0].nodeKey, "1:vehicle-agent");
		assert.equal(body.agents[0].attach.kind, "agent-session");
		assert.equal(body.agents[0].runtimeKind, "simple");
		assert.equal(body.agents[0].runtimeBinding.kind, "simple");
		assert.match(body.agents[0].runtimeBindingDigest, /^sha256:/);
		assert.equal(body.agents[0].agentOntologyBinding.subject.registeredName, "vehicle-smoke-agent");
		assert.match(body.agents[0].agentOntologyBindingDigest, /^sha256:/);
		assert.equal(body.agents[0].meaningfulObjects.agentSession.kind, "agent-session");
		assert.deepEqual(body.agents[0].attach.objectRef, body.agents[0].meaningfulObjects.agentSession);
	});

	it("returns the collaborative agent-session document and event log", async (t) => {
		const { runtime, journal, dir } = tmpStores();
		t.after(() => {
			runtime.close();
			journal.close();
			rmSync(dir, { recursive: true, force: true });
		});
		await runtime.init();
		await journal.init();
		await seedAttachableSession(runtime);

		const previousSecret = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "dev-secret";
		t.after(() => {
			if (previousSecret === undefined) {
				delete process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
			} else {
				process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = previousSecret;
			}
		});

		const req = mockRequest({ url: "/api/agent-sessions/ags-vehicle" });
		const res = mockResponse();
		await routeRequest(req, res, makeTestCtx(runtime, journal) as never);

		assert.equal(res.statusCode, 200);
		const body = JSON.parse(res.output);
		assert.equal(body.session.sessionId, "ags-vehicle");
		assert.equal(body.document.schema, "choreograph.agent-session-document.v1");
		assert.equal(body.document.source.kind, "workflow-node");
		assert.equal(body.document.source.runId, "wfr-vehicle");
		assert.equal(body.document.transcript.order.length, 1);
		assert.equal(body.document.collab.schema, "choreograph.agent-session-collab.v1");
		assert.equal(body.documentBackend.crdt, "loro");
		assert.equal(body.documentRevision, 3);
		assert.equal(body.documentOps.length, 3);
		assert.deepEqual(
			body.documentOps.map((op: { kind: string }) => op.kind),
			["session.created", "runtime.bound", "session.outcome.completed"],
		);
		assert.ok(body.events.some((event: { type: string }) => event.type === "session.closed"));
	});

	it("returns cursorable collaborative document ops after a revision", async (t) => {
		const { runtime, journal, dir } = tmpStores();
		t.after(() => {
			runtime.close();
			journal.close();
			rmSync(dir, { recursive: true, force: true });
		});
		await runtime.init();
		await journal.init();
		await seedAttachableSession(runtime);

		const previousSecret = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "dev-secret";
		t.after(() => {
			if (previousSecret === undefined) {
				delete process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
			} else {
				process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = previousSecret;
			}
		});

		const req = mockRequest({ url: "/api/agent-sessions/ags-vehicle/document-ops?since=1" });
		const res = mockResponse();
		await routeRequest(req, res, makeTestCtx(runtime, journal) as never);

		assert.equal(res.statusCode, 200);
		const ops = JSON.parse(res.output);
		assert.equal(ops.length, 2);
		assert.equal(ops[0].revision, 2);
		assert.equal(ops[0].kind, "runtime.bound");
		assert.equal(ops[1].revision, 3);
		assert.equal(ops[1].kind, "session.outcome.completed");
		assert.equal(ops[1].patch.op, "transcript.result.append");
		assert.equal(res.headers["x-next-revision"], "3");
	});

	it("polls agent-session events after the last seen seq", async (t) => {
		const { runtime, journal, dir } = tmpStores();
		t.after(() => {
			runtime.close();
			journal.close();
			rmSync(dir, { recursive: true, force: true });
		});
		await runtime.init();
		await journal.init();
		await seedAttachableSession(runtime);

		const previousSecret = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "dev-secret";
		t.after(() => {
			if (previousSecret === undefined) {
				delete process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
			} else {
				process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = previousSecret;
			}
		});

		const req = mockRequest({ url: "/api/agent-sessions/ags-vehicle/events?since=0" });
		const res = mockResponse();
		await routeRequest(req, res, makeTestCtx(runtime, journal) as never);

		assert.equal(res.statusCode, 200);
		const events = JSON.parse(res.output);
		assert.deepEqual(
			events.map((event: { type: string }) => event.type),
			["budget.ledger_updated", "runtime.bound", "session.closed"],
		);
		assert.equal(events[0].sessionId, "ags-vehicle");
		assert.equal(res.headers["x-next-since"], "3");
	});

	it("streams agent-session events as SSE and closes after terminal status", async (t) => {
		const { runtime, journal, dir } = tmpStores();
		t.after(() => {
			runtime.close();
			journal.close();
			rmSync(dir, { recursive: true, force: true });
		});
		await runtime.init();
		await journal.init();
		await seedAttachableSession(runtime);

		const previousSecret = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "dev-secret";
		t.after(() => {
			if (previousSecret === undefined) {
				delete process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
			} else {
				process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = previousSecret;
			}
		});

		const req = mockRequest({
			url: "/api/agent-sessions/ags-vehicle/events",
			headers: { accept: "text/event-stream" },
		});
		const res = mockResponse();
		await routeRequest(req, res, makeTestCtx(runtime, journal) as never);
		await new Promise((resolve) => setTimeout(resolve, 25));

		assert.equal(res.statusCode, 200);
		assert.equal(res.headers["content-type"], "text/event-stream");
		assert.match(res.output, /event: session\.queued/);
		assert.match(res.output, /event: session\.closed/);
		assert.ok(res.ended);
	});

	it("claims a Vehicle driver lease and durably delivers idempotent steering", async (t) => {
		const { runtime, journal, dir } = tmpStores();
		t.after(() => {
			runtime.close();
			journal.close();
			rmSync(dir, { recursive: true, force: true });
		});
		await runtime.init();
		await journal.init();
		await seedAttachableSession(runtime, { finish: false, bindSandbox: true });

		const previousSecret = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "dev-secret";
		t.after(() => {
			if (previousSecret === undefined) {
				delete process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
			} else {
				process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = previousSecret;
			}
		});

		const liveDeliveries: Array<{ sandboxId: string; commandIds: string[] }> = [];
		const ctx = makeTestCtx(runtime, journal, {
			spawner: {
				async drainAgentSessionCommands(sandboxId) {
					const commands = await runtime.claimAgentSessionCommandsForDelivery("ags-vehicle", 0, 2100);
					liveDeliveries.push({ sandboxId, commandIds: commands.map((command) => command.command_id) });
					return commands;
				},
			},
		});

		const claimReq = mockRequest({
			method: "POST",
			url: "/api/agent-sessions/ags-vehicle/driver",
			body: { clientId: "vehicle-driver", ts: 2000 },
		});
		const claimRes = mockResponse();
		await routeRequest(claimReq, claimRes, ctx as never);

		assert.equal(claimRes.statusCode, 200);
		const claim = JSON.parse(claimRes.output);
		assert.equal(claim.applied, true);
		assert.equal(claim.driver, "vehicle-driver");
		assert.equal(claim.document.control.driverLease.holder, "vehicle-driver");
		assert.equal(claim.events[0].type, "control.driver-claimed");

		const steerReq = mockRequest({
			method: "POST",
			url: "/api/agent-sessions/ags-vehicle/steer",
			body: { clientId: "vehicle-driver", commandId: "steer-1", text: "inspect the current graph state" },
		});
		const steerRes = mockResponse();
		await routeRequest(steerReq, steerRes, ctx as never);

		assert.equal(steerRes.statusCode, 202);
		const steer = JSON.parse(steerRes.output);
		assert.equal(steer.duplicate, false);
		assert.equal(steer.driver, "vehicle-driver");
		assert.equal(steer.command.command_id, "steer-1");
		assert.equal(steer.command.name, "steer");
		assert.deepEqual(steer.command.payload, { text: "inspect the current graph state" });
		assert.deepEqual(steer.liveDelivery, {
			attempted: true,
			delivered: 1,
			sandboxId: "sandbox-vehicle",
		});
		assert.deepEqual(liveDeliveries, [{ sandboxId: "sandbox-vehicle", commandIds: ["steer-1"] }]);

		const events = await runtime.listAgentSessionEvents("ags-vehicle");
		assert.deepEqual(
			events.map((event) => event.type),
			["session.queued", "budget.ledger_updated", "runtime.bound", "control.driver-claimed", "command.accepted"],
		);
		const documentOps = await runtime.listAgentSessionDocumentOps("ags-vehicle");
		assert.deepEqual(
			documentOps.map((op) => op.kind),
			["session.created", "runtime.bound", "control.driver-claimed", "command.accepted"],
		);
		assert.equal((await runtime.readAgentSessionCommand("steer-1"))?.state, "delivered");
	});

	it("queues a passivated Vehicle follow-up for an exact durable wake instead of draining a stale sandbox", async (t) => {
		const { runtime, journal, dir } = tmpStores();
		t.after(() => {
			runtime.close();
			journal.close();
			rmSync(dir, { recursive: true, force: true });
		});
		await runtime.init();
		await journal.init();
		await seedAttachableSession(runtime, { finish: false, bindSandbox: true });
		await runtime.raw(
			`UPDATE agent_materializations
			    SET state = 'passivated', checkpoint_id = 'checkpoint-vehicle-0',
			        passivated_at = 1900, updated_at = 1900
			  WHERE session_id = 'ags-vehicle' AND generation = 0`,
		);
		await runtime.raw(
			`UPDATE agent_session_body_states SET state = 'passivated', updated_at = 1900
			  WHERE session_id = 'ags-vehicle' AND generation = 0 AND role = 'worker'`,
		);

		const previousSecret = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "dev-secret";
		t.after(() => {
			if (previousSecret === undefined) delete process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
			else process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = previousSecret;
		});
		await runtime.claimAgentSessionDriver("ags-vehicle", {
			clientId: "vehicle-driver",
			now: 2000,
			claimTs: 2000,
		});

		let wakes = 0;
		let staleDrainAttempts = 0;
		const ctx = makeTestCtx(runtime, journal, {
			spawner: {
				wakeDurableSupervision() {
					wakes += 1;
				},
				async drainAgentSessionCommands() {
					staleDrainAttempts += 1;
					return [];
				},
			},
		});
		const request = mockRequest({
			method: "POST",
			url: "/api/agent-sessions/ags-vehicle/commands",
			body: {
				clientId: "vehicle-driver",
				commandId: "follow-up-after-passivation",
				idempotencyKey: "follow-up-after-passivation",
				name: "follow_up",
				payload: { text: "Restore the checkpoint and continue." },
			},
		});
		const response = mockResponse();
		await routeRequest(request, response, ctx as never);

		assert.equal(response.statusCode, 202);
		const body = JSON.parse(response.output);
		assert.deepEqual(body.liveDelivery, {
			attempted: false,
			delivered: 0,
			sandboxId: null,
			activationQueued: true,
		});
		assert.equal(body.command.target_generation, 1);
		assert.equal(body.command.state, "queued");
		assert.equal(staleDrainAttempts, 0);
		assert.equal(wakes, 1);
	});

	it("admits only strict owner-authorized goal commands and queues their compost activation idempotently", async (t) => {
		const { runtime, journal, dir } = tmpStores();
		t.after(() => {
			runtime.close();
			journal.close();
			rmSync(dir, { recursive: true, force: true });
		});
		await runtime.init();
		await journal.init();
		await seedAttachableSession(runtime, { finish: false, bindSandbox: true });
		await runtime.raw(
			`UPDATE agent_materializations
			    SET state = 'passivated', checkpoint_id = 'checkpoint-goal-route-0',
			        passivated_at = 1900, updated_at = 1900
			  WHERE session_id = 'ags-vehicle' AND generation = 0`,
		);
		await runtime.raw(
			`UPDATE agent_session_body_states SET state = 'passivated', updated_at = 1900
			  WHERE session_id = 'ags-vehicle' AND generation = 0 AND role = 'worker'`,
		);
		const previousSecret = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "dev-secret";
		t.after(() => {
			if (previousSecret === undefined) delete process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
			else process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = previousSecret;
		});
		let wakes = 0;
		const ctx = makeTestCtx(runtime, journal, {
			spawner: {
				wakeDurableSupervision() {
					wakes += 1;
				},
			},
		});
		const post = async (body: Record<string, unknown>, headers?: Record<string, string>) => {
			const request = mockRequest({
				method: "POST",
				url: "/api/agent-sessions/ags-vehicle/commands",
				body,
				headers,
			});
			const response = mockResponse();
			await routeRequest(request, response, ctx as never);
			return response;
		};
		const completion = {
			clientId: "goal-client",
			commandId: "goal-complete-after-compost",
			idempotencyKey: "goal-complete-after-compost",
			name: "goal.complete",
			payload: {},
		};
		const accepted = await post(completion);
		assert.equal(accepted.statusCode, 202);
		assert.deepEqual(JSON.parse(accepted.output).liveDelivery, {
			attempted: false,
			delivered: 0,
			sandboxId: null,
			activationQueued: true,
		});
		assert.equal(JSON.parse(accepted.output).command.target_generation, 1);
		assert.equal(wakes, 1);

		const replay = await post(completion);
		assert.equal(replay.statusCode, 200);
		assert.equal(JSON.parse(replay.output).duplicate, true);
		assert.equal(wakes, 1);

		const goalGet = await post({
			clientId: "goal-client",
			commandId: "goal-get-after-compost",
			idempotencyKey: "goal-get-after-compost",
			name: "goal.get",
			payload: {},
		});
		assert.equal(goalGet.statusCode, 202);
		const malformedCreate = await post({
			clientId: "goal-client",
			commandId: "goal-create-malformed",
			idempotencyKey: "goal-create-malformed",
			name: "goal.create",
			payload: { objective: "strict payload", tokenBudget: 4, extra: true },
		});
		assert.equal(malformedCreate.statusCode, 400);
		const malformedComplete = await post({
			clientId: "goal-client",
			commandId: "goal-complete-malformed",
			idempotencyKey: "goal-complete-malformed",
			name: "goal.complete",
			payload: { goalId: "forged" },
		});
		assert.equal(malformedComplete.statusCode, 400);
		const unknown = await post({
			clientId: "goal-client",
			commandId: "goal-unknown",
			idempotencyKey: "goal-unknown",
			name: "goal.update",
			payload: {},
		});
		assert.equal(unknown.statusCode, 400);
		const foreign = await post(completion, { "x-user-id": "user-other" });
		assert.equal(foreign.statusCode, 403);
	});

	it("rejects non-driver steering with a not_driver control response", async (t) => {
		const { runtime, journal, dir } = tmpStores();
		t.after(() => {
			runtime.close();
			journal.close();
			rmSync(dir, { recursive: true, force: true });
		});
		await runtime.init();
		await journal.init();
		await seedAttachableSession(runtime, { finish: false, bindSandbox: true });

		const previousSecret = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "dev-secret";
		t.after(() => {
			if (previousSecret === undefined) {
				delete process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
			} else {
				process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = previousSecret;
			}
		});

		await runtime.claimAgentSessionDriver("ags-vehicle", {
			clientId: "vehicle-driver",
			now: 2000,
			claimTs: 2000,
		});

		const steerReq = mockRequest({
			method: "POST",
			url: "/api/agent-sessions/ags-vehicle/steer",
			body: { clientId: "observer", commandId: "observer-steer-1", text: "please ignore the current task" },
		});
		const steerRes = mockResponse();
		await routeRequest(steerReq, steerRes, makeTestCtx(runtime, journal) as never);

		assert.equal(steerRes.statusCode, 409);
		const body = JSON.parse(steerRes.output);
		assert.equal(body.code, "agent_session_command_rejected");
		assert.match(body.error, /driven by vehicle-driver/);
		assert.equal(body.command.state, "rejected");
		assert.equal((await runtime.listAgentSessionDocumentOps("ags-vehicle")).length, 4);

		const duplicateReq = mockRequest({
			method: "POST",
			url: "/api/agent-sessions/ags-vehicle/steer",
			body: { clientId: "observer", commandId: "observer-steer-1", text: "please ignore the current task" },
		});
		const duplicateRes = mockResponse();
		await routeRequest(duplicateReq, duplicateRes, makeTestCtx(runtime, journal) as never);
		assert.equal(duplicateRes.statusCode, 409);
		assert.equal(JSON.parse(duplicateRes.output).duplicate, true);
		assert.equal((await runtime.listAgentSessionDocumentOps("ags-vehicle")).length, 4);
	});

	it("durably cancels an owned Agent Session and wakes descendant supervision", async (t) => {
		const { runtime, journal, dir } = tmpStores();
		t.after(() => {
			runtime.close();
			journal.close();
			rmSync(dir, { recursive: true, force: true });
		});
		await runtime.init();
		await journal.init();
		await seedAttachableSession(runtime, { finish: false, bindSandbox: true });
		const previousSecret = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "dev-secret";
		t.after(() => {
			if (previousSecret === undefined) delete process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
			else process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = previousSecret;
		});
		let wakes = 0;
		const ctx = makeTestCtx(runtime, journal, {
			spawner: {
				wakeDurableSupervision: () => {
					wakes += 1;
				},
			},
		});
		const cancel = async () => {
			const req = mockRequest({
				method: "POST",
				url: "/api/agent-sessions/ags-vehicle/cancel",
				body: { requestId: "cancel-session-1", reason: "owner requested stop" },
			});
			const res = mockResponse();
			await routeRequest(req, res, ctx as never);
			return res;
		};
		const first = await cancel();
		assert.equal(first.statusCode, 202);
		const firstBody = JSON.parse(first.output);
		assert.equal(firstBody.applied, true);
		assert.equal(firstBody.cascade.cause, "explicit_cancel");
		assert.equal((await runtime.readAgentSession("ags-vehicle"))?.lifecycle_state, "closing");
		const replay = await cancel();
		assert.equal(replay.statusCode, 200);
		assert.equal(JSON.parse(replay.output).applied, false);
		assert.equal(wakes, 2);
	});

	it("cancels an undelivered durable command idempotently through the canonical route", async (t) => {
		const { runtime, journal, dir } = tmpStores();
		t.after(() => {
			runtime.close();
			journal.close();
			rmSync(dir, { recursive: true, force: true });
		});
		await runtime.init();
		await journal.init();
		await seedAttachableSession(runtime, { finish: false, bindSandbox: false });

		const previousSecret = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "dev-secret";
		t.after(() => {
			if (previousSecret === undefined) delete process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
			else process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = previousSecret;
		});
		await runtime.claimAgentSessionDriver("ags-vehicle", {
			clientId: "vehicle-driver",
			now: 2000,
			claimTs: 2000,
		});
		const ctx = makeTestCtx(runtime, journal);
		const submitReq = mockRequest({
			method: "POST",
			url: "/api/agent-sessions/ags-vehicle/commands",
			body: {
				clientId: "vehicle-driver",
				commandId: "cancel-me",
				idempotencyKey: "cancel-me",
				name: "prompt",
				payload: { text: "never deliver this" },
			},
		});
		const submitRes = mockResponse();
		await routeRequest(submitReq, submitRes, ctx as never);
		assert.equal(submitRes.statusCode, 202);
		assert.equal(JSON.parse(submitRes.output).command.state, "queued");

		const cancel = async () => {
			const req = mockRequest({
				method: "POST",
				url: "/api/agent-sessions/ags-vehicle/commands/cancel-me/cancel",
				body: { clientId: "vehicle-driver" },
			});
			const res = mockResponse();
			await routeRequest(req, res, ctx as never);
			return res;
		};
		const first = await cancel();
		assert.equal(first.statusCode, 200);
		assert.equal(JSON.parse(first.output).command.state, "cancelled");
		assert.equal(JSON.parse(first.output).duplicate, false);
		const duplicate = await cancel();
		assert.equal(duplicate.statusCode, 200);
		assert.equal(JSON.parse(duplicate.output).duplicate, true);
		assert.deepEqual(
			(await runtime.listAgentSessionEvents("ags-vehicle"))
				.map((event) => event.type)
				.filter((type) => type.startsWith("command.")),
			["command.accepted", "command.cancelled"],
		);
	});

	it("deduplicates commands canonically and redelivers only into a newer generation", async (t) => {
		const { runtime, journal, dir } = tmpStores();
		t.after(() => {
			runtime.close();
			journal.close();
			rmSync(dir, { recursive: true, force: true });
		});
		await runtime.init();
		await journal.init();
		await seedAttachableSession(runtime, { finish: false, bindSandbox: true });

		const first = await runtime.submitAgentSessionCommand("ags-vehicle", {
			commandId: "command-1",
			idempotencyKey: "vehicle-command-1",
			name: "prompt",
			payload: { text: "continue", context: { z: 2, a: 1 } },
			clientId: "vehicle-driver",
			targetGeneration: 0,
			now: 2000,
		});
		assert.equal(first?.duplicate, false);

		const duplicate = await runtime.submitAgentSessionCommand("ags-vehicle", {
			commandId: "command-1",
			idempotencyKey: "vehicle-command-1",
			name: "prompt",
			payload: { context: { a: 1, z: 2 }, text: "continue" },
			clientId: "vehicle-driver",
			targetGeneration: 0,
			now: 2001,
		});
		assert.equal(duplicate?.duplicate, true);
		assert.equal(duplicate?.record.state, "queued");

		assert.deepEqual(
			(await runtime.claimAgentSessionCommandsForDelivery("ags-vehicle", 0, 2010)).map(
				(command) => command.command_id,
			),
			["command-1"],
		);
		assert.deepEqual(await runtime.claimAgentSessionCommandsForDelivery("ags-vehicle", 0, 2011), []);
		const redelivered = await runtime.claimAgentSessionCommandsForDelivery("ags-vehicle", 1, 2020);
		assert.equal(redelivered[0]?.delivery_generation, 1);
		await assert.rejects(
			() =>
				runtime.completeAgentSessionCommand("command-1", 0, {
					status: "completed",
					result: { output: "stale" },
					now: 2021,
				}),
			/stale or undelivered generation/,
		);
		const completed = await runtime.completeAgentSessionCommand("command-1", 1, {
			status: "completed",
			result: { output: "continued" },
			now: 2022,
		});
		assert.equal(completed?.state, "completed");

		const completedDuplicate = await runtime.submitAgentSessionCommand("ags-vehicle", {
			commandId: "command-1",
			idempotencyKey: "vehicle-command-1",
			name: "prompt",
			payload: { context: { a: 1, z: 2 }, text: "continue" },
			clientId: "vehicle-driver",
			targetGeneration: 0,
			now: 2030,
		});
		assert.equal(completedDuplicate?.duplicate, true);
		assert.equal(completedDuplicate?.record.state, "completed");
		await assert.rejects(
			() =>
				runtime.submitAgentSessionCommand("ags-vehicle", {
					commandId: "command-1",
					idempotencyKey: "vehicle-command-1",
					name: "prompt",
					payload: { text: "different" },
					clientId: "vehicle-driver",
					now: 2031,
				}),
			/idempotency key already names a different command/,
		);

		const cancellable = await runtime.submitAgentSessionCommand("ags-vehicle", {
			commandId: "command-cancel",
			idempotencyKey: "vehicle-command-cancel",
			name: "follow_up",
			payload: { text: "do not deliver this" },
			clientId: "vehicle-driver",
			targetGeneration: 1,
			now: 2040,
		});
		assert.equal(cancellable?.accepted, true);
		const cancelled = await runtime.cancelAgentSessionCommand("ags-vehicle", "command-cancel", {
			clientId: "vehicle-driver",
			now: 2041,
		});
		assert.equal(cancelled?.record.state, "cancelled");
		assert.equal(cancelled?.duplicate, false);
		const cancelledDuplicate = await runtime.cancelAgentSessionCommand("ags-vehicle", "command-cancel", {
			clientId: "vehicle-driver",
			now: 2042,
		});
		assert.equal(cancelledDuplicate?.record.state, "cancelled");
		assert.equal(cancelledDuplicate?.duplicate, true);
		assert.deepEqual(await runtime.claimAgentSessionCommandsForDelivery("ags-vehicle", 1, 2043), []);
	});

	it("exposes run-level driver/CAS amendment control without changing the workflow toolbelt", async (t) => {
		const { runtime, journal, dir } = tmpStores();
		t.after(() => {
			runtime.close();
			journal.close();
			rmSync(dir, { recursive: true, force: true });
		});
		await runtime.init();
		await journal.init();
		await runtime.createWorkflowInstance({
			runId: "wfr-beats",
			workflowName: "steerable-program",
			graphId: "g1",
			ownerUserId: "user-1",
			inputs: {},
			startedAt: 1000,
		});

		const previousSecret = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "dev-secret";
		t.after(() => {
			if (previousSecret === undefined) delete process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
			else process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = previousSecret;
		});
		const ctx = makeTestCtx(runtime, journal);

		const claimReq = mockRequest({
			method: "POST",
			url: "/api/workflows/runs/wfr-beats/driver",
			body: { clientId: "vehicle-driver", ts: 2000, expectedRevision: 0 },
		});
		const claimRes = mockResponse();
		await routeRequest(claimReq, claimRes, ctx as never);
		assert.equal(claimRes.statusCode, 200);
		const claim = JSON.parse(claimRes.output);
		assert.equal(claim.control.revision, 1);
		assert.equal(claim.control.driverLease.epoch, 1);

		const amendReq = mockRequest({
			method: "POST",
			url: "/api/workflows/runs/wfr-beats/amendments",
			body: {
				clientId: "vehicle-driver",
				amendmentId: "directive-next-model",
				kind: "directive",
				targetBeatId: "triage",
				payload: { text: "inspect the new evidence before choosing" },
				expectedRevision: 1,
				leaseEpoch: 1,
			},
		});
		const amendRes = mockResponse();
		await routeRequest(amendReq, amendRes, ctx as never);
		assert.equal(amendRes.statusCode, 202);
		const amended = JSON.parse(amendRes.output);
		assert.equal(amended.control.revision, 2);
		assert.equal(amended.control.amendments[0].kind, "directive");

		const staleReq = mockRequest({
			method: "POST",
			url: "/api/workflows/runs/wfr-beats/amendments",
			body: {
				clientId: "vehicle-driver",
				amendmentId: "skip-stale",
				kind: "skip",
				targetBeatId: "triage",
				payload: {},
				expectedRevision: 1,
				leaseEpoch: 1,
			},
		});
		const staleRes = mockResponse();
		await routeRequest(staleReq, staleRes, ctx as never);
		assert.equal(staleRes.statusCode, 409);
		assert.equal(JSON.parse(staleRes.output).reason, "revision_conflict");

		const readReq = mockRequest({ url: "/api/workflows/runs/wfr-beats/control" });
		const readRes = mockResponse();
		await routeRequest(readReq, readRes, ctx as never);
		assert.equal(readRes.statusCode, 200);
		const read = JSON.parse(readRes.output);
		assert.equal(read.control.driverLease.holder, "vehicle-driver");
		assert.equal(read.control.amendments.length, 1);
	});
});
