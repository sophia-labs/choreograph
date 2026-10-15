/**
 * IntentLog — the append-only intent spine of a CA-1 agent session.
 *
 * CA-1 / S1 — the SoR discipline (no new table, no migration, zero data movement).
 *
 * The IntentLog is a *discipline* layered over the EXISTING `messages` table
 * owned by {@link SessionStore} (see ../session-store.ts: `appendMessages`
 * ~:197, `getMessages` ~:242, `rowToMessage` ~:339). It does NOT introduce a
 * new table, a migration, or any data copy. It re-frames the already-persisted,
 * ordinal-ordered Pi message rows as an *intent journal*: an append-only log of
 * what the human and the agent did, in order, which is the source of record a
 * SessionProjection folds into a head.
 *
 * The single new affordance over SessionStore is {@link IntentLog.freeze}: it
 * reads the current rows (via the SAME `getMessages` mapper that produces plain
 * `MessageRecord` values — never a live handle) and materializes a
 * DEEP-FROZEN {@link FrozenSnapshot}. Freezing makes the snapshot a value the
 * projection cannot accidentally mutate: it is the firewall between "the live,
 * still-appending log" and "the immutable input the fold ran against". This is
 * the precedent set by `reconstructRunRecord` in ../workflow/projection.ts
 * (~:50) — a pure value fold over plain rows, NOT `foldRunToProvenance` which
 * takes a live JournalStore handle.
 *
 * Substrate-neutral on purpose: the trait names no CRDT, no yrs/Loro, no
 * specific storage — only "entries in order" + "head seq". That keeps the
 * convergence question (where does ordering authority live?) open for a later
 * slice instead of baking in apparatus now.
 */

import type { MessageRecord, SerializableMessage, SessionStore } from "../session-store.js";

/**
 * One entry in the frozen snapshot: the persisted message row as a plain,
 * deeply-frozen value. `seq` is the row's `ordinal` — the append-order index in
 * the intent log (0-based, gap-free per session). All fields mirror
 * {@link MessageRecord} exactly; `content_json` is left as the persisted JSON
 * string (the projection parses it), matching how `rebuildPiMessages` reads it.
 */
export interface FrozenEntry {
	readonly seq: number;
	readonly message_id: string;
	readonly session_id: string;
	readonly role: MessageRecord["role"];
	readonly content_json: string;
	readonly usage_json: string | null;
	readonly stop_reason: string | null;
	readonly model: string | null;
	readonly timestamp: number;
}

/**
 * An immutable, deeply-frozen point-in-time read of an IntentLog. `entries` are
 * in append order; `headSeq` is the ordinal of the last entry (or -1 when
 * empty). This is the ONLY input a {@link SessionProjection} folds — never the
 * live store.
 */
export interface FrozenSnapshot {
	readonly sessionId: string;
	readonly headSeq: number;
	readonly entries: readonly FrozenEntry[];
}

/**
 * The IntentLog trait. Substrate-neutral: it names no storage engine and no
 * CRDT. An implementation appends intents in order, reads them back in order,
 * and can freeze a snapshot for projection.
 */
export interface IntentLog {
	/** Session this log is scoped to. */
	readonly sessionId: string;
	/** Append intents in order; returns the count appended (delegates to the store). */
	append(entries: SerializableMessage[]): Promise<number>;
	/** Read every entry, in append order, as plain values. */
	read(): Promise<MessageRecord[]>;
	/** Materialize a deep-frozen, immutable snapshot for the projection to fold. */
	freeze(): Promise<FrozenSnapshot>;
}

/**
 * SessionStore-backed IntentLog. A thin discipline over `appendMessages` /
 * `getMessages` — it adds no table and moves no data. `freeze()` deep-freezes
 * the plain `MessageRecord` values returned by the store's `rowToMessage`
 * mapper, producing the immutable input the projection folds.
 */
export class SessionStoreIntentLog implements IntentLog {
	readonly sessionId: string;
	private readonly store: SessionStore;

	constructor(store: SessionStore, sessionId: string) {
		this.store = store;
		this.sessionId = sessionId;
	}

	append(entries: SerializableMessage[]): Promise<number> {
		// Pure delegation: SessionStore owns ordinal assignment + atomicity.
		return this.store.appendMessages(this.sessionId, entries);
	}

	read(): Promise<MessageRecord[]> {
		return this.store.getMessages(this.sessionId);
	}

	async freeze(): Promise<FrozenSnapshot> {
		const rows = await this.store.getMessages(this.sessionId);
		const entries: FrozenEntry[] = rows.map((r) =>
			Object.freeze({
				seq: r.ordinal,
				message_id: r.message_id,
				session_id: r.session_id,
				role: r.role,
				content_json: r.content_json,
				usage_json: r.usage_json,
				stop_reason: r.stop_reason,
				model: r.model,
				timestamp: r.timestamp,
			}),
		);
		const headSeq = entries.length === 0 ? -1 : entries[entries.length - 1].seq;
		return Object.freeze({
			sessionId: this.sessionId,
			headSeq,
			entries: Object.freeze(entries) as readonly FrozenEntry[],
		});
	}
}
