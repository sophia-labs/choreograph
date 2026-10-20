/**
 * JournalStore — the event-sourced run journal, the SOURCE OF TRUTH for a
 * workflow run. Built on the embedded `@libsql/client` file client (plain
 * SQLite on disk; the future swap to a `libsql://` sqld URL is a one-line
 * client-config change). The `wf:` triples in the Mnemosyne graph are a
 * re-projectable FOLD of this journal — see `projection.ts`.
 *
 * DSL-AGNOSTIC substrate: `run_events.type` records execution-lifecycle facts
 * (the FROZEN 8-value enum below), NOT workflow-model constructs. This store
 * never mints a `wf:` triple.
 *
 * ── Async ordinal/seq assignment ──────────────────────────────────────────
 * Both this store and `SessionStore` use `@libsql/client` (async-first: `await
 * db.execute`), so the node:sqlite `DatabaseSync` single-event-loop-turn
 * atomicity no longer applies — a read-then-write straddling an `await` is NOT
 * atomic on its own. Two valid fixes: (a) a SINGLE atomic statement, used here
 * for `seq` (`INSERT … SELECT COALESCE(MAX(seq),-1)+1 … WHERE run_id=? RETURNING
 * seq`); or (b) hold the write lock across the read+write inside one
 * `transaction("write")` (BEGIN IMMEDIATE), used by `SessionStore.appendMessages`
 * for `ordinal`. The constructor cannot run CREATE TABLE synchronously, so tables
 * are created in `async init()`, which MUST be awaited before the store is
 * threaded into AppContext.
 *
 * ── Isolation ─────────────────────────────────────────────────────────────
 * The handle lives ONLY on the orchestrator side of the stdio wall (same side
 * as the API key). Workers are `--unshare-all` and never receive a handle.
 */

import type { Row } from "@libsql/client";
import { LibsqlStore } from "../persistence/libsql-store.js";
import type { RunMeta, RunTelemetryEmitter } from "./run-telemetry.js";
import type { RunRecord } from "./types.js";

// ─── Event vocabulary ────────────────────────────────────────────────────────

/**
 * Run-event enum (v1.1). Core 8 values are EXECUTION facts, not workflow
 * constructs — do NOT add wf: model values here. (`token_usage` is the terminal
 * SpawnResult rollup, NOT a mid-node incremental stream.)
 *
 * v1.1 additions:
 *   `phase_entered` / `phase_exited` — emitted by the interpreter's `phase()`
 *     shim; payload carries `{ phaseIndex, phaseTitle }`.
 *   `log` — emitted by the interpreter's `log()` shim; payload carries `{ msg }`.
 * These travel through the same per-run serial writer as node events and are
 * projected onto Contract A `phase.entered` / `phase.exited` / `log` on the
 * SSE wire. They do NOT affect the wf: RDF fold (provenance.ts ignores them).
 */
export type RunEventType =
	| "run_started"
	| "node_queued"
	| "node_started"
	| "tool_call"
	// 2026-10-20: a tool call's outcome, `{ gate, isError }` (never its result). Journals before this have none.
	| "tool_result"
	| "token_usage"
	| "node_done"
	| "run_done"
	| "error"
	// v1.1 — interpreter-level phase / log promotion
	| "phase_entered"
	| "phase_exited"
	| "log";

/** Run-header status: the RunRecord union plus the in-flight `running` state. */
export type RunStatus = RunRecord["status"] | "running";

// ─── Row shapes ─────────────────────────────────────────────────────────────

export interface RunHeader {
	run_id: string;
	workflow_name: string;
	graph_id: string;
	owner_user_id: string;
	status: RunStatus;
	started_at: number;
	ended_at: number | null;
	duration_ms: number | null;
	agent_count: number | null;
	total_tokens: number | null;
	synthesis_doc_id: string | null;
	/** JSON escape valve — arbitrary header-level facts. */
	payload: unknown;
}

