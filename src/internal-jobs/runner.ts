import type { BusEvent } from "../event-bus.js";
import {
	internalStageJobsTotal,
	internalStageQueueDepth,
	transcriptionPeakRssBytes,
	transcriptionRtf,
	transcriptionWallSeconds,
} from "../metrics.js";
import type { SandboxState } from "../sandbox-store.js";
import type { SandboxSpawner } from "../spawner.js";
import {
	INTERNAL_STAGE_KINDS,
	InternalJobRequestError,
	InternalStageInputValidationError,
	type InternalStageJob,
	type InternalStageKind,
	type InternalStageSubmission,
} from "./contracts.js";
import type { InternalStageRegistry } from "./registry.js";
import type { InternalJobStore } from "./store.js";

const SANDBOX_TERMINAL_STATES = new Set<SandboxState>(["done", "truncated", "error", "timeout", "killed"]);

export class InternalJobRunner {
	private activeWorkers = 0;
	private closing = false;
	private readonly workerPromises = new Set<Promise<void>>();

	constructor(
		readonly store: InternalJobStore,
		private readonly registry: InternalStageRegistry,
		private readonly spawner: SandboxSpawner,
		private readonly concurrency = 1,
	) {
		if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
			throw new Error("internal stage concurrency must be an integer from 1 through 8");
		}
		if (!spawner.bus) {
			throw new Error("internal stages require the Choreograph sandbox event bus");
		}
	}

	start(): void {
		for (const stage of INTERNAL_STAGE_KINDS) {
			const driver = this.registry.require(stage);
			const recovered = this.store.recoverRunning(stage, driver.maxAttempts);
			for (const job of recovered) {
				recordTerminalMetric(job);
				console.warn(`[internal-jobs] recovered interrupted ${job.stage} job ${job.job_id} as ${job.state}`);
			}
		}
		for (const stage of INTERNAL_STAGE_KINDS) {
			const queued = this.store.list(["queued"]).filter((job) => job.stage === stage).length;
			if (queued > 0) internalStageQueueDepth.add(queued, { stage });
		}
		this.kick();
	}

	async shutdown(): Promise<void> {
		this.closing = true;
		await Promise.allSettled([...this.workerPromises]);
	}

	async submit(submission: InternalStageSubmission): Promise<InternalStageJob> {
		this.assertAdmissionOpen();
		const driver = this.registry.require(submission.stage);
		await driver.validateSubmission(submission);
		this.assertAdmissionOpen();
		const result = this.store.createOrGet(submission, driver.initialModel(submission));
		if (result.created) {
			internalStageQueueDepth.add(1, { stage: submission.stage });
			this.kick();
		}
		return result.job;
	}

	status(jobId: string, stage: InternalStageKind): InternalStageJob {
		const job = this.store.get(jobId, stage);
		if (!job) throw new InternalJobRequestError("stage job not found", 404);
		return job;
	}

	retry(jobId: string, stage: InternalStageKind, expectedAttempt: number, idempotencyKey: string): InternalStageJob {
		this.assertAdmissionOpen();
		const replay = this.store.getRetryReplay(jobId, stage, idempotencyKey);
		if (replay) return replay;
		const current = this.status(jobId, stage);
		const driver = this.registry.require(stage);
		const model = driver.retryModel(current, current.attempt + 1);
		const retried = this.store.retry(jobId, stage, expectedAttempt, idempotencyKey, model, driver.maxAttempts);
		internalStageQueueDepth.add(1, { stage });
		this.kick();
		return retried;
	}

	async cancel(jobId: string, stage: InternalStageKind): Promise<InternalStageJob> {
		this.assertAdmissionOpen();
		const current = this.status(jobId, stage);
		const cancelled = this.store.cancel(jobId, stage);
		if (current.state === "queued") internalStageQueueDepth.add(-1, { stage });
		if (current.state === "running" && current.sandbox_id) {
			try {
				await this.spawner.kill(current.sandbox_id);
			} catch (error) {
				console.warn(
					`[internal-jobs] sandbox kill raced terminal state: job=${jobId} error=${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
		if (cancelled.state === "cancelled" && current.state !== "cancelled") recordTerminalMetric(cancelled);
		return cancelled;
	}

	private kick(): void {
		if (this.closing) return;
		while (this.activeWorkers < this.concurrency && this.store.list(["queued"]).length > 0) {
			this.activeWorkers += 1;
			const worker = this.workerLoop().finally(() => {
				this.activeWorkers -= 1;
				this.workerPromises.delete(worker);
				if (!this.closing) this.kick();
			});
			this.workerPromises.add(worker);
		}
	}

	private assertAdmissionOpen(): void {
		if (this.closing) throw new InternalJobRequestError("internal stage runner is shutting down", 503);
	}

	private async workerLoop(): Promise<void> {
		while (!this.closing) {
			const job = this.store.claimNextQueued();
			if (!job) return;
			internalStageQueueDepth.add(-1, { stage: job.stage });
			await this.execute(job);
		}
	}

	private async execute(job: InternalStageJob): Promise<void> {
		const driver = this.registry.require(job.stage);
		try {
			const plan = await driver.prepareAttempt(job);
			const sandbox = this.spawner.enqueue({
				template: plan.template,
				resources: plan.resources,
				timeout_ms: plan.timeoutMs,
				intent: `internal:${job.stage}:${job.job_id}:attempt:${job.attempt}`,
				worker_config: plan.workerConfig,
				privateMounts: plan.privateMounts,
				ownerUserId: "phanes-internal",
				authMethod: "internal_stage",
			});
			const attached = this.store.attachSandbox(job, sandbox.sandbox_id);
			if (attached.state !== "running") {
				try {
					await this.spawner.kill(sandbox.sandbox_id);
				} catch (error) {
					console.warn(
						`[internal-jobs] sandbox kill raced non-running attachment: job=${job.job_id} state=${
							attached.state
						} error=${error instanceof Error ? error.message : String(error)}`,
					);
				}
				return;
			}
			const terminal = await this.waitForTerminal(sandbox.sandbox_id);
			const current = this.status(job.job_id, job.stage);
			if (current.state === "cancelled") return;
			if (terminal.state !== "done" || terminal.exitCode !== 0) {
				throw new Error(
					`ASR sandbox ended in ${terminal.state}${
						terminal.exitCode == null ? "" : ` with exit code ${terminal.exitCode}`
					}`,
				);
			}
			const promotion = await driver.validateAndPromote(current);
			const succeeded = this.store.finish(current, "succeeded", { resultDigest: promotion.resultDigest });
			if (succeeded.state !== "succeeded") return;
			recordTerminalMetric(succeeded);
			recordPromotionMetrics(succeeded, promotion.metrics);
			console.log(
				`[internal-jobs] ${job.stage} succeeded job=${job.job_id} attempt=${job.attempt} result=${promotion.resultDigest}`,
			);
		} catch (error) {
			const current = this.status(job.job_id, job.stage);
			if (current.state === "cancelled") return;
			const terminal = error instanceof InternalStageInputValidationError || current.attempt >= driver.maxAttempts;
			const message = error instanceof Error ? error.message : String(error);
			const failed = this.store.finish(current, terminal ? "failed_terminal" : "failed_retryable", {
				error: message,
			});
			recordTerminalMetric(failed);
			console.warn(
				`[internal-jobs] ${job.stage} failed job=${job.job_id} attempt=${job.attempt} terminal=${terminal}: ${message}`,
			);
		}
	}

	private waitForTerminal(
		sandboxId: string,
	): Promise<{ state: SandboxState; exitCode?: number; errorDetail?: string }> {
		const bus = this.spawner.bus!;
		return new Promise((resolve) => {
			let settled = false;
			let unsubscribe: (() => void) | undefined;
			const finish = (state: SandboxState, exitCode?: number, errorDetail?: string) => {
				if (settled) return;
				settled = true;
				unsubscribe?.();
				resolve({ state, exitCode, errorDetail });
			};
			const handle = (event: BusEvent) => {
				if ("category" in event && event.category === "lifecycle" && event.type === "terminal") {
					finish(event.state, event.exit_code, event.error_detail);
					return;
				}
				if (
					"category" in event &&
					event.category === "system" &&
					event.type === "snapshot" &&
					SANDBOX_TERMINAL_STATES.has(event.record.state)
				) {
					finish(event.record.state, event.record.exit_code, event.record.error_detail);
				}
			};
			unsubscribe = bus.subscribe(handle, { sandbox_id: sandboxId });
			// subscribe() delivers a snapshot synchronously. If that snapshot was
			// already terminal, finish() ran before unsubscribe was assigned.
			if (settled) unsubscribe();
		});
	}
}

function recordTerminalMetric(job: InternalStageJob): void {
	internalStageJobsTotal.add(1, {
		stage: job.stage,
		state: job.state,
		model: job.model,
		attempt: job.attempt,
	});
}

function recordPromotionMetrics(job: InternalStageJob, metrics: Record<string, number> | undefined): void {
	if (!metrics) return;
	const attributes = { stage: job.stage, model: job.model, attempt: job.attempt };
	if (Number.isFinite(metrics.wall_seconds)) transcriptionWallSeconds.record(metrics.wall_seconds!, attributes);
	if (Number.isFinite(metrics.rtf)) transcriptionRtf.record(metrics.rtf!, attributes);
	if (Number.isFinite(metrics.peak_rss_bytes)) transcriptionPeakRssBytes.record(metrics.peak_rss_bytes!, attributes);
}
