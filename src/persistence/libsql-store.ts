/**
 * LibsqlStore — the shared serialized-libSQL substrate (L1 persistence
 * primitive). SoR: `sophia-code-lab/cloud2-durable-plane-spec-20260620`.
 *
 * The thesis: **serialization belongs in the SQL layer, once.** Before this
 * substrate there were three different answers to the one-connection question —
 * `with-journal.ts`'s per-run tail (a DIFFERENT concern: causal ordering),
 * billing's bespoke `writeChain`, and `SessionStore`'s bare
 * `transaction("write")` with NO guard at all. This base class makes the
 * connection own its own serial write executor; every concrete store routes its
 * writes through it and stops re-inventing the queue.
 *
 * ── Why one dedicated writer connection + a serial write executor ──────────
 * On `@libsql/client@0.17.3` the embedded `file:` client is ONE `Database`. Two
 * overlapping `transaction("write")` throw `SQLITE_BUSY` *immediately*, and
 * `busy_timeout` does NOT help (it governs OS file locks, not in-process
 * BEGIN-while-BEGIN re-entrancy). A second write *connection* to the same
 * `file:` relocates contention to SQLite's file-scoped writer lock. So:
 *   - ONE dedicated writer connection (`this.writerDb`) per store. Recovery
 *     from a failed BEGIN can replace it without disrupting in-flight reads.
 *   - A serial write executor (`enqueue`, generalized from billing's
 *     `writeChain`): every write/transaction is enqueued onto a single
 *     writer promise-chain → at most one explicit embedded transaction (or
 *     remote `transaction("write")`) is ever in flight → BEGIN-while-BEGIN is
 *     structurally impossible on one connection.
 *   - Independent connections/processes contend at `BEGIN IMMEDIATE`; bounded
 *     asynchronous retry acquires that file-scoped lock without exposing a
 *     transient `SQLITE_BUSY` or blocking the JavaScript event loop.
 *   - The protected `this.db` remains the schema/read connection. READS do NOT
 *     go through the chain. WAL (`journal_mode=WAL`) gives readers a consistent
 *     snapshot concurrent with the open writer. Routing reads through the
 *     chain would serialize them behind writes for no correctness benefit and
 *     tank read latency (the SSE tail polls constantly).
 *
 * ── Hard rule (deadlock avoidance) ─────────────────────────────────────────
 * NEVER call `this.write`/`this.tx` from INSIDE a `tx()` body. Use the passed
 * `tx` handle. An inner enqueue would wait on the outer link that is itself
 * waiting on the inner body → self-deadlock. No current store does this.
 */

import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { type Client, createClient, type InStatement, type ResultSet, type Transaction } from "@libsql/client";

const execFileAsync = promisify(execFile);
const WRITE_LOCK_RETRY_DEADLINE_MS = 2_000;
const WRITE_LOCK_RETRY_INITIAL_MS = 2;
const WRITE_LOCK_RETRY_MAX_MS = 50;

type WriteTransaction = Pick<Transaction, "execute">;

/**
 * The declared write semantics of a capture, aligned with the durable-plane
 * spec's `CaptureEvent.write_mode`. This is DECLARATIVE metadata, not a code
 * path that rewrites SQL (the SQL already encodes the semantics —
 * `ON CONFLICT DO NOTHING`, the guarded `UPDATE … WHERE balance >= :req`). Its
 * jobs: (1) an OTEL span attribute so capture semantics are observable per the
 * L2 contract; (2) the single declared field a future `Capture(CaptureEvent)`
 * L2 facade reads to pick an executor. The L2 envelope lands here without
 * re-touching the stores.
 */
export type WriteMode = "APPEND" | "CAS" | "UPSERT_IF_ABSENT" | "UPSERT";

