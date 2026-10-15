import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SandboxSpawner } from "../spawner.js";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

describe("durable passivated Agent Session command activation", () => {
	it("claims one exact N+1 wake across stores and settles only after command completion", async () => {
		await withTwoStores(async (first, second) => {
			const sessionId = await seedResidentPrime(first, "single-owner");
			const submitted = await first.submitAgentSessionCommand(sessionId, {
				commandId: "command-single-owner",
				idempotencyKey: "command-single-owner",
				name: "follow_up",
				payload: { text: "Continue after composting." },
				clientId: "vehicle-single-owner",
				now: 10,
			});
			assert.equal(submitted?.record.target_generation, 1);

			const claims = await Promise.all([
				first.claimAgentSessionCommandActivation({ consumer: "host-a", leaseMs: 1_000, now: 11 }),
				second.claimAgentSessionCommandActivation({ consumer: "host-b", leaseMs: 1_000, now: 11 }),
			]);
			const claimed = claims.find((claim) => claim !== null);
			assert.ok(claimed);
			assert.equal(claims.filter(Boolean).length, 1);
			assert.equal(claimed.command.command_id, "command-single-owner");
			assert.equal(claimed.activation.target_generation, 1);
			assert.equal(claimed.activation.attempt, 1);
			assert.equal(claimed.activation.state, "claimed");
			const materialization = await first.readAgentMaterialization(sessionId, 1);
			assert.equal(materialization?.state, "claimed");
			assert.equal(materialization?.activation_id, claimed.activation.activation_id);

			await assert.rejects(
				first.settleAgentSessionCommandActivation(claimed.command.command_id, {
					consumer: claimed.activation.consumer!,
					claimToken: claimed.activation.claim_token!,
					now: 12,
					outcome: "completed",
				}),
				/materialization|durable result/i,
			);
			await first.bindAgentSandbox(sessionId, {
				generation: 1,
				activationId: claimed.activation.activation_id,
				sandboxId: "sandbox-command-single-owner",
				now: 13,
			});
			const delivered = await first.claimExactAgentSessionCommandForDelivery(
				sessionId,
				1,
				claimed.command.command_id,
				14,
			);
			assert.equal(delivered?.name, "follow_up");
			await first.completeAgentSessionCommand(claimed.command.command_id, 1, {
				status: "completed",
				result: { output: "continued" },
				now: 15,
			});
			const settled = await first.settleAgentSessionCommandActivation(claimed.command.command_id, {
				consumer: claimed.activation.consumer!,
				claimToken: claimed.activation.claim_token!,
				now: 16,
				outcome: "completed",
			});
			assert.equal(settled.state, "completed");
			assert.equal(
				await second.claimAgentSessionCommandActivation({ consumer: "host-c", leaseMs: 1_000, now: 17 }),
				null,
			);
		});
	});

	it("cancels an unbound wake atomically and admits a later command at the same next generation", async () => {
		await withTwoStores(async (first, second) => {
			const sessionId = await seedResidentPrime(first, "cancel-before-bind");
			await first.submitAgentSessionCommand(sessionId, {
				commandId: "command-cancel-before-bind",
				idempotencyKey: "command-cancel-before-bind",
				name: "steer",
				payload: { text: "Wake, unless I cancel." },
				clientId: "vehicle-cancel",
				now: 10,
			});
			const claim = await first.claimAgentSessionCommandActivation({
				consumer: "host-cancel",
				leaseMs: 1_000,
				now: 11,
			});
			assert.ok(claim);
			const cancelled = await second.cancelAgentSessionCommand(sessionId, claim.command.command_id, {
				clientId: "vehicle-cancel",
				now: 12,
			});
			assert.equal(cancelled?.record.state, "cancelled");
			assert.equal((await first.readAgentSessionCommandActivation(claim.command.command_id))?.state, "failed");
			assert.equal(await first.readAgentMaterialization(sessionId, 1), null);

			await first.submitAgentSessionCommand(sessionId, {
				commandId: "command-after-cancel",
				idempotencyKey: "command-after-cancel",
				name: "follow_up",
				payload: { text: "Wake after the prior request was cancelled." },
				clientId: "vehicle-cancel",
				now: 13,
			});
			const replacement = await second.claimAgentSessionCommandActivation({
				consumer: "host-replacement",
				leaseMs: 1_000,
				now: 14,
			});
			assert.ok(replacement);
			assert.equal(replacement.activation.target_generation, 1);
			assert.notEqual(replacement.activation.activation_id, claim.activation.activation_id);
		});
	});

	it("lets Session cancellation atomically fence an unbound wake and close from the prior passivated body", async () => {
		await withTwoStores(async (first, second) => {
			const sessionId = await seedResidentPrime(first, "session-cancel-unbound");
			await first.submitAgentSessionCommand(sessionId, {
				commandId: "command-session-cancel-unbound",
				idempotencyKey: "command-session-cancel-unbound",
				name: "follow_up",
				payload: { text: "This wake must lose to Session cancellation." },
				clientId: "vehicle-session-cancel",
				now: 10,
			});
			const claim = await first.claimAgentSessionCommandActivation({
				consumer: "host-session-cancel",
				leaseMs: 1_000,
				now: 11,
			});
			assert.ok(claim);

			const cancelled = await second.requestAgentSessionCancellation(sessionId, {
				requestId: "cancel-session-with-unbound-wake",
				actor: { kind: "owner_api", ownerUserId: "user-command-activation" },
				reason: "owner cancelled before the next body existed",
				now: 12,
			});
			assert.equal(cancelled.cascade.state, "completed");
			assert.equal((await first.readAgentSession(sessionId))?.lifecycle_state, "closed");
			assert.equal((await first.readAgentSession(sessionId))?.status, "cancelled");
			assert.equal((await first.readAgentSessionCommand(claim.command.command_id))?.state, "cancelled");
			assert.equal((await first.readAgentSessionCommandActivation(claim.command.command_id))?.state, "failed");
			assert.equal(await first.readAgentMaterialization(sessionId, 1), null);
			assert.equal(await first.readNextAgentSessionCommandActivationDueAt(13), null);
			assert.equal(
				await first.claimAgentSessionCommandActivation({ consumer: "host-after-cancel", leaseMs: 1_000, now: 13 }),
				null,
			);
			await assert.rejects(
				first.renewAgentSessionCommandActivationLease(claim.command.command_id, {
					consumer: claim.activation.consumer!,
					claimToken: claim.activation.claim_token!,
					leaseMs: 1_000,
					now: 13,
				}),
				/lease was lost/i,
			);
			const cancellationEvents = (await first.listAgentSessionEvents(sessionId)).filter(
				(event) => event.type === "command.cancelled",
			);
			assert.equal(cancellationEvents.length, 1);
		});
	});

	it("cancels delivered wake work without rewriting an already-bound body before physical cleanup", async () => {
		await withTwoStores(async (first, second) => {
			const sessionId = await seedResidentPrime(first, "session-cancel-bound");
			await first.submitAgentSessionCommand(sessionId, {
				commandId: "command-session-cancel-bound",
				idempotencyKey: "command-session-cancel-bound",
				name: "follow_up",
				payload: { text: "Cancellation must reap this already-bound wake." },
				clientId: "vehicle-session-cancel-bound",
				now: 10,
			});
			const claim = await first.claimAgentSessionCommandActivation({
				consumer: "host-session-cancel-bound",
				leaseMs: 1_000,
				now: 11,
			});
			assert.ok(claim);
			await first.bindAgentSandbox(sessionId, {
				generation: 1,
				activationId: claim.activation.activation_id,
				sandboxId: "sandbox-session-cancel-bound",
				now: 12,
			});
			await first.claimExactAgentSessionCommandForDelivery(sessionId, 1, claim.command.command_id, 13);

			const cancelled = await second.requestAgentSessionCancellation(sessionId, {
				requestId: "cancel-session-with-bound-wake",
				actor: { kind: "owner_api", ownerUserId: "user-command-activation" },
				reason: "owner cancelled after body bind",
				now: 14,
			});
			assert.equal(cancelled.cascade.state, "active");
			assert.equal((await first.readAgentSession(sessionId))?.lifecycle_state, "closing");
			assert.equal((await first.readAgentSessionCommand(claim.command.command_id))?.state, "cancelled");
			assert.equal((await first.readAgentSessionCommandActivation(claim.command.command_id))?.state, "failed");
			const stillBound = await first.readAgentMaterialization(sessionId, 1);
			assert.equal(stillBound?.state, "running");
			assert.equal(stillBound?.sandbox_id, "sandbox-session-cancel-bound");

			await first.finishAgentMaterialization(sessionId, 1, {
				activationId: claim.activation.activation_id,
				from: "running",
				to: "cancelled",
				now: 15,
			});
			assert.equal((await second.readAgentSession(sessionId))?.lifecycle_state, "closed");
			assert.equal((await second.readAgentSession(sessionId))?.status, "cancelled");
		});
	});

	it("does not advertise or claim a wake while the body is running or after an irrecoverable fault", async () => {
		await withTwoStores(async (first) => {
			const sessionId = await seedResidentPrime(first, "not-resumable", { passivated: false });
			await first.submitAgentSessionCommand(sessionId, {
				commandId: "command-not-resumable",
				idempotencyKey: "command-not-resumable",
				name: "follow_up",
				payload: { text: "Do not manufacture a second body." },
				clientId: "vehicle-not-resumable",
				now: 10,
			});
			assert.equal(await first.readNextAgentSessionCommandActivationDueAt(11), null);
			assert.equal(
				await first.claimAgentSessionCommandActivation({ consumer: "host-running", leaseMs: 1_000, now: 11 }),
				null,
			);

			await first.raw(
				`UPDATE agent_materializations
				    SET state = 'faulted', fault_kind = 'worker_exit', recoverable = 0, updated_at = 12
				  WHERE session_id = ? AND generation = 0`,
				[sessionId],
			);
			await first.raw(
				`UPDATE agent_session_body_states SET state = 'faulted', updated_at = 12
				  WHERE session_id = ? AND generation = 0 AND role = 'worker'`,
				[sessionId],
			);
			assert.equal(await first.readNextAgentSessionCommandActivationDueAt(13), null);
			assert.equal(
				await first.claimAgentSessionCommandActivation({ consumer: "host-faulted", leaseMs: 1_000, now: 13 }),
				null,
			);
		});
	});

	it("tombstones an unbound wake before any body when required capability authority is absent", async () => {
		await withTwoStores(async (first) => {
			const now = Date.now();
			const sessionId = await seedResidentPrime(first, "missing-authority", {
				capabilities: { browser: { kind: "web" } },
			});
			await first.submitAgentSessionCommand(sessionId, {
				commandId: "command-missing-authority",
				idempotencyKey: "command-missing-authority",
				name: "follow_up",
				payload: { text: "Do not mint a browser without durable authority." },
				clientId: "vehicle-missing-authority",
				now,
			});
			const claim = await first.claimAgentSessionCommandActivation({
				consumer: "host-missing-authority",
				leaseMs: 10_000,
				now: now + 1,
			});
			assert.ok(claim);

			const spawner = Object.create(SandboxSpawner.prototype) as SandboxSpawner;
			const host = spawner as unknown as Record<string, unknown>;
			host.workflowRuntime = first;
			host.agentMemory = {};
			host.eventBus = {};
			host.shuttingDown = false;
			await assert.rejects(
				spawner.activateAgentSessionCommand({
					activation: claim.activation,
					command: claim.command,
					signal: new AbortController().signal,
				}),
				/command_activation_grant_snapshot_missing/,
			);

			assert.equal((await first.readAgentSessionCommand(claim.command.command_id))?.state, "cancelled");
			assert.equal((await first.readAgentSessionCommandActivation(claim.command.command_id))?.state, "failed");
			assert.equal((await first.readAgentMaterialization(sessionId, 1))?.state, "authority_revoked");
			const bodies = await first.raw(
				"SELECT COUNT(*) AS count FROM agent_session_body_states WHERE session_id = ? AND generation = 1",
				[sessionId],
			);
			assert.equal(Number(bodies.rows[0]?.count), 0);
		});
	});

	it("settles a command-caused goal exactly once without an opaque goal_update mirror", async () => {
		await withTwoStores(async (first, second) => {
			const sessionId = await seedResidentPrime(first, "goal-handoff", { passivated: false });
			const submitted = await first.submitAgentSessionCommand(sessionId, {
				commandId: "goal-create-command",
				idempotencyKey: "goal-create-idempotency",
				name: "goal.create",
				payload: { objective: "Survive composting.", tokenBudget: 12 },
				clientId: "host-goal-proof",
				now: 10,
			});
			assert.equal(submitted?.record.name, "goal.create");
			const delivered = await first.claimExactAgentSessionCommandForDelivery(
				sessionId,
				0,
				"goal-create-command",
				11,
			);
			assert.equal(delivered?.state, "delivered");

			assert.equal(
				await first.recordPrimeGoalUpdatedWitness({
					sessionId,
					generation: 0,
					activationId: "activation-command-goal-handoff-0",
					workerSequence: 20,
					now: 12,
				}),
				true,
			);
			const response = {
				goal: {
					goal_id: "goal-handoff-1",
					objective: "Survive composting.",
					status: "active" as const,
					token_budget: 12,
					tokens_used: 0,
					time_used_seconds: 0,
					created_at: 12,
					updated_at: 12,
				},
				remaining_tokens: 12,
				completion_budget_report: null,
			};
			const settled = await second.settlePrimeGoalCommandResult({
				sessionId,
				generation: 0,
				activationId: "activation-command-goal-handoff-0",
				workerSequence: 21,
				commandId: "goal-create-command",
				commandName: "goal.create",
				status: "completed",
				result: response,
				now: 13,
			});
			assert.equal(settled.state, "completed");
			const events = await first.listAgentSessionEvents(sessionId);
			assert.equal(events.filter((event) => event.type === "goal.updated").length, 1);
			assert.equal(
				events.some((event) => event.type === "goal_update"),
				false,
			);
			const projection = await first.readAgentSessionGoalProjection(sessionId);
			assert.equal(projection?.reducer_state.goals["goal-handoff-1"]?.status, "active");
			assert.equal(
				projection?.reducer_state.receipts["goal-create-idempotency"]?.eventSequence,
				events.find((event) => event.type === "goal.updated")?.seq,
			);

			const replay = await second.settlePrimeGoalCommandResult({
				sessionId,
				generation: 0,
				activationId: "activation-command-goal-handoff-0",
				workerSequence: 21,
				commandId: "goal-create-command",
				commandName: "goal.create",
				status: "completed",
				result: response,
				now: 14,
			});
			assert.equal(replay.state, "completed");
			assert.equal(
				(await first.listAgentSessionEvents(sessionId)).filter((event) => event.type === "goal.updated").length,
				1,
			);
			await assert.rejects(
				second.settlePrimeGoalCommandResult({
					sessionId,
					generation: 0,
					activationId: "activation-command-goal-handoff-0",
					workerSequence: 22,
					commandId: "goal-create-command",
					commandName: "goal.create",
					status: "completed",
					result: { ...response, goal: { ...response.goal, objective: "divergent" } },
					now: 15,
				}),
				/first-wins|divergent/i,
			);
			await first.raw(
				`UPDATE agent_session_goal_projections
			    SET reducer_state_json = ?
			  WHERE session_id = ?`,
				[
					JSON.stringify({
						schema: "choreograph.agent-session-goal.v1",
						goals: {},
						currentGoalId: null,
						receipts: {},
						hostBudgetExhausted: false,
						forged: true,
					}),
					sessionId,
				],
			);
			await assert.rejects(
				first.readAgentSessionGoalProjection(sessionId),
				/invalid Agent Session reducer_state keys/,
			);
		});
	});
});

