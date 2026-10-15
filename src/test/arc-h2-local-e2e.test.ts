import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { MEANINGFUL_OBJECT_REF_SCHEMA } from "../agent-runtime/meaningful-object.js";
import { digestAgentOntologyBinding } from "../agent-runtime/ontology-binding.js";
import { digestAgentRuntimeBinding } from "../agent-runtime/profile.js";
import { mirrorAgentSessionEvent } from "../agent-runtime/session-event-mirror.js";
import { digestSophiaAgentSourceTree } from "../runtime-bundles.js";
import { makeNodeRunner } from "../workflow/run-node.js";
import { makeRuntimeNodeRunner } from "../workflow/runtime-control.js";
import type { AgentSessionEvent, WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import type { AgentNodeSpec, NodeRunner } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";
import { closeLocalHarness, createLocalHarness, type LocalHarness } from "./arc-f6-phanes-local-support.js";

const ENTRYPOINT = process.env.SOPHIA_AGENT_RUNTIME_ENTRYPOINT?.trim();
const BRIDGE = process.env.SOPHIA_JUPYTER_BRIDGE_PATH?.trim();
const PYTHON = process.env.SOPHIA_PRIME_KERNEL_PYTHON?.trim();
const LOCAL_RUNTIME_SKIP =
	!ENTRYPOINT || !existsSync(ENTRYPOINT) || !BRIDGE || !existsSync(BRIDGE) || !PYTHON || !existsSync(PYTHON)
		? "set the Prime H worker, Jupyter bridge, and kernel Python paths"
		: false;

const GRAPH_ID = "arc-h2-local-proof";
const GRAPH_OWNER_PRINCIPAL = "organization:arc-h2-local-proof";
const OWNER_USER_ID = "user:arc-h2-local-proof";
const RUN_ID = "arc-h2-local-e2e";
const WORKFLOW_NAME = "arc-h2-goal-compost-proof";
const SESSION_ID = "agent-session:arc-h2-local-e2e";
const NODE_KEY = "arc-h2-goal-prime";
const CREATE_COMMAND_ID = "goal:create:arc-h2-generation-0";
const COMPLETE_COMMAND_ID = "goal:complete:arc-h2-generation-1";
const GOAL_OBJECTIVE = "Complete the one durable Arc H2 organism goal without a model turn.";

interface BodyWitness {
	readonly generation: number;
	readonly role: "worker" | "kernel";
	readonly sandboxId: string;
	readonly pid: number;
}

describe("Arc H2 command-first goal compost organism", { concurrency: false }, () => {
	it(
		"completes one restored goal without fabricating a prompt, turn, tool, or execution cell",
		{ skip: LOCAL_RUNTIME_SKIP, timeout: 180_000 },
		async () => {
			const tempDir = mkdtempSync(join(tmpdir(), "choreograph-arc-h2-e2e-"));
			const bodies: BodyWitness[] = [];
			let host: LocalHarness | undefined;
			try {
				host = await createLocalHarness(tempDir, "arc-h2-host-a");
				await host.spawner.start();
				await createWorkflow(host.runtime);
				const runner = makeSessionRunner(host, bodies);
				const generation0 = runner(generationSpec(makePrimeSpec(), 0, `${SESSION_ID}:generation:0`));
				const worker0 = await waitForValue(
					() =>
						[...host!.spawner.getActive().values()].find(
							(active) => active.agentRequest?.session_id === SESSION_ID && active.agentRequest.generation === 0,
						),
					"generation 0 did not become resident",
				);
				const created = await host.runtime.submitAgentSessionCommand(SESSION_ID, {
					commandId: CREATE_COMMAND_ID,
					idempotencyKey: CREATE_COMMAND_ID,
					name: "goal.create",
					payload: { objective: GOAL_OBJECTIVE, tokenBudget: 12 },
					clientId: "arc-h2-host-a",
					now: Date.now(),
				});
				assert.ok(created?.accepted);
				await host.spawner.drainAgentSessionCommands(worker0.record.sandbox_id);
				const initialResult = await generation0;
				assert.equal(initialResult.state, "done");
				assert.ok(initialResult.agentCheckpoint);
				await assertPassivated(host, 0);
				captureGenerationBodies(host, bodies, 0, new Set());
				assertBodiesPassivated(host, bodies, 0);
				const goalId = (await host.runtime.readAgentSessionGoalProjection(SESSION_ID))?.reducer_state.currentGoalId;
				assert.ok(goalId, "generation 0 goal.create did not establish the host reducer goal");

				const eventsBeforeCompletion = await host.runtime.listAgentSessionEvents(SESSION_ID);
				const bodiesBeforeCompletion = new Set(host.sandboxStore.list().map((record) => record.sandbox_id));
				const completed = await host.runtime.submitAgentSessionCommand(SESSION_ID, {
					commandId: COMPLETE_COMMAND_ID,
					idempotencyKey: COMPLETE_COMMAND_ID,
					name: "goal.complete",
					payload: {},
					clientId: "arc-h2-host-a",
					now: Date.now(),
				});
				assert.ok(completed?.accepted, JSON.stringify(completed));
				assert.equal(completed.record.target_generation, 1);
				host.spawner.wakeDurableSupervision();
				const settled = await waitForValue(async () => {
					const command = await host!.runtime.readAgentSessionCommand(COMPLETE_COMMAND_ID);
					return command?.state === "completed" || command?.state === "failed" || command?.state === "cancelled"
						? command
						: undefined;
				}, "restored goal.complete did not settle");
				assert.equal(settled.state, "completed", settled.error ?? "goal.complete failed");
				assert.equal(settled.delivery_generation, 1);
				await assertPassivated(host, 1);
				captureGenerationBodies(host, bodies, 1, bodiesBeforeCompletion);

				const events = await host.runtime.listAgentSessionEvents(SESSION_ID);
				assertGoalCompleteChronology(eventsBeforeCompletion, events);
				const projection = await host.runtime.readAgentSessionGoalProjection(SESSION_ID);
				assert.equal(projection?.reducer_state.goals[goalId]?.status, "complete");
				const hostGoalUpdates = events.filter(
					(event) =>
						event.type === "goal.updated" &&
						(event.payload as { source?: unknown }).source === "host-reducer" &&
						event.command_id === COMPLETE_COMMAND_ID,
				);
				assert.equal(hostGoalUpdates.length, 1, "completion must append one sole host goal.updated fact");
				assert.equal(
					projection?.reducer_state.receipts[COMPLETE_COMMAND_ID]?.eventSequence,
					hostGoalUpdates[0]?.seq,
				);
				assert.equal(
					events.some((event) => event.type === "goal_update" && event.seq > eventsBeforeCompletion.at(-1)!.seq),
					false,
					"the H completion witness must not enter the opaque mirror",
				);
				assert.equal(await host.runtime.listExecutionJournal(SESSION_ID).then((cells) => cells.length), 0);
				await assertSingleCheckpointAndPassivation(host.runtime, events, 1);
				assertBodiesPassivated(host, bodies, 1);
				assert.equal(host.spawner.sessionBodyCount(SESSION_ID), 0);

				const durableEvents = structuredClone(events);
				const durableJournal = structuredClone(await host.runtime.listExecutionJournal(SESSION_ID));
				const durableBodies = uniqueBodies(bodies);
				const checkpoint = await host.runtime.readLatestAgentCheckpoint(SESSION_ID);
				assert.ok(checkpoint);
				await closeLocalHarness(host);
				host = undefined;

				host = await createLocalHarness(tempDir, "arc-h2-host-c");
				await host.spawner.start();
				await delay(100);
				assert.equal(await host.runtime.readAgentMaterialization(SESSION_ID, 2), null);
				assert.equal(host.spawner.sessionBodyCount(SESSION_ID), 0);
				assert.deepEqual(await host.runtime.listAgentSessionEvents(SESSION_ID), durableEvents);
				assert.deepEqual(await host.runtime.listExecutionJournal(SESSION_ID), durableJournal);
				assert.deepEqual(uniqueBodies(bodies), durableBodies);
				assert.equal(
					(await host.runtime.readLatestAgentCheckpoint(SESSION_ID))?.manifest.checkpointId,
					checkpoint.manifest.checkpointId,
				);
				assert.equal(
					(await host.runtime.readAgentSessionCommandActivation(COMPLETE_COMMAND_ID))?.state,
					"completed",
				);
				assert.equal((await host.runtime.readAgentSessionCommandActivation(COMPLETE_COMMAND_ID))?.attempt, 1);
			} finally {
				if (host) await closeLocalHarness(host).catch(() => {});
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	);
});

function makeSessionRunner(harness: LocalHarness, bodies: BodyWitness[]): NodeRunner {
	const baseRunner = makeNodeRunner({
		spawner: harness.spawner,
		eventBus: harness.spawner.bus!,
		authContext: {
			method: "internal_service",
			userId: OWNER_USER_ID,
			internalServiceSecret: "arc-h2-local-only",
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
			bodies.push({ generation: spec.sandboxGeneration ?? 0, role: "worker", sandboxId, pid });
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
				assert.ok(kernel?.pid, "kernel event lacks PID testimony");
				bodies.push({
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
	const semantic = makeTestAgentSemanticBinding({
		kind: "prime",
		graphId: GRAPH_ID,
		registeredName: "arc-h2-goal-agent",
		bundleDigest: digestSophiaAgentSourceTree(ENTRYPOINT!),
	});
	const runtime = {
		...semantic.runtime,
		constraints: { ...semantic.runtime.constraints, idlePassivateMs: 0 },
	};
	const ontology = {
		...semantic.ontology,
		objects: {
			...semantic.ontology.objects,
			skills: [
				{
					schema: MEANINGFUL_OBJECT_REF_SCHEMA,
					kind: "skill" as const,
					ownerPrincipal: "user:test",
					graphId: GRAPH_ID,
					objectId: "goal",
					version: "1",
					digest: `sha256:${"a".repeat(64)}`,
				},
			],
		},
	};
	return {
		label: "arc-h2-goal-prime",
		phaseIndex: 1,
		nodeKey: NODE_KEY,
		sessionId: SESSION_ID,
		depth: 0,
		sandboxGeneration: 0,
		prompt: "Await the durable Arc H2 goal command before any model turn.",
		model: "mock:resident_ipython",
		provider: "openrouter",
		graphId: GRAPH_ID,
		toolMode: "none",
		...semantic,
		runtime,
		runtimeBindingDigest: digestAgentRuntimeBinding(runtime),
		ontology,
		ontologyBindingDigest: digestAgentOntologyBinding(ontology),
	};
}

function generationSpec(base: AgentNodeSpec, generation: number, activationId: string): AgentNodeSpec {
	return {
		...base,
		sandboxGeneration: generation,
		invocationId: activationId,
		awaitInitialCommand: true,
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
	assert.equal(harness.spawner.sessionBodyCount(SESSION_ID), 0);
}

function assertGoalCompleteChronology(before: readonly AgentSessionEvent[], after: readonly AgentSessionEvent[]): void {
	const firstNew = after.find((event) => event.seq > (before.at(-1)?.seq ?? -1));
	assert.ok(firstNew);
	const commandAccepted = after.find(
		(event) =>
			event.type === "command.accepted" &&
			(event.payload as { commandId?: unknown }).commandId === COMPLETE_COMMAND_ID,
	);
	const hostGoal = after.find((event) => event.type === "goal.updated" && event.command_id === COMPLETE_COMMAND_ID);
	const commandCompleted = after.find(
		(event) =>
			event.type === "command.completed" &&
			(event.payload as { commandId?: unknown }).commandId === COMPLETE_COMMAND_ID,
	);
	assert.ok(commandAccepted && hostGoal && commandCompleted);
	assert.equal(commandAccepted.seq < hostGoal.seq, true);
	assert.equal(hostGoal.seq < commandCompleted.seq, true);
	assert.deepEqual(
		after
			.filter((event) => event.seq > commandAccepted.seq && event.seq < commandCompleted.seq)
			.filter(
				(event) =>
					["input.prompt", "input.follow_up", "input.steer"].includes(event.type) ||
					event.type.startsWith("turn.") ||
					event.type.startsWith("tool."),
			),
		[],
		"goal.complete must be the first semantic activation stimulus",
	);
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
	assert.equal(checkpointOps.length, 1);
	for (const type of ["runtime.quiescing", "runtime.quiescent", "runtime.passivated"] as const) {
		assert.equal(
			events.filter(
				(event) => event.type === type && (event.payload as { generation?: unknown }).generation === generation,
			).length,
			1,
		);
	}
}

function captureGenerationBodies(
	harness: LocalHarness,
	bodies: BodyWitness[],
	generation: number,
	baseline: ReadonlySet<string>,
): void {
	const records = harness.sandboxStore.list().filter((record) => !baseline.has(record.sandbox_id));
	assert.deepEqual(records.map((record) => record.template).sort(), ["agent", "bare"]);
	for (const record of records) {
		assert.ok(record.pid, `sandbox ${record.sandbox_id} has no PID testimony`);
		bodies.push({
			generation,
			role: record.template === "agent" ? "worker" : "kernel",
			sandboxId: record.sandbox_id,
			pid: record.pid,
		});
	}
}

function assertBodiesPassivated(harness: LocalHarness, bodies: readonly BodyWitness[], generation: number): void {
	const generationBodies = uniqueBodies(bodies).filter((body) => body.generation === generation);
	assert.deepEqual(generationBodies.map((body) => body.role).sort(), ["kernel", "worker"]);
	assert.equal(harness.spawner.getKernelLeaseForSession(SESSION_ID), undefined);
	for (const body of generationBodies)
		assert.equal(isProcessAlive(body.pid), false, `${body.role} survived passivation`);
}

function uniqueBodies(bodies: readonly BodyWitness[]): BodyWitness[] {
	const unique = new Map<string, BodyWitness>();
	for (const body of bodies) unique.set(`${body.generation}:${body.role}:${body.sandboxId}`, body);
	return [...unique.values()].sort((left, right) => left.sandboxId.localeCompare(right.sandboxId));
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
