/**
 * Incident 2026-10-13 13:20 PDT: a host replacement restored a queued follow-up whose passivated Prime predecessor
 * carried no terminal kernel testimony. Every claim threw "Prime regrow requires exact terminal predecessor kernel
 * testimony" inside the claim transaction, so nothing durable changed, the same command was admitted again on every
 * iteration, and the activation service never marked startup ready: the orchestrator never reached `listen`.
 *
 * Real WorkflowRuntimeStore on libSQL in a temporary directory; the activator is a real function that drives the
 * store's own delivery and completion path.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	type AgentSessionCommandActivation,
	AgentSessionCommandActivationService,
} from "../agent-runtime/agent-session-command-activation-service.js";
import { digestAgentRuntimeBinding } from "../agent-runtime/profile.js";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

const REFUSAL = /Prime regrow requires exact terminal predecessor kernel testimony/;

describe("command activation with a predecessor that cannot regrow", () => {
	it("settles the refused command terminally, with its reason, instead of throwing on every claim", async () => {
		await withStore(async (store) => {
			const sessionId = await seedPassivatedPrime(store, "poisoned", { kernel: "none" });
			await submitFollowUp(store, sessionId, "command-poisoned", 10);

			const claim = await store.claimAgentSessionCommandActivation({ consumer: "host-a", leaseMs: 1_000, now: 11 });
			assert.equal(claim, null, "nothing claimable remains once the refused command is settled");

			const command = await store.readAgentSessionCommand("command-poisoned");
			assert.equal(command?.state, "cancelled");
			assert.match(command?.error ?? "", REFUSAL);
			const events = await store.listAgentSessionEvents(sessionId);
			assert.ok(
				events.some(
					(event) => event.type === "command.cancelled" && event.payload?.commandId === "command-poisoned",
				),
				"the Session's event stream says the command was cancelled",
			);
			assert.equal(await store.readAgentMaterialization(sessionId, 1), null, "no generation was claimed");

			// Not claimed again: a later claim neither throws nor returns it.
			assert.equal(
				await store.claimAgentSessionCommandActivation({ consumer: "host-b", leaseMs: 1_000, now: 12 }),
				null,
			);
			assert.equal((await store.readAgentSessionCommand("command-poisoned"))?.state, "cancelled");
		});
	});

	it("regrows a kernel-less Session (its binding grants no kernel) from its checkpoint", async () => {
		await withStore(async (store) => {
			const sessionId = await seedPassivatedPrime(store, "kernelless", { kernel: "none", kernelless: true });
			await submitFollowUp(store, sessionId, "command-kernelless", 10);
			const claim = await store.claimAgentSessionCommandActivation({ consumer: "host-a", leaseMs: 1_000, now: 11 });
			assert.ok(claim, "the follow-up is claimed instead of refused");
			assert.equal((await store.readAgentSessionCommand("command-kernelless"))?.state === "cancelled", false);
			const next = await store.readAgentMaterialization(sessionId, 1);
			assert.equal(next?.state, "claimed", "generation 1 was claimed from the passivated generation 0");
		});
	});

	it("still refuses a Session whose binding allows a kernel but left no kernel testimony", async () => {
		await withStore(async (store) => {
			const sessionId = await seedPassivatedPrime(store, "kernel-allowed", { kernel: "none" });
			await submitFollowUp(store, sessionId, "command-kernel-allowed", 10);
			assert.equal(
				await store.claimAgentSessionCommandActivation({ consumer: "host-a", leaseMs: 1_000, now: 11 }),
				null,
			);
			const command = await store.readAgentSessionCommand("command-kernel-allowed");
			assert.equal(command?.state, "cancelled");
			assert.match(command?.error ?? "", REFUSAL);
		});
	});

	it("still claims the healthy command queued behind the refused one", async () => {
		await withStore(async (store) => {
			const poisoned = await seedPassivatedPrime(store, "behind-poisoned", { kernel: "none" });
			const healthy = await seedPassivatedPrime(store, "behind-healthy", { kernel: "released" });
			await submitFollowUp(store, poisoned, "command-first-poisoned", 10);
			await submitFollowUp(store, healthy, "command-second-healthy", 11);

			const claim = await store.claimAgentSessionCommandActivation({ consumer: "host-a", leaseMs: 1_000, now: 12 });
			assert.equal(claim?.command.command_id, "command-second-healthy");
			assert.equal(claim?.activation.target_generation, 1);
			assert.equal((await store.readAgentSessionCommand("command-first-poisoned"))?.state, "cancelled");
		});
	});

	it("refuses a pending activation whose predecessor stopped being regrowable", async () => {
		await withStore(async (store) => {
			const sessionId = await seedPassivatedPrime(store, "pending-poisoned", { kernel: "released" });
			await submitFollowUp(store, sessionId, "command-pending-poisoned", 10);
			const first = await store.claimAgentSessionCommandActivation({ consumer: "host-a", leaseMs: 5, now: 11 });
			assert.ok(first);
			// The claimed generation never embodied; the host died and its testimony went with it.
			await store.raw("DELETE FROM agent_materialization_supervision WHERE session_id = ? AND generation = 1", [
				sessionId,
			]);
			await store.raw("DELETE FROM agent_materializations WHERE session_id = ? AND generation = 1", [sessionId]);
			await store.raw(
				"DELETE FROM agent_session_body_states WHERE session_id = ? AND generation = 0 AND role = 'kernel'",
				[sessionId],
			);
			await store.raw(
				`UPDATE agent_session_command_activation_work
				    SET state = 'pending', consumer = NULL, claim_token = NULL, claimed_at = NULL,
				        claim_expires_at = NULL, heartbeat_at = NULL
				  WHERE command_id = ?`,
				["command-pending-poisoned"],
			);

			assert.equal(
				await store.claimAgentSessionCommandActivation({ consumer: "host-b", leaseMs: 1_000, now: 20 }),
				null,
			);
			assert.equal((await store.readAgentSessionCommand("command-pending-poisoned"))?.state, "cancelled");
			const work = await store.readAgentSessionCommandActivation("command-pending-poisoned");
			assert.equal(work?.state, "failed");
			assert.match(work?.last_error ?? "", REFUSAL);
		});
	});

	it("marks startup ready while a refused command is queued, so the orchestrator can listen", async () => {
		await withStore(async (store) => {
			const sessionId = await seedPassivatedPrime(store, "startup-poisoned", { kernel: "none" });
			await submitFollowUp(store, sessionId, "command-startup-poisoned", 10);
			const activated: string[] = [];
			const service = activationService(store, async ({ command }) => {
				activated.push(command.command_id);
			});
			try {
				await withinMs(service.start(), 2_000, "startup readiness");
				assert.deepEqual(activated, [], "the refused command never reaches a body");
				assert.equal((await store.readAgentSessionCommand("command-startup-poisoned"))?.state, "cancelled");
			} finally {
				await service.stop();
			}
		});
	});

	it("marks startup ready even when every claim fails", async () => {
		await withStore(async (store) => {
			// A store that cannot answer at all: every iteration fails before any command is claimed.
			store.close();
			const errors: string[] = [];
			const service = activationService(store, async () => undefined, errors);
			try {
				await withinMs(service.start(), 2_000, "startup readiness");
				assert.ok(errors.length >= 1, "the failing iteration is still logged");
			} finally {
				await service.stop();
			}
		});
	});

	it("retries a command whose activation fails transiently, and delivers it on the next attempt", async () => {
		await withStore(async (store) => {
			const sessionId = await seedPassivatedPrime(store, "transient", { kernel: "released" });
			await submitFollowUp(store, sessionId, "command-transient", 10);
			let attempts = 0;
			const service = activationService(store, async ({ activation, command }) => {
				attempts += 1;
				if (attempts === 1) throw new Error("socket hang up");
				await embodyAndComplete(store, sessionId, activation, command.command_id);
			});
			try {
				await withinMs(service.start(), 2_000, "startup readiness");
				await eventually(
					async () => (await store.readAgentSessionCommand("command-transient"))?.state === "completed",
				);
				await eventually(
					async () => (await store.readAgentSessionCommandActivation("command-transient"))?.state === "completed",
				);
				assert.equal(attempts, 2);
				assert.equal((await store.readAgentSessionCommandActivation("command-transient"))?.attempt, 2);
			} finally {
				await service.stop();
			}
		});
	});
});

class InspectableWorkflowRuntimeStore extends WorkflowRuntimeStore {
	raw(sql: string, args: unknown[] = []) {
		return this.db.execute({ sql, args: args as never });
	}
}

function activationService(
	store: WorkflowRuntimeStore,
	activate: (input: AgentSessionCommandActivation) => Promise<void>,
	errors: string[] = [],
): AgentSessionCommandActivationService {
	return new AgentSessionCommandActivationService({
		store,
		consumer: "incident-proof",
		activate,
		leaseMs: 1_000,
		retryBaseMs: 5,
		retryMaxMs: 10,
		idlePollMs: 10,
		commandSettleTimeoutMs: 1_000,
		logger: {
			error: (message: string) => errors.push(String(message)),
			warn: (message: string) => errors.push(String(message)),
		},
	});
}

/** The store's own embodiment and completion path, as a host does it. */
async function embodyAndComplete(
	store: WorkflowRuntimeStore,
	sessionId: string,
	activation: AgentSessionCommandActivation["activation"],
	commandId: string,
): Promise<void> {
	const now = Date.now();
	await store.bindAgentSandbox(sessionId, {
		generation: activation.target_generation,
		activationId: activation.activation_id,
		sandboxId: `sandbox-${commandId}`,
		now,
	});
	const delivered = await store.claimExactAgentSessionCommandForDelivery(
		sessionId,
		activation.target_generation,
		commandId,
		now,
	);
	assert.equal(delivered?.command_id, commandId);
	await store.completeAgentSessionCommand(commandId, activation.target_generation, {
		status: "completed",
		result: { output: "continued" },
		now,
	});
}

