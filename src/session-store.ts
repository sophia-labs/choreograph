/**
 * libSQL/Turso session + message persistence for the Choreograph chat backend.
 *
 * A session spans multiple sandbox lifetimes. Each user message spawns a
 * sandbox with the full message history re-injected; on exit the new
 * messages are captured from SpawnResult and persisted here.
 *
 * Storage is Pi-native: `messages.content_json` holds Pi content blocks, which
 * the GET /messages endpoint returns verbatim and the Garden frontend's
 * pi-adapter renders. Engine is `@libsql/client` (same as the run journal), so
 * the same on-disk file works with `file:` today and a hosted `libsql://` sqld
 * URL later with no schema change — and one snapshot/restore path covers both
 * the journal and this store. Construction is sync; `init()` must be awaited
 * before first use (the async client cannot create tables in the constructor).
 *
 * One-time import of legacy opencode-serve conversations →
 * scripts/migrate-opencode-conversations.ts (opencode message-v2 → Pi blocks).
 */

import { randomUUID } from "node:crypto";
import { trace } from "@opentelemetry/api";
import { LibsqlStore } from "./persistence/libsql-store.js";

const tracer = trace.getTracer("sandbox-mgmt.sessions");

// ─── Types ──────────────────────────────────────────────────────────────

export interface SessionRecord {
	session_id: string;
	user_id: string;
	title: string | null;
	model: string | null;
	/**
	 * Per-session inference provider (CA-1 shared substrate). Nullable; the
	 * `session` precedence layer of the binding fold. Unset ⇒ the env-default is
	 * used downstream, byte-identical to before.
	 */
	provider: string | null;
	graph_id: string | null;
	/**
	 * Session-lifetime Mnemosyne write lock. `0` ⇒ every sandbox this session
	 * spawns gets `capabilities.writes=false` (the read-only gate in
	 * wrapMnemosyneProxy). `null`/`1` ⇒ writes enabled (default, byte-identical
	 * to before the column existed). Create-time only — there is deliberately no
	 * PATCH path, so a read-only session can never be promoted after birth.
	 */
	mnemosyne_writes: number | null;
	created_at: string;
	updated_at: string;
}

export interface MessageRecord {
	message_id: string;
	session_id: string;
	ordinal: number;
	role: "user" | "assistant" | "toolResult";
	content_json: string;
	usage_json: string | null;
	stop_reason: string | null;
	model: string | null;
	timestamp: number;
}

export interface AppendedUserMessage {
	ordinal: number;
	turnIndex: number;
}

// ─── Store ──────────────────────────────────────────────────────────────

export class SessionStore extends LibsqlStore {
	constructor(databaseUrlOrPath: string, authToken?: string) {
		super(databaseUrlOrPath, {
			snapshotName: "sessions",
			authToken,
			authTokenEnv: "CHAT_DB_AUTH_TOKEN",
			// Coarse S3 durability (mirrors the run journal). Snapshots to CHAT_DB_S3_URL —
			// the SAME journal bucket under a `sessions/` prefix, so the instance-role IAM
			// already covers it. Unset ⇒ snapshotToS3 is a no-op (local/dev stays file-only).
			s3Url: process.env.CHAT_DB_S3_URL,
		});
	}

	/**
	 * Create tables/indexes. WAL/synchronous pragmas + the once-guard are applied
	 * by the base `init()` — this FIXES SessionStore's prior divergence (it alone
	 * ran the default rollback-journal mode); schema-identical, functionally an
	 * improvement. `db.batch(..., "write")` stays — it is pre-traffic DDL.
	 */
	protected async createSchema(): Promise<void> {
		await this.db.batch(
			[
				`CREATE TABLE IF NOT EXISTS sessions (
					session_id       TEXT PRIMARY KEY,
					user_id          TEXT NOT NULL,
					title            TEXT,
					model            TEXT,
					provider         TEXT,
					graph_id         TEXT,
					mnemosyne_writes INTEGER,
					created_at       TEXT NOT NULL,
					updated_at       TEXT NOT NULL
				)`,
				`CREATE TABLE IF NOT EXISTS messages (
					message_id   TEXT PRIMARY KEY,
					session_id   TEXT NOT NULL REFERENCES sessions(session_id),
					ordinal      INTEGER NOT NULL,
					role         TEXT NOT NULL,
					content_json TEXT NOT NULL,
					usage_json   TEXT,
					stop_reason  TEXT,
					model        TEXT,
					timestamp    INTEGER NOT NULL,
					UNIQUE(session_id, ordinal)
				)`,
				`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, updated_at)`,
				`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ordinal)`,
			],
			"write",
		);
		// Idempotent ADD-column migration (CA-1 shared substrate): a sessions table
		// created before the `provider` column existed gets it added here. Guarded by
		// a PRAGMA table_info check so re-running init() (or a fresh DB that already
		// has the column from CREATE above) is a no-op — no "duplicate column" error.
		await this.ensureSessionsProviderColumn();
		await this.ensureSessionsMnemosyneWritesColumn();
	}

