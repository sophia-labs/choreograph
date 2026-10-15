import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AgentSessionChildHostRequestFault } from "../agent-runtime/child-execution-service.js";
import type {
	RlmDeleteSubagentResult,
	RlmListSubagentsResult,
	RlmSpawnHandle,
} from "../agent-runtime/rlm-control-contract.js";
import type { InternalJobRunner } from "../internal-jobs/runner.js";
import { type InternalJobServer, startInternalJobServer } from "../internal-jobs/server.js";
import { phanesDomainTriggerSubmitter } from "../orchestrator.js";
import { digestSophiaAgentSourceTree } from "../runtime-bundles.js";
import type { SandboxSpawner } from "../spawner.js";
import type { InvocationEnvelopeV1 } from "../workflow/invocation.js";
import type { WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import type { AgentNodeResult, AgentNodeSpec, RunRecord } from "../workflow/types.js";
import {
	closeLocalHarness,
	configuredPhanesLocalRuntime,
	createLocalHarness,
	executeLocalDomainInvocation,
	LocalGraph,
	type LocalHarness,
} from "./arc-f6-phanes-local-support.js";

const {
	entrypoint: ENTRYPOINT,
	phanesRoot: PHANES_ROOT,
	driver: PHANES_DRIVER,
	skip: LOCAL_RUNTIME_SKIP,
} = configuredPhanesLocalRuntime();

const HOME_OWNER = "user:phanes-owner";
const AUTHORITY_OWNER = "user:platform-steward";
const HOME_GRAPH = "phanes";
const AUTHORITY_GRAPH = "observatory";
const OWNER_USER_ID = "phanes-owner";
const ACTOR_REF = `user:${OWNER_USER_ID}`;
const TOKEN = "arc-f6-local-internal-token-0000000000000001";
const RESPONSE_TEXT = "Arc F6 completed one bounded investigation and preserved the parent.";
const CHILD_PROMPT = "Inspect one bounded local F6 question without receiving parent credentials or authority.";

describe("Arc F6 canonical Phanes local organism", { concurrency: false }, () => {
	it(
		"runs one real bounded child through the Discord trigger and completes its sole host-bound effect exactly once",
		{ skip: LOCAL_RUNTIME_SKIP, timeout: 240_000 },
		async () => {
			const tempDir = mkdtempSync(join(tmpdir(), "choreograph-arc-f6-phanes-"));
			let harness: LocalHarness | undefined;
			let server: InternalJobServer | undefined;
			let driver: DriverProcess | undefined;
			try {
				const bundleDigest = digestSophiaAgentSourceTree(ENTRYPOINT!);
				const seed = readPhanesSeed(bundleDigest);
				const definitionText = requireDocument(seed.graphDocuments, seed.agent.definitionDocumentId);
				const definition = JSON.parse(definitionText) as Record<string, unknown>;
				assert.equal(
					((definition.runtimes as Record<string, Record<string, unknown>>).pilot as Record<string, unknown>)
						.schema,
					"choreograph.agent-runtime-binding.v2",
				);
				assert.equal(definitionText.includes("maxWorkspaceBytes"), false);

				const home = new LocalGraph(HOME_GRAPH, seed.graphDocuments);
				const authority = new LocalGraph(AUTHORITY_GRAPH, seed.authorityDocuments);
				harness = await createLocalHarness(tempDir, "arc-f6-phanes");
				await harness.spawner.start();

				let execution: Promise<RunRecord> | undefined;
				let intercepted: InterceptionEvidence | undefined;
				let interceptionFault: unknown;
				const dispatcher = childDispatcher(harness.spawner);
				const originalHandle = dispatcher.handle.bind(dispatcher);
				dispatcher.handle = async (input) => {
					const payload = input.payload as { type?: unknown };
					if (payload.type !== "rlm.delete_subagent" || intercepted) return originalHandle(input);
					try {
						intercepted = await exerciseDenialsAndReplay(harness!, originalHandle, input);
						return intercepted.originalDelete;
					} catch (error) {
						interceptionFault = error;
						console.error(`ARC_F6_INTERCEPTION_DIAGNOSTIC:${JSON.stringify(interceptionDiagnostic(error))}`);
						throw error;
					}
				};

				const fakeFetch: typeof fetch = async (_url, init) => {
					assert.equal(init?.method, "POST");
					const headers = new Headers(init?.headers);
					assert.equal(headers.get("x-internal-service"), "arc-f6-internal-service-secret");
					assert.equal(headers.get("x-user-id"), OWNER_USER_ID);
					assert.equal(headers.get("x-sophia-trigger-adapter"), "discord");
					assert.equal(headers.get("prefer"), "respond-async");
					const envelope = JSON.parse(String(init?.body)) as InvocationEnvelopeV1;
					assert.equal(envelope.schema, "choreograph.invocation-envelope.v1");
					assert.deepEqual(envelope.graph, { ownerPrincipal: HOME_OWNER, graphId: HOME_GRAPH });
					assert.equal(envelope.actorRef, ACTOR_REF);
					const runId = "wfr-arc-f6-phanes-local";
					execution = executeLocalDomainInvocation({
						harness: harness!,
						home,
						authority,
						envelope,
						runId,
						homeGraphId: HOME_GRAPH,
						homeOwnerPrincipal: HOME_OWNER,
						authorityGraphId: AUTHORITY_GRAPH,
						authorityOwnerPrincipal: AUTHORITY_OWNER,
						ownerUserId: OWNER_USER_ID,
						actorRef: ACTOR_REF,
						now: 1_785_888_000_001,
						internalServiceSecret: "arc-f6-local-only",
						capabilityGateError: "Arc F6 mock model must not cross the graph capability gate",
						onResolved: (resolved) => {
							assert.deepEqual(
								[
									resolved.runtimes.pilot.constraints.maxChildren,
									resolved.runtimes.pilot.constraints.maxChildDepth,
									resolved.runtimes.pilot.constraints.maxConcurrentChildren,
								],
								[1, 1, 1],
							);
							assert.deepEqual(
								[
									resolved.runtimes.emanation.constraints.maxChildren,
									resolved.runtimes.emanation.constraints.maxChildDepth,
									resolved.runtimes.emanation.constraints.maxConcurrentChildren,
								],
								[0, 0, 0],
							);
						},
						deterministicNode: (spec, now) =>
							spec.label === "pilot-attend" ? deterministicAttend(spec, now) : undefined,
					});
					return Response.json({ runId, invocationId: envelope.invocationId }, { status: 202 });
				};

				const domainTrigger = phanesDomainTriggerSubmitter(
					fakeFetch,
					{
						MNEMOSYNE_INTERNAL_SERVICE_SECRET: "arc-f6-internal-service-secret",
						PHANES_ON_BEHALF_OF: OWNER_USER_ID,
						PHANES_GRAPH_OWNER: HOME_OWNER,
						PHANES_AGENT_DEFINITION_DOCUMENT_ID: seed.agent.definitionDocumentId,
					},
					1,
				);
				const socketPath = join(tempDir, "internal", "phanes.sock");
				server = await startInternalJobServer({
					socketPath,
					token: TOKEN,
					runner: {} as InternalJobRunner,
					effectStore: harness.runtime,
					effectCapabilities: ["discord"],
					domainTrigger,
				});

				driver = runPhanesDriver({
					bundleDigest,
					socketPath,
					statePath: join(tempDir, "phanes-turns.sqlite"),
				});
				await waitFor(
					() => execution !== undefined,
					"production Phanes trigger did not reach canonical invocation",
				);
				const run = await execution!;
				const driverReceipt = await driver.done;
				assert.ok(
					intercepted,
					`parent delete interception failed: ${JSON.stringify(interceptionDiagnostic(interceptionFault))}`,
				);

				assert.equal(run.status, "completed");
				assert.deepEqual(run.output, {
					response: { content: RESPONSE_TEXT },
					proposedEffects: [],
					delegated: false,
					emanations: [],
					programInvocation: null,
					failure: null,
					effectReceipts: run.effectReceipts,
				});
				assert.equal(run.agents.filter((agent) => agent.label === "pilot-respond").length, 1);
				assert.equal(run.agents.filter((agent) => agent.label === "pilot-attend").length, 1);

				assert.equal(driverReceipt.schema, "sophia.arc-f6-phanes-driver-receipt.v1");
				assert.equal(driverReceipt.turn.runId, "wfr-arc-f6-phanes-local");
				assert.equal(driverReceipt.turn.responseMessageId, "400");
				assert.deepEqual(driverReceipt.events, ["placeholder", "effect-edit"]);
				assert.equal(driverReceipt.sourceCommit.updates, 1);
				assert.ok(driverReceipt.sourceCommit.queries >= 2);
				assert.ok(driverReceipt.sourceCommit.tripleCount > 0);
				assert.equal(driverReceipt.grantReads, 1);
				assert.deepEqual(driverReceipt.effect, {
					editCount: 1,
					content: RESPONSE_TEXT,
					attachmentCount: 0,
					duplicateClaim: false,
				});

				await assertGoldDurability(harness, intercepted, run);
				assert.equal(home.writes.filter((write) => write.documentId.startsWith("effect-receipts-")).length, 1);
				assert.equal(JSON.stringify(seed).includes(TOKEN), false);
				assert.equal(JSON.stringify(run).includes(TOKEN), false);
				assert.equal(JSON.stringify(intercepted).includes(CHILD_PROMPT), false);
			} finally {
				if (driver) {
					void driver.done.catch(() => undefined);
					driver.kill();
				}
				await server?.close();
				if (harness) await closeLocalHarness(harness);
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	);
});

interface MaterializedSeed {
	readonly graphId: string;
	readonly agent: {
		readonly definitionDocumentId: string;
		readonly grantDocumentId: string;
	};
	readonly graphDocuments: Readonly<Record<string, string>>;
	readonly authorityDocuments: Readonly<Record<string, string>>;
}

function interceptionDiagnostic(error: unknown): Record<string, unknown> {
	return {
		name: error instanceof Error ? error.name : typeof error,
		message: error instanceof Error ? error.message : String(error),
		structured:
			error instanceof AgentSessionChildHostRequestFault
				? error.structured
				: (error as { structured?: unknown } | null)?.structured,
	};
}

function deterministicAttend(spec: AgentNodeSpec, now: number): AgentNodeResult {
	return {
		label: spec.label,
		phaseIndex: spec.phaseIndex,
		state: "done",
		output: "No workflow-level emanation is needed; the respondent may use its sole bounded RLM child.",
		structured: { reason: "One respondent-local bounded investigation is sufficient.", tasks: [], program: null },
		model: spec.model,
		agentId: spec.agentId,
		turns: 1,
		toolCalls: 0,
		tokens: 0,
		queuedAt: now,
		startedAt: now,
		durationMs: 0,
		agentType: spec.agentType,
	};
}

type DispatcherResult = RlmSpawnHandle | RlmListSubagentsResult | RlmDeleteSubagentResult;
type DispatcherInput = {
	readonly requestId: string;
	readonly payload: unknown;
	readonly parent: {
		readonly sessionId: string;
		readonly generation: number;
		readonly activationId: string;
		readonly agentSandboxId: string;
		readonly ownerUserId: string;
		readonly graphOwnerPrincipal: string;
		readonly graphId: string;
	};
};

interface ChildDispatcher {
	handle(input: DispatcherInput): Promise<DispatcherResult>;
	stop(): Promise<void>;
}

interface InterceptionEvidence {
	readonly parentSessionId: string;
	readonly childSessionId: string;
	readonly childRunId: string;
	readonly childSandboxId: string;
	readonly originalDelete: RlmDeleteSubagentResult;
	readonly exactReplay: RlmDeleteSubagentResult;
	readonly childAsParentDenial: string;
	readonly secondParentDenial: string;
}

async function exerciseDenialsAndReplay(
	harness: LocalHarness,
	handle: (input: DispatcherInput) => Promise<DispatcherResult>,
	input: DispatcherInput,
): Promise<InterceptionEvidence> {
	let childSessionId = "";
	let childRunId = "";
	let childSandboxId = "";
	await waitFor(async () => {
		const controls = await harness.runtime.listAgentSessionChildControls(input.parent.sessionId, {
			includeClosed: true,
		});
		const child = controls.find((control) => control.child_name === "phanes-researcher");
		if (!child || child.run_state !== "claimed") return false;
		const materialization = await harness.runtime.readAgentMaterialization(child.child_session_id, 0);
		if (!materialization || materialization.state !== "running") return false;
		if (harness.spawner.sessionBodyCount(child.child_session_id) !== 1) return false;
		childSessionId = child.child_session_id;
		childRunId = child.child_run_id;
		childSandboxId = materialization.sandbox_id;
		return true;
	}, "F6 simple child did not materialize its exact worker body");
	const childMaterialization = await harness.runtime.readAgentMaterialization(childSessionId, 0);
	assert.ok(childMaterialization);
	let childAsParentDenial = "";
	await assert.rejects(
		handle({
			requestId: "arc-f6-child-as-parent-denial",
			payload: {
				type: "rlm.run",
				prompt: "This forbidden grandchild must never materialize.",
				kwargs: { name: "forbidden-grandchild", model: "mock:done" },
			},
			parent: {
				sessionId: childSessionId,
				generation: 0,
				activationId: childMaterialization.activation_id,
				agentSandboxId: childSandboxId,
				ownerUserId: OWNER_USER_ID,
				graphOwnerPrincipal: HOME_OWNER,
				graphId: HOME_GRAPH,
			},
		}),
		(error: unknown) => {
			assert.ok(error instanceof AgentSessionChildHostRequestFault);
			assert.equal(error.structured.code, "children_not_granted");
			childAsParentDenial = error.structured.code;
			return true;
		},
	);
	assert.equal(
		(await harness.runtime.listAgentSessionChildControls(childSessionId, { includeClosed: true })).length,
		0,
	);

	const originalDelete = (await handle(input)) as RlmDeleteSubagentResult;
	const replayOne = (await handle(input)) as RlmDeleteSubagentResult;
	const replayTwo = (await handle(input)) as RlmDeleteSubagentResult;
	assert.equal(JSON.stringify(replayOne), JSON.stringify(originalDelete));
	assert.deepEqual(replayTwo, originalDelete);
	let secondParentDenial = "";
	await assert.rejects(
		handle({
			requestId: "arc-f6-second-parent-denial",
			payload: {
				type: "rlm.run",
				prompt: "This second distinct parent child must be denied.",
				kwargs: { name: "forbidden-second-child", model: "mock:rlm_f6_blocked_child" },
			},
			parent: input.parent,
		}),
		(error: unknown) => {
			assert.ok(error instanceof AgentSessionChildHostRequestFault);
			assert.equal(error.structured.code, "max_children_exhausted");
			secondParentDenial = error.structured.code;
			return true;
		},
	);
	return {
		parentSessionId: input.parent.sessionId,
		childSessionId,
		childRunId,
		childSandboxId,
		originalDelete,
		exactReplay: replayTwo,
		childAsParentDenial,
		secondParentDenial,
	};
}

async function assertGoldDurability(
	harness: LocalHarness,
	evidence: InterceptionEvidence,
	run: RunRecord,
): Promise<void> {
	await waitFor(
		async () => (await harness.runtime.readAgentSessionFamilyProjectionOutboxNextAvailableAt(Date.now())) === null,
		"F6 family projection outbox did not drain",
	);
	const parent = await harness.runtime.readAgentSession(evidence.parentSessionId);
	const parentMaterialization = await harness.runtime.readAgentMaterialization(evidence.parentSessionId, 0);
	const child = await harness.runtime.readAgentSession(evidence.childSessionId);
	const childRun = await harness.runtime.readAgentSessionChildRun(evidence.childRunId);
	const childMaterialization = await harness.runtime.readAgentMaterialization(evidence.childSessionId, 0);
	const controls = await harness.runtime.listAgentSessionChildControls(evidence.parentSessionId, {
		includeClosed: true,
	});
	assert.equal(parent?.lifecycle_state, "open");
	assert.notEqual(parent?.status, "failed");
	assert.equal(parentMaterialization?.state, "running");
	assert.equal(harness.spawner.sessionBodyCount(evidence.parentSessionId), 2);
	assert.equal(child?.lifecycle_state, "closed");
	assert.equal(childRun?.state, "cancelled");
	assert.equal(childMaterialization?.state, "cancelled");
	assert.equal(harness.spawner.sessionBodyCount(evidence.childSessionId), 0);
	assert.equal(harness.spawner.getActive().has(evidence.childSandboxId), false);
	assert.equal(controls.length, 1);
	assert.equal(controls[0]?.child_run_id, evidence.childRunId);
	assert.deepEqual(evidence.exactReplay, evidence.originalDelete);
	assert.equal(evidence.childAsParentDenial, "children_not_granted");
	assert.equal(evidence.secondParentDenial, "max_children_exhausted");

	const allocationRows = await runtimeRows(
		harness.runtime,
		`SELECT allocation_id FROM agent_session_child_budget_allocations
		 WHERE child_session_id = ?`,
		[evidence.childSessionId],
	);
	assert.equal(allocationRows.length, 1);
	const allocation = await harness.runtime.readAgentSessionChildBudgetAllocation(
		String(allocationRows[0]!.allocation_id),
	);
	assert.equal(allocation?.state, "settled");
	const childBudget = await harness.runtime.readAgentSessionBudgetSnapshot(evidence.childSessionId);
	assert.equal(childBudget?.account.spent.costUsdMicros, 0);
	const cancellations = await harness.runtime.listAgentSessionChildCancellationRequests(evidence.childRunId);
	assert.ok(cancellations.some((request) => request.actor.kind === "parent_materialization"));
	const family = await harness.runtime.readAgentSessionFamilyProjection(evidence.parentSessionId);
	assert.ok(family);
	assert.equal(family.children.length, 1);
	assert.equal(family.children[0]?.childRunState, "cancelled");
	assert.equal(family.children[0]?.child.sessionState, "closed");
	assert.equal(family.children[0]?.materializationState, "cancelled");
	assert.ok(harness.projectionUpdates.length > 0);
	const display = JSON.stringify({ family, updates: harness.projectionUpdates });
	for (const forbidden of [
		CHILD_PROMPT,
		"mock:rlm_f6_blocked_child",
		evidence.childRunId,
		evidence.childSandboxId,
		TOKEN,
		"arc-f6-local-only",
	]) {
		assert.equal(display.includes(forbidden), false, `F6 family display leaked ${forbidden}`);
	}
	const journal = JSON.stringify(
		(await harness.runtime.listExecutionJournal(evidence.parentSessionId)).map((cell) => cell.outputs),
	);
	assert.match(journal, /F6 sole child admitted/);
	assert.match(journal, /F6 exact child deletion observed/);
	assert.match(journal, /F6 parent continued after bounded child cancellation 1/);
	const durable = await runtimeRows(
		harness.runtime,
		`SELECT
			(SELECT COUNT(*) FROM agent_session_child_runs WHERE parent_session_id = ?) AS childRuns,
			(SELECT COUNT(*) FROM agent_session_child_spawn_requests WHERE parent_session_id = ? AND decision = 'denied') AS parentDenials,
			(SELECT COUNT(*) FROM agent_session_child_spawn_requests WHERE parent_session_id = ? AND decision = 'denied') AS childDenials,
			(SELECT COUNT(*) FROM effect_handoffs WHERE run_id = ? AND state = 'executed') AS executedEffects,
			(SELECT COUNT(*) FROM effect_handoffs WHERE run_id = ?) AS effectCount`,
		[evidence.parentSessionId, evidence.parentSessionId, evidence.childSessionId, run.runId, run.runId],
	);
	assert.deepEqual(durable[0], {
		childRuns: 1,
		parentDenials: 1,
		childDenials: 1,
		executedEffects: 1,
		effectCount: 1,
	});
}

function readPhanesSeed(bundleDigest: string): MaterializedSeed {
	const result = spawnSync(
		"uv",
		[
			"run",
			"python",
			PHANES_DRIVER!,
			"seed",
			"--runtime-bundle-digest",
			bundleDigest,
			"--pilot-model",
			"mock:rlm_f6_parent",
			"--emanation-model",
			"mock:rlm_f6_blocked_child",
		],
		{ cwd: PHANES_ROOT!, encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout) as MaterializedSeed;
}

interface DriverReceipt {
	readonly schema: string;
	readonly turn: { readonly responseMessageId: string; readonly runId: string };
	readonly events: readonly string[];
	readonly sourceCommit: { readonly updates: number; readonly queries: number; readonly tripleCount: number };
	readonly grantReads: number;
	readonly effect: {
		readonly editCount: number;
		readonly content: string;
		readonly attachmentCount: number;
		readonly duplicateClaim: boolean;
	};
}

interface DriverProcess {
	readonly process: ChildProcessWithoutNullStreams;
	readonly done: Promise<DriverReceipt>;
	kill(): void;
}

function runPhanesDriver(input: {
	readonly bundleDigest: string;
	readonly socketPath: string;
	readonly statePath: string;
}): DriverProcess {
	const child = spawn(
		"uv",
		[
			"run",
			"python",
			PHANES_DRIVER!,
			"run",
			"--runtime-bundle-digest",
			input.bundleDigest,
			"--pilot-model",
			"mock:rlm_f6_parent",
			"--emanation-model",
			"mock:rlm_f6_blocked_child",
			"--socket",
			input.socketPath,
			"--token",
			TOKEN,
			"--state",
			input.statePath,
		],
		{ cwd: PHANES_ROOT!, stdio: ["ignore", "pipe", "pipe"] },
	);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const done = new Promise<DriverReceipt>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (code !== 0) {
				reject(new Error(`Arc F6 Phanes driver failed code=${String(code)} signal=${String(signal)}: ${stderr}`));
				return;
			}
			try {
				resolve(JSON.parse(stdout) as DriverReceipt);
			} catch (error) {
				reject(new Error(`Arc F6 Phanes driver emitted invalid JSON: ${stdout}`, { cause: error }));
			}
		});
	});
	return {
		process: child,
		done,
		kill() {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		},
	};
}

function childDispatcher(spawner: SandboxSpawner): ChildDispatcher {
	const dispatcher = (spawner as unknown as { childExecutionService?: ChildDispatcher }).childExecutionService;
	assert.ok(dispatcher, "Arc F6 organism requires the production child dispatcher");
	return dispatcher;
}

function requireDocument(documents: Readonly<Record<string, string>>, documentId: string): string {
	const document = documents[documentId];
	assert.notEqual(document, undefined, `missing ${documentId}`);
	return document!;
}

async function runtimeRows(
	runtime: WorkflowRuntimeStore,
	sql: string,
	args: readonly (string | number)[],
): Promise<Record<string, unknown>[]> {
	const result = await (
		runtime as unknown as {
			read(input: {
				readonly sql: string;
				readonly args: readonly (string | number)[];
			}): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
		}
	).read({ sql, args });
	return result.rows.map((row) => ({ ...row }));
}

async function waitFor(check: () => boolean | Promise<boolean>, message: string, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await delay(10);
	}
	throw new Error(message);
}