export interface RunEvent {
	run_id: string;
	seq: number;
	ts: number;
	type: RunEventType;
	sandbox_id: string | null;
	label: string | null;
	phase_index: number | null;
	/** JSON escape valve — the event-specific payload. */
	payload: unknown;
}

/** What a caller hands to `createRun`. */
export interface CreateRunInput {
	run_id: string;
	workflow_name: string;
	graph_id: string;
	owner_user_id: string;
	started_at: number;
	status?: RunStatus;
	payload?: unknown;
}

/** What a caller hands to `appendEvent` (seq + run_id are assigned/provided here). */
export interface AppendEventInput {
	type: RunEventType;
	ts?: number;
	sandbox_id?: string | null;
	label?: string | null;
	phase_index?: number | null;
	payload?: unknown;
}

/** What a caller hands to `finishRun`. */
export interface FinishRunInput {
	status: RunStatus;
	ended_at: number;
	duration_ms: number;
	agent_count: number;
	total_tokens: number;
	synthesis_doc_id?: string | null;
}

export interface JournalStoreOptions {
	/**
	 * S3 destination prefix for coarse snapshots, e.g. `s3://bucket/journal/`.
	 * When unset the store is FILE-ONLY and never touches the network. See
	 * `snapshotToS3`.
	 *
	 * INFRA PAUSE: provisioning the bucket + IAM (s3:PutObject/GetObject on the
	 * prefix) is deferred — do NOT provision or deploy. See `snapshotToS3`.
	 */
	s3Url?: string;
	/** Override for the `aws` CLI binary (tests/CI). */
	awsBin?: string;
}

// ─── Store ──────────────────────────────────────────────────────────────────

export class JournalStore extends LibsqlStore {
	/**
	 * Optional live-tail fan-out point (Contract A producer). When set,
	 * `appendEvent` calls `emitter.notify()` after each successful INSERT so SSE
	 * consumers receive events without polling. Set once at startup via
	 * `setTelemetryEmitter()`; never replaced.
	 */
	private telemetryEmitter?: RunTelemetryEmitter;
	/**
	 * Minimal per-run metadata cache so `appendEvent` can decorate events with
	 * `workflowName` for the telemetry wire without an extra DB round-trip.
	 * Populated by `createRun`; cleared by `close`.
	 */
	private readonly runMeta = new Map<string, RunMeta>();

	constructor(databasePath: string, options?: JournalStoreOptions) {
		// The base ctor ensures the parent dir exists and opens the file client.
		// (restoreFromS3 would pull the file BEFORE construction — orchestrator-gated.)
		super(databasePath, {
			snapshotName: "journal",
			s3Url: options?.s3Url ?? process.env.WORKFLOW_JOURNAL_S3_URL,
			awsBin: options?.awsBin,
		});
	}

	/**
	 * Create the tables. WAL/synchronous pragmas + the once-guard are applied by
	 * the base `init()`; this only declares the DDL.
	 */
	protected async createSchema(): Promise<void> {
		await this.db.execute(`
			CREATE TABLE IF NOT EXISTS workflow_runs (
				run_id           TEXT PRIMARY KEY,
				workflow_name    TEXT NOT NULL,
				graph_id         TEXT NOT NULL,
				owner_user_id    TEXT NOT NULL,
				status           TEXT NOT NULL,
				started_at       INTEGER NOT NULL,
				ended_at         INTEGER,
				duration_ms      INTEGER,
				agent_count      INTEGER,
				total_tokens     INTEGER,
				synthesis_doc_id TEXT,
				payload          TEXT
			)
		`);
		await this.db.execute(`
			CREATE TABLE IF NOT EXISTS run_events (
				run_id      TEXT NOT NULL,
				seq         INTEGER NOT NULL,
				ts          INTEGER NOT NULL,
				type        TEXT NOT NULL,
				sandbox_id  TEXT,
				label       TEXT,
				phase_index INTEGER,
				payload     TEXT,
				PRIMARY KEY (run_id, seq)
			)
		`);
	}

