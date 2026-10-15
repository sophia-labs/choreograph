/**
 * LibsqlStore substrate — REAL `file:` libSQL, NO MOCKS.
 *
 * A tiny `TestStore extends LibsqlStore` with one log table + one counter row
 * exercises the substrate's serial write executor directly: N-way concurrent
 * serialized writes, N-way CAS transactions (the billing shape generalized),
 * mixed write+tx interleave, the poison-the-chain invariant, reads-during-
 * writes (WAL), and a snapshot/restore round-trip through a real `aws`-shaped
 * stub script (real binary, real bytes, no network, no mock of the store).
 *
 * Run via `tsx --test`.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { InStatement } from "@libsql/client";
import { LibsqlStore, type LibsqlStoreOptions } from "./libsql-store.js";

function tmpDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

// ─── A minimal concrete store ───────────────────────────────────────────────
class TestStore extends LibsqlStore {
	constructor(urlOrPath: string, opts?: Partial<LibsqlStoreOptions>) {
		super(urlOrPath, { snapshotName: "test", ...opts });
	}

	protected async createSchema(): Promise<void> {
		await this.db.execute(`CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT NOT NULL)`);
		await this.db.execute(`CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)`);
		await this.db.execute(`INSERT OR IGNORE INTO counter (id, n) VALUES (1, 0)`);
	}

	append(v: string): Promise<unknown> {
		return this.write({ sql: `INSERT INTO log (v) VALUES (?)`, args: [v] }, "APPEND");
	}

	/** CAS decrement floored at 0 (the billing-debit shape, generalized). */
	casDecrement(amount: number): Promise<boolean> {
		return this.tx(async (tx) => {
			const res = await tx.execute({
				sql: `UPDATE counter SET n = n - :amt WHERE id = 1 AND n >= :amt`,
				args: { amt: amount },
			});
			return res.rowsAffected > 0;
		}, "CAS");
	}

	async setCounter(n: number): Promise<void> {
		await this.write({ sql: `UPDATE counter SET n = ? WHERE id = 1`, args: [n] }, "UPSERT");
	}

	async getCounter(): Promise<number> {
		const res = await this.read({ sql: `SELECT n FROM counter WHERE id = 1`, args: [] });
		return Number(res.rows[0]?.n ?? 0);
	}

	async countLog(): Promise<number> {
		const res = await this.read({ sql: `SELECT COUNT(*) AS c FROM log`, args: [] });
		return Number(res.rows[0]?.c ?? 0);
	}

	async logValues(): Promise<string[]> {
		const res = await this.read({ sql: `SELECT v FROM log ORDER BY id ASC`, args: [] });
		return res.rows.map((r) => String(r.v));
	}

	/** Inject a write that rejects mid-statement (poison test). */
	poison(): Promise<unknown> {
		// A syntactically-broken statement rejects inside the chain link.
		return this.write({ sql: `INSERT INTO nonexistent_table (x) VALUES (1)`, args: [] } as InStatement, "APPEND");
	}

	/** A deliberately-long write tx (holds BEGIN open while we read concurrently). */
	longTx(value: string, holdMs: number): Promise<void> {
		return this.tx(async (tx) => {
			await tx.execute({ sql: `INSERT INTO log (v) VALUES (?)`, args: [value] });
			await new Promise((r) => setTimeout(r, holdMs));
		});
	}
}

async function freshStore(): Promise<TestStore> {
	const dir = tmpDir("libsql-substrate-");
	const store = new TestStore(join(dir, "test.sqlite"));
	await store.init();
	return store;
}

