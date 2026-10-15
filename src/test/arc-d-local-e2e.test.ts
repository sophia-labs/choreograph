import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SophiaContentStore } from "../agent-runtime/content-store.js";
import { AgentMemory } from "../agent-runtime/memory.js";
import { digestAgentRuntimeBinding } from "../agent-runtime/profile.js";
import { mirrorAgentSessionEvent } from "../agent-runtime/session-event-mirror.js";
import { createSandboxEventBus } from "../event-bus.js";
import type { CapabilityBackend } from "../mnemosyne.js";
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
const LOCAL_RUNTIME_SKIP =
	!ENTRYPOINT || !existsSync(ENTRYPOINT) || !BRIDGE || !existsSync(BRIDGE) || !PYTHON || !existsSync(PYTHON)
		? "set the Prime worker, Jupyter bridge, and kernel Python paths"
		: false;

describe("Arc D Sophia-native memory lifecycle", { concurrency: false }, () => {
	it(
		"passivates to zero bodies, resumes by snapshot, and falls back to testimony-bound journal replay",
		{ skip: LOCAL_RUNTIME_SKIP, timeout: 120_000 },
		async () => {
			const tempDir = mkdtempSync(join(tmpdir(), "choreograph-arc-d-e2e-"));
			const sandboxStore = new SandboxStore(join(tempDir, "sandboxes.sqlite"));
			const runtime = new WorkflowRuntimeStore(join(tempDir, "runtime.sqlite"));
			await runtime.init();
			const content = SophiaContentStore.fromUrl(pathToFileURL(`${join(tempDir, "memory")}/`).toString());
			const memory = new AgentMemory(content, runtime);
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
				const runId = "arc-d-local-e2e";
				const sessionId = "agent-session:arc-d-local-e2e";
				const nodeKey = "arc-d-memory";
				const graphId = "arc-d-proof";
				const ownerUserId = "user:arc-d-proof";
				await runtime.createWorkflowInstance({
					runId,
					workflowName: "arc-d-memory-proof",
					graphId,
					ownerUserId,
					inputs: {},
					startedAt: Date.now(),
				});

				const semanticBase = makeTestAgentSemanticBinding({
					kind: "prime",
					graphId,
					registeredName: "arc-d-memory-agent",
					bundleDigest: digestSophiaAgentSourceTree(ENTRYPOINT!),
				});
				const runtimeBinding = {
					...semanticBase.runtime,
					constraints: { ...semanticBase.runtime.constraints, idlePassivateMs: 0 },
				};
				const semantic = {
					...semanticBase,
					runtime: runtimeBinding,
					runtimeBindingDigest: digestAgentRuntimeBinding(runtimeBinding),
				};
				let backendCalls = 0;
				const bindBackend = async (): Promise<ReadonlyMap<string, CapabilityBackend>> => {
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
							return { documents: ["recorded-host-testimony"] };
						},
						async close() {},
					};
					return new Map([["mnemosyne", backend]]);
				};
				const baseRunner = makeNodeRunner({
					spawner,
					eventBus,
					authContext: {
						method: "internal_service",
						userId: ownerUserId,
						internalServiceSecret: "local-proof-only",
					},
					ownerUserId,
					mnemosyne: { mcpUrl: "disabled", graphId },
					bindCapabilities: bindBackend,
					resolveCapabilityGrantPolicy: () => ({
						exactTools: { mnemosyne: ["search_documents"] },
					}),
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
							return;
						}
						const semanticEvent = mirrorAgentSessionEvent(event, spec);
						if (semanticEvent) {
							await runtime.appendAgentSessionEventForGeneration(
								spec.sessionId!,
								spec.sandboxGeneration ?? 0,
								spec.invocationId!,
								semanticEvent,
							);
						}
					},
				});
				const runner = makeRuntimeNodeRunner({
					runtime,
					baseRunner,
					memory,
					runId,
					workflowName: "arc-d-memory-proof",
					graphId,
					ownerUserId,
					onIdle: (spec) =>
						spawner.scheduleAgentPassivation({
							sessionId: spec.sessionId!,
							generation: spec.sandboxGeneration ?? 0,
							ownerPrincipal: ownerUserId,
							graphId,
							runtimeBundleDigest: spec.runtime!.bundle.digest,
							idleMs: 0,
						}),
				});
				const spec = (generation: number, model: string): AgentNodeSpec => ({
					label: "arc-d-memory",
					phaseIndex: 1,
					nodeKey,
					sessionId,
					sandboxGeneration: generation,
					prompt: generation === 0 ? "Create durable computational state" : "Continue from durable memory",
					model,
					provider: "openrouter",
					graphId,
					toolMode: "none",
					...semantic,
				});

				const generation0 = await runner(spec(0, "mock:ipython_capability"));
				assert.equal(generation0.state, "done");
				assert.ok(generation0.agentCheckpoint);
				assert.equal((await runtime.readAgentMaterialization(sessionId, 0))?.state, "passivated");
				assert.equal(spawner.sessionBodyCount(sessionId), 0);
				const journal = await runtime.listExecutionJournal(sessionId);
				assert.equal(journal.length, 1);
				assert.equal(journal[0]?.hostRequests.length, 2);
				assert.equal(journal[0]?.hostRequests[0]?.ok, true);
				assert.equal(journal[0]?.hostRequests[1]?.ok, false);
				assert.equal(backendCalls, 1);

				const generation1 = await runner(spec(1, "mock:ipython"));
				assert.equal(generation1.state, "done");
				assert.equal((await runtime.readAgentMaterialization(sessionId, 1))?.state, "passivated");
				assert.equal(spawner.sessionBodyCount(sessionId), 0);
				let events = await runtime.listAgentSessionEvents(sessionId);
				const snapshotResume = events.find(
					(event) =>
						event.type === "runtime.resumed" &&
						(event.payload as { generation?: unknown; method?: unknown }).generation === 1,
				);
				assert.ok(
					snapshotResume,
					JSON.stringify(
						events.filter((event) => event.type.startsWith("runtime.")),
						null,
						2,
					),
				);
				assert.equal((snapshotResume?.payload as { method?: unknown }).method, "snapshot");

				const latestKernelCheckpoint = await runtime.readLatestKernelCheckpoint(sessionId);
				assert.ok(latestKernelCheckpoint);
				await writeFile(fileURLToPath(latestKernelCheckpoint.manifest.payload.uri), "deliberately-corrupt");

				const callsBeforeReplay = backendCalls;
				const generation2 = await runner(spec(2, "mock:ipython"));
				assert.equal(generation2.state, "done");
				assert.equal((await runtime.readAgentMaterialization(sessionId, 2))?.state, "passivated");
				assert.equal(spawner.sessionBodyCount(sessionId), 0);
				assert.equal(
					backendCalls,
					callsBeforeReplay,
					"journal replay must consume recorded host testimony without re-invoking authority",
				);
				events = await runtime.listAgentSessionEvents(sessionId);
				const journalResume = events.find(
					(event) =>
						event.type === "runtime.resumed" &&
						(event.payload as { generation?: unknown; method?: unknown }).generation === 2,
				);
				assert.equal((journalResume?.payload as { method?: unknown }).method, "journal");
				assert.equal((journalResume?.payload as { replay?: { replayedCells?: unknown } }).replay?.replayedCells, 3);
				assert.match(
					String((journalResume?.payload as { snapshotFailure?: unknown }).snapshotFailure),
					/digest|length/,
				);
			} finally {
				await spawner.shutdownAll();
				runtime.close();
				sandboxStore.close();
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	);
});
