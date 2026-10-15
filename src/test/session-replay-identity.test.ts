/**
 * CA-1 / S1 — session replay-identity, against a REAL file: libSQL database.
 *
 * No mocks. Every leg exercises the real {@link SessionStore} (real
 * `@libsql/client` on a real on-disk file via `mkdtempSync`), the real
 * {@link SessionStoreIntentLog} discipline, and the real {@link HeadProjection}
 * fold. The only literal values are the seeded message rows — that is data, not
 * a mock.
 *
 * The six legs prove the spine S2/S3/S5 branch from:
 *   1. SEED   — the CA-1 trace ("give me an interface" → grow_interface tool_call
 *               → toolResult → assistant text) lands in the messages table.
 *   2. FOLD   — projecting freeze() twice is deterministic, AND the projected
 *               head is value-identical to the EXISTING authority
 *               (`rebuildPiMessages`). The projection re-derives, never diverges.
 *   3. DISPOSABILITY — VACUUM INTO a copy, reopen a fresh store on the copy,
 *               re-project → identical digest. The cell is genuinely reversible.
 *   4. FIREWALL — freeze() output is deep-frozen plain values; a mutation attempt
 *               is a no-op (snapshot unchanged).
 *   5. FORK   — fork(log, atSeq=2) projects exactly the first two turns.
 *   6. DIGEST — two permuted-key objects produce an EQUAL canonical digest.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createClient } from "@libsql/client";
import { canonicalDigest } from "../agent-subject/canonical-json.js";
import { SessionStoreIntentLog } from "../agent-subject/intent-log.js";
import { fork, HeadProjection } from "../agent-subject/session-projection.js";
import { type SerializableMessage, SessionStore } from "../session-store.js";

function tmpDbPath(label: string): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), `ca1-s1-${label}-`));
	return { dir, path: join(dir, "sessions.sqlite") };
}

/**
 * The canonical CA-1 trace, as `SerializableMessage[]` (the shape
 * `appendMessages` persists): a user asking for an interface, the agent calling
 * `grow_interface`, the tool result, and a closing assistant text. Four turns.
 */
function ca1Trace(): SerializableMessage[] {
	const t0 = 1_700_000_000_000;
	return [
		{
			role: "user",
			content: [{ type: "text", text: "give me an interface" }],
			timestamp: t0,
		},
		{
			role: "assistant",
			content: [
				{ type: "toolCall", toolCallId: "call_grow_1", toolName: "grow_interface", args: { component: "panel" } },
			],
			usage: { input: 11, output: 7 },
			stopReason: "toolUse",
			model: "claude-opus-4-8",
			timestamp: t0 + 1000,
		},
		{
			role: "toolResult",
			content: {
				toolCallId: "call_grow_1",
				toolName: "grow_interface",
				isError: false,
				content: "panel grown: panel-1",
			},
			timestamp: t0 + 2000,
		},
		{
			role: "assistant",
			content: [{ type: "text", text: "Here is your interface — a panel." }],
			usage: { input: 19, output: 9 },
			stopReason: "endTurn",
			model: "claude-opus-4-8",
			timestamp: t0 + 3000,
		},
	];
}

