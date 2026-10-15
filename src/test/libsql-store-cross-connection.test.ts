import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LibsqlStore } from "../persistence/libsql-store.js";

/** Minimal aggregate authority driven through the real embedded libSQL client. */
class AggregateGuardStore extends LibsqlStore {
	constructor(path: string) {
		super(path, { snapshotName: "aggregate-guard" });
	}

	protected async createSchema(): Promise<void> {
		await this.db.execute(
			"CREATE TABLE IF NOT EXISTS aggregate_account (id INTEGER PRIMARY KEY, available INTEGER NOT NULL)",
		);
		await this.db.execute("INSERT OR IGNORE INTO aggregate_account (id, available) VALUES (1, 0)");
		await this.db.execute("CREATE TABLE IF NOT EXISTS testimony (value TEXT PRIMARY KEY)");
	}

	async setAvailable(value: number): Promise<void> {
		await this.write({ sql: "UPDATE aggregate_account SET available = ? WHERE id = 1", args: [value] }, "UPSERT");
	}

	reserveOne(): Promise<boolean> {
		return this.tx(async (tx) => {
			const result = await tx.execute(
				"UPDATE aggregate_account SET available = available - 1 WHERE id = 1 AND available >= 1",
			);
			return result.rowsAffected === 1;
		}, "CAS");
	}

	async available(): Promise<number> {
		const result = await this.read("SELECT available FROM aggregate_account WHERE id = 1");
		return Number(result.rows[0]?.available);
	}

	holdWriter(value: string, durationMs: number): Promise<void> {
		return this.tx(async (tx) => {
			await tx.execute({ sql: "INSERT INTO testimony (value) VALUES (?)", args: [value] });
			await new Promise((resolve) => setTimeout(resolve, durationMs));
		});
	}

	async holdReadSnapshot(durationMs: number): Promise<readonly [number, number]> {
		const tx = await this.db.transaction("read");
		try {
			const before = await tx.execute("SELECT available FROM aggregate_account WHERE id = 1");
			await new Promise((resolve) => setTimeout(resolve, durationMs));
			const after = await tx.execute("SELECT available FROM aggregate_account WHERE id = 1");
			await tx.commit();
			return [Number(before.rows[0]?.available), Number(after.rows[0]?.available)];
		} catch (error) {
			await tx.rollback();
			throw error;
		}
	}

	async recordTestimony(value: string): Promise<void> {
		await this.write({ sql: "INSERT INTO testimony (value) VALUES (?)", args: [value] }, "APPEND");
	}

	async hasTestimony(value: string): Promise<boolean> {
		const result = await this.read({ sql: "SELECT 1 AS found FROM testimony WHERE value = ?", args: [value] });
		return result.rows.length === 1;
	}

	poisonTransaction(): Promise<never> {
		return this.tx(async () => {
			throw new Error("deliberate transaction poison");
		});
	}

	poisonAfterAppliedStatement(value: string): Promise<never> {
		return this.tx(async (tx) => {
			await tx.execute({ sql: "INSERT INTO testimony (value) VALUES (?)", args: [value] });
			throw new Error("deliberate post-write poison");
		});
	}

	injectRollbackFailureOnce(): void {
		const writer = (
			this as unknown as {
				writerDb: { execute: (statement: unknown, args?: unknown) => Promise<unknown> };
			}
		).writerDb;
		const execute = writer.execute.bind(writer);
		let pending = true;
		writer.execute = (statement, args) => {
			if (pending && statement === "ROLLBACK") {
				pending = false;
				return Promise.reject(new Error("injected rollback failure"));
			}
			return execute(statement, args);
		};
	}

	rejectNativeTransactionObjects(): void {
		const writer = (
			this as unknown as {
				writerDb: { transaction: () => Promise<never> };
			}
		).writerDb;
		writer.transaction = () => Promise.reject(new Error("embedded native transaction object was allocated"));
	}
}

describe("LibsqlStore cross-connection writer authority", () => {
	it("serializes aggregate guards across two same-file connections without SQLITE_BUSY or overspend", async () => {
		const directory = mkdtempSync(join(tmpdir(), "libsql-cross-connection-"));
		const path = join(directory, "runtime.sqlite");
		const first = new AggregateGuardStore(path);
		const second = new AggregateGuardStore(path);
		try {
			await first.init();
			await second.init();
			first.rejectNativeTransactionObjects();
			second.rejectNativeTransactionObjects();
			await first.setAvailable(25);

			const race = Promise.all(
				Array.from({ length: 50 }, (_, index) => (index % 2 === 0 ? first : second).reserveOne()),
			);
			await assert.doesNotReject(race, "cross-connection contention must not escape as SQLITE_BUSY");
			const results = await race;
			assert.equal(results.filter(Boolean).length, 25, "exactly the available aggregate admits");
			assert.equal(await first.available(), 0, "the shared aggregate never overspends");
			assert.equal(await second.available(), 0, "both connections observe the same committed decisions");
		} finally {
			first.close();
			second.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("retries write() beside a held read and keeps the contender queue poison-proof", async () => {
		const directory = mkdtempSync(join(tmpdir(), "libsql-cross-connection-poison-"));
		const path = join(directory, "runtime.sqlite");
		const incumbent = new AggregateGuardStore(path);
		const contender = new AggregateGuardStore(path);
		try {
			await incumbent.init();
			await contender.init();
			await incumbent.setAvailable(1);

			const readSnapshot = contender.holdReadSnapshot(125);
			await new Promise((resolve) => setTimeout(resolve, 5));
			const holding = incumbent.holdWriter("incumbent", 75);
			await new Promise((resolve) => setTimeout(resolve, 10));
			const retriedWrite = contender.recordTestimony("contender");
			const poisonAssertion = assert.rejects(
				contender.poisonTransaction(),
				/deliberate transaction poison/,
				"only the rejected operation fails",
			);

			await holding;
			await assert.doesNotReject(retriedWrite, "write() eventually acquires the file-scoped writer lock");
			assert.equal(await contender.hasTestimony("contender"), true);
			assert.deepEqual(await readSnapshot, [1, 1], "writer reconnect never disrupts the held read snapshot");
			await poisonAssertion;
			await assert.rejects(
				contender.poisonAfterAppliedStatement("rolled-back"),
				/deliberate post-write poison/,
				"an applied statement is rolled back with its rejected transaction",
			);
			assert.equal(await contender.hasTestimony("rolled-back"), false);
			await assert.doesNotReject(contender.setAvailable(2), "the next queued write still runs");
			assert.equal(await incumbent.available(), 2);

			contender.injectRollbackFailureOnce();
			await assert.rejects(
				contender.poisonAfterAppliedStatement("rollback-reconnect"),
				(error: unknown) =>
					error instanceof AggregateError &&
					error.errors.some((nested) => String(nested).includes("injected rollback failure")),
				"a failed rollback is surfaced after quarantining the writer connection",
			);
			assert.equal(await contender.hasTestimony("rollback-reconnect"), false);
			await assert.doesNotReject(
				contender.recordTestimony("after-rollback-reconnect"),
				"the recovered writer accepts the next queued mutation",
			);
			assert.equal(await incumbent.hasTestimony("after-rollback-reconnect"), true);
		} finally {
			incumbent.close();
			contender.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