export interface LibsqlStoreOptions {
	/** S3 prefix for coarse snapshots, e.g. `s3://bucket/journal/`. Unset ⇒ file-only. */
	s3Url?: string;
	/** Filename stem in the snapshot key (`journal`/`sessions`/`billing`). */
	snapshotName: string;
	/** Per-store auth-token env var name (`BILLING_DB_AUTH_TOKEN`, …). */
	authTokenEnv?: string;
	/** Explicit auth token (wins over `authTokenEnv`). */
	authToken?: string;
	/** Override the `aws` binary (tests/CI). */
	awsBin?: string;
}

// ─── URL handling (the one verbatim copy of toLibsqlUrl) ────────────────────
// Accept a bare filesystem path or an explicit libSQL/Turso URL. A bare path
// becomes a `file:` URL.
function toLibsqlUrl(input: string): string {
	if (/^(file|libsql|https?|wss?):/.test(input)) return input;
	return `file:${resolve(input)}`;
}

/** Extract the on-disk path from a `file:` url (null for remote urls). */
function fileUrlToPath(url: string): string | null {
	const m = /^file:(.*)$/.exec(url);
	return m ? m[1] : null;
}

function isSqliteBusy(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" && (code === "SQLITE_BUSY" || code.startsWith("SQLITE_BUSY_"));
}

export abstract class LibsqlStore {
	protected readonly db: Client;
	private readonly writerDb: Client;
	private readonly embeddedFile: boolean;
	/**
	 * Serializes write transactions on the single underlying libSQL connection.
	 * Generalized from billing's `writeChain`. Each link awaits the previous
	 * one's SETTLEMENT (both branches via `then(op, op)`), so one rejection never
	 * poisons the queue for the next; the chain head is reset to a resolved
	 * promise regardless of outcome.
	 */
	private writeChain: Promise<unknown> = Promise.resolve();
	private readonly s3Url?: string;
	private readonly awsBin: string;
	private readonly snapshotName: string;
	private initialized = false;

	protected constructor(urlOrPath: string, opts: LibsqlStoreOptions) {
		const url = toLibsqlUrl(urlOrPath);
		// For `file:` urls, ensure the parent dir exists before the client opens it.
		const path = fileUrlToPath(url);
		if (path) mkdirSync(dirname(path), { recursive: true });
		const clientConfig = {
			url,
			authToken: opts.authToken ?? (opts.authTokenEnv ? process.env[opts.authTokenEnv] : undefined),
		};
		this.db = createClient(clientConfig);
		this.writerDb = createClient(clientConfig);
		this.embeddedFile = path !== null;
		this.s3Url = opts.s3Url?.trim() || undefined;
		this.awsBin = opts.awsBin?.trim() || process.env.AWS_CLI_BIN?.trim() || "aws";
		this.snapshotName = opts.snapshotName;
	}

	/**
	 * Subclasses implement DDL only. The base wraps WAL+synchronous pragmas and
	 * the once-guard around it.
	 */
	protected abstract createSchema(): Promise<void>;

	async init(): Promise<void> {
		if (this.initialized) return;
		await this.db.execute("PRAGMA journal_mode = WAL");
		await this.db.execute("PRAGMA synchronous = NORMAL");
		await this.db.execute("PRAGMA foreign_keys = ON");
		await this.createSchema();
		await this.writerDb.execute("PRAGMA journal_mode = WAL");
		await this.writerDb.execute("PRAGMA synchronous = NORMAL");
		await this.writerDb.execute("PRAGMA foreign_keys = ON");
		this.initialized = true;
	}

	// ── The serial write executor (generalized writeChain) ───────────────────

