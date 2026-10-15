/**
 * SessionProjection — fold a frozen IntentLog snapshot into a session head.
 *
 * CA-1 / S1 — the projection spine.
 *
 * A {@link SessionProjection} is the read model of an {@link IntentLog}: it takes
 * a {@link FrozenSnapshot} (the immutable intent journal) and FOLDS it into a
 * {@link ProjectedHead} — the Pi message array a sandbox would be re-injected
 * with, plus a content `digest`. This mirrors the journal→wf: projection
 * precedent in ../workflow/projection.ts (`reconstructRunRecord` ~:50): a PURE
 * value fold over plain rows, not a live-handle read.
 *
 * The head MUST be value-identical to the EXISTING authority,
 * `SessionStore.rebuildPiMessages` (../session-store.ts ~:262). That is the
 * load-bearing invariant: the projection is a re-derivation of what choreograph
 * already injects, so adopting it changes the *story* (intent log → projected
 * head) without changing the *bytes*. The S1 replay-identity test pins this.
 *
 * SUBSTRATE-NEUTRAL: this module imports NO CRDT library (yrs / Loro / yjs).
 * Naming a substrate here would be premature apparatus — the projection only
 * needs "entries in order". Where ordering *authority* eventually lives (single
 * writer? CRDT? the MO log?) is a deliberately deferred fork.
 */

import { canonicalDigest } from "./canonical-json.js";
import type { FrozenEntry, FrozenSnapshot, IntentLog } from "./intent-log.js";

/**
 * The projected head: the reconstructed Pi message array (`messages`) plus a
 * stable content `digest` over it, and `headSeq` (the seq the head was folded
 * up to). `messages` is value-identical to `SessionStore.rebuildPiMessages`.
 */
export interface ProjectedHead {
	readonly messages: unknown[];
	readonly digest: string;
	readonly headSeq: number;
}

/** The SessionProjection trait: fold a frozen snapshot into a head. */
export interface SessionProjection {
	project(snapshot: FrozenSnapshot): ProjectedHead;
}

/**
 * Reconstruct one Pi message from a frozen intent entry. This is a verbatim
 * value-copy of the per-row reconstruction in `SessionStore.rebuildPiMessages`
 * (../session-store.ts ~:264-286), so the projected head matches the existing
 * authority byte-for-byte (after deepEqual).
 */
function entryToPiMessage(entry: FrozenEntry): unknown {
	const content = JSON.parse(entry.content_json);
	if (entry.role === "user") {
		return { role: "user", content, timestamp: entry.timestamp };
	}
	if (entry.role === "assistant") {
		const msg: Record<string, unknown> = { role: "assistant", content, timestamp: entry.timestamp };
		if (entry.usage_json) msg.usage = JSON.parse(entry.usage_json);
		if (entry.stop_reason) msg.stopReason = entry.stop_reason;
		if (entry.model) msg.model = entry.model;
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
		timestamp: entry.timestamp,
	};
}

/**
 * The one SessionProjection implementation: a pure fold of the frozen snapshot's
 * entries (in seq order) into Pi messages, fingerprinted with a canonical digest.
 */
export class HeadProjection implements SessionProjection {
	project(snapshot: FrozenSnapshot): ProjectedHead {
		const messages = snapshot.entries.map(entryToPiMessage);
		return {
			messages,
			digest: canonicalDigest(messages),
			headSeq: snapshot.headSeq,
		};
	}
}

/**
 * Fork helper: project only the FIRST `atSeq` turns of a log. Freezes the log,
 * truncates to the first `atSeq` entries (by append order), and projects that
 * prefix as if it were the whole snapshot. This is the "forkable session"
 * primitive — a projected head as of an earlier point — without any substrate
 * commitment. `atSeq` is a TURN COUNT (entries), not an ordinal bound.
 */
export async function fork(
	log: IntentLog,
	atSeq: number,
	projection: SessionProjection = new HeadProjection(),
): Promise<ProjectedHead> {
	const snapshot = await log.freeze();
	const prefix = snapshot.entries.slice(0, Math.max(0, atSeq));
	const headSeq = prefix.length === 0 ? -1 : prefix[prefix.length - 1].seq;
	const forked: FrozenSnapshot = Object.freeze({
		sessionId: snapshot.sessionId,
		headSeq,
		entries: Object.freeze([...prefix]) as readonly FrozenEntry[],
	});
	return projection.project(forked);
}
