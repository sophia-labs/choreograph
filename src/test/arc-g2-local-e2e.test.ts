import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalJson } from "@sophia-labs/canonical-json";
import type { InternalJobRunner } from "../internal-jobs/runner.js";
import { type InternalJobServer, startInternalJobServer } from "../internal-jobs/server.js";
import { phanesDomainTriggerSubmitter } from "../orchestrator.js";
import { digestSophiaAgentSourceTree } from "../runtime-bundles.js";
import { grantDigest, parseAgentToolGrant } from "../workflow/agent-tool-grant.js";
import type { CurrentGrantReader } from "../workflow/current-grant-reader.js";
import type { InvocationEnvelopeV1 } from "../workflow/invocation.js";
import type { AgentSessionScheduleRecord } from "../workflow/runtime-store.js";
import {
	closeLocalHarness,
	configuredPhanesLocalRuntime,
	createLocalHarness,
	executeLocalDomainInvocation,
	LocalGraph,
	type LocalHarness,
} from "./arc-f6-phanes-local-support.js";

const { entrypoint: ENTRYPOINT, phanesRoot: PHANES_ROOT, driver: PHANES_DRIVER, skip } = configuredPhanesLocalRuntime();
const HOME_OWNER = "user:phanes-owner";
const AUTHORITY_OWNER = "user:platform-steward";
const HOME_GRAPH = "phanes";
const AUTHORITY_GRAPH = "observatory";
const OWNER_USER_ID = "phanes-owner";
const ACTOR_REF = `user:${OWNER_USER_ID}`;
const TOKEN = "arc-g2-local-internal-token-0000000000000001";