	// ─── Telemetry emitter (Contract A producer hook) ────────────────────────

	/**
	 * Wire the live-tail fan-out point. Called once at startup after the emitter
	 * is created; subsequent calls are ignored (idempotent for safety).
	 */
	setTelemetryEmitter(emitter: RunTelemetryEmitter): void {
		if (!this.telemetryEmitter) {
			this.telemetryEmitter = emitter;
		}
	}

	// ─── Run header ──────────────────────────────────────────────────────────

	async createRun(input: CreateRunInput): Promise<void> {
		await this.write(
			{
				sql: `
				INSERT INTO workflow_runs
					(run_id, workflow_name, graph_id, owner_user_id, status, started_at, payload)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`,
				args: [
					input.run_id,
					input.workflow_name,
					input.graph_id,
					input.owner_user_id,
					input.status ?? "running",
					input.started_at,
					input.payload === undefined ? null : JSON.stringify(input.payload),
				],
			},
			"APPEND",
		);
		// Cache the minimal metadata for telemetry decoration (no extra SELECT
		// inside appendEvent's hot path).
		this.runMeta.set(input.run_id, {
			runId: input.run_id,
			workflowName: input.workflow_name,
		});
	}

	async finishRun(runId: string, input: FinishRunInput): Promise<void> {
		await this.write(
			{
				sql: `
				UPDATE workflow_runs
				   SET status = ?, ended_at = ?, duration_ms = ?, agent_count = ?,
				       total_tokens = ?, synthesis_doc_id = ?
				 WHERE run_id = ?
			`,
				args: [
					input.status,
					input.ended_at,
					input.duration_ms,
					input.agent_count,
					input.total_tokens,
					input.synthesis_doc_id ?? null,
					runId,
				],
			},
			"UPSERT",
		);
	}

	// ─── Event append (ATOMIC seq) ───────────────────────────────────────────