	/**
	 * Enqueue an op onto the serial write chain. At most one op is in flight at
	 * a time → no two `transaction("write")` BEGINs overlap → zero SQLITE_BUSY.
	 * Poison-proof: a rejected link rejects only its OWN returned promise; the
	 * chain head is reset to a resolved promise on both branches.
	 */
	private enqueue<T>(op: () => Promise<T>): Promise<T> {
		const run = this.writeChain.then(op, op);
		this.writeChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * Single serialized statement. It deliberately uses the same explicit write
	 * transaction as multi-statement mutations so cross-connection lock retry is
	 * pre-statement and therefore never risks replaying an ambiguously applied
	 * autocommit. `mode` is declarative metadata (see `WriteMode`).
	 */
	protected write(stmt: InStatement, _mode?: WriteMode): Promise<ResultSet> {
		return this.enqueue(() => this.runWriteTransaction((tx) => tx.execute(stmt)));
	}

	/**
	 * Multi-statement transaction. The whole BEGIN…COMMIT runs inside one local
	 * `enqueue` link; acquisition retry composes that connection-local ordering
	 * with SQLite's file-scoped writer lock. NEVER call `this.write`/`this.tx`
	 * from inside `body` — use the passed `tx` handle.
	 */
	protected tx<T>(body: (tx: WriteTransaction) => Promise<T>, _mode?: WriteMode): Promise<T> {
		return this.enqueue(() => this.runWriteTransaction(body));
	}

	private async runWriteTransaction<T>(body: (tx: WriteTransaction) => Promise<T>): Promise<T> {
		if (this.embeddedFile) return this.runEmbeddedWriteTransaction(body);
		const tx = await this.acquireWriteTransaction();
		try {
			const out = await body(tx);
			await tx.commit();
			return out;
		} catch (err) {
			await tx.rollback();
			throw err;
		}
	}

	/**
	 * The embedded client's `transaction()` implementation detaches a native
	 * Database per transaction and retains its file/WAL handles until GC after a
	 * prepared statement has executed. Besides leaking descriptors, concurrent
	 * N-API finalization can crash a long-running Node host. A file-backed store
	 * already owns one serialized writer connection, so explicit SQL transaction
	 * control on that persistent connection provides the same BEGIN IMMEDIATE
	 * authority without allocating transaction-owned native databases.
	 */
	private async runEmbeddedWriteTransaction<T>(body: (tx: WriteTransaction) => Promise<T>): Promise<T> {
		await this.retryWriterLock(async () => {
			await this.writerDb.execute("BEGIN IMMEDIATE");
		});
		const tx: WriteTransaction = {
			execute: (stmt) => this.writerDb.execute(stmt),
		};
		try {
			const out = await body(tx);
			await this.writerDb.execute("COMMIT");
			return out;
		} catch (error) {
			try {
				await this.writerDb.execute("ROLLBACK");
			} catch (rollbackError) {
				try {
					// A transient driver failure may leave the SQL transaction live.
					// Retry the idempotent rollback before reconnecting; otherwise the
					// detached embedded Database can retain the writer lock until GC.
					await this.writerDb.execute("ROLLBACK");
					await this.reconnectWriter();
				} catch (recoveryError) {
					throw new AggregateError(
						[error, rollbackError, recoveryError],
						"Embedded libSQL transaction, rollback, and writer recovery all failed",
					);
				}
				throw new AggregateError(
					[error, rollbackError],
					"Embedded libSQL transaction and rollback both failed; writer connection was recovered",
				);
			}
			throw error;
		}
	}

	/**
	 * Acquire SQLite's file-scoped writer lock without blocking the JS event
	 * loop. The per-instance write chain prevents connection re-entrancy, while
	 * BEGIN IMMEDIATE is the authority across independent connections and
	 * processes. Embedded libSQL reports a contended BEGIN as SQLITE_BUSY
	 * immediately; retry that one pre-transaction boundary with bounded jitter.
	 * `busy_timeout` is deliberately avoided because this embedded driver blocks
	 * the JavaScript thread while waiting, which can prevent a same-process
	 * incumbent from reaching COMMIT.
	 * Once BEGIN succeeds, no application statement has run, so retry is safe.
	 * Remote clients use their protocol-owned transaction handle here.
	 */
	private async acquireWriteTransaction(): Promise<Transaction> {
		return this.retryWriterLock(() => this.writerDb.transaction("write"));
	}

	private async retryWriterLock<T>(attempt: () => Promise<T>): Promise<T> {
		const deadline = Date.now() + WRITE_LOCK_RETRY_DEADLINE_MS;
		let delayCapMs = WRITE_LOCK_RETRY_INITIAL_MS;
		for (;;) {
			try {
				return await attempt();
			} catch (error) {
				const remainingMs = deadline - Date.now();
				if (!isSqliteBusy(error) || remainingMs <= 0) throw error;
				// @libsql/client's embedded driver can retain the failed BEGIN's
				// prepared statement on this connection; reusing it may make a later
				// COMMIT fail with "SQL statements in progress". No transaction was
				// acquired, so replacing only this idle connection is safe.
				await this.reconnectWriter();
				const delayMs = Math.min(remainingMs, 1 + Math.floor(Math.random() * delayCapMs));
				await sleep(delayMs);
				delayCapMs = Math.min(delayCapMs * 2, WRITE_LOCK_RETRY_MAX_MS);
			}
		}
	}

	private async reconnectWriter(): Promise<void> {
		await this.writerDb.reconnect();
		await this.writerDb.execute("PRAGMA synchronous = NORMAL");
		await this.writerDb.execute("PRAGMA foreign_keys = ON");
	}

	/** Read — NOT serialized. WAL gives a consistent snapshot concurrent with the open writer. */
	protected read(stmt: InStatement): Promise<ResultSet> {
		return this.db.execute(stmt);
	}

	/**
	 * Produce a clean, WAL-free SQLite snapshot at `destPath` without exposing the
	 * live connection. The VACUUM is routed through the same serial executor as
	 * writes, so the snapshot cannot race an open write transaction. The caller
	 * owns the destination file; an existing file is replaced deliberately.
	 */
	async snapshotToFile(destPath: string): Promise<void> {
		const destination = resolve(destPath);
		mkdirSync(dirname(destination), { recursive: true });
		await unlink(destination).catch(() => {});
		await this.enqueue(() =>
			this.writerDb.execute({
				sql: "VACUUM INTO ?",
				args: [destination],
			}),
		);
	}

	/** Securely compact deleted rows out of the live SQLite file and WAL. */
	async secureVacuum(): Promise<void> {
		// Checkpoint and VACUUM are connection-level maintenance operations and
		// cannot run inside the BEGIN IMMEDIATE envelope used by ordinary writes.
		// Keep the whole maintenance sequence on the serialized writer instead.
		await this.enqueue(async () => {
			await this.writerDb.execute({ sql: "PRAGMA secure_delete = ON", args: [] });
			await this.writerDb.execute({ sql: "PRAGMA wal_checkpoint(TRUNCATE)", args: [] });
			await this.writerDb.execute({ sql: "VACUUM", args: [] });
		});
	}

	// ── Coarse S3 durability (CODE ONLY — INFRA PAUSE) ───────────────────────

	/**
	 * Coarse-snapshot durability: `VACUUM INTO` a temp file, then `aws s3 cp` it
	 * to a versioned prefix. Plain SQLite + AWS CLI — NOT libSQL "bottomless"
	 * (a sqld-server feature absent from the embedded file client). RPO is
	 * point-of-last-snapshot, NOT point-in-time. No-op when `s3Url` is unset
	 * (local/dev stays file-only, never touches the network).
	 *
	 * Key layout `<instanceId>/<date>/<snapshotName>-<stamp>.sqlite` is unchanged
	 * from the per-store originals so restore-on-boot can pick the newest across
	 * instance prefixes.
	 *
	 * INFRA PAUSE — provisioning the bucket + IAM is deferred; do NOT action.
	 * @returns the s3 object URL written, or null when S3 is not configured.
	 */
	async snapshotToS3(opts?: { instanceId?: string; now?: Date }): Promise<string | null> {
		if (!this.s3Url) return null;
		const now = opts?.now ?? new Date();
		const instanceId = opts?.instanceId ?? process.env.EC2_INSTANCE_ID ?? process.env.HOSTNAME ?? "local";
		const stamp = now.toISOString().replace(/[:.]/g, "-");
		const key = `${instanceId}/${now.toISOString().slice(0, 10)}/${this.snapshotName}-${stamp}.sqlite`;
		const dest = `${this.s3Url.replace(/\/+$/, "")}/${key}`;
		const tmpFile = join(tmpdir(), `${this.snapshotName}-snapshot-${stamp}-${process.pid}.sqlite`);
		try {
			// VACUUM INTO yields a clean, WAL-free copy safe to upload while the DB is open.
			await this.snapshotToFile(tmpFile);
			await execFileAsync(this.awsBin, ["s3", "cp", tmpFile, dest]);
			return dest;
		} finally {
			await unlink(tmpFile).catch(() => {});
		}
	}

	/**
	 * Replace every retained S3 snapshot under this store's prefix with one
	 * freshly vacuumed snapshot. This is intentionally destructive and exists
	 * for privacy-epoch retirement: versioned backups must not resurrect rows
	 * that were securely deleted from the live database.
	 */
	async replaceS3SnapshotHistory(): Promise<{ snapshotUrl: string | null; retiredVersions: number }> {
		const snapshotUrl = await this.snapshotToS3();
		if (!snapshotUrl || !this.s3Url) return { snapshotUrl, retiredVersions: 0 };
		const snapshot = parseS3Url(snapshotUrl);
		const prefix = parseS3Url(this.s3Url).key.replace(/\/+$/, "");
		const inventory = await listS3ObjectVersions(this.awsBin, snapshot.bucket, prefix);
		const versions = Array.isArray(inventory.Versions) ? inventory.Versions : [];
		const deleteMarkers = Array.isArray(inventory.DeleteMarkers) ? inventory.DeleteMarkers : [];
		const keep = versions.find(
			(version) =>
				version.Key === snapshot.key &&
				version.IsLatest === true &&
				typeof version.VersionId === "string" &&
				version.VersionId.length > 0,
		);
		if (!keep) throw new Error("fresh privacy-safe S3 snapshot version was not visible after upload");
		const deletions: Array<{ Key: string; VersionId: string }> = [];
		for (const entry of [...versions, ...deleteMarkers]) {
			if (
				typeof entry.Key !== "string" ||
				typeof entry.VersionId !== "string" ||
				(entry.Key === keep.Key && entry.VersionId === keep.VersionId)
			) {
				continue;
			}
			deletions.push({ Key: entry.Key, VersionId: entry.VersionId });
		}
		for (let offset = 0; offset < deletions.length; offset += 500) {
			const objects = deletions.slice(offset, offset + 500);
			const { stdout } = await execFileAsync(this.awsBin, [
				"s3api",
				"delete-objects",
				"--bucket",
				snapshot.bucket,
				"--delete",
				JSON.stringify({ Objects: objects, Quiet: true }),
				"--output",
				"json",
			]);
			const result = JSON.parse(stdout || "{}") as { Errors?: unknown };
			if (Array.isArray(result.Errors) && result.Errors.length > 0) {
				throw new Error("S3 snapshot history retirement reported object deletion failures");
			}
		}
		const remaining = await listS3ObjectVersions(this.awsBin, snapshot.bucket, prefix);
		const remainingVersions = Array.isArray(remaining.Versions) ? remaining.Versions : [];
		const remainingMarkers = Array.isArray(remaining.DeleteMarkers) ? remaining.DeleteMarkers : [];
		if (
			remainingVersions.length !== 1 ||
			remainingMarkers.length !== 0 ||
			remainingVersions[0]?.Key !== keep.Key ||
			remainingVersions[0]?.VersionId !== keep.VersionId
		) {
			throw new Error("S3 snapshot history retirement did not converge to one privacy-safe version");
		}
		return { snapshotUrl, retiredVersions: deletions.length };
	}

	/**
	 * Restore-on-boot: `aws s3 ls` across instance prefixes under `s3Url`, pick
	 * the newest `<snapshotName>-*.sqlite`, `aws s3 cp` it to `destPath`. Static
	 * because it must run BEFORE the constructor opens the file. Returns whether a
	 * file landed.
	 *
	 * INFRA PAUSE — the bucket/IAM are deferred to
	 * `platform-next/terraform/userdata-choreograph.sh`; the orchestrator calls
	 * this explicitly (behind the `*_S3_URL` gate) before `new …Store()`. It is
	 * deliberately NOT called from the constructor (that would surprise tests).
	 */
	static async restoreFromS3(opts: {
		s3Url: string;
		destPath: string;
		snapshotName: string;
		awsBin?: string;
	}): Promise<boolean> {
		const awsBin = opts.awsBin?.trim() || process.env.AWS_CLI_BIN?.trim() || "aws";
		const prefix = `${opts.s3Url.replace(/\/+$/, "")}/`;
		// Recursive listing across all instance/date prefixes under the bucket prefix.
		const { stdout } = await execFileAsync(awsBin, ["s3", "ls", prefix, "--recursive"]);
		// `aws s3 ls --recursive` lines: "<date> <time> <size> <key>" where <key>
		// is relative to the BUCKET root, not the prefix. Pick newest matching key.
		const pat = new RegExp(`${opts.snapshotName}-.*\\.sqlite$`);
		let newest: { key: string; sort: string } | null = null;
		for (const line of stdout.split("\n")) {
			const parts = line.trim().split(/\s+/);
			if (parts.length < 4) continue;
			const key = parts.slice(3).join(" ");
			if (!pat.test(key)) continue;
			const sort = `${parts[0]} ${parts[1]}`; // date+time, lexically sortable
			if (!newest || sort > newest.sort) newest = { key, sort };
		}
		if (!newest) return false;
		// Reconstruct the bucket root from `s3://bucket/...` and join the listed key.
		const m = /^(s3:\/\/[^/]+)\//.exec(prefix);
		const bucketRoot = m ? m[1] : prefix.replace(/\/.*$/, "");
		const src = `${bucketRoot}/${newest.key}`;
		mkdirSync(dirname(resolve(opts.destPath)), { recursive: true });
		await execFileAsync(awsBin, ["s3", "cp", src, opts.destPath]);
		return true;
	}

	close(): void {
		this.db.close();
		this.writerDb.close();
	}
}

function parseS3Url(value: string): { bucket: string; key: string } {
	const match = /^s3:\/\/([^/]+)(?:\/(.*))?$/.exec(value.trim());
	if (!match) throw new Error("snapshot history retirement requires a canonical s3:// URL");
	return { bucket: match[1], key: match[2] ?? "" };
}

async function listS3ObjectVersions(
	awsBin: string,
	bucket: string,
	prefix: string,
): Promise<{
	Versions?: Array<{ Key?: unknown; VersionId?: unknown; IsLatest?: unknown }>;
	DeleteMarkers?: Array<{ Key?: unknown; VersionId?: unknown }>;
}> {
	const { stdout } = await execFileAsync(
		awsBin,
		["s3api", "list-object-versions", "--bucket", bucket, "--prefix", prefix ? `${prefix}/` : "", "--output", "json"],
		{ maxBuffer: 64 * 1024 * 1024 },
	);
	return JSON.parse(stdout || "{}") as {
		Versions?: Array<{ Key?: unknown; VersionId?: unknown; IsLatest?: unknown }>;
		DeleteMarkers?: Array<{ Key?: unknown; VersionId?: unknown }>;
	};
}
