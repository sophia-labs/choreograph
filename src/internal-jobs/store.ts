import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	canonicalJson,
	InternalJobRequestError,
	type InternalStageJob,
	type InternalStageKind,
	type InternalStageState,
	type InternalStageSubmission,
} from "./contracts.js";

interface JobRow {
	job_id: string;
	stage: string;
	state: string;
	input_digest: string;
	input_json: string;
	parameters_json: string;
	current_attempt: number;
	model: string;
	sandbox_id: string | null;
	result_digest: string | null;
	error: string | null;
	created_at: string;
	updated_at: string;
}

const TERMINAL_STATES = new Set<InternalStageState>(["succeeded", "failed_terminal", "cancelled"]);

export class InternalJobStore {
	private readonly db: DatabaseSync;

	constructor(databasePath: string) {
		const resolved = resolve(databasePath);
		mkdirSync(dirname(resolved), { recursive: true });
		this.db = new DatabaseSync(resolved);
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			PRAGMA foreign_keys = ON;

			CREATE TABLE IF NOT EXISTS internal_stage_jobs (
				job_id TEXT NOT NULL,
				stage TEXT NOT NULL,
				state TEXT NOT NULL,
				input_digest TEXT NOT NULL,
				input_json TEXT NOT NULL,
				parameters_json TEXT NOT NULL,
				current_attempt INTEGER NOT NULL,
				model TEXT NOT NULL,
				sandbox_id TEXT,
				result_digest TEXT,
				error TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY(job_id, stage)
			);

			CREATE TABLE IF NOT EXISTS internal_stage_attempts (
				job_id TEXT NOT NULL,
				stage TEXT NOT NULL,
				attempt INTEGER NOT NULL,
				state TEXT NOT NULL,
				model TEXT NOT NULL,
				sandbox_id TEXT,
				result_digest TEXT,
				error TEXT,
				idempotency_key TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY(job_id, stage, attempt),
				UNIQUE(job_id, stage, idempotency_key),
				FOREIGN KEY(job_id, stage) REFERENCES internal_stage_jobs(job_id, stage)
			);

			CREATE INDEX IF NOT EXISTS idx_internal_stage_jobs_state
				ON internal_stage_jobs(state, created_at);
		`);
	}

	close(): void {
		this.db.close();
	}

	createOrGet(submission: InternalStageSubmission, model: string): { job: InternalStageJob; created: boolean } {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.getRow(submission.job_id, submission.stage);
			if (existing) {
				if (
					existing.input_digest !== submission.input_digest ||
					existing.input_json !== canonicalJson(submission.input) ||
					existing.parameters_json !== canonicalJson(submission.parameters)
				) {
					throw new InternalJobRequestError("job_id and stage already exist with different immutable input", 409);
				}
				this.db.exec("COMMIT");
				return { job: rowToJob(existing), created: false };
			}
			const now = new Date().toISOString();
			this.db
				.prepare(`
					INSERT INTO internal_stage_jobs (
						job_id, stage, state, input_digest, input_json, parameters_json,
						current_attempt, model, created_at, updated_at
					) VALUES (?, ?, 'queued', ?, ?, ?, 1, ?, ?, ?)
				`)
				.run(
					submission.job_id,
					submission.stage,
					submission.input_digest,
					canonicalJson(submission.input),
					canonicalJson(submission.parameters),
					model,
					now,
					now,
				);
			this.db
				.prepare(`
					INSERT INTO internal_stage_attempts (
						job_id, stage, attempt, state, model, created_at, updated_at
					) VALUES (?, ?, 1, 'queued', ?, ?, ?)
				`)
				.run(submission.job_id, submission.stage, model, now, now);
			const created = this.getRow(submission.job_id, submission.stage);
			this.db.exec("COMMIT");
			return { job: rowToJob(created!), created: true };
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	get(jobId: string, stage: InternalStageKind): InternalStageJob | undefined {
		const row = this.getRow(jobId, stage);
		return row ? rowToJob(row) : undefined;
	}

	getRetryReplay(jobId: string, stage: InternalStageKind, idempotencyKey: string): InternalStageJob | undefined {
		const replay = this.db
			.prepare(`
				SELECT attempt FROM internal_stage_attempts
				WHERE job_id = ? AND stage = ? AND idempotency_key = ?
			`)
			.get(jobId, stage, idempotencyKey) as { attempt?: number } | undefined;
		return replay ? this.get(jobId, stage) : undefined;
	}

	list(states?: readonly InternalStageState[]): InternalStageJob[] {
		const rows =
			states && states.length > 0
				? (this.db
						.prepare(
							`SELECT * FROM internal_stage_jobs
							 WHERE state IN (${states.map(() => "?").join(",")})
							 ORDER BY created_at`,
						)
						.all(...states) as unknown as JobRow[])
				: (this.db.prepare("SELECT * FROM internal_stage_jobs ORDER BY created_at").all() as unknown as JobRow[]);
		return rows.map(rowToJob);
	}

	claimNextQueued(): InternalStageJob | undefined {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.db
				.prepare("SELECT * FROM internal_stage_jobs WHERE state = 'queued' ORDER BY created_at LIMIT 1")
				.get() as unknown as JobRow | undefined;
			if (!row) {
				this.db.exec("COMMIT");
				return undefined;
			}
			const now = new Date().toISOString();
			this.db
				.prepare(`
					UPDATE internal_stage_jobs
					SET state = 'running', error = NULL, updated_at = ?
					WHERE job_id = ? AND stage = ? AND state = 'queued'
				`)
				.run(now, row.job_id, row.stage);
			this.db
				.prepare(`
					UPDATE internal_stage_attempts SET state = 'running', error = NULL, updated_at = ?
					WHERE job_id = ? AND stage = ? AND attempt = ?
				`)
				.run(now, row.job_id, row.stage, row.current_attempt);
			const claimed = this.getRow(row.job_id, row.stage as InternalStageKind);
			this.db.exec("COMMIT");
			return rowToJob(claimed!);
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	attachSandbox(job: InternalStageJob, sandboxId: string): InternalStageJob {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const now = new Date().toISOString();
			this.db
				.prepare(`
					UPDATE internal_stage_jobs SET sandbox_id = ?, updated_at = ?
					WHERE job_id = ? AND stage = ? AND current_attempt = ? AND state = 'running'
				`)
				.run(sandboxId, now, job.job_id, job.stage, job.attempt);
			this.db
				.prepare(`
					UPDATE internal_stage_attempts SET sandbox_id = ?, updated_at = ?
					WHERE job_id = ? AND stage = ? AND attempt = ? AND state = 'running'
				`)
				.run(sandboxId, now, job.job_id, job.stage, job.attempt);
			const attached = this.require(job.job_id, job.stage);
			this.db.exec("COMMIT");
			return attached;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	finish(
		job: InternalStageJob,
		state: Extract<InternalStageState, "succeeded" | "failed_retryable" | "failed_terminal">,
		options?: { resultDigest?: string; error?: string },
	): InternalStageJob {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const now = new Date().toISOString();
			const error = options?.error?.replaceAll("\n", " ").slice(0, 1000);
			this.db
				.prepare(`
					UPDATE internal_stage_jobs
					SET state = ?, result_digest = ?, error = ?, updated_at = ?
					WHERE job_id = ? AND stage = ? AND current_attempt = ? AND state = 'running'
				`)
				.run(state, options?.resultDigest ?? null, error ?? null, now, job.job_id, job.stage, job.attempt);
			this.db
				.prepare(`
					UPDATE internal_stage_attempts
					SET state = ?, result_digest = ?, error = ?, updated_at = ?
					WHERE job_id = ? AND stage = ? AND attempt = ? AND state = 'running'
				`)
				.run(state, options?.resultDigest ?? null, error ?? null, now, job.job_id, job.stage, job.attempt);
			const finished = this.require(job.job_id, job.stage);
			this.db.exec("COMMIT");
			return finished;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	retry(
		jobId: string,
		stage: InternalStageKind,
		expectedAttempt: number,
		idempotencyKey: string,
		model: string,
		maxAttempts: number,
	): InternalStageJob {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const replay = this.db
				.prepare(`
					SELECT attempt FROM internal_stage_attempts
					WHERE job_id = ? AND stage = ? AND idempotency_key = ?
				`)
				.get(jobId, stage, idempotencyKey) as { attempt?: number } | undefined;
			if (replay) {
				const current = this.require(jobId, stage);
				this.db.exec("COMMIT");
				return current;
			}
			const current = this.require(jobId, stage);
			if (current.state !== "failed_retryable") {
				throw new InternalJobRequestError(`stage is ${current.state}, not failed_retryable`, 409);
			}
			if (current.attempt !== expectedAttempt) {
				throw new InternalJobRequestError(
					`expected_attempt ${expectedAttempt} does not match current attempt ${current.attempt}`,
					409,
				);
			}
			const nextAttempt = current.attempt + 1;
			if (nextAttempt > maxAttempts) {
				throw new InternalJobRequestError(`stage has exhausted its ${maxAttempts} attempts`, 409);
			}
			const now = new Date().toISOString();
			this.db
				.prepare(`
					INSERT INTO internal_stage_attempts (
						job_id, stage, attempt, state, model, idempotency_key, created_at, updated_at
					) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)
				`)
				.run(jobId, stage, nextAttempt, model, idempotencyKey, now, now);
			this.db
				.prepare(`
					UPDATE internal_stage_jobs
					SET state = 'queued', current_attempt = ?, model = ?, sandbox_id = NULL,
						result_digest = NULL, error = NULL, updated_at = ?
					WHERE job_id = ? AND stage = ?
				`)
				.run(nextAttempt, model, now, jobId, stage);
			const retried = this.require(jobId, stage);
			this.db.exec("COMMIT");
			return retried;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	cancel(jobId: string, stage: InternalStageKind): InternalStageJob {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const current = this.require(jobId, stage);
			if (TERMINAL_STATES.has(current.state)) {
				this.db.exec("COMMIT");
				return current;
			}
			const now = new Date().toISOString();
			this.db
				.prepare(`
					UPDATE internal_stage_jobs SET state = 'cancelled', error = NULL, updated_at = ?
					WHERE job_id = ? AND stage = ? AND state IN ('queued', 'running', 'failed_retryable')
				`)
				.run(now, jobId, stage);
			this.db
				.prepare(`
					UPDATE internal_stage_attempts SET state = 'cancelled', error = NULL, updated_at = ?
					WHERE job_id = ? AND stage = ? AND attempt = ?
						AND state IN ('queued', 'running', 'failed_retryable')
				`)
				.run(now, jobId, stage, current.attempt);
			const cancelled = this.require(jobId, stage);
			this.db.exec("COMMIT");
			return cancelled;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	recoverRunning(stage: InternalStageKind, maxAttempts: number): InternalStageJob[] {
		const running = this.list(["running"]).filter((job) => job.stage === stage);
		for (const job of running) {
			this.finish(job, job.attempt < maxAttempts ? "failed_retryable" : "failed_terminal", {
				error: "Choreograph restarted while the stage sandbox was running",
			});
		}
		return running.map((job) => this.require(job.job_id, job.stage));
	}

	private require(jobId: string, stage: InternalStageKind): InternalStageJob {
		const job = this.get(jobId, stage);
		if (!job) {
			throw new InternalJobRequestError("stage job not found", 404);
		}
		return job;
	}

	private getRow(jobId: string, stage: InternalStageKind): JobRow | undefined {
		return this.db
			.prepare("SELECT * FROM internal_stage_jobs WHERE job_id = ? AND stage = ?")
			.get(jobId, stage) as unknown as JobRow | undefined;
	}
}

function rowToJob(row: JobRow): InternalStageJob {
	return {
		job_id: row.job_id,
		stage: row.stage as InternalStageKind,
		state: row.state as InternalStageState,
		input_digest: row.input_digest,
		input: JSON.parse(row.input_json) as Record<string, unknown>,
		parameters: JSON.parse(row.parameters_json) as Record<string, unknown>,
		attempt: row.current_attempt,
		model: row.model,
		sandbox_id: row.sandbox_id ?? undefined,
		result_digest: row.result_digest ?? undefined,
		error: row.error ?? undefined,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}
