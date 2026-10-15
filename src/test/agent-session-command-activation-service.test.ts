import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AgentSessionCommandActivationService,
	type AgentSessionCommandActivationStore,
} from "../agent-runtime/agent-session-command-activation-service.js";
import type {
	AgentSessionCommandActivationRecord,
	AgentSessionCommandRecord,
	RenewAgentSessionCommandActivationLeaseInput,
	SettleAgentSessionCommandActivationInput,
} from "../workflow/runtime-store.js";

const COMMAND_ID = "command-activation-service";

class FakeCommandActivationStore implements AgentSessionCommandActivationStore {
	readonly command: Mutable<AgentSessionCommandRecord> = {
		command_id: COMMAND_ID,
		session_id: "ags-command-activation-service",
		idempotency_key: COMMAND_ID,
		command_digest: "digest",
		name: "follow_up",
		payload: { text: "continue exactly once" },
		client_id: "vehicle-service",
		target_generation: 1,
		delivery_generation: null,
		state: "queued",
		result: null,
		error: null,
		submitted_at: 100,
		delivered_at: null,
		completed_at: null,
	};
	readonly activation: Mutable<AgentSessionCommandActivationRecord> = {
		command_id: COMMAND_ID,
		session_id: this.command.session_id,
		target_generation: 1,
		activation_id: "activation-command-service-1",
		grant_snapshot_digest: null,
		state: "pending",
		attempt: 0,
		consumer: null,
		claim_token: null,
		claimed_at: null,
		claim_expires_at: null,
		heartbeat_at: null,
		not_before: 100,
		last_error: null,
		completed_at: null,
	};
	claimCount = 0;
	settlements: SettleAgentSessionCommandActivationInput[] = [];

	async claimAgentSessionCommandActivation(input: { consumer: string; leaseMs: number; now: number }) {
		if (this.activation.state !== "pending" || this.activation.not_before > input.now) return null;
		this.claimCount++;
		this.activation.state = "claimed";
		this.activation.attempt++;
		this.activation.consumer = input.consumer;
		this.activation.claim_token = `claim-${String(this.activation.attempt)}`;
		this.activation.claimed_at = input.now;
		this.activation.claim_expires_at = input.now + input.leaseMs;
		this.activation.heartbeat_at = input.now;
		return { activation: { ...this.activation }, command: { ...this.command } };
	}

	async readNextAgentSessionCommandActivationDueAt() {
		return this.activation.state === "pending" ? this.activation.not_before : null;
	}

	async renewAgentSessionCommandActivationLease(
		_commandId: string,
		input: RenewAgentSessionCommandActivationLeaseInput,
	) {
		this.activation.heartbeat_at = input.now;
		this.activation.claim_expires_at = input.now + input.leaseMs;
		return { ...this.activation };
	}

	async settleAgentSessionCommandActivation(_commandId: string, input: SettleAgentSessionCommandActivationInput) {
		this.settlements.push(input);
		if (input.outcome === "completed") {
			assert.equal(this.command.state, "completed");
			this.activation.state = "completed";
			this.activation.completed_at = input.now;
		} else if (input.outcome === "terminal_failure") {
			this.activation.state = "failed";
			this.activation.last_error = input.error;
			this.activation.completed_at = input.now;
		} else {
			this.activation.state = "pending";
			this.activation.not_before = input.retryAt;
			this.activation.last_error = input.error;
		}
		this.activation.consumer = null;
		this.activation.claim_token = null;
		this.activation.claimed_at = null;
		this.activation.claim_expires_at = null;
		this.activation.heartbeat_at = null;
		return { ...this.activation };
	}

	async readAgentSessionCommand(commandId: string) {
		return commandId === COMMAND_ID ? { ...this.command } : null;
	}

	async readAgentSessionCommandActivation(commandId: string) {
		return commandId === COMMAND_ID ? { ...this.activation } : null;
	}
}

describe("AgentSessionCommandActivationService", () => {
	it("owns one command activation until its durable result settles", async () => {
		const store = new FakeCommandActivationStore();
		let activations = 0;
		const service = new AgentSessionCommandActivationService({
			store,
			consumer: "command-service-a",
			idlePollMs: 2,
			retryBaseMs: 1,
			retryMaxMs: 2,
			activate: async ({ activation, command, signal }) => {
				assert.equal(signal.aborted, false);
				assert.equal(activation.command_id, command.command_id);
				activations++;
				store.command.state = "completed";
				store.command.result = { output: "continued" };
			},
		});
		await service.start();
		await eventually(() => store.activation.state === "completed");
		service.wake();
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		assert.equal(activations, 1);
		assert.equal(store.claimCount, 1);
		assert.equal(store.settlements.at(-1)?.outcome, "completed");
		await service.stop();
	});

	it("retries one physical activation without duplicating its command identity", async () => {
		const store = new FakeCommandActivationStore();
		let now = 100;
		const attempts: Array<{ attempt: number; commandId: string; activationId: string }> = [];
		const service = new AgentSessionCommandActivationService({
			store,
			consumer: "command-service-retry",
			now: () => now,
			idlePollMs: 2,
			retryBaseMs: 1,
			retryMaxMs: 2,
			activate: async ({ activation }) => {
				attempts.push({
					attempt: activation.attempt,
					commandId: activation.command_id,
					activationId: activation.activation_id,
				});
				if (attempts.length === 1) throw new Error("transient host loss");
				store.command.state = "completed";
			},
		});
		const settle = store.settleAgentSessionCommandActivation.bind(store);
		store.settleAgentSessionCommandActivation = async (commandId, input) => {
			const result = await settle(commandId, input);
			if (input.outcome === "retryable_failure") now = input.retryAt;
			return result;
		};
		// Startup is ready after one full iteration (here, the failed first attempt), not after the queue drains
		// (incident 2026-10-13): the retry completes after start() returns.
		await service.start();
		await eventually(() => store.activation.state === "completed");
		assert.deepEqual(
			attempts.map((attempt) => attempt.attempt),
			[1, 2],
		);
		assert.equal(new Set(attempts.map((attempt) => `${attempt.commandId}:${attempt.activationId}`)).size, 1);
		assert.deepEqual(
			store.settlements.map((settlement) => settlement.outcome),
			["retryable_failure", "completed"],
		);
		await service.stop();
	});

	it("aborts the physical activation when durable Session cancellation removes its lease", async () => {
		const store = new FakeCommandActivationStore();
		let started = false;
		let observedAbort = false;
		store.renewAgentSessionCommandActivationLease = async () => {
			throw new Error("command activation lease was lost to Session cancellation");
		};
		const service = new AgentSessionCommandActivationService({
			store,
			consumer: "command-service-cancel",
			leaseMs: 6,
			idlePollMs: 2,
			retryBaseMs: 1,
			retryMaxMs: 2,
			activate: async ({ signal }) => {
				started = true;
				await new Promise<void>((resolve) => {
					if (signal.aborted) {
						observedAbort = true;
						resolve();
						return;
					}
					signal.addEventListener(
						"abort",
						() => {
							observedAbort = true;
							resolve();
						},
						{ once: true },
					);
				});
			},
		});
		const startup = service.start();
		await eventually(() => started);
		store.command.state = "cancelled";
		store.command.error = "owner cancelled the Session";
		store.activation.state = "failed";
		store.activation.last_error = store.command.error;
		await startup;
		assert.equal(observedAbort, true);
		assert.equal(store.settlements.length, 0, "the cancellation transaction already owns work settlement");
		await service.stop();
	});
});

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

async function eventually(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("condition did not become true");
		await new Promise<void>((resolve) => setTimeout(resolve, 2));
	}
}
