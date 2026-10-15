import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
	type AgentSessionScheduleActivation,
	AgentSessionSchedulerService,
} from "../agent-runtime/agent-session-scheduler-service.js";
import { SophiaContentStore } from "../agent-runtime/content-store.js";
import { AgentMemory } from "../agent-runtime/memory.js";
import { digestAgentRuntimeBinding } from "../agent-runtime/profile.js";
import { mirrorAgentSessionEvent } from "../agent-runtime/session-event-mirror.js";
import { createSandboxEventBus } from "../event-bus.js";
import { digestSophiaAgentSourceTree } from "../runtime-bundles.js";
import { SandboxStore } from "../sandbox-store.js";
import { SandboxSpawner } from "../spawner.js";
import { makeNodeRunner } from "../workflow/run-node.js";
import { makeRuntimeNodeRunner } from "../workflow/runtime-control.js";
import {
	type AgentSessionCommandRecord,
	type AgentSessionEvent,
	type AgentSessionRecord,
	WorkflowRuntimeStore,
} from "../workflow/runtime-store.js";
import type { AgentNodeSpec, NodeRunner } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

const ENTRYPOINT = process.env.SOPHIA_AGENT_RUNTIME_ENTRYPOINT?.trim();
const BRIDGE = process.env.SOPHIA_JUPYTER_BRIDGE_PATH?.trim();
const PYTHON = process.env.SOPHIA_PRIME_KERNEL_PYTHON?.trim();
const LOCAL_RUNTIME_SKIP =
	!ENTRYPOINT || !existsSync(ENTRYPOINT) || !BRIDGE || !existsSync(BRIDGE) || !PYTHON || !existsSync(PYTHON)
		? "set the Prime worker, Jupyter bridge, and kernel Python paths"
		: false;

const GRAPH_ID = "arc-g1-local-proof";
const OWNER_USER_ID = "user:arc-g1-local-proof";
const GRAPH_OWNER_PRINCIPAL = "organization:arc-g1-local-proof";
const RUN_ID = "arc-g1-local-e2e";
const WORKFLOW_NAME = "arc-g1-scheduled-activation-proof";
const SESSION_ID = "agent-session:arc-g1-local-e2e";
const NODE_KEY = "arc-g1-scheduled-prime";
const SCHEDULE_ID = "schedule:arc-g1-one-shot";
const CREATE_REQUEST_ID = "request:arc-g1-create-one-shot";
const SCHEDULED_PROMPT = "Wake from compost exactly once for the Arc G1 scheduled turn.";
const VEHICLE_FOLLOW_UP_COMMAND_ID = "vehicle:arc-g1-follow-up-after-passivation";
const VEHICLE_FOLLOW_UP = "Restore the resident value and increment it exactly once through Vehicle.";

