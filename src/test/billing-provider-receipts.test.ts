import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { reconcileOpenRouterReceipts } from "../billing-provider-receipts.js";
import { BillingStore, type UsageEventInput } from "../billing-store.js";

/**
 * What a call really cost is OpenRouter's to say, in its generation record: which upstream provider served it, the
 * native token counts it billed and the total it charged. Until 2026-10-01 the ledger kept neither the generation id
 * nor any provider receipt, and its `provider_reported_cost_micro_usd` held Pi's own arithmetic over a static table
 * (price-gap/FINDINGS.md). Now a usage event keeps the generation id, and a reconciler reads each generation record
 * into an append-only receipts table beside the ledger. The ledger row is never rewritten.
 *
 * Real store (libSQL file), real HTTP: a local server stands in for OpenRouter's generation endpoint.
 */

function usage(eventId: string, providerGenerationId: string | null): UsageEventInput {
	return {
		eventId,
		ts: Date.parse("2026-10-01T22:08:20Z"),
		userId: "user-a",
		graphId: "graph-a",
		sandboxId: "sbx-a",
		template: "agent",
		sessionId: "ags_a",
		generation: 0,
		inferenceOperationId: eventId,
		requestId: "prime-llm-0",
		childRunId: null,
		allocationId: null,
		provider: "openrouter",
		model: "moonshotai/kimi-k2.6",
		modelPriced: "moonshotai/kimi-k2.6",
		reason: "stop",
		inputTokens: 509,
		outputTokens: 32,
		cacheReadTokens: 763,
		cacheWriteTokens: 0,
		totalTokens: 1304,
		inputCostMicroUsd: 221,
		outputCostMicroUsd: 59,
		cacheReadCostMicroUsd: 56,
		cacheWriteCostMicroUsd: 0,
		providerCostMicroUsd: 336,
		providerReportedCostMicroUsd: null,
		markupMicroUsd: 51,
		costMicroUsd: 387,
		pricingVersion: "cat:abbd7d8ab327@2026-10-01T22:06:04.537Z",
		pricedDefault: false,
		providerGenerationId,
	} as UsageEventInput;
}

async function withGenerationServer(
	records: Map<string, Record<string, unknown>>,
	body: (base: string, seen: { ids: string[]; auth: string[] }) => Promise<void>,
): Promise<void> {
	const seen = { ids: [] as string[], auth: [] as string[] };
	const server = createServer((request: IncomingMessage, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const id = url.searchParams.get("id") ?? "";
		seen.ids.push(id);
		seen.auth.push(String(request.headers.authorization ?? ""));
		const record = url.pathname === "/api/v1/generation" ? records.get(id) : undefined;
		if (!record) {
			response.writeHead(404, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "Generation not found", code: 404 } }));
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ data: record }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	try {
		await body(`http://127.0.0.1:${port}/api/v1`, seen);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

async function withStore(body: (store: BillingStore) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "receipts-"));
	const store = new BillingStore(join(dir, "billing.sqlite"));
	await store.init();
	try {
		await body(store);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

const GEN_A = "gen-1790893024-TZYksidy0cQRoBKpJHBH";
const GEN_B = "gen-1790893037-q1pDLxwRYsUzXsDwvbGs";
const RECORD_A = {
	id: GEN_A,
	provider_name: "Baidu",
	model: "moonshotai/kimi-k2.6",
	total_cost: 0.00033526891,
	upstream_inference_cost: 0.00033526891,
	cache_discount: 0.00027551,
	native_tokens_prompt: 1272,
	native_tokens_completion: 32,
	native_tokens_cached: 763,
	native_tokens_reasoning: 32,
	is_byok: false,
};

describe("a usage event keeps the provider's generation id", () => {
	it("round-trips it through the ledger", async () => {
		await withStore(async (store) => {
			assert.equal(await store.recordUsage(usage("evt-a", GEN_A)), true);
			assert.equal((await store.getEvent("evt-a"))?.providerGenerationId, GEN_A);
			assert.equal(await store.recordUsage(usage("evt-none", null)), true);
			assert.equal((await store.getEvent("evt-none"))?.providerGenerationId, null);
		});
	});
});

describe("the receipts reconciler", () => {
	it("records the provider that served a call and what OpenRouter charged, from its own generation record", async () => {
		await withStore(async (store) => {
			await store.recordUsage(usage("evt-a", GEN_A));
			await withGenerationServer(new Map([[GEN_A, RECORD_A]]), async (baseUrl, seen) => {
				const result = await reconcileOpenRouterReceipts({
					store,
					apiKey: "or-test-key",
					baseUrl,
					now: () => 1_790_893_100_000,
				});
				assert.deepEqual(result, { fetched: 1, pending: 0, failed: 0 });
				const receipt = await store.getProviderReceipt("evt-a");
				assert.ok(receipt);
				assert.equal(receipt.generationId, GEN_A);
				assert.equal(receipt.servedProvider, "Baidu");
				assert.equal(receipt.totalCostMicroUsd, 335);
				assert.equal(receipt.nativePromptTokens, 1272);
				assert.equal(receipt.nativeCompletionTokens, 32);
				assert.equal(receipt.nativeCachedTokens, 763);
				assert.equal(receipt.cacheDiscountMicroUsd, 276);
				assert.equal(receipt.fetchedAt, 1_790_893_100_000);
				assert.deepEqual(seen.auth, ["Bearer or-test-key"], "the key goes to the provider, in the header, once");
				// The ledger row is not rewritten: the receipt sits beside it.
				assert.equal((await store.getEvent("evt-a"))?.providerReportedCostMicroUsd, null);
			});
		});
	});

	it("leaves a record that is not ready yet for the next run, and never asks twice for one it has", async () => {
		await withStore(async (store) => {
			await store.recordUsage(usage("evt-a", GEN_A));
			await store.recordUsage(usage("evt-b", GEN_B));
			await store.recordUsage(usage("evt-none", null));
			const records = new Map<string, Record<string, unknown>>([[GEN_A, RECORD_A]]);
			await withGenerationServer(records, async (baseUrl, seen) => {
				assert.deepEqual(await reconcileOpenRouterReceipts({ store, apiKey: "k", baseUrl }), {
					fetched: 1,
					pending: 1,
					failed: 0,
				});
				assert.equal(await store.getProviderReceipt("evt-b"), undefined);
				records.set(GEN_B, { ...RECORD_A, id: GEN_B, total_cost: 0.00033093655, native_tokens_cached: 775 });
				assert.deepEqual(await reconcileOpenRouterReceipts({ store, apiKey: "k", baseUrl }), {
					fetched: 1,
					pending: 0,
					failed: 0,
				});
				assert.equal((await store.getProviderReceipt("evt-b"))?.totalCostMicroUsd, 331);
				assert.deepEqual(
					seen.ids,
					[GEN_A, GEN_B, GEN_B],
					"an event without a generation id is never asked about; one with a receipt is not asked again",
				);
			});
		});
	});
});
