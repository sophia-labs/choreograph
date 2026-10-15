/** Real BillingStore -> VACUUM snapshot -> versioned Observatory view proof. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createClient } from "@libsql/client";
import { BillingStore, type UsageEventInput } from "../billing-store.js";

function usage(eventId: string, ts: number, userId: string | null): UsageEventInput {
	return {
		eventId,
		ts,
		userId,
		graphId: "organism-dev",
		sandboxId: "sbx-test",
		template: "agent",
		provider: "openrouter",
		model: "openrouter/test-model",
		modelPriced: "openrouter/test-model",
		reason: "stop",
		inputTokens: 10,
		outputTokens: 5,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 15,
		inputCostMicroUsd: 1,
		outputCostMicroUsd: 2,
		cacheReadCostMicroUsd: 0,
		cacheWriteCostMicroUsd: 0,
		providerCostMicroUsd: 3,
		markupMicroUsd: 1,
		costMicroUsd: 4,
		pricingVersion: "test",
		pricedDefault: false,
	};
}

describe("Observatory billing read seam", () => {
	it("exposes a narrow v1 view in an immutable real snapshot", async () => {
		const directory = mkdtempSync(join(tmpdir(), "billing-observatory-test-"));
		after(() => rmSync(directory, { recursive: true, force: true }));
		const livePath = join(directory, "live.sqlite");
		const snapshotPath = join(directory, "snapshot.sqlite");
		const store = new BillingStore(livePath);
		await store.init();

		const start = Date.parse("2026-07-11T00:00:00Z");
		const end = Date.parse("2026-07-12T00:00:00Z");
		await store.recordUsage(usage("a-1", start + 1, "user-a"));
		await store.recordUsage(usage("a-2", start + 2, "user-a"));
		await store.recordUsage(usage("b-1", start + 3, "user-b"));
		await store.recordUsage(usage("anonymous", start + 4, null));
		await store.snapshotToFile(snapshotPath);

		// A later live write proves the snapshot is a point-in-time copy, not an
		// alias or second connection to mutable billing authority.
		await store.recordUsage(usage("later", start + 5, "user-later"));
		store.close();

		const snapshot = createClient({ url: `file:${snapshotPath}` });
		try {
			const result = await snapshot.execute({
				sql: `SELECT COUNT(DISTINCT user_id) AS dau, COUNT(*) AS n
					FROM observatory_billing_usage_v1
					WHERE user_id IS NOT NULL AND ts >= ? AND ts < ?`,
				args: [start, end],
			});
			assert.equal(Number(result.rows[0]?.dau), 2);
			assert.equal(Number(result.rows[0]?.n), 3);

			const columns = await snapshot.execute("PRAGMA table_info(observatory_billing_usage_v1)");
			assert.deepEqual(
				columns.rows.map((row) => String(row.name)),
				["event_id", "ts", "user_id", "graph_id", "model", "total_tokens", "cost_micro_usd", "priced_default"],
			);
		} finally {
			snapshot.close();
		}
	});

	it("fences queued writes before VACUUM so a snapshot is transactionally complete", async () => {
		const directory = mkdtempSync(join(tmpdir(), "billing-observatory-fence-test-"));
		after(() => rmSync(directory, { recursive: true, force: true }));
		const snapshotPath = join(directory, "snapshot.sqlite");
		const store = new BillingStore(join(directory, "live.sqlite"));
		await store.init();
		const start = Date.parse("2026-07-11T00:00:00Z");

		const writes = Array.from({ length: 40 }, (_, index) =>
			store.recordUsage(usage(`queued-${index}`, start + index, `user-${index}`)),
		);
		const snapshot = store.snapshotToFile(snapshotPath);
		await Promise.all([...writes, snapshot]);
		store.close();

		const copy = createClient({ url: `file:${snapshotPath}` });
		try {
			const result = await copy.execute("SELECT COUNT(*) AS n FROM observatory_billing_usage_v1");
			assert.equal(Number(result.rows[0]?.n), 40);
		} finally {
			copy.close();
		}
	});
});
