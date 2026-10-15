import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { SophiaContentStore } from "../agent-runtime/content-store.js";
import { AgentMemory } from "../agent-runtime/memory.js";
import { digestAgentRuntimeBinding } from "../agent-runtime/profile.js";
import { createSandboxEventBus } from "../event-bus.js";
import { digestSophiaAgentSourceTree } from "../runtime-bundles.js";
import { SandboxStore } from "../sandbox-store.js";
import { SandboxSpawner } from "../spawner.js";
import { makeNodeRunner } from "../workflow/run-node.js";
import { makeRuntimeNodeRunner } from "../workflow/runtime-control.js";
import { type AgentSessionCommandRecord, WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

const ENTRYPOINT = process.env.SOPHIA_AGENT_RUNTIME_ENTRYPOINT?.trim();
const BRIDGE = process.env.SOPHIA_JUPYTER_BRIDGE_PATH?.trim();
const PYTHON = process.env.SOPHIA_PRIME_KERNEL_PYTHON?.trim();
const LIVE_GRAPH_ID = process.env.ARC_F3_E2E_GRAPH_ID?.trim();
const LIVE_USER_ID = process.env.ARC_F3_E2E_USER_ID?.trim();
const LIVE_MCP_URL = process.env.ARC_F3_E2E_MCP_URL?.trim();
const LIVE_SESSION_ID = process.env.ARC_F3_E2E_SESSION_ID?.trim();
const LOCAL_RUNTIME_SKIP =
	!ENTRYPOINT || !existsSync(ENTRYPOINT) || !BRIDGE || !existsSync(BRIDGE) || !PYTHON || !existsSync(PYTHON)
		? "set the Prime worker, Jupyter bridge, and kernel Python paths"
		: false;
const liveCoordinates = [LIVE_GRAPH_ID, LIVE_USER_ID, LIVE_MCP_URL];
if (liveCoordinates.some(Boolean) && !liveCoordinates.every(Boolean)) {
	throw new Error("ARC_F3_E2E_GRAPH_ID, ARC_F3_E2E_USER_ID, and ARC_F3_E2E_MCP_URL must be supplied together");
}

describe("Arc F3 resident Prime child organism", { concurrency: false }, () => {
	it(
		"keeps an admitted child worker+kernel pair across a second command, then passivates it independently",
		{ skip: LOCAL_RUNTIME_SKIP, timeout: 120_000 },
		async () => {
			const tempDir = mkdtempSync(join(tmpdir(), "choreograph-arc-f3-e2e-"));
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
				const runId = "arc-f3-local-e2e";
				const workflowName = "domain-agent-activity-loop-v1";
				const parentSessionId = LIVE_SESSION_ID ?? "ags_arc_f3_parent";
				const graphId = LIVE_GRAPH_ID ?? "arc-f3-proof";
				const ownerUserId = LIVE_USER_ID ?? "user:arc-f3-proof";
				const bundleDigest = digestSophiaAgentSourceTree(ENTRYPOINT!);
				const pilot = makeTestAgentSemanticBinding({
					kind: "prime",
					graphId,
					registeredName: "arc-f3-agent",
					bundleDigest,
				});
				const emanationBase = makeTestAgentSemanticBinding({
					kind: "prime",
					graphId,
					registeredName: "arc-f3-agent",
					bundleDigest,
				});
				const emanationRuntime = {
					...emanationBase.runtime,
					constraints: {
						...emanationBase.runtime.constraints,
						maxChildren: 0,
						maxChildDepth: 0,
						maxConcurrentChildren: 0,
						idlePassivateMs: 60_000,
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
								maxEmanations: 1,
								maxTurns: emanation.runtime.constraints.maxTurns,
							},
							emanationToolInclude: [],
							systemPrompt: "You are a resident, bounded Arc F3 child.",
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
					label: "arc-f3-parent",
					phaseIndex: 1,
					nodeKey: "arc-f3-parent",
					sessionId: parentSessionId,
					depth: 0,
					sandboxGeneration: 0,
					prompt: "Spawn one resident Prime child, then prove this parent kernel remains usable.",
					model: "mock:rlm_prime",
					provider: "openrouter",
					graphId,
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

				const child = await waitForResidentChild(runtime, parentSessionId);
				assert.equal(child.session.status, "completed");
				assert.equal(child.run.state, "completed");
				assert.equal(child.materialization.state, "running");
				assert.equal(child.materialization.activation_id, child.run.child_run_id);
				assert.equal(spawner.sessionBodyCount(child.session.session_id), 2);
				const childLease = spawner.getKernelLeaseForSession(child.session.session_id);
				assert.ok(childLease);
				assert.notEqual(child.materialization.sandbox_id, parentMaterialization.sandbox_id);
				assert.notEqual(childLease.kernelSandboxId, parentLease.kernelSandboxId);
				assert.notEqual(childLease.agentSandboxId, parentLease.agentSandboxId);
				const childActive = spawner.getActive().get(child.materialization.sandbox_id);
				assert.equal(childActive?.agentRequest?.depth, 1);
				assert.equal(childActive?.agentRequest?.runtime_binding.kind, "prime");

				let childCells = await runtime.listExecutionJournal(child.session.session_id);
				assert.equal(childCells.length, 1);
				assert.match(JSON.stringify(childCells[0]?.outputs), /resident value 1/);

				const commandId = `arc-f3:continue:${child.session.session_id}`;
				await runtime.submitAgentSessionCommand(child.session.session_id, {
					commandId,
					idempotencyKey: commandId,
					name: "prompt",
					payload: { text: "Continue once in the same resident child kernel." },
					clientId: "arc-f3-proof",
					targetGeneration: 0,
					now: Date.now(),
				});
				await spawner.drainAgentSessionCommands(child.materialization.sandbox_id);
				assert.equal((await waitForCommand(runtime, commandId)).state, "completed");
				childCells = await runtime.listExecutionJournal(child.session.session_id);
				assert.equal(childCells.length, 2);
				assert.match(JSON.stringify(childCells[1]?.outputs), /resident value 2/);
				assert.equal(spawner.getKernelLeaseForSession(child.session.session_id)?.leaseId, childLease.leaseId);
				assert.equal(
					(await runtime.readAgentMaterialization(child.session.session_id, 0))?.sandbox_id,
					child.materialization.sandbox_id,
				);

				let family = await runtime.readAgentSessionFamilyProjection(parentSessionId);
				const displayedChild = family?.children.find(
					(candidate) => candidate.child.sessionId === child.session.session_id,
				);
				assert.equal(displayedChild?.admission?.runtimeKind, "prime");
				assert.equal(displayedChild?.workerState, "running");
				assert.equal(displayedChild?.kernelState, "running");

				await spawner.passivateAgentSession({
					sessionId: child.session.session_id,
					generation: 0,
					ownerPrincipal: ownerUserId,
					graphId,
					runtimeBundleDigest: emanation.runtime.bundle.digest,
				});
				assert.equal(spawner.sessionBodyCount(child.session.session_id), 0);
				assert.equal((await runtime.readAgentMaterialization(child.session.session_id, 0))?.state, "passivated");
				family = await runtime.readAgentSessionFamilyProjection(parentSessionId);
				const passivatedChild = family?.children.find(
					(candidate) => candidate.child.sessionId === child.session.session_id,
				);
				assert.equal(passivatedChild?.workerState, "passivated");
				assert.equal(passivatedChild?.kernelState, "shutdown");
				assert.equal(
					spawner.sessionBodyCount(parentSessionId),
					2,
					"child passivation must not disturb the parent pair",
				);
				assert.equal(spawner.getKernelLeaseForSession(parentSessionId)?.leaseId, parentLease.leaseId);
			} finally {
				await spawner.shutdownAll();
				runtime.close();
				sandboxStore.close();
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	);
});

async function waitForResidentChild(runtime: WorkflowRuntimeStore, parentSessionId: string) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const relation = (await runtime.listAgentSessionChildren(parentSessionId))[0];
		if (relation) {
			const session = await runtime.readAgentSession(relation.child_session_id);
			if (session) {
				const source = (JSON.parse(session.document_json) as { source?: { childRunId?: unknown } }).source;
				const childRunId = typeof source?.childRunId === "string" ? source.childRunId : undefined;
				if (childRunId) {
					const [run, materialization] = await Promise.all([
						runtime.readAgentSessionChildRun(childRunId),
						runtime.readAgentMaterialization(session.session_id, 0),
					]);
					if (run?.state === "completed" && materialization?.state === "running") {
						return { session, run, materialization };
					}
				}
			}
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("resident Prime child did not reach completed initial run with a running materialization");
}

async function waitForCommand(runtime: WorkflowRuntimeStore, commandId: string): Promise<AgentSessionCommandRecord> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const command = await runtime.readAgentSessionCommand(commandId);
		if (command && ["completed", "failed", "cancelled"].includes(command.state)) return command;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`resident child command ${commandId} did not settle`);
}
