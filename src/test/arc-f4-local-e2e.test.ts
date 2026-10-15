import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { SophiaContentStore } from "../agent-runtime/content-store.js";
import { AgentMemory } from "../agent-runtime/memory.js";
import { digestAgentRuntimeBinding } from "../agent-runtime/profile.js";
import { mintAgentSessionUri } from "../agent-subject/agent-ontology.js";
import { createSandboxEventBus } from "../event-bus.js";
import { digestSophiaAgentSourceTree } from "../runtime-bundles.js";
import { SandboxStore } from "../sandbox-store.js";
import { SandboxSpawner } from "../spawner.js";
import { makeNodeRunner } from "../workflow/run-node.js";
import { makeRuntimeNodeRunner } from "../workflow/runtime-control.js";
import {
	type AgentSessionChildSpawnRequestRecord,
	type AgentSessionCommandRecord,
	type AgentSessionFamilyProjectionSnapshot,
	WorkflowRuntimeStore,
} from "../workflow/runtime-store.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

const ENTRYPOINT = process.env.SOPHIA_AGENT_RUNTIME_ENTRYPOINT?.trim();
const BRIDGE = process.env.SOPHIA_JUPYTER_BRIDGE_PATH?.trim();
const PYTHON = process.env.SOPHIA_PRIME_KERNEL_PYTHON?.trim();
const LIVE_GRAPH_ID = process.env.ARC_F4_E2E_GRAPH_ID?.trim();
const LIVE_USER_ID = process.env.ARC_F4_E2E_USER_ID?.trim();
const LIVE_MCP_URL = process.env.ARC_F4_E2E_MCP_URL?.trim();
const LIVE_SESSION_ID = process.env.ARC_F4_E2E_SESSION_ID?.trim();
const LOCAL_RUNTIME_SKIP =
	!ENTRYPOINT || !existsSync(ENTRYPOINT) || !BRIDGE || !existsSync(BRIDGE) || !PYTHON || !existsSync(PYTHON)
		? "set the Prime worker, Jupyter bridge, and kernel Python paths"
		: false;
const liveCoordinates = [LIVE_GRAPH_ID, LIVE_USER_ID, LIVE_MCP_URL, LIVE_SESSION_ID];
if (liveCoordinates.some(Boolean) && !liveCoordinates.every(Boolean)) {
	throw new Error(
		"ARC_F4_E2E_GRAPH_ID, ARC_F4_E2E_USER_ID, ARC_F4_E2E_MCP_URL, and ARC_F4_E2E_SESSION_ID must be supplied together",
	);
}

const CHILD_COST_USD_MICROS = 500_000;
const PARENT_COST_USD_MICROS = 2_000_000;

