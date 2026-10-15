import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createClient } from "@libsql/client";
import { digestAgentRuntimeBinding } from "../agent-runtime/profile.js";
import {
	AgentSessionScheduleFault,
	type AgentSessionScheduleFireClaim,
	agentNodeSpecForScheduledActivation,
	WorkflowRuntimeStore,
} from "../workflow/runtime-store.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

describe("Arc G1 durable Agent Session schedules", () => {
	it("admits only an explicit durable Prime grant and preserves exact idempotent creation testimony", async () => {
		await withTwoStores(async (first, second) => {
			const enabled = await seedSession(first, "authority-enabled", { allowSchedules: true });
			const input = {
				requestId: "req-create-authority",
				scheduleId: "schedule-authority",
				definition: { kind: "once" as const, fireAt: 1_000 },
				prompt: { text: "Resume the durable inquiry." },
				clientId: "host:authority-proof",
				now: 100,
			};
			const created = await first.createAgentSessionSchedule(enabled.sessionId, input);
			assert.equal(created.created, true);
			assert.deepEqual(created.schedule.definition, input.definition);
			assert.deepEqual(created.schedule.prompt, input.prompt);

			const replay = await second.createAgentSessionSchedule(enabled.sessionId, input);
			assert.equal(replay.created, false);
			assert.deepEqual(replay.schedule, created.schedule);
			await assert.rejects(
				second.createAgentSessionSchedule(enabled.sessionId, {
					...input,
					scheduleId: "schedule-authority-changed",
				}),
				isScheduleFault("request_conflict"),
			);

			const events = await first.listAgentSessionEvents(enabled.sessionId);
			const testimony = events.filter((event) => event.type === "schedule.created");
			assert.equal(testimony.length, 1);
			assert.equal(testimony[0]?.causation_id, input.requestId);
			assert.equal(testimony[0]?.command_id, null);
			assert.deepEqual(testimony[0]?.payload, {
				schema: "choreograph.agent-session-schedule-created.v1",
				scheduleId: input.scheduleId,
				requestId: input.requestId,
				schedule: {
					kind: "once",
					expression: new Date(input.definition.fireAt).toISOString(),
					timeZone: "UTC",
				},
				input: input.prompt,
				nextFireAt: new Date(input.definition.fireAt).toISOString(),
			});

			const disabledPrime = await seedSession(first, "authority-disabled-prime");
			await assert.rejects(
				first.createAgentSessionSchedule(disabledPrime.sessionId, {
					...input,
					requestId: "req-disabled-prime",
					scheduleId: "schedule-disabled-prime",
					now: 101,
				}),
				isScheduleFault("request_invalid"),
			);
			const simple = await seedSession(first, "authority-simple", { kind: "simple" });
			await assert.rejects(
				first.createAgentSessionSchedule(simple.sessionId, {
					...input,
					requestId: "req-simple",
					scheduleId: "schedule-simple",
					now: 101,
				}),
				isScheduleFault("request_invalid"),
			);
			await assert.rejects(
				first.createAgentSessionSchedule(enabled.sessionId, {
					...input,
					requestId: "req-too-fast",
					scheduleId: "schedule-too-fast",
					definition: { kind: "interval", firstFireAt: 2_000, intervalMs: 9_999 },
					now: 102,
				}),
				isScheduleFault("request_invalid"),
			);
			await assert.rejects(
				first.createAgentSessionSchedule(enabled.sessionId, {
					...input,
					requestId: "req-clock-regression",
					scheduleId: "schedule-clock-regression",
					now: 99,
				}),
				isScheduleFault("clock_regression"),
			);

			const ordinaryCancellation = await first.requestAgentSessionCancellation(simple.sessionId, {
				requestId: "cancel-simple-without-schedule-grant",
				actor: { kind: "owner_api", ownerUserId: "user-g1" },
				reason: "ordinary Session cancellation remains independent of schedule authority",
				now: 103,
			});
			assert.equal(ordinaryCancellation.applied, true);

			const columns = await first.raw("PRAGMA table_info(agent_session_events)");
			assert.ok(columns.rows.some((row) => row.name === "causation_id"));
			assert.ok(columns.rows.some((row) => row.name === "command_id"));
		});
	});

	it("migrates existing event journals to preserve causal and command coordinates", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-g1-event-migration-"));
		const path = join(directory, "runtime.sqlite");
		const legacy = createClient({ url: `file:${path}` });
		await legacy.execute(`CREATE TABLE agent_session_events (
			session_id TEXT NOT NULL,
			seq INTEGER NOT NULL,
			ts INTEGER NOT NULL,
			type TEXT NOT NULL,
			payload_json TEXT,
			PRIMARY KEY (session_id, seq)
		)`);
		legacy.close();
		const store = new InspectableWorkflowRuntimeStore(path);
		try {
			await store.init();
			const columns = await store.raw("PRAGMA table_info(agent_session_events)");
			assert.ok(columns.rows.some((row) => row.name === "causation_id"));
			assert.ok(columns.rows.some((row) => row.name === "command_id"));
		} finally {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("round-trips the exact root execution authority for a scheduled activation without an initial turn", async () => {
		await withTwoStores(async (store) => {
			const seeded = await seedSession(store, "reconstruct-rich", {
				allowSchedules: true,
				node: {
					systemPrompt: "Continue the same durable investigation.",
					graphAccess: "read",
					toolMode: "dynamic",
					excludeTools: ["write_graph"],
					includeTools: ["recall"],
					strictToolManifest: true,
					interactionMode: "headed",
					schema: {
						type: "object",
						properties: { answer: { type: "string" } },
						required: ["answer"],
						additionalProperties: false,
					},
					maxTurns: 12,
					agentType: "scheduled-researcher",
					poolMode: "differentiated",
					capabilities: {
						subject: {
							kind: "web",
							engine: "camoufox",
							boundOrigin: "https://example.com",
							storageStateRef: "secret/browser-state",
							accessLevel: "ro",
						},
					},
					initialGoal: { objective: "Keep the durable inquiry coherent.", tokenBudget: 5_000 },
				},
			});
			const session = await store.readAgentSession(seeded.sessionId);
			assert.ok(session);
			const spec = agentNodeSpecForScheduledActivation(session, {
				generation: 3,
				activationId: "act-g1-reconstruct-rich-3",
			});
			assert.deepEqual(
				{
					nodeKey: spec.nodeKey,
					sessionId: spec.sessionId,
					depth: spec.depth,
					sandboxGeneration: spec.sandboxGeneration,
					invocationId: spec.invocationId,
					awaitInitialCommand: spec.awaitInitialCommand,
					label: spec.label,
					phaseIndex: spec.phaseIndex,
					prompt: spec.prompt,
					systemPrompt: spec.systemPrompt,
					agentId: spec.agentId,
					graphAccess: spec.graphAccess,
					model: spec.model,
					provider: spec.provider,
					graphId: spec.graphId,
					toolMode: spec.toolMode,
					excludeTools: spec.excludeTools,
					includeTools: spec.includeTools,
					strictToolManifest: spec.strictToolManifest,
					interactionMode: spec.interactionMode,
					schema: spec.schema,
					maxTurns: spec.maxTurns,
					agentType: spec.agentType,
					poolMode: spec.poolMode,
					capabilities: spec.capabilities,
					initialGoal: spec.initialGoal,
				},
				{
					nodeKey: "1:scheduled-prime",
					sessionId: seeded.sessionId,
					depth: 0,
					sandboxGeneration: 3,
					invocationId: "act-g1-reconstruct-rich-3",
					awaitInitialCommand: true,
					label: "scheduled-prime",
					phaseIndex: 1,
					prompt: "Await durable scheduled input.",
					systemPrompt: "Continue the same durable investigation.",
					agentId: session.agent_id,
					graphAccess: "read",
					model: "mock:done",
					provider: "openrouter",
					graphId: "g1-scheduler-proof",
					toolMode: "dynamic",
					excludeTools: ["write_graph"],
					includeTools: ["recall"],
					strictToolManifest: true,
					interactionMode: "headed",
					schema: {
						type: "object",
						properties: { answer: { type: "string" } },
						required: ["answer"],
						additionalProperties: false,
					},
					maxTurns: 12,
					agentType: "scheduled-researcher",
					poolMode: "differentiated",
					capabilities: {
						subject: {
							kind: "web",
							engine: "camoufox",
							boundOrigin: "https://example.com",
							storageStateRef: "secret/browser-state",
							accessLevel: "ro",
						},
					},
					initialGoal: { objective: "Keep the durable inquiry coherent.", tokenBudget: 5_000 },
				},
			);
			assert.deepEqual(spec.runtime, JSON.parse(session.document_json).source.runtimeBinding);
			assert.deepEqual(spec.ontology, JSON.parse(session.document_json).source.agentOntologyBinding);
			assert.equal(spec.runtimeBindingDigest, JSON.parse(session.document_json).source.runtimeBindingDigest);
			assert.equal(spec.ontologyBindingDigest, JSON.parse(session.document_json).source.agentOntologyBindingDigest);
			assert.equal(Object.hasOwn(spec, "restoreState"), false);

			const sparse = await seedSession(store, "reconstruct-sparse", { allowSchedules: true });
			const sparseSession = await store.readAgentSession(sparse.sessionId);
			assert.ok(sparseSession);
			const sparseSource = JSON.parse(sparseSession.document_json).source as Record<string, unknown>;
			for (const field of [
				"systemPrompt",
				"graphAccess",
				"toolMode",
				"excludeTools",
				"includeTools",
				"strictToolManifest",
				"interactionMode",
				"schema",
				"maxTurns",
				"agentType",
				"poolMode",
				"capabilities",
				"initialGoal",
			]) {
				assert.equal(Object.hasOwn(sparseSource, field), false, `${field} must not persist as undefined`);
			}
		});
	});

	it("fails closed on child, non-Prime, digest-divergent, and poisoned scheduled activation sources", async () => {
		await withTwoStores(async (store) => {
			const enabled = await seedSession(store, "reconstruct-adversarial", { allowSchedules: true });
			const session = await store.readAgentSession(enabled.sessionId);
			assert.ok(session);
			const activation = { generation: 1, activationId: "act-g1-reconstruct-adversarial" };
			const poison = (
				mutate: (document: {
					source: Record<string, unknown>;
					meaningfulObjects: Record<string, Record<string, unknown>>;
				}) => void,
			) => {
				const document = JSON.parse(session.document_json) as {
					source: Record<string, unknown>;
					meaningfulObjects: Record<string, Record<string, unknown>>;
				};
				mutate(document);
				return { ...session, document_json: JSON.stringify(document) };
			};
			for (const poisoned of [
				{ ...session, family_root_session_id: "ags-g1-parent" },
				poison((document) => {
					document.source.kind = "child-admission";
				}),
				poison((document) => {
					document.source.runtimeBindingDigest = `sha256:${"0".repeat(64)}`;
				}),
				poison((document) => {
					document.source.agentOntologyBindingDigest = `sha256:${"0".repeat(64)}`;
				}),
				poison((document) => {
					document.source.capabilities = { subject: { kind: "shell" } };
				}),
				poison((document) => {
					document.source.untrustedProviderOverride = "ambient";
				}),
				poison((document) => {
					document.meaningfulObjects.workflowNode.digest = `sha256:${"f".repeat(64)}`;
				}),
			]) {
				assert.throws(
					() => agentNodeSpecForScheduledActivation(poisoned, activation),
					isScheduleFault("materialization_conflict"),
				);
			}

			for (const [suffix, options] of [
				["reconstruct-simple", { kind: "simple" as const, allowSchedules: false }],
				["reconstruct-no-grant", { kind: "prime" as const, allowSchedules: false }],
			] as const) {
				const denied = await seedSession(store, suffix, options);
				const deniedSession = await store.readAgentSession(denied.sessionId);
				assert.ok(deniedSession);
				assert.throws(
					() => agentNodeSpecForScheduledActivation(deniedSession, activation),
					isScheduleFault("materialization_conflict"),
				);
			}
		});
	});

	it("rejects node capability and durable host-tool requirements without erasing their descriptors", async () => {
		await withTwoStores(async (store) => {
			const web = await seedSession(store, "external-node-capability", {
				allowSchedules: true,
				node: {
					capabilities: {
						subject: {
							kind: "web",
							engine: "chromium",
							boundOrigin: "https://example.com",
							accessLevel: "ro",
						},
					},
				},
			});
			await assert.rejects(
				store.createAgentSessionSchedule(web.sessionId, {
					requestId: "req-external-node-capability",
					scheduleId: "schedule-external-node-capability",
					definition: { kind: "once", fireAt: 100 },
					prompt: { text: "Do not silently reconstruct browser authority." },
					clientId: "host:authority-restriction",
					now: 10,
				}),
				isScheduleFault("request_invalid"),
			);
			const webSession = await store.readAgentSession(web.sessionId);
			assert.ok(webSession);
			assert.deepEqual(JSON.parse(webSession.document_json).source.capabilities, {
				subject: {
					kind: "web",
					engine: "chromium",
					boundOrigin: "https://example.com",
					accessLevel: "ro",
				},
			});
			assert.deepEqual(await store.listAgentSessionSchedules(web.sessionId), []);

			const included = await seedSession(store, "included-host-tool", {
				allowSchedules: true,
				node: { toolMode: "dynamic", includeTools: ["recall"], strictToolManifest: true },
			});
			await assert.rejects(
				store.createAgentSessionSchedule(included.sessionId, {
					requestId: "req-included-host-tool",
					scheduleId: "schedule-included-host-tool",
					definition: { kind: "once", fireAt: 100 },
					prompt: { text: "Do not promote a curated include into durable authority." },
					clientId: "host:authority-restriction",
					now: 11,
				}),
				isScheduleFault("request_invalid"),
			);

			const catalog = await seedSession(store, "external-catalog-capability", { allowSchedules: true });
			await store.raw("UPDATE workflow_instances SET inputs_json = ? WHERE run_id = ?", [
				JSON.stringify({
					hostContext: {
						schema: "sophia.domain-agent-host-context.v1",
						toolbelt: {
							capabilities: [{ capability: "mnemosyne" }],
							tools: [{ name: "recall", capability: "mnemosyne", available: true }],
						},
					},
				}),
				`wfr-g1-external-catalog-capability`,
			]);
			await assert.rejects(
				store.createAgentSessionSchedule(catalog.sessionId, {
					requestId: "req-external-catalog-capability",
					scheduleId: "schedule-external-catalog-capability",
					definition: { kind: "once", fireAt: 100 },
					prompt: { text: "Do not silently reconstruct a host tool grant." },
					clientId: "host:authority-restriction",
					now: 12,
				}),
				isScheduleFault("request_invalid"),
			);
			assert.deepEqual(await store.listAgentSessionSchedules(catalog.sessionId), []);
		});
	});

	it("auto-cancels authority drift once before due-to-fire and preserves create replay", async () => {
		await withTwoStores(async (first, second) => {
			const seeded = await seedSession(first, "authority-drift", { allowSchedules: true });
			const input = {
				requestId: "req-authority-drift",
				scheduleId: "schedule-authority-drift",
				definition: { kind: "once" as const, fireAt: 100 },
				prompt: { text: "This must not fire after external authority appears." },
				clientId: "host:authority-drift",
				now: 10,
			};
			const created = await first.createAgentSessionSchedule(seeded.sessionId, input);
			assert.equal(created.created, true);

			const session = await first.readAgentSession(seeded.sessionId);
			assert.ok(session);
			const document = JSON.parse(session.document_json) as {
				source: Record<string, unknown>;
			};
			document.source.capabilities = {
				subject: { kind: "web", engine: "camoufox", accessLevel: "ro" },
			};
			await first.raw("UPDATE agent_sessions SET document_json = ?, updated_at = ? WHERE session_id = ?", [
				JSON.stringify(document),
				50,
				seeded.sessionId,
			]);

			const replay = await second.createAgentSessionSchedule(seeded.sessionId, input);
			assert.equal(replay.created, false);
			assert.equal(replay.schedule.state, "active");
			assert.equal(
				await Promise.all([
					first.claimDueAgentSessionScheduleFire({ consumer: "scheduler-authority-a", leaseMs: 100, now: 100 }),
					second.claimDueAgentSessionScheduleFire({ consumer: "scheduler-authority-b", leaseMs: 100, now: 100 }),
				]).then((claims) => claims.filter(Boolean).length),
				0,
			);
			const cancelled = await first.readAgentSessionSchedule(seeded.sessionId, input.scheduleId);
			assert.equal(cancelled?.state, "cancelled");
			assert.equal(cancelled?.cancel_reason, "authority_revoked");
			assert.deepEqual(await first.listAgentSessionScheduleFires(seeded.sessionId), []);
			assert.deepEqual(await first.listAgentSessionCommands(seeded.sessionId), []);
			assert.equal(
				(
					await first.raw("SELECT COUNT(*) AS count FROM agent_materializations WHERE session_id = ?", [
						seeded.sessionId,
					])
				).rows[0]?.count,
				0,
			);
			assert.equal(await first.readNextAgentSessionScheduleDueAt(100), null);

			const cancelledEvents = (await first.listAgentSessionEvents(seeded.sessionId)).filter(
				(event) => event.type === "schedule.cancelled",
			);
			assert.equal(cancelledEvents.length, 1);
			assert.ok(cancelledEvents[0]?.causation_id);
			assert.deepEqual(cancelledEvents[0]?.payload, {
				schema: "choreograph.agent-session-schedule-cancelled.v1",
				scheduleId: input.scheduleId,
				requestId: cancelledEvents[0]?.causation_id,
				reason: "authority_revoked",
			});
			const cancellations = await first.raw(
				"SELECT * FROM agent_session_schedule_cancellations WHERE session_id = ? AND schedule_id = ?",
				[seeded.sessionId, input.scheduleId],
			);
			assert.equal(cancellations.rows.length, 1);
			assert.equal(cancellations.rows[0]?.request_id, cancelledEvents[0]?.causation_id);
		});
	});

	it("creates one logical fire, prompt command, and wake coordinate across a two-store race and reclaims it stably", async () => {
		await withTwoStores(async (first, second) => {
			const session = await seedSession(first, "exact-fire", { allowSchedules: true });
			await first.createAgentSessionSchedule(session.sessionId, {
				requestId: "req-exact-fire",
				scheduleId: "schedule-exact-fire",
				definition: { kind: "once", fireAt: 1_000 },
				prompt: { text: "Perform exactly one scheduled turn." },
				clientId: "host:exact-fire",
				now: 100,
			});

			const raced = await Promise.all([
				first.claimDueAgentSessionScheduleFire({ consumer: "scheduler-a", leaseMs: 10, now: 1_000 }),
				second.claimDueAgentSessionScheduleFire({ consumer: "scheduler-b", leaseMs: 10, now: 1_000 }),
			]);
			const logicalClaims = raced.filter((claim): claim is AgentSessionScheduleFireClaim => claim !== null);
			assert.equal(logicalClaims.length, 1);
			const initial = logicalClaims[0]!;
			assert.equal(initial.fire.attempt, 1);
			assert.equal(initial.command.name, "prompt");
			assert.equal(initial.command.state, "queued");
			assert.deepEqual(initial.command.payload, { text: "Perform exactly one scheduled turn." });
			assert.equal(initial.command.target_generation, initial.fire.target_generation);
			assert.equal((await first.listAgentSessionScheduleFires(session.sessionId)).length, 1);
			assert.equal((await first.listAgentSessionCommands(session.sessionId)).length, 1);

			const firedEvent = (await first.listAgentSessionEvents(session.sessionId)).find(
				(event) => event.type === "schedule.fired",
			);
			assert.equal(firedEvent?.causation_id, initial.fire.fire_id);
			assert.equal(firedEvent?.command_id, initial.fire.command_id);
			assert.deepEqual(firedEvent?.payload, {
				schema: "choreograph.agent-session-schedule-fired.v1",
				scheduleId: "schedule-exact-fire",
				fireId: initial.fire.fire_id,
				commandId: initial.fire.command_id,
				scheduledAt: new Date(1_000).toISOString(),
				claimedAt: new Date(1_000).toISOString(),
				nextFireAt: null,
			});

			const retry = await first.settleAgentSessionScheduleFire(initial.fire.fire_id, {
				consumer: initial.fire.consumer!,
				claimToken: initial.fire.claim_token!,
				now: 1_005,
				outcome: "retryable_failure",
				error: "transient activation transport fault",
				retryAt: 1_020,
			});
			assert.equal(retry.state, "pending");
			assert.equal(await second.readNextAgentSessionScheduleDueAt(1_010), 1_020);
			const reclaimed = await second.claimDueAgentSessionScheduleFire({
				consumer: "scheduler-recovery",
				leaseMs: 100,
				now: 1_020,
			});
			assert.ok(reclaimed);
			assert.equal(reclaimed.fire.fire_id, initial.fire.fire_id);
			assert.equal(reclaimed.fire.command_id, initial.fire.command_id);
			assert.equal(reclaimed.fire.activation_id, initial.fire.activation_id);
			assert.equal(reclaimed.fire.target_generation, initial.fire.target_generation);
			assert.equal(reclaimed.fire.attempt, 2);

			await assert.rejects(
				second.settleAgentSessionScheduleFire(reclaimed.fire.fire_id, {
					consumer: reclaimed.fire.consumer!,
					claimToken: reclaimed.fire.claim_token!,
					now: 1_021,
					outcome: "completed",
				}),
				isScheduleFault("materialization_conflict"),
			);
			await second.bindAgentSandbox(session.sessionId, {
				generation: reclaimed.fire.target_generation,
				activationId: reclaimed.fire.activation_id,
				sandboxId: "sbx-g1-exact-fire",
				now: 1_022,
			});
			const delivered = await second.claimExactAgentSessionCommandForDelivery(
				session.sessionId,
				reclaimed.fire.target_generation,
				reclaimed.fire.command_id,
				1_023,
			);
			assert.equal(delivered?.command_id, reclaimed.fire.command_id);
			await second.completeAgentSessionCommand(reclaimed.fire.command_id, reclaimed.fire.target_generation, {
				status: "completed",
				result: { output: "scheduled turn completed" },
				now: 1_024,
			});
			const completed = await second.settleAgentSessionScheduleFire(reclaimed.fire.fire_id, {
				consumer: reclaimed.fire.consumer!,
				claimToken: reclaimed.fire.claim_token!,
				now: 1_025,
				outcome: "completed",
			});
			assert.equal(completed.state, "completed");
			assert.equal(completed.attempt, 2);
			assert.equal(await first.readNextAgentSessionScheduleDueAt(1_026), null);
			await assert.rejects(
				first.raw("UPDATE agent_session_schedule_fires SET scheduled_at = scheduled_at + 1 WHERE fire_id = ?", [
					initial.fire.fire_id,
				]),
				/immutable/i,
			);
		});
	});

	it("reserves N+1 after passivation and joins later due fires to the same claimed activation", async () => {
		await withTwoStores(async (first, second) => {
			const session = await seedSession(first, "passivated-join", {
				allowSchedules: true,
				materialize: true,
			});
			await first.beginAgentSessionKernelLaunch(session.sessionId, 0, {
				activationId: session.activationId,
				sandboxId: "kernel-g1-passivated",
				now: 4,
			});
			await first.bindAgentSessionKernelLaunch(session.sessionId, 0, {
				activationId: session.activationId,
				sandboxId: "kernel-g1-passivated",
				now: 5,
			});
			await first.recordAgentSessionKernelState(session.sessionId, 0, {
				activationId: session.activationId,
				state: "released",
				now: 6,
			});
			await first.raw(
				`UPDATE agent_materializations
				    SET state = 'passivated', checkpoint_id = 'chk-g1-passivated', passivated_at = 8, updated_at = 8
				  WHERE session_id = ? AND generation = 0`,
				[session.sessionId],
			);
			await first.raw(
				"UPDATE agent_session_body_states SET state = 'passivated', updated_at = 8 WHERE session_id = ? AND generation = 0 AND role = 'worker'",
				[session.sessionId],
			);
			await first.createAgentSessionSchedule(session.sessionId, {
				requestId: "req-passivated-join",
				scheduleId: "schedule-passivated-join",
				definition: { kind: "interval", firstFireAt: 100, intervalMs: 10_000 },
				prompt: { text: "Continue resident work." },
				clientId: "host:passivated-join",
				now: 10,
			});

			const firstFire = await first.claimDueAgentSessionScheduleFire({
				consumer: "scheduler-passivated",
				leaseMs: 1_000_000,
				now: 100,
			});
			assert.ok(firstFire);
			assert.equal(firstFire.fire.target_generation, 1);
			assert.notEqual(firstFire.fire.activation_id, session.activationId);
			await assert.rejects(
				first.settleAgentSessionScheduleFire(firstFire.fire.fire_id, {
					consumer: firstFire.fire.consumer!,
					claimToken: firstFire.fire.claim_token!,
					now: 101,
					outcome: "terminal_failure",
					error: "nonretryable host activation failure",
				}),
				isScheduleFault("materialization_conflict"),
			);
			assert.equal((await first.listAgentSessionScheduleFires(session.sessionId)).length, 1);

			const secondFire = await second.claimDueAgentSessionScheduleFire({
				consumer: "scheduler-next-interval",
				leaseMs: 1_000_000,
				now: 10_100,
			});
			assert.ok(secondFire);
			assert.notEqual(secondFire.fire.fire_id, firstFire.fire.fire_id);
			assert.notEqual(secondFire.fire.command_id, firstFire.fire.command_id);
			assert.equal(secondFire.fire.target_generation, firstFire.fire.target_generation);
			assert.equal(secondFire.fire.activation_id, firstFire.fire.activation_id);
			assert.equal((await first.listAgentSessionScheduleFires(session.sessionId)).length, 2);
			assert.equal(
				(
					await first.raw("SELECT COUNT(*) AS count FROM agent_materializations WHERE session_id = ?", [
						session.sessionId,
					])
				).rows[0]?.count,
				2,
			);
		});
	});

	it("settles a nonretryable fire only after its exact materialization has durably converged", async () => {
		await withTwoStores(async (first, second) => {
			const session = await seedSession(first, "terminal-fire-failure", { allowSchedules: true });
			await first.createAgentSessionSchedule(session.sessionId, {
				requestId: "req-terminal-fire-failure",
				scheduleId: "schedule-terminal-fire-failure",
				definition: { kind: "once", fireAt: 100 },
				prompt: { text: "This activation will fail before binding." },
				clientId: "host:terminal-fire-failure",
				now: 10,
			});
			const claim = await first.claimDueAgentSessionScheduleFire({
				consumer: "scheduler-terminal-failure",
				leaseMs: 100,
				now: 100,
			});
			assert.ok(claim);
			await assert.rejects(
				first.settleAgentSessionScheduleFire(claim.fire.fire_id, {
					consumer: claim.fire.consumer!,
					claimToken: claim.fire.claim_token!,
					now: 101,
					outcome: "terminal_failure",
					error: "worker spawn failed",
				}),
				isScheduleFault("materialization_conflict"),
			);
			await first.bindAgentSandbox(session.sessionId, {
				generation: claim.fire.target_generation,
				activationId: claim.fire.activation_id,
				sandboxId: "sbx-g1-terminal-fire-failure",
				now: 102,
			});
			await first.finishAgentMaterialization(session.sessionId, claim.fire.target_generation, {
				activationId: claim.fire.activation_id,
				from: "running",
				to: "faulted",
				faultKind: "worker_exit",
				recoverable: false,
				now: 103,
			});
			const settled = await second.settleAgentSessionScheduleFire(claim.fire.fire_id, {
				consumer: claim.fire.consumer!,
				claimToken: claim.fire.claim_token!,
				now: 104,
				outcome: "terminal_failure",
				error: "worker exited after bind",
			});
			assert.equal(settled.state, "failed");
			assert.equal(settled.last_error, "worker exited after bind");
			assert.equal(
				(await first.readAgentMaterialization(session.sessionId, claim.fire.target_generation))?.state,
				"faulted",
			);
			assert.equal((await first.readAgentSession(session.sessionId))?.lifecycle_state, "faulted");
			assert.equal(
				await second.claimDueAgentSessionScheduleFire({
					consumer: "scheduler-after-terminal",
					leaseMs: 100,
					now: 105,
				}),
				null,
			);
			assert.equal((await first.listAgentSessionScheduleFires(session.sessionId)).length, 1);
		});
	});

	it("defers a quiescing target without starving another due Session", async () => {
		await withTwoStores(async (first, second) => {
			const blocked = await seedSession(first, "a-quiescing", {
				allowSchedules: true,
				materialize: true,
			});
			const ready = await seedSession(first, "b-ready", { allowSchedules: true });
			for (const [seeded, suffix] of [
				[blocked, "blocked"],
				[ready, "ready"],
			] as const) {
				await first.createAgentSessionSchedule(seeded.sessionId, {
					requestId: `req-${suffix}`,
					scheduleId: `schedule-${suffix}`,
					definition: { kind: "once", fireAt: 100 },
					prompt: { text: `Run ${suffix}.` },
					clientId: "host:quiescing-race",
					now: 10,
				});
			}
			await first.transitionAgentMaterialization(blocked.sessionId, 0, {
				activationId: blocked.activationId,
				from: "running",
				to: "quiescing",
				now: 50,
			});

			const claim = await second.claimDueAgentSessionScheduleFire({
				consumer: "scheduler-not-starved",
				leaseMs: 100,
				now: 100,
			});
			assert.ok(claim);
			assert.equal(claim.fire.session_id, ready.sessionId);
			assert.deepEqual(await first.listAgentSessionScheduleFires(blocked.sessionId), []);
			assert.deepEqual(await first.listAgentSessionCommands(blocked.sessionId), []);
			assert.equal(await first.readNextAgentSessionScheduleDueAt(100), 100);
		});
	});

	it("normalizes UTC cron with DOM and DOW AND semantics and coalesces missed interval occurrences", async () => {
		await withTwoStores(async (first) => {
			const session = await seedSession(first, "utc-coalescing", { allowSchedules: true });
			const now = Date.UTC(2026, 4, 1, 0, 0, 0, 0);
			const firstDomAndDow = Date.UTC(2026, 5, 1, 0, 0, 0, 0);
			const cron = await first.createAgentSessionSchedule(session.sessionId, {
				requestId: "req-cron-and",
				scheduleId: "schedule-cron-and",
				definition: { kind: "cron", expression: "0 0 1 * 1", timezone: "UTC" },
				prompt: { text: "Run only when the first day is Monday." },
				clientId: "host:utc-cron",
				now,
			});
			assert.equal(cron.schedule.next_fire_at, firstDomAndDow);
			const createdEvent = (await first.listAgentSessionEvents(session.sessionId)).find(
				(event) => event.type === "schedule.created",
			);
			assert.deepEqual((createdEvent?.payload as Record<string, unknown>).schedule, {
				kind: "cron",
				expression: "0 0 1 * 1",
				timeZone: "UTC",
			});

			const firstInterval = now + 10_000;
			await first.createAgentSessionSchedule(session.sessionId, {
				requestId: "req-interval-coalescing",
				scheduleId: "schedule-interval-coalescing",
				definition: { kind: "interval", firstFireAt: firstInterval, intervalMs: 10_000 },
				prompt: { text: "Coalesce missed interval ticks." },
				clientId: "host:interval-coalescing",
				now,
			});
			const claimedAt = now + 45_000;
			const fire = await first.claimDueAgentSessionScheduleFire({
				consumer: "scheduler-coalescing",
				leaseMs: 100,
				now: claimedAt,
			});
			assert.ok(fire);
			assert.equal(fire.fire.schedule_id, "schedule-interval-coalescing");
			assert.equal(fire.fire.scheduled_at, firstInterval);
			assert.equal(fire.fire.coalesced_count, 4);
			assert.equal(fire.fire.coalesced_through_at, now + 40_000);
			assert.equal(
				(await first.readAgentSessionSchedule(session.sessionId, fire.fire.schedule_id))?.next_fire_at,
				now + 50_000,
			);
		});
	});

	it("arbitrates cancellation against fire first-wins and auto-cancels a terminal Session with durable host testimony", async () => {
		await withTwoStores(async (first, second) => {
			const raced = await seedSession(first, "cancel-fire-race", { allowSchedules: true });
			await first.createAgentSessionSchedule(raced.sessionId, {
				requestId: "req-race-create",
				scheduleId: "schedule-race",
				definition: { kind: "once", fireAt: 100 },
				prompt: { text: "Race cancellation." },
				clientId: "host:race",
				now: 10,
			});
			const [cancelResult, fireResult] = await Promise.all([
				first.cancelAgentSessionSchedule(raced.sessionId, "schedule-race", {
					requestId: "req-race-cancel",
					clientId: "host:race",
					reason: "operator supplied free-text reason",
					now: 100,
				}),
				second.claimDueAgentSessionScheduleFire({ consumer: "scheduler-race", leaseMs: 100, now: 100 }),
			]);
			assert.equal(cancelResult.cancellation.reason, "operator supplied free-text reason");
			assert.equal(cancelResult.cancellation.disposition === "cancelled", fireResult === null);
			assert.equal(cancelResult.cancellation.disposition === "fire_preceded", fireResult !== null);
			const terminalEvents = (await first.listAgentSessionEvents(raced.sessionId)).filter(
				(event) => event.type === "schedule.cancelled" || event.type === "schedule.fired",
			);
			assert.equal(terminalEvents.length, 1);
			if (terminalEvents[0]?.type === "schedule.cancelled") {
				assert.equal(terminalEvents[0].causation_id, "req-race-cancel");
				assert.deepEqual(terminalEvents[0].payload, {
					schema: "choreograph.agent-session-schedule-cancelled.v1",
					scheduleId: "schedule-race",
					requestId: "req-race-cancel",
					reason: "requested",
				});
			}

			const terminal = await seedSession(first, "terminal-auto-cancel", { allowSchedules: true });
			await first.createAgentSessionSchedule(terminal.sessionId, {
				requestId: "req-terminal-create",
				scheduleId: "schedule-terminal",
				definition: { kind: "once", fireAt: 1_000 },
				prompt: { text: "This must never fire after closure." },
				clientId: "host:terminal",
				now: 101,
			});
			await first.raw(
				"UPDATE agent_sessions SET lifecycle_state = 'closed', lifecycle_terminal_digest = 'terminal-g1', updated_at = 120 WHERE session_id = ?",
				[terminal.sessionId],
			);
			assert.equal(await first.readNextAgentSessionScheduleDueAt(120), 120);
			assert.equal(
				await second.claimDueAgentSessionScheduleFire({ consumer: "scheduler-recovery", leaseMs: 100, now: 120 }),
				null,
			);
			const schedule = await first.readAgentSessionSchedule(terminal.sessionId, "schedule-terminal");
			assert.equal(schedule?.state, "cancelled");
			assert.equal(schedule?.cancel_reason, "session_closed");
			const autoEvent = (await first.listAgentSessionEvents(terminal.sessionId)).find(
				(event) => event.type === "schedule.cancelled",
			);
			assert.ok(autoEvent?.causation_id);
			assert.equal(autoEvent.command_id, null);
			assert.deepEqual(autoEvent.payload, {
				schema: "choreograph.agent-session-schedule-cancelled.v1",
				scheduleId: "schedule-terminal",
				requestId: autoEvent.causation_id,
				reason: "session_closed",
			});
			const cancellation = await first.raw(
				"SELECT * FROM agent_session_schedule_cancellations WHERE session_id = ? AND schedule_id = ?",
				[terminal.sessionId, "schedule-terminal"],
			);
			assert.equal(cancellation.rows.length, 1);
			assert.equal(cancellation.rows[0]?.request_id, autoEvent.causation_id);
			assert.equal(cancellation.rows[0]?.reason, "session_closed");
		});
	});
});

class InspectableWorkflowRuntimeStore extends WorkflowRuntimeStore {
	raw(sql: string, args: unknown[] = []) {
		return this.db.execute({ sql, args });
	}
}

async function seedSession(
	store: WorkflowRuntimeStore,
	suffix: string,
	options: {
		readonly kind?: "simple" | "prime";
		readonly allowSchedules?: boolean;
		readonly materialize?: boolean;
		readonly node?: Partial<
			Pick<
				AgentNodeSpec,
				| "systemPrompt"
				| "graphAccess"
				| "toolMode"
				| "excludeTools"
				| "includeTools"
				| "strictToolManifest"
				| "schema"
				| "maxTurns"
				| "agentType"
				| "poolMode"
				| "capabilities"
				| "initialGoal"
			>
		>;
	} = {},
): Promise<{ readonly sessionId: string; readonly activationId: string }> {
	const kind = options.kind ?? "prime";
	const graphId = "g1-scheduler-proof";
	const sessionId = `ags-g1-${suffix}`;
	const runId = `wfr-g1-${suffix}`;
	const workflowName = `g1-store-${suffix}`;
	const semantic = makeTestAgentSemanticBinding({ graphId, kind, registeredName: `g1-${suffix}` });
	const runtime = {
		...semantic.runtime,
		constraints: {
			...semantic.runtime.constraints,
			allowSchedules: options.allowSchedules ?? false,
		},
	};
	const spec: AgentNodeSpec = {
		label: "scheduled-prime",
		phaseIndex: 1,
		prompt: "Await durable scheduled input.",
		model: "mock:done",
		provider: "openrouter",
		graphId,
		sessionId,
		...options.node,
		agentId: semantic.agentId,
		runtime,
		runtimeBindingDigest: digestAgentRuntimeBinding(runtime),
		ontology: semantic.ontology,
		ontologyBindingDigest: semantic.ontologyBindingDigest,
	};
	await store.createWorkflowInstance({
		runId,
		workflowName,
		graphId,
		ownerUserId: "user-g1",
		inputs: {},
		startedAt: 1,
	});
	await store.beginAgentSession({
		sessionId,
		runId,
		workflowName,
		graphId,
		ownerUserId: "user-g1",
		graphOwnerPrincipal: "user:g1",
		spec,
		nodeKey: "1:scheduled-prime",
		frontier: { kind: "before-node", sessionId, phaseIndex: 1, ts: 1 },
		now: 1,
	});
	const activationId = `act-g1-${suffix}`;
	if (options.materialize) {
		await store.claimAgentMaterialization(sessionId, { generation: 0, activationId, now: 2 });
		await store.bindAgentSandbox(sessionId, {
			generation: 0,
			activationId,
			sandboxId: `sbx-g1-${suffix}`,
			now: 3,
		});
	}
	return { sessionId, activationId };
}

function isScheduleFault(reason: AgentSessionScheduleFault["reason"]): (error: unknown) => boolean {
	return (error: unknown) => error instanceof AgentSessionScheduleFault && error.reason === reason;
}

async function withTwoStores(
	run: (first: InspectableWorkflowRuntimeStore, second: InspectableWorkflowRuntimeStore) => Promise<void>,
): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "agent-g1-store-"));
	const path = join(directory, "runtime.sqlite");
	const first = new InspectableWorkflowRuntimeStore(path);
	const second = new InspectableWorkflowRuntimeStore(path);
	try {
		await first.init();
		await second.init();
		await run(first, second);
	} finally {
		first.close();
		second.close();
		rmSync(directory, { recursive: true, force: true });
	}
}
