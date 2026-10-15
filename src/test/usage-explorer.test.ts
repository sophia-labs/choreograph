import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createClient } from "@libsql/client";
import { BillingStore, type UsageEventInput } from "../billing-store.js";
import { checkedUsageEvent, currentUsageEvent, readUsageExplorer, usagePageQuery } from "../usage-explorer.js";

const event = (id: string, userId = "alice"): UsageEventInput => ({
	eventId: id,
	userId,
	ts: 100,
	graphId: "graph",
	sandboxId: null,
	template: "chat",
	provider: "provider",
	model: "model",
	modelPriced: "model",
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
	pricingVersion: "fixture",
	pricedDefault: false,
});

describe("owner usage explorer", () => {
	it("paginates equal timestamps across both sources without duplicating, crossing owners, or touching credits", async () => {
		const dir = mkdtempSync(join(tmpdir(), "usage-explorer-"));
		after(() => rmSync(dir, { recursive: true, force: true }));
		const path = join(dir, "billing.sqlite");
		const billing = new BillingStore(path);
		await billing.init();
		after(() => billing.close());
		for (const id of ["b", "a", "c"]) await billing.recordUsage(event(id));
		await billing.recordUsage(event("private", "bob"));
		const native = await billing.getEvent("a");
		assert.ok(native);
		const historical = {
			...currentUsageEvent(native),
			id: "cloud-1:old",
			source: "cloud-1",
			session_token: "never exposed",
		};
		const db = createClient({ url: `file:${path}` });
		await db.execute({
			sql: "INSERT INTO legacy_usage_history VALUES(?,?,?,?,?)",
			args: ["alice", "old", 100, JSON.stringify(historical), "fixture"],
		});
		await db.execute({
			sql: "INSERT INTO legacy_usage_imports VALUES(?,?,?,?)",
			args: ["alice", "2026-09-21T00:00:00Z", "fixture", 1],
		});
		db.close();
		const ids: string[] = [];
		let params = new URLSearchParams("limit=1");
		for (let i = 0; i < 5; i++) {
			const page = await readUsageExplorer(billing, "alice", usagePageQuery("alice", params, 200));
			assert.equal(page.coverage.find((c) => c.source === "sirin")?.eventCount, 3);
			assert.equal(page.coverage.find((c) => c.source === "cloud-1")?.state, "imported-snapshot");
			assert.ok(!JSON.stringify(page).includes("never exposed"));
			ids.push(...page.items.map((v) => v.id));
			if (!page.nextCursor) break;
			assert.throws(() => usagePageQuery("bob", new URLSearchParams({ after: page.nextCursor! }), 200));
			params = new URLSearchParams({ limit: "1", after: page.nextCursor });
		}
		assert.deepEqual(ids, ["cloud-1:old", "sirin:a", "sirin:b", "sirin:c"]);
		assert.equal(await billing.getCredit("alice"), undefined);
		const empty = await readUsageExplorer(
			billing,
			"alice",
			usagePageQuery("alice", new URLSearchParams("from=101&to=200"), 200),
		);
		assert.equal(empty.items.length, 0);
		assert.equal(empty.coverage.find((c) => c.source === "sirin")?.eventCount, 3);
		const outsider = await readUsageExplorer(
			billing,
			"charlie",
			usagePageQuery("charlie", new URLSearchParams(), 200),
		);
		assert.equal(outsider.items.length, 0);
		assert.equal(outsider.coverage.find((c) => c.source === "cloud-1")?.state, "not-imported");
	});
	it("rejects ambiguous, oversized and unsafe queries", () => {
		for (const query of [
			"limit=0",
			"limit=201",
			"limit=1&limit=2",
			"from=2&to=1",
			"to=9007199254740992",
			"owner=bob",
			"after=bad",
			"from=-1",
			"from=1.5",
			"to=201",
		]) {
			assert.throws(() => usagePageQuery("alice", new URLSearchParams(query), 200), query);
		}
	});
	it("rejects unsafe costs and copies only explicit event fields", () => {
		assert.throws(() => checkedUsageEvent({ id: "cloud-1:x", costMicroUsd: Number.MAX_SAFE_INTEGER + 1 }));
	});
});
