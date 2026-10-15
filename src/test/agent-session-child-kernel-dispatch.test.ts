import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	type AgentSessionChildExecutionService,
	AgentSessionChildHostRequestFault,
} from "../agent-runtime/child-execution-service.js";
import { createSandboxEventBus } from "../event-bus.js";
import { SandboxStore } from "../sandbox-store.js";
import { SandboxSpawner } from "../spawner.js";
import type {
	AgentMaterializationRecord,
	AgentSessionRecord,
	WorkflowRuntimeStore,
} from "../workflow/runtime-store.js";

const parentSession: AgentSessionRecord = {
	session_id: "ags_parent",
	run_id: "run-1",
	owner_user_id: "owner-1",
	graph_owner_principal: "organization:kernel-dispatch-lab",
	graph_id: "graph-1",
	workflow_name: "wf",
	node_key: "pilot",
	label: "pilot",
	phase_index: 1,
	agent_id: "agent-1",
	sandbox_id: "sbx_parent",
	model: "mock:done",
	status: "running",
	lifecycle_state: "open",
	frontier_json: null,
	result_json: null,
	document_json: "{}",
	created_at: 1,
	updated_at: 1,
	completed_at: null,
};

const parentMaterialization: AgentMaterializationRecord = {
	session_id: parentSession.session_id,
	generation: 2,
	sandbox_id: "sbx_parent",
	activation_id: "activation-2",
	state: "running",
	fault_kind: null,
	recoverable: null,
	checkpoint_id: null,
	kernel_checkpoint_id: null,
	created_at: 1,
	updated_at: 1,
	passivated_at: null,
};

interface SpawnerInternals {
	shuttingDown: boolean;
	active: Map<string, Record<string, unknown>>;
	executionService: {
		getLeaseForSession(sessionId: string): undefined;
		getLeaseForKernel(kernelSandboxId: string): {
			leaseId: string;
			sessionId: string;
			agentSandboxId: string;
			ownerUserId: string;
			generation: number;
			activationId: string;
		};
		recordHostRequest(kernelSandboxId: string, inputId: string, input: Record<string, unknown>): void;
	};
	handleKernelHostRequest(
		kernelSandboxId: string,
		event: { request_id: string; input_id: string; payload: Record<string, unknown> },
		kernelActive: Record<string, unknown>,
	): Promise<void>;
	monitorExit(sandboxId: string, child: ChildProcess, cgroupPath: undefined): void;
	compostSimpleAgentBody(sessionId: string, generation: number, sandboxId: string): Promise<void>;
	heartbeatService?: { handle(input: Record<string, unknown>): Promise<unknown> };
}

