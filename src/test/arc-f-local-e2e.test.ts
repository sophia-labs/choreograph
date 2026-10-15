import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { SophiaContentStore } from "../agent-runtime/content-store.js";
import { AgentMemory } from "../agent-runtime/memory.js";
import { createSandboxEventBus } from "../event-bus.js";
import { digestSophiaAgentSourceTree } from "../runtime-bundles.js";
import { SandboxStore } from "../sandbox-store.js";
import { SandboxSpawner } from "../spawner.js";
import { makeNodeRunner } from "../workflow/run-node.js";
import { makeRuntimeNodeRunner } from "../workflow/runtime-control.js";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

const ENTRYPOINT = process.env.SOPHIA_AGENT_RUNTIME_ENTRYPOINT?.trim();
const BRIDGE = process.env.SOPHIA_JUPYTER_BRIDGE_PATH?.trim();
const PYTHON = process.env.SOPHIA_PRIME_KERNEL_PYTHON?.trim();
const LIVE_GRAPH_ID = process.env.ARC_F_E2E_GRAPH_ID?.trim();
const LIVE_USER_ID = process.env.ARC_F_E2E_USER_ID?.trim();
const LIVE_MCP_URL = process.env.ARC_F_E2E_MCP_URL?.trim();
const LIVE_SESSION_ID = process.env.ARC_F_E2E_SESSION_ID?.trim();
const LOCAL_RUNTIME_SKIP =
	!ENTRYPOINT || !existsSync(ENTRYPOINT) || !BRIDGE || !existsSync(BRIDGE) || !PYTHON || !existsSync(PYTHON)
		? "set the Prime worker, Jupyter bridge, and kernel Python paths"
		: false;
const liveCoordinates = [LIVE_GRAPH_ID, LIVE_USER_ID, LIVE_MCP_URL];
if (liveCoordinates.some(Boolean) && !liveCoordinates.every(Boolean)) {
	throw new Error("ARC_F_E2E_GRAPH_ID, ARC_F_E2E_USER_ID, and ARC_F_E2E_MCP_URL must be supplied together");
}

describe("Arc F hosted child organism", { concurrency: false }, () => {
	it(
		"returns an opaque handle before one no-kernel child completes and leaves the parent kernel usable",
		{ skip: LOCAL_RUNTIME_SKIP, timeout: 120_000 },
		async () => {
			const tempDir = mkdtempSync(join(tmpdir(), "choreograph-arc-f-e2e-"));
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
				const runId = "arc-f-local-e2e";
				const workflowName = "domain-agent-activity-loop-v1";
				const parentSessionId = LIVE_SESSION_ID ?? "ags_arc_f_parent";
				const graphId = LIVE_GRAPH_ID ?? "arc-f-proof";
				const ownerUserId = LIVE_USER_ID ?? "user:arc-f-proof";
				const bundleDigest = digestSophiaAgentSourceTree(ENTRYPOINT!);
				const pilot = makeTestAgentSemanticBinding({
					kind: "prime",
					graphId,
					registeredName: "arc-f-agent",
					bundleDigest,
				});
				const emanation = makeTestAgentSemanticBinding({
					kind: "simple",
					graphId,
					registeredName: "arc-f-agent",
					bundleDigest,
				});
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
								model: "mock:done",
								maxEmanations: 1,
								maxTurns: emanation.runtime.constraints.maxTurns,
							},
							emanationToolInclude: [],
							systemPrompt: "You are a bounded Arc F child.",
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
					label: "arc-f-parent",
					phaseIndex: 1,
					nodeKey: "arc-f-parent",
					sessionId: parentSessionId,
					sandboxGeneration: 0,
					prompt: "Spawn one bounded child, then prove this parent kernel remains usable.",
					model: "mock:rlm",
					provider: "openrouter",
					graphId,
					toolMode: "none",
					...pilot,
				};

				const parentResult = await runner(parentSpec);
				assert.equal(parentResult.state, "done");
				assert.ok(spawner.sessionBodyCount(parentSessionId) > 0, "the parent remains materialized");
				const parentCells = await runtime.listExecutionJournal(parentSessionId);
				assert.equal(parentCells.length, 2);
				assert.match(JSON.stringify(parentCells[0]?.outputs), /child admitted ags_.* acr_/);
				assert.match(JSON.stringify(parentCells[1]?.outputs), /parent continued 1/);

				const child = await waitForCompletedChild(runtime, parentSessionId);
				assert.equal(child.session.status, "completed");
				assert.equal(child.run.state, "completed");
				assert.equal(child.materialization.state, "completed");
				assert.equal(child.materialization.generation, 0);
				assert.equal(child.materialization.activation_id, child.run.child_run_id);
				assert.equal(spawner.sessionBodyCount(child.session.session_id), 0);
				assert.equal((await runtime.listAgentSessionChildren(parentSessionId)).length, 1);

				const parentEvents = await runtime.listAgentSessionEvents(parentSessionId);
				for (const eventType of ["child.spawn_requested", "child.created", "child.run.completed"]) {
					assert.equal(
						parentEvents.filter((event) => event.type === eventType).length,
						1,
						`${eventType} must be testified exactly once`,
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

async function waitForCompletedChild(runtime: WorkflowRuntimeStore, parentSessionId: string) {
	const deadline = Date.now() + 20_000;
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
					if (run?.state === "completed" && materialization?.state === "completed") {
						return { session, run, materialization };
					}
				}
			}
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("hosted child did not reach completed Session, run, and materialization states");
}