	/**
	 * Append an event, assigning `seq` with a SINGLE atomic statement —
	 * `INSERT … SELECT COALESCE(MAX(seq),-1)+1 … WHERE run_id=? RETURNING seq`.
	 * This is the load-bearing invariant: it is race-free under concurrent
	 * async appends BECAUSE the max-read and the insert happen in one statement,
	 * NOT across an `await`. Returns the assigned seq.
	 */
	async appendEvent(runId: string, event: AppendEventInput): Promise<number> {
		const ts = event.ts ?? Date.now();
		// SINGLE atomic seq-assigning INSERT (unchanged) — now routed through the
		// serialized write() so it can never overlap a tx() on the same connection
		// (the bonus SQLITE_BUSY-proofing the substrate adds). The atomic-seq
		// invariant is intrinsic to the statement and independent of the chain.
		const result = await this.write(
			{
				sql: `
				INSERT INTO run_events (run_id, seq, ts, type, sandbox_id, label, phase_index, payload)
				SELECT ?, COALESCE(MAX(seq), -1) + 1, ?, ?, ?, ?, ?, ?
				  FROM run_events
				 WHERE run_id = ?
				RETURNING seq
			`,
				args: [
					runId,
					ts,
					event.type,
					event.sandbox_id ?? null,
					event.label ?? null,
					event.phase_index ?? null,
					event.payload === undefined ? null : JSON.stringify(event.payload),
					runId,
				],
			},
			"APPEND",
		);
		const seq = result.rows[0]?.seq;
		if (typeof seq !== "number") {
			throw new Error(`appendEvent: expected a numeric seq, got ${String(seq)}`);
		}

		// ── Contract A live-tail notification ────────────────────────────────
		// Notify the telemetry emitter synchronously AFTER the atomic INSERT so
		// SSE consumers see events in journal order. Non-fatal: a broken handler
		// must not corrupt the run.
		if (this.telemetryEmitter) {
			const meta = this.runMeta.get(runId);
			if (meta) {
				const emitted: RunEvent = {
					run_id: runId,
					seq,
					ts,
					type: event.type,
					sandbox_id: event.sandbox_id ?? null,
					label: event.label ?? null,
					phase_index: event.phase_index ?? null,
					// Payload was already JSON-serialised into the DB; carry it as-is.
					payload: event.payload,
				};
				try {
					this.telemetryEmitter.notify(meta, emitted);
				} catch (err) {
					console.error(
						`[journal] telemetry notify failed for ${runId} seq=${seq}: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				}
			}
		}

		return seq;
	}

	// ─── Reads ───────────────────────────────────────────────────────────────

	async readRun(runId: string): Promise<{ header: RunHeader | null; events: RunEvent[] }> {
		const header = await this.readHeader(runId);
		const events = await this.listEvents(runId);
		return { header, events };
	}

	async readHeader(runId: string): Promise<RunHeader | null> {
		const result = await this.read({
			sql: "SELECT * FROM workflow_runs WHERE run_id = ?",
			args: [runId],
		});
		const row = result.rows[0];
		if (!row) {
			return null;
		}
		return rowToHeader(row);
	}

	async listEvents(runId: string): Promise<RunEvent[]> {
		const result = await this.read({
			sql: "SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC",
			args: [runId],
		});
		return result.rows.map(rowToRunEvent);
	}

	/**
	 * Return all events for a run with `seq >= since`, ordered by seq ASC.
	 * Pass `since = 0` (or omit) to get all events. This is the replay-by-seq
	 * primitive for the Contract A poll-since-seq endpoint
	 * (`GET /api/workflows/runs/:runId/events?since=N`) — INCLUSIVE of `since`.
	 */
	async listEventsSince(runId: string, since: number): Promise<RunEvent[]> {
		const result = await this.read({
			sql: "SELECT * FROM run_events WHERE run_id = ? AND seq >= ? ORDER BY seq ASC",
			args: [runId, since],
		});
		return result.rows.map(rowToRunEvent);
	}

	/**
	 * Events for a run with `seq > sinceSeq`, in seq order — the EXCLUSIVE-cursor
	 * primitive for the per-run SSE tail (run-endpoints.ts `startRunSseStream`):
	 * pass the last delivered seq to get only what is new (the loop advances
	 * `cursor = e.seq` each tick, so exclusivity is what prevents re-emission).
	 * `sinceSeq = -1` returns the whole log (first seq is 0).
	 *
	 * NB: deliberately distinct from `listEventsSince` (INCLUSIVE `seq >= since`,
	 * the Contract-A replay primitive). The two cursor semantics are both
	 * load-bearing — see the respective test suites.
	 */
	async listEventsAfter(runId: string, sinceSeq: number): Promise<RunEvent[]> {
		const result = await this.read({
			sql: "SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC",
			args: [runId, sinceSeq],
		});
		return result.rows.map(rowToRunEvent);
	}

	/**
	 * Run headers for the run-list endpoint, newest-first by `started_at`. Scoped
	 * to one owner (ownership is enforced here, not at the HTTP edge); optional
	 * `status` and `since` (started_at >= ms) filters; `limit` caps the page.
	 */
	async listRuns(opts: {
		ownerUserId: string;
		graphId?: string;
		since?: number;
		status?: RunStatus;
		limit: number;
	}): Promise<RunHeader[]> {
		const clauses = ["owner_user_id = ?"];
		const args: (string | number)[] = [opts.ownerUserId];
		if (opts.graphId !== undefined) {
			clauses.push("graph_id = ?");
			args.push(opts.graphId);
		}
		if (opts.status !== undefined) {
			clauses.push("status = ?");
			args.push(opts.status);
		}
		if (opts.since !== undefined) {
			clauses.push("started_at >= ?");
			args.push(opts.since);
		}
		args.push(opts.limit);
		const result = await this.read({
			sql: `SELECT * FROM workflow_runs WHERE ${clauses.join(" AND ")} ORDER BY started_at DESC LIMIT ?`,
			args,
		});
		return result.rows.map(rowToHeader);
	}

	/**
	 * Graph-wide run headers for a caller that has already crossed a trusted
	 * graph-ACL boundary (currently the platform-next internal-service proxy).
	 * Never expose this through a direct bearer route: unlike `listRuns`, it is
	 * deliberately not owner-scoped.
	 */
	async listRunsForTrustedGraph(opts: { graphId: string; graphOwner?: string; limit: number }): Promise<RunHeader[]> {
		const clauses = ["graph_id = ?"];
		const args: (string | number)[] = [opts.graphId];
		if (opts.graphOwner !== undefined) {
			clauses.push("json_extract(payload, '$.graphOwner') = ?");
			args.push(opts.graphOwner);
		}
		args.push(opts.limit);
		const result = await this.read({
			sql: `SELECT * FROM workflow_runs WHERE ${clauses.join(" AND ")} ORDER BY started_at DESC LIMIT ?`,
			args,
		});
		return result.rows.map(rowToHeader);
	}

	async listScopedRunIds(opts: { workflowName: string; graphId: string; ownerUserId: string }): Promise<string[]> {
		const result = await this.read({
			sql: `SELECT run_id FROM workflow_runs
				WHERE workflow_name = ? AND graph_id = ? AND owner_user_id = ?
				ORDER BY started_at`,
			args: [opts.workflowName, opts.graphId, opts.ownerUserId],
		});
		return result.rows.map((row) => String(row.run_id));
	}

	async purgeRuns(runIds: readonly string[]): Promise<number> {
		const exact = [...new Set(runIds)];
		if (exact.length === 0) return 0;
		if (exact.some((runId) => !/^wfr-[A-Za-z0-9-]+$/.test(runId))) {
			throw new Error("journal privacy purge received an invalid run id");
		}
		const placeholders = Array.from({ length: exact.length }, () => "?").join(", ");
		return this.tx(async (tx) => {
			await tx.execute({
				sql: `DELETE FROM run_events WHERE run_id IN (${placeholders})`,
				args: exact,
			});
			const deleted = await tx.execute({
				sql: `DELETE FROM workflow_runs WHERE run_id IN (${placeholders})`,
				args: exact,
			});
			for (const runId of exact) this.runMeta.delete(runId);
			return deleted.rowsAffected;
		}, "UPSERT");
	}

	// snapshotToS3 / restoreFromS3 / close are inherited from LibsqlStore.
	// The key layout (snapshotName="journal") + INFRA-PAUSE gating are unchanged;
	// the journal additionally KEEPS its per-run ordering via with-journal's tail
	// (orthogonal to connection serialization) and now GAINS SQLITE_BUSY-proofing.
}

function rowToHeader(row: Row): RunHeader {
	return {
		run_id: String(row.run_id),
		workflow_name: String(row.workflow_name),
		graph_id: String(row.graph_id),
		owner_user_id: String(row.owner_user_id),
		status: String(row.status) as RunStatus,
		started_at: Number(row.started_at),
		ended_at: row.ended_at == null ? null : Number(row.ended_at),
		duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
		agent_count: row.agent_count == null ? null : Number(row.agent_count),
		total_tokens: row.total_tokens == null ? null : Number(row.total_tokens),
		synthesis_doc_id: row.synthesis_doc_id == null ? null : String(row.synthesis_doc_id),
		payload: parseJson(row.payload),
	};
}

function rowToRunEvent(row: Row): RunEvent {
	return {
		run_id: String(row.run_id),
		seq: Number(row.seq),
		ts: Number(row.ts),
		type: String(row.type) as RunEventType,
		sandbox_id: row.sandbox_id == null ? null : String(row.sandbox_id),
		label: row.label == null ? null : String(row.label),
		phase_index: row.phase_index == null ? null : Number(row.phase_index),
		payload: parseJson(row.payload),
	};
}

function parseJson(value: unknown): unknown {
	if (typeof value !== "string" || value.length === 0) {
		return undefined;
	}
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}
