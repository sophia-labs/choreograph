/**
 * SQLite sandbox registry — tracks every bwrap instance through its lifecycle.
 *
 * Uses node:sqlite DatabaseSync (Node 22+), with the same durable-state
 * pattern used elsewhere in the repo's orchestrator prototypes.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { trace } from "@opentelemetry/api";

const tracer = trace.getTracer("sandbox-mgmt.store");

// ─── Types ──────────────────────────────────────────────────────────────

export type SandboxState = "queued" | "spawning" | "running" | "done" | "truncated" | "error" | "timeout" | "killed";

export interface ResourceConfig {
	memory_max_bytes?: number;
	cpu_quota_us?: number;
	cpu_period_us?: number;
	pids_max?: number;
}

export interface SandboxRecord {
	sandbox_id: string;
	state: SandboxState;
	template: string;
	filesystems?: string[];
	intent?: string;
	owner_user_id?: string;
	auth_method?: string;
	pid?: number;
	cgroup_path?: string;
	exit_code?: number;
	memory_max_bytes?: number;
	cpu_quota_us?: number;
	cpu_period_us?: number;
	pids_max?: number;
	memory_peak_bytes?: number;
	cpu_usage_us?: number;
	queued_at: string;
	spawned_at?: string;
	running_at?: string;
	exited_at?: string;
	error_detail?: string;
}

interface SandboxRow {
	sandbox_id: string;
	state: string;
	template: string;
	filesystems_json: string | null;
	intent: string | null;
	owner_user_id: string | null;
	auth_method: string | null;
	pid: number | null;
	cgroup_path: string | null;
	exit_code: number | null;
	memory_max_bytes: number | null;
	cpu_quota_us: number | null;
	cpu_period_us: number | null;
	pids_max: number | null;
	memory_peak_bytes: number | null;
	cpu_usage_us: number | null;
	queued_at: string;
	spawned_at: string | null;
	running_at: string | null;
	exited_at: string | null;
	error_detail: string | null;
}

// ─── State Machine ──────────────────────────────────────────────────────

const VALID_TRANSITIONS: Record<string, SandboxState[]> = {
	queued: ["spawning", "error", "killed"],
	spawning: ["running", "error"],
	running: ["done", "truncated", "error", "timeout", "killed"],
};

const TERMINAL_STATES: Set<SandboxState> = new Set(["done", "truncated", "error", "timeout", "killed"]);

export const ALL_STATES: ReadonlySet<string> = new Set<string>([
	"queued",
	"spawning",
	"running",
	"done",
	"truncated",
	"error",
	"timeout",
	"killed",
]);

// ─── Store ──────────────────────────────────────────────────────────────

export class SandboxStore {
	private readonly db: DatabaseSync;

	// ─── Cached Prepared Statements ───────────────────────────────────
	private readonly stmtInsertSandbox;
	private readonly stmtGetSandbox;
	private readonly stmtListAll;
	private readonly stmtListByState;
	private readonly stmtInsertTransition;
	private readonly stmtUpdateState;
	private readonly stmtUpdateStateSpawnedAt;
	private readonly stmtUpdateStateRunningAt;
	private readonly stmtUpdateStateExitedAt;
	private readonly stmtUpdatePid;
	private readonly stmtUpdateCgroupPath;
	private readonly stmtUpdateResourceUsage;
	private readonly stmtUpdateExitCode;
	private readonly stmtUpdateErrorDetail;
	// Batch: transition queued→spawning + set cgroup path
	private readonly stmtBatchToSpawning;
	// Batch: set pid + transition spawning→running
	private readonly stmtBatchToRunning;
	private readonly stmtBatchToRunningTransition;
	// Batch: exit (resource usage + exit code + state + timing)
	private readonly stmtBatchExit;

	constructor(databasePath: string) {
		const resolvedPath = resolve(databasePath);
		mkdirSync(dirname(resolvedPath), { recursive: true });
		this.db = new DatabaseSync(resolvedPath);
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			PRAGMA foreign_keys = ON;
			PRAGMA secure_delete = ON;

			CREATE TABLE IF NOT EXISTS sandboxes (
				sandbox_id        TEXT PRIMARY KEY,
				state             TEXT NOT NULL DEFAULT 'queued',
				template          TEXT NOT NULL,
				filesystems_json  TEXT,
				intent            TEXT,
				owner_user_id     TEXT,
				auth_method       TEXT,
				pid               INTEGER,
				cgroup_path       TEXT,
				exit_code         INTEGER,
				memory_max_bytes  INTEGER,
				cpu_quota_us      INTEGER,
				cpu_period_us     INTEGER DEFAULT 100000,
				pids_max          INTEGER,
				memory_peak_bytes INTEGER,
				cpu_usage_us      INTEGER,
				queued_at         TEXT NOT NULL,
				spawned_at        TEXT,
				running_at        TEXT,
				exited_at         TEXT,
				error_detail      TEXT
			);

			CREATE TABLE IF NOT EXISTS state_transitions (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				sandbox_id      TEXT NOT NULL,
				from_state      TEXT NOT NULL,
				to_state        TEXT NOT NULL,
				reason          TEXT,
				transitioned_at TEXT NOT NULL,
				FOREIGN KEY (sandbox_id) REFERENCES sandboxes(sandbox_id)
			);

			CREATE INDEX IF NOT EXISTS idx_sandboxes_state
				ON sandboxes(state);
			CREATE INDEX IF NOT EXISTS idx_transitions_sandbox
				ON state_transitions(sandbox_id);
		`);
		this.ensureSandboxColumns();

		// Cache all prepared statements
		this.stmtInsertSandbox = this.db.prepare(`
			INSERT INTO sandboxes (
				sandbox_id, state, template, filesystems_json, intent,
				owner_user_id, auth_method,
				memory_max_bytes, cpu_quota_us, cpu_period_us, pids_max,
				queued_at
			) VALUES (
				$sandbox_id, 'queued', $template, $filesystems_json, $intent,
				$owner_user_id, $auth_method,
				$memory_max_bytes, $cpu_quota_us, $cpu_period_us, $pids_max,
				$queued_at
			)
		`);

		this.stmtGetSandbox = this.db.prepare(`SELECT * FROM sandboxes WHERE sandbox_id = $sandbox_id`);

		this.stmtListAll = this.db.prepare(`SELECT * FROM sandboxes ORDER BY queued_at DESC`);

		this.stmtListByState = this.db.prepare(`SELECT * FROM sandboxes WHERE state = $state ORDER BY queued_at DESC`);

		this.stmtInsertTransition = this.db.prepare(`
			INSERT INTO state_transitions (sandbox_id, from_state, to_state, reason, transitioned_at)
			VALUES ($sandbox_id, $from_state, $to_state, $reason, $transitioned_at)
		`);

		this.stmtUpdateState = this.db.prepare(`UPDATE sandboxes SET state = $state WHERE sandbox_id = $sandbox_id`);

		this.stmtUpdateStateSpawnedAt = this.db.prepare(
			`UPDATE sandboxes SET state = $state, spawned_at = $ts WHERE sandbox_id = $sandbox_id`,
		);

		this.stmtUpdateStateRunningAt = this.db.prepare(
			`UPDATE sandboxes SET state = $state, running_at = $ts WHERE sandbox_id = $sandbox_id`,
		);

		this.stmtUpdateStateExitedAt = this.db.prepare(
			`UPDATE sandboxes SET state = $state, exited_at = $ts WHERE sandbox_id = $sandbox_id`,
		);

		this.stmtUpdatePid = this.db.prepare(`UPDATE sandboxes SET pid = $pid WHERE sandbox_id = $sandbox_id`);

		this.stmtUpdateCgroupPath = this.db.prepare(
			`UPDATE sandboxes SET cgroup_path = $cgroup_path WHERE sandbox_id = $sandbox_id`,
		);

		this.stmtUpdateResourceUsage = this.db.prepare(`
			UPDATE sandboxes
			SET memory_peak_bytes = COALESCE($memory_peak_bytes, memory_peak_bytes),
			    cpu_usage_us = COALESCE($cpu_usage_us, cpu_usage_us)
			WHERE sandbox_id = $sandbox_id
		`);

		this.stmtUpdateExitCode = this.db.prepare(
			`UPDATE sandboxes SET exit_code = $exit_code WHERE sandbox_id = $sandbox_id`,
		);

		this.stmtUpdateErrorDetail = this.db.prepare(
			`UPDATE sandboxes SET error_detail = $error_detail WHERE sandbox_id = $sandbox_id`,
		);

		// Batch: queued→spawning + cgroup path in one UPDATE
		this.stmtBatchToSpawning = this.db.prepare(`
			UPDATE sandboxes
			SET state = 'spawning', cgroup_path = $cgroup_path, spawned_at = $ts
			WHERE sandbox_id = $sandbox_id AND state = 'queued'
		`);

		// Batch: spawning→running + pid in one UPDATE
		this.stmtBatchToRunning = this.db.prepare(`
			UPDATE sandboxes
			SET state = 'running', pid = $pid, running_at = $ts
			WHERE sandbox_id = $sandbox_id AND state = 'spawning'
		`);

		this.stmtBatchToRunningTransition = this.db.prepare(`
			INSERT INTO state_transitions (sandbox_id, from_state, to_state, reason, transitioned_at)
			VALUES ($sandbox_id, $from_state, $to_state, NULL, $transitioned_at)
		`);

		// Batch: exit (usage + exit_code + state + timing)
		this.stmtBatchExit = this.db.prepare(`
			UPDATE sandboxes
			SET state = $state, exit_code = $exit_code, exited_at = $ts,
			    memory_peak_bytes = COALESCE($memory_peak_bytes, memory_peak_bytes),
			    cpu_usage_us = COALESCE($cpu_usage_us, cpu_usage_us),
			    error_detail = COALESCE($error_detail, error_detail)
			WHERE sandbox_id = $sandbox_id
		`);
	}

	create(
		template: string,
		resources?: ResourceConfig,
		intent?: string,
		ownership?: { ownerUserId?: string; authMethod?: string; filesystems?: string[] },
	): SandboxRecord {
		return tracer.startActiveSpan("store.create", (span) => {
			const sandboxId = randomUUID();
			const now = new Date().toISOString();

			span.setAttributes({
				"sandbox.id": sandboxId,
				"sandbox.template": template,
				"db.system": "sqlite",
			});
			if (ownership?.ownerUserId) {
				span.setAttribute("sandbox.owner_user_id", ownership.ownerUserId);
			}
			if (ownership?.authMethod) {
				span.setAttribute("sandbox.auth_method", ownership.authMethod);
			}
			if (ownership?.filesystems?.length) {
				span.setAttribute("sandbox.filesystem_count", ownership.filesystems.length);
			}

			this.stmtInsertSandbox.run({
				sandbox_id: sandboxId,
				template,
				filesystems_json: serializeStringArray(ownership?.filesystems),
				intent: intent ?? null,
				owner_user_id: ownership?.ownerUserId ?? null,
				auth_method: ownership?.authMethod ?? null,
				memory_max_bytes: resources?.memory_max_bytes ?? null,
				cpu_quota_us: resources?.cpu_quota_us ?? null,
				cpu_period_us: resources?.cpu_period_us ?? 100000,
				pids_max: resources?.pids_max ?? null,
				queued_at: now,
			});

			span.end();
			return this.get(sandboxId)!;
		});
	}

	get(sandboxId: string): SandboxRecord | undefined {
		const row = this.stmtGetSandbox.get({
			sandbox_id: sandboxId,
		}) as unknown as SandboxRow | undefined;

		return row ? deserialize(row) : undefined;
	}

	list(filter?: { state?: SandboxState }): SandboxRecord[] {
		return tracer.startActiveSpan("store.list", (span) => {
			if (filter?.state) {
				span.setAttribute("store.filter.state", filter.state);
			}

			let results: SandboxRecord[];
			if (filter?.state) {
				results = (
					this.stmtListByState.all({
						state: filter.state,
					}) as unknown as SandboxRow[]
				).map(deserialize);
			} else {
				results = (this.stmtListAll.all() as unknown as SandboxRow[]).map(deserialize);
			}

			span.setAttribute("store.result_count", results.length);
			span.end();
			return results;
		});
	}

	transition(sandboxId: string, toState: SandboxState, reason?: string): SandboxRecord {
		return tracer.startActiveSpan("store.transition", (span) => {
			span.setAttributes({
				"sandbox.id": sandboxId,
				"sandbox.state.to": toState,
			});
			if (reason) span.setAttribute("sandbox.transition.reason", reason);

			try {
				const result = this.withTransaction(() => {
					const record = this.get(sandboxId);
					if (!record) throw new Error(`Sandbox not found: ${sandboxId}`);

					span.setAttribute("sandbox.state.from", record.state);

					const allowed = VALID_TRANSITIONS[record.state];
					if (!allowed || !allowed.includes(toState)) {
						throw new Error(`Invalid transition: ${record.state} -> ${toState} for sandbox ${sandboxId}`);
					}

					const now = new Date().toISOString();

					// Record the transition
					this.stmtInsertTransition.run({
						sandbox_id: sandboxId,
						from_state: record.state,
						to_state: toState,
						reason: reason ?? null,
						transitioned_at: now,
					});

					// Update the sandbox state + timing
					const stmt = TERMINAL_STATES.has(toState)
						? this.stmtUpdateStateExitedAt
						: toState === "spawning"
							? this.stmtUpdateStateSpawnedAt
							: toState === "running"
								? this.stmtUpdateStateRunningAt
								: this.stmtUpdateState;

					if (stmt === this.stmtUpdateState) {
						stmt.run({ sandbox_id: sandboxId, state: toState });
					} else {
						stmt.run({ sandbox_id: sandboxId, state: toState, ts: now });
					}

					return this.get(sandboxId)!;
				});

				span.end();
				return result;
			} catch (err) {
				span.recordException(err as Error);
				span.setStatus({ code: 2, message: (err as Error).message }); // SpanStatusCode.ERROR = 2
				span.end();
				throw err;
			}
		});
	}

	/**
	 * Batch: transition queued→spawning + set cgroup path in one transaction.
	 * Replaces: transition("spawning") + updateCgroupPath().
	 */
	transitionToSpawning(sandboxId: string, cgroupPath: string): SandboxRecord {
		return this.withTransaction(() => {
			const now = new Date().toISOString();
			const result = this.stmtBatchToSpawning.run({
				sandbox_id: sandboxId,
				cgroup_path: cgroupPath,
				ts: now,
			});
			if ((result as any).changes === 0) {
				throw new Error(`Cannot transition to spawning: sandbox ${sandboxId} not in queued state`);
			}
			this.stmtBatchToRunningTransition.run({
				sandbox_id: sandboxId,
				from_state: "queued",
				to_state: "spawning",
				transitioned_at: now,
			});
			return this.get(sandboxId)!;
		});
	}

	/**
	 * Batch: transition spawning→running + set PID in one transaction.
	 * Replaces: updatePid() + transition("running").
	 */
	transitionToRunning(sandboxId: string, pid: number): SandboxRecord {
		return this.withTransaction(() => {
			const now = new Date().toISOString();
			const result = this.stmtBatchToRunning.run({
				sandbox_id: sandboxId,
				pid,
				ts: now,
			});
			if ((result as any).changes === 0) {
				throw new Error(`Cannot transition to running: sandbox ${sandboxId} not in spawning state`);
			}
			this.stmtBatchToRunningTransition.run({
				sandbox_id: sandboxId,
				from_state: "spawning",
				to_state: "running",
				transitioned_at: now,
			});
			return this.get(sandboxId)!;
		});
	}

	/**
	 * Batch: transition running→terminal + set exit code, usage, error in one transaction.
	 * Replaces: updateResourceUsage() + updateExitCode() + transition(terminal) + updateErrorDetail().
	 */
	transitionToTerminal(
		sandboxId: string,
		toState: SandboxState,
		opts: {
			exitCode?: number;
			usage?: { memory_peak_bytes?: number; cpu_usage_us?: number };
			reason?: string;
			errorDetail?: string;
		},
	): SandboxRecord {
		return this.withTransaction(() => {
			const record = this.get(sandboxId);
			if (!record) throw new Error(`Sandbox not found: ${sandboxId}`);
			if (record.state !== "running") {
				throw new Error(`Cannot transition to terminal: sandbox ${sandboxId} is ${record.state}, not running`);
			}

			const now = new Date().toISOString();
			this.stmtBatchExit.run({
				sandbox_id: sandboxId,
				state: toState,
				exit_code: opts.exitCode ?? null,
				ts: now,
				memory_peak_bytes: opts.usage?.memory_peak_bytes ?? null,
				cpu_usage_us: opts.usage?.cpu_usage_us ?? null,
				error_detail: opts.errorDetail ?? null,
			});
			this.stmtInsertTransition.run({
				sandbox_id: sandboxId,
				from_state: record.state,
				to_state: toState,
				reason: opts.reason ?? null,
				transitioned_at: now,
			});
			return this.get(sandboxId)!;
		});
	}

	updatePid(sandboxId: string, pid: number): void {
		this.stmtUpdatePid.run({ sandbox_id: sandboxId, pid });
	}

	updateCgroupPath(sandboxId: string, cgroupPath: string): void {
		this.stmtUpdateCgroupPath.run({ sandbox_id: sandboxId, cgroup_path: cgroupPath });
	}

	updateResourceUsage(sandboxId: string, usage: { memory_peak_bytes?: number; cpu_usage_us?: number }): void {
		tracer.startActiveSpan("store.update_resource_usage", (span) => {
			span.setAttribute("sandbox.id", sandboxId);
			if (usage.memory_peak_bytes != null) {
				span.setAttribute("sandbox.resources.memory_peak_bytes", usage.memory_peak_bytes);
			}
			if (usage.cpu_usage_us != null) {
				span.setAttribute("sandbox.resources.cpu_usage_us", usage.cpu_usage_us);
			}

			this.stmtUpdateResourceUsage.run({
				sandbox_id: sandboxId,
				memory_peak_bytes: usage.memory_peak_bytes ?? null,
				cpu_usage_us: usage.cpu_usage_us ?? null,
			});

			span.end();
		});
	}

	updateExitCode(sandboxId: string, exitCode: number): void {
		this.stmtUpdateExitCode.run({ sandbox_id: sandboxId, exit_code: exitCode });
	}

	updateErrorDetail(sandboxId: string, detail: string): void {
		this.stmtUpdateErrorDetail.run({ sandbox_id: sandboxId, error_detail: detail });
	}

	/** Securely erase the registry testimony for an exact set of retired sandboxes. */
	purgeSandboxes(sandboxIds: readonly string[]): number {
		const exact = [...new Set(sandboxIds)];
		if (
			exact.some(
				(sandboxId) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sandboxId),
			)
		) {
			throw new Error("sandbox privacy purge received an invalid sandbox id");
		}
		if (exact.length === 0) return 0;
		let deleted = 0;
		this.withTransaction(() => {
			for (let offset = 0; offset < exact.length; offset += 500) {
				const batch = exact.slice(offset, offset + 500);
				const placeholders = batch.map(() => "?").join(", ");
				this.db.prepare(`DELETE FROM state_transitions WHERE sandbox_id IN (${placeholders})`).run(...batch);
				const result = this.db.prepare(`DELETE FROM sandboxes WHERE sandbox_id IN (${placeholders})`).run(...batch);
				deleted += Number(result.changes);
			}
		});
		this.db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
		return deleted;
	}

	close(): void {
		this.db.close();
	}

	private ensureSandboxColumns(): void {
		const columns = this.db.prepare("PRAGMA table_info(sandboxes)").all() as Array<{ name?: unknown }>;
		const names = new Set(
			columns.map((column) => (typeof column.name === "string" ? column.name : "")).filter(Boolean),
		);
		if (!names.has("owner_user_id")) {
			this.db.exec("ALTER TABLE sandboxes ADD COLUMN owner_user_id TEXT");
		}
		if (!names.has("auth_method")) {
			this.db.exec("ALTER TABLE sandboxes ADD COLUMN auth_method TEXT");
		}
		if (!names.has("filesystems_json")) {
			this.db.exec("ALTER TABLE sandboxes ADD COLUMN filesystems_json TEXT");
		}
	}

	private withTransaction<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}