describe("Arc G2 local Domain organism", { concurrency: false }, () => {
	it(
		"reopens one real heartbeat across hosts A/B/C without duplicating durable evidence",
		{ skip, timeout: 180_000 },
		async () => {
			const tempDir = mkdtempSync(join(tmpdir(), "choreograph-arc-g2-local-"));
			let harness: LocalHarness | undefined;
			let server: InternalJobServer | undefined;
			let driver: ReturnType<typeof runDriver> | undefined;
			let execution: Promise<unknown> | undefined;
			let callbackCount = 0;
			try {
				const bundleDigest = digestSophiaAgentSourceTree(ENTRYPOINT!);
				const seed = readSeed(bundleDigest);
				const grantText = seed.authorityDocuments[seed.agent.grantDocumentId]!;
				const grant = parseAgentToolGrant(JSON.parse(grantText));
				let grantReads = 0;
				const reader: CurrentGrantReader = {
					async readCurrentGrant(ref) {
						assert.deepEqual(ref, {
							grantAuthorityGraphId: seed.agent.grantAuthorityGraphId,
							grantDocumentId: seed.agent.grantDocumentId,
							grantAuthorityOwnerPrincipal: seed.agent.grantAuthorityOwnerPrincipal,
						});
						grantReads++;
						return { canonicalBytes: canonicalJson(grant), digest: grantDigest(grant), revision: "phanes-g2-r1" };
					},
				};

				const home = new LocalGraph(HOME_GRAPH, seed.graphDocuments);
				const authority = new LocalGraph(AUTHORITY_GRAPH, seed.authorityDocuments);
				harness = await createLocalHarness(tempDir, "arc-g2-host-a", { currentGrantReader: reader });
				await harness.spawner.start();
				const fakeFetch: typeof fetch = async (_url, init) => {
					callbackCount++;
					const envelope = JSON.parse(String(init?.body)) as InvocationEnvelopeV1;
					assert.equal(envelope.schema, "choreograph.invocation-envelope.v1");
					assert.deepEqual(envelope.graph, { ownerPrincipal: HOME_OWNER, graphId: HOME_GRAPH });
					execution = executeLocalDomainInvocation({
						harness: harness!,
						home,
						authority,
						envelope,
						runId: "wfr-arc-g2-local",
						homeGraphId: HOME_GRAPH,
						homeOwnerPrincipal: HOME_OWNER,
						authorityGraphId: AUTHORITY_GRAPH,
						authorityOwnerPrincipal: AUTHORITY_OWNER,
						ownerUserId: OWNER_USER_ID,
						actorRef: ACTOR_REF,
						now: 1_785_888_000_001,
						internalServiceSecret: "arc-g2-local-only",
						capabilityGateError: "Arc G2 mock model must not cross the graph capability gate",
						onResolved: (resolved) => {
							const runtimes = resolved.runtimes as { pilot: typeof resolved.runtimes.pilot };
							runtimes.pilot = {
								...runtimes.pilot,
								constraints: { ...runtimes.pilot.constraints, idlePassivateMs: 60_000 },
							};
						},
						deterministicNode: (spec, now) =>
							spec.label === "pilot-attend"
								? {
										label: spec.label,
										phaseIndex: spec.phaseIndex,
										state: "done",
										output:
											"No workflow-level emanation is needed; the respondent may use its sole bounded RLM child.",
										structured: {
											reason: "One respondent-local bounded investigation is sufficient.",
											tasks: [],
											program: null,
										},
										model: spec.model,
										agentId: spec.agentId,
										turns: 1,
										toolCalls: 0,
										tokens: 0,
										queuedAt: now,
										startedAt: now,
										durationMs: 0,
										agentType: spec.agentType,
									}
								: undefined,
					});
					return Response.json(
						{ runId: "wfr-arc-g2-local", invocationId: envelope.invocationId },
						{ status: 202 },
					);
				};
				const domainTrigger = phanesDomainTriggerSubmitter(
					fakeFetch,
					{
						MNEMOSYNE_INTERNAL_SERVICE_SECRET: "arc-g2-internal-service-secret",
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
				driver = runDriver(bundleDigest, socketPath, join(tempDir, "phanes-turns.sqlite"));
				await Promise.race([
					waitFor(() => execution !== undefined, "Phanes trigger did not admit the G2 Domain invocation"),
					driver.done.then(() => {
						throw new Error("Phanes driver completed without admitting the G2 Domain invocation");
					}),
				]);
				await execution;
				await driver.done;

				// Host A: the real Domain worker creates the heartbeat and remains resident
				// long enough for production supervision to deliver the first live follow-up.
				const first = await waitForValue(
					async () => {
						const schedule = await oneSchedule(harness!);
						if (!schedule || schedule.fire_count !== 1) return undefined;
						const fires = await harness!.runtime.listAgentSessionScheduleFires(
							schedule.session_id,
							schedule.schedule_id,
						);
						return fires[0]?.state === "completed" ? { schedule, fire: fires[0] } : undefined;
					},
					"Host A did not settle the first heartbeat fire",
					45_000,
				);
				assert.equal(first.schedule.source, "rlm_heartbeat");
				assert.equal(first.schedule.delivery_mode, "follow_up");
				assert.equal(first.fire.requested_delivery_mode, "follow_up");
				assert.equal(first.fire.command_name, "follow_up");
				assert.equal(first.fire.target_generation, 0);
				assert.deepEqual(await authorityAttemptProof(harness, first.fire.fire_id), [
					[1, "accepted", "phanes-g2-r1"],
				]);
				assert.equal(callbackCount, 1);

				await server.close();
				server = undefined;
				await closeLocalHarness(harness);
				harness = undefined;

				// Host B: reopen the same durable stores before the interval's next due
				// horizon. The production scheduler creates fire #2 and, because A
				// passivated generation 0, embodies the immutable command as prompt at N+1.
				harness = await createLocalHarness(tempDir, "arc-g2-host-b", { currentGrantReader: reader });
				await harness.spawner.start();
				assert.equal((await oneSchedule(harness))?.fire_count, 1);
				const second = await waitForValue(
					async () => {
						const schedule = await oneSchedule(harness!);
						if (!schedule || schedule.fire_count < 2) return undefined;
						const fires = await harness!.runtime.listAgentSessionScheduleFires(
							schedule.session_id,
							schedule.schedule_id,
						);
						return fires[1]?.state === "completed" ? { schedule, fire: fires[1] } : undefined;
					},
					"Host B did not create and settle the second heartbeat fire",
					45_000,
				);
				assert.equal(second.fire.requested_delivery_mode, "follow_up");
				assert.equal(second.fire.command_name, "prompt");
				assert.equal(second.fire.target_generation, first.fire.target_generation + 1);
				const secondCommand = await harness.runtime.readAgentSessionCommand(second.fire.command_id);
				assert.equal(secondCommand?.name, "prompt");
				assert.equal(secondCommand?.target_generation, second.fire.target_generation);
				assert.equal(secondCommand?.payload.text, second.schedule.prompt.text);
				assert.deepEqual(await authorityAttemptProof(harness, second.fire.fire_id), [
					[1, "accepted", "phanes-g2-r1"],
				]);
				const cancelledSchedule = await waitForValue(
					async () => {
						const schedule = await oneSchedule(harness!);
						return schedule?.state === "cancelled" ? schedule : undefined;
					},
					"Host B did not cancel the recurring heartbeat after fire #2",
					10_000,
				);
				assert.equal(cancelledSchedule.fire_count, 2);
				await harness.spawner.shutdownAll();
				await waitFor(
					async () =>
						(await harness!.runtime.readAgentMaterialization(first.fire.session_id, 1))?.state === "passivated",
					"Host B did not settle and passivate generation N+1",
					20_000,
				);
				assert.equal(harness.spawner.sessionBodyCount(first.fire.session_id), 0);
				const proofB = await durableProof(harness, second.schedule);
				assert.equal(proofB.callbackCount, callbackCount);
				assert.equal(proofB.materializations.filter((item) => item !== null).length, 2);
				await closeLocalHarness(harness);
				harness = undefined;

				// Host C: startup recovery/rescan sees only completed immutable work.
				harness = await createLocalHarness(tempDir, "arc-g2-host-c", { currentGrantReader: reader });
				await harness.spawner.start();
				const proofC = await durableProof(harness, second.schedule);
				assert.deepEqual(proofC, proofB);
				assert.equal(callbackCount, 1);
				assert.equal(grantReads, 2);
				assert.equal(harness.spawner.sessionBodyCount(first.fire.session_id), 0);
			} finally {
				if (driver) driver.kill();
				await server?.close().catch(() => undefined);
				if (harness) await closeLocalHarness(harness).catch(() => undefined);
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	);
});

interface Seed {
	readonly agent: {
		readonly definitionDocumentId: string;
		readonly grantDocumentId: string;
		readonly grantAuthorityGraphId: string;
		readonly grantAuthorityOwnerPrincipal: string;
	};
	readonly graphDocuments: Readonly<Record<string, string>>;
	readonly authorityDocuments: Readonly<Record<string, string>>;
}

function readSeed(bundleDigest: string): Seed {
	const result = spawnSync(
		"uv",
		[
			"run",
			"python",
			PHANES_DRIVER!,
			"seed",
			"--allow-schedules-for-test",
			"--runtime-bundle-digest",
			bundleDigest,
			"--pilot-model",
			"mock:rlm_g2_heartbeat",
			"--emanation-model",
			"mock:rlm_f6_blocked_child",
		],
		{ cwd: PHANES_ROOT!, encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout) as Seed;
}

function runDriver(bundleDigest: string, socketPath: string, statePath: string) {
	const child = spawn(
		"uv",
		[
			"run",
			"python",
			PHANES_DRIVER!,
			"run",
			"--allow-schedules-for-test",
			"--runtime-bundle-digest",
			bundleDigest,
			"--pilot-model",
			"mock:rlm_g2_heartbeat",
			"--emanation-model",
			"mock:rlm_f6_blocked_child",
			"--socket",
			socketPath,
			"--token",
			TOKEN,
			"--state",
			statePath,
		],
		{ cwd: PHANES_ROOT!, stdio: ["ignore", "pipe", "pipe"] },
	);
	let error = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		error += chunk;
	});
	return {
		done: new Promise<void>((resolve, reject) =>
			child.once("close", (code) =>
				code === 0 ? resolve() : reject(new Error(`G2 driver failed ${String(code)}: ${error}`)),
			),
		),
		kill: () => {
			if (child.exitCode === null) child.kill("SIGTERM");
		},
	};
}

async function oneSchedule(harness: LocalHarness): Promise<AgentSessionScheduleRecord | null> {
	const result = await (
		harness.runtime as unknown as {
			read(input: {
				sql: string;
				args: unknown[];
			}): Promise<{ rows: Array<{ session_id: string; schedule_id: string }> }>;
		}
	).read({
		sql: "SELECT session_id, schedule_id FROM agent_session_schedules WHERE source = 'rlm_heartbeat'",
		args: [],
	});
	const row = result.rows[0];
	return row ? await harness.runtime.readAgentSessionSchedule(row.session_id, row.schedule_id) : null;
}

async function authorityAttemptProof(harness: LocalHarness, fireId: string) {
	const attempts = await harness.runtime.listAgentSessionScheduleFireAuthorityAttempts(fireId);
	return attempts.map((attempt) => [attempt.attempt, attempt.outcome, attempt.revision]);
}

async function durableProof(harness: LocalHarness, schedule: AgentSessionScheduleRecord): Promise<DurableProof> {
	const fires = await harness.runtime.listAgentSessionScheduleFires(schedule.session_id, schedule.schedule_id);
	const commands = await harness.runtime.listAgentSessionCommands(schedule.session_id);
	const materializations = await Promise.all([
		harness.runtime.readAgentMaterialization(schedule.session_id, 0),
		harness.runtime.readAgentMaterialization(schedule.session_id, 1),
	]);
	return {
		callbackCount: 1,
		fires: fires.map((fire) => [
			fire.fire_id,
			fire.command_id,
			fire.ordinal,
			fire.target_generation,
			fire.requested_delivery_mode,
			fire.command_name,
			fire.state,
		]),
		attempts: await Promise.all(fires.map((fire) => authorityAttemptProof(harness, fire.fire_id))),
		commands: commands.map((command) => [command.command_id, command.name, command.target_generation, command.state]),
		materializations: materializations.map((materialization) =>
			materialization
				? [
						materialization.generation,
						materialization.activation_id,
						materialization.sandbox_id,
						materialization.state,
					]
				: null,
		),
		events: await harness.runtime.listAgentSessionEvents(schedule.session_id),
		bodies: harness.sandboxStore.list().map((record) => record.sandbox_id),
	};
}

interface DurableProof {
	readonly callbackCount: number;
	readonly fires: readonly unknown[];
	readonly attempts: readonly unknown[];
	readonly commands: readonly unknown[];
	readonly materializations: readonly unknown[];
	readonly events: readonly unknown[];
	readonly bodies: readonly string[];
}

async function waitFor(check: () => boolean | Promise<boolean>, message: string, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await delay(10);
	}
	throw new Error(message);
}

async function waitForValue<T>(read: () => Promise<T | undefined>, message: string, timeoutMs = 30_000): Promise<T> {
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