describe("Arc G1 durable scheduler organism", { concurrency: false }, () => {
	it(
		"reopens before due, wakes one composted Prime generation exactly once, and does not replay the fire",
		{ skip: LOCAL_RUNTIME_SKIP, timeout: 180_000 },
		async () => {
			const tempDir = mkdtempSync(join(tmpdir(), "choreograph-arc-g1-e2e-"));
			const bodies: BodyWitness[] = [];
			let scheduledActivations = 0;
			const scheduledActivationErrors: unknown[] = [];
			let bodyProofAfterFire: BodyWitness[] = [];
			// The durable scheduler has an injected clock, while physical body and
			// recovery testimony intentionally use wall time. Cross the short future
			// deadline in real time so every production timestamp remains monotonic.
			let schedulerNow = Date.now();
			let dueAt = 0;
			const integration = productionSchedulerIntegration();
			const baseSpec = makePrimeSpec();
			let harness: LocalHarness | null = null;
			let scheduler: SchedulerService | null = null;

			try {
				// Host A creates the durable Session, proves memory-first composting, and
				// persists a future schedule. It closes while the fire is still not due.
				harness = await createHarness(tempDir, bodies);
				await harness.spawner.start();
				await createWorkflow(harness.runtime);
				const generation0 = await makeSessionRunner(harness)(
					generationSpec(baseSpec, 0, {
						activationId: `${SESSION_ID}:generation:0`,
						prompt: "Initialize durable state, then compost before the scheduled wake.",
					}),
				);
				assert.equal(generation0.state, "done");
				assert.ok(generation0.agentCheckpoint);
				await assertPassivated(harness, 0);
				assertBodyPairPassivated(bodies, 0);

				schedulerNow = Date.now();
				dueAt = schedulerNow + 5_000;
				const created = await integration.createSchedule(harness.runtime, {
					scheduleId: SCHEDULE_ID,
					requestId: CREATE_REQUEST_ID,
					sessionId: SESSION_ID,
					dueAt,
					prompt: SCHEDULED_PROMPT,
					now: schedulerNow,
				});
				assert.equal(created.scheduleId, SCHEDULE_ID);
				assert.equal(created.requestId, CREATE_REQUEST_ID);
				assert.equal(created.sessionId, SESSION_ID);
				assert.equal(created.nextFireAt, dueAt);
				const beforeDueEvents = await harness.runtime.listAgentSessionEvents(SESSION_ID);
				scheduler = integration.makeService({
					runtime: harness.runtime,
					consumer: "arc-g1-host-before-due",
					now: () => schedulerNow,
					activate: async ({ fire }) => {
						throw new Error(`future schedule activated early: ${fire.fire_id}`);
					},
				});
				await scheduler.start();
				scheduler.wake();
				await scheduler.stop();
				scheduler = null;
				assert.equal(await harness.runtime.readAgentMaterialization(SESSION_ID, 1), null);
				assert.equal(harness.spawner.sessionBodyCount(SESSION_ID), 0);
				assert.deepEqual(await harness.runtime.listAgentSessionEvents(SESSION_ID), beforeDueEvents);
				assert.equal((await harness.runtime.listExecutionJournal(SESSION_ID)).length, 1);
				await closeHarness(harness);
				harness = null;

				// Host B reopens before due. Its initial recovery sweep must still do
				// nothing. Crossing the due boundary then activates generation 1 in
				// await_initial_command mode: construction/readiness has no turn, and the
				// queued scheduled command is Prime's first semantic stimulus.
				schedulerNow = Math.min(Date.now(), dueAt - 1);
				harness = await createHarness(tempDir, bodies);
				await harness.spawner.start();
				const activateScheduled = async (activation: AgentSessionScheduleActivation): Promise<void> => {
					assert.equal(activation.fire.schedule_id, SCHEDULE_ID);
					assert.equal(activation.fire.session_id, SESSION_ID);
					assert.equal(activation.fire.target_generation, 1);
					assert.equal(activation.command.command_id, activation.fire.command_id);
					assert.equal(activation.command.payload.text, SCHEDULED_PROMPT);
					try {
						await harness!.spawner.activateAgentSessionSchedule(activation);
						scheduledActivations += 1;
					} catch (error) {
						scheduledActivationErrors.push(error);
						throw error;
					}
				};
				scheduler = integration.makeService({
					runtime: harness.runtime,
					consumer: "arc-g1-host-after-due",
					now: () => schedulerNow,
					activate: activateScheduled,
				});
				await scheduler.start();
				scheduler.wake();
				await scheduler.stop();
				scheduler = null;
				assert.equal(scheduledActivations, 0);
				assert.equal(await harness.runtime.readAgentMaterialization(SESSION_ID, 1), null);
				assert.equal(harness.spawner.sessionBodyCount(SESSION_ID), 0);

				const generation1SandboxBaseline = new Set(harness.sandboxStore.list().map((record) => record.sandbox_id));
				await delay(Math.max(0, dueAt + 1 - Date.now()));
				schedulerNow = Date.now();
				scheduler = integration.makeService({
					runtime: harness.runtime,
					consumer: "arc-g1-host-at-due",
					now: () => schedulerNow,
					activate: activateScheduled,
				});
				await scheduler.start();
				scheduler.wake();
				await waitFor(
					() => scheduledActivations === 1 || scheduledActivationErrors.length > 0,
					"scheduled activation did not settle",
				);
				if (scheduledActivationErrors.length > 0) throw scheduledActivationErrors[0];
				await assertPassivated(harness, 1);
				captureGenerationBodies(harness, bodies, 1, generation1SandboxBaseline);

				const firstProof = await waitForValue(async () => {
					const proof = await integration.readProof(harness!.runtime, SCHEDULE_ID);
					return proof.fires[0]?.state === "completed" ? proof : undefined;
				}, "scheduled fire work did not settle completed");
				assert.equal(firstProof.schedule.scheduleId, SCHEDULE_ID);
				assert.equal(firstProof.schedule.state, "completed");
				assert.equal(firstProof.fires.length, 1);
				const fire = firstProof.fires[0]!;
				assert.equal(fire.scheduleId, SCHEDULE_ID);
				assert.equal(fire.sessionId, SESSION_ID);
				assert.equal(fire.generation, 1);
				assert.equal(fire.prompt, SCHEDULED_PROMPT);
				assert.equal(fire.activationId.length > 0, true);
				assert.equal(fire.commandId.length > 0, true);
				assert.notEqual(fire.commandId, created.requestId);
				assert.equal(fire.scheduledAt, dueAt);
				assert.equal(fire.coalescedThroughAt, dueAt);
				assert.equal(fire.coalescedCount, 1);
				assert.equal(fire.claimedAt, schedulerNow);
				assert.equal(fire.nextFireAt, null);
				assert.equal(fire.state, "completed");
				assert.equal(fire.attempt, 1);
				assertScheduledCommandCompleted(await harness.runtime.readAgentSessionCommand(fire.commandId), fire);
				assertScheduledSessionResult(await harness.runtime.readAgentSession(SESSION_ID));
				assert.equal((await harness.runtime.readLatestAgentCheckpoint(SESSION_ID))?.manifest.generation, 1);

				const journal = await harness.runtime.listExecutionJournal(SESSION_ID);
				assert.deepEqual(
					journal.map((cell) => cell.generation),
					[0, 1],
					"one initial kernel cell and one scheduled kernel cell are expected",
				);
				assert.match(JSON.stringify(journal[0]?.outputs), /resident value 1/);
				assert.match(JSON.stringify(journal[1]?.outputs), /resident value 2/);
				const events = await harness.runtime.listAgentSessionEvents(SESSION_ID);
				assertScheduleEventCausation(events, created, fire);
				assertScheduledFirstStimulus(events, fire);
				await assertSingleCheckpointAndPassivation(harness.runtime, events, 1);
				assert.equal(
					events.filter(
						(event) =>
							event.type === "runtime.resumed" && (event.payload as { generation?: unknown }).generation === 1,
					).length,
					1,
				);

				assertBodyPairPassivated(bodies, 1);
				assert.equal(harness.spawner.sessionBodyCount(SESSION_ID), 0);
				bodyProofAfterFire = uniqueBodies(bodies);

				await scheduler.stop();
				scheduler = null;
				await closeHarness(harness);
				harness = null;

				// Host C starts well after the one-shot. Reprocessing the same durable
				// horizon must produce no callback, generation, cell, event, or process.
				schedulerNow += 60_000;
				harness = await createHarness(tempDir, bodies);
				await harness.spawner.start();
				let replayActivations = 0;
				scheduler = integration.makeService({
					runtime: harness.runtime,
					consumer: "arc-g1-host-replay",
					now: () => schedulerNow,
					activate: async ({ fire }) => {
						replayActivations += 1;
						throw new Error(`completed one-shot replayed: ${fire.fire_id}`);
					},
				});
				await scheduler.start();
				scheduler.wake();
				await scheduler.stop();
				scheduler = null;
				assert.equal(replayActivations, 0);
				assert.equal(await harness.runtime.readAgentMaterialization(SESSION_ID, 2), null);
				assert.equal(harness.spawner.sessionBodyCount(SESSION_ID), 0);
				assert.equal((await harness.runtime.listExecutionJournal(SESSION_ID)).length, 2);
				const replayProof = await integration.readProof(harness.runtime, SCHEDULE_ID);
				assert.deepEqual(replayProof, firstProof);
				const replayEvents = await harness.runtime.listAgentSessionEvents(SESSION_ID);
				assert.equal(replayEvents.filter((event) => event.type === "schedule.fired").length, 1);
				assertScheduledFirstStimulus(replayEvents, firstProof.fires[0]!);
				assert.deepEqual(uniqueBodies(bodies), bodyProofAfterFire);
			} finally {
				if (scheduler) await scheduler.stop().catch(() => {});
				if (harness) await closeHarness(harness).catch(() => {});
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	);

	it(
		"wakes a passivated Prime for one exact Vehicle follow-up and never replays the activation",
		{ skip: LOCAL_RUNTIME_SKIP, timeout: 180_000 },
		async () => {
			const tempDir = mkdtempSync(join(tmpdir(), "choreograph-vehicle-follow-up-e2e-"));
			const bodies: BodyWitness[] = [];
			let harness: LocalHarness | null = null;
			try {
				harness = await createHarness(tempDir, bodies);
				await harness.spawner.start();
				await createWorkflow(harness.runtime);
				const generation0 = await makeSessionRunner(harness)(
					generationSpec(makePrimeSpec(), 0, {
						activationId: `${SESSION_ID}:vehicle:generation:0`,
						prompt: "Initialize the resident value, then compost before the Vehicle follow-up.",
					}),
				);
				assert.equal(generation0.state, "done");
				assert.ok(generation0.agentCheckpoint);
				await assertPassivated(harness, 0);
				assertBodyPairPassivated(bodies, 0);

				const generation1SandboxBaseline = new Set(harness.sandboxStore.list().map((record) => record.sandbox_id));
				const submitted = await harness.runtime.submitAgentSessionCommand(SESSION_ID, {
					commandId: VEHICLE_FOLLOW_UP_COMMAND_ID,
					idempotencyKey: VEHICLE_FOLLOW_UP_COMMAND_ID,
					name: "follow_up",
					payload: { text: VEHICLE_FOLLOW_UP },
					clientId: "vehicle:arc-g1-local-proof",
					now: Date.now(),
				});
				assert.ok(submitted?.accepted);
				assert.equal(submitted.record.target_generation, 1);
				harness.spawner.wakeDurableSupervision();

				const completed = await waitForValue(async () => {
					const command = await harness!.runtime.readAgentSessionCommand(VEHICLE_FOLLOW_UP_COMMAND_ID);
					return command?.state === "completed" || command?.state === "failed" || command?.state === "cancelled"
						? command
						: undefined;
				}, "Vehicle follow-up did not settle durably");
				assert.equal(completed.state, "completed", completed.error ?? "Vehicle follow-up did not complete");
				assert.equal(completed.name, "follow_up");
				assert.equal(completed.delivery_generation, 1);
				assert.match(JSON.stringify(completed.result), /Resident Prime command completed/);
				await assertPassivated(harness, 1);
				captureGenerationBodies(harness, bodies, 1, generation1SandboxBaseline);

				const activation = await harness.runtime.readAgentSessionCommandActivation(VEHICLE_FOLLOW_UP_COMMAND_ID);
				assert.equal(activation?.state, "completed");
				assert.equal(activation?.target_generation, 1);
				assert.equal(activation?.attempt, 1);
				assert.equal((await harness.runtime.readLatestAgentCheckpoint(SESSION_ID))?.manifest.generation, 1);
				assertScheduledSessionResult(await harness.runtime.readAgentSession(SESSION_ID));

				const journal = await harness.runtime.listExecutionJournal(SESSION_ID);
				assert.deepEqual(
					journal.map((cell) => cell.generation),
					[0, 1],
				);
				assert.match(JSON.stringify(journal[0]?.outputs), /resident value 1/);
				assert.match(JSON.stringify(journal[1]?.outputs), /resident value 2/);
				const events = await harness.runtime.listAgentSessionEvents(SESSION_ID);
				assertVehicleFollowUpFirstStimulus(events);
				await assertSingleCheckpointAndPassivation(harness.runtime, events, 1);
				assertBodyPairPassivated(bodies, 1);
				assert.equal(harness.spawner.sessionBodyCount(SESSION_ID), 0);

				const durableEvents = structuredClone(events);
				const durableBodies = uniqueBodies(bodies);
				await closeHarness(harness);
				harness = null;

				harness = await createHarness(tempDir, bodies);
				await harness.spawner.start();
				await delay(100);
				assert.equal(await harness.runtime.readAgentMaterialization(SESSION_ID, 2), null);
				assert.equal(harness.spawner.sessionBodyCount(SESSION_ID), 0);
				assert.equal((await harness.runtime.listExecutionJournal(SESSION_ID)).length, 2);
				assert.deepEqual(await harness.runtime.listAgentSessionEvents(SESSION_ID), durableEvents);
				assert.deepEqual(uniqueBodies(bodies), durableBodies);
				assert.equal(
					(await harness.runtime.readAgentSessionCommandActivation(VEHICLE_FOLLOW_UP_COMMAND_ID))?.state,
					"completed",
				);
			} finally {
				if (harness) await closeHarness(harness).catch(() => {});
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	);
});

interface SchedulerService {
	start(): Promise<void>;
	wake(): void;
	stop(): Promise<void>;
}

interface ScheduledActivation {
	readonly scheduleId: string;
	readonly fireId: string;
	readonly sessionId: string;
	readonly generation: number;
	readonly activationId: string;
	readonly commandId: string;
	readonly prompt: string;
}

interface ScheduleWitness {
	readonly scheduleId: string;
	readonly requestId: string;
	readonly sessionId: string;
	readonly nextFireAt: number;
}

interface ScheduleFireWitness extends ScheduledActivation {
	readonly scheduledAt: number;
	readonly coalescedThroughAt: number;
	readonly coalescedCount: number;
	readonly claimedAt: number;
	readonly nextFireAt: number | null;
	readonly state: "pending" | "claimed" | "completed" | "failed";
	readonly attempt: number;
}

interface ScheduleProof {
	readonly schedule: {
		readonly scheduleId: string;
		readonly sessionId: string;
		readonly nextFireAt: number | null;
		readonly state: "active" | "completed" | "cancelled";
	};
	readonly fires: readonly ScheduleFireWitness[];
}

interface SchedulerIntegration {
	createSchedule(
		runtime: WorkflowRuntimeStore,
		input: {
			readonly scheduleId: string;
			readonly requestId: string;
			readonly sessionId: string;
			readonly dueAt: number;
			readonly prompt: string;
			readonly now: number;
		},
	): Promise<ScheduleWitness>;
	makeService(input: {
		readonly runtime: WorkflowRuntimeStore;
		readonly consumer: string;
		readonly now: () => number;
		readonly activate: (activation: AgentSessionScheduleActivation) => Promise<void>;
	}): SchedulerService;
	readProof(runtime: WorkflowRuntimeStore, scheduleId: string): Promise<ScheduleProof>;
}

/** Keep storage vocabulary normalization at the organism boundary. */
function productionSchedulerIntegration(): SchedulerIntegration {
	return {
		async createSchedule(runtime, input) {
			const { schedule } = await runtime.createAgentSessionSchedule(input.sessionId, {
				requestId: input.requestId,
				scheduleId: input.scheduleId,
				definition: { kind: "once", fireAt: input.dueAt },
				prompt: { text: input.prompt },
				clientId: "arc-g1-local-proof",
				now: input.now,
			});
			assert.notEqual(schedule.next_fire_at, null);
			return {
				scheduleId: schedule.schedule_id,
				requestId: schedule.create_request_id,
				sessionId: schedule.session_id,
				nextFireAt: schedule.next_fire_at!,
			};
		},
		makeService(input) {
			return new AgentSessionSchedulerService({
				store: input.runtime,
				consumer: input.consumer,
				now: input.now,
				leaseMs: 60_000,
				idlePollMs: 60_000,
				commandSettleTimeoutMs: 60_000,
				activate: input.activate,
			});
		},
		async readProof(runtime, scheduleId) {
			const schedule = await runtime.readAgentSessionSchedule(SESSION_ID, scheduleId);
			assert.ok(schedule);
			const events = await runtime.listAgentSessionEvents(SESSION_ID);
			const fireRecords = await runtime.listAgentSessionScheduleFires(SESSION_ID, scheduleId);
			const fires = await Promise.all(
				fireRecords.map(async (fire): Promise<ScheduleFireWitness> => {
					const command = await runtime.readAgentSessionCommand(fire.command_id);
					assert.ok(command);
					const event = events.find(
						(candidate) =>
							candidate.type === "schedule.fired" &&
							(candidate.payload as { fireId?: unknown }).fireId === fire.fire_id,
					);
					assert.ok(event);
					const payload = event.payload as {
						claimedAt?: unknown;
						nextFireAt?: unknown;
					};
					return {
						scheduleId: fire.schedule_id,
						fireId: fire.fire_id,
						sessionId: fire.session_id,
						generation: fire.target_generation,
						activationId: fire.activation_id,
						commandId: fire.command_id,
						prompt: String(command.payload.text),
						scheduledAt: fire.scheduled_at,
						coalescedThroughAt: fire.coalesced_through_at,
						coalescedCount: fire.coalesced_count,
						claimedAt: requiredIsoTimestamp(payload.claimedAt, "schedule.fired claimedAt"),
						nextFireAt:
							payload.nextFireAt === null
								? null
								: requiredIsoTimestamp(payload.nextFireAt, "schedule.fired nextFireAt"),
						state: fire.state,
						attempt: fire.attempt,
					};
				}),
			);
			return {
				schedule: {
					scheduleId: schedule.schedule_id,
					sessionId: schedule.session_id,
					nextFireAt: schedule.next_fire_at,
					state: schedule.state,
				},
				fires,
			};
		},
	};
}

function requiredIsoTimestamp(value: unknown, label: string): number {
	if (typeof value !== "string") throw new Error(`${label} is absent`);
	const timestamp = Date.parse(value);
	if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error(`${label} is invalid`);
	return timestamp;
}

interface BodyWitness {
	readonly generation: number;
	readonly role: "worker" | "kernel";
	readonly sandboxId: string;
	readonly pid: number;
}

interface LocalHarness {
	readonly runtime: WorkflowRuntimeStore;
	readonly sandboxStore: SandboxStore;
	readonly memory: AgentMemory;
	readonly spawner: SandboxSpawner;
	readonly bodies: BodyWitness[];
}

async function createHarness(tempDir: string, bodies: BodyWitness[]): Promise<LocalHarness> {
	const sandboxStore = new SandboxStore(join(tempDir, "sandboxes.sqlite"));
	const runtime = new WorkflowRuntimeStore(join(tempDir, "runtime.sqlite"));
	await runtime.init();
	const memory = new AgentMemory(
		SophiaContentStore.fromUrl(pathToFileURL(`${join(tempDir, "memory")}/`).toString()),
		runtime,
	);
	const eventBus = createSandboxEventBus(sandboxStore, { cleanupDelayMs: 0 });
	const spawner = new SandboxSpawner(
		sandboxStore,
		{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
		{
			sandboxMode: "local-native",
			defaultTimeoutMs: 90_000,
			eventBus,
			agentMemory: memory,
			workflowRuntime: runtime,
			// The organism owns a separately injected logical clock. Prevent the
			// composition-root wall clock from becoming a second schedule claimant.
			schedulerService: dormantSchedulerService(),
		},
	);
	return { runtime, sandboxStore, memory, spawner, bodies };
}

function dormantSchedulerService(): AgentSessionSchedulerService {
	return {
		start: async () => {},
		wake: () => {},
		stop: async () => {},
	} as unknown as AgentSessionSchedulerService;
}

function makeSessionRunner(
	harness: LocalHarness,
	options: { readonly preserveMaterializationOnActivationFailure?: boolean } = {},
): NodeRunner {
	const eventBus = harness.spawner.bus!;
	const baseRunner = makeNodeRunner({
		spawner: harness.spawner,
		eventBus,
		authContext: {
			method: "internal_service",
			userId: OWNER_USER_ID,
			internalServiceSecret: "arc-g1-local-only",
		},
		ownerUserId: OWNER_USER_ID,
		mnemosyne: {
			mcpUrl: "disabled",
			ownerPrincipal: GRAPH_OWNER_PRINCIPAL,
			graphId: GRAPH_ID,
			capabilities: { reads: true, writes: false, dangerous_ops: false },
		},
		resolveCapabilityGrantPolicy: () => ({ exactTools: { mnemosyne: [] } }),
		onProcessSpawn: async ({ spec, sandboxId, pid }) => {
			harness.bodies.push({
				generation: spec.sandboxGeneration ?? 0,
				role: "worker",
				sandboxId,
				pid,
			});
			await harness.runtime.bindAgentSandbox(spec.sessionId!, {
				sandboxId,
				generation: spec.sandboxGeneration ?? 0,
				activationId: spec.invocationId!,
				now: Date.now(),
			});
		},
		onEvent: async ({ spec, event }) => {
			if ("category" in event && event.category === "execution" && event.type === "compute.cell") {
				await harness.runtime.appendExecutionCell(spec.sessionId!, spec.invocationId!, event.cell);
				const kernel = harness.sandboxStore.get(event.cell.kernelSandboxId);
				assert.ok(kernel?.pid, `kernel ${event.cell.kernelSandboxId} has no physical PID testimony`);
				harness.bodies.push({
					generation: spec.sandboxGeneration ?? 0,
					role: "kernel",
					sandboxId: event.cell.kernelSandboxId,
					pid: kernel.pid,
				});
				return;
			}
			const semanticEvent = mirrorAgentSessionEvent(event, spec);
			if (semanticEvent) {
				await harness.runtime.appendAgentSessionEventForGeneration(
					spec.sessionId!,
					spec.sandboxGeneration ?? 0,
					spec.invocationId!,
					semanticEvent,
				);
			}
		},
	});
	return makeRuntimeNodeRunner({
		runtime: harness.runtime,
		baseRunner,
		memory: harness.memory,
		runId: RUN_ID,
		workflowName: WORKFLOW_NAME,
		graphId: GRAPH_ID,
		ownerUserId: OWNER_USER_ID,
		graphOwnerPrincipal: GRAPH_OWNER_PRINCIPAL,
		preserveMaterializationOnActivationFailure: options.preserveMaterializationOnActivationFailure,
		onIdle: (spec) =>
			harness.spawner.scheduleAgentPassivation({
				sessionId: spec.sessionId!,
				generation: spec.sandboxGeneration ?? 0,
				ownerPrincipal: GRAPH_OWNER_PRINCIPAL,
				graphId: GRAPH_ID,
				runtimeBundleDigest: spec.runtime!.bundle.digest,
				idleMs: 0,
			}),
	});
}

function makePrimeSpec(): AgentNodeSpec {
	const semanticBase = makeTestAgentSemanticBinding({
		kind: "prime",
		graphId: GRAPH_ID,
		registeredName: "arc-g1-scheduled-agent",
		bundleDigest: digestSophiaAgentSourceTree(ENTRYPOINT!),
	});
	const runtime = {
		...semanticBase.runtime,
		constraints: { ...semanticBase.runtime.constraints, idlePassivateMs: 0, allowSchedules: true },
	};
	return {
		label: "arc-g1-scheduled-prime",
		phaseIndex: 1,
		nodeKey: NODE_KEY,
		sessionId: SESSION_ID,
		depth: 0,
		sandboxGeneration: 0,
		prompt: "Initialize the Arc G1 scheduled Prime.",
		model: "mock:resident_ipython",
		provider: "openrouter",
		graphId: GRAPH_ID,
		toolMode: "none",
		...semanticBase,
		runtime,
		runtimeBindingDigest: digestAgentRuntimeBinding(runtime),
	};
}

function generationSpec(
	base: AgentNodeSpec,
	generation: number,
	input: { readonly activationId: string; readonly prompt: string; readonly awaitInitialCommand?: true },
): AgentNodeSpec {
	return {
		...base,
		sandboxGeneration: generation,
		invocationId: input.activationId,
		prompt: input.prompt,
		awaitInitialCommand: input.awaitInitialCommand,
	};
}

async function createWorkflow(runtime: WorkflowRuntimeStore): Promise<void> {
	await runtime.createWorkflowInstance({
		runId: RUN_ID,
		workflowName: WORKFLOW_NAME,
		graphId: GRAPH_ID,
		ownerUserId: OWNER_USER_ID,
		inputs: {},
		startedAt: Date.now(),
	});
}

async function assertPassivated(harness: LocalHarness, generation: number): Promise<void> {
	await waitFor(
		async () => (await harness.runtime.readAgentMaterialization(SESSION_ID, generation))?.state === "passivated",
		`generation ${generation} did not passivate`,
	);
	const materialization = await harness.runtime.readAgentMaterialization(SESSION_ID, generation);
	assert.equal(materialization?.state, "passivated");
	assert.equal((await harness.runtime.readAgentSession(SESSION_ID))?.lifecycle_state, "open");
	assert.equal(harness.spawner.sessionBodyCount(SESSION_ID), 0);
}

function assertScheduleEventCausation(
	events: readonly AgentSessionEvent[],
	createdWitness: ScheduleWitness,
	fire: ScheduleFireWitness,
): void {
	const created = events.filter((event) => event.type === "schedule.created");
	const fired = events.filter((event) => event.type === "schedule.fired");
	assert.equal(created.length, 1);
	assert.equal(fired.length, 1);
	const createdEvent = created[0] as AgentSessionEvent & {
		causation_id: string | null;
		command_id: string | null;
	};
	const createdPayload = created[0]?.payload as {
		scheduleId?: unknown;
		requestId?: unknown;
	};
	assert.equal(createdEvent.causation_id, createdWitness.requestId);
	assert.equal(createdEvent.command_id, null);
	assert.equal(createdPayload.scheduleId, SCHEDULE_ID);
	assert.equal(createdPayload.requestId, createdWitness.requestId);
	const firedEvent = fired[0] as AgentSessionEvent & {
		causation_id: string | null;
		command_id: string | null;
	};
	const firedPayload = fired[0]?.payload as {
		scheduleId?: unknown;
		fireId?: unknown;
		commandId?: unknown;
		scheduledAt?: unknown;
	};
	assert.equal(firedEvent.causation_id, fire.fireId);
	assert.equal(firedEvent.command_id, fire.commandId);
	assert.equal(firedPayload.scheduleId, SCHEDULE_ID);
	assert.equal(firedPayload.fireId, fire.fireId);
	assert.equal(firedPayload.commandId, fire.commandId);
	assert.equal(Date.parse(String(firedPayload.scheduledAt)), fire.scheduledAt);
}

function assertScheduledFirstStimulus(events: readonly AgentSessionEvent[], fire: ScheduleFireWitness): void {
	const scheduledPrompts = events.filter((event) => {
		if (event.type !== "input.prompt") return false;
		const payload = event.payload as { value?: { text?: unknown; commandId?: unknown } };
		return payload.value?.text === SCHEDULED_PROMPT && payload.value.commandId === fire.commandId;
	});
	assert.equal(scheduledPrompts.length, 1, "scheduled first stimulus must enter Prime exactly once");
	const prompt = scheduledPrompts[0]!;
	const fired = events.filter(
		(event) => event.type === "schedule.fired" && JSON.stringify(event.payload).includes(fire.fireId),
	);
	assert.equal(fired.length, 1);
	assert.equal(fired[0]!.seq < prompt.seq, true, "scheduled prompt arrived before its durable fire testimony");
	assert.deepEqual(
		events
			.filter((event) => event.seq > fired[0]!.seq && event.seq < prompt.seq)
			.filter((event) => event.type.startsWith("input.") || event.type.startsWith("turn.")),
		[],
		"await_initial_command restore fabricated semantic work before the durable prompt",
	);
	const resumed = events.filter(
		(event) =>
			event.type === "runtime.resumed" && (event.payload as { generation?: unknown }).generation === fire.generation,
	);
	assert.equal(resumed.length, 1, "scheduled activation must restore exactly one generation");
	const firstTurn = events.find((event) => event.seq > fired[0]!.seq && event.type === "turn.started");
	assert.ok(firstTurn);
	assert.equal(prompt.seq < firstTurn.seq, true, "Prime began a turn before the scheduled prompt");
	const completed = events.filter(
		(event) => event.type === "command.completed" && JSON.stringify(event.payload).includes(fire.commandId),
	);
	assert.equal(completed.length, 1, "the scheduled command must produce one exact durable result");
}

function assertVehicleFollowUpFirstStimulus(events: readonly AgentSessionEvent[]): void {
	const accepted = events.filter(
		(event) =>
			event.type === "command.accepted" &&
			(event.payload as { commandId?: unknown }).commandId === VEHICLE_FOLLOW_UP_COMMAND_ID,
	);
	assert.equal(accepted.length, 1);
	const followUps = events.filter((event) => {
		if (event.type !== "input.follow_up") return false;
		const payload = event.payload as { value?: { text?: unknown; commandId?: unknown } };
		return payload.value?.text === VEHICLE_FOLLOW_UP && payload.value.commandId === VEHICLE_FOLLOW_UP_COMMAND_ID;
	});
	assert.equal(followUps.length, 1, "Vehicle follow-up must enter the restored Prime exactly once");
	assert.equal(accepted[0]!.seq < followUps[0]!.seq, true);
	assert.deepEqual(
		events
			.filter((event) => event.seq > accepted[0]!.seq && event.seq < followUps[0]!.seq)
			.filter((event) => event.type.startsWith("input.") || event.type.startsWith("turn.")),
		[],
		"command-first restore fabricated semantic work before the Vehicle follow-up",
	);
	const firstTurn = events.find((event) => event.seq > accepted[0]!.seq && event.type === "turn.started");
	assert.ok(firstTurn);
	assert.equal(followUps[0]!.seq < firstTurn.seq, true, "Prime began a turn before the durable Vehicle follow-up");
	const completed = events.filter(
		(event) =>
			event.type === "command.completed" && JSON.stringify(event.payload).includes(VEHICLE_FOLLOW_UP_COMMAND_ID),
	);
	assert.equal(completed.length, 1, "Vehicle follow-up must produce one exact durable result");
}

function assertScheduledCommandCompleted(command: AgentSessionCommandRecord | null, fire: ScheduleFireWitness): void {
	assert.ok(command);
	assert.equal(command.command_id, fire.commandId);
	assert.equal(command.session_id, SESSION_ID);
	assert.equal(command.name, "prompt");
	assert.equal(command.payload.text, SCHEDULED_PROMPT);
	assert.equal(command.target_generation, 1);
	assert.equal(command.delivery_generation, 1);
	assert.equal(command.state, "completed", command.error ?? "scheduled command did not complete");
	assert.match(JSON.stringify(command.result), /Resident Prime command completed/);
}

function assertScheduledSessionResult(session: AgentSessionRecord | null): void {
	assert.ok(session?.result_json);
	const result = JSON.parse(session.result_json) as {
		state?: unknown;
		output?: unknown;
		agentCheckpoint?: { manifest?: { generation?: unknown } };
	};
	assert.equal(result.state, "done");
	assert.equal(result.output, "Resident Prime command completed.");
	assert.equal(result.agentCheckpoint?.manifest?.generation, 1);
}

async function assertSingleCheckpointAndPassivation(
	runtime: WorkflowRuntimeStore,
	events: readonly AgentSessionEvent[],
	generation: number,
): Promise<void> {
	const checkpoint = await runtime.readLatestAgentCheckpoint(SESSION_ID);
	assert.equal(checkpoint?.manifest.generation, generation);
	const checkpointOps = (await runtime.listAgentSessionDocumentOps(SESSION_ID)).filter(
		(op) =>
			op.kind === "agent-checkpoint.committed" &&
			JSON.stringify(op.patch).includes(checkpoint!.manifest.checkpointId),
	);
	assert.equal(checkpointOps.length, 1, `generation ${generation} committed its Prime checkpoint more than once`);
	const lifecycle = (type: string) =>
		events.filter(
			(event) => event.type === type && (event.payload as { generation?: unknown }).generation === generation,
		);
	assert.equal(lifecycle("runtime.quiescing").length, 1);
	assert.equal(lifecycle("runtime.quiescent").length, 1);
	assert.equal(lifecycle("runtime.passivated").length, 1, `generation ${generation} passivated more than once`);
}

function assertBodyPairPassivated(bodies: readonly BodyWitness[], generation: number): void {
	const generationBodies = uniqueBodies(bodies).filter((body) => body.generation === generation);
	assert.deepEqual(
		generationBodies.map((body) => body.role).sort(),
		["kernel", "worker"],
		`generation ${generation} must materialize exactly one worker+kernel pair`,
	);
	for (const body of generationBodies) {
		assert.equal(isProcessAlive(body.pid), false, `${body.role} PID ${body.pid} survived passivation`);
	}
}

function captureGenerationBodies(
	harness: LocalHarness,
	bodies: BodyWitness[],
	generation: number,
	baseline: ReadonlySet<string>,
): void {
	const records = harness.sandboxStore
		.list()
		.filter((record) => !baseline.has(record.sandbox_id))
		.sort((left, right) => left.sandbox_id.localeCompare(right.sandbox_id));
	assert.deepEqual(
		records.map((record) => record.template).sort(),
		["agent", "bare"],
		`generation ${generation} must create one Prime worker and one kernel sandbox`,
	);
	for (const record of records) {
		assert.ok(record.pid, `sandbox ${record.sandbox_id} has no physical PID testimony`);
		bodies.push({
			generation,
			role: record.template === "agent" ? "worker" : "kernel",
			sandboxId: record.sandbox_id,
			pid: record.pid,
		});
	}
}

function uniqueBodies(bodies: readonly BodyWitness[]): BodyWitness[] {
	const unique = new Map<string, BodyWitness>();
	for (const body of bodies) unique.set(`${body.generation}:${body.role}:${body.sandboxId}`, body);
	return [...unique.values()].sort((left, right) =>
		`${left.generation}:${left.role}:${left.sandboxId}`.localeCompare(
			`${right.generation}:${right.role}:${right.sandboxId}`,
		),
	);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function waitFor(check: () => boolean | Promise<boolean>, message: string, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await delay(10);
	}
	throw new Error(message);
}

async function waitForValue<T>(
	read: () => T | undefined | Promise<T | undefined>,
	message: string,
	timeoutMs = 30_000,
): Promise<T> {
	let value: T | undefined;
	await waitFor(
		async () => {
			value = await read();
			return value !== undefined;
		},
		message,
		timeoutMs,
	);
	return value!;
}

async function closeHarness(harness: LocalHarness): Promise<void> {
	await harness.spawner.shutdownAll();
	harness.runtime.close();
	harness.sandboxStore.close();
}
