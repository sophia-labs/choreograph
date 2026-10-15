import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	AGENT_SESSION_SCHEDULE_CONTROL_SCHEMA,
	type AgentSessionScheduleControlRequestV1,
} from "../agent-runtime/agent-session-schedule-control.js";
import { digestAgentRuntimeBinding } from "../agent-runtime/profile.js";
import { grantDigest } from "../workflow/agent-tool-grant.js";
import { type AgentNodeSpec, AgentSessionScheduleFault, WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

describe("Arc G2 durable schedule controls", () => {
	it("widens a legacy materialization schema for authority tombstones", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-g2-migration-"));
		const path = join(directory, "runtime.sqlite");
		const first = new InspectableWorkflowRuntimeStore(path);
		try {
			await first.init();
			const schema = await first.raw(
				"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_materializations'",
			);
			const current = String(schema.rows[0]?.sql);
			const legacy = current.replace(", 'authority_revoked'))", "))");
			assert.notEqual(legacy, current);
			await first.raw("PRAGMA writable_schema = ON");
			await first.raw("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'agent_materializations'", [
				legacy,
			]);
			await first.raw("PRAGMA writable_schema = OFF");
			first.close();
			const reopened = new InspectableWorkflowRuntimeStore(path);
			try {
				await reopened.init();
				const widened = await reopened.raw(
					"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_materializations'",
				);
				assert.match(String(widened.rows[0]?.sql), /authority_revoked/);
			} finally {
				reopened.close();
			}
		} finally {
			try {
				first.close();
			} catch {}
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("replays controls exactly and applies update/CAS across two stores", async () => {
		await withTwoStores(async (first, second) => {
			const session = await seedSession(first, "controls");
			const created = await first.createAgentSessionSchedule(session.sessionId, {
				requestId: "create-controls",
				scheduleId: "schedule-controls",
				definition: { kind: "once", fireAt: 1_000 },
				prompt: { text: "old" },
				clientId: "owner:test",
				now: 100,
				options: {
					source: "rlm_heartbeat",
					label: "queue",
					deliveryMode: "follow_up",
				},
			});
			assert.equal(created.schedule.revision, 0);
			assert.equal(created.schedule.delivery_mode, "follow_up");
			const request: AgentSessionScheduleControlRequestV1 & { clientId: string; now: number } = {
				schema: AGENT_SESSION_SCHEDULE_CONTROL_SCHEMA,
				requestId: "control-update",
				scheduleId: "schedule-controls",
				expectedRevision: 0,
				action: { kind: "update", input: { text: "new" }, label: "renamed", deliveryMode: "steer" },
				clientId: "owner:test",
				now: 200,
			};
			const applied = await second.controlAgentSessionSchedule(session.sessionId, request);
			assert.equal(applied.applied, true);
			assert.equal(applied.receipt.resultingRevision, 1);
			assert.equal(applied.schedule.prompt.text, "new");
			assert.equal(applied.schedule.label, "renamed");
			const replay = await first.controlAgentSessionSchedule(session.sessionId, request);
			assert.deepEqual(replay.receipt, applied.receipt);
			assert.deepEqual(replay.schedule, applied.schedule);
			const updatedEvents = (await first.listAgentSessionEvents(session.sessionId)).filter(
				(event) => event.type === "schedule.updated",
			);
			assert.equal(updatedEvents.length, 1, "replaying a control must not append another public update receipt");
			const updatedEvent = updatedEvents[0];
			assert.ok(updatedEvent);
			const { seq: _seq, ...publicUpdateEvent } = updatedEvent;
			assert.deepEqual(publicUpdateEvent, {
				session_id: session.sessionId,
				ts: 200,
				type: "schedule.updated",
				causation_id: "control-update",
				command_id: null,
				payload: {
					schema: "choreograph.agent-session-schedule-updated.v1",
					scheduleId: "schedule-controls",
					requestId: "control-update",
					priorRevision: 0,
					resultingRevision: 1,
					action: { kind: "update", input: { text: "new" }, label: "renamed", deliveryMode: "steer" },
					priorState: "active",
					resultingState: "active",
					nextFireAt: "1970-01-01T00:00:01.000Z",
				},
			});
			await assert.rejects(
				first.controlAgentSessionSchedule(session.sessionId, {
					...request,
					action: { kind: "update", input: { text: "tampered" } },
					now: 201,
				}),
				isFault("request_conflict"),
			);
			await assert.rejects(
				first.controlAgentSessionSchedule(session.sessionId, {
					...request,
					requestId: "control-stale",
					expectedRevision: 0,
					action: { kind: "pause" },
					now: 202,
				}),
				isFault("request_conflict"),
			);
		});
	});

	it("arbitrates pause versus due fire, resumes without paused debt, and cancels paused schedules", async () => {
		await withTwoStores(async (first, second) => {
			const session = await seedSession(first, "pause-race");
			await first.createAgentSessionSchedule(session.sessionId, {
				requestId: "create-pause-race",
				scheduleId: "schedule-pause-race",
				definition: { kind: "interval", firstFireAt: 1_000, intervalMs: 10_000 },
				prompt: { text: "race" },
				clientId: "owner:test",
				now: 100,
			});
			const pauseRequest = {
				schema: AGENT_SESSION_SCHEDULE_CONTROL_SCHEMA,
				requestId: "pause-race",
				scheduleId: "schedule-pause-race",
				action: { kind: "pause" as const },
				clientId: "owner:test",
				now: 1_000,
			};
			const [, fire] = await Promise.all([
				second.controlAgentSessionSchedule(session.sessionId, pauseRequest),
				first.claimDueAgentSessionScheduleFire({ consumer: "scheduler", leaseMs: 1_000, now: 1_000 }),
			]);
			const observed = await first.readAgentSessionSchedule(session.sessionId, "schedule-pause-race");
			assert.ok(observed);
			if (fire) {
				assert.equal(fire.fire.ordinal, 0);
				assert.equal(observed.state, "active");
			} else {
				assert.equal(observed.state, "paused");
				assert.equal(observed.next_fire_at, null);
				const resumed = await first.controlAgentSessionSchedule(session.sessionId, {
					schema: AGENT_SESSION_SCHEDULE_CONTROL_SCHEMA,
					requestId: "resume-race",
					scheduleId: "schedule-pause-race",
					action: { kind: "resume" },
					clientId: "owner:test",
					now: 20_000,
				});
				assert.equal(resumed.schedule.state, "active");
				assert.ok((resumed.schedule.next_fire_at ?? 0) > 20_000);
				const cancelled = await second.cancelAgentSessionSchedule(session.sessionId, "schedule-pause-race", {
					requestId: "cancel-after-resume",
					clientId: "owner:test",
					now: 20_001,
				});
				assert.equal(cancelled.schedule.state, "cancelled");
			}
		});
	});

	it("keeps G1 creation and fire behavior compatible while exposing G2 defaults", async () => {
		await withTwoStores(async (first) => {
			const session = await seedSession(first, "compatibility");
			const created = await first.createAgentSessionSchedule(session.sessionId, {
				requestId: "create-g1-compatible",
				scheduleId: "schedule-g1-compatible",
				definition: { kind: "once", fireAt: 1_000 },
				prompt: { text: "G1 text-only" },
				clientId: "owner:test",
				now: 100,
			});
			assert.equal(created.schedule.revision, 0);
			assert.equal(created.schedule.source, "internal");
			assert.equal(created.schedule.label, null);
			assert.equal(created.schedule.delivery_mode, "steer");
			assert.equal(created.schedule.grant_snapshot_digest, null);
			const claim = await first.claimDueAgentSessionScheduleFire({
				consumer: "scheduler",
				leaseMs: 1_000,
				now: 1_000,
			});
			assert.ok(claim);
			assert.equal(claim.command.payload.text, "G1 text-only");
			assert.equal(
				(await first.readAgentSessionSchedule(session.sessionId, created.schedule.schedule_id))?.state,
				"completed",
			);
		});
	});

	it("freezes requested and actual delivery: live modes stay exact while a composted wake is prompt", async () => {
		await withTwoStores(async (store) => {
			const live = await seedSession(store, "live-delivery");
			await store.claimAgentMaterialization(live.sessionId, {
				generation: 0,
				activationId: "live-delivery-0",
				now: 10,
			});
			await store.bindAgentSandbox(live.sessionId, {
				sandboxId: "sandbox-live-delivery",
				generation: 0,
				activationId: "live-delivery-0",
				now: 11,
			});
			for (const [index, deliveryMode] of (["steer", "follow_up"] as const).entries()) {
				await store.createAgentSessionSchedule(live.sessionId, {
					requestId: `create-${deliveryMode}`,
					scheduleId: `schedule-${deliveryMode}`,
					definition: { kind: "once", fireAt: 1_000 },
					prompt: { text: `${deliveryMode} input` },
					clientId: "owner:test",
					now: 100 + index * 1_000,
					options: { deliveryMode },
				});
				const claim = await store.claimDueAgentSessionScheduleFire({
					consumer: `scheduler-${deliveryMode}`,
					// Keep the first exact-delivery fire leased while the second is
					// claimed; this proves the scheduler does not relabel old work.
					leaseMs: 100_000,
					now: 1_000 + index * 1_000,
				});
				assert.ok(claim);
				assert.equal(claim.fire.requested_delivery_mode, deliveryMode);
				assert.equal(claim.fire.command_name, deliveryMode);
				assert.equal(claim.command.name, deliveryMode);
			}

			const composted = await seedSession(store, "composted-delivery");
			await store.createAgentSessionSchedule(composted.sessionId, {
				requestId: "create-composted",
				scheduleId: "schedule-composted",
				definition: { kind: "once", fireAt: 3_000 },
				prompt: { text: "prompt after compost" },
				clientId: "owner:test",
				now: 2_001,
				options: { deliveryMode: "follow_up" },
			});
			const claim = await store.claimDueAgentSessionScheduleFire({
				consumer: "scheduler-composted",
				leaseMs: 1_000,
				now: 3_000,
			});
			assert.ok(claim);
			assert.equal(claim.fire.requested_delivery_mode, "follow_up");
			assert.equal(claim.fire.command_name, "prompt");
			assert.equal(claim.command.name, "prompt");
			assert.equal(claim.fire.target_generation, 0);
		});
	});

	it("round-trips a Phanes Discord materialized grant through Session admission and pins external schedules", async () => {
		await withTwoStores(async (store) => {
			const session = await seedSession(store, "domain-binding", { domainHost: true });
			const row = await store.raw("SELECT digest FROM agent_session_schedule_grant_bindings WHERE session_id = ?", [
				session.sessionId,
			]);
			assert.equal(row.rows.length, 1, JSON.stringify(row.rows));
			const binding = await store.readAgentSessionScheduleGrantBinding(
				session.sessionId,
				String(row.rows[0]?.digest),
			);
			assert.ok(binding);
			assert.equal(binding.binding.snapshot.graphId, "g2-scheduler-proof");
			assert.equal(binding.binding.snapshot.grantAuthorityGraphId, "grant-authority-graph");
			assert.equal(binding.binding.snapshot.capturedAt, 50);
			assert.deepEqual(binding.binding.snapshot.grant.capabilities[0]?.fence, {
				graphIds: ["g2-scheduler-proof"],
				requiredScopeSchema: "sophia.discord-capability-scope.v2",
				requiredDatasetObjectKind: "dataset-epoch",
			});
			const created = await store.createAgentSessionSchedule(session.sessionId, {
				requestId: "create-bound",
				scheduleId: "schedule-bound",
				definition: { kind: "interval", firstFireAt: 1_000, intervalMs: 10_000 },
				prompt: { text: "use exact bound tools" },
				clientId: "owner:test",
				now: 100,
			});
			assert.equal(created.schedule.grant_snapshot_digest, binding.digest);
		});
	});

	it("tombstones an unembodied authority-revoked fire once while preserving the Session", async () => {
		await withTwoStores(async (store) => {
			const session = await seedSession(store, "authority-tombstone", { domainHost: true });
			await store.createAgentSessionSchedule(session.sessionId, {
				requestId: "create-authority-tombstone",
				scheduleId: "authority-tombstone",
				definition: { kind: "interval", firstFireAt: 1_000, intervalMs: 10_000 },
				prompt: { text: "must not spawn" },
				clientId: "owner:test",
				now: 100,
			});
			const claim = await store.claimDueAgentSessionScheduleFire({
				consumer: "scheduler",
				leaseMs: 1_000,
				now: 1_000,
			});
			assert.ok(claim);
			await assert.rejects(
				store.settleAgentSessionScheduleFire(claim.fire.fire_id, {
					consumer: "scheduler",
					claimToken: claim.fire.claim_token!,
					outcome: "terminal_failure",
					error: "ordinary failure must not rewrite an unembodied Session",
					now: 1_001,
				}),
				isFault("materialization_conflict"),
			);
			await store.rejectAgentSessionScheduleFireAuthority({
				fireId: claim.fire.fire_id,
				consumer: "scheduler",
				claimToken: claim.fire.claim_token!,
				outcome: "rejected",
				code: "schedule_grant_current_mismatch",
				now: 1_002,
			});
			const fire = (await store.listAgentSessionScheduleFires(session.sessionId))[0];
			assert.equal(fire?.state, "failed");
			assert.equal(fire?.last_error, "schedule_grant_current_mismatch");
			const materialization = await store.readAgentMaterialization(session.sessionId, claim.fire.target_generation);
			assert.equal(materialization?.state, "authority_revoked");
			assert.equal((await store.readAgentSession(session.sessionId))?.lifecycle_state, "open");
			assert.equal((await store.readAgentSessionCommand(claim.command.command_id))?.state, "cancelled");
			const family = await store.readAgentSessionFamilyProjection(session.sessionId);
			assert.equal(
				family?.root.materializationState,
				null,
				"no-body tombstone is intentionally not a body projection",
			);
			assert.equal(family?.root.workerState, null);
			assert.equal(family?.root.kernelState, null);
			const regrown = await store.claimAgentMaterialization(session.sessionId, {
				generation: claim.fire.target_generation + 1,
				activationId: "authority-regrow-n-plus-one",
				now: 1_003,
			});
			assert.equal(regrown.generation, claim.fire.target_generation + 1);
			assert.equal(regrown.state, "claimed");
			assert.equal(regrown.checkpoint_id, null);
			assert.equal(regrown.kernel_checkpoint_id, null);
			assert.equal(
				(await store.readAgentSessionSchedule(session.sessionId, "authority-tombstone"))?.cancel_reason,
				"authority_revoked",
			);
			assert.deepEqual(await store.listAgentSessionScheduleFireAuthorityAttempts(claim.fire.fire_id), [
				{
					fire_id: claim.fire.fire_id,
					attempt: 1,
					outcome: "rejected",
					grant_digest: null,
					revision: null,
					code: "schedule_grant_current_mismatch",
					checked_at: 1_002,
				},
			]);
			await assert.rejects(store.raw("UPDATE agent_session_schedule_fire_authority_attempts SET code = 'tampered'"));
		});
	});

	it("records unavailable then reclaimed accepted authority attempts under distinct leases", async () => {
		await withTwoStores(async (store) => {
			const session = await seedSession(store, "authority-reclaim", { domainHost: true });
			await store.createAgentSessionSchedule(session.sessionId, {
				requestId: "create-authority-reclaim",
				scheduleId: "authority-reclaim",
				definition: { kind: "once", fireAt: 1_000 },
				prompt: { text: "retry" },
				clientId: "owner:test",
				now: 100,
			});
			const first = await store.claimDueAgentSessionScheduleFire({
				consumer: "scheduler-a",
				leaseMs: 10,
				now: 1_000,
			});
			assert.ok(first);
			await store.recordAgentSessionScheduleFireAuthorityUnavailable({
				fireId: first.fire.fire_id,
				consumer: "scheduler-a",
				claimToken: first.fire.claim_token!,
				code: "schedule_grant_current_unavailable",
				now: 1_001,
			});
			const second = await store.claimDueAgentSessionScheduleFire({
				consumer: "scheduler-b",
				leaseMs: 10,
				now: 1_010,
			});
			assert.ok(second);
			await store.recordAgentSessionScheduleFireAuthorityAccepted({
				fireId: second.fire.fire_id,
				consumer: "scheduler-b",
				claimToken: second.fire.claim_token!,
				grantDigest: "a".repeat(64),
				revision: 2,
				now: 1_011,
			});
			assert.deepEqual(
				(await store.listAgentSessionScheduleFireAuthorityAttempts(first.fire.fire_id)).map((item) => [
					item.attempt,
					item.outcome,
					item.revision,
				]),
				[
					[1, "unavailable", null],
					[2, "accepted", "2"],
				],
			);
		});
	});

	it("reject authority rolls back when the exact command was already delivered", async () => {
		await withTwoStores(async (store) => {
			const session = await seedSession(store, "authority-delivered", { domainHost: true });
			await store.createAgentSessionSchedule(session.sessionId, {
				requestId: "create-delivered",
				scheduleId: "delivered",
				definition: { kind: "once", fireAt: 1_000 },
				prompt: { text: "race" },
				clientId: "owner:test",
				now: 100,
			});
			const claim = await store.claimDueAgentSessionScheduleFire({
				consumer: "scheduler",
				leaseMs: 1_000,
				now: 1_000,
			});
			assert.ok(claim);
			await store.claimExactAgentSessionCommandForDelivery(
				session.sessionId,
				claim.fire.target_generation,
				claim.command.command_id,
				1_001,
			);
			await assert.rejects(
				store.rejectAgentSessionScheduleFireAuthority({
					fireId: claim.fire.fire_id,
					consumer: "scheduler",
					claimToken: claim.fire.claim_token!,
					outcome: "rejected",
					code: "schedule_grant_current_mismatch",
					now: 1_002,
				}),
				isFault("lease_lost"),
			);
			assert.deepEqual(await store.listAgentSessionScheduleFireAuthorityAttempts(claim.fire.fire_id), []);
			assert.equal(
				(await store.readAgentMaterialization(session.sessionId, claim.fire.target_generation))?.state,
				"claimed",
			);
		});
	});

	it("running authority rejection leaves the resident materialization, body, kernel, and occupancy testimony byte-identical", async () => {
		await withTwoStores(async (store) => {
			const session = await seedSession(store, "authority-running", { domainHost: true });
			await store.createAgentSessionSchedule(session.sessionId, {
				requestId: "create-running",
				scheduleId: "running",
				definition: { kind: "once", fireAt: 1_000 },
				prompt: { text: "resident" },
				clientId: "owner:test",
				now: 100,
			});
			const claim = await store.claimDueAgentSessionScheduleFire({
				consumer: "scheduler",
				leaseMs: 1_000,
				now: 1_000,
			});
			assert.ok(claim);
			await store.bindAgentSandbox(session.sessionId, {
				sandboxId: "resident-authority-running",
				generation: claim.fire.target_generation,
				activationId: claim.fire.activation_id,
				now: 1_001,
			});
			const before = await store.raw(
				"SELECT state, sandbox_id, activation_id, checkpoint_id, kernel_checkpoint_id FROM agent_materializations WHERE session_id = ? AND generation = ?",
				[session.sessionId, claim.fire.target_generation],
			);
			const bodies = await store.raw(
				"SELECT role, state FROM agent_session_body_states WHERE session_id = ? AND generation = ?",
				[session.sessionId, claim.fire.target_generation],
			);
			const kernel = await store.raw(
				"SELECT state, sandbox_id FROM agent_session_kernel_launches WHERE session_id = ? AND generation = ?",
				[session.sessionId, claim.fire.target_generation],
			);
			// Root Sessions have no child-generation allocation, but preserve the
			// exact occupancy relation as well: a live-target rejection must not
			// acquire, release, or otherwise mutate capacity testimony.
			const occupancy = await store.raw(
				"SELECT parent_session_id, child_session_id, generation, state, acquired_at, released_at FROM agent_session_child_generation_occupancy WHERE child_session_id = ? ORDER BY generation",
				[session.sessionId],
			);
			await store.rejectAgentSessionScheduleFireAuthority({
				fireId: claim.fire.fire_id,
				consumer: "scheduler",
				claimToken: claim.fire.claim_token!,
				outcome: "rejected",
				code: "schedule_grant_current_mismatch",
				now: 1_002,
			});
			assert.deepEqual(
				await store.raw(
					"SELECT state, sandbox_id, activation_id, checkpoint_id, kernel_checkpoint_id FROM agent_materializations WHERE session_id = ? AND generation = ?",
					[session.sessionId, claim.fire.target_generation],
				),
				before,
			);
			assert.deepEqual(
				await store.raw(
					"SELECT role, state FROM agent_session_body_states WHERE session_id = ? AND generation = ?",
					[session.sessionId, claim.fire.target_generation],
				),
				bodies,
			);
			assert.deepEqual(
				await store.raw(
					"SELECT state, sandbox_id FROM agent_session_kernel_launches WHERE session_id = ? AND generation = ?",
					[session.sessionId, claim.fire.target_generation],
				),
				kernel,
			);
			assert.deepEqual(
				await store.raw(
					"SELECT parent_session_id, child_session_id, generation, state, acquired_at, released_at FROM agent_session_child_generation_occupancy WHERE child_session_id = ? ORDER BY generation",
					[session.sessionId],
				),
				occupancy,
			);
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
	options: { domainHost?: boolean } = {},
): Promise<{ sessionId: string }> {
	const graphId = "g2-scheduler-proof";
	const sessionId = `ags-g2-${suffix}`;
	const runId = `wfr-g2-${suffix}`;
	const semantic = makeTestAgentSemanticBinding({ graphId, kind: "prime", registeredName: `g2-${suffix}` });
	const runtime = { ...semantic.runtime, constraints: { ...semantic.runtime.constraints, allowSchedules: true } };
	const spec: AgentNodeSpec = {
		label: "scheduled-prime",
		phaseIndex: 1,
		prompt: "Await durable scheduled input.",
		model: "mock:done",
		provider: "openrouter",
		graphId,
		sessionId,
		agentId: semantic.agentId,
		runtime,
		runtimeBindingDigest: digestAgentRuntimeBinding(runtime),
		ontology: semantic.ontology,
		ontologyBindingDigest: semantic.ontologyBindingDigest,
		...(options.domainHost ? { includeTools: ["recall"], toolMode: "dynamic" as const } : {}),
	};
	await store.createWorkflowInstance({
		runId,
		workflowName: `g2-store-${suffix}`,
		graphId,
		ownerUserId: "user:g2",
		inputs: options.domainHost ? { hostContext: domainHostContext(semantic.agentId) } : {},
		startedAt: 1,
	});
	if (options.domainHost) {
		const persisted = await (store as InspectableWorkflowRuntimeStore).raw(
			"SELECT inputs_json FROM workflow_instances WHERE run_id = ?",
			[runId],
		);
		assert.equal(JSON.parse(String(persisted.rows[0]?.inputs_json)).hostContext.agentId, semantic.agentId);
	}
	await store.beginAgentSession({
		sessionId,
		runId,
		workflowName: `g2-store-${suffix}`,
		graphId,
		ownerUserId: "user:g2",
		graphOwnerPrincipal: "user:g2",
		spec,
		nodeKey: "1:scheduled-prime",
		frontier: { kind: "before-node", sessionId, phaseIndex: 1, ts: 1 },
		now: 1,
	});
	return { sessionId };
}

function domainHostContext(agentId: string) {
	const grant = {
		schema: "sophia.agent-toolbelt-grant.v1" as const,
		grantId: "grant-domain-binding",
		subjectAgentId: agentId,
		issuedBy: "user:grant-authority",
		authorityGraphId: "grant-authority-graph",
		issuedAt: 1,
		status: "active" as const,
		capabilities: [
			{
				capability: "mnemosyne",
				operations: ["recall"],
				access: "read" as const,
				approvalPolicy: "ordinary" as const,
				fence: {
					graphIds: ["g2-scheduler-proof"],
					requiredScopeSchema: "sophia.discord-capability-scope.v2",
					requiredDatasetObjectKind: "dataset-epoch",
				},
				quota: { maxPerWave: 1 },
			},
		],
		sourceRefs: ["urn:grant:domain-binding"],
	};
	return {
		schema: "sophia.domain-agent-host-context.v1",
		agentId,
		grant,
		grantDocumentId: "grant-domain-binding",
		grantAuthorityOwnerPrincipal: "user:grant-authority",
		toolbelt: {
			schema: "sophia.granted-toolbelt.v1",
			grantId: grant.grantId,
			grantDigest: grantDigest(grant),
			manifestId: "manifest-domain-binding",
			manifestHash: "a".repeat(64),
			agentId,
			tools: [],
			capabilities: grant.capabilities,
			suppressions: [],
			failures: [],
			resolvedAt: 50,
		},
	};
}

function isFault(reason: AgentSessionScheduleFault["reason"]): (error: unknown) => boolean {
	return (error: unknown) => error instanceof AgentSessionScheduleFault && error.reason === reason;
}

async function withTwoStores(
	run: (first: InspectableWorkflowRuntimeStore, second: InspectableWorkflowRuntimeStore) => Promise<void>,
): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "agent-g2-store-"));
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