	/** Add `sessions.provider` if a pre-substrate table lacks it (idempotent). */
	private async ensureSessionsProviderColumn(): Promise<void> {
		const info = await this.db.execute({ sql: `PRAGMA table_info(sessions)`, args: [] });
		const hasProvider = info.rows.some((row) => String(row.name) === "provider");
		if (!hasProvider) {
			await this.db.execute({ sql: `ALTER TABLE sessions ADD COLUMN provider TEXT`, args: [] });
		}
	}

	/** Add `sessions.mnemosyne_writes` if a pre-lock table lacks it (idempotent). */
	private async ensureSessionsMnemosyneWritesColumn(): Promise<void> {
		const info = await this.db.execute({ sql: `PRAGMA table_info(sessions)`, args: [] });
		const hasColumn = info.rows.some((row) => String(row.name) === "mnemosyne_writes");
		if (!hasColumn) {
			await this.db.execute({ sql: `ALTER TABLE sessions ADD COLUMN mnemosyne_writes INTEGER`, args: [] });
		}
	}

	// ─── Session CRUD ────────────────────────────────────────────────

	async createSession(
		userId: string,
		opts?: { title?: string; model?: string; provider?: string; graphId?: string; mnemosyneWrites?: boolean },
	): Promise<SessionRecord> {
		return tracer.startActiveSpan("sessions.create", async (span) => {
			const sessionId = `ses_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
			const now = new Date().toISOString();
			// Only an EXPLICIT false persists a 0 (the read-only lock); undefined/true
			// store null so pre-existing behavior stays byte-identical.
			const mnemosyneWrites = opts?.mnemosyneWrites === false ? 0 : null;
			span.setAttributes({ "session.id": sessionId, "session.user_id": userId, "db.system": "sqlite" });
			await this.write(
				{
					sql: `INSERT INTO sessions (session_id, user_id, title, model, provider, graph_id, mnemosyne_writes, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					args: [
						sessionId,
						userId,
						opts?.title ?? null,
						opts?.model ?? null,
						opts?.provider ?? null,
						opts?.graphId ?? null,
						mnemosyneWrites,
						now,
						now,
					],
				},
				"UPSERT_IF_ABSENT",
			);
			span.end();
			return {
				session_id: sessionId,
				user_id: userId,
				title: opts?.title ?? null,
				model: opts?.model ?? null,
				provider: opts?.provider ?? null,
				graph_id: opts?.graphId ?? null,
				mnemosyne_writes: mnemosyneWrites,
				created_at: now,
				updated_at: now,
			};
		});
	}

	async getSession(sessionId: string): Promise<SessionRecord | undefined> {
		const res = await this.read({ sql: `SELECT * FROM sessions WHERE session_id = ?`, args: [sessionId] });
		const row = res.rows[0];
		return row ? rowToSession(row) : undefined;
	}

	async listSessions(userId: string, limit = 50, offset = 0): Promise<SessionRecord[]> {
		return tracer.startActiveSpan("sessions.list", async (span) => {
			span.setAttribute("session.user_id", userId);
			const res = await this.read({
				sql: `SELECT * FROM sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
				args: [userId, limit, offset],
			});
			span.setAttribute("session.result_count", res.rows.length);
			span.end();
			return res.rows.map(rowToSession);
		});
	}

	async updateTitle(sessionId: string, title: string): Promise<SessionRecord | undefined> {
		const now = new Date().toISOString();
		await this.write(
			{
				sql: `UPDATE sessions SET title = ?, updated_at = ? WHERE session_id = ?`,
				args: [title, now, sessionId],
			},
			"UPSERT",
		);
		return this.getSession(sessionId);
	}

	async deleteSession(sessionId: string): Promise<boolean> {
		// Serialized tx — the messages + session deletes are both-or-neither, and
		// inherited chaining guarantees no overlap with a concurrent appendMessages.
		return this.tx(async (tx) => {
			await tx.execute({ sql: `DELETE FROM messages WHERE session_id = ?`, args: [sessionId] });
			const res = await tx.execute({ sql: `DELETE FROM sessions WHERE session_id = ?`, args: [sessionId] });
			return res.rowsAffected > 0;
		}, "APPEND");
	}

	async touchSession(sessionId: string): Promise<void> {
		await this.write(
			{
				sql: `UPDATE sessions SET updated_at = ? WHERE session_id = ?`,
				args: [new Date().toISOString(), sessionId],
			},
			"UPSERT",
		);
	}

	// ─── Message Persistence ─────────────────────────────────────────

	/**
	 * Append messages to a session. Assigns ordinals starting after the
	 * current max. Returns the number of messages inserted. Atomic.
	 */
	async appendMessages(sessionId: string, messages: SerializableMessage[]): Promise<number> {
		if (messages.length === 0) return 0;
		return tracer.startActiveSpan("sessions.append_messages", async (span) => {
			span.setAttributes({ "session.id": sessionId, "messages.count": messages.length });
			try {
				// Serialized multi-statement tx — closes the prior latent
				// SQLITE_BUSY hazard (the bare transaction("write") had NO guard;
				// two concurrent appendMessages on one connection could collide).
				// The MAX(ordinal)+INSERTs+UPDATE skeleton is unchanged.
				return await this.tx(async (tx) => {
					const maxRes = await tx.execute({
						sql: `SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal FROM messages WHERE session_id = ?`,
						args: [sessionId],
					});
					let ordinal = Number(maxRes.rows[0]?.max_ordinal ?? -1) + 1;
					for (const msg of messages) {
						await tx.execute({
							sql: `INSERT INTO messages
							(message_id, session_id, ordinal, role, content_json, usage_json, stop_reason, model, timestamp)
							VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
							args: [
								`msg_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
								sessionId,
								ordinal,
								msg.role,
								JSON.stringify(msg.content),
								msg.usage ? JSON.stringify(msg.usage) : null,
								msg.stopReason ?? null,
								msg.model ?? null,
								msg.timestamp,
							],
						});
						ordinal++;
					}
					await tx.execute({
						sql: `UPDATE sessions SET updated_at = ? WHERE session_id = ?`,
						args: [new Date().toISOString(), sessionId],
					});
					return messages.length;
				}, "APPEND");
			} finally {
				span.end();
			}
		});
	}

	/**
	 * Persist one accepted user message and return its transactionally assigned
	 * message ordinal and user-turn index. The shared write chain makes concurrent
	 * prompts for one session receive distinct, stable indices.
	 */
	async appendUserMessage(sessionId: string, message: SerializableMessage): Promise<AppendedUserMessage> {
		if (message.role !== "user") throw new Error("appendUserMessage requires role=user");
		return tracer.startActiveSpan("sessions.append_messages", async (span) => {
			span.setAttributes({ "session.id": sessionId, "messages.count": 1 });
			try {
				return await this.tx(async (tx) => {
					const positionRes = await tx.execute({
						sql: `SELECT
							COALESCE(MAX(ordinal), -1) AS max_ordinal,
							SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS user_turn_count
						FROM messages WHERE session_id = ?`,
						args: [sessionId],
					});
					const ordinal = Number(positionRes.rows[0]?.max_ordinal ?? -1) + 1;
					const turnIndex = Number(positionRes.rows[0]?.user_turn_count ?? 0);
					await tx.execute({
						sql: `INSERT INTO messages
							(message_id, session_id, ordinal, role, content_json, usage_json, stop_reason, model, timestamp)
							VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						args: [
							`msg_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
							sessionId,
							ordinal,
							message.role,
							JSON.stringify(message.content),
							message.usage ? JSON.stringify(message.usage) : null,
							message.stopReason ?? null,
							message.model ?? null,
							message.timestamp,
						],
					});
					await tx.execute({
						sql: `UPDATE sessions SET updated_at = ? WHERE session_id = ?`,
						args: [new Date().toISOString(), sessionId],
					});
					return { ordinal, turnIndex };
				}, "APPEND");
			} finally {
				span.end();
			}
		});
	}

	async getMessages(sessionId: string): Promise<MessageRecord[]> {
		const res = await this.read({
			sql: `SELECT * FROM messages WHERE session_id = ? ORDER BY ordinal ASC`,
			args: [sessionId],
		});
		return res.rows.map(rowToMessage);
	}

	async getMessageCount(sessionId: string): Promise<number> {
		const res = await this.read({
			sql: `SELECT COUNT(*) AS count FROM messages WHERE session_id = ?`,
			args: [sessionId],
		});
		return Number(res.rows[0]?.count ?? 0);
	}

	/**
	 * Reconstruct the Pi message array from persisted messages.
	 * This is what gets re-injected into SpawnRequest.messages.
	 */
	async rebuildPiMessages(sessionId: string): Promise<unknown[]> {
		const rows = await this.getMessages(sessionId);
		return rows.map((row) => {
			const content = JSON.parse(row.content_json);
			if (row.role === "user") {
				return { role: "user", content, timestamp: row.timestamp };
			}
			if (row.role === "assistant") {
				const msg: Record<string, unknown> = { role: "assistant", content, timestamp: row.timestamp };
				if (row.usage_json) msg.usage = JSON.parse(row.usage_json);
				if (row.stop_reason) msg.stopReason = row.stop_reason;
				if (row.model) msg.model = row.model;
				return msg;
			}
			// toolResult — content_json stores { toolCallId, toolName, isError, content }
			const envelope = content as { toolCallId: string; toolName: string; isError: boolean; content: unknown };
			return {
				role: "toolResult",
				toolCallId: envelope.toolCallId,
				toolName: envelope.toolName,
				isError: envelope.isError,
				content: envelope.content,
				timestamp: row.timestamp,
			};
		});
	}

	// snapshotToS3 / restoreFromS3 / close are inherited from LibsqlStore.
	// Key layout (snapshotName="sessions") + CHAT_DB_S3_URL gating are unchanged.
}

// ─── Row mappers ────────────────────────────────────────────────────────
// libSQL rows are objects keyed by column name; values are JS primitives.
type LibsqlRow = Record<string, unknown>;

function s(v: unknown): string | null {
	return v == null ? null : String(v);
}

function rowToSession(row: LibsqlRow): SessionRecord {
	return {
		session_id: String(row.session_id),
		user_id: String(row.user_id),
		title: s(row.title),
		model: s(row.model),
		provider: s(row.provider),
		graph_id: s(row.graph_id),
		mnemosyne_writes: row.mnemosyne_writes == null ? null : Number(row.mnemosyne_writes),
		created_at: String(row.created_at),
		updated_at: String(row.updated_at),
	};
}

function rowToMessage(row: LibsqlRow): MessageRecord {
	return {
		message_id: String(row.message_id),
		session_id: String(row.session_id),
		ordinal: Number(row.ordinal),
		role: String(row.role) as MessageRecord["role"],
		content_json: String(row.content_json),
		usage_json: s(row.usage_json),
		stop_reason: s(row.stop_reason),
		model: s(row.model),
		timestamp: Number(row.timestamp),
	};
}

// ─── Message Serialization Interface ────────────────────────────────────

/**
 * Intermediate format for messages being persisted. The caller (session
 * routes or sandbox result handler) converts Pi messages into this shape
 * before passing to appendMessages().
 */
export interface SerializableMessage {
	role: "user" | "assistant" | "toolResult";
	/** Pi content blocks, or toolResult envelope */
	content: unknown;
	/** Pi usage object (assistant messages only) */
	usage?: unknown;
	stopReason?: string;
	model?: string;
	timestamp: number;
}

/**
 * Convert a Pi Message (from SpawnResult.messages) into a SerializableMessage.
 * Handles all three roles: user, assistant, toolResult.
 */
export function piMessageToSerializable(msg: Record<string, unknown>): SerializableMessage {
	const role = msg.role as string;
	const timestamp = (msg.timestamp as number) ?? Date.now();

	if (role === "user") {
		return { role: "user", content: msg.content, timestamp };
	}

	if (role === "assistant") {
		return {
			role: "assistant",
			content: msg.content,
			usage: msg.usage,
			stopReason: msg.stopReason as string | undefined,
			model: msg.model as string | undefined,
			timestamp,
		};
	}

	// toolResult — wrap envelope fields alongside content
	return {
		role: "toolResult",
		content: {
			toolCallId: msg.toolCallId,
			toolName: msg.toolName,
			isError: msg.isError,
			content: msg.content,
		},
		timestamp,
	};
}
