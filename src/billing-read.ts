/**
 * Billing read projections (WS-B) — the pure shapers behind `GET /api/billing/*`.
 * Read-only over the choreograph libSQL ledger. The orchestrator route resolves
 * the caller's Cognito userId, then calls one of these. Extracted (like
 * `processStripeWebhook`) so the shaping is unit-tested with a REAL store — no HTTP.
 */

import { createHash } from "node:crypto";
import { admissionFloorMicroUsd, type BillingGateMode, readBillingGateMode } from "./billing-gate.js";
import { FREE_TIER_BALANCE_MICRO_USD, resolveBillingFeeBps } from "./billing-pricing.js";
import type { BillingStore, CreditAdjustmentKind, CreditMovementRow, Tier } from "./billing-store.js";

export interface BalanceView {
	userId: string;
	/** Current balance, integer µUSD. An uninitialized user reports the free seed. */
	balanceMicroUsd: number;
	lifetimeUsageMicroUsd: number;
	/**
	 * The admission floor, integer µUSD: -$0.50 while the gate observes (nothing visible
	 * changes before the flip), $0 once it enforces. The gateway refuses a floor above 0
	 * and derives `can_make_requests` from it.
	 */
	floorMicroUsd: number;
	/** false ⇒ no credits row yet (defaults reported). */
	initialized: boolean;
	/**
	 * ADDITIVE (the credits notice is the backend's to turn over, so the SPA publishes once): the service fee in
	 * force, in basis points. 1500 until the flip sets BILLING_FEE_BPS, 2000 after it. Always present.
	 */
	feeBps: number;
	/** ADDITIVE: the live BILLING_GATE_MODE. `enforce` is the flip. Always present. */
	gateMode: BillingGateMode;
	/**
	 * ADDITIVE, absent (no key, never null) unless set: the day credits start, `YYYY-MM-DD`, from the SSM value
	 * CREDITS_START_DATE, for the notice. An unreadable value is absent, never shown wrong.
	 *
	 * THE KEY SET of this view only ever GROWS, and the deployed gateway parses it with `deny_unknown_fields`
	 * and re-projects it, so a key added here reaches nobody (and makes that gateway answer 502) until the gateway
	 * that accepts it has rolled: the gateway rolls first.
	 */
	creditsStartDate?: string;
}

export const CREDITS_START_DATE_ENV = "CREDITS_START_DATE";

export interface CreditsStartDateReading {
	readonly date: string | undefined;
	/** What the boot log says besides the date: a value that is not a date. */
	readonly warnings: readonly string[];
}

/** `CREDITS_START_DATE`: a `YYYY-MM-DD` that is a real calendar day, or nothing. Read at boot like the fee and the mode. */
export function readCreditsStartDate(env: NodeJS.ProcessEnv = process.env): CreditsStartDateReading {
	const raw = env[CREDITS_START_DATE_ENV]?.trim();
	if (!raw) return { date: undefined, warnings: [] };
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
	if (match) {
		const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
		const calendar = new Date(Date.UTC(year, month - 1, day));
		if (calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day) {
			return { date: raw, warnings: [] };
		}
	}
	return {
		date: undefined,
		warnings: [
			`${CREDITS_START_DATE_ENV}=${JSON.stringify(raw)} is not a calendar date written YYYY-MM-DD; the notice carries no date`,
		],
	};
}

export async function readBillingBalance(
	billing: BillingStore,
	userId: string,
	mode?: BillingGateMode,
	env: NodeJS.ProcessEnv = process.env,
): Promise<BalanceView> {
	const credit = await billing.getCredit(userId);
	const gateMode = mode ?? readBillingGateMode(env);
	const { date } = readCreditsStartDate(env);
	return {
		userId,
		balanceMicroUsd: credit?.balanceMicroUsd ?? FREE_TIER_BALANCE_MICRO_USD,
		lifetimeUsageMicroUsd: credit?.lifetimeUsageMicroUsd ?? 0,
		floorMicroUsd: admissionFloorMicroUsd(gateMode),
		initialized: credit !== undefined,
		feeBps: resolveBillingFeeBps(env),
		gateMode,
		...(date ? { creditsStartDate: date } : {}),
	};
}