function makeHarness(input?: {
	stale?: boolean;
	staleActivation?: boolean;
	materializationSandbox?: string;
	forgedSession?: boolean;
	forgedGeneration?: boolean;
	forgedOwner?: boolean;
	forgedGraph?: boolean;
	fail?: boolean;
	readFail?: boolean;
	historicalSessionSandbox?: boolean;
}) {
	const tempDir = mkdtempSync(join(tmpdir(), "child-kernel-dispatch-"));
	const sandboxStore = new SandboxStore(join(tempDir, "sandboxes.sqlite"));
	const eventBus = createSandboxEventBus(sandboxStore, { cleanupDelayMs: 0 });
	const requests: Array<Record<string, unknown>> = [];
	let durableReads = 0;
	const session = input?.historicalSessionSandbox
		? { ...parentSession, sandbox_id: "sbx_parent_gen0" }
		: parentSession;
	const materialization = input?.historicalSessionSandbox
		? { ...parentMaterialization, generation: 1, sandbox_id: "sbx_parent_gen1", activation_id: "activation-1" }
		: parentMaterialization;
	const childService = {
		async start() {},
		wake() {},
		async stop() {},
		async handle(request: Record<string, unknown>) {
			requests.push(request);
			if (input?.fail) {
				throw new AgentSessionChildHostRequestFault("rlm_subagent_not_found", "not_found", "Child run not found");
			}
			const payload = request.payload as Record<string, unknown>;
			if (payload.type === "rlm.list_subagents") {
				return {
					subagents: [
						{
							child_session_id: "ags_0123456789abcdef01234567",
							child_run_id: "acr_0123456789abcdef01234567",
							name: "researcher",
							model: "mock:done",
							run_state: "completed",
							session_state: "open",
						},
					],
				};
			}
			if (payload.type === "rlm.delete_subagent") {
				return {
					closure: {
						child_session_id: "ags_0123456789abcdef01234567",
						child_run_id: payload.target,
						name: "researcher",
						model: "mock:done",
						prior_run_state: "completed",
						final_run_state: "completed",
						session_state: "closed",
						cancellation: "not_required",
					},
				};
			}
			return {
				child_session_id: "ags_0123456789abcdef01234567",
				child_run_id: "acr_0123456789abcdef01234567",
				name: "researcher",
				model: "mock:done",
			};
		},
	} as unknown as AgentSessionChildExecutionService;
	const runtime = {
		async readAgentSession() {
			durableReads += 1;
			if (input?.readFail) throw new Error("runtime db temporarily unavailable");
			return input?.forgedSession ? { ...session, session_id: "ags_forged" } : session;
		},
		async readAgentMaterialization() {
			durableReads += 1;
			if (input?.stale) return { ...materialization, generation: materialization.generation - 1 };
			if (input?.staleActivation) return { ...materialization, activation_id: "activation-replaced" };
			if (input?.materializationSandbox) return { ...materialization, sandbox_id: input.materializationSandbox };
			return materialization;
		},
	} as unknown as WorkflowRuntimeStore;
	const spawner = new SandboxSpawner(
		sandboxStore,
		{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
		{ sandboxMode: "local-native", eventBus, workflowRuntime: runtime, childExecutionService: childService },
	);
	const kernelWrites: Record<string, unknown>[] = [];
	const testimony: Record<string, unknown>[] = [];
	const internal = spawner as unknown as SpawnerInternals;
	internal.executionService = {
		getLeaseForSession() {
			return undefined;
		},
		getLeaseForKernel() {
			return {
				leaseId: "kls_parent",
				sessionId: session.session_id,
				agentSandboxId: materialization.sandbox_id,
				ownerUserId: input?.forgedOwner ? "owner-forged" : session.owner_user_id,
				generation: input?.forgedGeneration ? materialization.generation + 1 : materialization.generation,
				activationId: materialization.activation_id,
			};
		},
		recordHostRequest(_kernelSandboxId, _inputId, record) {
			testimony.push(record);
		},
	};
	internal.active.set(materialization.sandbox_id, {
		record: { sandbox_id: materialization.sandbox_id, template: "agent", state: "running" },
		process: { stdin: { write() {} } },
		isAgentRun: true,
		agentRequest: {
			session_id: input?.forgedSession ? "ags_forged" : session.session_id,
			generation: input?.forgedGeneration ? materialization.generation + 1 : materialization.generation,
			mnemosyne: {
				graph_scope: {
					default_graph_owner: input?.forgedGraph ? "organization:forged" : session.graph_owner_principal,
					default_graph_id: input?.forgedGraph ? "graph-forged" : session.graph_id,
				},
			},
		},
		capabilityRegistry: new Map([
			[
				"mnemosyne",
				{
					async listTools() {
						return [{ name: "probe" }];
					},
					async callTool(tool: string, args: Record<string, unknown>) {
						return { tool, args, source: "generic-capability" };
					},
				},
			],
		]),
		captureIdentity: { principal: "service:choreograph" },
	});
	const kernelActive = {
		record: { sandbox_id: "sbx_kernel", template: "bare", state: "running" },
		process: { stdin: { write: (line: string) => kernelWrites.push(JSON.parse(line) as Record<string, unknown>) } },
		isKernelRun: true,
		captureIdentity: { principal: "service:choreograph" },
	};
	return {
		spawner,
		internal,
		kernelActive,
		kernelWrites,
		testimony,
		requests,
		get durableReads() {
			return durableReads;
		},
		close: () => {
			sandboxStore.close();
			rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

async function dispatch(harness: ReturnType<typeof makeHarness>, requestId: string, payload: Record<string, unknown>) {
	await harness.internal.handleKernelHostRequest(
		"sbx_kernel",
		{ request_id: requestId, input_id: `input:${requestId}`, payload },
		harness.kernelActive,
	);
	return harness.kernelWrites.at(-1)!;
}

describe("kernel RLM control dispatcher", () => {
	it("dispatches exact run/list/delete results using only the live parent materialization fence", async () => {
		const harness = makeHarness();
		try {
			const run = await dispatch(harness, "request-run", {
				type: "rlm.run",
				prompt: "inspect",
				kwargs: { name: "researcher", model: "mock:done" },
			});
			assert.equal(run.ok, true);
			assert.deepEqual(run.result, {
				child_session_id: "ags_0123456789abcdef01234567",
				child_run_id: "acr_0123456789abcdef01234567",
				name: "researcher",
				model: "mock:done",
			});
			const listed = await dispatch(harness, "request-list", { type: "rlm.list_subagents" });
			assert.equal(listed.ok, true);
			assert.equal((listed.result as { subagents: unknown[] }).subagents.length, 1);
			const deleted = await dispatch(harness, "request-delete", {
				type: "rlm.delete_subagent",
				target: "acr_0123456789abcdef01234567",
			});
			assert.equal(deleted.ok, true);
			assert.equal((deleted.result as { closure: { session_state: string } }).closure.session_state, "closed");
			assert.equal(harness.requests.length, 3);
			for (const request of harness.requests) {
				assert.deepEqual(request.parent, {
					sessionId: parentSession.session_id,
					generation: 2,
					activationId: parentMaterialization.activation_id,
					agentSandboxId: "sbx_parent",
					ownerUserId: parentSession.owner_user_id,
					graphOwnerPrincipal: parentSession.graph_owner_principal,
					graphId: parentSession.graph_id,
				});
				assert.equal("authContext" in request, false);
				assert.equal("capabilityRegistry" in request, false);
			}
			assert.equal(harness.testimony.length, 3);
		} finally {
			harness.close();
		}
	});

	it("accepts gen1 heartbeat work when Session retains only its gen0 historical sandbox", async () => {
		const harness = makeHarness({ historicalSessionSandbox: true });
		try {
			const heartbeatCalls: Record<string, unknown>[] = [];
			harness.internal.heartbeatService = {
				async handle(request) {
					heartbeatCalls.push(request);
					return { heartbeats: [] };
				},
			};
			const response = await dispatch(harness, "request-heartbeat-gen1", {
				type: "rlm_heartbeat.list",
				include_inactive: false,
			});
			assert.equal(response.ok, true);
			assert.deepEqual(response.result, { heartbeats: [] });
			const control = await dispatch(harness, "request-heartbeat-control-gen1", {
				type: "rlm_heartbeat.update",
				id: "heartbeat:gen1",
				status: "pause",
			});
			assert.equal(control.ok, true);
			const deleted = await dispatch(harness, "request-heartbeat-delete-gen1", {
				type: "rlm_heartbeat.delete",
				id: "heartbeat:gen1",
			});
			assert.equal(deleted.ok, true);
			assert.equal(heartbeatCalls.length, 3);
			assert.deepEqual(
				heartbeatCalls.map((call) => (call.payload as Record<string, unknown>).type),
				["rlm_heartbeat.list", "rlm_heartbeat.update", "rlm_heartbeat.delete"],
			);
			assert.equal((heartbeatCalls[0]?.parent as Record<string, unknown>).generation, 1);
			assert.equal((heartbeatCalls[0]?.parent as Record<string, unknown>).activationId, "activation-1");

			const readsAfterHeartbeats = harness.durableReads;
			const generic = await dispatch(harness, "request-generic-capability-gen1", {
				type: "capability.call",
				capability: "mnemosyne",
				tool: "probe",
				args: { query: "live" },
			});
			assert.equal(generic.ok, true);
			assert.deepEqual(generic.result, {
				result: { tool: "probe", args: { query: "live" }, source: "generic-capability" },
			});
			assert.equal(harness.durableReads, readsAfterHeartbeats);

			for (const [label, options] of [
				["stale activation", { historicalSessionSandbox: true, staleActivation: true }],
				["stale materialization sandbox", { historicalSessionSandbox: true, materializationSandbox: "sbx_other" }],
				["forged Session", { historicalSessionSandbox: true, forgedSession: true }],
				["forged generation", { historicalSessionSandbox: true, forgedGeneration: true }],
				["forged owner", { historicalSessionSandbox: true, forgedOwner: true }],
				["forged graph", { historicalSessionSandbox: true, forgedGraph: true }],
			] as const) {
				const rejected = makeHarness(options);
				try {
					const stale = await dispatch(rejected, `request-${label}`, { type: "rlm_heartbeat.list" });
					assert.equal(rejected.requests.length, 0, label);
					assert.equal(stale.error?.code, "agent_session_generation_stale", label);
				} finally {
					rejected.close();
				}
			}
		} finally {
			harness.close();
		}
	});

	it("returns exact structured RLM errors and rejects a stale parent before dispatch", async () => {
		const failed = makeHarness({ fail: true });
		try {
			const response = await dispatch(failed, "request-missing", {
				type: "rlm.delete_subagent",
				target: "acr_0123456789abcdef01234567",
			});
			assert.deepEqual(response.error, {
				code: "rlm_subagent_not_found",
				class: "not_found",
				message: "Child run not found",
				retryable: false,
			});
			assert.deepEqual(Object.keys(response.error as Record<string, unknown>).sort(), [
				"class",
				"code",
				"message",
				"retryable",
			]);
		} finally {
			failed.close();
		}

		const stale = makeHarness({ stale: true });
		try {
			const response = await dispatch(stale, "request-stale", {
				type: "rlm.run",
				prompt: "stale",
				kwargs: {},
			});
			assert.equal(stale.requests.length, 0);
			assert.deepEqual(response.error, {
				code: "agent_session_generation_stale",
				class: "conflict",
				message: "Kernel host request does not belong to the active parent materialization",
				retryable: false,
			});
		} finally {
			stale.close();
		}

		const replaced = makeHarness({ staleActivation: true });
		try {
			const response = await dispatch(replaced, "request-replaced-activation", {
				type: "rlm.list_subagents",
			});
			assert.equal(replaced.requests.length, 0);
			assert.deepEqual(response.error, {
				code: "agent_session_generation_stale",
				class: "conflict",
				message: "Kernel host request does not belong to the active parent materialization",
				retryable: false,
			});
		} finally {
			replaced.close();
		}
	});

	it("returns one canonical response and testimony when durable parent authority lookup fails", async () => {
		const unavailable = makeHarness({ readFail: true });
		try {
			const response = await dispatch(unavailable, "request-read-failure", { type: "rlm.list_subagents" });
			assert.equal(unavailable.requests.length, 0);
			assert.equal(unavailable.kernelWrites.length, 1);
			assert.equal(unavailable.testimony.length, 1);
			assert.deepEqual(response.error, {
				code: "child_runtime_unavailable",
				class: "unavailable",
				message: "runtime db temporarily unavailable",
				retryable: false,
			});
			assert.deepEqual(unavailable.testimony[0]?.error, response.error);
		} finally {
			unavailable.close();
		}
	});

	it("latches sandbox admission and kernel host work before shutdown drain", async () => {
		const harness = makeHarness();
		try {
			harness.internal.shuttingDown = true;
			assert.throws(
				() => harness.spawner.enqueue({ template: "bare", worker_config: { mode: "kernel", kernel: "python3" } }),
				/Sandbox admission is closed during shutdown/,
			);
			const response = await dispatch(harness, "request-after-latch", { type: "rlm.list_subagents" });
			assert.equal(harness.requests.length, 0);
			assert.deepEqual(response.error, {
				code: "kernel_host_shutting_down",
				class: "unavailable",
				message: "Kernel host work is unavailable during shutdown",
				retryable: false,
			});
		} finally {
			harness.close();
		}
	});

	it("composts only the exact terminal simple child and preserves its done sandbox outcome", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "simple-child-compost-"));
		const sandboxStore = new SandboxStore(join(tempDir, "sandboxes.sqlite"));
		const eventBus = createSandboxEventBus(sandboxStore, { cleanupDelayMs: 0 });
		const spawner = new SandboxSpawner(
			sandboxStore,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{ sandboxMode: "local-native", eventBus },
		);
		const internal = spawner as unknown as SpawnerInternals;
		const body = spawn(
			process.execPath,
			["-e", "process.stdin.resume(); process.stdin.once('end', () => process.exit(0));"],
			{
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		try {
			await once(body, "spawn");
			const queued = sandboxStore.create("agent");
			sandboxStore.transitionToSpawning(queued.sandbox_id, "local-native");
			const running = sandboxStore.transitionToRunning(queued.sandbox_id, body.pid!);
			const active: Record<string, unknown> = {
				record: running,
				process: body,
				isAgentRun: true,
				agentRequest: { session_id: "ags_compost", generation: 0 },
				runtimeBinding: { kind: "prime", constraints: { allowPersistentKernel: true } },
				workerTerminalState: "done",
				workerResult: { status: "terminated", turns: 1 },
				captureIdentity: { principal: "service:choreograph" },
			};
			internal.active.set(running.sandbox_id, active);
			internal.monitorExit(running.sandbox_id, body, undefined);
			await assert.rejects(
				internal.compostSimpleAgentBody("ags_compost", 0, running.sandbox_id),
				/outside simple child/,
			);
			active.runtimeBinding = { kind: "simple", constraints: { allowPersistentKernel: false } };
			await assert.rejects(
				internal.compostSimpleAgentBody("ags_compost", 1, running.sandbox_id),
				/outside simple child/,
			);
			active.workerResult = undefined;
			await assert.rejects(
				internal.compostSimpleAgentBody("ags_compost", 0, running.sandbox_id),
				/before its terminal result/,
			);
			active.workerResult = { status: "terminated", turns: 1 };
			await internal.compostSimpleAgentBody("ags_compost", 0, running.sandbox_id);
			assert.equal(spawner.sessionBodyCount("ags_compost"), 0);
			assert.equal(sandboxStore.get(running.sandbox_id)?.state, "done");
		} finally {
			if (body.exitCode === null && body.signalCode === null) body.kill("SIGKILL");
			await spawner.shutdownAll();
			sandboxStore.close();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
