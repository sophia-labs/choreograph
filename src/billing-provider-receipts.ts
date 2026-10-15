/**
 * Provider receipts: what a call really cost, from the provider's own record (price-gap, 2026-10-01).
 *
 * The ledger prices every call from the Session's rate card (deterministic; what the person is charged). Until this
 * module, nothing kept what OpenRouter actually charged: `provider_reported_cost_micro_usd` held Pi's `usage.cost`,
 * which Pi computes from a static table in its own catalogue, and the generation id was dropped before settlement.
 * Now settlement keeps the generation id on the usage event, and this reconciler reads each generation record
 * (`GET /api/v1/generation?id=…`: the upstream provider that served the call, the native tokens it billed, the total it
 * charged, any cache discount) into `usage_provider_receipts`, one append-only row per event. A record the provider
 * has not published yet (it lags a few seconds) is left for the next run; the ledger row is never rewritten.
 *
 * Wiring (a timer or an operator route) is the caller's; this module is pure apart from the store and the fetch.
 */
import type { BillingStore, ProviderReceipt } from "./billing-store.js";

export interface ReconcileOpenRouterReceiptsInput {
	readonly store: BillingStore;
	/** The OpenRouter key whose calls these are; sent only to `baseUrl`, in the Authorization header. */
	readonly apiKey: string;
	readonly baseUrl?: string;
	readonly fetchImpl?: typeof fetch;
	readonly limit?: number;
	readonly now?: () => number;
	readonly timeoutMs?: number;
}

export interface ReconcileResult {
	/** Receipts written by this run. */
	readonly fetched: number;
	/** Records the provider has not published yet (404): asked again next run. */
	readonly pending: number;
	/** Any other failure (bad answer, network): asked again next run. */
	readonly failed: number;
}

const DEFAULT_BASE = "https://openrouter.ai/api/v1";

function micros(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
	const m = Math.round(value * 1_000_000);
	return Number.isSafeInteger(m) ? m : null;
}

function count(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Read the receipts the ledger still lacks, oldest first, at most `limit` of them. */
export async function reconcileOpenRouterReceipts(input: ReconcileOpenRouterReceiptsInput): Promise<ReconcileResult> {
	const fetchImpl = input.fetchImpl ?? fetch;
	const base = (input.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
	const now = input.now ?? Date.now;
	const due = await input.store.usageEventsAwaitingReceipt(input.limit ?? 100);
	let fetched = 0;
	let pending = 0;
	let failed = 0;
	for (const { eventId, generationId } of due) {
		let response: Response;
		try {
			response = await fetchImpl(`${base}/generation?id=${encodeURIComponent(generationId)}`, {
				headers: { authorization: `Bearer ${input.apiKey}` },
				signal: AbortSignal.timeout(input.timeoutMs ?? 20_000),
			});
		} catch {
			failed += 1;
			continue;
		}
		if (response.status === 404) {
			await response.body?.cancel();
			pending += 1;
			continue;
		}
		if (!response.ok) {
			await response.body?.cancel();
			failed += 1;
			continue;
		}
		let data: Record<string, unknown> | undefined;
		try {
			const body = (await response.json()) as { data?: unknown };
			data =
				typeof body.data === "object" && body.data !== null ? (body.data as Record<string, unknown>) : undefined;
		} catch {
			data = undefined;
		}
		const total = micros(data?.total_cost);
		if (!data || total === null || (typeof data.id === "string" && data.id !== generationId)) {
			failed += 1;
			continue;
		}
		const receipt: ProviderReceipt = {
			eventId,
			generationId,
			servedProvider: typeof data.provider_name === "string" && data.provider_name ? data.provider_name : null,
			totalCostMicroUsd: total,
			upstreamCostMicroUsd: micros(data.upstream_inference_cost),
			cacheDiscountMicroUsd: micros(data.cache_discount),
			nativePromptTokens: count(data.native_tokens_prompt),
			nativeCompletionTokens: count(data.native_tokens_completion),
			nativeCachedTokens: count(data.native_tokens_cached),
			nativeReasoningTokens: count(data.native_tokens_reasoning),
			fetchedAt: now(),
		};
		if (await input.store.recordProviderReceipt(receipt)) fetched += 1;
	}
	return { fetched, pending, failed };
}
