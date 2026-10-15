import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { BusEvent, BusSubscriber, SandboxEventBus, SubscribeOptions } from "../event-bus.js";
import { type InternalStageJob, parseInternalStageSubmission } from "../internal-jobs/contracts.js";
import type { InternalStageAttemptPlan, InternalStageDriver } from "../internal-jobs/registry.js";
import { InternalStageRegistry } from "../internal-jobs/registry.js";
import { InternalJobRunner } from "../internal-jobs/runner.js";
import { InternalJobStore } from "../internal-jobs/store.js";
import type { SandboxState } from "../sandbox-store.js";
import type { SandboxSpawner } from "../spawner.js";

const JOB_ID = "66666666-6666-4666-8666-666666666666";
const DIGEST = "d".repeat(64);
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class FakeTerminalBus implements SandboxEventBus {
	unsubscribeCount = 0;
	private subscriber?: BusSubscriber;

	constructor(private readonly immediateState?: SandboxState) {}

	emit(_event: BusEvent): void {}

	subscribe(subscriber: BusSubscriber, options: SubscribeOptions): () => void {
		this.subscriber = subscriber;
		if (this.immediateState) {
			subscriber({
				category: "system",
				type: "snapshot",
				sandbox_id: options.sandbox_id,
				ts: new Date().toISOString(),
				record: {
					sandbox_id: options.sandbox_id,
					state: this.immediateState,
					exit_code: this.immediateState === "done" ? 0 : 1,
				} as never,
				recent_events: [],
			});
		}
		return () => {
			this.unsubscribeCount += 1;
			this.subscriber = undefined;
		};
	}

	terminal(sandboxId: string, state: SandboxState): void {
		this.subscriber?.({
			category: "lifecycle",
			type: "terminal",
			sandbox_id: sandboxId,
			ts: new Date().toISOString(),
			state,
			exit_code: state === "done" ? 0 : 1,
		});
	}

	subscriberCount(): number {
		return this.subscriber ? 1 : 0;
	}

	cleanup(): void {}
}

class FakeSpawner {
	readonly sandboxId = "sandbox-internal-test";
	killCalls = 0;
	onEnqueue?: () => void;

	constructor(readonly bus: FakeTerminalBus) {}

	enqueue() {
		this.onEnqueue?.();
		return { sandbox_id: this.sandboxId };
	}

	async kill() {
		this.killCalls += 1;
		this.bus.terminal(this.sandboxId, "killed");
		return { sandbox_id: this.sandboxId };
	}
}

class FakeDriver implements InternalStageDriver {
	readonly stage = "transcription" as const;
	readonly maxAttempts = 2;

	initialModel(): string {
		return "vibeasr-bitnet";
	}

	retryModel(_job: InternalStageJob, nextAttempt: number): string {
		assert.equal(nextAttempt, 2);
		return "whisper-small-en";
	}

	async validateSubmission(): Promise<void> {}

	async prepareAttempt(): Promise<InternalStageAttemptPlan> {
		return {
			template: "bare",
			privateMounts: [],
			resources: {
				memory_max_bytes: 64 * 1024 * 1024,
				cpu_quota_us: 100_000,
				cpu_period_us: 100_000,
				pids_max: 16,
			},
			timeoutMs: 10_000,
			workerConfig: { mode: "command", command: ["/bin/true"] },
		};
	}

	async validateAndPromote() {
		return { resultDigest: "e".repeat(64) };
	}
}

function submission(jobId = JOB_ID) {
	return parseInternalStageSubmission({
		schema_version: 1,
		job_id: jobId,
		stage: "transcription",
		input_digest: DIGEST,
		input: { manifest_sha256: DIGEST },
		parameters: { preferred_model: "vibeasr-bitnet" },
	});
}

function fixture(state?: SandboxState) {
	const root = mkdtempSync(join(tmpdir(), "internal-runner-"));
	roots.push(root);
	const store = new InternalJobStore(join(root, "jobs.sqlite"));
	const registry = new InternalStageRegistry();
	registry.register(new FakeDriver());
	const bus = new FakeTerminalBus(state);
	const spawner = new FakeSpawner(bus);
	const runner = new InternalJobRunner(store, registry, spawner as unknown as SandboxSpawner);
	runner.start();
	return { store, bus, spawner, runner };
}

async function waitForState(
	store: InternalJobStore,
	state: InternalStageJob["state"],
	timeoutMs = 2000,
): Promise<InternalStageJob> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const job = store.get(JOB_ID, "transcription");
		if (job?.state === state) return job;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`job did not reach ${state}`);
}

describe("internal stage runner", () => {
	it("latches admission before draining an active worker and leaves queued work unclaimed", async () => {
		const { store, bus, runner } = fixture();
		await runner.submit(submission());
		await waitForState(store, "running");
		const queuedId = "77777777-7777-4777-8777-777777777777";
		await runner.submit(submission(queuedId));
		assert.equal(store.get(queuedId, "transcription")?.state, "queued");

		let drained = false;
		const shutdown = runner.shutdown().then(() => {
			drained = true;
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
		assert.equal(drained, false, "the active worker remains part of the shutdown barrier");
		await assert.rejects(() => runner.submit(submission("99999999-9999-4999-8999-999999999999")), {
			statusCode: 503,
		});
		assert.throws(() => runner.retry(queuedId, "transcription", 1, "shutdown-retry"), { statusCode: 503 });
		await assert.rejects(() => runner.cancel(queuedId, "transcription"), { statusCode: 503 });
		assert.equal(store.get(queuedId, "transcription")?.state, "queued");

		bus.terminal("sandbox-internal-test", "done");
		await shutdown;
		assert.equal(store.get(queuedId, "transcription")?.state, "queued");
		store.close();
	});

	it("handles a terminal replay snapshot and immediately unsubscribes", async () => {
		const { store, bus, runner } = fixture("done");
		await runner.submit(submission());
		const succeeded = await waitForState(store, "succeeded");
		assert.equal(succeeded.result_digest, "e".repeat(64));
		assert.equal(bus.unsubscribeCount, 1);
		await runner.shutdown();
		store.close();
	});

	it("selects the fixed fallback once and then becomes terminal", async () => {
		const { store, runner } = fixture("error");
		await runner.submit(submission());
		const first = await waitForState(store, "failed_retryable");
		assert.equal(first.attempt, 1);
		const retried = runner.retry(JOB_ID, "transcription", 1, "fallback-once");
		assert.equal(retried.model, "whisper-small-en");
		const second = await waitForState(store, "failed_terminal");
		assert.equal(second.attempt, 2);
		const replay = runner.retry(JOB_ID, "transcription", 1, "fallback-once");
		assert.equal(replay.state, "failed_terminal");
		assert.equal(replay.attempt, 2);
		await runner.shutdown();
		store.close();
	});

	it("kills a running sandbox and preserves cancelled state", async () => {
		const { store, spawner, runner } = fixture();
		await runner.submit(submission());
		await waitForState(store, "running");
		const cancelled = await runner.cancel(JOB_ID, "transcription");
		assert.equal(cancelled.state, "cancelled");
		assert.equal(spawner.killCalls, 1);
		await runner.shutdown();
		store.close();
	});

	it("kills a sandbox when cancellation lands between enqueue and attachment", async () => {
		const { store, spawner, runner } = fixture();
		spawner.onEnqueue = () => {
			void runner.cancel(JOB_ID, "transcription");
		};
		await runner.submit(submission());
		await waitForState(store, "cancelled");
		const deadline = Date.now() + 2000;
		while (spawner.killCalls !== 1 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(spawner.killCalls, 1);
		await runner.shutdown();
		store.close();
	});
});