async function submitFollowUp(
	store: WorkflowRuntimeStore,
	sessionId: string,
	commandId: string,
	now: number,
): Promise<void> {
	const submitted = await store.submitAgentSessionCommand(sessionId, {
		commandId,
		idempotencyKey: commandId,
		name: "follow_up",
		payload: { text: "Continue after composting." },
		clientId: "vehicle-incident",
		now,
	});
	assert.equal(submitted?.record.target_generation, 1);
}

/**
 * A resident Prime at generation 0, passivated with a checkpoint. `kernel: "released"` gives it the exact terminal
 * kernel testimony a regrow requires; `kernel: "none"` gives it none, as in the incident.
 */
async function seedPassivatedPrime(
	store: InspectableWorkflowRuntimeStore,
	suffix: string,
	options: { readonly kernel: "released" | "none"; readonly kernelless?: true },
): Promise<string> {
	const graphId = "command-activation-incident";
	const sessionId = `ags-incident-${suffix}`;
	const runId = `wfr-incident-${suffix}`;
	const base = makeTestAgentSemanticBinding({ graphId, kind: "prime", registeredName: `incident-${suffix}` });
	// A binding that grants no persistent kernel (the workspace chat's): its Session never has a kernel row.
	const semantic = options.kernelless
		? (() => {
				const runtime = {
					...base.runtime,
					constraints: { ...base.runtime.constraints, allowPersistentKernel: false },
				};
				return { ...base, runtime, runtimeBindingDigest: digestAgentRuntimeBinding(runtime) };
			})()
		: base;
	const spec: AgentNodeSpec = {
		label: "resident-prime",
		phaseIndex: 1,
		prompt: "Create resident state, then await durable commands.",
		model: "mock:done",
		provider: "openrouter",
		graphId,
		toolMode: "none",
		sessionId,
		...semantic,
	};
	await store.createWorkflowInstance({
		runId,
		workflowName: `incident-${suffix}`,
		graphId,
		ownerUserId: "user-incident",
		inputs: {},
		startedAt: 1,
	});
	await store.beginAgentSession({
		sessionId,
		runId,
		workflowName: `incident-${suffix}`,
		graphId,
		ownerUserId: "user-incident",
		graphOwnerPrincipal: "user:incident",
		spec,
		nodeKey: "1:resident-prime",
		frontier: { kind: "before-node", sessionId, phaseIndex: 1, ts: 1 },
		now: 1,
	});
	const activationId = `activation-incident-${suffix}-0`;
	await store.claimAgentMaterialization(sessionId, { generation: 0, activationId, now: 2 });
	await store.bindAgentSandbox(sessionId, {
		generation: 0,
		activationId,
		sandboxId: `sandbox-incident-${suffix}-0`,
		now: 3,
	});
	if (options.kernel === "released") {
		await store.beginAgentSessionKernelLaunch(sessionId, 0, {
			activationId,
			sandboxId: `kernel-incident-${suffix}-0`,
			now: 4,
		});
		await store.bindAgentSessionKernelLaunch(sessionId, 0, {
			activationId,
			sandboxId: `kernel-incident-${suffix}-0`,
			now: 5,
		});
		await store.recordAgentSessionKernelState(sessionId, 0, { activationId, state: "released", now: 6 });
	}
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

async function withStore(run: (store: InspectableWorkflowRuntimeStore) => Promise<void>): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "command-activation-incident-"));
	const store = new InspectableWorkflowRuntimeStore(join(directory, "runtime.sqlite"));
	try {
		await store.init();
		await run(store);
	} finally {
		try {
			store.close();
		} catch {
			// Already closed by the test.
		}
		rmSync(directory, { recursive: true, force: true });
	}
}

async function withinMs<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} did not resolve within ${String(ms)} ms`)), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function eventually(predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error("condition did not become true");
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
}