class InspectableWorkflowRuntimeStore extends WorkflowRuntimeStore {
	raw(sql: string, args: unknown[] = []) {
		return this.db.execute({ sql, args });
	}
}

async function seedResidentPrime(
	store: InspectableWorkflowRuntimeStore,
	suffix: string,
	options: { readonly passivated?: boolean; readonly capabilities?: AgentNodeSpec["capabilities"] } = {},
): Promise<string> {
	const graphId = "command-activation-proof";
	const sessionId = `ags-command-activation-${suffix}`;
	const runId = `wfr-command-activation-${suffix}`;
	const semantic = makeTestAgentSemanticBinding({ graphId, kind: "prime", registeredName: `command-${suffix}` });
	const spec: AgentNodeSpec = {
		label: "resident-prime",
		phaseIndex: 1,
		prompt: "Create resident state, then await durable commands.",
		model: "mock:done",
		provider: "openrouter",
		graphId,
		toolMode: "none",
		sessionId,
		...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
		...semantic,
	};
	await store.createWorkflowInstance({
		runId,
		workflowName: `command-activation-${suffix}`,
		graphId,
		ownerUserId: "user-command-activation",
		inputs: {},
		startedAt: 1,
	});
	await store.beginAgentSession({
		sessionId,
		runId,
		workflowName: `command-activation-${suffix}`,
		graphId,
		ownerUserId: "user-command-activation",
		graphOwnerPrincipal: "user:command-activation",
		spec,
		nodeKey: "1:resident-prime",
		frontier: { kind: "before-node", sessionId, phaseIndex: 1, ts: 1 },
		now: 1,
	});
	const activationId = `activation-command-${suffix}-0`;
	await store.claimAgentMaterialization(sessionId, { generation: 0, activationId, now: 2 });
	await store.bindAgentSandbox(sessionId, {
		generation: 0,
		activationId,
		sandboxId: `sandbox-command-${suffix}-0`,
		now: 3,
	});
	if (options.passivated === false) return sessionId;
	await store.beginAgentSessionKernelLaunch(sessionId, 0, {
		activationId,
		sandboxId: `kernel-command-${suffix}-0`,
		now: 4,
	});
	await store.bindAgentSessionKernelLaunch(sessionId, 0, {
		activationId,
		sandboxId: `kernel-command-${suffix}-0`,
		now: 5,
	});
	await store.recordAgentSessionKernelState(sessionId, 0, {
		activationId,
		state: "released",
		now: 6,
	});
	await store.raw(
		`UPDATE agent_materializations
		    SET state = 'passivated', checkpoint_id = ?, passivated_at = 8, updated_at = 8
		  WHERE session_id = ? AND generation = 0`,
		[`checkpoint-${suffix}`, sessionId],
	);
	await store.raw(
		`UPDATE agent_session_body_states SET state = 'passivated', updated_at = 8
		  WHERE session_id = ? AND generation = 0 AND role = 'worker'`,
		[sessionId],
	);
	return sessionId;
}

async function withTwoStores(
	run: (first: InspectableWorkflowRuntimeStore, second: InspectableWorkflowRuntimeStore) => Promise<void>,
): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "agent-command-activation-store-"));
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
