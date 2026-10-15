import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";
import type { Span } from "@opentelemetry/api";
import { canonicalDigest } from "@sophia-labs/canonical-json";
import { SophiaContentStore } from "../agent-runtime/content-store.js";
import {
	PRIME_HOST_PROTOCOL_VERSION,
	type PrimeCommandResultV1,
	type PrimeWorkerEventV1,
	parsePrimeHostBridgeMessage,
} from "../agent-runtime/host-protocol.js";
import { AgentMemory } from "../agent-runtime/memory.js";
import { PRIME_RUNTIME_STATE_SCHEMA, type PrimeRuntimeStateV2 } from "../agent-runtime/result-validation.js";
import { type BusEvent, createSandboxEventBus, type SandboxEventBus } from "../event-bus.js";
import type { CapabilityBackend, HostedMnemosyneProxy, HostedServiceAuthConfig } from "../mnemosyne.js";
import { type CaptureEmitter, CaptureWriter, type ChoreographCaptureEvent } from "../observatory-capture.js";
import { digestSophiaAgentSourceTree } from "../runtime-bundles.js";
import { SandboxStore } from "../sandbox-store.js";
import { SandboxSpawner } from "../spawner.js";
import type { AgentSpawnRequest, AgentSpawnResult } from "../wire-protocol.js";
import { makeNodeRunner } from "../workflow/run-node.js";
import { makeRuntimeNodeRunner } from "../workflow/runtime-control.js";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import type { AgentNodeResult, AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

const SOPHIA_AGENT_ENTRYPOINT = process.env.SOPHIA_AGENT_RUNTIME_ENTRYPOINT?.trim();
const SOPHIA_RUNTIME_SKIP =
	!SOPHIA_AGENT_ENTRYPOINT || !existsSync(SOPHIA_AGENT_ENTRYPOINT)
		? "set SOPHIA_AGENT_RUNTIME_ENTRYPOINT to a Sophia host-worker.js or host-worker.ts"
		: false;
const SOPHIA_RUNTIME_DIGEST = SOPHIA_AGENT_ENTRYPOINT
	? digestSophiaAgentSourceTree(SOPHIA_AGENT_ENTRYPOINT)
	: undefined;
const JUPYTER_BRIDGE = process.env.SOPHIA_JUPYTER_BRIDGE_PATH?.trim();
const PRIME_KERNEL_PYTHON = process.env.SOPHIA_PRIME_KERNEL_PYTHON?.trim();
const KERNEL_RUNTIME_SKIP =
	SOPHIA_RUNTIME_SKIP ||
	!JUPYTER_BRIDGE ||
	!existsSync(JUPYTER_BRIDGE) ||
	!PRIME_KERNEL_PYTHON ||
	!existsSync(PRIME_KERNEL_PYTHON)
		? "set the Prime worker, Jupyter bridge, and kernel Python paths"
		: false;
const TERMINAL_STATES = new Set(["done", "truncated", "error", "timeout", "killed"]);

class RecordingCapture implements CaptureEmitter {
	readonly events: ChoreographCaptureEvent[] = [];
	constructor(private readonly downstream?: CaptureEmitter) {}
	emit(input: ChoreographCaptureEvent): void {
		this.events.push(input);
		this.downstream?.emit(input);
	}
}

async function waitForTerminal(store: SandboxStore, sandboxId: string): Promise<void> {
	const deadline = Date.now() + 35_000;
	while (Date.now() < deadline) {
		if (TERMINAL_STATES.has(store.get(sandboxId)?.state ?? "")) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`sandbox ${sandboxId} did not terminate`);
}

async function eventually(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 2));
	}
	assert.fail(message);
}