describe("CA-1/S1 session replay-identity (real file: libSQL, no mocks)", () => {
	it("(1) SEED: the CA-1 trace lands in the messages table in order", async () => {
		const { dir, path } = tmpDbPath("seed");
		after(() => rmSync(dir, { recursive: true, force: true }));

		const store = new SessionStore(path);
		await store.init();
		const session = await store.createSession("user-ada", { graphId: "sophia-code-lab" });
		const log = new SessionStoreIntentLog(store, session.session_id);

		const appended = await log.append(ca1Trace());
		assert.equal(appended, 4, "all four CA-1 turns appended");

		const rows = await log.read();
		assert.equal(rows.length, 4);
		assert.deepEqual(
			rows.map((r) => r.role),
			["user", "assistant", "toolResult", "assistant"],
			"roles persisted in append order",
		);
		assert.deepEqual(
			rows.map((r) => r.ordinal),
			[0, 1, 2, 3],
			"gap-free ordinals from 0",
		);
		store.close();
	});

	it("(2) FOLD: project(freeze()) is deterministic AND === rebuildPiMessages (the existing authority)", async () => {
		const { dir, path } = tmpDbPath("fold");
		after(() => rmSync(dir, { recursive: true, force: true }));

		const store = new SessionStore(path);
		await store.init();
		const session = await store.createSession("user-ada", { graphId: "sophia-code-lab" });
		const log = new SessionStoreIntentLog(store, session.session_id);
		await log.append(ca1Trace());

		const projection = new HeadProjection();
		const head1 = projection.project(await log.freeze());
		const head2 = projection.project(await log.freeze());

		// fold-determinism: same input → same digest.
		assert.equal(head1.digest, head2.digest, "two folds of the same log produce an equal digest");
		assert.deepEqual(head1.messages, head2.messages, "two folds produce equal messages");
		assert.equal(head1.headSeq, 3, "head folded up to seq 3 (4 turns, 0-based)");

		// head === the EXISTING authority: the projection re-derives exactly what
		// SessionStore.rebuildPiMessages already injects.
		const authority = await store.rebuildPiMessages(session.session_id);
		assert.deepEqual(head1.messages, authority, "projected head is value-identical to rebuildPiMessages");
		store.close();
	});

	it("(3) DISPOSABILITY: VACUUM INTO a copy, reopen a fresh store, re-project → identical digest", async () => {
		const { dir, path } = tmpDbPath("dispose");
		const { dir: dir2, path: copyPath } = tmpDbPath("dispose-copy");
		after(() => {
			rmSync(dir, { recursive: true, force: true });
			rmSync(dir2, { recursive: true, force: true });
		});

		const store = new SessionStore(path);
		await store.init();
		const session = await store.createSession("user-ada", { graphId: "sophia-code-lab" });
		const log = new SessionStoreIntentLog(store, session.session_id);
		await log.append(ca1Trace());

		const projection = new HeadProjection();
		const head1 = projection.project(await log.freeze());

		// VACUUM INTO produces a clean, WAL-free copy of the live file (the same
		// reversibility move SessionStore.snapshotToS3 uses). A real second libSQL
		// client on the SAME file — not a mock — performs the copy.
		const raw = createClient({ url: `file:${path}` });
		await raw.execute({ sql: "VACUUM INTO ?", args: [copyPath] });
		raw.close();
		store.close();

		// Reopen a BRAND-NEW SessionStore on the disposable copy; the session must
		// survive and re-project to the identical head.
		const restored = new SessionStore(copyPath);
		await restored.init(); // CREATE TABLE IF NOT EXISTS — no-op on the copy.
		const restoredLog = new SessionStoreIntentLog(restored, session.session_id);
		const head3 = projection.project(await restoredLog.freeze());

		assert.equal(head1.digest, head3.digest, "restore-identity: the copy re-projects to the same digest");
		assert.deepEqual(head1.messages, head3.messages, "restored head is value-identical to the original");
		restored.close();
	});

	it("(4) FIREWALL: freeze() output is deep-frozen plain values; a mutation attempt is a no-op", async () => {
		const { dir, path } = tmpDbPath("firewall");
		after(() => rmSync(dir, { recursive: true, force: true }));

		const store = new SessionStore(path);
		await store.init();
		const session = await store.createSession("user-ada", { graphId: "sophia-code-lab" });
		const log = new SessionStoreIntentLog(store, session.session_id);
		await log.append(ca1Trace());

		const snapshot = await log.freeze();

		assert.ok(Object.isFrozen(snapshot), "snapshot is frozen");
		assert.ok(Object.isFrozen(snapshot.entries), "entries array is frozen");
		for (const entry of snapshot.entries) {
			assert.ok(Object.isFrozen(entry), "each entry is frozen");
			// Plain value: a plain object literal, no class instance, no live handle.
			assert.equal(Object.getPrototypeOf(entry), Object.prototype, "entry is a plain object");
		}

		const before = structuredClone(snapshot.entries.map((e) => ({ ...e })));
		// Mutation attempt on a frozen value: in non-strict module scope this is a
		// silent no-op; assignment must not change the snapshot either way.
		try {
			// @ts-expect-error — deliberately attempting to mutate a readonly/frozen field.
			snapshot.entries[0].role = "TAMPERED";
			// @ts-expect-error — deliberately attempting to mutate headSeq.
			snapshot.headSeq = 999;
		} catch {
			// A TypeError under strict mode is also acceptable — the point is the
			// snapshot is unchanged.
		}
		const after2 = snapshot.entries.map((e) => ({ ...e }));
		assert.deepEqual(after2, before, "the frozen snapshot is unchanged by the mutation attempt");
		assert.notEqual(snapshot.entries[0].role, "TAMPERED");
		store.close();
	});

	it("(5) FORK: fork(log, atSeq=2) projects exactly the first two turns", async () => {
		const { dir, path } = tmpDbPath("fork");
		after(() => rmSync(dir, { recursive: true, force: true }));

		const store = new SessionStore(path);
		await store.init();
		const session = await store.createSession("user-ada", { graphId: "sophia-code-lab" });
		const log = new SessionStoreIntentLog(store, session.session_id);
		await log.append(ca1Trace());

		const forked = await fork(log, 2);
		assert.equal(forked.messages.length, 2, "fork keeps only the first two turns");
		assert.equal(forked.headSeq, 1, "forked head seq is 1 (two turns, 0-based)");

		// The forked head deep-equals the first two messages of the full head.
		const full = new HeadProjection().project(await log.freeze());
		assert.deepEqual(forked.messages, full.messages.slice(0, 2), "fork == first two turns of the full head");

		// Distinct fingerprint from the full 4-turn head.
		assert.notEqual(forked.digest, full.digest, "a forked prefix digests differently from the full head");
		store.close();
	});

	it("(6) DIGEST: two permuted-key objects produce an EQUAL canonical digest", () => {
		const a = { role: "user", content: [{ type: "text", text: "give me an interface" }], timestamp: 1 };
		const b = { timestamp: 1, content: [{ text: "give me an interface", type: "text" }], role: "user" };
		assert.equal(canonicalDigest(a), canonicalDigest(b), "key order does not change the digest");

		// Sanity: a genuinely different value digests differently.
		const c = { role: "assistant", content: [{ type: "text", text: "give me an interface" }], timestamp: 1 };
		assert.notEqual(canonicalDigest(a), canonicalDigest(c), "a real content difference changes the digest");
	});
});
