/**
 * SessionStore — REAL `file:` libSQL, NO MOCKS.
 *
 * The load-bearing addition is the CHAT CONCURRENCY assertion: pre-substrate,
 * `appendMessages` used a bare `transaction("write")` with NO serialization
 * guard, so two concurrent appends to the same session on the single connection
 * could collide with SQLITE_BUSY (the fire-and-forget terminal-callback overlap
 * shape). After the migration `appendMessages` rides the inherited write chain,
 * so concurrent appends are strictly serialized → contiguous ordinals, zero
 * lost messages, zero SQLITE_BUSY. Plus round-trip + WAL-fix assertions.
 *
 * Run via `tsx --test`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { type SerializableMessage, SessionStore } from "../session-store.js";

function freshDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "session-store-"));
	after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

async function freshStore(): Promise<SessionStore> {
	const store = new SessionStore(join(freshDir(), "sessions.sqlite"));
	await store.init();
	return store;
}

function msg(text: string): SerializableMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

describe("SessionStore (real file: libSQL, no mocks)", () => {
	it("creates + round-trips a session and its messages", async () => {
		const store = await freshStore();
		const ses = await store.createSession("u1", { title: "hello", model: "m", graphId: "g" });
		assert.match(ses.session_id, /^ses_/);
		const got = await store.getSession(ses.session_id);
		assert.ok(got);
		assert.equal(got.title, "hello");

		const n = await store.appendMessages(ses.session_id, [msg("a"), msg("b")]);
		assert.equal(n, 2);
		const msgs = await store.getMessages(ses.session_id);
		assert.deepEqual(
			msgs.map((m) => m.ordinal),
			[0, 1],
			"ordinals assigned contiguously from 0",
		);
		assert.equal(await store.getMessageCount(ses.session_id), 2);
		store.close();
	});

	it("updateTitle + touchSession + deleteSession behave (signatures preserved)", async () => {
		const store = await freshStore();
		const ses = await store.createSession("u1");
		const updated = await store.updateTitle(ses.session_id, "renamed");
		assert.equal(updated?.title, "renamed");
		await store.touchSession(ses.session_id);
		await store.appendMessages(ses.session_id, [msg("x")]);
		assert.equal(await store.deleteSession(ses.session_id), true, "delete returns true when a row was removed");
		assert.equal(await store.getSession(ses.session_id), undefined, "session gone");
		assert.equal(await store.getMessageCount(ses.session_id), 0, "its messages gone too (cascade in one tx)");
		assert.equal(await store.deleteSession(ses.session_id), false, "second delete is a no-op (false)");
		store.close();
	});

	it("init sets WAL (fixes SessionStore's prior rollback-journal divergence)", async () => {
		const store = await freshStore();
		const res = await (
			store as unknown as { db: { execute: (s: string) => Promise<{ rows: { journal_mode?: unknown }[] }> } }
		).db.execute("PRAGMA journal_mode");
		assert.equal(String(res.rows[0]?.journal_mode).toLowerCase(), "wal");
		store.close();
	});

	it("CONCURRENCY: two concurrent appendMessages to the SAME session — contiguous ordinals, zero loss, zero SQLITE_BUSY", async () => {
		const store = await freshStore();
		const ses = await store.createSession("u1");
		// The fire-and-forget terminal-callback overlap shape: two appends fire at
		// once on the single connection. Pre-substrate this raced on the bare
		// transaction("write") (SQLITE_BUSY); the inherited chain serializes them.
		const batchA = Array.from({ length: 10 }, (_, i) => msg(`A${i}`));
		const batchB = Array.from({ length: 10 }, (_, i) => msg(`B${i}`));
		await assert.doesNotReject(
			Promise.all([store.appendMessages(ses.session_id, batchA), store.appendMessages(ses.session_id, batchB)]),
			"no SQLITE_BUSY on concurrent same-session appends",
		);
		const msgs = await store.getMessages(ses.session_id);
		assert.equal(msgs.length, 20, "zero lost messages — all 20 landed");
		assert.deepEqual(
			msgs.map((m) => m.ordinal),
			Array.from({ length: 20 }, (_, i) => i),
			"ordinals are contiguous 0..19 (no gaps, no dupes, UNIQUE(session,ordinal) never violated)",
		);
		assert.equal(new Set(msgs.map((m) => m.ordinal)).size, 20, "ordinals unique");
		store.close();
	});

	it("assigns stable user-turn indices inside the serialized append transaction", async () => {
		const store = await freshStore();
		const session = await store.createSession("u1");
		await store.appendMessages(session.session_id, [
			{
				role: "assistant",
				content: [{ type: "text", text: "prior assistant" }],
				timestamp: Date.now(),
			},
		]);

		const positions = await Promise.all([
			store.appendUserMessage(session.session_id, msg("concurrent-a")),
			store.appendUserMessage(session.session_id, msg("concurrent-b")),
		]);
		assert.deepEqual(
			positions.map((position) => position.ordinal).sort((a, b) => a - b),
			[1, 2],
		);
		assert.deepEqual(
			positions.map((position) => position.turnIndex).sort((a, b) => a - b),
			[0, 1],
			"assistant/tool rows do not consume chat-turn indices and concurrent prompts cannot duplicate one",
		);
		store.close();
	});

	it("CONCURRENCY: appends to DIFFERENT sessions interleave safely (per-session ordinals)", async () => {
		const store = await freshStore();
		const s1 = await store.createSession("u1");
		const s2 = await store.createSession("u2");
		const ops: Promise<unknown>[] = [];
		for (let i = 0; i < 8; i++) {
			ops.push(store.appendMessages(s1.session_id, [msg(`s1-${i}`)]));
			ops.push(store.appendMessages(s2.session_id, [msg(`s2-${i}`)]));
		}
		// A delete of a THIRD, unrelated session in the same burst must not collide.
		const s3 = await store.createSession("u3");
		await store.appendMessages(s3.session_id, [msg("doomed")]);
		ops.push(store.deleteSession(s3.session_id));

		await assert.doesNotReject(Promise.all(ops), "no SQLITE_BUSY across multi-session concurrent writes");
		assert.deepEqual(
			(await store.getMessages(s1.session_id)).map((m) => m.ordinal),
			Array.from({ length: 8 }, (_, i) => i),
			"session 1 ordinals contiguous",
		);
		assert.deepEqual(
			(await store.getMessages(s2.session_id)).map((m) => m.ordinal),
			Array.from({ length: 8 }, (_, i) => i),
			"session 2 ordinals contiguous, independent of session 1",
		);
		assert.equal(await store.getSession(s3.session_id), undefined, "the concurrent delete applied cleanly");
		store.close();
	});

	it("snapshotToS3 no-ops (returns null) when CHAT_DB_S3_URL is unset", async () => {
		const prev = process.env.CHAT_DB_S3_URL;
		delete process.env.CHAT_DB_S3_URL;
		try {
			const store = await freshStore();
			await store.createSession("u1");
			assert.equal(await store.snapshotToS3(), null);
			store.close();
		} finally {
			if (prev !== undefined) process.env.CHAT_DB_S3_URL = prev;
		}
	});
});

describe("SessionStore mnemosyne_writes (session-lifetime read-only lock)", () => {
	it("explicit mnemosyneWrites:false persists 0 and round-trips", async () => {
		const store = await freshStore();
		const ses = await store.createSession("u1", { graphId: "default", mnemosyneWrites: false });
		assert.equal(ses.mnemosyne_writes, 0);
		const got = await store.getSession(ses.session_id);
		assert.ok(got);
		assert.equal(got.mnemosyne_writes, 0);
		store.close();
	});

	it("omitted and explicit true both store null (pre-lock behavior byte-identical)", async () => {
		const store = await freshStore();
		const omitted = await store.createSession("u1", { graphId: "default" });
		assert.equal(omitted.mnemosyne_writes, null);
		const explicitTrue = await store.createSession("u1", { graphId: "default", mnemosyneWrites: true });
		assert.equal(explicitTrue.mnemosyne_writes, null);
		const got = await store.getSession(omitted.session_id);
		assert.ok(got);
		assert.equal(got.mnemosyne_writes, null);
		store.close();
	});

	it("re-running init() on an existing DB is a no-op (idempotent ADD-column migration)", async () => {
		const dir = freshDir();
		const path = join(dir, "sessions.sqlite");
		const first = new SessionStore(path);
		await first.init();
		const ses = await first.createSession("u1", { mnemosyneWrites: false });
		first.close();

		const second = new SessionStore(path);
		await second.init(); // must not throw "duplicate column"
		const got = await second.getSession(ses.session_id);
		assert.ok(got);
		assert.equal(got.mnemosyne_writes, 0);
		second.close();
	});
});