describe("SandboxSpawner Observatory seams", { concurrency: false }, () => {
	let tempDir: string;
	let store: SandboxStore;
	let capture: RecordingCapture;
	let wireWriter: CaptureWriter;
	let wireOutput: string;
	let spawner: SandboxSpawner;
	let eventBus: SandboxEventBus;

	before(() => {
		tempDir = mkdtempSync(join(tmpdir(), "spawner-observatory-"));
		store = new SandboxStore(join(tempDir, "sandboxes.sqlite"));
		wireOutput = "";
		const wireSink = new PassThrough();
		wireSink.on("data", (chunk: Buffer) => {
			wireOutput += chunk.toString("utf8");
		});
		wireWriter = new CaptureWriter({ sink: wireSink, hostId: "local-test", heartbeatMs: 0 });
		capture = new RecordingCapture(wireWriter);
		eventBus = createSandboxEventBus(store, { cleanupDelayMs: 0 });
		spawner = new SandboxSpawner(
			store,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			// This suite proves testimony semantics, not a startup SLO. Leave enough
			// budget for the real worker process under Node's parallel test runner.
			{ sandboxMode: "local-native", defaultTimeoutMs: 30_000, capture, eventBus },
		);
	});

	after(async () => {
		await spawner.shutdownAll();
		await wireWriter.close();
		store.close();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("serializes the trusted pre-spawn gate before any worker adapter entry and replays its terminal rejection", async () => {
		const internals = spawner as unknown as {
			doSpawn(sandboxId: string, options: unknown): Promise<void>;
		};
		const originalDoSpawn = internals.doSpawn.bind(spawner);
		let adapterEntries = 0;
		internals.doSpawn = async () => {
			adapterEntries += 1;
		};
		let enterGate!: () => void;
		const gateEntered = new Promise<void>((resolve) => {
			enterGate = resolve;
		});
		let releaseGate!: () => void;
		const gateReleased = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		let backendCloses = 0;
		const backend = {
			close: async () => {
				backendCloses += 1;
			},
		} as CapabilityBackend;
		try {
			const queued = spawner.enqueue({
				template: "bare",
				capabilityBackends: new Map([["test", backend]]),
				preSpawnGate: async ({ sandboxId }) => {
					assert.equal(sandboxId, queued.sandbox_id);
					enterGate();
					await gateReleased;
					throw new Error("durable launch intent was cancelled");
				},
			});
			await gateEntered;
			assert.equal(adapterEntries, 0);
			const replayed: BusEvent[] = [];
			const unsubscribe = eventBus.subscribe((event) => replayed.push(event), { sandbox_id: queued.sandbox_id });
			releaseGate();
			await waitForTerminal(store, queued.sandbox_id);
			unsubscribe();
			assert.equal(store.get(queued.sandbox_id)?.state, "killed");
			assert.equal(adapterEntries, 0);
			assert.equal(backendCloses, 1);
			assert.equal(
				replayed.some(
					(event) =>
						(event.category === "lifecycle" && event.type === "terminal" && event.state === "killed") ||
						(event.category === "system" &&
							event.type === "snapshot" &&
							event.recent_events.some(
								(recent) =>
									recent.category === "lifecycle" && recent.type === "terminal" && recent.state === "killed",
							)),
				),
				true,
			);
		} finally {
			releaseGate();
			internals.doSpawn = originalDoSpawn;
		}
	});

	it("latches a semaphore-queued spawn before adapter entry and drains the tracked task", async () => {
		const directory = mkdtempSync(join(tmpdir(), "spawner-shutdown-queue-"));
		const localStore = new SandboxStore(join(directory, "sandboxes.sqlite"));
		const localSpawner = new SandboxSpawner(
			localStore,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{ sandboxMode: "local-native", maxConcurrentSpawns: 1 },
		);
		const internals = localSpawner as unknown as {
			semaphore: { acquire(): Promise<void>; release(): void };
			doSpawn(sandboxId: string, options: unknown): Promise<void>;
		};
		await internals.semaphore.acquire();
		let slotHeld = true;
		let adapterEntries = 0;
		internals.doSpawn = async () => {
			adapterEntries += 1;
		};
		try {
			const queued = localSpawner.enqueue({ template: "bare" });
			let shutdownFinished = false;
			const shutdown = localSpawner.shutdownAll().then(() => {
				shutdownFinished = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 5));
			assert.equal(shutdownFinished, false, "shutdown must await the already-admitted spawn task");
			assert.equal(adapterEntries, 0);
			internals.semaphore.release();
			slotHeld = false;
			await shutdown;
			assert.equal(adapterEntries, 0);
			assert.equal(localStore.get(queued.sandbox_id)?.state, "killed");
			assert.equal(localSpawner.getActive().size, 0);
		} finally {
			if (slotHeld) internals.semaphore.release();
			await localSpawner.shutdownAll();
			localStore.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("tears down kernels before draining a bridge request that depends on kernel detach", async () => {
		const directory = mkdtempSync(join(tmpdir(), "spawner-shutdown-kernel-request-"));
		const localStore = new SandboxStore(join(directory, "sandboxes.sqlite"));
		const localSpawner = new SandboxSpawner(
			localStore,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{ sandboxMode: "local-native" },
		);
		let releaseBridge!: () => void;
		const bridgeReleased = new Promise<void>((resolve) => {
			releaseBridge = resolve;
		});
		const internals = localSpawner as unknown as {
			kernelHostRequests: Set<Promise<void>>;
			executionService: { shutdownAll(): Promise<void> };
		};
		let tracked!: Promise<void>;
		tracked = bridgeReleased.finally(() => internals.kernelHostRequests.delete(tracked));
		internals.kernelHostRequests.add(tracked);
		internals.executionService = {
			async shutdownAll() {
				releaseBridge();
			},
		};
		try {
			await localSpawner.shutdownAll();
			assert.equal(internals.kernelHostRequests.size, 0);
		} finally {
			releaseBridge();
			localStore.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("reaps a shutdown-owned child pair without manufacturing cancellation testimony", async () => {
		const sandboxId = "sbx-host-stop-child";
		const calls: string[] = [];
		let terminalWrites = 0;
		const internals = spawner as unknown as {
			active: Map<string, Record<string, unknown>>;
			workflowRuntime?: {
				readAgentMaterialization(): Promise<Record<string, unknown>>;
				finishAgentMaterialization(): Promise<void>;
			};
			executionService: { reapForRecovery(sessionId: string, generation: number): Promise<boolean> };
			killProcess(sandboxId: string, reason: string): Promise<void>;
			reapAgentSessionBodiesWithoutSettlement(sessionId: string, generation: number): Promise<void>;
		};
		const previousRuntime = internals.workflowRuntime;
		const previousExecution = internals.executionService;
		const originalKill = internals.killProcess.bind(spawner);
		internals.workflowRuntime = {
			async readAgentMaterialization() {
				return {
					session_id: "ags-host-stop-child",
					generation: 0,
					sandbox_id: sandboxId,
					activation_id: "activation-host-stop",
					state: "running",
				};
			},
			async finishAgentMaterialization() {
				terminalWrites += 1;
			},
		};
		internals.executionService = {
			async reapForRecovery() {
				calls.push("kernel-reap");
				return true;
			},
		};
		internals.active.set(sandboxId, {
			durableSupervisorExit: true,
			record: { sandbox_id: sandboxId, state: "running" },
		});
		internals.killProcess = async () => {
			calls.push("worker-reap");
			internals.active.delete(sandboxId);
		};
		try {
			await internals.reapAgentSessionBodiesWithoutSettlement("ags-host-stop-child", 0);
			assert.deepEqual(calls, ["kernel-reap", "worker-reap"]);
			assert.equal(terminalWrites, 0, "host shutdown cannot testify cancelled/faulted before leased recovery");
		} finally {
			internals.active.delete(sandboxId);
			internals.workflowRuntime = previousRuntime;
			internals.executionService = previousExecution;
			internals.killProcess = originalKill;
		}
	});

	it("synchronously latches an aborted child against new kernel work before durable arbitration", async () => {
		const writes: Record<string, unknown>[] = [];
		let kernelExecutions = 0;
		const controller = new AbortController();
		const active = {
			hostWorkAdmissionClosed: false,
			bridgeAbortControllers: new Map([["existing-request", controller]]),
			record: { sandbox_id: "sbx-aborted-child", template: "agent", state: "running" },
			isAgentRun: true,
			nextHostResponseId: 0,
			agentRequest: {
				session_id: "ags-aborted-child",
				generation: 0,
				runtime_binding: { constraints: { allowPersistentKernel: true } },
			},
		};
		const internals = spawner as unknown as {
			executionService: {
				getLease(): { sessionId: string };
				execute(): Promise<void>;
			};
			closeActiveHostWorkAdmission(active: Record<string, unknown>, reason: Error): void;
			handleKernelRequest(
				request: Record<string, unknown>,
				child: unknown,
				active: Record<string, unknown>,
			): Promise<void>;
		};
		const previousExecution = internals.executionService;
		internals.executionService = {
			getLease: () => ({ sessionId: "ags-aborted-child" }),
			async execute() {
				kernelExecutions += 1;
			},
		};
		try {
			internals.closeActiveHostWorkAdmission(active, new Error("durable delete is arbitrating"));
			assert.equal(controller.signal.aborted, true);
			await internals.handleKernelRequest(
				{
					protocol: PRIME_HOST_PROTOCOL_VERSION,
					kind: "request",
					name: "kernel.request",
					requestId: "bridge-kernel-after-delete",
					sandboxId: "sbx-aborted-child",
					sessionId: "ags-aborted-child",
					generation: 0,
					sequence: 1,
					payload: {
						requestId: "kernel-after-delete",
						operation: "execute",
						leaseId: "kls-aborted-child",
						code: "side_effect()",
					},
				},
				{ stdin: { write: (line: string) => writes.push(JSON.parse(line) as Record<string, unknown>) } },
				active,
			);
			assert.equal(kernelExecutions, 0);
			assert.equal(writes.length, 1);
			assert.match(JSON.stringify(writes[0]), /kernel_runtime_shutting_down/);
		} finally {
			internals.executionService = previousExecution;
		}
	});

	it("rechecks shutdown after an in-flight pre-spawn gate before any adapter entry", async () => {
		const directory = mkdtempSync(join(tmpdir(), "spawner-shutdown-gate-"));
		const localStore = new SandboxStore(join(directory, "sandboxes.sqlite"));
		const localSpawner = new SandboxSpawner(
			localStore,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{ sandboxMode: "local-native", maxConcurrentSpawns: 1 },
		);
		const internals = localSpawner as unknown as {
			doSpawn(sandboxId: string, options: unknown): Promise<void>;
		};
		let adapterEntries = 0;
		internals.doSpawn = async () => {
			adapterEntries += 1;
		};
		let gateEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			gateEntered = resolve;
		});
		let releaseGate!: () => void;
		const released = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		let backendCloses = 0;
		const backend = {
			close: async () => {
				backendCloses += 1;
			},
		} as CapabilityBackend;
		try {
			const queued = localSpawner.enqueue({
				template: "bare",
				capabilityBackends: new Map([["test", backend]]),
				preSpawnGate: async () => {
					gateEntered();
					await released;
				},
			});
			await entered;
			const shutdown = localSpawner.shutdownAll();
			await new Promise((resolve) => setTimeout(resolve, 5));
			assert.equal(adapterEntries, 0);
			releaseGate();
			await shutdown;
			assert.equal(adapterEntries, 0);
			assert.equal(localStore.get(queued.sandbox_id)?.state, "killed");
			assert.equal(backendCloses, 1);
			assert.equal(localSpawner.getActive().size, 0);
		} finally {
			releaseGate();
			await localSpawner.shutdownAll();
			localStore.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("retains an uncooperative process and running testimony until an actual close is observed", async () => {
		const directory = mkdtempSync(join(tmpdir(), "spawner-uncooperative-reap-"));
		const localStore = new SandboxStore(join(directory, "sandboxes.sqlite"));
		const localSpawner = new SandboxSpawner(
			localStore,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{
				sandboxMode: "local-native",
				killTermGraceMs: 3,
				killForceGraceMs: 3,
				exitCleanupGraceMs: 10,
			},
		);
		const queued = localStore.create("bare");
		localStore.transitionToSpawning(queued.sandbox_id, "local-native");
		const running = localStore.transitionToRunning(queued.sandbox_id, 4242);
		const child = new EventEmitter() as EventEmitter & {
			exitCode: number | null;
			signalCode: string | null;
			kill(signal?: string): boolean;
		};
		child.exitCode = null;
		child.signalCode = null;
		child.kill = () => false;
		const internals = localSpawner as unknown as {
			active: Map<string, Record<string, unknown>>;
			killProcess(sandboxId: string, reason: "killed"): Promise<unknown>;
			monitorExit(sandboxId: string, child: unknown, cgroupPath: undefined): void;
		};
		internals.active.set(queued.sandbox_id, {
			record: running,
			process: child,
			bodyBound: true,
			captureIdentity: {},
		});
		internals.monitorExit(queued.sandbox_id, child, undefined);
		try {
			await assert.rejects(internals.killProcess(queued.sandbox_id, "killed"), /physical exit|did not exit/);
			assert.equal(internals.active.has(queued.sandbox_id), true);
			assert.equal(localStore.get(queued.sandbox_id)?.state, "running");
			child.exitCode = 0;
			child.emit("exit", 0, null);
			child.emit("close", 0, null);
			await eventually(() => !internals.active.has(queued.sandbox_id), "late close did not finish monitor cleanup");
			assert.equal(localStore.get(queued.sandbox_id)?.state, "done");
		} finally {
			await localSpawner.shutdownAll();
			localStore.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("retains post-exit cleanup identity until a failed cgroup reap can be retried", async () => {
		const directory = mkdtempSync(join(tmpdir(), "spawner-cgroup-retry-"));
		const cgroupPath = join(directory, "sandbox-cgroup");
		mkdirSync(cgroupPath);
		writeFileSync(join(cgroupPath, "cgroup.kill"), "");
		writeFileSync(join(cgroupPath, "cgroup.procs"), "");
		writeFileSync(join(cgroupPath, "cgroup.events"), "populated 0\n");
		const localStore = new SandboxStore(join(directory, "sandboxes.sqlite"));
		const localSpawner = new SandboxSpawner(
			localStore,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{ sandboxMode: "local-native", exitCleanupGraceMs: 20 },
		);
		const queued = localStore.create("bare");
		localStore.transitionToSpawning(queued.sandbox_id, cgroupPath);
		const running = localStore.transitionToRunning(queued.sandbox_id, 5252);
		const child = new EventEmitter() as EventEmitter & {
			exitCode: number | null;
			signalCode: string | null;
			kill(signal?: string): boolean;
		};
		child.exitCode = 0;
		child.signalCode = null;
		child.kill = () => true;
		const internals = localSpawner as unknown as {
			active: Map<string, { exitCleanupError?: unknown }>;
			killProcess(sandboxId: string, reason: "killed"): Promise<unknown>;
			monitorExit(sandboxId: string, child: unknown, cgroupPath: string): void;
			recordDurableAgentBodyExit(active: unknown, code: number | null): Promise<void>;
		};
		const originalRecordBodyExit = internals.recordDurableAgentBodyExit.bind(localSpawner);
		let durableBodyExits = 0;
		internals.recordDurableAgentBodyExit = async () => {
			durableBodyExits += 1;
		};
		internals.active.set(queued.sandbox_id, {
			record: running,
			process: child,
			cgroupPath,
			bodyBound: true,
			captureIdentity: {},
		} as never);
		internals.monitorExit(queued.sandbox_id, child, cgroupPath);
		try {
			child.emit("close", 0, null);
			await eventually(
				() => internals.active.get(queued.sandbox_id)?.exitCleanupError !== undefined,
				"failed cgroup cleanup did not preserve retry identity",
			);
			assert.equal(internals.active.has(queued.sandbox_id), true);
			assert.equal(localStore.get(queued.sandbox_id)?.state, "done");
			assert.equal(durableBodyExits, 0, "Agent body truth must remain live while cgroup cleanup is unverified");
			rmSync(cgroupPath, { recursive: true, force: true });
			await internals.killProcess(queued.sandbox_id, "killed");
			assert.equal(internals.active.has(queued.sandbox_id), false);
			assert.equal(durableBodyExits, 1, "late verified cleanup commits exact Agent body testimony once");
		} finally {
			internals.recordDurableAgentBodyExit = originalRecordBodyExit;
			rmSync(cgroupPath, { recursive: true, force: true });
			await localSpawner.shutdownAll();
			localStore.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("faults an unexpectedly closed hosted worker after physical reap while expected exits remain supervisor-owned", async () => {
		const calls: string[] = [];
		let materializationReads = 0;
		const internals = spawner as unknown as {
			workflowRuntime?: {
				readAgentMaterialization(sessionId: string, generation: number): Promise<Record<string, unknown>>;
				finishAgentMaterialization(
					sessionId: string,
					generation: number,
					input: Record<string, unknown>,
				): Promise<void>;
			};
			executionService: {
				getLeaseForSession(sessionId: string): Record<string, unknown> | undefined;
				reapSessionAcquisition(
					sessionId: string,
					generation: number,
					activationId: string,
					terminalState: string,
				): Promise<boolean>;
			};
			recordDurableAgentBodyExit(active: Record<string, unknown>, code: number | null): Promise<void>;
		};
		const previousRuntime = internals.workflowRuntime;
		const previousExecution = internals.executionService;
		internals.workflowRuntime = {
			async readAgentMaterialization() {
				materializationReads += 1;
				return {
					session_id: "ags-hosted-worker-crash",
					generation: 0,
					activation_id: "activation-hosted-worker-crash",
					sandbox_id: "sbx-hosted-worker-crash",
					state: "running",
					checkpoint_id: null,
				};
			},
			async finishAgentMaterialization(_sessionId, _generation, input) {
				calls.push(`materialization:${String(input.to)}`);
				assert.equal(input.faultKind, "worker_exit");
			},
		};
		internals.executionService = {
			getLeaseForSession: () => ({
				leaseId: "kernel-lease-hosted-worker-crash",
				generation: 0,
				activationId: "activation-hosted-worker-crash",
			}),
			async fault() {
				calls.push("kernel:faulted");
			},
		};
		const unexpected = {
			isAgentRun: true,
			bodyBound: true,
			durableSupervisorExit: true,
			hostWorkAdmissionClosed: false,
			record: { sandbox_id: "sbx-hosted-worker-crash" },
			agentRequest: {
				session_id: "ags-hosted-worker-crash",
				generation: 0,
				runtime_binding: { kind: "prime" },
			},
		};
		try {
			await internals.recordDurableAgentBodyExit(unexpected, 9);
			assert.deepEqual(calls, ["kernel:faulted", "materialization:faulted"]);
			assert.equal(materializationReads, 1);

			await internals.recordDurableAgentBodyExit({ ...unexpected, hostWorkAdmissionClosed: true }, 9);
			await internals.recordDurableAgentBodyExit(
				{
					...unexpected,
					workerResult: { state: "error" },
					agentRequest: {
						...unexpected.agentRequest,
						runtime_binding: { kind: "simple" },
					},
				},
				0,
			);
			assert.deepEqual(calls, ["kernel:faulted", "materialization:faulted"]);
			assert.equal(materializationReads, 1, "expected exits remain under the exact child-run supervisor");
		} finally {
			internals.workflowRuntime = previousRuntime;
			internals.executionService = previousExecution;
		}
	});

	it("reaps a crashed Prime worker's paired kernel before draining its blocked cell", async () => {
		const directory = mkdtempSync(join(tmpdir(), "spawner-worker-crash-kernel-first-"));
		const localStore = new SandboxStore(join(directory, "sandboxes.sqlite"));
		const localSpawner = new SandboxSpawner(
			localStore,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{ sandboxMode: "local-native", exitCleanupGraceMs: 100 },
		);
		const queued = localStore.create("agent");
		localStore.transitionToSpawning(queued.sandbox_id, "local-native");
		const running = localStore.transitionToRunning(queued.sandbox_id, 6262);
		const child = new EventEmitter() as EventEmitter & {
			exitCode: number | null;
			signalCode: string | null;
			kill(signal?: string): boolean;
		};
		child.exitCode = 9;
		child.signalCode = "SIGKILL";
		child.kill = () => true;
		let releaseBlockedCell!: () => void;
		const blockedCell = new Promise<void>((resolve) => {
			releaseBlockedCell = resolve;
		});
		const workerLineRequests = new Set<Promise<void>>();
		let trackedBlockedCell!: Promise<void>;
		trackedBlockedCell = blockedCell.finally(() => workerLineRequests.delete(trackedBlockedCell));
		workerLineRequests.add(trackedBlockedCell);
		let kernelAttached = true;
		const calls: string[] = [];
		const internals = localSpawner as unknown as {
			active: Map<string, Record<string, unknown>>;
			workflowRuntime?: {
				readAgentMaterialization(): Promise<Record<string, unknown>>;
				finishAgentMaterialization(
					sessionId: string,
					generation: number,
					input: Record<string, unknown>,
				): Promise<void>;
			};
			executionService: {
				getLeaseForSession(sessionId: string): Record<string, unknown> | undefined;
				fault(leaseId: string): Promise<void>;
			};
			monitorExit(sandboxId: string, process: unknown, cgroupPath: undefined): void;
		};
		const previousRuntime = internals.workflowRuntime;
		const previousExecution = internals.executionService;
		internals.workflowRuntime = {
			async readAgentMaterialization() {
				return {
					session_id: "ags-hosted-blocked-cell",
					generation: 0,
					activation_id: "activation-hosted-blocked-cell",
					sandbox_id: queued.sandbox_id,
					state: "running",
					checkpoint_id: null,
				};
			},
			async finishAgentMaterialization(_sessionId, _generation, input) {
				calls.push(`materialization:${String(input.to)}`);
			},
		};
		internals.executionService = {
			getLeaseForSession: () =>
				kernelAttached
					? {
							leaseId: "kernel-lease-blocked-cell",
							generation: 0,
							activationId: "activation-hosted-blocked-cell",
						}
					: undefined,
			async reapSessionAcquisition(sessionId, generation, activationId, terminalState) {
				assert.equal(sessionId, "ags-hosted-blocked-cell");
				assert.equal(generation, 0);
				assert.equal(activationId, "activation-hosted-blocked-cell");
				assert.equal(terminalState, "faulted");
				calls.push("kernel:faulted");
				kernelAttached = false;
				releaseBlockedCell();
				return true;
			},
		};
		internals.active.set(queued.sandbox_id, {
			record: running,
			process: child,
			isAgentRun: true,
			bodyBound: true,
			durableSupervisorExit: true,
			hostWorkAdmissionClosed: false,
			hostedChildRunId: `acr_${"b".repeat(24)}`,
			workerLineRequests,
			captureIdentity: {},
			agentRequest: {
				session_id: "ags-hosted-blocked-cell",
				generation: 0,
				invocation_id: "activation-hosted-blocked-cell",
				runtime_binding: { kind: "prime" },
			},
		});
		internals.monitorExit(queued.sandbox_id, child, undefined);
		try {
			child.emit("exit", 9, "SIGKILL");
			child.emit("close", 9, "SIGKILL");
			await eventually(
				() => !internals.active.has(queued.sandbox_id),
				"blocked cell did not drain after paired-kernel fault",
			);
			assert.deepEqual(calls, ["kernel:faulted", "materialization:faulted"]);
			assert.equal(kernelAttached, false);
			assert.equal(localStore.get(queued.sandbox_id)?.state, "error");
		} finally {
			releaseBlockedCell();
			internals.workflowRuntime = previousRuntime;
			internals.executionService = previousExecution;
			await localSpawner.shutdownAll();
			localStore.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("keeps launch preparation and post-spawn bind failures free of fabricated Agent body testimony", async () => {
		const directory = mkdtempSync(join(tmpdir(), "spawner-post-spawn-bind-"));
		const localStore = new SandboxStore(join(directory, "sandboxes.sqlite"));
		const localSpawner = new SandboxSpawner(
			localStore,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{
				sandboxMode: "local-native",
				defaultTimeoutMs: 5_000,
				killTermGraceMs: 100,
				killForceGraceMs: 100,
				exitCleanupGraceMs: 1_000,
			},
		);
		const internals = localSpawner as unknown as {
			active: Map<string, { bodyBound?: boolean }>;
			resolveWorkerRuntime(sandboxId: string, options: unknown): Promise<unknown>;
			recordDurableAgentBodyExit(active: unknown, code: number | null): Promise<void>;
		};
		const originalResolve = internals.resolveWorkerRuntime.bind(localSpawner);
		const originalRecordBodyExit = internals.recordDurableAgentBodyExit.bind(localSpawner);
		let preGates = 0;
		let processBinds = 0;
		let cleanupEntered!: () => void;
		let releaseCleanup!: () => void;
		const enteredCleanup = new Promise<void>((resolve) => {
			cleanupEntered = resolve;
		});
		const cleanupReleased = new Promise<void>((resolve) => {
			releaseCleanup = resolve;
		});
		try {
			internals.resolveWorkerRuntime = async () => {
				throw new Error("capability preparation failed");
			};
			const prepFailure = localSpawner.enqueue({
				template: "bare",
				preSpawnGate: async () => {
					preGates += 1;
				},
				onProcessSpawn: async () => {
					processBinds += 1;
				},
			});
			await waitForTerminal(localStore, prepFailure.sandbox_id);
			assert.equal(preGates, 1);
			assert.equal(processBinds, 0, "preparation failure must occur before any body bind");
			assert.equal(internals.active.has(prepFailure.sandbox_id), false);

			internals.resolveWorkerRuntime = originalResolve;
			internals.recordDurableAgentBodyExit = async (active, code) => {
				cleanupEntered();
				await cleanupReleased;
				await originalRecordBodyExit(active, code);
			};
			const bindFailure = localSpawner.enqueue({
				template: "bare",
				preSpawnGate: async () => {
					preGates += 1;
				},
				onProcessSpawn: async ({ sandboxId }) => {
					processBinds += 1;
					assert.equal(internals.active.get(sandboxId)?.bodyBound, false);
					throw new Error("durable child bind lost to cancellation");
				},
			});
			await waitForTerminal(localStore, bindFailure.sandbox_id);
			await enteredCleanup;
			let attemptSettled = false;
			const launchAttempt = localSpawner.awaitSpawnAttempt(bindFailure.sandbox_id).then(() => {
				attemptSettled = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 5));
			assert.equal(attemptSettled, false, "generic terminal cannot overtake verified launch cleanup");
			assert.equal(internals.active.has(bindFailure.sandbox_id), true);
			releaseCleanup();
			await launchAttempt;
			assert.equal(preGates, 2);
			assert.equal(processBinds, 1);
			assert.equal(internals.active.has(bindFailure.sandbox_id), false);
			assert.equal(localStore.get(bindFailure.sandbox_id)?.state, "error");
		} finally {
			releaseCleanup();
			internals.resolveWorkerRuntime = originalResolve;
			internals.recordDurableAgentBodyExit = originalRecordBodyExit;
			await localSpawner.shutdownAll();
			localStore.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("settles an actual pre-spawn OS error without binding or fabricating an Agent body", async () => {
		const directory = mkdtempSync(join(tmpdir(), "spawner-os-spawn-error-"));
		const localStore = new SandboxStore(join(directory, "sandboxes.sqlite"));
		const localSpawner = new SandboxSpawner(
			localStore,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{
				sandboxMode: "local-native",
				exitCleanupGraceMs: 500,
				spawnProcess: (() =>
					spawnChild(join(directory, "definitely-missing-executable"), [], {
						stdio: ["pipe", "pipe", "pipe"],
					})) as typeof spawnChild,
			},
		);
		const internals = localSpawner as unknown as {
			active: Map<string, { bodyBound?: boolean }>;
			resolveWorkerRuntime(sandboxId: string, options: unknown): Promise<unknown>;
		};
		const originalResolve = internals.resolveWorkerRuntime.bind(localSpawner);
		internals.resolveWorkerRuntime = async () => ({
			runtime: process.execPath,
			initMessage: { kind: "init", config: {} },
			keepStdinOpen: true,
			isAgentRun: true,
			isRuntimeRun: false,
			isKernelRun: false,
			agentRequest: {
				session_id: "ags-os-spawn-error",
				generation: 0,
				runtime_binding: { kind: "prime" },
			},
		});
		let gates = 0;
		let binds = 0;
		const startedAt = Date.now();
		try {
			const queued = localSpawner.enqueue({
				template: "bare",
				preSpawnGate: async () => {
					gates += 1;
				},
				onProcessSpawn: async () => {
					binds += 1;
				},
			});
			await waitForTerminal(localStore, queued.sandbox_id);
			await eventually(() => !internals.active.has(queued.sandbox_id), "pre-spawn error retained active identity");
			assert.equal(gates, 1);
			assert.equal(binds, 0, "an OS spawn error cannot bind Agent materialization/body testimony");
			assert.equal(localStore.get(queued.sandbox_id)?.state, "error");
			assert.ok(Date.now() - startedAt < 2_000, "pre-spawn close should not wait signal kill grace periods");
		} finally {
			internals.resolveWorkerRuntime = originalResolve;
			await localSpawner.shutdownAll();
			localStore.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("keeps kernel testimony empty when the wrapper OS process never spawns", async () => {
		const directory = mkdtempSync(join(tmpdir(), "spawner-kernel-os-spawn-error-"));
		const localStore = new SandboxStore(join(directory, "sandboxes.sqlite"));
		const localBus = createSandboxEventBus(localStore, { cleanupDelayMs: 0 });
		let kernelWrites = 0;
		let launchIntents = 0;
		let launchBinds = 0;
		let unboundFailures = 0;
		const localSpawner = new SandboxSpawner(
			localStore,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{
				sandboxMode: "local-native",
				eventBus: localBus,
				workflowRuntime: {
					async beginAgentSessionKernelLaunch() {
						launchIntents += 1;
					},
					async bindAgentSessionKernelLaunch() {
						launchBinds += 1;
					},
					async failUnboundAgentSessionKernelLaunch() {
						unboundFailures += 1;
						return true;
					},
					async recordAgentSessionKernelState() {
						kernelWrites += 1;
					},
				} as never,
				familyProjectionPump: { async start() {}, wake() {}, async stop() {} } as never,
				exitCleanupGraceMs: 500,
				spawnProcess: (() =>
					spawnChild(join(directory, "definitely-missing-kernel-executable"), [], {
						stdio: ["pipe", "pipe", "pipe"],
					})) as typeof spawnChild,
			},
		);
		const internals = localSpawner as unknown as {
			active: Map<string, unknown>;
			executionService: {
				acquire(input: Record<string, unknown>): Promise<unknown>;
				getLeaseForSession(sessionId: string): unknown;
			};
			resolveWorkerRuntime(sandboxId: string, options: unknown): Promise<unknown>;
		};
		const originalResolve = internals.resolveWorkerRuntime.bind(localSpawner);
		internals.resolveWorkerRuntime = async () => ({
			runtime: process.execPath,
			initMessage: { kind: "kernel_init", kernel: "python3" },
			keepStdinOpen: true,
			isAgentRun: false,
			isRuntimeRun: false,
			isKernelRun: true,
			kernelRequest: { kernel: "python3" },
		});
		try {
			await assert.rejects(
				internals.executionService.acquire({
					sessionId: "ags-kernel-os-spawn-error",
					agentSandboxId: "sbx-kernel-owner",
					ownerUserId: "raw-kernel-actor",
					generation: 0,
					activationId: "activation-kernel-os-spawn-error",
				}),
				/failed to start|ENOENT/i,
			);
			await eventually(() => internals.active.size === 0, "kernel OS spawn error retained active identity");
			assert.equal(kernelWrites, 0, "zero-body kernel launch cannot emit fault testimony");
			assert.equal(launchIntents, 1, "the exact kernel sandbox is reserved before OS spawn");
			assert.equal(launchBinds, 0, "an OS ENOENT never crosses the durable body-bind boundary");
			assert.equal(unboundFailures, 1, "verified OS failure terminalizes only the launch intent");
			assert.equal(internals.executionService.getLeaseForSession("ags-kernel-os-spawn-error"), undefined);
		} finally {
			internals.resolveWorkerRuntime = originalResolve;
			await localSpawner.shutdownAll();
			localStore.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("reaps a spawned kernel wrapper whose durable body bind loses without inventing kernel testimony", async () => {
		const directory = mkdtempSync(join(tmpdir(), "spawner-kernel-bind-loss-"));
		const localStore = new SandboxStore(join(directory, "sandboxes.sqlite"));
		const localBus = createSandboxEventBus(localStore, { cleanupDelayMs: 0 });
		let launchIntents = 0;
		let launchBinds = 0;
		let unboundFailures = 0;
		let kernelWrites = 0;
		let cleanupEntered!: () => void;
		let releaseCleanup!: () => void;
		const enteredCleanup = new Promise<void>((resolve) => {
			cleanupEntered = resolve;
		});
		const cleanupReleased = new Promise<void>((resolve) => {
			releaseCleanup = resolve;
		});
		const localSpawner = new SandboxSpawner(
			localStore,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{
				sandboxMode: "local-native",
				eventBus: localBus,
				workflowRuntime: {
					async beginAgentSessionKernelLaunch() {
						launchIntents += 1;
					},
					async bindAgentSessionKernelLaunch() {
						launchBinds += 1;
						throw new Error("kernel launch bind CAS lost");
					},
					async failUnboundAgentSessionKernelLaunch() {
						unboundFailures += 1;
						return true;
					},
					async recordAgentSessionKernelState() {
						kernelWrites += 1;
					},
				} as never,
				familyProjectionPump: { async start() {}, wake() {}, async stop() {} } as never,
				exitCleanupGraceMs: 500,
				spawnProcess: ((_runtime, _args, options) =>
					spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options)) as typeof spawnChild,
			},
		);
		const internals = localSpawner as unknown as {
			active: Map<string, unknown>;
			executionService: { acquire(input: Record<string, unknown>): Promise<unknown> };
			resolveWorkerRuntime(sandboxId: string, options: unknown): Promise<unknown>;
			recordDurableAgentBodyExit(active: unknown, code: number | null): Promise<void>;
		};
		const originalResolve = internals.resolveWorkerRuntime.bind(localSpawner);
		const originalRecordBodyExit = internals.recordDurableAgentBodyExit.bind(localSpawner);
		internals.resolveWorkerRuntime = async () => ({
			runtime: process.execPath,
			initMessage: { kind: "kernel_init", kernel: "python3" },
			keepStdinOpen: true,
			isAgentRun: false,
			isRuntimeRun: false,
			isKernelRun: true,
			kernelRequest: { kernel: "python3" },
		});
		internals.recordDurableAgentBodyExit = async (active, code) => {
			cleanupEntered();
			await cleanupReleased;
			await originalRecordBodyExit(active, code);
		};
		try {
			const acquiring = internals.executionService.acquire({
				sessionId: "ags-kernel-bind-loss",
				agentSandboxId: "sbx-kernel-owner",
				ownerUserId: "raw-kernel-actor",
				generation: 0,
				activationId: "activation-kernel-bind-loss",
			});
			await enteredCleanup;
			assert.equal(unboundFailures, 0, "failed_unbound must wait for verified wrapper cleanup");
			assert.equal(internals.active.size, 1, "cleanup identity remains active while the barrier is held");
			releaseCleanup();
			await assert.rejects(acquiring, /bind CAS lost|failed to start/i);
			await eventually(() => internals.active.size === 0, "unbound spawned kernel retained physical identity");
			assert.equal(launchIntents, 1);
			assert.equal(launchBinds, 1, "the OS spawn event reaches the awaited durable bind");
			assert.equal(unboundFailures, 1, "verified reap terminalizes the unbound launch attempt");
			assert.equal(kernelWrites, 0, "a failed body bind cannot emit kernel body testimony");
		} finally {
			releaseCleanup();
			internals.resolveWorkerRuntime = originalResolve;
			internals.recordDurableAgentBodyExit = originalRecordBodyExit;
			await localSpawner.shutdownAll();
			localStore.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("cancels a real post-bind kernel before readiness with the exact terminal intent", async () => {
		const directory = mkdtempSync(join(tmpdir(), "spawner-kernel-post-bind-cancel-"));
		const localStore = new SandboxStore(join(directory, "sandboxes.sqlite"));
		const localBus = createSandboxEventBus(localStore, { cleanupDelayMs: 0 });
		let launchIntents = 0;
		let launchBinds = 0;
		let unboundFailures = 0;
		const kernelStates: string[] = [];
		let bindEntered!: () => void;
		const bound = new Promise<void>((resolve) => {
			bindEntered = resolve;
		});
		const localSpawner = new SandboxSpawner(
			localStore,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{
				sandboxMode: "local-native",
				eventBus: localBus,
				workflowRuntime: {
					async beginAgentSessionKernelLaunch() {
						launchIntents += 1;
					},
					async bindAgentSessionKernelLaunch() {
						launchBinds += 1;
						bindEntered();
					},
					async failUnboundAgentSessionKernelLaunch() {
						unboundFailures += 1;
						return true;
					},
					async recordAgentSessionKernelState(_sessionId: string, _generation: number, input: { state: string }) {
						kernelStates.push(input.state);
					},
				} as never,
				familyProjectionPump: { async start() {}, wake() {}, async stop() {} } as never,
				killTermGraceMs: 100,
				killForceGraceMs: 100,
				exitCleanupGraceMs: 1_000,
				spawnProcess: ((_runtime, _args, options) =>
					spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options)) as typeof spawnChild,
			},
		);
		const internals = localSpawner as unknown as {
			active: Map<string, unknown>;
			executionService: {
				acquire(input: Record<string, unknown>): Promise<unknown>;
				reapSessionAcquisition(
					sessionId: string,
					generation: number,
					activationId: string,
					terminalState: "cancelled",
				): Promise<boolean>;
				getLeaseForSession(sessionId: string): unknown;
			};
			resolveWorkerRuntime(sandboxId: string, options: unknown): Promise<unknown>;
		};
		const originalResolve = internals.resolveWorkerRuntime.bind(localSpawner);
		internals.resolveWorkerRuntime = async () => ({
			runtime: process.execPath,
			initMessage: { kind: "kernel_init", kernel: "python3" },
			keepStdinOpen: true,
			isAgentRun: false,
			isRuntimeRun: false,
			isKernelRun: true,
			kernelRequest: { kernel: "python3" },
		});
		const sessionId = "ags-kernel-post-bind-cancel";
		const activationId = "activation-kernel-post-bind-cancel";
		try {
			const acquiring = internals.executionService.acquire({
				sessionId,
				agentSandboxId: "sbx-kernel-post-bind-owner",
				ownerUserId: "raw-kernel-actor",
				generation: 0,
				activationId,
			});
			await bound;
			const reaped = await internals.executionService.reapSessionAcquisition(
				sessionId,
				0,
				activationId,
				"cancelled",
			);
			await assert.rejects(acquiring, /failed (?:before readiness|to start)|fenced|cancel/i);
			assert.equal(reaped, true);
			assert.equal(launchIntents, 1);
			assert.equal(launchBinds, 1, "observed OS spawn durably bound the one kernel body");
			assert.equal(unboundFailures, 0, "a bound body cannot be rewritten as failed_unbound");
			assert.deepEqual(kernelStates, ["cancelled"]);
			assert.equal(internals.executionService.getLeaseForSession(sessionId), undefined);
			assert.equal(internals.active.size, 0, "cancel waits for exact wrapper and cgroup reap");
		} finally {
			internals.resolveWorkerRuntime = originalResolve;
			await localSpawner.shutdownAll();
			localStore.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("reclassifies a lingering kernel launch after startup physical cleanup before materialization recovery", async () => {
		const sessionId = "ags-kernel-startup-launching";
		const workerSandboxId = "sbx-kernel-startup-worker";
		const kernelSandboxId = "sbx-kernel-startup-unbound";
		const activationId = "activation-kernel-startup-launching";
		const calls: string[] = [];
		const internals = spawner as unknown as {
			active: Map<string, unknown>;
			workflowRuntime?: Record<string, unknown>;
			executionService: Record<string, unknown>;
			cleanupAgentSessionChild(input: Record<string, unknown>): Promise<Record<string, unknown>>;
		};
		const previousRuntime = internals.workflowRuntime;
		const previousExecutionService = internals.executionService;
		internals.active.delete(workerSandboxId);
		internals.active.delete(kernelSandboxId);
		internals.workflowRuntime = {
			async readAgentSession(requestedSessionId: string) {
				assert.equal(requestedSessionId, sessionId);
				return { document_json: JSON.stringify({ runtime: { kind: "prime" } }) };
			},
			async failUnboundAgentSessionKernelLaunch(
				requestedSessionId: string,
				generation: number,
				input: Record<string, unknown>,
			) {
				assert.equal(requestedSessionId, sessionId);
				assert.equal(generation, 0);
				assert.equal(input.activationId, activationId);
				assert.equal(input.sandboxId, kernelSandboxId);
				calls.push("fail-unbound-launch");
				return true;
			},
		};
		internals.executionService = {
			async reapForRecovery(requestedSessionId: string, generation: number) {
				assert.equal(requestedSessionId, sessionId);
				assert.equal(generation, 0);
				calls.push("reap-kernel-lease");
			},
		};
		try {
			const cleanup = await internals.cleanupAgentSessionChild({
				phase: "recovery",
				terminalIntent: "faulted",
				reason: "startup stale recovery",
				authority: {
					ownerUserId: "raw-owner",
					graphOwnerPrincipal: "organization:startup-recovery",
					graphId: "graph-startup-recovery",
				},
				claim: {
					materialization: {
						session_id: sessionId,
						generation: 0,
						activation_id: activationId,
						sandbox_id: workerSandboxId,
						state: "running",
						checkpoint_id: null,
					},
					kernel_state: null,
					kernel_launch_state: "launching",
					kernel_launch_sandbox_id: kernelSandboxId,
				},
			});
			assert.deepEqual(calls, ["fail-unbound-launch", "reap-kernel-lease"]);
			assert.deepEqual(cleanup, {
				materializationState: "faulted",
				faultKind: "worker_exit",
				recoverable: false,
			});
		} finally {
			internals.workflowRuntime = previousRuntime;
			internals.executionService = previousExecutionService;
		}
	});

	it("releases a standalone root launch intent after an actual OS spawn error", async () => {
		const directory = mkdtempSync(join(tmpdir(), "spawner-root-os-spawn-error-"));
		const localStore = new SandboxStore(join(directory, "sandboxes.sqlite"));
		const runtime = new WorkflowRuntimeStore(join(directory, "runtime.sqlite"));
		await runtime.init();
		await runtime.createWorkflowInstance({
			runId: "run-root-os-spawn-error",
			workflowName: "root-os-spawn-error",
			graphId: "g1",
			ownerUserId: "raw-root-actor",
			inputs: {},
			startedAt: 1,
		});
		const localBus = createSandboxEventBus(localStore, { cleanupDelayMs: 0 });
		const memory = new AgentMemory(
			SophiaContentStore.fromUrl(new URL("memory/", `file://${directory}/`).toString()),
			runtime,
		);
		const localSpawner = new SandboxSpawner(
			localStore,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{
				sandboxMode: "local-native",
				eventBus: localBus,
				workflowRuntime: runtime,
				agentMemory: memory,
				exitCleanupGraceMs: 500,
				spawnProcess: (() =>
					spawnChild(join(directory, "definitely-missing-root-executable"), [], {
						stdio: ["pipe", "pipe", "pipe"],
					})) as typeof spawnChild,
			},
		);
		const internals = localSpawner as unknown as {
			active: Map<string, { bodyBound?: boolean }>;
			resolveWorkerRuntime(sandboxId: string, options: unknown): Promise<unknown>;
		};
		const originalResolve = internals.resolveWorkerRuntime.bind(localSpawner);
		internals.resolveWorkerRuntime = async () => ({
			runtime: process.execPath,
			initMessage: { kind: "init", config: {} },
			keepStdinOpen: true,
			isAgentRun: true,
			isRuntimeRun: false,
			isKernelRun: false,
			agentRequest: {
				session_id: "ags-root-os-spawn-error",
				generation: 0,
				runtime_binding: { kind: "simple" },
			},
		});
		const semantic = makeTestAgentSemanticBinding({ graphId: "g1", kind: "simple" });
		const baseRunner = makeNodeRunner({
			spawner: localSpawner,
			eventBus: localBus,
			authContext: {
				method: "internal_service",
				userId: "raw-root-actor",
				internalServiceSecret: "local-proof-only",
			},
			ownerUserId: "raw-root-actor",
			mnemosyne: { mcpUrl: "disabled", ownerPrincipal: "organization:root-lab", graphId: "g1" },
			resolveCapabilityGrantPolicy: () => ({ exactTools: { mnemosyne: [] } }),
			onProcessSpawn: ({ spec, sandboxId }) =>
				runtime.bindAgentSandbox(spec.sessionId!, {
					sandboxId,
					generation: spec.sandboxGeneration ?? 0,
					activationId: spec.invocationId!,
					now: Date.now(),
				}),
		});
		const runner = makeRuntimeNodeRunner({
			runtime,
			baseRunner,
			memory,
			runId: "run-root-os-spawn-error",
			workflowName: "root-os-spawn-error",
			graphId: "g1",
			ownerUserId: "raw-root-actor",
			graphOwnerPrincipal: "organization:root-lab",
		});
		try {
			await assert.rejects(
				runner({
					label: "root os spawn failure",
					phaseIndex: 1,
					nodeKey: "root-os-spawn-error",
					sessionId: "ags-root-os-spawn-error",
					prompt: "never reaches a body",
					model: "mock:done",
					graphId: "g1",
					...semantic,
				}),
			);
			await eventually(() => internals.active.size === 0, "root OS spawn error retained active identity");
			assert.equal(await runtime.readAgentMaterialization("ags-root-os-spawn-error", 0), null);
			const session = await runtime.readAgentSession("ags-root-os-spawn-error");
			assert.equal(session?.status, "queued");
			assert.equal(session?.lifecycle_state, "open");
			assert.equal(session?.sandbox_id, null);
			assert.equal(
				(await runtime.listAgentSessionEvents("ags-root-os-spawn-error")).filter((event) =>
					event.type.startsWith("runtime."),
				).length,
				0,
				"a process that never spawned emits no fabricated runtime event",
			);
		} finally {
			internals.resolveWorkerRuntime = originalResolve;
			await localSpawner.shutdownAll();
			runtime.close();
			localStore.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("keeps hosted child body heartbeats single-owned until terminal run handoff", async () => {
		const directory = mkdtempSync(join(tmpdir(), "spawner-heartbeat-owner-"));
		const localStore = new SandboxStore(join(directory, "sandboxes.sqlite"));
		const localSpawner = new SandboxSpawner(
			localStore,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{ sandboxMode: "local-native" },
		);
		let childRunState = "claimed";
		let delayChildRead = false;
		let enterChildRead!: () => void;
		const childReadEntered = new Promise<void>((resolve) => {
			enterChildRead = resolve;
		});
		let releaseChildRead!: () => void;
		const childReadReleased = new Promise<void>((resolve) => {
			releaseChildRead = resolve;
		});
		const heartbeats: string[] = [];
		const internals = localSpawner as unknown as {
			active: Map<string, Record<string, unknown>>;
			workflowRuntime?: {
				readAgentSessionChildRun(childRunId: string): Promise<{ state: string }>;
				readAgentMaterialization(sessionId: string, generation: number): Promise<Record<string, unknown>>;
				heartbeatAgentMaterialization(sessionId: string): Promise<void>;
			};
			heartbeatLiveAgentMaterializations(): Promise<void>;
		};
		internals.workflowRuntime = {
			async readAgentSessionChildRun() {
				if (delayChildRead) {
					enterChildRead();
					await childReadReleased;
				}
				return { state: childRunState };
			},
			async readAgentMaterialization(sessionId) {
				return {
					session_id: sessionId,
					generation: 0,
					sandbox_id: `sbx-${sessionId}`,
					activation_id: `act-${sessionId}`,
					state: "running",
				};
			},
			async heartbeatAgentMaterialization(sessionId) {
				heartbeats.push(sessionId);
			},
		};
		internals.active.set("sbx-root", {
			bodyBound: true,
			isAgentRun: true,
			agentRequest: { session_id: "root", generation: 0 },
			record: { sandbox_id: "sbx-root" },
		});
		internals.active.set("sbx-child", {
			bodyBound: true,
			durableSupervisorExit: true,
			hostedChildRunId: `acr_${"a".repeat(24)}`,
			isAgentRun: true,
			agentRequest: { session_id: "child", generation: 0 },
			record: { sandbox_id: "sbx-child" },
		});
		try {
			await internals.heartbeatLiveAgentMaterializations();
			assert.deepEqual(heartbeats, ["root"]);
			childRunState = "completed";
			delayChildRead = true;
			const delayedHandoff = internals.heartbeatLiveAgentMaterializations();
			await childReadEntered;
			const child = internals.active.get("sbx-child")!;
			child.hostWorkAdmissionClosed = true;
			child.durableSupervisorExit = true;
			releaseChildRead();
			await delayedHandoff;
			assert.deepEqual(heartbeats, ["root", "root"]);
			assert.equal(child.durableSupervisorExit, true, "a late handoff cannot undo cancellation ownership");

			delayChildRead = false;
			child.hostWorkAdmissionClosed = false;
			await internals.heartbeatLiveAgentMaterializations();
			assert.deepEqual(heartbeats, ["root", "root", "root", "child"]);
			assert.equal(internals.active.get("sbx-child")?.durableSupervisorExit, false);
		} finally {
			internals.active.clear();
			internals.workflowRuntime = undefined;
			await localSpawner.shutdownAll();
			localStore.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("serializes the global materialization heartbeat and drains its in-flight write on shutdown", async () => {
		const directory = mkdtempSync(join(tmpdir(), "spawner-heartbeat-shutdown-"));
		const localStore = new SandboxStore(join(directory, "sandboxes.sqlite"));
		let enterHeartbeat!: () => void;
		const heartbeatEntered = new Promise<void>((resolve) => {
			enterHeartbeat = resolve;
		});
		let releaseHeartbeat!: () => void;
		const heartbeatReleased = new Promise<void>((resolve) => {
			releaseHeartbeat = resolve;
		});
		let currentHeartbeats = 0;
		let maxHeartbeats = 0;
		let heartbeatWrites = 0;
		const runtime = {
			async readAgentMaterialization() {
				return {
					session_id: "ags-root-heartbeat-tail",
					generation: 0,
					sandbox_id: "sbx-root-heartbeat-tail",
					activation_id: "activation-root-heartbeat-tail",
					state: "running",
				};
			},
			async heartbeatAgentMaterialization() {
				currentHeartbeats += 1;
				maxHeartbeats = Math.max(maxHeartbeats, currentHeartbeats);
				enterHeartbeat();
				await heartbeatReleased;
				heartbeatWrites += 1;
				currentHeartbeats -= 1;
			},
		};
		const localSpawner = new SandboxSpawner(
			localStore,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{
				sandboxMode: "local-native",
				workflowRuntime: runtime as never,
				familyProjectionPump: { async start() {}, wake() {}, async stop() {} } as never,
			},
		);
		const internals = localSpawner as unknown as {
			active: Map<string, Record<string, unknown>>;
			startMaterializationHeartbeat(): void;
		};
		internals.active.set("sbx-root-heartbeat-tail", {
			bodyBound: true,
			isAgentRun: true,
			record: { sandbox_id: "sbx-root-heartbeat-tail" },
			agentRequest: { session_id: "ags-root-heartbeat-tail", generation: 0 },
		});
		internals.startMaterializationHeartbeat();
		internals.startMaterializationHeartbeat();
		await heartbeatEntered;
		internals.active.clear();
		let shutdownFinished = false;
		const shutdown = localSpawner.shutdownAll().then(() => {
			shutdownFinished = true;
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
		assert.equal(shutdownFinished, false);
		assert.equal(maxHeartbeats, 1, "global heartbeat ticks must never overlap");
		releaseHeartbeat();
		await shutdown;
		assert.equal(heartbeatWrites, 1);
		localStore.close();
		rmSync(directory, { recursive: true, force: true });
	});

	it("coalesces an idle passivation already in flight with child closure preparation", async () => {
		const directory = mkdtempSync(join(tmpdir(), "spawner-passivation-coalesce-"));
		const localStore = new SandboxStore(join(directory, "sandboxes.sqlite"));
		const materialization = {
			session_id: "ags-passivation-coalesce",
			generation: 0,
			sandbox_id: "sbx-passivation-coalesce",
			activation_id: "activation-passivation-coalesce",
			state: "running",
		};
		const runtime = {
			async readAgentMaterialization() {
				return materialization;
			},
		};
		const localSpawner = new SandboxSpawner(
			localStore,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{
				sandboxMode: "local-native",
				workflowRuntime: runtime as never,
				familyProjectionPump: { async start() {}, wake() {}, async stop() {} } as never,
			},
		);
		let releasePassivation!: () => void;
		const passivationReleased = new Promise<void>((resolve) => {
			releasePassivation = resolve;
		});
		let passivations = 0;
		const internals = localSpawner as unknown as {
			active: Map<string, Record<string, unknown>>;
			passivateAgentSession(input: Record<string, unknown>): Promise<Record<string, unknown>>;
			startPassivationTask(input: Record<string, unknown>): Promise<void>;
			cleanupAgentSessionChild(input: Record<string, unknown>): Promise<Record<string, unknown>>;
		};
		const originalPassivate = internals.passivateAgentSession.bind(localSpawner);
		internals.passivateAgentSession = async () => {
			passivations += 1;
			await passivationReleased;
			return { checkpointedKernel: false, liveBodies: 0 };
		};
		internals.active.set(materialization.sandbox_id, {
			isAgentRun: true,
			record: { sandbox_id: materialization.sandbox_id },
			agentRequest: {
				session_id: materialization.session_id,
				generation: 0,
				runtime_binding: {
					kind: "prime",
					bundle: { digest: "sha256:passivation-coalesce" },
				},
			},
		});
		const passivationInput = {
			sessionId: materialization.session_id,
			generation: 0,
			ownerPrincipal: "organization:passivation-lab",
			graphId: "graph-passivation-lab",
			runtimeBundleDigest: "sha256:passivation-coalesce",
		};
		try {
			const idle = internals.startPassivationTask(passivationInput);
			const closure = internals.cleanupAgentSessionChild({
				phase: "prepare_closure",
				materialization,
				authority: {
					graphOwnerPrincipal: "organization:passivation-lab",
					graphId: "graph-passivation-lab",
				},
				reason: "terminal child closure",
			});
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
			assert.equal(passivations, 1);
			releasePassivation();
			assert.deepEqual(await closure, { materializationState: "passivated", kernelState: "shutdown" });
			await idle;
			assert.equal(passivations, 1, "idle and closure must join one materialization CAS");
		} finally {
			releasePassivation();
			internals.passivateAgentSession = originalPassivate;
			internals.active.clear();
			await localSpawner.shutdownAll();
			localStore.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("mints a fresh cloud child graph proxy from durable graph owner and acting-user authority", () => {
		const previousToken = process.env.MNEMOSYNE_SERVICE_TOKEN;
		const previousGateway = process.env.MNEMOSYNE_GATEWAY_BASE_URL;
		const previousDirectUrl = process.env.MNEMOSYNE_MCP_URL;
		const previousDirectToken = process.env.MNEMOSYNE_MCP_ACCESS_TOKEN;
		const previousDirectBearer = process.env.MNEMOSYNE_MCP_BEARER_TOKEN;
		const previousApiToken = process.env.MNEMOSYNE_API_TOKEN;
		const previousGlobalFallback = process.env.MNEMOSYNE_ALLOW_GLOBAL_TOKEN_FALLBACK;
		const internals = spawner as unknown as {
			createHostedMnemosyneProxy(
				sandboxId: string,
				descriptor: Record<string, unknown>,
				opts: Record<string, unknown>,
			): HostedMnemosyneProxy;
		};
		const descriptor = {
			mcp_url: "hosted-proxy",
			tool_profile: "chat",
			graph_scope: {
				mode: "allowlist",
				default_graph_owner: "organization:shared-lab",
				default_graph_id: "graph-child-service-auth",
				allowed_graph_ids: ["graph-child-service-auth"],
				bound_cell: true,
			},
		};
		try {
			process.env.MNEMOSYNE_SERVICE_TOKEN = "pn-service-child-secret";
			process.env.MNEMOSYNE_GATEWAY_BASE_URL = "https://api.garden.example.invalid";
			process.env.MNEMOSYNE_MCP_URL = "http://poisoned-parent-direct.invalid/mcp";
			delete process.env.MNEMOSYNE_MCP_ACCESS_TOKEN;
			delete process.env.MNEMOSYNE_MCP_BEARER_TOKEN;
			process.env.MNEMOSYNE_API_TOKEN = "poisoned-global-api-token";
			process.env.MNEMOSYNE_ALLOW_GLOBAL_TOKEN_FALLBACK = "true";
			const first = internals.createHostedMnemosyneProxy("sbx-child-1", descriptor, {
				ownerUserId: "raw-cognito-actor",
				requireGatewayServiceAuth: true,
				authContext: { method: "delegated_bearer", bearerToken: "poisoned-parent-bearer" },
				mnemosyne: { capabilities: { reads: true, writes: false, dangerous_ops: false } },
			});
			const second = internals.createHostedMnemosyneProxy("sbx-child-2", descriptor, {
				ownerUserId: "raw-cognito-actor",
				requireGatewayServiceAuth: true,
				mnemosyne: { capabilities: { reads: true, writes: false, dangerous_ops: false } },
			});
			assert.notEqual(first, second, "each hosted child receives a fresh graph proxy/backend");
			const proxy = first as unknown as {
				ownerPrincipal: string;
				graphId: string;
				authContext?: unknown;
				apiToken?: string;
				allowGlobalTokenFallback: boolean;
				directMcp?: unknown;
				preferredMcpUrl?: string;
				apiBaseUrl: string;
				serviceAuth: HostedServiceAuthConfig;
				buildServiceSession(auth: HostedServiceAuthConfig): {
					mcpUrl: string;
					accessToken: string;
					userId: string;
				};
			};
			assert.equal(proxy.ownerPrincipal, "organization:shared-lab");
			assert.equal(proxy.graphId, "graph-child-service-auth");
			assert.equal(proxy.authContext, undefined, "no parent bearer/auth context may cross into the child proxy");
			assert.equal(proxy.apiToken, undefined);
			assert.equal(proxy.directMcp, undefined);
			assert.equal(proxy.allowGlobalTokenFallback, false);
			assert.equal(proxy.preferredMcpUrl, undefined);
			assert.equal(proxy.apiBaseUrl, "https://api.garden.example.invalid");
			assert.deepEqual(proxy.serviceAuth, {
				serviceToken: "pn-service-child-secret",
				gatewayBaseUrl: "https://api.garden.example.invalid",
				onBehalfOf: "raw-cognito-actor",
			});
			const session = proxy.buildServiceSession(proxy.serviceAuth);
			assert.equal(
				session.mcpUrl,
				"https://api.garden.example.invalid/o/organization%3Ashared-lab/g/graph-child-service-auth/mcp",
			);
			assert.equal(session.accessToken, "pn-service-child-secret");
			assert.equal(session.userId, "raw-cognito-actor");

			delete process.env.MNEMOSYNE_SERVICE_TOKEN;
			assert.throws(
				() =>
					internals.createHostedMnemosyneProxy("sbx-child-denied", descriptor, {
						ownerUserId: "raw-cognito-actor",
						requireGatewayServiceAuth: true,
					}),
				/durable cloud supervisor graph access requires gateway service auth/,
			);
		} finally {
			if (previousToken === undefined) delete process.env.MNEMOSYNE_SERVICE_TOKEN;
			else process.env.MNEMOSYNE_SERVICE_TOKEN = previousToken;
			if (previousGateway === undefined) delete process.env.MNEMOSYNE_GATEWAY_BASE_URL;
			else process.env.MNEMOSYNE_GATEWAY_BASE_URL = previousGateway;
			if (previousDirectUrl === undefined) delete process.env.MNEMOSYNE_MCP_URL;
			else process.env.MNEMOSYNE_MCP_URL = previousDirectUrl;
			if (previousDirectToken === undefined) delete process.env.MNEMOSYNE_MCP_ACCESS_TOKEN;
			else process.env.MNEMOSYNE_MCP_ACCESS_TOKEN = previousDirectToken;
			if (previousDirectBearer === undefined) delete process.env.MNEMOSYNE_MCP_BEARER_TOKEN;
			else process.env.MNEMOSYNE_MCP_BEARER_TOKEN = previousDirectBearer;
			if (previousApiToken === undefined) delete process.env.MNEMOSYNE_API_TOKEN;
			else process.env.MNEMOSYNE_API_TOKEN = previousApiToken;
			if (previousGlobalFallback === undefined) delete process.env.MNEMOSYNE_ALLOW_GLOBAL_TOKEN_FALLBACK;
			else process.env.MNEMOSYNE_ALLOW_GLOBAL_TOKEN_FALLBACK = previousGlobalFallback;
		}
	});

	it("uses exact direct MCP auth when the legacy API base is explicitly disabled", () => {
		const previousToken = process.env.MNEMOSYNE_SERVICE_TOKEN;
		const previousGateway = process.env.MNEMOSYNE_GATEWAY_BASE_URL;
		const previousDirectUrl = process.env.MNEMOSYNE_MCP_URL;
		const previousDirectToken = process.env.MNEMOSYNE_MCP_ACCESS_TOKEN;
		const previousApiBase = process.env.MNEMOSYNE_API_BASE_URL;
		const previousApiToken = process.env.MNEMOSYNE_API_TOKEN;
		const previousGlobalFallback = process.env.MNEMOSYNE_ALLOW_GLOBAL_TOKEN_FALLBACK;
		const internals = spawner as unknown as {
			createHostedMnemosyneProxy(
				sandboxId: string,
				descriptor: Record<string, unknown>,
				opts: Record<string, unknown>,
			): HostedMnemosyneProxy;
		};
		const descriptor = {
			mcp_url: "http://host.lima.internal:7090/mcp",
			tool_profile: "chat",
			graph_scope: {
				mode: "allowlist",
				default_graph_owner: "user:local-owner",
				default_graph_id: "local-graph",
				allowed_graph_ids: ["local-graph"],
				bound_cell: true,
			},
		};
		try {
			process.env.MNEMOSYNE_SERVICE_TOKEN = "";
			process.env.MNEMOSYNE_GATEWAY_BASE_URL = "";
			process.env.MNEMOSYNE_API_BASE_URL = "";
			process.env.MNEMOSYNE_MCP_URL = "http://host.lima.internal:7090/mcp";
			process.env.MNEMOSYNE_MCP_ACCESS_TOKEN = "local-loopback-token";
			process.env.MNEMOSYNE_API_TOKEN = "poisoned-global-api-token";
			process.env.MNEMOSYNE_ALLOW_GLOBAL_TOKEN_FALLBACK = "true";

			const proxy = internals.createHostedMnemosyneProxy("sbx-local-direct", descriptor, {
				ownerUserId: "local-owner",
				authContext: { method: "delegated_bearer", bearerToken: "poisoned-parent-bearer" },
				mnemosyne: {
					apiBaseUrl: "",
					mcpUrl: "http://host.lima.internal:7090/mcp",
					capabilities: { reads: true, writes: false, dangerous_ops: false },
				},
			}) as unknown as {
				apiBaseUrl: string;
				directMcp: { mcpUrl: string; accessToken: string; userId?: string };
			};

			assert.equal(proxy.apiBaseUrl, "http://host.lima.internal:7090/mcp");
			assert.deepEqual(proxy.directMcp, {
				mcpUrl: "http://host.lima.internal:7090/mcp",
				accessToken: "local-loopback-token",
				userId: "local-owner",
			});
		} finally {
			if (previousToken === undefined) delete process.env.MNEMOSYNE_SERVICE_TOKEN;
			else process.env.MNEMOSYNE_SERVICE_TOKEN = previousToken;
			if (previousGateway === undefined) delete process.env.MNEMOSYNE_GATEWAY_BASE_URL;
			else process.env.MNEMOSYNE_GATEWAY_BASE_URL = previousGateway;
			if (previousDirectUrl === undefined) delete process.env.MNEMOSYNE_MCP_URL;
			else process.env.MNEMOSYNE_MCP_URL = previousDirectUrl;
			if (previousDirectToken === undefined) delete process.env.MNEMOSYNE_MCP_ACCESS_TOKEN;
			else process.env.MNEMOSYNE_MCP_ACCESS_TOKEN = previousDirectToken;
			if (previousApiBase === undefined) delete process.env.MNEMOSYNE_API_BASE_URL;
			else process.env.MNEMOSYNE_API_BASE_URL = previousApiBase;
			if (previousApiToken === undefined) delete process.env.MNEMOSYNE_API_TOKEN;
			else process.env.MNEMOSYNE_API_TOKEN = previousApiToken;
			if (previousGlobalFallback === undefined) delete process.env.MNEMOSYNE_ALLOW_GLOBAL_TOKEN_FALLBACK;
			else process.env.MNEMOSYNE_ALLOW_GLOBAL_TOKEN_FALLBACK = previousGlobalFallback;
		}
	});

	it("resets and replays a mismatched snapshot on the same kernel lease and body identity", async () => {
		const leaseId = "kls-same-generation-replay";
		const kernelSandboxId = "sbx-same-generation-kernel";
		const sessionId = "ags-same-generation-replay";
		const activationId = "act-same-generation-replay";
		const runtimeBundleDigest = `sha256:${"b".repeat(64)}`;
		const journalHeadDigest = `sha256:${"c".repeat(64)}`;
		const executeCalls: Array<{ leaseId: string; code: string }> = [];
		const replayLeaseIds: string[] = [];
		const events: Array<Record<string, unknown>> = [];
		let faultCalls = 0;
		const internals = spawner as unknown as {
			workflowRuntime?: Record<string, unknown>;
			agentMemory?: Record<string, unknown>;
			executionService: Record<string, unknown>;
			restoredKernelLeases: Set<string>;
			restoreKernelForGeneration(
				request: Record<string, unknown>,
				active: Record<string, unknown>,
				acquired: { leaseId: string; kernelSandboxId: string; expiresAt: number },
				bootstrapCode: string,
			): Promise<{ leaseId: string; kernelSandboxId: string; expiresAt: number }>;
		};
		const previousRuntime = internals.workflowRuntime;
		const previousMemory = internals.agentMemory;
		const previousExecutionService = internals.executionService;
		internals.workflowRuntime = {
			async listExecutionJournal() {
				return [{ cellDigest: journalHeadDigest, cellRef: "compute.cell:same-lease:0" }];
			},
			async readLatestKernelReplayWitness() {
				return { generation: 0, journalHeadDigest, namespace: ["answer"] };
			},
			async readLatestKernelCheckpoint() {
				return {
					manifest: { generation: 0, runtimeBundleDigest, journalHeadDigest },
					object: { kind: "agent-checkpoint", id: "checkpoint:same-lease" },
				};
			},
			async appendAgentSessionEventForGeneration(
				_sessionId: string,
				_generation: number,
				_activationId: string,
				event: Record<string, unknown>,
			) {
				events.push(event);
			},
		};
		internals.agentMemory = {
			async restoreKernelSnapshot() {
				return { snapshot: "opaque-snapshot" };
			},
		};
		internals.executionService = {
			getLease(requestedLeaseId: string) {
				assert.equal(requestedLeaseId, leaseId);
				return { leaseId, sessionId, activationId };
			},
			async restoreSnapshot(requestedLeaseId: string) {
				assert.equal(requestedLeaseId, leaseId);
				return { status: "restored", namespace: ["answer", "os"] };
			},
			async execute(requestedLeaseId: string, code: string) {
				executeCalls.push({ leaseId: requestedLeaseId, code });
				return { status: "ok" };
			},
			async replayJournal(requestedLeaseId: string) {
				replayLeaseIds.push(requestedLeaseId);
				return { status: "restored", namespace: ["answer"] };
			},
			async fault() {
				faultCalls += 1;
			},
		};
		try {
			internals.restoredKernelLeases.delete(leaseId);
			const acquired = { leaseId, kernelSandboxId, expiresAt: 10_000 };
			const restored = await internals.restoreKernelForGeneration(
				{ name: "kernel.request", sessionId, generation: 1 },
				{
					agentRequest: { runtime_binding: { bundle: { digest: runtimeBundleDigest } } },
				},
				acquired,
				"bootstrap_runtime()",
			);
			assert.deepEqual(restored, acquired);
			assert.deepEqual(executeCalls, [
				{ leaseId, code: "%reset -f" },
				{ leaseId, code: "bootstrap_runtime()" },
			]);
			assert.deepEqual(replayLeaseIds, [leaseId]);
			assert.equal(faultCalls, 0);
			assert.equal(internals.restoredKernelLeases.has(leaseId), true);
			assert.deepEqual(events, [
				{
					type: "runtime.resumed",
					payload: {
						generation: 1,
						method: "journal",
						replay: { status: "restored", namespace: ["answer"] },
						snapshotFailure: "snapshot namespace differs from the journal witness",
					},
				},
			]);
		} finally {
			internals.restoredKernelLeases.delete(leaseId);
			internals.workflowRuntime = previousRuntime;
			internals.agentMemory = previousMemory;
			internals.executionService = previousExecutionService;
		}
	});

	it("retries paired-worker cleanup after an unexpected kernel exit before materialization settlement", async () => {
		const sandboxId = "sbx-kernel-pair-retry";
		let killAttempts = 0;
		const kernelStates: string[] = [];
		let materializationFinishes = 0;
		const internals = spawner as unknown as {
			active: Map<string, Record<string, unknown>>;
			workflowRuntime?: {
				recordAgentSessionKernelState(): Promise<void>;
				readAgentMaterialization(): Promise<Record<string, unknown>>;
				finishAgentMaterialization(): Promise<void>;
			};
			killProcess(sandboxId: string, reason: string): Promise<void>;
			handleUnexpectedKernelExit(input: Record<string, unknown>): Promise<void>;
		};
		const previousRuntime = internals.workflowRuntime;
		const originalKill = internals.killProcess.bind(spawner);
		internals.active.set(sandboxId, {
			isAgentRun: true,
			durableSupervisorExit: false,
			agentRequest: { session_id: "ags-kernel-pair-retry", generation: 0 },
			record: { sandbox_id: sandboxId, state: "running" },
		});
		internals.workflowRuntime = {
			async recordAgentSessionKernelState() {
				kernelStates.push("faulted");
			},
			async readAgentMaterialization() {
				return {
					session_id: "ags-kernel-pair-retry",
					generation: 0,
					sandbox_id: sandboxId,
					activation_id: "activation-pair-retry",
					state: "running",
					checkpoint_id: null,
				};
			},
			async finishAgentMaterialization() {
				materializationFinishes += 1;
			},
		};
		internals.killProcess = async (target) => {
			assert.equal(target, sandboxId);
			killAttempts += 1;
			if (killAttempts === 1) throw new Error("worker cgroup still populated");
			internals.active.delete(sandboxId);
		};
		const input = {
			leaseId: "kls-pair-retry",
			sessionId: "ags-kernel-pair-retry",
			generation: 0,
			activationId: "activation-pair-retry",
			agentSandboxId: sandboxId,
			kernelSandboxId: "sbx-kernel-wrapper-reaped",
			exitCode: 9,
			signal: "SIGKILL",
		};
		try {
			await internals.handleUnexpectedKernelExit(input);
			assert.equal(internals.active.has(sandboxId), true);
			assert.equal(materializationFinishes, 0, "a live paired worker forbids terminal materialization testimony");
			assert.deepEqual(kernelStates, ["faulted"], "the already-reaped kernel may be testified independently");
			await internals.handleUnexpectedKernelExit(input);
			assert.equal(internals.active.has(sandboxId), false);
			assert.equal(materializationFinishes, 1);
			assert.equal(killAttempts, 2);
		} finally {
			internals.active.delete(sandboxId);
			internals.workflowRuntime = previousRuntime;
			internals.killProcess = originalKill;
		}
	});

	it(
		"rejects a runtime binding whose bundle digest does not attest the local source before queueing",
		{ skip: SOPHIA_RUNTIME_SKIP },
		() => {
			const semantic = makeTestAgentSemanticBinding({ registeredName: "stale-runtime-agent" });
			const before = store.list().length;
			assert.throws(
				() =>
					spawner.enqueue({
						template: "agent",
						worker_config: {
							mode: "agent",
							model: "mock:done",
							provider: "openrouter",
							session_id: "session-stale-runtime",
							generation: 0,
							agent_id: semantic.agentId,
							runtime_binding: semantic.runtime,
							runtime_binding_digest: semantic.runtimeBindingDigest,
							agent_ontology: semantic.ontology,
							agent_ontology_binding_digest: semantic.ontologyBindingDigest,
						},
					}),
				/runtime artifact digest mismatch/,
			);
			assert.equal(store.list().length, before);
		},
	);

	it(
		"emits spawn, terminal LLM usage, parsed turn completion, and canonical reap from the Sophia runtime",
		{ skip: SOPHIA_RUNTIME_SKIP },
		async () => {
			const semantic = makeTestAgentSemanticBinding({
				registeredName: "observatory-agent",
				bundleDigest: SOPHIA_RUNTIME_DIGEST,
			});
			const captureStart = capture.events.length;
			const wireStart = wireOutput.length;
			const running = await spawner.spawn({
				template: "agent",
				ownerUserId: "user-alpha-0001",
				authContext: {
					method: "internal_service",
					userId: "user-alpha-0001",
					internalServiceSecret: "not-emitted",
				},
				mnemosyne: { graphId: "organism-dev" },
				worker_config: {
					mode: "agent",
					model: "mock:done",
					session_id: "session-observatory-agent",
					generation: 0,
					agent_id: semantic.agentId,
					runtime_binding: semantic.runtime,
					runtime_binding_digest: semantic.runtimeBindingDigest,
					agent_ontology: semantic.ontology,
					agent_ontology_binding_digest: semantic.ontologyBindingDigest,
					tool_mode: "none",
				},
			});
			await waitForTerminal(store, running.sandbox_id);

			const ownEvents = capture.events.slice(captureStart);
			assert.deepEqual(
				ownEvents.map((event) => event.kind),
				["sandbox.spawn", "llm.call", "agent.turn", "sandbox.reap"],
			);
			for (const event of ownEvents) {
				assert.equal(event.principal, "service:choreograph");
				assert.equal(event.onBehalfOf, "user-alpha-0001");
				assert.equal(event.graphId, "organism-dev");
			}

			const llm = ownEvents.find((event) => event.kind === "llm.call");
			assert.ok(llm?.kind === "llm.call");
			assert.equal(llm.payload.model, "mock:done");
			assert.equal(typeof llm.payload.totalTokens, "number");
			assert.equal("prompt" in llm.payload, false);
			assert.equal("result" in llm.payload, false);

			const turns = ownEvents.filter((event) => event.kind === "agent.turn");
			assert.deepEqual(
				turns.map((turn) => turn.payload.stepIndex),
				[0],
			);
			assert.ok(turns.every((turn) => typeof turn.payload.toolCount === "number"));

			const reap = ownEvents.find((event) => event.kind === "sandbox.reap");
			assert.ok(reap?.kind === "sandbox.reap");
			assert.equal(reap.payload.reason, "completed");
			assert.equal(
				reap.payload.exitCode ?? 0,
				0,
				`a semantically completed local worker cannot report a nonzero exit code (${reap.payload.exitCode})`,
			);

			assert.equal(await wireWriter.whenIdle(), true);
			const wire = wireOutput.slice(wireStart);
			const records = wire
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			assert.deepEqual(
				records.map((record) => record.kind),
				["sandbox.spawn", "llm.call", "agent.turn", "sandbox.reap"],
			);
			assert.deepEqual(
				records.map((record) => record.v),
				[1, 1, 1, 1],
			);
			assert.deepEqual(
				records.map((record) => record.seq),
				[0, 1, 2, 3],
			);
			assert.ok(records.every((record) => record.principal === "service:choreograph"));
			assert.ok(records.every((record) => record.on_behalf_of === "user-alpha-0001"));
			assert.ok(records.every((record) => record.graph_id === "organism-dev"));
		},
	);

	it(
		"routes a real kernel comm request directly through the exact host capability grant",
		{ skip: KERNEL_RUNTIME_SKIP },
		async () => {
			const semantic = makeTestAgentSemanticBinding({
				kind: "prime",
				registeredName: "kernel-capability-agent",
				bundleDigest: SOPHIA_RUNTIME_DIGEST,
			});
			let backendCalls = 0;
			const backend: CapabilityBackend = {
				capabilityName: "mnemosyne",
				accessLevel: "ro",
				async listTools() {
					return [{ name: "search_documents", destructive: false }];
				},
				async callTool(tool, args) {
					backendCalls += 1;
					assert.equal(tool, "search_documents");
					assert.deepEqual(args, { query: "kernel capability lane" });
					return { documents: ["doc-from-host-gate"] };
				},
				async close() {},
			};
			const running = await spawner.spawn({
				template: "agent",
				ownerUserId: "user-kernel-capability",
				authContext: {
					method: "internal_service",
					userId: "user-kernel-capability",
					internalServiceSecret: "not-emitted",
				},
				mnemosyne: { graphId: "kernel-capability-graph" },
				capabilityBackends: new Map([["mnemosyne", backend]]),
				capabilityGrantPolicy: { exactTools: { mnemosyne: ["search_documents"] } },
				worker_config: {
					mode: "agent",
					model: "mock:ipython_capability",
					session_id: "session-kernel-capability",
					generation: 0,
					agent_id: semantic.agentId,
					runtime_binding: semantic.runtime,
					runtime_binding_digest: semantic.runtimeBindingDigest,
					agent_ontology: semantic.ontology,
					agent_ontology_binding_digest: semantic.ontologyBindingDigest,
					tool_mode: "none",
				},
			});
			const events: BusEvent[] = [];
			const unsubscribe = eventBus.subscribe(
				(event) => {
					if (event.category === "system" && event.type === "snapshot") events.push(...event.recent_events);
					else events.push(event);
				},
				{ sandbox_id: running.sandbox_id },
			);
			try {
				await waitForTerminal(store, running.sandbox_id);
			} finally {
				unsubscribe();
			}

			assert.equal(store.get(running.sandbox_id)?.state, "done");
			assert.equal(backendCalls, 1);
			const capability = events.find(
				(event) =>
					event.category === "capability" && event.type === "call" && event.operation === "search_documents",
			);
			assert.ok(capability && capability.category === "capability");
			assert.equal(capability.outcome, "ok");
			const denied = events.find(
				(event) => event.category === "capability" && event.type === "call" && event.operation === "remember",
			);
			assert.ok(denied && denied.category === "capability");
			assert.equal(denied.outcome, "denied");
			const cell = events.find((event) => event.category === "execution" && event.type === "compute.cell");
			assert.ok(cell && cell.category === "execution");
			assert.match(JSON.stringify(cell.cell.outputs), /doc-from-host-gate/);
			assert.match(JSON.stringify(cell.cell.outputs), /capability_denied/);
		},
	);

	it(
		"fails closed when a schema-bound Sophia runtime naturally stops without submit",
		{ skip: SOPHIA_RUNTIME_SKIP },
		async () => {
			const semantic = makeTestAgentSemanticBinding({
				registeredName: "schema-agent",
				bundleDigest: SOPHIA_RUNTIME_DIGEST,
			});
			let terminal: Extract<BusEvent, { type: "terminal" }> | undefined;
			const captureStart = capture.events.length;
			const running = await spawner.spawn({
				template: "agent",
				ownerUserId: "user-schema-contract",
				authContext: {
					method: "internal_service",
					userId: "user-schema-contract",
					internalServiceSecret: "not-emitted",
				},
				mnemosyne: { graphId: "organism-dev" },
				worker_config: {
					mode: "agent",
					model: "mock:text",
					session_id: "session-schema-agent",
					generation: 0,
					agent_id: semantic.agentId,
					runtime_binding: semantic.runtime,
					runtime_binding_digest: semantic.runtimeBindingDigest,
					agent_ontology: semantic.ontology,
					agent_ontology_binding_digest: semantic.ontologyBindingDigest,
					tool_mode: "none",
					output_schema: {
						type: "object",
						properties: { answer: { type: "string" } },
						required: ["answer"],
						additionalProperties: false,
					},
				},
			});
			const unsubscribe = eventBus.subscribe(
				(event) => {
					if (
						event.category === "lifecycle" &&
						event.type === "terminal" &&
						event.sandbox_id === running.sandbox_id
					) {
						terminal = event;
					}
				},
				{ sandbox_id: running.sandbox_id },
			);
			try {
				await waitForTerminal(store, running.sandbox_id);
			} finally {
				unsubscribe();
			}

			const final = store.get(running.sandbox_id);
			assert.equal(final?.state, "error");
			assert.equal(final?.exit_code, 0, "the worker reports a semantic error while still exiting cleanly");
			assert.equal(terminal?.result?.status, "error");
			assert.equal(
				terminal?.result?.output,
				"Prime stopped without calling submit() for the required structured result.",
			);

			const reap = capture.events.slice(captureStart).find((event) => event.kind === "sandbox.reap");
			assert.ok(reap?.kind === "sandbox.reap");
			assert.equal(reap.outcome, "error");
			assert.equal(reap.payload.reason, "error");
		},
	);

	it("never constructs testimony from worker stdout or content-bearing agent events", () => {
		const beforeCount = capture.events.length;
		const active = {
			record: { sandbox_id: "sbx-content", template: "agent", state: "running" },
			isAgentRun: true,
			captureIdentity: { principal: "service:choreograph" },
			turnToolCount: 0,
		};
		const span = {
			addEvent() {},
			setAttribute() {},
		} as unknown as Span;
		const heartbeat = () => {};
		const handle = (
			spawner as unknown as {
				handleWorkerEvent(
					sandboxId: string,
					event: Record<string, unknown>,
					active: Record<string, unknown>,
					span: Span,
					onHeartbeat: () => void,
				): void;
			}
		).handleWorkerEvent.bind(spawner);
		handle("sbx-content", { type: "stdout", text: "TOP SECRET stdout" }, active, span, heartbeat);
		handle("sbx-content", { type: "text", content: "TOP SECRET model text" }, active, span, heartbeat);
		handle("sbx-content", { type: "thinking", content: "TOP SECRET reasoning" }, active, span, heartbeat);
		handle("sbx-content", { type: "done", output: "TOP SECRET result" }, active, span, heartbeat);
		assert.equal(capture.events.length, beforeCount);
	});

	it("keeps an H goal witness out of the opaque mirror and recovers its serialized tail after failure", async () => {
		const localStore = new SandboxStore(join(tempDir, "goal-handoff-spawner.sqlite"));
		let witnessHandled = true;
		let witnessCalls = 0;
		const witnessedActivationIds: string[] = [];
		const settledActivationIds: string[] = [];
		const localSpawner = new SandboxSpawner(
			localStore,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{
				workflowRuntime: {
					recordPrimeGoalUpdatedWitness: async (input) => {
						witnessCalls += 1;
						witnessedActivationIds.push(input.activationId);
						return witnessHandled;
					},
					readAgentSessionCommand: async () => ({
						session_id: "session-goal-handoff",
						name: "goal.create",
					}),
					settlePrimeGoalCommandResult: async (input) => {
						settledActivationIds.push(input.activationId);
						return { state: "completed" };
					},
				} as unknown as WorkflowRuntimeStore,
			},
		);
		const internals = localSpawner as unknown as {
			handlePrimeWorkerEvent(
				sandboxId: string,
				message: PrimeWorkerEventV1,
				active: Record<string, unknown>,
				monitorSpan: Span,
				onHeartbeat: () => void,
			): Promise<void>;
			handleCommandResult(message: PrimeCommandResultV1, active: Record<string, unknown>): Promise<void>;
			handleWorkerEvent: (...args: unknown[]) => void;
			enqueueGoalHandoff<T>(active: Record<string, unknown>, work: () => Promise<T>): Promise<T>;
		};
		let opaqueMirrors = 0;
		internals.handleWorkerEvent = () => {
			opaqueMirrors += 1;
		};
		const request = {
			session_id: "session-goal-handoff",
			generation: 1,
			invocation_id: "activation-goal-handoff",
		};
		const witness = {
			protocol: PRIME_HOST_PROTOCOL_VERSION,
			messageId: "goal-witness-1",
			sessionId: request.session_id,
			sandboxId: "sandbox-goal-handoff",
			generation: request.generation,
			correlationId: "goal-create-1",
			causationId: "runtime.restore:sandbox-goal-handoff:1",
			direction: "worker_to_host",
			kind: "event",
			workerSequence: 17,
			name: "goal.updated",
			payload: {},
		} as const satisfies PrimeWorkerEventV1;
		const span = { addEvent() {}, setAttribute() {} } as unknown as Span;

		await internals.handlePrimeWorkerEvent(
			"sandbox-goal-handoff",
			witness,
			{ agentRequest: request, goalHandoffCommandIds: new Set(["goal-create-1"]) },
			span,
			() => {},
		);
		assert.equal(witnessCalls, 1);
		assert.deepEqual(witnessedActivationIds, [request.invocation_id]);
		assert.equal(opaqueMirrors, 0);
		await internals.handleCommandResult(
			{
				protocol: PRIME_HOST_PROTOCOL_VERSION,
				messageId: "goal-result-1",
				sessionId: request.session_id,
				sandboxId: "sandbox-goal-handoff",
				generation: request.generation,
				correlationId: "goal-create-1",
				direction: "worker_to_host",
				kind: "result",
				workerSequence: 18,
				name: "command.result",
				commandId: "goal-create-1",
				payload: {
					commandId: "goal-create-1",
					commandName: "goal.create",
					status: "completed",
					result: {
						goal: {
							goal_id: "goal-handoff-1",
							objective: "Preserve the exact activation fence.",
							status: "active",
							token_budget: 12,
							tokens_used: 0,
							time_used_seconds: 0,
							created_at: 1,
							updated_at: 1,
						},
						remaining_tokens: 12,
						completion_budget_report: null,
					},
				},
			} satisfies PrimeCommandResultV1,
			{ agentRequest: request, goalHandoffCommandIds: new Set(["goal-create-1"]) },
		);
		assert.deepEqual(settledActivationIds, [request.invocation_id]);

		witnessHandled = false;
		await assert.rejects(
			internals.handlePrimeWorkerEvent(
				"sandbox-goal-handoff",
				witness,
				{ agentRequest: request, goalHandoffCommandIds: new Set(["goal-create-1"]) },
				span,
				() => {},
			),
			/does not match a delivered mutating durable goal command/,
		);
		assert.equal(opaqueMirrors, 0);

		await internals.handlePrimeWorkerEvent(
			"sandbox-goal-handoff",
			witness,
			{ agentRequest: request },
			span,
			() => {},
		);
		assert.equal(opaqueMirrors, 1);

		const tailActive: Record<string, unknown> = {};
		await assert.rejects(
			internals.enqueueGoalHandoff(tailActive, async () => Promise.reject(new Error("first failed"))),
			/first failed/,
		);
		assert.equal(await internals.enqueueGoalHandoff(tailActive, async () => "second settled"), "second settled");
		localStore.close();
	});

	it("accepts only a bounded host activation fence and never sources it from the worker request", async () => {
		const semantic = makeTestAgentSemanticBinding({ kind: "prime", registeredName: "activation-fence-proof" });
		const internals = spawner as unknown as {
			buildAgentRequest(
				sandboxId: string,
				opts: SpawnOptions,
				config: Record<string, unknown>,
			): Promise<{ request: AgentSpawnRequest }>;
		};
		const config = {
			mode: "agent",
			intent: "wait for the host activation fence",
			agent_id: semantic.agentId,
			session_id: "session-activation-fence",
			generation: 0,
			invocation_id: "activation-fence-exact",
			runtime_binding: semantic.runtime,
			runtime_binding_digest: semantic.runtimeBindingDigest,
			agent_ontology: semantic.ontology,
			agent_ontology_binding_digest: semantic.ontologyBindingDigest,
		};
		const opts: SpawnOptions = {
			template: "agent",
			intent: config.intent,
			mnemosyne: { mcpUrl: "disabled", graphId: "g1" },
		};
		const built = await internals.buildAgentRequest("sandbox-activation-fence", opts, config);
		assert.equal(built.request.invocation_id, "activation-fence-exact");
		for (const invalid of ["", "  ", "activation\0fence", "a".repeat(257), 42]) {
			await assert.rejects(
				internals.buildAgentRequest("sandbox-activation-fence", opts, { ...config, invocation_id: invalid }),
				/non-empty and bounded/,
			);
		}
		await assert.rejects(
			internals.buildAgentRequest("sandbox-activation-fence", opts, {
				...config,
				invocation_id: undefined,
				request: { invocation_id: "worker-forged-activation" },
			}),
			/host materialization activation id/,
		);
		assert.equal(
			(
				await internals.buildAgentRequest("sandbox-activation-fence", opts, {
					...config,
					invocation_id: undefined,
				})
			).request.invocation_id,
			undefined,
			"legacy sessions without a host activation fence retain their absence behavior",
		);
	});

	it("rejects a worker bridge request that forges its admitted generation", () => {
		const validate = (
			spawner as unknown as {
				validateWorkerBridgeContext(sandboxId: string, active: Record<string, unknown>, message: unknown): void;
			}
		).validateWorkerBridgeContext.bind(spawner);
		assert.throws(
			() =>
				validate(
					"sbx-generation",
					{
						agentRequest: {
							spawn_id: "sbx-generation",
							session_id: "session-generation",
							generation: 4,
						},
					},
					{
						protocol: PRIME_HOST_PROTOCOL_VERSION,
						messageId: "worker.request:sbx-generation:3:0",
						sessionId: "session-generation",
						sandboxId: "sbx-generation",
						generation: 3,
						correlationId: "prime-llm-0",
						direction: "worker_to_host",
						kind: "request",
						workerSequence: 0,
						name: "inference.request",
						payload: {
							requestId: "prime-llm-0",
							model: { id: "mock:done" },
							context: {},
						},
					},
				),
			/bridge context does not match/,
		);
	});

	it("admits one monotonic Prime worker sequence and rejects replay", () => {
		const validate = (
			spawner as unknown as {
				validateWorkerBridgeContext(sandboxId: string, active: Record<string, unknown>, message: unknown): void;
			}
		).validateWorkerBridgeContext.bind(spawner);
		const active = {
			agentRequest: {
				spawn_id: "sbx-sequence",
				session_id: "session-sequence",
				generation: 0,
			},
			nextPrimeWorkerSequence: 0,
		};
		const event = {
			protocol: PRIME_HOST_PROTOCOL_VERSION,
			messageId: "worker.event:sbx-sequence:0:0",
			sessionId: "session-sequence",
			sandboxId: "sbx-sequence",
			generation: 0,
			correlationId: "materialization:sbx-sequence:0",
			direction: "worker_to_host",
			kind: "event",
			workerSequence: 0,
			name: "turn.started",
			payload: { turn: 1 },
		};
		validate("sbx-sequence", active, event);
		assert.equal(active.nextPrimeWorkerSequence, 1);
		assert.throws(() => validate("sbx-sequence", active, event), /sequence is not the next admitted value/);
	});

	it("drains durable steering only as a materialization-bound bridge command", async () => {
		const childInput = new PassThrough();
		let output = "";
		childInput.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		const activeMap = (spawner as unknown as { active: Map<string, Record<string, unknown>> }).active;
		const mutableSpawner = spawner as unknown as {
			workflowRuntime?: {
				claimAgentSessionCommandsForDelivery(
					sessionId: string,
					generation: number,
					now: number,
				): Promise<unknown[]>;
				releaseAgentSessionCommandDelivery(commandId: string, generation: number): Promise<void>;
			};
		};
		activeMap.set("sbx-steer", {
			record: { sandbox_id: "sbx-steer", template: "agent", state: "running" },
			process: { stdin: childInput },
			isAgentRun: true,
			nextHostCommandId: 0,
			agentRequest: { spawn_id: "sbx-steer", session_id: "session-steer", generation: 3 },
		});
		mutableSpawner.workflowRuntime = {
			async claimAgentSessionCommandsForDelivery(sessionId, generation) {
				assert.equal(sessionId, "session-steer");
				assert.equal(generation, 3);
				return [
					{
						command_id: "command-1",
						session_id: "session-steer",
						idempotency_key: "command-1",
						command_digest: `sha256:${"a".repeat(64)}`,
						name: "steer",
						payload: { text: "take the gold path" },
						client_id: "vehicle-1",
						target_generation: 3,
						delivery_generation: 3,
						state: "delivered",
						result: undefined,
						error: null,
						submitted_at: 42,
						delivered_at: 43,
						completed_at: null,
					},
				];
			},
			async releaseAgentSessionCommandDelivery() {},
		};
		try {
			const delivered = await spawner.drainAgentSessionCommands("sbx-steer");
			assert.equal(delivered.length, 1);
		} finally {
			activeMap.delete("sbx-steer");
			mutableSpawner.workflowRuntime = undefined;
		}
		const command = parsePrimeHostBridgeMessage(JSON.parse(output));
		assert.deepEqual(command, {
			protocol: PRIME_HOST_PROTOCOL_VERSION,
			messageId: "host.command:sbx-steer:3:0",
			sessionId: "session-steer",
			sandboxId: "sbx-steer",
			generation: 3,
			correlationId: "command-1",
			causationId: "runtime.restore:sbx-steer:3",
			commandId: "command-1",
			direction: "host_to_worker",
			kind: "command",
			name: "input.steer",
			payload: { text: "take the gold path" },
		});
	});

	it("gives the command-first prompt one checkpoint/passivation owner and preserves later command semantics", async () => {
		const directory = mkdtempSync(join(tmpdir(), "spawner-command-first-"));
		const runtime = new WorkflowRuntimeStore(join(directory, "runtime.sqlite"));
		await runtime.init();
		await runtime.createWorkflowInstance({
			runId: "run-command-first",
			workflowName: "command-first-proof",
			graphId: "g1",
			ownerUserId: "user:test",
			inputs: {},
			startedAt: 1,
		});
		const memory = new AgentMemory(
			SophiaContentStore.fromUrl(new URL("memory/", `file://${directory}/`).toString()),
			runtime,
		);
		const semantic = makeTestAgentSemanticBinding({ kind: "prime", registeredName: "command-first-proof" });
		const sessionId = "ags-command-first";
		const sandboxId = "sbx-command-first";
		const invocationId = "activation-command-first";
		const firstCommandId = "cmd-scheduled-first";
		const laterCommandId = "cmd-resident-later";
		const request: AgentSpawnRequest = {
			spawn_id: sandboxId,
			session_id: sessionId,
			generation: 0,
			intent: "the durable prompt owns the first turn",
			await_initial_command: true,
			wards: { max_turns: semantic.runtime.constraints.maxTurns, max_depth: 0, require_done_tool: false },
			mnemosyne: {
				mcp_url: "disabled",
				session_token: "disabled",
				graph_scope: { default_graph_id: "g1" },
				tool_profile: "chat",
				expires_at: "2030-01-01T00:00:00.000Z",
			},
			medium: "conversation",
			model: "mock:done",
			agent_id: semantic.agentId,
			depth: 0,
			runtime_binding: semantic.runtime,
			runtime_binding_digest: semantic.runtimeBindingDigest,
			agent_ontology: semantic.ontology,
			agent_ontology_binding_digest: semantic.ontologyBindingDigest,
		};
		const active = {
			record: { sandbox_id: sandboxId, template: "agent", state: "running" },
			process: { stdin: new PassThrough() },
			isAgentRun: true,
			nextHostCommandId: 0,
			agentRequest: request,
		};
		const internals = spawner as unknown as {
			active: Map<string, Record<string, unknown>>;
			workflowRuntime?: WorkflowRuntimeStore;
			agentMemory?: AgentMemory;
			scheduleAgentPassivation(input: Record<string, unknown>): Promise<void>;
			deliverAgentSessionCommands(
				active: Record<string, unknown>,
				commands: Awaited<ReturnType<WorkflowRuntimeStore["claimAgentSessionCommandsForDelivery"]>>,
			): Promise<unknown[]>;
			handleCommandResult(message: PrimeCommandResultV1, active: Record<string, unknown>): Promise<void>;
		};
		const previousRuntime = internals.workflowRuntime;
		const previousMemory = internals.agentMemory;
		const originalSchedulePassivation = internals.scheduleAgentPassivation.bind(spawner);
		const memoryInternals = memory as unknown as {
			commitPrimeState: AgentMemory["commitPrimeState"];
		};
		const originalCommitPrimeState = memoryInternals.commitPrimeState.bind(memory);
		let checkpointCommits = 0;
		let passivationSchedules = 0;
		memoryInternals.commitPrimeState = async (input) => {
			checkpointCommits += 1;
			return originalCommitPrimeState(input);
		};
		internals.workflowRuntime = runtime;
		internals.agentMemory = memory;
		internals.scheduleAgentPassivation = async () => {
			passivationSchedules += 1;
		};
		internals.active.set(sandboxId, active);

		try {
			let firstState!: PrimeRuntimeStateV2;
			let firstResult!: AgentSpawnResult & { prime_state: PrimeRuntimeStateV2 };
			const runner = makeRuntimeNodeRunner({
				runtime,
				memory,
				runId: "run-command-first",
				workflowName: "command-first-proof",
				graphId: "g1",
				ownerUserId: "user:test",
				graphOwnerPrincipal: "user:test",
				now: () => Date.now(),
				onIdle: async () => internals.scheduleAgentPassivation({ sessionId }),
				baseRunner: async (input) => {
					await runtime.bindAgentSandbox(sessionId, {
						sandboxId,
						generation: 0,
						activationId: invocationId,
						now: Date.now(),
					});
					await runtime.submitAgentSessionCommand(sessionId, {
						commandId: firstCommandId,
						idempotencyKey: firstCommandId,
						name: "prompt",
						payload: { text: "wake for the claimed schedule fire" },
						clientId: "scheduler",
						targetGeneration: 0,
						requireDriver: false,
						now: Date.now(),
					});
					const claimedFirst = await runtime.claimExactAgentSessionCommandForDelivery(
						sessionId,
						0,
						firstCommandId,
						Date.now(),
					);
					assert.ok(claimedFirst);
					await internals.deliverAgentSessionCommands(active, [claimedFirst]);
					assert.equal(active.materializationResultCommandId, firstCommandId);
					firstState = commandFirstPrimeState(request, 1);
					firstResult = commandFirstSpawnResult(request, firstState, "scheduled turn complete");
					await internals.handleCommandResult(
						commandFirstResultMessage(request, firstCommandId, 1, firstResult),
						active,
					);
					assert.equal((await runtime.readAgentSessionCommand(firstCommandId))?.state, "completed");
					assert.equal(checkpointCommits, 0, "the command handler must not double-commit materialization state");
					assert.equal(passivationSchedules, 0, "the command handler must not race materialization idle policy");
					return commandFirstNodeResult(input, firstState, firstResult.output);
				},
			});
			const spec: AgentNodeSpec = {
				label: "scheduled activation",
				phaseIndex: 0,
				prompt: "not an initial turn",
				model: "mock:done",
				graphId: "g1",
				sessionId,
				sandboxGeneration: 0,
				invocationId,
				awaitInitialCommand: true,
				...semantic,
			};
			const materializationResult = await runner(spec);
			assert.ok(materializationResult.agentCheckpoint);
			assert.equal(checkpointCommits, 1, "the materialization result is the sole first-turn checkpoint owner");
			assert.equal(passivationSchedules, 1, "the materialization result is the sole first-turn idle owner");
			await internals.handleCommandResult(
				commandFirstResultMessage(request, firstCommandId, 2, firstResult),
				active,
			);
			assert.equal(checkpointCommits, 1, "a replayed first command result cannot acquire checkpoint ownership");
			assert.equal(passivationSchedules, 1, "a replayed first command result cannot acquire idle ownership");
			assert.equal(
				(await runtime.listAgentSessionEvents(sessionId)).filter(
					(event) =>
						event.type === "command.completed" &&
						(event.payload as { commandId?: unknown }).commandId === firstCommandId,
				).length,
				1,
				"the first prompt still receives one durable command completion event",
			);

			const laterState = commandFirstPrimeState(request, 2);
			const laterResult = commandFirstSpawnResult(request, laterState, "resident turn complete");
			await runtime.submitAgentSessionCommand(sessionId, {
				commandId: laterCommandId,
				idempotencyKey: laterCommandId,
				name: "prompt",
				payload: { text: "continue in the resident materialization" },
				clientId: "vehicle",
				targetGeneration: 0,
				requireDriver: false,
				now: Date.now(),
			});
			await spawner.drainAgentSessionCommands(sandboxId);
			assert.equal(
				active.materializationResultCommandId,
				firstCommandId,
				"later prompts cannot steal first-turn identity",
			);
			await internals.handleCommandResult(
				commandFirstResultMessage(request, laterCommandId, 3, laterResult),
				active,
			);
			assert.equal((await runtime.readAgentSessionCommand(laterCommandId))?.state, "completed");
			assert.equal(checkpointCommits, 2, "a later resident command keeps its command-handler checkpoint");
			assert.equal(passivationSchedules, 2, "a later resident command keeps its command-handler idle policy");
		} finally {
			internals.active.delete(sandboxId);
			internals.workflowRuntime = previousRuntime;
			internals.agentMemory = previousMemory;
			internals.scheduleAgentPassivation = originalSchedulePassivation;
			runtime.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("pins prompt, follow-up, and steer as the sole command-first materialization result owner", () => {
		const internals = spawner as unknown as {
			sendDurableAgentCommand(active: Record<string, unknown>, command: Record<string, unknown>): void;
		};
		for (const name of ["prompt", "follow_up", "steer"] as const) {
			const input = new PassThrough();
			const active: Record<string, unknown> = {
				record: { sandbox_id: `sandbox-command-first-${name}` },
				process: { stdin: input },
				nextHostCommandId: 0,
				agentRequest: {
					await_initial_command: true,
					session_id: `session-command-first-${name}`,
					generation: 1,
				},
			};
			const commandId = `command-first-${name}`;
			internals.sendDurableAgentCommand(active, {
				command_id: commandId,
				session_id: `session-command-first-${name}`,
				delivery_generation: 1,
				name,
				payload: { text: `continue with ${name}` },
			});
			assert.equal(active.materializationResultCommandId, commandId);
			internals.sendDurableAgentCommand(active, {
				command_id: `later-${name}`,
				session_id: `session-command-first-${name}`,
				delivery_generation: 1,
				name: "prompt",
				payload: { text: "later resident command" },
			});
			assert.equal(active.materializationResultCommandId, commandId);
		}
	});

	it("delivers only the exact supervisor quiesce command after shutdown admission latches", async () => {
		const childInput = new PassThrough();
		let output = "";
		childInput.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		let genericClaims = 0;
		let exactClaims = 0;
		const activeMap = (spawner as unknown as { active: Map<string, Record<string, unknown>> }).active;
		const mutableSpawner = spawner as unknown as {
			shuttingDown: boolean;
			workflowRuntime?: {
				claimAgentSessionCommandsForDelivery(): Promise<unknown[]>;
				claimExactAgentSessionCommandForDelivery(
					sessionId: string,
					generation: number,
					commandId: string,
					now: number,
				): Promise<Record<string, unknown> | null>;
				releaseAgentSessionCommandDelivery(commandId: string, generation: number): Promise<void>;
			};
			drainShutdownQuiesceCommand(sandboxId: string, commandId: string): Promise<unknown[]>;
		};
		const commandId = "runtime.quiesce:session-shutdown-quiesce:2";
		activeMap.set("sbx-shutdown-quiesce", {
			record: { sandbox_id: "sbx-shutdown-quiesce", template: "agent", state: "running" },
			process: { stdin: childInput },
			isAgentRun: true,
			nextHostCommandId: 0,
			hostWorkAdmissionClosed: false,
			agentRequest: {
				spawn_id: "sbx-shutdown-quiesce",
				session_id: "session-shutdown-quiesce",
				generation: 2,
			},
		});
		mutableSpawner.workflowRuntime = {
			async claimAgentSessionCommandsForDelivery() {
				genericClaims += 1;
				return [];
			},
			async claimExactAgentSessionCommandForDelivery(sessionId, generation, requestedCommandId) {
				exactClaims += 1;
				assert.equal(sessionId, "session-shutdown-quiesce");
				assert.equal(generation, 2);
				assert.equal(requestedCommandId, commandId);
				return {
					command_id: commandId,
					session_id: sessionId,
					idempotency_key: commandId,
					command_digest: `sha256:${"b".repeat(64)}`,
					name: "quiesce",
					payload: { reason: "shutdown", drainDeadlineMs: 10_000 },
					client_id: "choreograph.agent-memory",
					target_generation: generation,
					delivery_generation: generation,
					state: "delivered",
					result: undefined,
					error: null,
					submitted_at: 42,
					delivered_at: 43,
					completed_at: null,
				};
			},
			async releaseAgentSessionCommandDelivery() {},
		};
		mutableSpawner.shuttingDown = true;
		try {
			const delivered = await mutableSpawner.drainShutdownQuiesceCommand("sbx-shutdown-quiesce", commandId);
			assert.equal(delivered.length, 1);
			assert.equal(exactClaims, 1);
			assert.equal(genericClaims, 0, "shutdown passivation must not sweep arbitrary queued commands");
		} finally {
			mutableSpawner.shuttingDown = false;
			activeMap.delete("sbx-shutdown-quiesce");
			mutableSpawner.workflowRuntime = undefined;
		}
		const command = parsePrimeHostBridgeMessage(JSON.parse(output));
		assert.equal(command.kind, "command");
		assert.equal(command.commandId, commandId);
		assert.equal(command.name, "runtime.quiesce");
	});

	it("kills a Prime materialization that emits a non-bridge message", async () => {
		let killed = false;
		const active = {
			record: { sandbox_id: "sbx-one-wire", template: "agent", state: "running" },
			isAgentRun: true,
			agentRequest: { spawn_id: "sbx-one-wire", session_id: "session-one-wire", generation: 0 },
			workerTerminalState: undefined as string | undefined,
			workerResultFault: undefined as string | undefined,
		};
		const handleLine = (
			spawner as unknown as {
				handleWorkerLine(options: Record<string, unknown>): Promise<void>;
			}
		).handleWorkerLine.bind(spawner);
		await handleLine({
			sandboxId: "sbx-one-wire",
			line: JSON.stringify({ kind: "event", event: { type: "turn_start", turn: 1 } }),
			child: {
				kill() {
					killed = true;
				},
			},
			active,
			monitorSpan: {},
			onHeartbeat() {},
		});
		assert.equal(killed, true);
		assert.equal(active.workerTerminalState, "error");
		assert.match(active.workerResultFault ?? "", /non-bridge message/);
	});

	it("propagates bridge cancellation into an active capability backend and returns a typed failure", async () => {
		const childInput = new PassThrough();
		let output = "";
		childInput.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		let callStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			callStarted = resolve;
		});
		let observedSignal: AbortSignal | undefined;
		const backend: CapabilityBackend = {
			capabilityName: "mnemosyne",
			accessLevel: "rw",
			async listTools() {
				return [];
			},
			async callTool(_tool, _args, signal) {
				observedSignal = signal;
				callStarted();
				return new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			},
			async close() {},
		};
		const active = {
			record: { sandbox_id: "sbx-cancel", template: "agent", state: "running" },
			capabilityRegistry: new Map([["mnemosyne", backend]]),
			bridgeAbortControllers: new Map<string, AbortController>(),
			nextHostResponseId: 0,
			captureIdentity: { principal: "service:choreograph" },
		};
		const bridgeContext = {
			protocol: PRIME_HOST_PROTOCOL_VERSION,
			sessionId: "session-cancel",
			sandboxId: "sbx-cancel",
			generation: 0,
			direction: "worker_to_host",
			kind: "request",
		} as const;
		const capabilityRequest = {
			...bridgeContext,
			messageId: "worker.request:sbx-cancel:0:0",
			correlationId: "prime-gate-0",
			workerSequence: 0,
			name: "capability.request",
			payload: {
				requestId: "prime-gate-0",
				capability: "mnemosyne",
				tool: "slow_tool",
				args: {},
			},
		} as const;
		const cancellationRequest = {
			...bridgeContext,
			messageId: "worker.request:sbx-cancel:0:1",
			correlationId: "prime-cancel-1",
			workerSequence: 1,
			name: "request.cancel",
			payload: {
				requestId: "prime-cancel-1",
				targetRequestId: "prime-gate-0",
				reason: "test abort",
			},
		} as const;
		const internals = spawner as unknown as {
			handleGateCall(
				message: Record<string, unknown>,
				child: Record<string, unknown>,
				active: Record<string, unknown>,
				bridgeRequest: Record<string, unknown>,
			): Promise<void>;
			handleBridgeCancellation(
				request: Record<string, unknown>,
				child: Record<string, unknown>,
				active: Record<string, unknown>,
			): void;
		};
		const child = { stdin: childInput };
		const pending = internals.handleGateCall(
			{ kind: "gate_call", call_id: "prime-gate-0", capability: "mnemosyne", tool: "slow_tool", args: {} },
			child,
			active,
			capabilityRequest,
		);
		await started;
		internals.handleBridgeCancellation(cancellationRequest, child, active);
		await pending;

		assert.equal(observedSignal?.aborted, true);
		const responses = output
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const cancellation = responses.find((response) => response.requestId === "prime-cancel-1");
		assert.deepEqual(cancellation?.result, {
			kind: "request.cancelled",
			targetRequestId: "prime-gate-0",
			cancelled: true,
		});
		const original = responses.find((response) => response.requestId === "prime-gate-0");
		assert.equal(original?.ok, false);
		assert.deepEqual(original?.error, {
			code: "capability_cancelled",
			class: "cancelled",
			message: "test abort",
			retryable: false,
		});
	});
});

function commandFirstPrimeState(request: AgentSpawnRequest, workerSequence: number): PrimeRuntimeStateV2 {
	const unsigned: Omit<PrimeRuntimeStateV2, "digest"> = {
		schema: PRIME_RUNTIME_STATE_SCHEMA,
		sessionId: request.session_id,
		sandboxId: request.spawn_id,
		generation: request.generation,
		runtimeBindingDigest: request.runtime_binding_digest,
		ontologyBindingDigest: request.agent_ontology_binding_digest,
		sessionHeader: { type: "session", version: 3, id: request.session_id, cwd: "/workspace" },
		entries: [],
		goal: null,
		autonomous: { enabled: false },
		workerSequence,
		createdAt: new Date(Date.now() + workerSequence).toISOString(),
	};
	return { ...unsigned, digest: `sha256:${canonicalDigest(unsigned)}` };
}

function commandFirstSpawnResult(
	request: AgentSpawnRequest,
	state: PrimeRuntimeStateV2,
	output: string,
): AgentSpawnResult & { prime_state: PrimeRuntimeStateV2 } {
	return {
		spawn_id: request.spawn_id,
		status: "terminated",
		output,
		turns: 1,
		tokens: 1,
		tool_calls: 0,
		session_id: request.session_id,
		runtime_binding_digest: request.runtime_binding_digest,
		agent_ontology_binding_digest: request.agent_ontology_binding_digest,
		prime_state: state,
	};
}

function commandFirstResultMessage(
	request: AgentSpawnRequest,
	commandId: string,
	workerSequence: number,
	result: AgentSpawnResult,
): PrimeCommandResultV1 {
	return {
		protocol: PRIME_HOST_PROTOCOL_VERSION,
		messageId: `worker.command-result:${request.spawn_id}:${String(request.generation)}:${String(workerSequence)}`,
		sessionId: request.session_id,
		sandboxId: request.spawn_id,
		generation: request.generation,
		correlationId: commandId,
		causationId: `host.command:${request.spawn_id}:${String(request.generation)}:${String(workerSequence - 1)}`,
		commandId,
		direction: "worker_to_host",
		kind: "result",
		workerSequence,
		name: "command.result",
		payload: {
			commandId,
			commandName: "input.prompt",
			status: "completed",
			result,
		},
	};
}

function commandFirstNodeResult(input: AgentNodeSpec, state: PrimeRuntimeStateV2, output: string): AgentNodeResult {
	return {
		nodeKey: input.nodeKey,
		sessionId: input.sessionId,
		invocationId: input.invocationId,
		label: input.label,
		phaseIndex: input.phaseIndex,
		state: "done",
		output,
		model: input.model,
		agentId: input.agentId,
		turns: 1,
		toolCalls: 0,
		tokens: 1,
		queuedAt: 1,
		startedAt: 2,
		durationMs: 1,
		agentType: input.agentType,
		primeState: state,
	};
}