describe("Arc F4 durable family-budget organism", { concurrency: false }, () => {
	it(
		"enforces lifetime, generation occupancy, cost carve-outs, replay, and projection around real resident Prime pairs",
		{ skip: LOCAL_RUNTIME_SKIP, timeout: 180_000 },
		async () => {
			const tempDir = mkdtempSync(join(tmpdir(), "choreograph-arc-f4-e2e-"));
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
					defaultTimeoutMs: 60_000,
					eventBus,
					agentMemory: memory,
					workflowRuntime: runtime,
				},
			);

			try {
				const runId = "arc-f4-local-e2e";
				const workflowName = "domain-agent-activity-loop-v1";
				const parentSessionId = LIVE_SESSION_ID ?? "ags_arc_f4_parent";
				const graphId = LIVE_GRAPH_ID ?? "arc-f4-proof";
				const ownerUserId = LIVE_USER_ID ?? "user:arc-f4-proof";
				const bundleDigest = digestSophiaAgentSourceTree(ENTRYPOINT!);
				const pilotBase = makeTestAgentSemanticBinding({
					kind: "prime",
					graphId,
					registeredName: "arc-f4-agent",
					bundleDigest,
				});
				const pilotRuntime = {
					...pilotBase.runtime,
					constraints: {
						...pilotBase.runtime.constraints,
						maxChildren: 2,
						maxConcurrentChildren: 1,
						maxCostUsdMicros: PARENT_COST_USD_MICROS,
					},
				};
				const pilot = {
					...pilotBase,
					runtime: pilotRuntime,
					runtimeBindingDigest: digestAgentRuntimeBinding(pilotRuntime),
				};
				const emanationBase = makeTestAgentSemanticBinding({
					kind: "prime",
					graphId,
					registeredName: "arc-f4-agent",
					bundleDigest,
				});
				const emanationRuntime = {
					...emanationBase.runtime,
					constraints: {
						...emanationBase.runtime.constraints,
						maxTurns: 6,
						maxWallTimeMs: 300_000,
						maxTokens: 20_000,
						maxCostUsdMicros: CHILD_COST_USD_MICROS,
						maxChildren: 0,
						maxChildDepth: 0,
						maxConcurrentChildren: 0,
						maxArtifactBytes: 134_217_728,
					},
				};
				const emanation = {
					...emanationBase,
					runtime: emanationRuntime,
					runtimeBindingDigest: digestAgentRuntimeBinding(emanationRuntime),
				};
				await runtime.createWorkflowInstance({
					runId,
					workflowName,
					graphId,
					ownerUserId,
					inputs: {
						hostContext: {
							schema: "sophia.domain-agent-host-context.v1",
							runtimes: { pilot: pilot.runtime, emanation: emanation.runtime },
							ontologies: { pilot: pilot.ontology, emanation: emanation.ontology },
							emanation: {
								enabled: true,
								provider: "openrouter",
								model: "mock:resident_ipython",
								maxEmanations: 2,
								maxTurns: emanation.runtime.constraints.maxTurns,
							},
							emanationToolInclude: [],
							systemPrompt: "You are a resident, budgeted Arc F4 child.",
							toolbelt: { tools: [] },
						},
					},
					startedAt: Date.now(),
				});

				const baseRunner = makeNodeRunner({
					spawner,
					eventBus,
					authContext: {
						method: "internal_service",
						userId: ownerUserId,
						internalServiceSecret: "local-proof-only",
					},
					ownerUserId,
					mnemosyne: {
						mcpUrl: LIVE_MCP_URL ?? "disabled",
						ownerPrincipal: ownerUserId.startsWith("user:") ? ownerUserId : `user:${ownerUserId}`,
						graphId,
						capabilities: { reads: true, writes: false, dangerous_ops: false },
					},
					resolveCapabilityGrantPolicy: () => ({ exactTools: { mnemosyne: [] } }),
					onEnqueue: ({ spec, sandboxId, queuedAt }) =>
						runtime.bindAgentSandbox(spec.sessionId!, {
							sandboxId,
							generation: spec.sandboxGeneration ?? 0,
							activationId: spec.invocationId!,
							now: queuedAt,
						}),
					onEvent: async ({ spec, event }) => {
						if ("category" in event && event.category === "execution" && event.type === "compute.cell") {
							await runtime.appendExecutionCell(spec.sessionId!, spec.invocationId!, event.cell);
						}
					},
				});
				const runner = makeRuntimeNodeRunner({
					runtime,
					baseRunner,
					memory,
					runId,
					workflowName,
					graphId,
					ownerUserId,
				});
				const parentSpec: AgentNodeSpec = {
					label: "arc-f4-parent",
					phaseIndex: 1,
					nodeKey: "arc-f4-parent",
					sessionId: parentSessionId,
					depth: 0,
					sandboxGeneration: 0,
					prompt: "Drive the first step of the durable Arc F4 child-budget scenario.",
					model: "mock:rlm_f4",
					provider: "openrouter",
					graphId,
					maxTurns: pilot.runtime.constraints.maxTurns,
					toolMode: "none",
					...pilot,
				};

				const parentResult = await runner(parentSpec);
				assert.equal(parentResult.state, "done");
				const parentMaterialization = await runtime.readAgentMaterialization(parentSessionId, 0);
				assert.ok(parentMaterialization);
				const parentLease = spawner.getKernelLeaseForSession(parentSessionId);
				assert.ok(parentLease);
				assert.equal(spawner.sessionBodyCount(parentSessionId), 2);

				const first = await waitForResidentChild(runtime, parentSessionId, "prime-child-one");
				assert.equal(spawner.sessionBodyCount(first.sessionId), 2);
				await assertFamilyBudget(runtime, parentSessionId, {
					directAcceptedChildren: 1,
					occupiedChildren: 1,
					reservedCostUsdMicros: CHILD_COST_USD_MICROS,
				});

				await runParentPrompt(
					runtime,
					spawner,
					parentSessionId,
					parentMaterialization.sandbox_id,
					"arc-f4:concurrency-denial",
					"Attempt the concurrent child and retain the durable denial.",
				);
				const concurrencyDenial = await findChildDenial(
					runtime,
					parentSessionId,
					"max_concurrent_children_exhausted",
				);
				const replay = await runtime.admitAgentSessionChild(parentSessionId, {
					requestId: concurrencyDenial.request_id,
					parentGeneration: 0,
					parentActivationId: parentMaterialization.activation_id,
					parentSandboxId: parentMaterialization.sandbox_id,
					prompt: "This child must be denied while the first resident generation occupies capacity.",
					requestedName: "blocked-prime-child",
					requestedModel: "mock:resident_ipython",
					causationId: concurrencyDenial.request_id,
					now: Date.now(),
				});
				assert.equal(replay.decision, "denied");
				assert.equal(replay.created, false);
				if (replay.decision === "denied") {
					assert.equal(replay.request.denial_code, "max_concurrent_children_exhausted");
				}
				await assertFamilyBudget(runtime, parentSessionId, {
					directAcceptedChildren: 1,
					occupiedChildren: 1,
					reservedCostUsdMicros: CHILD_COST_USD_MICROS,
				});

				await passivateChild(spawner, first.sessionId, ownerUserId, graphId, emanation.runtime.bundle.digest);
				await assertFamilyBudget(runtime, parentSessionId, {
					directAcceptedChildren: 1,
					occupiedChildren: 0,
					reservedCostUsdMicros: CHILD_COST_USD_MICROS,
				});

				await runParentPrompt(
					runtime,
					spawner,
					parentSessionId,
					parentMaterialization.sandbox_id,
					"arc-f4:second-child",
					"Use the released generation slot for the second lifetime child.",
				);
				const second = await waitForResidentChild(runtime, parentSessionId, "prime-child-two");
				assert.notEqual(second.sessionId, first.sessionId);
				assert.equal(spawner.sessionBodyCount(second.sessionId), 2);
				await assertFamilyBudget(runtime, parentSessionId, {
					directAcceptedChildren: 2,
					occupiedChildren: 1,
					reservedCostUsdMicros: CHILD_COST_USD_MICROS * 2,
				});

				await runParentPrompt(
					runtime,
					spawner,
					parentSessionId,
					parentMaterialization.sandbox_id,
					"arc-f4:lifetime-denial",
					"Attempt a third distinct child and retain the lifetime denial.",
				);
				const lifetimeDenial = await findChildDenial(runtime, parentSessionId, "max_children_exhausted");
				assert.equal(lifetimeDenial.decision, "denied");
				const atLifetimeLimit = await assertFamilyBudget(runtime, parentSessionId, {
					directAcceptedChildren: 2,
					occupiedChildren: 1,
					reservedCostUsdMicros: CHILD_COST_USD_MICROS * 2,
				});
				assert.equal(atLifetimeLimit.children.length, 2);
				for (const child of atLifetimeLimit.children) {
					assert.equal(child.admission?.allocationState, "reserved");
					assert.equal(child.admission?.settledActualCostUsdMicros, null);
					assert.equal(child.admission?.budget.maxCostUsdMicros, CHILD_COST_USD_MICROS);
				}

				await passivateChild(spawner, second.sessionId, ownerUserId, graphId, emanation.runtime.bundle.digest);
				const finalFamily = await assertFamilyBudget(runtime, parentSessionId, {
					directAcceptedChildren: 2,
					occupiedChildren: 0,
					reservedCostUsdMicros: CHILD_COST_USD_MICROS * 2,
				});
				assert.equal(
					spawner.sessionBodyCount(parentSessionId),
					2,
					"child lifecycle must not disturb the parent pair",
				);
				assert.equal(spawner.getKernelLeaseForSession(parentSessionId)?.leaseId, parentLease.leaseId);
				if (LIVE_MCP_URL) {
					const [parentCells, firstChildCells, secondChildCells] = await Promise.all([
						runtime.listExecutionJournal(parentSessionId),
						runtime.listExecutionJournal(first.sessionId),
						runtime.listExecutionJournal(second.sessionId),
					]);
					assert.equal(parentCells.length, 4);
					assert.equal(firstChildCells.length, 1);
					assert.equal(secondChildCells.length, 1);
					assert.match(JSON.stringify(firstChildCells[0]?.outputs), /resident value 1/);
					assert.match(JSON.stringify(secondChildCells[0]?.outputs), /resident value 1/);
					const parentOutputs = JSON.stringify(parentCells.map((cell) => cell.outputs));
					for (const evidence of [
						"F4 first child admitted",
						"F4 concurrency denial durable",
						"F4 second child admitted",
						"F4 lifetime denial durable",
					]) {
						assert.match(parentOutputs, new RegExp(evidence));
					}
					assert.ok(finalFamily.root.agentId);
					console.log(
						JSON.stringify({
							schema: "choreograph.arc-f4-live-receipt.v1",
							graphId,
							parentSessionId,
							rootAgentId: finalFamily.root.agentId,
							familyRootSessionIri: mintAgentSessionUri(finalFamily.root.agentId, parentSessionId),
							children: [
								{
									sessionId: first.sessionId,
									name: "prime-child-one",
									childRunId: first.childRunId,
								},
								{
									sessionId: second.sessionId,
									name: "prime-child-two",
									childRunId: second.childRunId,
								},
							],
							ledger: {
								directAcceptedChildren: finalFamily.root.directAcceptedChildren,
								maxChildren: finalFamily.root.maxChildren,
								occupiedChildren: finalFamily.root.occupiedChildren,
								maxConcurrentChildren: finalFamily.root.maxConcurrentChildren,
								spentCostUsdMicros: finalFamily.root.budgetCostSpentUsdMicros,
								reservedCostUsdMicros: finalFamily.root.budgetCostReservedUsdMicros,
								remainingCostUsdMicros: finalFamily.root.budgetCostRemainingUsdMicros,
								maxCostUsdMicros: finalFamily.root.budgetCostMaxUsdMicros,
								revision: finalFamily.root.budgetAccountRevision,
								exhausted: finalFamily.root.budgetAccountExhausted,
							},
							finalBodies: {
								parent: {
									materialization: parentMaterialization.state,
									worker: "running",
									kernel: "running",
									liveBodies: spawner.sessionBodyCount(parentSessionId),
								},
								children: finalFamily.children.map((child) => ({
									sessionId: child.child.sessionId,
									materialization: child.materializationState,
									worker: child.workerState,
									kernel: child.kernelState,
								})),
							},
							expectedNotebook: {
								cellCount: parentCells.length + firstChildCells.length + secondChildCells.length,
								evidence: [
									"F4 first child admitted",
									"F4 concurrency denial durable",
									"F4 second child admitted",
									"F4 lifetime denial durable",
									"resident value 1 (two child notebooks)",
								],
							},
						}),
					);
				}
			} finally {
				await spawner.shutdownAll();
				runtime.close();
				sandboxStore.close();
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	);
});

