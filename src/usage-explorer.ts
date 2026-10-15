import { Buffer } from "node:buffer";
import type { BillingStore, UsageEventRecord } from "./billing-store.js";

export interface UsageExplorerEvent {
	id: string;
	source: "sirin" | "cloud-1";
	ts: number;
	recordedAt: string;
	timezone: "utc" | "unspecified";
	provider: string;
	model: string;
	status: string;
	surface: string | null;
	graphId: string | null;
	sessionId: string | null;
	fundingSource: "platform" | "user" | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	totalTokens: number | null;
	costMicroUsd: number;
	providerCostMicroUsd: number | null;
	providerReportedCostMicroUsd: number | null;
	markupMicroUsd: number | null;
}

export interface UsagePageQuery {
	from: number;
	to: number;
	limit: number;
	beforeTs: number;
	afterKey: string;
}

const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Copy an allowlist; stored source material can never add credential fields. */
export function checkedUsageEvent(value: unknown): UsageExplorerEvent {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid usage record");
	const v = value as Record<string, unknown>;
	const text = (key: string, nullable = false): string | null => {
		const s = v[key];
		if (nullable && s === null) return null;
		if (typeof s !== "string" || s.length > 1024) throw new Error("Invalid usage field");
		return s;
	};
	const number = (key: string, nullable = true): number | null => {
		const n = v[key];
		if (nullable && n === null) return null;
		if (!integer(n)) throw new Error("Invalid usage number");
		return n;
	};
	if (
		!["sirin", "cloud-1"].includes(String(v.source)) ||
		!["utc", "unspecified"].includes(String(v.timezone)) ||
		![null, "platform", "user"].includes(v.fundingSource as null | string)
	)
		throw new Error("Invalid usage source");
	const id = text("id")!;
	if (!id.startsWith(`${v.source}:`)) throw new Error("Invalid usage identity");
	return {
		id,
		source: v.source as UsageExplorerEvent["source"],
		ts: number("ts", false)!,
		recordedAt: text("recordedAt")!,
		timezone: v.timezone as UsageExplorerEvent["timezone"],
		provider: text("provider")!,
		model: text("model")!,
		status: text("status")!,
		surface: text("surface", true),
		graphId: text("graphId", true),
		sessionId: text("sessionId", true),
		fundingSource: v.fundingSource as UsageExplorerEvent["fundingSource"],
		inputTokens: number("inputTokens"),
		outputTokens: number("outputTokens"),
		cacheReadTokens: number("cacheReadTokens"),
		cacheWriteTokens: number("cacheWriteTokens"),
		totalTokens: number("totalTokens"),
		costMicroUsd: number("costMicroUsd", false)!,
		providerCostMicroUsd: number("providerCostMicroUsd"),
		providerReportedCostMicroUsd: number("providerReportedCostMicroUsd"),
		markupMicroUsd: number("markupMicroUsd"),
	};
}

export function currentUsageEvent(e: UsageEventRecord): UsageExplorerEvent {
	return checkedUsageEvent({
		id: `sirin:${e.eventId}`,
		source: "sirin",
		ts: e.ts,
		recordedAt: new Date(e.ts).toISOString(),
		timezone: "utc",
		provider: e.provider,
		model: e.model,
		status: e.reason ?? "recorded",
		surface: e.template,
		graphId: e.graphId,
		sessionId: e.sessionId,
		fundingSource: e.fundingSource ?? null,
		inputTokens: e.inputTokens,
		outputTokens: e.outputTokens,
		cacheReadTokens: e.cacheReadTokens,
		cacheWriteTokens: e.cacheWriteTokens,
		totalTokens: e.totalTokens,
		costMicroUsd: e.costMicroUsd,
		providerCostMicroUsd: e.providerCostMicroUsd,
		providerReportedCostMicroUsd: e.providerReportedCostMicroUsd ?? null,
		markupMicroUsd: e.markupMicroUsd,
	});
}

export function usagePageQuery(userId: string, params: URLSearchParams, now = Date.now()): UsagePageQuery {
	for (const key of params.keys()) {
		if (!["after", "limit", "from", "to"].includes(key) || params.getAll(key).length !== 1)
			throw new Error("Invalid usage query");
	}
	const parse = (s: string | null, fallback: number): number => {
		if (s === null) return fallback;
		if (!/^\d+$/.test(s) || !integer(Number(s))) throw new Error("Invalid usage query");
		return Number(s);
	};
	const limit = parse(params.get("limit"), 100);
	if (limit < 1 || limit > 200) throw new Error("Invalid usage limit");
	const after = params.get("after");
	if (after) {
		if (after.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(after) || params.has("from") || params.has("to"))
			throw new Error("Invalid usage cursor");
		const c = JSON.parse(Buffer.from(after, "base64url").toString("utf8"));
		if (
			c.userId !== userId ||
			!integer(c.from) ||
			!integer(c.to) ||
			c.from >= c.to ||
			c.to > now ||
			!integer(c.ts) ||
			c.ts < c.from ||
			c.ts >= c.to ||
			typeof c.key !== "string" ||
			c.key.length > 1100
		)
			throw new Error("Invalid usage cursor");
		return { from: c.from, to: c.to, limit, beforeTs: c.ts, afterKey: c.key };
	}
	const from = parse(params.get("from"), 0),
		to = parse(params.get("to"), now);
	if (from >= to || to > now) throw new Error("Invalid usage window");
	return { from, to, limit, beforeTs: to, afterKey: "" };
}

export async function readUsageExplorer(billing: BillingStore, userId: string, query: UsagePageQuery) {
	const page = await billing.usageExplorerPage(userId, query);
	const items = page.items.slice(0, query.limit);
	const last = items.at(-1);
	const nextCursor =
		page.items.length > query.limit && last
			? Buffer.from(JSON.stringify({ userId, from: query.from, to: query.to, ts: last.ts, key: last.id })).toString(
					"base64url",
				)
			: null;
	return {
		schema: "sophia.usage-explorer.v1",
		userId,
		fromTs: query.from,
		toTs: query.to,
		items,
		nextCursor,
		coverage: page.coverage,
	};
}