// ─── The credit history (Sobremesa): a NEW view, so no deployed parser can break ──────────

export const CREDIT_HISTORY_SCHEMA = "sophia.credit-history.v1" as const;
const CREDIT_HISTORY_DEFAULT_LIMIT = 50;
const CREDIT_HISTORY_MAX_LIMIT = 200;

/** A malformed query or cursor: a definite 400, never a 500. */
export class CreditHistoryQueryError extends Error {
	constructor(detail: string) {
		super(`invalid history query: ${detail}`);
		this.name = "CreditHistoryQueryError";
	}
}

export interface CreditHistoryQuery {
	readonly limit: number;
	/**
	 * The cursor of the page before this one (a page's `nextCursor`): continue with entries OLDER than it, in the
	 * same newest-first order. Sent as `after`, the name the gateway forwards and the SPA uses (the house name:
	 * the usage explorer pages with it too); `before` is the same cursor under its earlier name.
	 */
	readonly before: string | undefined;
}

/**
 * Parse `?limit=1..200&after=<cursor>`; `before=<cursor>` is the same cursor under its earlier name, and sending
 * both is refused (one cursor, one name). Anything else (an unknown or repeated parameter) is refused, `from` and
 * `to` included: the gateway documents an epoch-millisecond window for this route, Choreograph's history has none,
 * and a window the authority ignores would be a silent lie, so it is a 400 until there is one.
 */
export function creditHistoryQuery(params: URLSearchParams): CreditHistoryQuery {
	for (const key of new Set(params.keys())) {
		if (key !== "limit" && key !== "after" && key !== "before") {
			throw new CreditHistoryQueryError(`unsupported parameter ${key}`);
		}
		if (params.getAll(key).length > 1) throw new CreditHistoryQueryError(`repeated parameter ${key}`);
	}
	let limit = CREDIT_HISTORY_DEFAULT_LIMIT;
	const rawLimit = params.get("limit");
	if (rawLimit !== null) {
		if (!/^[0-9]{1,4}$/.test(rawLimit)) throw new CreditHistoryQueryError("limit must be a whole number");
		limit = Number(rawLimit);
		if (limit < 1 || limit > CREDIT_HISTORY_MAX_LIMIT) {
			throw new CreditHistoryQueryError(`limit must be between 1 and ${CREDIT_HISTORY_MAX_LIMIT}`);
		}
	}
	const rawAfter = params.get("after");
	const rawBefore = params.get("before");
	if (rawAfter !== null && rawBefore !== null) {
		throw new CreditHistoryQueryError("send one cursor: after and before are the same cursor");
	}
	const cursor = rawAfter ?? rawBefore;
	if (cursor !== null && !/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) {
		throw new CreditHistoryQueryError("cursor is not valid");
	}
	return { limit, before: cursor ?? undefined };
}

export interface CreditHistoryItem {
	/** Opaque and stable: derived from the internal id, which never leaves the host. */
	id: string;
	kind: "top-up" | "monthly-deposit" | "adjustment";
	/** epoch ms. */
	ts: number;
	/** Signed integer µUSD: what this moved the balance by. */
	amountMicroUsd: number;
	label: string;
	/** An adjustment's recorded reason, written for the person; null for a top-up or deposit. */
	reason: string | null;
}

export interface CreditHistoryView {
	schema: typeof CREDIT_HISTORY_SCHEMA;
	userId: string;
	items: CreditHistoryItem[];
	nextCursor: string | null;
}

const ADJUSTMENT_LABELS: Readonly<Record<CreditAdjustmentKind, string>> = {
	goodwill: "Credits added by Sophia",
	operator_funding: "Credits added by Sophia",
	correction: "Balance correction",
	refund: "Refund",
	dispute: "Payment dispute",
};

