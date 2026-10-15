import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AgentSessionSchedulerService,
	type AgentSessionSchedulerStore,
} from "../agent-runtime/agent-session-scheduler-service.js";
import type {
	AgentSessionCommandRecord,
	AgentSessionScheduleFireRecord,
	RenewAgentSessionScheduleFireLeaseInput,
	SettleAgentSessionScheduleFireInput,
} from "../workflow/runtime-store.js";

const FIRE_ID = "asf_scheduler_test";
const COMMAND_ID = "asc_scheduler_test";

class FakeSchedulerStore implements AgentSessionSchedulerStore {
	readonly command: AgentSessionCommandRecord = {
		command_id: COMMAND_ID,
		session_id: "ags_scheduler_test",
		idempotency_key: "schedule-fire:test",
		command_digest: "digest",
		name: "prompt",
		payload: { text: "wake exactly once" },
		client_id: "scheduler-test",
		target_generation: 1,
		delivery_generation: null,
		state: "queued",
		result: null,
		error: null,
		submitted_at: 100,
		delivered_at: null,
		completed_at: null,
	};
	readonly fire: Mutable<AgentSessionScheduleFireRecord> = {
		fire_id: FIRE_ID,
		schedule_id: "schedule-test",
		session_id: "ags_scheduler_test",
		ordinal: 0,
		scheduled_at: 100,
		coalesced_through_at: 100,
		coalesced_count: 1,
		command_id: COMMAND_ID,
		target_generation: 1,
		activation_id: "schedule-activation-test",
		created_at: 100,
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
	settlements: SettleAgentSessionScheduleFireInput[] = [];

	async claimDueAgentSessionScheduleFire(input: {
		readonly consumer: string;
		readonly leaseMs: number;
		readonly now: number;
	}) {
		if (this.fire.state !== "pending" || this.fire.not_before > input.now) return null;
		this.claimCount++;
		this.fire.state = "claimed";
		this.fire.attempt++;
		this.fire.consumer = input.consumer;
		this.fire.claim_token = `claim-${String(this.fire.attempt)}`;
		this.fire.claimed_at = input.now;
		this.fire.claim_expires_at = input.now + input.leaseMs;
		this.fire.heartbeat_at = input.now;
		return { fire: { ...this.fire }, command: { ...this.command }, claimed: true };
	}

	async readNextAgentSessionScheduleDueAt() {
		return this.fire.state === "pending" ? this.fire.not_before : null;
	}

	async renewAgentSessionScheduleFireLease(_fireId: string, input: RenewAgentSessionScheduleFireLeaseInput) {
		this.fire.heartbeat_at = input.now;
		this.fire.claim_expires_at = input.now + input.leaseMs;
		return { ...this.fire };
	}

	async settleAgentSessionScheduleFire(_fireId: string, input: SettleAgentSessionScheduleFireInput) {
		assert.equal(input.consumer, this.fire.consumer);
		assert.equal(input.claimToken, this.fire.claim_token);
		this.settlements.push(input);
		if (input.outcome === "completed") {
			assert.equal(this.command.state, "completed");
			this.fire.state = "completed";
			this.fire.completed_at = input.now;
		} else if (input.outcome === "terminal_failure") {
			this.fire.state = "failed";
			this.fire.last_error = input.error;
			this.fire.completed_at = input.now;
		} else {
			this.fire.state = "pending";
			this.fire.not_before = input.retryAt;
			this.fire.last_error = input.error;
		}
		this.fire.consumer = null;
		this.fire.claim_token = null;
		this.fire.claimed_at = null;
		this.fire.claim_expires_at = null;
		this.fire.heartbeat_at = null;
		return { ...this.fire };
	}

	async readAgentSessionCommand(commandId: string) {
		return commandId === COMMAND_ID ? { ...this.command } : null;
	}
}

describe("AgentSessionSchedulerService", () => {
	it("waits until due, embodies one fire, and fences rescans after completion", async () => {
		const store = new FakeSchedulerStore();
		store.fire.not_before = 200;
		let now = 100;
		const activations: Array<Pick<AgentSessionScheduleFireRecord, "fire_id" | "command_id" | "activation_id">> = [];
		const service = new AgentSessionSchedulerService({
			store,
			consumer: "scheduler-a",
			now: () => now,
			idlePollMs: 5,
			retryBaseMs: 1,
			retryMaxMs: 5,
			activate: async ({ fire, command, signal }) => {
				assert.equal(signal.aborted, false);
				assert.equal(command.command_id, fire.command_id);
				activations.push({
					fire_id: fire.fire_id,
					command_id: fire.command_id,
					activation_id: fire.activation_id,
				});
				store.command.state = "completed";
				store.command.result = { output: "scheduled result" };
			},
		});

		await service.start();
		assert.equal(activations.length, 0);
		now = 200;
		service.wake();
		await eventually(() => store.fire.state === "completed");
		service.wake();
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(activations, [
			{ fire_id: FIRE_ID, command_id: COMMAND_ID, activation_id: "schedule-activation-test" },
		]);
		assert.equal(store.claimCount, 1);
		assert.equal(store.settlements.at(-1)?.outcome, "completed");
		await service.stop();
	});

	it("retries the same immutable fire coordinates after a transient activation failure", async () => {
		const store = new FakeSchedulerStore();
		let now = 100;
		const attempts: Array<{ attempt: number; fireId: string; commandId: string; activationId: string }> = [];
		const service = new AgentSessionSchedulerService({
			store,
			consumer: "scheduler-retry",
			now: () => now,
			idlePollMs: 2,
			retryBaseMs: 1,
			retryMaxMs: 2,
			activate: async ({ fire }) => {
				attempts.push({
					attempt: fire.attempt,
					fireId: fire.fire_id,
					commandId: fire.command_id,
					activationId: fire.activation_id,
				});
				if (attempts.length === 1) throw new Error("transient host loss");
				store.command.state = "completed";
			},
		});
		const originalSettle = store.settleAgentSessionScheduleFire.bind(store);
		store.settleAgentSessionScheduleFire = async (fireId, input) => {
			const settled = await originalSettle(fireId, input);
			if (input.outcome === "retryable_failure") now = input.retryAt;
			return settled;
		};

		await service.start();
		assert.equal(store.fire.state, "completed");
		assert.deepEqual(
			attempts.map(({ attempt }) => attempt),
			[1, 2],
		);
		assert.deepEqual(
			new Set(attempts.map(({ fireId, commandId, activationId }) => `${fireId}:${commandId}:${activationId}`)).size,
			1,
		);
		assert.deepEqual(
			store.settlements.map(({ outcome }) => outcome),
			["retryable_failure", "completed"],
		);
		await service.stop();
	});

	it("admits no fire after the stop latch", async () => {
		const store = new FakeSchedulerStore();
		store.fire.not_before = 200;
		let now = 100;
		let activations = 0;
		const service = new AgentSessionSchedulerService({
			store,
			consumer: "scheduler-stop",
			now: () => now,
			idlePollMs: 5,
			activate: async () => {
				activations++;
			},
		});
		await service.start();
		await service.stop();
		now = 200;
		service.wake();
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		assert.equal(activations, 0);
		assert.equal(store.claimCount, 0);
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