// ─── Serialization ──────────────────────────────────────────────────────

function deserialize(row: SandboxRow): SandboxRecord {
	return {
		sandbox_id: row.sandbox_id,
		state: row.state as SandboxState,
		template: row.template,
		filesystems: deserializeStringArray(row.filesystems_json),
		intent: row.intent ?? undefined,
		owner_user_id: row.owner_user_id ?? undefined,
		auth_method: row.auth_method ?? undefined,
		pid: row.pid ?? undefined,
		cgroup_path: row.cgroup_path ?? undefined,
		exit_code: row.exit_code ?? undefined,
		memory_max_bytes: row.memory_max_bytes ?? undefined,
		cpu_quota_us: row.cpu_quota_us ?? undefined,
		cpu_period_us: row.cpu_period_us ?? undefined,
		pids_max: row.pids_max ?? undefined,
		memory_peak_bytes: row.memory_peak_bytes ?? undefined,
		cpu_usage_us: row.cpu_usage_us ?? undefined,
		queued_at: row.queued_at,
		spawned_at: row.spawned_at ?? undefined,
		running_at: row.running_at ?? undefined,
		exited_at: row.exited_at ?? undefined,
		error_detail: row.error_detail ?? undefined,
	};
}

function serializeStringArray(values?: readonly string[]): string | null {
	if (!values || values.length === 0) {
		return null;
	}

	return JSON.stringify(Array.from(new Set(values)));
}

function deserializeStringArray(raw: string | null): string[] | undefined {
	if (!raw) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
			return undefined;
		}
		return parsed;
	} catch {
		return undefined;
	}
}