function encodeCursor(row: CreditMovementRow): string {
	return Buffer.from(JSON.stringify([row.ts, row.id]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { ts: number; id: string } {
	try {
		const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (
			Array.isArray(parsed) &&
			parsed.length === 2 &&
			Number.isSafeInteger(parsed[0]) &&
			typeof parsed[1] === "string"
		) {
			return { ts: parsed[0] as number, id: parsed[1] };
		}
	} catch {
		// fall through: not one of ours
	}
	throw new CreditHistoryQueryError("cursor is not valid");
}

function movementToItem(row: CreditMovementRow): CreditHistoryItem {
	const id = `h_${createHash("sha256").update(row.id).digest("hex").slice(0, 20)}`;
	if (row.source === "grant") {
		const deposit = row.detail === "invoice";
		return {
			id,
			kind: deposit ? "monthly-deposit" : "top-up",
			ts: row.ts,
			amountMicroUsd: row.amountMicroUsd,
			label: deposit ? "Monthly credit deposit" : "Credits added",
			reason: null,
		};
	}
	return {
		id,
		kind: "adjustment",
		ts: row.ts,
		amountMicroUsd: row.amountMicroUsd,
		label: ADJUSTMENT_LABELS[row.detail as CreditAdjustmentKind] ?? "Credit adjustment",
		reason: row.reason,
	};
}

/** What moved this person's balance up or down, newest first. Owner-scoped by construction: one user id. */
export async function readCreditHistory(
	billing: BillingStore,
	userId: string,
	query: { limit: number; before?: string },
): Promise<CreditHistoryView> {
	const before = query.before === undefined ? undefined : decodeCursor(query.before);
	const page = await billing.listCreditMovements(userId, { limit: query.limit, ...(before ? { before } : {}) });
	const last = page.rows.at(-1);
	return {
		schema: CREDIT_HISTORY_SCHEMA,
		userId,
		items: page.rows.map(movementToItem),
		nextCursor: page.hasMore && last ? encodeCursor(last) : null,
	};
}

export interface SubscriptionView {
	userId: string;
	tier: Tier;
	status: string;
	plan: string | null;
	currentPeriodEnd: number | null;
	canManage: boolean;
}

export async function readBillingSubscription(
	billing: BillingStore,
	userId: string,
	portalConfigured = false,
): Promise<SubscriptionView> {
	const sub = await billing.getSubscription(userId);
	const customer = await billing.getCustomer(userId);
	return {
		userId,
		tier: sub?.tier ?? "free",
		status: sub?.status ?? "none",
		plan: sub?.plan ?? null,
		currentPeriodEnd: sub?.currentPeriodEnd ?? null,
		canManage: portalConfigured && customer !== undefined,
	};
}

export interface UsageView {
	userId: string;
	fromTs: number;
	toTs: number;
	totalMicroUsd: number;
	eventCount: number;
}

export async function readBillingUsage(
	billing: BillingStore,
	userId: string,
	fromTs: number,
	toTs: number,
): Promise<UsageView> {
	const usage = await billing.sumByUser(userId, fromTs, toTs);
	return { userId, fromTs, toTs, totalMicroUsd: usage.totalMicroUsd, eventCount: usage.n };
}

/** Resolve the usage window: optional `?from`/`?to` (epoch ms), else trailing 30 days. */
export function usageWindow(
	fromParam: string | null,
	toParam: string | null,
	now: number,
): { fromTs: number; toTs: number } {
	const parse = (v: string | null, fallback: number): number => {
		// Treat an empty param (`?from=`) like an absent one — Number("") is 0, which
		// would otherwise silently mean "since epoch" instead of the default window.
		const n = v == null || v === "" ? Number.NaN : Number(v);
		return Number.isFinite(n) ? n : fallback;
	};
	const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
	return { fromTs: parse(fromParam, now - THIRTY_DAYS_MS), toTs: parse(toParam, now) };
}