async function runParentPrompt(
	runtime: WorkflowRuntimeStore,
	spawner: SandboxSpawner,
	sessionId: string,
	sandboxId: string,
	commandId: string,
	text: string,
): Promise<void> {
	await runtime.submitAgentSessionCommand(sessionId, {
		commandId,
		idempotencyKey: commandId,
		name: "prompt",
		payload: { text },
		clientId: "arc-f4-proof",
		targetGeneration: 0,
		now: Date.now(),
	});
	await spawner.drainAgentSessionCommands(sandboxId);
	assert.equal((await waitForCommand(runtime, commandId)).state, "completed");
}

async function passivateChild(
	spawner: SandboxSpawner,
	sessionId: string,
	ownerPrincipal: string,
	graphId: string,
	runtimeBundleDigest: string,
): Promise<void> {
	await spawner.passivateAgentSession({
		sessionId,
		generation: 0,
		ownerPrincipal,
		graphId,
		runtimeBundleDigest,
	});
	assert.equal(spawner.sessionBodyCount(sessionId), 0);
}

async function assertFamilyBudget(
	runtime: WorkflowRuntimeStore,
	parentSessionId: string,
	expected: {
		readonly directAcceptedChildren: number;
		readonly occupiedChildren: number;
		readonly reservedCostUsdMicros: number;
	},
): Promise<AgentSessionFamilyProjectionSnapshot> {
	const [family, budget] = await Promise.all([
		runtime.readAgentSessionFamilyProjection(parentSessionId),
		runtime.readAgentSessionBudgetSnapshot(parentSessionId),
	]);
	assert.ok(family);
	assert.ok(budget);
	assert.equal(family.root.directAcceptedChildren, expected.directAcceptedChildren);
	assert.equal(family.root.maxChildren, 2);
	assert.equal(family.root.occupiedChildren, expected.occupiedChildren);
	assert.equal(family.root.maxConcurrentChildren, 1);
	assert.equal(family.root.budgetCostMaxUsdMicros, PARENT_COST_USD_MICROS);
	assert.equal(family.root.budgetCostReservedUsdMicros, expected.reservedCostUsdMicros);
	assert.equal(family.root.budgetCostReservedUsdMicros, budget.account.reserved.costUsdMicros);
	assert.equal(family.root.budgetCostSpentUsdMicros, budget.account.spent.costUsdMicros);
	assert.equal(family.root.budgetCostRemainingUsdMicros, budget.available.costUsdMicros);
	assert.equal(family.root.budgetAccountExhausted, budget.account.exhausted);
	assert.equal(family.root.budgetAccountRevision, budget.account.revision);
	assert.equal(
		family.root.budgetCostSpentUsdMicros +
			family.root.budgetCostReservedUsdMicros +
			family.root.budgetCostRemainingUsdMicros,
		family.root.budgetCostMaxUsdMicros,
	);
	return family;
}

