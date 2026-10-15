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
import {
	type AgentMaterializationState,
	type AgentSessionCommandRecord,
	WorkflowRuntimeStore,
} from "../workflow/runtime-store.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

const ENTRYPOINT = process.env.SOPHIA_AGENT_RUNTIME_ENTRYPOINT?.trim();
const BRIDGE = process.env.SOPHIA_JUPYTER_BRIDGE_PATH?.trim();
const PYTHON = process.env.SOPHIA_PRIME_KERNEL_PYTHON?.trim();
const LOCAL_RUNTIME_SKIP =
	!ENTRYPOINT || !existsSync(ENTRYPOINT) || !BRIDGE || !existsSync(BRIDGE) || !PYTHON || !existsSync(PYTHON)
		? "set the Prime worker, Jupyter bridge, and kernel Python paths"
		: false;

describe("Arc E resident Prime lifecycle", { concurrency: false }, () => {
	it(
		"deduplicates durable commands and preserves one transcript/kernel through three body generations",
		{ skip: LOCAL_RUNTIME_SKIP, timeout: 120_000 },
		async () => {
			const tempDir = mkdtempSync(join(tmpdir(), "choreograph-arc-e-e2e-"));
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
				const runId = "arc-e-local-e2e";
				const sessionId = "agent-session:arc-e-local-e2e";
				const nodeKey = "arc-e-resident";
				const graphId = "arc-e-proof";
				const ownerUserId = "user:arc-e-proof";
				await runtime.createWorkflowInstance({
					runId,
					workflowName: "arc-e-resident-proof",
					graphId,
					ownerUserId,
					inputs: {},
					startedAt: Date.now(),
				});
				const semanticBase = makeTestAgentSemanticBinding({
					kind: "prime",
					graphId,
					registeredName: "arc-e-resident-agent",
					bundleDigest: digestSophiaAgentSourceTree(ENTRYPOINT!),
				});
				const runtimeBinding = {
					...semanticBase.runtime,
					constraints: { ...semanticBase.runtime.constraints, idlePassivateMs: 150 },
				};
				const semantic = {
					...semanticBase,
					runtime: runtimeBinding,
					runtimeBindingDigest: digestAgentRuntimeBinding(runtimeBinding),
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
					workflowName: "arc-e-resident-proof",
					graphId,
					ownerUserId,
					onIdle: (spec) =>
						spawner.scheduleAgentPassivation({
							sessionId: spec.sessionId!,
							generation: spec.sandboxGeneration ?? 0,
							ownerPrincipal: ownerUserId,
							graphId,
							runtimeBundleDigest: spec.runtime!.bundle.digest,
							idleMs: spec.runtime!.constraints.idlePassivateMs,
						}),
				});
				const spec = (generation: number): AgentNodeSpec => ({
					label: "arc-e-resident",
					phaseIndex: 1,
					nodeKey,
					sessionId,
					sandboxGeneration: generation,
					prompt: `Generation ${generation} initial prompt`,
					model: "mock:resident_ipython",
					provider: "openrouter",
					graphId,
					toolMode: "none",
					...semantic,
				});

				const submitPrompt = async (generation: number, suffix: string): Promise<AgentSessionCommandRecord> => {
					const commandId = `arc-e:${generation}:${suffix}`;
					const submitted = await runtime.submitAgentSessionCommand(sessionId, {
						commandId,
						idempotencyKey: commandId,
						name: suffix === "follow-up" ? "follow_up" : "prompt",
						payload: { text: `Resident command ${suffix} in generation ${generation}` },
						clientId: "vehicle-proof",
						targetGeneration: generation,
						now: Date.now(),
					});
					assert.ok(submitted);
					const materialization = await runtime.readAgentMaterialization(sessionId, generation);
					assert.ok(materialization);
					await spawner.drainAgentSessionCommands(materialization.sandbox_id);
					return waitForCommand(runtime, commandId);
				};

				for (let generation = 0; generation < 3; generation++) {
					const result = await runner(spec(generation));
					assert.equal(result.state, "done");
					assert.equal((await runtime.readAgentMaterialization(sessionId, generation))?.state, "running");
					const first = await submitPrompt(generation, "prompt");
					assert.equal(first.state, "completed");
					if (generation === 0) {
						const duplicate = await runtime.submitAgentSessionCommand(sessionId, {
							commandId: first.command_id,
							idempotencyKey: first.idempotency_key,
							name: "prompt",
							payload: { text: "Resident command prompt in generation 0" },
							clientId: "vehicle-proof",
							targetGeneration: 0,
							now: Date.now(),
						});
						assert.equal(duplicate?.duplicate, true);
						assert.equal(duplicate?.record.state, "completed");
						const followUp = await submitPrompt(generation, "follow-up");
						assert.equal(followUp.state, "completed");
					}
					await waitForMaterialization(runtime, sessionId, generation, "passivated");
					assert.equal(spawner.sessionBodyCount(sessionId), 0);
				}

				const cells = await runtime.listExecutionJournal(sessionId);
				assert.equal(cells.length, 7, "one initial cell per generation plus four resident commands");
				assert.deepEqual(
					cells.map((cell) => cell.generation),
					[0, 0, 0, 1, 1, 2, 2],
				);
				for (let index = 0; index < cells.length; index++) {
					assert.match(JSON.stringify(cells[index]!.outputs), new RegExp(`resident value ${index + 1}`));
				}
				const commands = await runtime.listAgentSessionCommands(sessionId);
				assert.equal(commands.filter((command) => command.name !== "quiesce").length, 4);
				assert.equal(commands.filter((command) => command.name === "quiesce").length, 3);
				assert.ok(commands.every((command) => command.state === "completed"));
				const session = await runtime.readAgentSession(sessionId);
				assert.ok(session);
				const document = JSON.parse(session.document_json) as {
					transcript?: { order?: string[]; items?: Record<string, { role?: string; generation?: number }> };
				};
				const commandTranscriptIds = (document.transcript?.order ?? []).filter((id) => id.startsWith("command:"));
				assert.equal(commandTranscriptIds.length, 8, "four inputs and four assistant results share one transcript");
				assert.deepEqual(
					[...new Set(commandTranscriptIds.map((id) => document.transcript?.items?.[id]?.generation))],
					[0, 1, 2],
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

async function waitForCommand(runtime: WorkflowRuntimeStore, commandId: string): Promise<AgentSessionCommandRecord> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const command = await runtime.readAgentSessionCommand(commandId);
		if (command && (command.state === "completed" || command.state === "failed")) return command;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`command ${commandId} did not complete`);
}

async function waitForMaterialization(
	runtime: WorkflowRuntimeStore,
	sessionId: string,
	generation: number,
	state: AgentMaterializationState,
): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if ((await runtime.readAgentMaterialization(sessionId, generation))?.state === state) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`materialization ${generation} did not reach ${state}`);
}