describe("LibsqlStore substrate (real file: libSQL, no mocks)", () => {
	it("WAL is set after init", async () => {
		const store = await freshStore();
		// PRAGMA journal_mode read goes through a normal execute.
		const res = await store["db"].execute("PRAGMA journal_mode");
		assert.equal(String(res.rows[0]?.journal_mode).toLowerCase(), "wal");
		store.close();
	});

	it("N-way concurrent write(): all rows present, monotonic, zero SQLITE_BUSY", async () => {
		const store = await freshStore();
		const N = 50;
		// Promise.all fires all 50 inserts "at once"; the chain serializes them.
		await assert.doesNotReject(Promise.all(Array.from({ length: N }, (_, i) => store.append(`v${i}`))));
		assert.equal(await store.countLog(), N, "all 50 rows present");
		// AUTOINCREMENT ids are monotonic 1..N (no gaps means no failed/retried inserts).
		const ids = await store["db"].execute("SELECT id FROM log ORDER BY id ASC");
		assert.deepEqual(
			ids.rows.map((r) => Number(r.id)),
			Array.from({ length: N }, (_, i) => i + 1),
			"ids are gap-free 1..N",
		);
		store.close();
	});

	it("N-way concurrent tx() CAS counter: exact final value, overspend impossible", async () => {
		const store = await freshStore();
		const N = 50;
		const start = N; // exactly enough for N decrements of 1
		await store.setCounter(start);
		const results = await Promise.all(Array.from({ length: N }, () => store.casDecrement(1)));
		assert.equal(results.filter((r) => r).length, N, "all N decrements succeeded (exactly enough budget)");
		assert.equal(await store.getCounter(), 0, "counter exactly drained, never below 0");

		// Now overspend: budget for only N/2, fire N. Exactly N/2 succeed, floor holds.
		await store.setCounter(N / 2);
		const over = await Promise.all(Array.from({ length: N }, () => store.casDecrement(1)));
		assert.equal(over.filter((r) => r).length, N / 2, "exactly budget-many succeed, overspend blocked");
		assert.equal(await store.getCounter(), 0, "floor at 0 held under concurrency");
		store.close();
	});

	it("mixed write() + tx() interleave: zero SQLITE_BUSY (one shared chain)", async () => {
		const store = await freshStore();
		await store.setCounter(100);
		const ops: Promise<unknown>[] = [];
		for (let i = 0; i < 25; i++) {
			ops.push(store.append(`w${i}`)); // single-statement
			ops.push(store.casDecrement(1)); // multi-statement tx
		}
		await assert.doesNotReject(Promise.all(ops), "no SQLITE_BUSY when write() and tx() share the chain");
		assert.equal(await store.countLog(), 25, "all single-statement writes landed");
		assert.equal(await store.getCounter(), 75, "all tx decrements landed");
		store.close();
	});

	it("poison: a rejected link does NOT poison the chain (next write still runs)", async () => {
		const store = await freshStore();
		await store.append("before");
		// The poison rejects; we catch it. The chain head must reset to resolved.
		await assert.rejects(store.poison(), "the broken write rejects its own promise");
		// A subsequent enqueued write must still succeed.
		await assert.doesNotReject(store.append("after"), "chain not poisoned");
		assert.deepEqual(await store.logValues(), ["before", "after"], "both good writes present, poison absent");
		store.close();
	});

	it("reads-during-writes: read() returns last committed value, never blocks (WAL)", async () => {
		const store = await freshStore();
		await store.append("committed");
		// Fire a long write tx that holds BEGIN open ~150ms, then read concurrently.
		const writing = store.longTx("during", 150);
		// Give the tx a moment to open BEGIN, then read while it is open.
		await new Promise((r) => setTimeout(r, 30));
		const t0 = Date.now();
		const mid = await store.countLog(); // read while the write tx is OPEN
		const readMs = Date.now() - t0;
		// WAL: the read sees the last COMMITTED state (1 row), not the uncommitted insert,
		// and it returns promptly (does not block on the open writer).
		assert.equal(mid, 1, "read sees last committed value, not the open tx's uncommitted row");
		assert.ok(readMs < 100, `read did not block on the open writer (took ${readMs}ms)`);
		await writing;
		assert.equal(await store.countLog(), 2, "the long tx committed afterward");
		store.close();
	});

	it("snapshotToS3 returns null when s3Url is unset", async () => {
		const store = await freshStore();
		await store.append("x");
		assert.equal(await store.snapshotToS3(), null, "no-op when S3 not configured");
		store.close();
	});

	it("privacy retirement replaces all versioned snapshot history with one verified vacuumed version", async () => {
		const dir = tmpDir("libsql-substrate-retire-");
		const statePath = join(dir, "versions.json");
		const awsBin = join(dir, "aws");
		writeFileSync(
			statePath,
			JSON.stringify({
				Versions: [
					{ Key: "journal/i-old/2026-08-01/test-old.sqlite", VersionId: "v1", IsLatest: true },
					{ Key: "journal/i-old/2026-08-01/test-old.sqlite", VersionId: "v0", IsLatest: false },
				],
				DeleteMarkers: [{ Key: "journal/i-older/2026-07-01/test-older.sqlite", VersionId: "d1", IsLatest: true }],
			}),
			"utf8",
		);
		writeFileSync(
			awsBin,
			`#!/usr/bin/env node
const fs = require("node:fs");
const statePath = ${JSON.stringify(statePath)};
const argv = process.argv.slice(2);
const read = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const write = (value) => fs.writeFileSync(statePath, JSON.stringify(value));
if (argv[0] === "s3" && argv[1] === "cp") {
  const state = read();
  for (const version of state.Versions) version.IsLatest = false;
  for (const marker of state.DeleteMarkers) marker.IsLatest = false;
  const key = new URL(argv[3]).pathname.slice(1);
  state.Versions.unshift({ Key: key, VersionId: "fresh", IsLatest: true });
  write(state);
  process.exit(0);
}
if (argv[0] === "s3api" && argv[1] === "list-object-versions") {
  process.stdout.write(JSON.stringify(read()));
  process.exit(0);
}
if (argv[0] === "s3api" && argv[1] === "delete-objects") {
  const state = read();
  const request = JSON.parse(argv[argv.indexOf("--delete") + 1]);
  const retired = new Set(request.Objects.map((item) => item.Key + "::" + item.VersionId));
  state.Versions = state.Versions.filter((item) => !retired.has(item.Key + "::" + item.VersionId));
  state.DeleteMarkers = state.DeleteMarkers.filter((item) => !retired.has(item.Key + "::" + item.VersionId));
  write(state);
  process.stdout.write("{}");
  process.exit(0);
}
process.exit(2);
`,
			"utf8",
		);
		chmodSync(awsBin, 0o755);

		const store = new TestStore(join(dir, "runtime.sqlite"), {
			s3Url: "s3://fake/journal/",
			awsBin,
		});
		await store.init();
		await store.append("privacy-safe current state");
		const receipt = await store.replaceS3SnapshotHistory();
		assert.equal(receipt.retiredVersions, 3);
		assert.ok(receipt.snapshotUrl?.startsWith("s3://fake/journal/"));
		const remaining = JSON.parse(readFileSync(statePath, "utf8"));
		assert.equal(remaining.Versions.length, 1);
		assert.equal(remaining.Versions[0].VersionId, "fresh");
		assert.deepEqual(remaining.DeleteMarkers, []);
		store.close();
	});

	it("snapshot/restore round-trip via a real aws-shaped stub (no network, no mock)", async () => {
		const dir = tmpDir("libsql-substrate-snap-");
		// A real executable that emulates the THREE aws s3 verbs we use: cp, ls.
		// It treats `s3://fake/...` as a path under fakeS3Root. Real bytes, real fs.
		const fakeS3Root = join(dir, "fakeS3");
		const awsBin = join(dir, "aws");
		writeFileSync(
			awsBin,
			`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const ROOT = ${JSON.stringify(fakeS3Root)};
function toLocal(u) {
  // s3://bucket/key  ->  ROOT/bucket/key
  return path.join(ROOT, u.replace(/^s3:\\/\\//, ""));
}
const argv = process.argv.slice(2); // ["s3", verb, ...]
const verb = argv[1];
if (verb === "cp") {
  const [src, dst] = [argv[2], argv[3]];
  const from = src.startsWith("s3://") ? toLocal(src) : src;
  const to = dst.startsWith("s3://") ? toLocal(dst) : dst;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  process.exit(0);
}
if (verb === "ls") {
  // "s3 ls <prefix> --recursive" -> lines "<date> <time> <size> <key>"
  // where <key> is relative to the BUCKET root.
  const prefixUrl = argv[2];
  const localPrefix = toLocal(prefixUrl);
  // bucket root = ROOT/<bucket>
  const m = /^s3:\\/\\/([^/]+)\\//.exec(prefixUrl);
  const bucket = m ? m[1] : "";
  const bucketRoot = path.join(ROOT, bucket);
  const out = cp.execSync("find " + JSON.stringify(localPrefix) + " -type f 2>/dev/null || true").toString();
  const lines = out.split("\\n").filter(Boolean).map((f) => {
    const st = fs.statSync(f);
    const rel = path.relative(bucketRoot, f);
    const d = new Date(st.mtimeMs).toISOString();
    return d.slice(0,10) + " " + d.slice(11,19) + " " + st.size + " " + rel;
  });
  process.stdout.write(lines.join("\\n") + "\\n");
  process.exit(0);
}
process.exit(0);
`,
			"utf8",
		);
		chmodSync(awsBin, 0o755);

		const s3Url = "s3://fake/journal/";
		const srcStore = new TestStore(join(dir, "src.sqlite"), { s3Url, awsBin });
		await srcStore.init();
		await srcStore.append("alpha");
		await srcStore.append("beta");
		await srcStore.setCounter(7);

		const written = await srcStore.snapshotToS3({ instanceId: "i-test", now: new Date() });
		assert.ok(written, "snapshot wrote an s3 url");
		assert.match(written, /test-.*\.sqlite$/, "snapshot key uses the snapshotName stem");
		srcStore.close();

		// Restore into a fresh path, then open a NEW store over the restored file.
		const restoredPath = join(dir, "restored.sqlite");
		const ok = await LibsqlStore.restoreFromS3({ s3Url, destPath: restoredPath, snapshotName: "test", awsBin });
		assert.equal(ok, true, "restore found + pulled the newest snapshot");

		const restored = new TestStore(restoredPath, { awsBin });
		await restored.init();
		assert.deepEqual(await restored.logValues(), ["alpha", "beta"], "restored rows identical");
		assert.equal(await restored.getCounter(), 7, "restored counter identical");
		restored.close();
	});

	it("restoreFromS3 returns false when no matching snapshot exists", async () => {
		const dir = tmpDir("libsql-substrate-norestore-");
		const fakeS3Root = join(dir, "fakeS3");
		const awsBin = join(dir, "aws");
		writeFileSync(awsBin, `#!/usr/bin/env node\nprocess.stdout.write("\\n");process.exit(0);\n`, "utf8");
		chmodSync(awsBin, 0o755);
		void fakeS3Root;
		const ok = await LibsqlStore.restoreFromS3({
			s3Url: "s3://fake/journal/",
			destPath: join(dir, "x.sqlite"),
			snapshotName: "test",
			awsBin,
		});
		assert.equal(ok, false, "no snapshot ⇒ false (caller starts fresh)");
	});
});