async function findChildDenial(
	runtime: WorkflowRuntimeStore,
	parentSessionId: string,
	code: string,
): Promise<AgentSessionChildSpawnRequestRecord> {
	const events = await runtime.listAgentSessionEvents(parentSessionId);
	const event = events.find((candidate) => {
		if (candidate.type !== "child.spawn_requested" || !isRecord(candidate.payload)) return false;
		const denial = candidate.payload.denial;
		return candidate.payload.decision === "denied" && isRecord(denial) && denial.code === code;
	});
	assert.ok(event && isRecord(event.payload));
	const requestId = event.payload.requestId;
	assert.equal(typeof requestId, "string");
	const request = await runtime.readAgentSessionChildSpawnRequest(parentSessionId, requestId as string);
	assert.ok(request);
	assert.equal(request.decision, "denied");
	assert.equal(request.denial_code, code);
	return request;
}

async function waitForResidentChild(runtime: WorkflowRuntimeStore, parentSessionId: string, childName: string) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const family = await runtime.readAgentSessionFamilyProjection(parentSessionId);
		const displayed = family?.children.find((child) => child.admission?.childName === childName);
		if (displayed?.materializationState === "running" && displayed.workerState === "running") {
			const session = await runtime.readAgentSession(displayed.child.sessionId);
			if (session) {
				const source = (JSON.parse(session.document_json) as { source?: { childRunId?: unknown } }).source;
				const childRunId = typeof source?.childRunId === "string" ? source.childRunId : undefined;
				if (childRunId && (await runtime.readAgentSessionChildRun(childRunId))?.state === "completed") {
					return { sessionId: session.session_id, childRunId };
				}
			}
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`resident Prime child ${childName} did not reach completed initial run with a running body`);
}

async function waitForCommand(runtime: WorkflowRuntimeStore, commandId: string): Promise<AgentSessionCommandRecord> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const command = await runtime.readAgentSessionCommand(commandId);
		if (command && ["completed", "failed", "cancelled"].includes(command.state)) return command;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`resident parent command ${commandId} did not settle`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
