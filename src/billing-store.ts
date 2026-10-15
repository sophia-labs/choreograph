/**
 * Billing Phase 0 (OBSERVE) — usage-event ledger.
 *
 * An immutable, append-only libSQL/Turso table that records ONE row per LLM
 * proxy request with its computed integer-µUSD cost. This is the *usage truth*
 * a later billing phase reads — it does NOT decrement balances, gate requests,
 * or touch money. OBSERVE only.
 *
 * Engine + durability mirror `SessionStore` / `JournalStore`: `@libsql/client`
 * (so a bare `file:` path today and a hosted `libsql://` URL later share one
 * schema), sync ctor, awaited `init()`, `VACUUM INTO` + `aws s3 cp` snapshot
 * gated on `BILLING_DB_S3_URL` (no-op when unset — local/dev stays file-only).
 *
 * Append semantics: `recordUsage` is a SINGLE atomic statement,
 * `INSERT … ON CONFLICT(event_id) DO NOTHING`. The key is the LLM `request_id`,
 * so a duplicate is a silent no-op (the FIRST write wins; the row is never
 * mutated). There is NO UPDATE or DELETE on this table anywhere — it is
 * immutable by construction. FAIL_SOFT is the CALLER's job (the wire point
 * wraps the call in `.catch`); this store just refuses to corrupt itself.
 */

import type { Client } from "@libsql/client";
import { trace } from "@opentelemetry/api";
import { FREE_TIER_BALANCE_MICRO_USD } from "./billing-pricing.js";
import { LibsqlStore } from "./persistence/libsql-store.js";
import { checkedUsageEvent, currentUsageEvent, type UsagePageQuery } from "./usage-explorer.js";

const tracer = trace.getTracer("sandbox-mgmt.billing");

// ─── Types ──────────────────────────────────────────────────────────────

/** Source of provider payment, pinned by host credential selection. */
export type InferenceFundingSource = "platform" | "user";

/** What the wire point hands to `recordUsage`. Cost fields are integer µUSD telemetry. */
export interface UsageEventInput {
	/** Host-pinned funding; absent historical records retain platform semantics. */
	fundingSource?: InferenceFundingSource;
	/** = LLM request_id (msg.request_id). Idempotency key. */
	eventId: string;
	/** epoch ms, capture time. */
	ts: number;
	/** Cognito sub (SandboxRecord.owner_user_id); null = unattributed. */
	userId: string | null;
	/** Billing context (informational in P0); null when unknown. */
	graphId: string | null;
	/** Provenance — the sandbox that issued the request. */
	sandboxId: string | null;
	/** Provenance — matches the OTEL `template` label. */
	template: string | null;
	/** Durable Agent Session provenance when the usage came from a hosted agent. */
	sessionId?: string | null;
	/** Fenced Agent Session materialization generation. */
	generation?: number | null;
	/** Host-derived durable inference-operation identity. */
	inferenceOperationId?: string | null;
	/** Worker request identity within the fenced materialization. */
	requestId?: string | null;
	/** Hosted child-run provenance when this Session was admitted as a child. */
	childRunId?: string | null;
	/** Parent-owned child budget allocation associated with this Session. */
	allocationId?: string | null;
	/** Resolved inference provider at the egress boundary. */
	provider: string;
	/** Raw model id as requested (pre-normalization). */
	model: string;
	/** Normalized key actually used for pricing. */
	modelPriced: string;
	/** done.reason | error.reason; null if absent. */
	reason: string | null;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	inputCostMicroUsd: number;
	outputCostMicroUsd: number;
	cacheReadCostMicroUsd: number;
	cacheWriteCostMicroUsd: number;
	providerCostMicroUsd: number;
	/** Provider-reported receipt, when available; never used as deterministic pricing truth. */
	providerReportedCostMicroUsd?: number | null;
	/** The provider's own id for the call (OpenRouter: the generation id), so its receipt can be looked up. */
	providerGenerationId?: string | null;
	/**
	 * What the costs above were priced from, for a Session priced from a card: `card` (the card, as every call is
	 * normally); `fallback-actual` (a call OpenRouter could not serve under the card, retried without the ceiling and
	 * billed at its reported charge plus the card's markup); `fallback-card` (such a call whose charge did not come back:
	 * billed at the card). Absent for a legacy Session priced by the static table.
	 */
	pricingBasis?: "card" | "fallback-actual" | "fallback-card" | null;
	/** The card's figures for the same tokens, kept beside a fallback's actual (and equal to the costs otherwise). */
	cardCostMicroUsd?: number | null;
	cardProviderCostMicroUsd?: number | null;
	markupMicroUsd: number;
	/** total = provider + markup. */
	costMicroUsd: number;
	/** Which rate table produced this row (re-derivability / audit). */
	pricingVersion: string;
	/** true if the DEFAULT_PRICING fallback was used. */
	pricedDefault: boolean;
}

/** What the provider said a call cost, from its own generation record (OpenRouter `GET /api/v1/generation`). */
export interface ProviderReceipt {
	eventId: string;
	generationId: string;
	servedProvider: string | null;
	totalCostMicroUsd: number;
	upstreamCostMicroUsd: number | null;
	cacheDiscountMicroUsd: number | null;
	nativePromptTokens: number | null;
	nativeCompletionTokens: number | null;
	nativeCachedTokens: number | null;
	nativeReasoningTokens: number | null;
	fetchedAt: number;
}

/** A row read back from the ledger. */
export interface UsageEventRecord extends UsageEventInput {
	kind: string;
	sessionId: string | null;
	generation: number | null;
	inferenceOperationId: string | null;
	requestId: string | null;
	childRunId: string | null;
	allocationId: string | null;
}

/** Billing Phase 1 — a row read back from the `credits` ledger. */
export interface CreditRecord {
	/** Cognito sub. */
	userId: string;
	/** Current balance, integer µUSD. May be negative: a call already made is always debited. */
	balanceMicroUsd: number;
	/** Cumulative debited usage, integer µUSD. */
	lifetimeUsageMicroUsd: number;
	/** epoch ms of the last debit/lazy-init. */
	updatedAt: number;
}

// ─── Sobremesa credits: the gate's record ───────────────────────────────

export const GATE_MODES = ["observe", "enforce"] as const;
export type GateMode = (typeof GATE_MODES)[number];

/** Where a decision was taken: the two ingress doors, the per-call clamp, the Hoja evaluators. */
export const GATE_DOORS = ["ingress.invocation", "ingress.command", "call", "evaluator"] as const;
export type GateDoor = (typeof GATE_DOORS)[number];

/** The non-trivial decisions; plain allows are counted, not logged (`gate_daily_counts`). */
export const GATE_DECISIONS = [
	"would_block",
	"block",
	"would_clamp",
	"clamp",
	"model_unpriced",
	"fail_open",
	"exempt",
	"provider_unavailable",
] as const;
export type GateDecision = (typeof GATE_DECISIONS)[number];

const GATE_REASON_MAX_CHARS = 500;

export interface GateEventInput {
	/** epoch ms. */
	ts: number;
	/** Cognito sub; null when the decision had no attributable owner. */
	userId: string | null;
	mode: GateMode;
	door: GateDoor;
	decision: GateDecision;
	/** The voice (model id) the call asked for, when known. */
	model: string | null;
	/** Spendable balance the decision saw (ledger balance minus holds), integer µUSD. */
	balanceMicroUsd: number | null;
	/** What the smallest viable call needed, integer µUSD. */
	requiredMicroUsd: number | null;
	/** Free text, `key=value` pairs; bounded to 500 characters. */
	reason: string | null;
}

export interface GateEventRecord extends GateEventInput {
	id: number;
}

export interface GateCounterDelta {
	/** UTC day, `YYYY-MM-DD`. */
	day: string;
	mode: GateMode;
	door: GateDoor;
	decision: GateDecision | "allow";
	/** Positive count to add. */
	n: number;
}

export type GateCounterRecord = GateCounterDelta;

// ─── Sobremesa credits: signed adjustments ──────────────────────────────

/**
 * What an adjustment is for. The ledger had no signed path (`credit_grants.amount > 0` is a CHECK), so
 * goodwill, forgiven overdrafts, refunds, chargebacks and operator funding of test accounts had nowhere to go.
 */
export const CREDIT_ADJUSTMENT_KINDS = ["goodwill", "operator_funding", "correction", "refund", "dispute"] as const;
export type CreditAdjustmentKind = (typeof CREDIT_ADJUSTMENT_KINDS)[number];

const ADJUSTMENT_REASON_MAX_CHARS = 500;
const ADJUSTMENT_TEXT_MAX_CHARS = 200;

export interface CreditAdjustmentInput {
	/** THE idempotency key: `ops:<batch>:<label>` for an operator, `refund:<pi>:<cents>` from Stripe. */
	adjustmentId: string;
	userId: string;
	/** Signed, non-zero, integer µUSD. Positive credits the person; negative claws back. */
	amountMicroUsd: number;
	kind: CreditAdjustmentKind;
	/** Free text. The person SEES it in their credit history: write it for them. */
	reason: string;
	/** Who or what applied it: `script:<name>`, `operator:<name>`, `stripe:webhook`. Never shown to the person. */
	actor: string;
	batchId?: string | null;
	/** What it relates to (a Stripe payment intent id, a ticket). Never shown to the person. */
	sourceRef?: string | null;
}

export interface CreditAdjustmentRecord {
	adjustmentId: string;
	userId: string;
	amountMicroUsd: number;
	kind: CreditAdjustmentKind;
	reason: string;
	actor: string;
	batchId: string | null;
	sourceRef: string | null;
	createdAt: number;
}

export interface AdjustmentResult {
	/** false = this key had already been applied (a replay): nothing moved. */
	isNew: boolean;
	/** The person's balance after the call (the current balance, for a replay). */
	balanceMicroUsd: number;
}

/** One row of a person's credit history, before it is shaped for them. */
export interface CreditMovementRow {
	/** `g:<grant_id>` or `a:<adjustment_id>`: internal, never sent to the person as is. */
	id: string;
	source: "grant" | "adjustment";
	ts: number;
	amountMicroUsd: number;
	/** The grant's stripe object, or the adjustment's kind. */
	detail: string;
	/** An adjustment's recorded reason; null for a grant. */
	reason: string | null;
}

/** A top-up's PaymentIntent, as recorded when its credit was granted (refund and dispute matching). */
export interface GrantPaymentRecord {
	paymentIntentId: string;
	grantId: string;
	userId: string;
	chargeAmountCents: number;
	creditedMicroUsd: number;
	currency: string;
}

/** What raised a durable alarm (E §4.4.5: an alarm instead of a silent skip). */
export const BILLING_ALARM_KINDS = [
	"non_usd_payment",
	"unmapped_customer",
	"user_mismatch",
	"bad_topup_amount",
	"unmatched_payment",
	"clawback_currency_mismatch",
] as const;
export type BillingAlarmKind = (typeof BILLING_ALARM_KINDS)[number];

export interface BillingAlarmInput {
	kind: BillingAlarmKind;
	eventId: string | null;
	eventType: string | null;
	userId: string | null;
	/** The Stripe object the alarm is about (a session, a charge, a dispute, a customer). */
	objectId: string | null;
	detail: string | null;
}

export interface BillingAlarmRecord extends BillingAlarmInput {
	/** `<kind>:<event id>`: an alarm is raised once per event, however often Stripe redelivers it. */
	alarmKey: string;
	ts: number;
}

/** A refund or dispute to claw back from the top-up it belongs to. */
export interface PaymentClawbackInput {
	kind: "refund" | "dispute";
	/** The adjustment's idempotency key: `refund:<charge>:<cumulative cents>` or `dispute:<dispute>`. */
	adjustmentId: string;
	paymentIntentId: string | null;
	currency: string;
	livemode: number;
	/** refund: the CUMULATIVE cents refunded on the charge; dispute: the disputed cents. */
	affectedCents: number;
	/** Shown to the person in their credit history: write it for them. */
	reason: string;
}

export type ClawbackResult =
	| { applied: true; amountMicroUsd: number; balanceMicroUsd: number }
	| {
			applied: false;
			reason: "duplicate" | "nothing_to_claw_back" | "unmatched_payment" | "currency_mismatch" | "test_mode";
	  };

function validateAdjustment(a: CreditAdjustmentInput): void {
	if (typeof a.adjustmentId !== "string" || !a.adjustmentId.trim() || a.adjustmentId.length > 200) {
		throw new Error("credit adjustment: adjustmentId is required (at most 200 characters)");
	}
	if (typeof a.userId !== "string" || !a.userId.trim()) throw new Error("credit adjustment: userId is required");
	if (!Number.isSafeInteger(a.amountMicroUsd) || a.amountMicroUsd === 0) {
		throw new Error("credit adjustment: amountMicroUsd must be a non-zero safe integer");
	}
	if (!(CREDIT_ADJUSTMENT_KINDS as readonly string[]).includes(a.kind)) {
		throw new Error(`credit adjustment: unknown kind ${JSON.stringify(a.kind)}`);
	}
	if (typeof a.reason !== "string" || !a.reason.trim()) throw new Error("credit adjustment: reason is required");
	if (typeof a.actor !== "string" || !a.actor.trim()) throw new Error("credit adjustment: actor is required");
}

function validateGateEvent(e: GateEventInput): void {
	if (!(GATE_MODES as readonly string[]).includes(e.mode)) {
		throw new Error(`gate event: unknown mode ${JSON.stringify(e.mode)}`);
	}
	if (!(GATE_DOORS as readonly string[]).includes(e.door)) {
		throw new Error(`gate event: unknown door ${JSON.stringify(e.door)}`);
	}
	if (!(GATE_DECISIONS as readonly string[]).includes(e.decision)) {
		throw new Error(`gate event: unknown decision ${JSON.stringify(e.decision)}`);
	}
	if (!Number.isSafeInteger(e.ts)) throw new Error("gate event: ts must be an integer epoch ms");
	for (const [name, value] of [
		["balanceMicroUsd", e.balanceMicroUsd],
		["requiredMicroUsd", e.requiredMicroUsd],
	] as const) {
		if (value !== null && !Number.isSafeInteger(value)) {
			throw new Error(`gate event: ${name} must be an integer µUSD or null`);
		}
	}
}

function validateGateCounter(row: GateCounterDelta): void {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(row.day)) throw new Error(`gate counter: day must be YYYY-MM-DD, got ${row.day}`);
	if (!(GATE_MODES as readonly string[]).includes(row.mode)) {
		throw new Error(`gate counter: unknown mode ${JSON.stringify(row.mode)}`);
	}
	if (!(GATE_DOORS as readonly string[]).includes(row.door)) {
		throw new Error(`gate counter: unknown door ${JSON.stringify(row.door)}`);
	}
	if (row.decision !== "allow" && !(GATE_DECISIONS as readonly string[]).includes(row.decision)) {
		throw new Error(`gate counter: unknown decision ${JSON.stringify(row.decision)}`);
	}
	if (!Number.isSafeInteger(row.n) || row.n <= 0) throw new Error("gate counter: count must be a positive integer");
}

// ─── Store ──────────────────────────────────────────────────────────────

/** A row read back from the `customer_map` ownership seam. */
export interface CustomerMapRecord {
	/** Cognito sub. */
	userId: string;
	/** Stripe `cus_…`, 1:1 with userId. */
	stripeCustomerId: string;
	/** Convenience copy of the Stripe email (NOT an identity authority). */
	email: string | null;
	createdAt: number;
	updatedAt: number;
}

/**
 * The webhook envelope handed to `recordGrantAndCredit` — the MESSAGE dedupe
 * row. The route layer (DEFERRED) verifies the Stripe signature off the RAW
 * body and supplies `payloadSha256`; this store never sees the raw bytes.
 */
export interface StripeWebhookInput {
	/** Stripe `evt_…` — the message idempotency key (redelivery dedupe). */
	eventId: string;
	/** e.g. `checkout.session.completed` | `payment_intent.succeeded`. */
	eventType: string;
	/** Stripe `created`, epoch seconds; null if absent. */
	stripeCreated: number | null;
	/** Stripe API version that produced the event (replay safety); null if absent. */
	apiVersion: string | null;
	/** 1 = live, 0 = test. A test event never credits a live ledger. */
	livemode: number;
	/** Denormalized `cus_…`; null on non-customer events. */
	stripeCustomerId: string | null;
	/** SHA-256 of the verified raw body (the body itself is never stored); null if unknown. */
	payloadSha256: string | null;
}

/**
 * A settled money-IN grant handed to `recordGrantAndCredit`. The caller MUST
 * resolve `userId` from `customer_map` first (an unresolved `cus_` is FAIL_HARD
 * at the route — Stripe then redelivers). `amountMicroUsd` MUST be > 0 (refunds
 * are a deferred negative path). `grantId` is derived from the SETTLED-money
 * object, NOT the webhook evt_ id.
 */
export interface CreditGrantInput {
	/** `pi:<payment_intent_id>` | `cs:<checkout_session_id>` — the MONEY idempotency key. */
	grantId: string;
	/** Cognito sub, already resolved via `customer_map`. */
	userId: string;
	/** Provenance: the `cus_…` the money came from. */
	stripeCustomerId: string;
	/** Provenance: the causing webhook `evt_…` (NOT the idempotency key). */
	sourceEventId: string;
	/** `payment_intent` | `checkout_session` | `invoice` (the renewal-deposit path). */
	stripeObject: string;
	/** Money-IN, integer µUSD (cents × 10000). MUST be > 0. */
	amountMicroUsd: number;
	/** Currency; non-`usd` is recorded but NEVER credits (the cents→µUSD fold assumes USD). */
	currency: string;
	/** 1 = live, 0 = test. Only livemode grants move the live ledger. */
	livemode: number;
	/**
	 * Other settled-money identities of the SAME payment (a session-keyed grant also answers to its
	 * `pi:<payment_intent>`). Imported cloud-1 money is suppressed under any of them, so a replayed old
	 * event can never credit the same payment twice, whichever id it arrives under.
	 */
	aliases?: readonly string[];
	/**
	 * The PaymentIntent this grant's money travelled through, with what the charge was for in total
	 * (cents, tax included). Recorded with a credited top-up so a later refund or dispute can find the
	 * credit it must claw back.
	 */
	payment?: { paymentIntentId: string; chargeAmountCents: number };
}

/** The outcome of `recordGrantAndCredit`. */
export interface GrantResult {
	/** Historical money already represented by the imported source balance. */
	suppressedLegacy?: boolean;
	/** true if this `grant_id` was newly recorded (the money had not been seen). */
	isNewGrant: boolean;
	/** true if the fold actually moved the ledger (new ∧ amount>0 ∧ livemode ∧ usd). */
	credited: boolean;
}

/** A row read back from `credit_grants` (provenance / tests). */
export interface CreditGrantRecord extends CreditGrantInput {
	kind: string;
	grantedAt: number;
	/** Whether this grant's fold moved the ledger. */
	credited: boolean;
}

/** The 5 tier labels the gateway recognizes (pn-gateway `Acl::Tier`). The
 *  subscription projection persists this STRING; the gateway folds it into an
 *  `EntitlementSet` (its `from_tier`). choreograph emits the label, nothing more. */
export type Tier = "free" | "pro" | "supporter" | "visionary" | "dev";

/**
 * Monthly credit grant per tier, integer µUSD, deposited on each paid
 * subscription invoice (`invoice.payment_succeeded` — `subscription_create` +
 * `subscription_cycle`). These are the "monthly bonus credits" that fund the
 * background metered features (dreaming / describing) and interactive use on paid
 * tiers. Values copied from cloud-1 `app/core/config/tiers.py` TIER_LIMITS
 * `monthly_credit_deposit_micro_usd` — the $15/mo pro SUBSCRIPTION deposits
 * $5/mo of CREDITS (price ≠ credit). `free`/`dev` receive none (free's seed is
 * `FREE_TIER_BALANCE_MICRO_USD`; dev is unmetered). Offered tiers today:
 * free / pro / dev — supporter (manually-granted, never credited) and visionary
 * are deliberately not offered; re-adding one later is a one-row change here +
 * in the gateway tier-limits table.
 */
export const MONTHLY_TIER_CREDIT_MICRO_USD: Record<Tier, number> = {
	free: 0,
	pro: 5_000_000, // $5.00/mo of credits (the $15/mo is the subscription PRICE)
	supporter: 0, // hidden/manual tier — pro-equivalent access, never credited (tiers.py parity)
	visionary: 0, // not offered (tiers.py had $10/mo; restore if the tier ever launches)
	dev: 0, // unmetered
};

/**
 * The plan→tier mapping from env (`STRIPE_PLAN_TIER_MAP`, JSON
 * `{"<price_id>":"pro", ...}`). Empty until real Stripe products exist (live
 * keys are deferred); tests pass an explicit map instead. The fold's only data
 * dependency.
 */
export function defaultPlanTierMap(): Record<string, Tier> {
	const raw = process.env.STRIPE_PLAN_TIER_MAP;
	if (!raw) return {};
	try {
		return JSON.parse(raw) as Record<string, Tier>;
	} catch {
		return {};
	}
}

/** Stripe statuses that grant the plan's tier; anything else downgrades to free. */
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

/**
 * THE FOLD: (plan, status) → tier LABEL. The single shared subscription→tier
 * mapping (the choreograph writer + the cloud-1 copy-in both go through tier
 * labels). A non-active status (canceled / past_due / incomplete / unpaid /
 * paused) → `free` (downgrade); an active status maps the plan via `map`,
 * defaulting to `free` for an UNRECOGNIZED plan (conservative — never grant a
 * tier we don't recognize).
 */
export function subscriptionToTier(
	plan: string,
	status: string,
	map: Record<string, Tier> = defaultPlanTierMap(),
): Tier {
	if (!ACTIVE_SUBSCRIPTION_STATUSES.has(status)) return "free";
	return map[plan] ?? "free";
}

/** A settled subscription state handed to `recordSubscriptionAndFold`. */
export interface SubscriptionInput {
	/** Cognito sub (resolved via `customer_map` before calling). */
	userId: string;
	stripeCustomerId: string;
	stripeSubscriptionId: string;
	/** Stripe price/product id — the fold's key. */
	plan: string;
	/** active | trialing | canceled | past_due | incomplete | unpaid | paused. */
	status: string;
	/** Stripe `current_period_end`, epoch secs; null if absent. */
	currentPeriodEnd: number | null;
	/** 1 = live, 0 = test. */
	livemode: number;
}

/** The outcome of `recordSubscriptionAndFold`. */
export interface SubscriptionFoldResult {
	/** false if a NEWER event was already stored (out-of-order redelivery — no change). */
	applied: boolean;
	/** The tier this event folds to (what the projection writer pushes, when applied). */
	tier: Tier;
}

/** A row read back from `subscription_state` (provenance / the writer / tests). */
export interface SubscriptionRecord {
	userId: string;
	stripeCustomerId: string | null;
	stripeSubscriptionId: string | null;
	plan: string | null;
	status: string;
	tier: Tier;
	currentPeriodEnd: number | null;
	livemode: number;
	eventCreated: number;
	sourceEventId: string | null;
	updatedAt: number;
}

export class BillingStore extends LibsqlStore {
	/**
	 * Serialization is INHERITED from `LibsqlStore`: every write/transaction is
	 * enqueued onto the base class's single per-connection promise-chain, so two
	 * overlapping `transaction("write")` (BEGIN-while-BEGIN) can never collide
	 * with SQLITE_BUSY. The wire point is fire-and-forget (no await), so under
	 * concurrent LLM fan-out two debits CAN race; the shared chain makes them
	 * strictly sequential → both-or-neither holds, balance exact (overspend
	 * impossible). Cloud-1 dodges this with per-request DynamoDB conditional
	 * updates; we own serialization in-process. (Previously a bespoke local
	 * `writeChain`; now the generalized substrate.)
	 */
	constructor(databaseUrlOrPath: string, authToken?: string) {
		super(databaseUrlOrPath, {
			snapshotName: "billing",
			authToken,
			authTokenEnv: "BILLING_DB_AUTH_TOKEN",
			// Coarse S3 durability (mirrors the journal + session store). Snapshots to
			// BILLING_DB_S3_URL under a `billing/` prefix. Unset ⇒ snapshotToS3 no-ops.
			s3Url: process.env.BILLING_DB_S3_URL,
		});
	}

	/** Create the (immutable, append-only) table + indexes. WAL/synchronous set by the base. */
	protected async createSchema(): Promise<void> {
		await this.db.execute(`
			CREATE TABLE IF NOT EXISTS usage_events (
				event_id        TEXT PRIMARY KEY,
				kind            TEXT NOT NULL DEFAULT 'usage_event',
				ts              INTEGER NOT NULL,
				user_id         TEXT,
				graph_id        TEXT,
				sandbox_id      TEXT,
				template        TEXT,
				session_id      TEXT,
				generation      INTEGER,
				inference_operation_id TEXT,
				request_id      TEXT,
				child_run_id    TEXT,
				allocation_id   TEXT,
				provider        TEXT NOT NULL DEFAULT 'openrouter',
				model           TEXT NOT NULL,
				model_priced    TEXT,
				reason          TEXT,
				input_tokens        INTEGER NOT NULL DEFAULT 0,
				output_tokens       INTEGER NOT NULL DEFAULT 0,
				cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
				cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
				total_tokens        INTEGER NOT NULL DEFAULT 0,
				input_cost_micro_usd       INTEGER NOT NULL DEFAULT 0,
				output_cost_micro_usd      INTEGER NOT NULL DEFAULT 0,
				cache_read_cost_micro_usd  INTEGER NOT NULL DEFAULT 0,
				cache_write_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
				provider_cost_micro_usd    INTEGER NOT NULL DEFAULT 0,
				provider_reported_cost_micro_usd INTEGER,
				markup_micro_usd           INTEGER NOT NULL DEFAULT 0,
				cost_micro_usd             INTEGER NOT NULL DEFAULT 0,
				pricing_version TEXT NOT NULL,
				priced_default  INTEGER NOT NULL DEFAULT 0
			)
		`);
		await this.ensureUsageProviderColumn();
		await this.ensureUsageAgentProvenanceColumns();
		await this.ensureUsageProviderReceiptColumn();
		await this.ensureUsageGenerationIdColumn();
		// What the provider says it charged for a call, read from its own generation record by the receipts
		// reconciler (billing-provider-receipts.ts). Append-only, one row per usage event; the ledger row is never rewritten.
		await this.db.execute(`
			CREATE TABLE IF NOT EXISTS usage_provider_receipts (
				event_id                    TEXT PRIMARY KEY,
				generation_id               TEXT NOT NULL,
				served_provider             TEXT,
				total_cost_micro_usd        INTEGER NOT NULL,
				upstream_cost_micro_usd     INTEGER,
				cache_discount_micro_usd    INTEGER,
				native_prompt_tokens        INTEGER,
				native_completion_tokens    INTEGER,
				native_cached_tokens        INTEGER,
				native_reasoning_tokens     INTEGER,
				fetched_at                  INTEGER NOT NULL
			)
		`);
		// Historical observations are isolated from the debit/grant ledger.
		await this.db.execute(`CREATE TABLE IF NOT EXISTS legacy_usage_history (
			user_id TEXT NOT NULL, event_id TEXT NOT NULL, ts INTEGER NOT NULL,
			record_json TEXT NOT NULL, source_sha256 TEXT NOT NULL,
			PRIMARY KEY(user_id, event_id))`);
		await this.db.execute(
			`CREATE INDEX IF NOT EXISTS idx_legacy_usage_user_ts ON legacy_usage_history(user_id, ts, event_id)`,
		);
		await this.db.execute(`CREATE TABLE IF NOT EXISTS legacy_usage_imports (
			user_id TEXT PRIMARY KEY, captured_at TEXT NOT NULL, source_sha256 TEXT NOT NULL,
			event_count INTEGER NOT NULL)`);
		await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_usage_user_ts ON usage_events(user_id, ts)`);
		await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_usage_graph_ts ON usage_events(graph_id, ts)`);
		await this.db.execute(
			`CREATE INDEX IF NOT EXISTS idx_usage_agent_session_generation ON usage_events(session_id, generation, ts)`,
		);
		await this.db.execute(
			`CREATE INDEX IF NOT EXISTS idx_usage_inference_operation ON usage_events(inference_operation_id)`,
		);
		// Versioned, read-only compatibility seam for Observatory. The view exposes
		// only the stable analytical columns; billing's tables and write semantics
		// remain authoritative and private to Choreograph.
		await this.db.execute(`
			CREATE VIEW IF NOT EXISTS observatory_billing_usage_v1 AS
			SELECT
				event_id,
				ts,
				user_id,
				graph_id,
				model,
				total_tokens,
				cost_micro_usd,
				priced_default
			FROM usage_events
		`);

		// ── Billing Phase 1 (DECREMENT) — credit ledger ──────────────────────
		// A mutable projection of the immutable usage_events truth: one row per
		// user, debited exactly once per usage event (see recordUsageAndDebit).
		// Same `billing.sqlite` file → one VACUUM INTO snapshot covers both tables.
		// PK on user_id is the only access path, so no extra index. Integer µUSD
		// only; updated_at is epoch ms (cloud-1 uses ISO, we stay integer-native).
		await this.db.execute(`
			CREATE TABLE IF NOT EXISTS credits (
				user_id                  TEXT PRIMARY KEY,
				balance_micro_usd        INTEGER NOT NULL,
				lifetime_usage_micro_usd INTEGER NOT NULL DEFAULT 0,
				updated_at               INTEGER NOT NULL
			)
		`);
		// ── Billing Phase 2.5 (MONEY-IN) — the Stripe seam (3 substores) ─────
		// The inverse of the usage/debit side: credits FLOW IN from Stripe. All
		// three tables live in the SAME billing.sqlite (one VACUUM INTO snapshot).
		// Integer µUSD. The fold is recordGrantAndCredit (mirror of
		// recordUsageAndDebit). CODE ONLY — live keys / webhook routes are
		// DEFERRED (INFRA PAUSE); nothing in production calls these yet.

		// (a) stripe_webhook_events — dedupe Stripe webhook REDELIVERY (the MESSAGE
		//     idempotency layer). PK = the evt_ id. We store a hash of the verified
		//     body, never the raw body. APPEND; first-write-wins.
		await this.db.execute(`
			CREATE TABLE IF NOT EXISTS stripe_webhook_events (
				event_id           TEXT PRIMARY KEY,
				kind               TEXT NOT NULL DEFAULT 'stripe_webhook_event',
				event_type         TEXT NOT NULL,
				received_at        INTEGER NOT NULL,
				stripe_created     INTEGER,
				api_version        TEXT,
				livemode           INTEGER NOT NULL DEFAULT 0,
				stripe_customer_id TEXT,
				status             TEXT NOT NULL DEFAULT 'received'
					CHECK (status IN ('received','processed','ignored','error')),
				error_detail       TEXT,
				payload_sha256     TEXT,
				processed_at       INTEGER
			)
		`);
		await this.db.execute(
			`CREATE INDEX IF NOT EXISTS idx_webhook_type_received ON stripe_webhook_events(event_type, received_at)`,
		);
		await this.db.execute(
			`CREATE INDEX IF NOT EXISTS idx_webhook_customer ON stripe_webhook_events(stripe_customer_id)`,
		);

		// (b) customer_map — cloud-2 user_id (Cognito sub) ↔ stripe_customer_id.
		//     This IS the Gap-1 ownership seam (no cloud-1 read). PK user_id for
		//     user→cus; UNIQUE stripe_customer_id for cus→user (1:1, FAIL_HARD on a
		//     cross-user collision). UPSERT.
		await this.db.execute(`
			CREATE TABLE IF NOT EXISTS customer_map (
				user_id            TEXT PRIMARY KEY,
				stripe_customer_id TEXT NOT NULL UNIQUE,
				email              TEXT,
				created_at         INTEGER NOT NULL,
				updated_at         INTEGER NOT NULL
			)
		`);

		// (c) credit_grants — append log of money-IN folding into `credits`. The
		//     MONEY idempotency layer: PK = grant_id DERIVED from the settled-money
		//     object ('pi:<payment_intent>' | 'cs:<checkout_session>'), NOT the
		//     webhook evt_ id — Stripe redelivers one payment under many event ids,
		//     so deduping on evt_ would double-credit. `source_event_id` is
		//     provenance only. CHECK(amount>0): positive money-IN only; refunds /
		//     chargebacks (negative, floor-aware) are a DEFERRED separate path.
		await this.db.execute(`
			CREATE TABLE IF NOT EXISTS credit_grants (
				grant_id           TEXT PRIMARY KEY,
				kind               TEXT NOT NULL DEFAULT 'credit_grant',
				user_id            TEXT NOT NULL,
				stripe_customer_id TEXT NOT NULL,
				source_event_id    TEXT NOT NULL,
				stripe_object      TEXT NOT NULL,
				amount_micro_usd   INTEGER NOT NULL CHECK (amount_micro_usd > 0),
				currency           TEXT NOT NULL DEFAULT 'usd',
				livemode           INTEGER NOT NULL DEFAULT 0,
				granted_at         INTEGER NOT NULL,
				credited           INTEGER NOT NULL DEFAULT 0
			)
		`);
		await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_grant_user_granted ON credit_grants(user_id, granted_at)`);
		await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_grant_source_event ON credit_grants(source_event_id)`);

		// Migration provenance is NOT a credit grant. Only the reviewed offline
		// importer inserts these rows, while payment writers are fenced. The
		// settled-money key is checked inside the same transaction as the fold.
		await this.db.execute(`
			CREATE TABLE IF NOT EXISTS legacy_payment_suppressions (
				grant_id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				stripe_customer_id TEXT,
				amount_micro_usd INTEGER NOT NULL CHECK (amount_micro_usd > 0),
				currency TEXT NOT NULL CHECK (currency = 'usd'),
				livemode INTEGER NOT NULL CHECK (livemode = 1),
				source_payment_id TEXT NOT NULL UNIQUE,
				source_record_sha256 TEXT NOT NULL,
				stripe_lookup_sha256 TEXT NOT NULL,
				migration_batch_id TEXT NOT NULL
			)
		`);

		// ── Billing Phase 1 (TIER) — the subscription_state projection ───────
		// The raw Stripe subscription truth. The FOLD (subscriptionToTier) maps
		// (plan, status) → a tier LABEL stored here; the gateway reads the label
		// and expands it to an EntitlementSet (its `from_tier`). Single-subject on
		// the Cognito sub (individuals-only). Updates are guarded apply-only-if-
		// newer (on the Stripe event `created`) so an out-of-order redelivery
		// never regresses to stale state. CODE ONLY — the projection writer (push
		// the tier to the cloud-2 entitlements store) + the live webhook are deferred.
		await this.db.execute(`
			CREATE TABLE IF NOT EXISTS subscription_state (
				user_id                TEXT PRIMARY KEY,
				stripe_customer_id     TEXT,
				stripe_subscription_id TEXT,
				plan                   TEXT,
				status                 TEXT NOT NULL,
				tier                   TEXT NOT NULL,
				current_period_end     INTEGER,
				livemode               INTEGER NOT NULL DEFAULT 0,
				event_created          INTEGER NOT NULL DEFAULT 0,
				source_event_id        TEXT,
				updated_at             INTEGER NOT NULL
			)
		`);

		// ── Sobremesa credits: the gate's record (E §4.4.3) ──────────────────
		// gate_events: append-only, one row per non-trivial gate decision
		// (would_block / block / would_clamp / clamp / model_unpriced / fail_open /
		// exempt / provider_unavailable). `billing.sqlite` snapshots to S3 every 15
		// minutes, so an `observe` dry run is readable without box access. No CHECK
		// on mode/door/decision: the store validates, and a new decision kind must
		// not need a migration. No UPDATE/DELETE anywhere.
		await this.db.execute(`
			CREATE TABLE IF NOT EXISTS gate_events (
				id                INTEGER PRIMARY KEY AUTOINCREMENT,
				ts                INTEGER NOT NULL,
				user_id           TEXT,
				mode              TEXT NOT NULL,
				door              TEXT NOT NULL,
				decision          TEXT NOT NULL,
				model             TEXT,
				balance_micro_usd INTEGER,
				required_micro_usd INTEGER,
				reason            TEXT
			)
		`);
		await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_gate_events_ts ON gate_events(ts)`);
		await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_gate_events_user_ts ON gate_events(user_id, ts)`);
		// gate_daily_counts: the plain allows, one counter row per day (the
		// denominator for the dry run; individual allows are not logged).
		// credit_adjustments: the SIGNED ledger movement (goodwill, forgiveness, refunds, chargebacks,
		// operator funding). PK = its idempotency key. Applied in the same transaction as the balance
		// change; not usage, so `lifetime_usage` never moves. Append-only: no UPDATE/DELETE anywhere.
		await this.db.execute(`
			CREATE TABLE IF NOT EXISTS credit_adjustments (
				adjustment_id    TEXT PRIMARY KEY,
				user_id          TEXT NOT NULL,
				amount_micro_usd INTEGER NOT NULL CHECK (amount_micro_usd != 0),
				kind             TEXT NOT NULL,
				reason           TEXT NOT NULL,
				actor            TEXT NOT NULL,
				batch_id         TEXT,
				source_ref       TEXT,
				created_at       INTEGER NOT NULL
			)
		`);
		await this.db.execute(
			`CREATE INDEX IF NOT EXISTS idx_adjustments_user_created ON credit_adjustments(user_id, created_at)`,
		);
		await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_adjustments_batch ON credit_adjustments(batch_id)`);
		await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_adjustments_source ON credit_adjustments(source_ref)`);
		// credit_grant_payments: the PaymentIntent a credited top-up was paid through, so a refund or a
		// dispute (which name the payment, not our grant) can find the credit to claw back.
		await this.db.execute(`
			CREATE TABLE IF NOT EXISTS credit_grant_payments (
				payment_intent_id   TEXT PRIMARY KEY,
				grant_id            TEXT NOT NULL,
				user_id             TEXT NOT NULL,
				charge_amount_cents INTEGER NOT NULL,
				credited_micro_usd  INTEGER NOT NULL,
				currency            TEXT NOT NULL,
				created_at          INTEGER NOT NULL
			)
		`);
		// billing_alarms: what the money-in path understood but could not credit or claw back (non-USD money,
		// an unmapped customer, an unmatched refund...). A durable row, snapshotted with the ledger: the
		// process has no log sink that outlives journald. Once per (kind, event).
		await this.db.execute(`
			CREATE TABLE IF NOT EXISTS billing_alarms (
				alarm_key  TEXT PRIMARY KEY,
				ts         INTEGER NOT NULL,
				kind       TEXT NOT NULL,
				event_id   TEXT,
				event_type TEXT,
				user_id    TEXT,
				object_id  TEXT,
				detail     TEXT
			)
		`);
		await this.db.execute(`
			CREATE TABLE IF NOT EXISTS gate_daily_counts (
				day      TEXT NOT NULL,
				mode     TEXT NOT NULL,
				door     TEXT NOT NULL,
				decision TEXT NOT NULL,
				n        INTEGER NOT NULL,
				PRIMARY KEY (day, mode, door, decision)
			)
		`);
	}

	/** Add provider identity to ledgers created before provider-aware billing. */
	private async ensureUsageProviderColumn(): Promise<void> {
		const info = await this.db.execute({ sql: `PRAGMA table_info(usage_events)`, args: [] });
		const hasProvider = info.rows.some((row) => String(row.name) === "provider");
		if (!hasProvider) {
			await this.db.execute({
				sql: `ALTER TABLE usage_events ADD COLUMN provider TEXT NOT NULL DEFAULT 'openrouter'`,
				args: [],
			});
		}
	}

	/** Add optional hosted-agent coordinates without changing non-Agent writers. */
	private async ensureUsageAgentProvenanceColumns(): Promise<void> {
		const info = await this.db.execute({ sql: `PRAGMA table_info(usage_events)`, args: [] });
		const existing = new Set(info.rows.map((row) => String(row.name)));
		for (const [name, declaration] of [
			["funding_source", "TEXT NOT NULL DEFAULT 'platform'"],
			["session_id", "TEXT"],
			["generation", "INTEGER"],
			["inference_operation_id", "TEXT"],
			["request_id", "TEXT"],
			["child_run_id", "TEXT"],
			["allocation_id", "TEXT"],
		] as const) {
			if (!existing.has(name)) {
				await this.db.execute(`ALTER TABLE usage_events ADD COLUMN ${name} ${declaration}`);
			}
		}
	}

	/** Preserve provider-reported spend separately from deterministic platform pricing. */
	private async ensureUsageProviderReceiptColumn(): Promise<void> {
		const info = await this.db.execute({ sql: `PRAGMA table_info(usage_events)`, args: [] });
		const hasReceipt = info.rows.some((row) => String(row.name) === "provider_reported_cost_micro_usd");
		if (!hasReceipt) {
			await this.db.execute(`ALTER TABLE usage_events ADD COLUMN provider_reported_cost_micro_usd INTEGER`);
		}
	}

	/** The provider's generation id and the pricing basis of a call (all nullable: legacy rows have none). */
	private async ensureUsageGenerationIdColumn(): Promise<void> {
		const info = await this.db.execute({ sql: `PRAGMA table_info(usage_events)`, args: [] });
		const existing = new Set(info.rows.map((row) => String(row.name)));
		for (const [name, declaration] of [
			["provider_generation_id", "TEXT"],
			["pricing_basis", "TEXT"],
			["card_cost_micro_usd", "INTEGER"],
			["card_provider_cost_micro_usd", "INTEGER"],
		] as const) {
			if (!existing.has(name)) await this.db.execute(`ALTER TABLE usage_events ADD COLUMN ${name} ${declaration}`);
		}
	}

	/** Usage events with a provider generation id and no receipt yet, oldest first. */
	async usageEventsAwaitingReceipt(limit: number): Promise<Array<{ eventId: string; generationId: string }>> {
		const res = await this.db.execute({
			sql: `SELECT u.event_id, u.provider_generation_id FROM usage_events AS u
			       LEFT JOIN usage_provider_receipts AS r ON r.event_id = u.event_id
			      WHERE u.provider_generation_id IS NOT NULL AND u.provider = 'openrouter' AND r.event_id IS NULL
			      ORDER BY u.ts, u.event_id LIMIT ?`,
			args: [Math.max(1, Math.floor(limit))],
		});
		return res.rows.map((row) => ({
			eventId: String(row.event_id),
			generationId: String(row.provider_generation_id),
		}));
	}

	/** Keep a provider receipt for a usage event, once (first write wins). @returns true if it was new. */
	async recordProviderReceipt(r: ProviderReceipt): Promise<boolean> {
		const res = await this.write(
			{
				sql: `INSERT INTO usage_provider_receipts (event_id, generation_id, served_provider, total_cost_micro_usd,
				        upstream_cost_micro_usd, cache_discount_micro_usd, native_prompt_tokens, native_completion_tokens,
				        native_cached_tokens, native_reasoning_tokens, fetched_at)
				      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`,
				args: [
					r.eventId,
					r.generationId,
					r.servedProvider,
					r.totalCostMicroUsd,
					r.upstreamCostMicroUsd,
					r.cacheDiscountMicroUsd,
					r.nativePromptTokens,
					r.nativeCompletionTokens,
					r.nativeCachedTokens,
					r.nativeReasoningTokens,
					r.fetchedAt,
				],
			},
			"UPSERT_IF_ABSENT",
		);
		return res.rowsAffected > 0;
	}

	async getProviderReceipt(eventId: string): Promise<ProviderReceipt | undefined> {
		const res = await this.db.execute({
			sql: `SELECT * FROM usage_provider_receipts WHERE event_id = ?`,
			args: [eventId],
		});
		const row = res.rows[0];
		if (!row) return undefined;
		const n = (v: unknown) => (v == null ? null : Number(v));
		return {
			eventId: String(row.event_id),
			generationId: String(row.generation_id),
			servedProvider: s(row.served_provider),
			totalCostMicroUsd: Number(row.total_cost_micro_usd),
			upstreamCostMicroUsd: n(row.upstream_cost_micro_usd),
			cacheDiscountMicroUsd: n(row.cache_discount_micro_usd),
			nativePromptTokens: n(row.native_prompt_tokens),
			nativeCompletionTokens: n(row.native_completion_tokens),
			nativeCachedTokens: n(row.native_cached_tokens),
			nativeReasoningTokens: n(row.native_reasoning_tokens),
			fetchedAt: Number(row.fetched_at),
		};
	}

	/**
	 * Append a usage event. SINGLE atomic statement,
	 * `INSERT … ON CONFLICT(event_id) DO NOTHING` — a duplicate request_id is a
	 * silent no-op and the FIRST write is preserved (immutable).
	 *
	 * @returns true if a row was inserted; false if it was a duplicate.
	 */
	async recordUsage(e: UsageEventInput): Promise<boolean> {
		return tracer.startActiveSpan("billing.record_usage", async (span) => {
			span.setAttributes({
				"billing.event_id": e.eventId,
				"billing.model": e.model,
				"billing.cost_micro_usd": e.costMicroUsd,
				"db.system": "sqlite",
				"db.write_mode": "UPSERT_IF_ABSENT",
			});
			// Single atomic INSERT … ON CONFLICT DO NOTHING — routed through the
			// serialized write() so it never overlaps a tx() on the same connection.
			const res = await this.write(usageInsertStmt(e), "UPSERT_IF_ABSENT");
			const inserted = res.rowsAffected > 0;
			span.setAttribute("billing.inserted", inserted);
			span.end();
			return inserted;
		});
	}

	/**
	 * Billing Phase 1 (DECREMENT). Append the usage event AND debit the credit
	 * ledger in ONE write transaction — both-or-neither. The debit fires ONLY
	 * when the usage insert actually inserts (first-write-wins), so a duplicate
	 * request_id no-ops the usage row AND skips the debit — never a double-debit.
	 *
	 * NO SILENT FLOOR (Sobremesa, E §4.4.1): every recorded platform cost is
	 * debited. The old -$0.50 guard skipped a debit silently while the usage row
	 * was still written, so a person past the floor chatted for free and the
	 * ledger stopped matching usage. The floor is now an ADMISSION rule (the
	 * credit gate refuses BEFORE the call; a call already made is always
	 * debited), never a reason to lose a cost that was already incurred. A
	 * balance can therefore go below zero, by at most the estimate error of one
	 * admitted call; the next admission refuses.
	 *
	 * Mirrors cloud-1 `credits.py` lazy-init (60–77); the guarded decrement
	 * (106–124) is deliberately not ported.
	 *
	 * @returns true if a NEW usage row landed; false if it was a duplicate.
	 */
	async recordUsageAndDebit(e: UsageEventInput): Promise<boolean> {
		return tracer.startActiveSpan("billing.record_usage_debit", async (span) => {
			span.setAttributes({
				"billing.event_id": e.eventId,
				"billing.model": e.model,
				"billing.cost_micro_usd": e.costMicroUsd,
				"db.system": "sqlite",
				// A tx() mixing UPSERT_IF_ABSENT (usage) + CAS (debit) declares the
				// DOMINANT mode CAS — the non-commutative one dictates engine-admissibility.
				"db.write_mode": "CAS",
			});
			// One serialized write transaction — both-or-neither. Inherited from the
			// substrate's chain → never overlaps another tx() on the single connection.
			const inserted = await this.tx(async (tx) => {
				// (a) usage insert — idempotent, first-write-wins (identical statement
				// to recordUsage via the shared helper, so the column list never drifts).
				const ins = await usageInsert(tx, e);
				const didInsert = ins.rowsAffected > 0;
				if (!didInsert) {
					const existing = await tx.execute({
						sql: "SELECT user_id, funding_source FROM usage_events WHERE event_id = ?",
						args: [e.eventId],
					});
					const row = existing.rows[0];
					if (row && (row.user_id !== e.userId || row.funding_source !== (e.fundingSource ?? "platform")))
						throw new Error("Usage event owner/funding conflict");
				}

				// Debit ONLY on a genuinely-new usage row for an attributable user.
				// Unattributed and user-funded rows are telemetry only; neither seeds credits.
				if (didInsert && e.userId && (e.fundingSource ?? "platform") === "platform") {
					const now = Date.now();
					const cost = e.costMicroUsd; // integer µUSD, computed upstream

					// (b1) lazy-init the free-tier row — no-op if it already exists.
					await tx.execute({
						sql: `INSERT INTO credits (user_id, balance_micro_usd, lifetime_usage_micro_usd, updated_at)
							VALUES (?, ?, 0, ?)
							ON CONFLICT(user_id) DO NOTHING`,
						args: [e.userId, FREE_TIER_BALANCE_MICRO_USD, now],
					});

					// (b2) atomic UNGUARDED decrement — single statement. The row exists
					// (b1), so every new usage row moves the ledger by exactly its cost.
					// cost === 0 is a benign no-op that still bumps updated_at.
					const dec = await tx.execute({
						sql: `UPDATE credits
							SET balance_micro_usd        = balance_micro_usd - :cost,
								lifetime_usage_micro_usd = lifetime_usage_micro_usd + :cost,
								updated_at               = :now
							WHERE user_id = :u`,
						args: { cost, now, u: e.userId },
					});
					span.setAttribute("billing.debited", dec.rowsAffected > 0);
				}

				return didInsert;
			}, "CAS");

			span.setAttribute("billing.inserted", inserted);
			span.end();
			return inserted;
		});
	}

	/** Fetch a single event by id (provenance / tests). */
	async getEvent(eventId: string): Promise<UsageEventRecord | undefined> {
		const res = await this.read({
			sql: `SELECT * FROM usage_events WHERE event_id = ?`,
			args: [eventId],
		});
		const row = res.rows[0];
		return row ? rowToUsageEvent(row) : undefined;
	}

	/** Owner-scoped observations only: no seeding, debiting, or payment replay. */
	async usageExplorerPage(userId: string, query: UsagePageQuery) {
		const args = [userId, query.from, query.to, query.beforeTs, query.beforeTs, query.afterKey, query.limit + 1];
		const current = await this.read({
			sql: `SELECT * FROM usage_events
			WHERE user_id=? AND ts>=? AND ts<? AND (ts<? OR (ts=? AND 'sirin:'||event_id>?))
			ORDER BY ts DESC,event_id ASC LIMIT ?`,
			args,
		});
		const legacy = await this.read({
			sql: `SELECT * FROM legacy_usage_history
			WHERE user_id=? AND ts>=? AND ts<? AND (ts<? OR (ts=? AND 'cloud-1:'||event_id>?))
			ORDER BY ts DESC,event_id ASC LIMIT ?`,
			args,
		});
		const historical = legacy.rows.map((row) => {
			const value = checkedUsageEvent(JSON.parse(String(row.record_json)));
			if (value.source !== "cloud-1" || value.id !== `cloud-1:${row.event_id}` || value.ts !== Number(row.ts))
				throw new Error("Usage archive identity mismatch");
			return value;
		});
		const items = [...current.rows.map((row) => currentUsageEvent(rowToUsageEvent(row))), ...historical]
			.sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
			.slice(0, query.limit + 1);
		const counts = await this.read({
			sql: `SELECT 'sirin' AS source,COUNT(*) AS n,MIN(ts) AS first_ts,MAX(ts) AS last_ts FROM usage_events WHERE user_id=?
			UNION ALL SELECT 'cloud-1',COUNT(*),MIN(ts),MAX(ts) FROM legacy_usage_history WHERE user_id=?`,
			args: [userId, userId],
		});
		const imported = await this.read({
			sql: "SELECT captured_at,event_count FROM legacy_usage_imports WHERE user_id=?",
			args: [userId],
		});
		return {
			items,
			coverage: counts.rows.map((row) => ({
				source: String(row.source),
				eventCount: Number(row.n),
				firstTs: row.first_ts == null ? null : Number(row.first_ts),
				lastTs: row.last_ts == null ? null : Number(row.last_ts),
				state:
					row.source === "sirin" ? "recorded-events" : imported.rows.length ? "imported-snapshot" : "not-imported",
				capturedAt: row.source === "cloud-1" && imported.rows.length ? String(imported.rows[0].captured_at) : null,
			})),
		};
	}

	/**
	 * Sum cost per user over a [fromTs, toTs) window (the projection read used by
	 * tests and future read endpoints). NULL-user rows are excluded by the
	 * `user_id = ?` predicate.
	 */
	async sumByUser(userId: string, fromTs: number, toTs: number): Promise<{ totalMicroUsd: number; n: number }> {
		const res = await this.read({
			sql: `SELECT COALESCE(SUM(cost_micro_usd), 0) AS total_micro_usd, COUNT(*) AS n
				FROM usage_events WHERE user_id = ? AND ts >= ? AND ts < ?`,
			args: [userId, fromTs, toTs],
		});
		const row = res.rows[0];
		return {
			totalMicroUsd: Number(row?.total_micro_usd ?? 0),
			n: Number(row?.n ?? 0),
		};
	}

	/**
	 * Billing Phase 1 — read a user's credit projection (balance + lifetime
	 * usage). Returns undefined if the user has no row yet (never billed). For
	 * tests + future Phase-2 reads; Phase 1 itself never reads-before-spawn.
	 */
	async getCredit(userId: string): Promise<CreditRecord | undefined> {
		const res = await this.read({
			sql: `SELECT user_id, balance_micro_usd, lifetime_usage_micro_usd, updated_at
				FROM credits WHERE user_id = ?`,
			args: [userId],
		});
		const row = res.rows[0];
		return row ? rowToCredit(row) : undefined;
	}

	// ── Billing Phase 2.5 (MONEY-IN) — the Stripe seam ───────────────────────

	/**
	 * Upsert the user_id ↔ stripe_customer_id ownership mapping (the Gap-1 seam).
	 * PK user_id; the UNIQUE on stripe_customer_id FAILS HARD if a `cus_` is
	 * claimed by a different user (a 1:1 invariant violation Stripe should never
	 * produce). UPSERT — re-running with the same pair is a no-op bump.
	 */
	async upsertCustomer(userId: string, stripeCustomerId: string, email?: string | null): Promise<void> {
		const now = Date.now();
		await this.write(
			{
				sql: `INSERT INTO customer_map (user_id, stripe_customer_id, email, created_at, updated_at)
					VALUES (:u, :cus, :email, :now, :now)
					ON CONFLICT(user_id) DO UPDATE SET
						stripe_customer_id = excluded.stripe_customer_id,
						email              = excluded.email,
						updated_at         = excluded.updated_at`,
				args: { u: userId, cus: stripeCustomerId, email: email ?? null, now },
			},
			"UPSERT",
		);
	}

	/** Resolve a Stripe `cus_…` back to its Cognito sub (the route's FAIL_HARD lookup). */
	async getUserByCustomer(stripeCustomerId: string): Promise<string | undefined> {
		const res = await this.read({
			sql: `SELECT user_id FROM customer_map WHERE stripe_customer_id = ?`,
			args: [stripeCustomerId],
		});
		const row = res.rows[0];
		return row ? String(row.user_id) : undefined;
	}

	/** Read a user's customer mapping (provenance / tests). */
	async getCustomer(userId: string): Promise<CustomerMapRecord | undefined> {
		const res = await this.read({
			sql: `SELECT user_id, stripe_customer_id, email, created_at, updated_at
				FROM customer_map WHERE user_id = ?`,
			args: [userId],
		});
		const row = res.rows[0];
		return row ? rowToCustomer(row) : undefined;
	}

	/**
	 * Billing Phase 2.5 (CREDIT) — the money-IN mirror of recordUsageAndDebit:
	 * record the webhook + the grant AND fold a credit into the ledger in ONE
	 * write transaction — both-or-neither (a crash before COMMIT rolls back the
	 * whole thing; Stripe redelivers; the next attempt is a clean first-write).
	 *
	 * TWO idempotency layers: the webhook `event_id` dedupes the MESSAGE; the
	 * `grant_id` (derived from the settled-money object) dedupes the MONEY. So
	 * Stripe sending one payment under several event ids credits EXACTLY ONCE —
	 * the second event inserts a fresh webhook row but the grant already exists →
	 * `isNewGrant=false` → no ledger move.
	 *
	 * The credit fires ONLY for a genuinely-new grant that is positive, livemode,
	 * and USD. A credit is an UNGUARDED add — unlike the floored debit, money-IN
	 * can never breach the overdraft floor, so there is no `WHERE balance >=` CAS.
	 * Like the debit side, the `credits` row is lazy-initialized to the free tier
	 * first, so a brand-new payer lands at FREE_TIER + their top-up.
	 *
	 * Caller contract: resolve `userId` from `customer_map` first (an unresolved
	 * `cus_` ⇒ don't call; let the webhook 4xx so Stripe retries). `amount` MUST
	 * be > 0 (refunds are a deferred negative path) — a non-positive amount throws
	 * before any write.
	 */
	async recordGrantAndCredit(webhook: StripeWebhookInput, grant: CreditGrantInput): Promise<GrantResult> {
		if (!(grant.amountMicroUsd > 0)) {
			throw new Error(
				`recordGrantAndCredit: amount_micro_usd must be > 0 (got ${grant.amountMicroUsd}); ` +
					`zero/negative are not credit_grants (refunds are a deferred path)`,
			);
		}
		return tracer.startActiveSpan("billing.record_grant_credit", async (span) => {
			span.setAttributes({
				"billing.grant_id": grant.grantId,
				"billing.event_id": webhook.eventId,
				"billing.amount_micro_usd": grant.amountMicroUsd,
				"billing.livemode": grant.livemode,
				"db.system": "sqlite",
				// webhook APPEND + grant APPEND + a ledger add: declare the dominant
				// non-commutative mode CAS (same convention as the debit fold).
				"db.write_mode": "CAS",
			});
			// Only a positive, livemode, USD grant moves real money.
			const willCredit = grant.amountMicroUsd > 0 && grant.livemode === 1 && grant.currency === "usd";

			const result = await this.tx(async (tx) => {
				const now = Date.now();
				const identities = [grant.grantId, ...(grant.aliases ?? [])];
				const marks = identities.map(() => "?").join(", ");
				const legacy = await tx.execute({
					sql: `SELECT * FROM legacy_payment_suppressions WHERE grant_id IN (${marks})`,
					args: identities,
				});
				const prior = legacy.rows[0];
				if (prior) {
					// A null historical customer is valid for one-time Checkout. It
					// must not invent a customer mapping; the authenticated route has
					// independently resolved today's customer to this exact owner.
					if (
						String(prior.user_id) !== grant.userId ||
						Number(prior.amount_micro_usd) !== grant.amountMicroUsd ||
						String(prior.currency) !== grant.currency ||
						Number(prior.livemode) !== grant.livemode ||
						(prior.stripe_customer_id !== null && String(prior.stripe_customer_id) !== grant.stripeCustomerId)
					) {
						throw new Error("legacy payment suppression conflicts with incoming money identity");
					}
					return { isNewGrant: false, credited: false, suppressedLegacy: true };
				}

				// (1) dedupe the MESSAGE — record the webhook once (first-write-wins).
				await tx.execute({
					sql: `INSERT INTO stripe_webhook_events
							(event_id, kind, event_type, received_at, stripe_created, api_version,
							 livemode, stripe_customer_id, status, payload_sha256)
						VALUES (?, 'stripe_webhook_event', ?, ?, ?, ?, ?, ?, 'received', ?)
						ON CONFLICT(event_id) DO NOTHING`,
					args: [
						webhook.eventId,
						webhook.eventType,
						now,
						webhook.stripeCreated,
						webhook.apiVersion,
						webhook.livemode,
						webhook.stripeCustomerId,
						webhook.payloadSha256,
					],
				});

				// (1b) the SAME money under another identity. A session-keyed grant answers to its PaymentIntent's
				// `pi:` id too, which the previous release credited straight from `payment_intent.succeeded`: money
				// a rolling deploy split across the two releases is credited once, whichever identity got there first.
				let creditedUnderAlias = false;
				if (grant.aliases && grant.aliases.length > 0) {
					const aliasMarks = grant.aliases.map(() => "?").join(", ");
					const aliased = await tx.execute({
						sql: `SELECT 1 AS present FROM credit_grants WHERE grant_id IN (${aliasMarks}) LIMIT 1`,
						args: [...grant.aliases],
					});
					creditedUnderAlias = aliased.rows.length > 0;
				}

				// (2) dedupe the MONEY — grant_id is derived from the settled-money
				// object, so a redelivered payment under a new evt_ is a no-op here.
				let isNewGrant = false;
				if (!creditedUnderAlias) {
					const g = await tx.execute({
						sql: `INSERT INTO credit_grants
								(grant_id, kind, user_id, stripe_customer_id, source_event_id,
								 stripe_object, amount_micro_usd, currency, livemode, granted_at, credited)
							VALUES (?, 'credit_grant', ?, ?, ?, ?, ?, ?, ?, ?, ?)
							ON CONFLICT(grant_id) DO NOTHING`,
						args: [
							grant.grantId,
							grant.userId,
							grant.stripeCustomerId,
							grant.sourceEventId,
							grant.stripeObject,
							grant.amountMicroUsd,
							grant.currency,
							grant.livemode,
							now,
							willCredit ? 1 : 0,
						],
					});
					isNewGrant = g.rowsAffected > 0;
				}

				// (3) fold a credit into the ledger — ONLY on a genuinely-new,
				// creditable grant. Lazy-init the free-tier row, then an UNGUARDED add
				// (money-IN can never breach the floor — the inverse of the debit CAS).
				let credited = false;
				if (isNewGrant && willCredit) {
					await tx.execute({
						sql: `INSERT INTO credits (user_id, balance_micro_usd, lifetime_usage_micro_usd, updated_at)
							VALUES (?, ?, 0, ?)
							ON CONFLICT(user_id) DO NOTHING`,
						args: [grant.userId, FREE_TIER_BALANCE_MICRO_USD, now],
					});
					await tx.execute({
						sql: `UPDATE credits
							SET balance_micro_usd = balance_micro_usd + :amt,
								updated_at        = :now
							WHERE user_id = :u`,
						args: { amt: grant.amountMicroUsd, now, u: grant.userId },
					});
					credited = true;
					// The PaymentIntent link, so a later refund or dispute can find this credit.
					if (grant.payment) {
						await tx.execute({
							sql: `INSERT INTO credit_grant_payments
									(payment_intent_id, grant_id, user_id, charge_amount_cents,
									 credited_micro_usd, currency, created_at)
								VALUES (?, ?, ?, ?, ?, ?, ?)
								ON CONFLICT(payment_intent_id) DO NOTHING`,
							args: [
								grant.payment.paymentIntentId,
								grant.grantId,
								grant.userId,
								grant.payment.chargeAmountCents,
								grant.amountMicroUsd,
								grant.currency,
								now,
							],
						});
					}
				}

				// (4) close out the webhook row (processed regardless of credit decision).
				await tx.execute({
					sql: `UPDATE stripe_webhook_events SET status = 'processed', processed_at = :now
						WHERE event_id = :evt`,
					args: { now, evt: webhook.eventId },
				});

				return { isNewGrant, credited };
			}, "CAS");

			span.setAttributes({
				"billing.is_new_grant": result.isNewGrant,
				"billing.credited": result.credited,
			});
			span.end();
			return result;
		});
	}

	/** Read a grant by id (provenance / tests). */
	async getGrant(grantId: string): Promise<CreditGrantRecord | undefined> {
		const res = await this.read({
			sql: `SELECT * FROM credit_grants WHERE grant_id = ?`,
			args: [grantId],
		});
		const row = res.rows[0];
		return row ? rowToGrant(row) : undefined;
	}

	/**
	 * Billing Phase 1 (TIER) — the subscription side. Record the webhook + fold
	 * (plan, status) → a tier LABEL and upsert `subscription_state`, in ONE write
	 * transaction. The FOLD (`subscriptionToTier`) is the single shared mapping;
	 * the resulting `tier` is what the projection writer (deferred) pushes to the
	 * cloud-2 entitlements store, where the gateway reads it.
	 *
	 * Out-of-order safety: Stripe redelivers AND reorders. The upsert is guarded
	 * apply-only-if-newer on the Stripe event `created` ts — an older event can
	 * never regress a fresher subscription state. `applied=false` means a newer
	 * event already won; the writer should then NOT push (the newer push already did).
	 *
	 * Caller contract: resolve `userId` from `customer_map` first; pass the
	 * webhook for MESSAGE-dedupe (reuses `stripe_webhook_events`).
	 */
	async recordSubscriptionAndFold(
		webhook: StripeWebhookInput,
		sub: SubscriptionInput,
		planTierMap?: Record<string, Tier>,
	): Promise<SubscriptionFoldResult> {
		const tier = subscriptionToTier(sub.plan, sub.status, planTierMap ?? defaultPlanTierMap());
		const eventCreated = webhook.stripeCreated ?? 0;
		return tracer.startActiveSpan("billing.record_subscription", async (span) => {
			span.setAttributes({
				"billing.event_id": webhook.eventId,
				"billing.user_id": sub.userId,
				"billing.tier": tier,
				"billing.sub_status": sub.status,
				"db.system": "sqlite",
				"db.write_mode": "UPSERT",
			});
			const applied = await this.tx(async (tx) => {
				const now = Date.now();
				// (1) dedupe the MESSAGE (webhook redelivery) — shared with the grant fold.
				await tx.execute({
					sql: `INSERT INTO stripe_webhook_events
							(event_id, kind, event_type, received_at, stripe_created, api_version,
							 livemode, stripe_customer_id, status, payload_sha256)
						VALUES (?, 'stripe_webhook_event', ?, ?, ?, ?, ?, ?, 'received', ?)
						ON CONFLICT(event_id) DO NOTHING`,
					args: [
						webhook.eventId,
						webhook.eventType,
						now,
						webhook.stripeCreated,
						webhook.apiVersion,
						webhook.livemode,
						webhook.stripeCustomerId,
						webhook.payloadSha256,
					],
				});
				// (2) upsert subscription_state, apply-only-if-NEWER (out-of-order guard):
				// the DO UPDATE fires only when this event's `created` >= the stored one,
				// so a late-arriving older event cannot regress fresher state.
				const up = await tx.execute({
					sql: `INSERT INTO subscription_state
							(user_id, stripe_customer_id, stripe_subscription_id, plan, status, tier,
							 current_period_end, livemode, event_created, source_event_id, updated_at)
						VALUES (:u, :cus, :subid, :plan, :status, :tier, :cpe, :live, :ec, :evt, :now)
						ON CONFLICT(user_id) DO UPDATE SET
							stripe_customer_id     = excluded.stripe_customer_id,
							stripe_subscription_id = excluded.stripe_subscription_id,
							plan                   = excluded.plan,
							status                 = excluded.status,
							tier                   = excluded.tier,
							current_period_end     = excluded.current_period_end,
							livemode               = excluded.livemode,
							event_created          = excluded.event_created,
							source_event_id        = excluded.source_event_id,
							updated_at             = excluded.updated_at
						WHERE excluded.event_created >= subscription_state.event_created`,
					args: {
						u: sub.userId,
						cus: sub.stripeCustomerId,
						subid: sub.stripeSubscriptionId,
						plan: sub.plan,
						status: sub.status,
						tier,
						cpe: sub.currentPeriodEnd,
						live: sub.livemode,
						ec: eventCreated,
						evt: webhook.eventId,
						now,
					},
				});
				const didApply = up.rowsAffected > 0;
				// (3) close out the webhook row.
				await tx.execute({
					sql: `UPDATE stripe_webhook_events SET status = 'processed', processed_at = :now WHERE event_id = :evt`,
					args: { now, evt: webhook.eventId },
				});
				return didApply;
			}, "CAS");
			span.setAttribute("billing.applied", applied);
			span.end();
			return { applied, tier };
		});
	}

	/** Read a user's current subscription/tier projection (provenance / writer / tests). */
	async getSubscription(userId: string): Promise<SubscriptionRecord | undefined> {
		const res = await this.read({
			sql: `SELECT * FROM subscription_state WHERE user_id = ?`,
			args: [userId],
		});
		const row = res.rows[0];
		return row ? rowToSubscription(row) : undefined;
	}

	// ── Sobremesa credits: alarms, payment links and claw-backs ──────────────

	/** The PaymentIntent link of a credited top-up, if this payment was one of ours. */
	async getGrantPayment(paymentIntentId: string): Promise<GrantPaymentRecord | undefined> {
		const res = await this.read({
			sql: `SELECT payment_intent_id, grant_id, user_id, charge_amount_cents, credited_micro_usd, currency
				FROM credit_grant_payments WHERE payment_intent_id = ?`,
			args: [paymentIntentId],
		});
		const row = res.rows[0];
		return row
			? {
					paymentIntentId: String(row.payment_intent_id),
					grantId: String(row.grant_id),
					userId: String(row.user_id),
					chargeAmountCents: Number(row.charge_amount_cents),
					creditedMicroUsd: Number(row.credited_micro_usd),
					currency: String(row.currency),
				}
			: undefined;
	}

	/**
	 * Record a durable alarm. Once per (kind, event): a redelivered event does not raise it again.
	 * @returns true when the alarm is new (the caller logs it), false when it was already raised.
	 */
	async recordBillingAlarm(alarm: BillingAlarmInput): Promise<boolean> {
		if (!(BILLING_ALARM_KINDS as readonly string[]).includes(alarm.kind)) {
			throw new Error(`billing alarm: unknown kind ${JSON.stringify(alarm.kind)}`);
		}
		const key = `${alarm.kind}:${alarm.eventId ?? alarm.objectId ?? "-"}`;
		const res = await this.write(
			{
				sql: `INSERT INTO billing_alarms (alarm_key, ts, kind, event_id, event_type, user_id, object_id, detail)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(alarm_key) DO NOTHING`,
				args: [
					key,
					Date.now(),
					alarm.kind,
					alarm.eventId,
					alarm.eventType,
					alarm.userId,
					alarm.objectId,
					alarm.detail === null ? null : alarm.detail.slice(0, GATE_REASON_MAX_CHARS),
				],
			},
			"UPSERT_IF_ABSENT",
		);
		return res.rowsAffected > 0;
	}

	/** Every alarm raised, oldest first. */
	async listBillingAlarms(): Promise<BillingAlarmRecord[]> {
		const res = await this.read({ sql: "SELECT * FROM billing_alarms ORDER BY ts ASC, alarm_key ASC", args: [] });
		return res.rows.map((row) => ({
			alarmKey: String(row.alarm_key),
			ts: Number(row.ts),
			kind: String(row.kind) as BillingAlarmKind,
			eventId: s(row.event_id),
			eventType: s(row.event_type),
			userId: s(row.user_id),
			objectId: s(row.object_id),
			detail: s(row.detail),
		}));
	}

	/**
	 * Claw back the credit a refund or a dispute takes away, in ONE transaction with the webhook dedupe
	 * row: find the top-up through its PaymentIntent, take the PROPORTION of the credit that the returned
	 * money is of the charge (a refund of half the charge takes back half the credit, tax or no tax), never
	 * more than was credited across every refund and dispute together, and post it as a signed adjustment
	 * keyed by `input.adjustmentId` (so a redelivery, or the same cumulative refund state, is a no-op).
	 * A refund reports CUMULATIVE cents, so the claw-back is the increment over what earlier refunds took.
	 * Money we cannot match, or that came back in another currency, moves nothing; the caller alarms.
	 */
	async recordPaymentClawback(webhook: StripeWebhookInput, input: PaymentClawbackInput): Promise<ClawbackResult> {
		return this.tx(async (tx) => {
			const now = Date.now();
			await tx.execute({
				sql: `INSERT INTO stripe_webhook_events
						(event_id, kind, event_type, received_at, stripe_created, api_version,
						 livemode, stripe_customer_id, status, payload_sha256)
					VALUES (?, 'stripe_webhook_event', ?, ?, ?, ?, ?, ?, 'received', ?)
					ON CONFLICT(event_id) DO NOTHING`,
				args: [
					webhook.eventId,
					webhook.eventType,
					now,
					webhook.stripeCreated,
					webhook.apiVersion,
					webhook.livemode,
					webhook.stripeCustomerId,
					webhook.payloadSha256,
				],
			});
			const finish = async (result: ClawbackResult): Promise<ClawbackResult> => {
				await tx.execute({
					sql: `UPDATE stripe_webhook_events SET status = 'processed', processed_at = :now WHERE event_id = :evt`,
					args: { now, evt: webhook.eventId },
				});
				return result;
			};
			if (input.livemode !== 1) return finish({ applied: false, reason: "test_mode" });
			if (!input.paymentIntentId) return finish({ applied: false, reason: "unmatched_payment" });
			const link = await tx.execute({
				sql: `SELECT user_id, charge_amount_cents, credited_micro_usd, currency, created_at
					FROM credit_grant_payments WHERE payment_intent_id = ?`,
				args: [input.paymentIntentId],
			});
			const row = link.rows[0];
			if (!row) return finish({ applied: false, reason: "unmatched_payment" });
			if (input.currency.trim().toLowerCase() !== String(row.currency)) {
				return finish({ applied: false, reason: "currency_mismatch" });
			}
			const known = await tx.execute({
				sql: "SELECT 1 AS present FROM credit_adjustments WHERE adjustment_id = ?",
				args: [input.adjustmentId],
			});
			if (known.rows[0]) return finish({ applied: false, reason: "duplicate" });

			const userId = String(row.user_id);
			const credited = Number(row.credited_micro_usd);
			const chargeCents = Math.max(1, Number(row.charge_amount_cents));
			const affected = Math.min(Math.max(0, Math.trunc(input.affectedCents)), chargeCents);
			const share = Math.floor((credited * affected) / chargeCents);
			const taken = await tx.execute({
				sql: `SELECT
						COALESCE(SUM(CASE WHEN kind = 'refund' THEN -amount_micro_usd ELSE 0 END), 0) AS refunded,
						COALESCE(SUM(-amount_micro_usd), 0) AS clawed,
						COALESCE(MAX(created_at), 0) AS latest
					FROM credit_adjustments
					WHERE source_ref = ? AND kind IN ('refund', 'dispute')`,
				args: [input.paymentIntentId],
			});
			const alreadyRefunded = Number(taken.rows[0]?.refunded ?? 0);
			const alreadyClawed = Number(taken.rows[0]?.clawed ?? 0);
			const wanted = input.kind === "refund" ? share - alreadyRefunded : share;
			const amount = Math.min(wanted, credited - alreadyClawed);
			if (amount <= 0) return finish({ applied: false, reason: "nothing_to_claw_back" });
			// The history reads newest first: a claw-back never sorts before the purchase it reverses, nor before an
			// earlier claw-back of the same payment, even when the clock has not ticked between them.
			const at = Math.max(now, Number(row.created_at) + 1, Number(taken.rows[0]?.latest ?? 0) + 1);

			await tx.execute({
				sql: `INSERT INTO credit_adjustments
						(adjustment_id, user_id, amount_micro_usd, kind, reason,
						 actor, batch_id, source_ref, created_at)
					VALUES (?, ?, ?, ?, ?, 'stripe:webhook', NULL, ?, ?)`,
				args: [
					input.adjustmentId,
					userId,
					-amount,
					input.kind,
					input.reason.slice(0, ADJUSTMENT_REASON_MAX_CHARS),
					input.paymentIntentId,
					at,
				],
			});
			await tx.execute({
				sql: `INSERT INTO credits (user_id, balance_micro_usd, lifetime_usage_micro_usd, updated_at)
					VALUES (?, ?, 0, ?)
					ON CONFLICT(user_id) DO NOTHING`,
				args: [userId, FREE_TIER_BALANCE_MICRO_USD, now],
			});
			await tx.execute({
				sql: `UPDATE credits
					SET balance_micro_usd = balance_micro_usd - :amt, updated_at = :now
					WHERE user_id = :u`,
				args: { amt: amount, now, u: userId },
			});
			const balance = await tx.execute({
				sql: "SELECT balance_micro_usd FROM credits WHERE user_id = ?",
				args: [userId],
			});
			return finish({
				applied: true,
				amountMicroUsd: amount,
				balanceMicroUsd: Number(balance.rows[0]?.balance_micro_usd ?? 0),
			});
		}, "CAS");
	}

	// ── Sobremesa credits: signed adjustments and the credit history ─────────

	/**
	 * Apply one signed adjustment and record it, in ONE transaction (both-or-neither), idempotent on its key.
	 * Like a first debit or a first top-up it seeds a fresh person's `credits` row with the $1.00 starter
	 * before adding. A replay of the same key is a no-op that reports the current balance; a key reused for a
	 * DIFFERENT movement (another person, amount or kind) is refused rather than silently keeping the first.
	 */
	async recordCreditAdjustment(a: CreditAdjustmentInput): Promise<AdjustmentResult> {
		validateAdjustment(a);
		const reason = a.reason.slice(0, ADJUSTMENT_REASON_MAX_CHARS);
		const actor = a.actor.slice(0, ADJUSTMENT_TEXT_MAX_CHARS);
		const batchId = a.batchId ? a.batchId.slice(0, ADJUSTMENT_TEXT_MAX_CHARS) : null;
		const sourceRef = a.sourceRef ? a.sourceRef.slice(0, ADJUSTMENT_TEXT_MAX_CHARS) : null;
		return tracer.startActiveSpan("billing.record_adjustment", async (span) => {
			span.setAttributes({
				"billing.adjustment_id": a.adjustmentId,
				"billing.amount_micro_usd": a.amountMicroUsd,
				"billing.adjustment_kind": a.kind,
				"db.system": "sqlite",
				"db.write_mode": "CAS",
			});
			try {
				const result = await this.tx(async (tx) => {
					const now = Date.now();
					const inserted = await tx.execute({
						sql: `INSERT INTO credit_adjustments
								(adjustment_id, user_id, amount_micro_usd, kind, reason,
								 actor, batch_id, source_ref, created_at)
							VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
							ON CONFLICT(adjustment_id) DO NOTHING`,
						args: [a.adjustmentId, a.userId, a.amountMicroUsd, a.kind, reason, actor, batchId, sourceRef, now],
					});
					const isNew = inserted.rowsAffected > 0;
					if (!isNew) {
						const existing = await tx.execute({
							sql: "SELECT user_id, amount_micro_usd, kind FROM credit_adjustments WHERE adjustment_id = ?",
							args: [a.adjustmentId],
						});
						const row = existing.rows[0];
						if (
							!row ||
							String(row.user_id) !== a.userId ||
							Number(row.amount_micro_usd) !== a.amountMicroUsd ||
							String(row.kind) !== a.kind
						) {
							throw new Error(`credit adjustment idempotency conflict for ${a.adjustmentId}`);
						}
					} else {
						await tx.execute({
							sql: `INSERT INTO credits (user_id, balance_micro_usd, lifetime_usage_micro_usd, updated_at)
								VALUES (?, ?, 0, ?)
								ON CONFLICT(user_id) DO NOTHING`,
							args: [a.userId, FREE_TIER_BALANCE_MICRO_USD, now],
						});
						await tx.execute({
							sql: `UPDATE credits
								SET balance_micro_usd = balance_micro_usd + :amt, updated_at = :now
								WHERE user_id = :u`,
							args: { amt: a.amountMicroUsd, now, u: a.userId },
						});
					}
					const balance = await tx.execute({
						sql: "SELECT balance_micro_usd FROM credits WHERE user_id = ?",
						args: [a.userId],
					});
					return {
						isNew,
						balanceMicroUsd: Number(balance.rows[0]?.balance_micro_usd ?? FREE_TIER_BALANCE_MICRO_USD),
					};
				}, "CAS");
				span.setAttribute("billing.is_new_adjustment", result.isNew);
				return result;
			} finally {
				span.end();
			}
		});
	}

	async getCreditAdjustment(adjustmentId: string): Promise<CreditAdjustmentRecord | undefined> {
		const res = await this.read({
			sql: "SELECT * FROM credit_adjustments WHERE adjustment_id = ?",
			args: [adjustmentId],
		});
		const row = res.rows[0];
		return row ? rowToAdjustment(row) : undefined;
	}

	/** Adjustments for review, oldest first; filter by person and/or batch. */
	async listCreditAdjustments(query: { userId?: string; batchId?: string } = {}): Promise<CreditAdjustmentRecord[]> {
		const clauses: string[] = [];
		const args: string[] = [];
		if (query.userId !== undefined) {
			clauses.push("user_id = ?");
			args.push(query.userId);
		}
		if (query.batchId !== undefined) {
			clauses.push("batch_id = ?");
			args.push(query.batchId);
		}
		const res = await this.read({
			sql: `SELECT * FROM credit_adjustments
				${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
				ORDER BY created_at ASC, adjustment_id ASC`,
			args,
		});
		return res.rows.map(rowToAdjustment);
	}

	/**
	 * Everyone whose balance is below `barMicroUsd`, in account order, with that balance: the set the "credits
	 * start" lift is read from (`billing-adjust.ts`). One read, so a snapshot of who is below the bar at this
	 * moment. A person the ledger has never seen has no row: they stand at the $1.00 seed, not below it.
	 */
	async listCreditsBelow(barMicroUsd: number): Promise<Array<{ userId: string; balanceMicroUsd: number }>> {
		const res = await this.read({
			sql: `SELECT user_id, balance_micro_usd FROM credits
				WHERE balance_micro_usd < ?
				ORDER BY user_id ASC`,
			args: [barMicroUsd],
		});
		return res.rows.map((row) => ({ userId: String(row.user_id), balanceMicroUsd: Number(row.balance_micro_usd) }));
	}

	/**
	 * A person's credit movements, newest first: grants that actually credited (never a non-USD or test
	 * payment) and every signed adjustment. Keyset-paged on (ts, id); `hasMore` says a next page exists.
	 */
	async listCreditMovements(
		userId: string,
		options: { limit: number; before?: { ts: number; id: string } },
	): Promise<{ rows: CreditMovementRow[]; hasMore: boolean }> {
		const args: Array<string | number> = [userId, userId];
		if (options.before) args.push(options.before.ts, options.before.ts, options.before.id);
		args.push(options.limit + 1);
		const res = await this.read({
			sql: `SELECT id, src, ts, amount, detail, reason FROM (
					SELECT 'g:' || grant_id AS id, 'grant' AS src, granted_at AS ts,
						amount_micro_usd AS amount, stripe_object AS detail, NULL AS reason
					FROM credit_grants WHERE user_id = ? AND credited = 1
					UNION ALL
					SELECT 'a:' || adjustment_id, 'adjustment', created_at, amount_micro_usd, kind, reason
					FROM credit_adjustments WHERE user_id = ?
				)
				${options.before ? "WHERE ts < ? OR (ts = ? AND id < ?)" : ""}
				ORDER BY ts DESC, id DESC
				LIMIT ?`,
			args,
		});
		const rows = res.rows.map(
			(row): CreditMovementRow => ({
				id: String(row.id),
				source: String(row.src) === "grant" ? "grant" : "adjustment",
				ts: Number(row.ts),
				amountMicroUsd: Number(row.amount),
				detail: String(row.detail),
				reason: s(row.reason),
			}),
		);
		const hasMore = rows.length > options.limit;
		return { rows: hasMore ? rows.slice(0, options.limit) : rows, hasMore };
	}

	// ── Sobremesa credits: gate_events + gate_daily_counts ───────────────────

	/**
	 * Append one gate decision. Append-only: identical events are separate rows
	 * and nothing here ever updates or deletes. The caller (the credit gate) treats
	 * a write failure as non-fatal; this method just refuses to write a row nothing
	 * can interpret.
	 *
	 * @returns the new row id.
	 */
	async recordGateEvent(e: GateEventInput): Promise<number> {
		validateGateEvent(e);
		const res = await this.write(
			{
				sql: `INSERT INTO gate_events
						(ts, user_id, mode, door, decision, model, balance_micro_usd, required_micro_usd, reason)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
					RETURNING id`,
				args: [
					e.ts,
					e.userId,
					e.mode,
					e.door,
					e.decision,
					e.model,
					e.balanceMicroUsd,
					e.requiredMicroUsd,
					e.reason === null ? null : e.reason.slice(0, GATE_REASON_MAX_CHARS),
				],
			},
			"APPEND",
		);
		const id = res.rows[0]?.id;
		if (typeof id !== "number" && typeof id !== "bigint") {
			throw new Error(`recordGateEvent: expected a numeric row id, got ${String(id)}`);
		}
		return Number(id);
	}

	/** Read gate decisions, newest first. */
	async listGateEvents(
		query: { sinceTs?: number; userId?: string; decision?: GateDecision; limit?: number } = {},
	): Promise<GateEventRecord[]> {
		const clauses: string[] = [];
		const args: Array<string | number> = [];
		if (query.sinceTs !== undefined) {
			clauses.push("ts >= ?");
			args.push(query.sinceTs);
		}
		if (query.userId !== undefined) {
			clauses.push("user_id = ?");
			args.push(query.userId);
		}
		if (query.decision !== undefined) {
			clauses.push("decision = ?");
			args.push(query.decision);
		}
		args.push(Math.min(Math.max(1, Math.trunc(query.limit ?? 1_000)), 10_000));
		const res = await this.read({
			sql: `SELECT * FROM gate_events
				${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
				ORDER BY ts DESC, id DESC
				LIMIT ?`,
			args,
		});
		return res.rows.map(rowToGateEvent);
	}

	/** Add plain-allow counts to their (day, mode, door, decision) rows, in one transaction. */
	async bumpGateCounters(rows: readonly GateCounterDelta[]): Promise<void> {
		if (rows.length === 0) return;
		for (const row of rows) validateGateCounter(row);
		await this.tx(async (tx) => {
			for (const row of rows) {
				await tx.execute({
					sql: `INSERT INTO gate_daily_counts (day, mode, door, decision, n)
						VALUES (?, ?, ?, ?, ?)
						ON CONFLICT(day, mode, door, decision) DO UPDATE SET n = n + excluded.n`,
					args: [row.day, row.mode, row.door, row.decision, row.n],
				});
			}
		}, "UPSERT");
	}

	/** The daily counter rows, oldest day first. */
	async gateDailyCounts(query: { day?: string } = {}): Promise<GateCounterRecord[]> {
		const res = await this.read({
			sql: `SELECT day, mode, door, decision, n FROM gate_daily_counts
				${query.day === undefined ? "" : "WHERE day = ?"}
				ORDER BY day ASC, mode ASC, door ASC, decision ASC`,
			args: query.day === undefined ? [] : [query.day],
		});
		return res.rows.map((row) => ({
			day: String(row.day),
			mode: String(row.mode) as GateMode,
			door: String(row.door) as GateDoor,
			decision: String(row.decision) as GateDecision | "allow",
			n: Number(row.n),
		}));
	}

	// snapshotToS3 / restoreFromS3 / close are inherited from LibsqlStore.
}

// ─── Shared usage INSERT ──────────────────────────────────────────────────
/** A libSQL executor — either the base `Client` or an open write `Transaction`. */
type Executor = Pick<Client, "execute">;

/**
 * The single source of truth for the usage_events INSERT (statement + arg list).
 * Shared by `recordUsage` (via `write()`) and `recordUsageAndDebit` (inside a
 * write transaction) so the 25-column list can never drift between the two.
 * `INSERT … ON CONFLICT(event_id) DO NOTHING` — idempotent, first-write-wins.
 */
function usageInsert(exec: Executor, e: UsageEventInput) {
	return exec.execute(usageInsertStmt(e));
}

/** The usage INSERT as a bare statement (for routing through the serialized `write()`). */
function usageInsertStmt(e: UsageEventInput) {
	if (e.fundingSource !== undefined && e.fundingSource !== "platform" && e.fundingSource !== "user")
		throw new Error("Invalid inference funding source");
	if (e.fundingSource === "user" && (e.provider !== "openrouter" || !e.userId))
		throw new Error("User-funded usage requires an OpenRouter owner");
	return {
		sql: `INSERT INTO usage_events (
				event_id, kind, ts, user_id, graph_id, sandbox_id, template,
				session_id, generation, inference_operation_id, request_id, child_run_id, allocation_id,
				provider, model, model_priced, reason,
				input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
				input_cost_micro_usd, output_cost_micro_usd, cache_read_cost_micro_usd,
				cache_write_cost_micro_usd, provider_cost_micro_usd, provider_reported_cost_micro_usd,
				markup_micro_usd, cost_micro_usd,
				pricing_version, priced_default, funding_source, provider_generation_id,
				pricing_basis, card_cost_micro_usd, card_provider_cost_micro_usd)
			VALUES (?, 'usage_event', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(event_id) DO NOTHING`,
		args: [
			e.eventId,
			e.ts,
			e.userId,
			e.graphId,
			e.sandboxId,
			e.template,
			e.sessionId ?? null,
			e.generation ?? null,
			e.inferenceOperationId ?? null,
			e.requestId ?? null,
			e.childRunId ?? null,
			e.allocationId ?? null,
			e.provider,
			e.model,
			e.modelPriced,
			e.reason,
			e.inputTokens,
			e.outputTokens,
			e.cacheReadTokens,
			e.cacheWriteTokens,
			e.totalTokens,
			e.inputCostMicroUsd,
			e.outputCostMicroUsd,
			e.cacheReadCostMicroUsd,
			e.cacheWriteCostMicroUsd,
			e.providerCostMicroUsd,
			e.providerReportedCostMicroUsd ?? null,
			e.markupMicroUsd,
			e.costMicroUsd,
			e.pricingVersion,
			e.pricedDefault ? 1 : 0,
			e.fundingSource ?? "platform",
			e.providerGenerationId ?? null,
			e.pricingBasis ?? null,
			e.cardCostMicroUsd ?? null,
			e.cardProviderCostMicroUsd ?? null,
		],
	};
}

// ─── Row mapper ───────────────────────────────────────────────────────────
type LibsqlRow = Record<string, unknown>;

function rowToCredit(row: LibsqlRow): CreditRecord {
	return {
		userId: String(row.user_id),
		balanceMicroUsd: Number(row.balance_micro_usd),
		lifetimeUsageMicroUsd: Number(row.lifetime_usage_micro_usd),
		updatedAt: Number(row.updated_at),
	};
}

function s(v: unknown): string | null {
	return v == null ? null : String(v);
}

function rowToAdjustment(row: LibsqlRow): CreditAdjustmentRecord {
	return {
		adjustmentId: String(row.adjustment_id),
		userId: String(row.user_id),
		amountMicroUsd: Number(row.amount_micro_usd),
		kind: String(row.kind) as CreditAdjustmentKind,
		reason: String(row.reason),
		actor: String(row.actor),
		batchId: s(row.batch_id),
		sourceRef: s(row.source_ref),
		createdAt: Number(row.created_at),
	};
}

function rowToGateEvent(row: LibsqlRow): GateEventRecord {
	return {
		id: Number(row.id),
		ts: Number(row.ts),
		userId: s(row.user_id),
		mode: String(row.mode) as GateMode,
		door: String(row.door) as GateDoor,
		decision: String(row.decision) as GateDecision,
		model: s(row.model),
		balanceMicroUsd: row.balance_micro_usd == null ? null : Number(row.balance_micro_usd),
		requiredMicroUsd: row.required_micro_usd == null ? null : Number(row.required_micro_usd),
		reason: s(row.reason),
	};
}

function rowToUsageEvent(row: LibsqlRow): UsageEventRecord {
	return {
		eventId: String(row.event_id),
		fundingSource: row.funding_source === "user" ? "user" : "platform",
		kind: String(row.kind),
		ts: Number(row.ts),
		userId: s(row.user_id),
		graphId: s(row.graph_id),
		sandboxId: s(row.sandbox_id),
		template: s(row.template),
		sessionId: s(row.session_id),
		generation: row.generation == null ? null : Number(row.generation),
		inferenceOperationId: s(row.inference_operation_id),
		requestId: s(row.request_id),
		childRunId: s(row.child_run_id),
		allocationId: s(row.allocation_id),
		provider: String(row.provider ?? "openrouter"),
		model: String(row.model),
		modelPriced: String(row.model_priced ?? ""),
		reason: s(row.reason),
		inputTokens: Number(row.input_tokens),
		outputTokens: Number(row.output_tokens),
		cacheReadTokens: Number(row.cache_read_tokens),
		cacheWriteTokens: Number(row.cache_write_tokens),
		totalTokens: Number(row.total_tokens),
		inputCostMicroUsd: Number(row.input_cost_micro_usd),
		outputCostMicroUsd: Number(row.output_cost_micro_usd),
		cacheReadCostMicroUsd: Number(row.cache_read_cost_micro_usd),
		cacheWriteCostMicroUsd: Number(row.cache_write_cost_micro_usd),
		providerCostMicroUsd: Number(row.provider_cost_micro_usd),
		providerReportedCostMicroUsd:
			row.provider_reported_cost_micro_usd == null ? null : Number(row.provider_reported_cost_micro_usd),
		providerGenerationId: s(row.provider_generation_id),
		pricingBasis:
			row.pricing_basis === "card" ||
			row.pricing_basis === "fallback-actual" ||
			row.pricing_basis === "fallback-card"
				? row.pricing_basis
				: null,
		cardCostMicroUsd: row.card_cost_micro_usd == null ? null : Number(row.card_cost_micro_usd),
		cardProviderCostMicroUsd:
			row.card_provider_cost_micro_usd == null ? null : Number(row.card_provider_cost_micro_usd),
		markupMicroUsd: Number(row.markup_micro_usd),
		costMicroUsd: Number(row.cost_micro_usd),
		pricingVersion: String(row.pricing_version),
		pricedDefault: Number(row.priced_default) === 1,
	};
}

function rowToCustomer(row: LibsqlRow): CustomerMapRecord {
	return {
		userId: String(row.user_id),
		stripeCustomerId: String(row.stripe_customer_id),
		email: s(row.email),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

function rowToGrant(row: LibsqlRow): CreditGrantRecord {
	return {
		grantId: String(row.grant_id),
		kind: String(row.kind),
		userId: String(row.user_id),
		stripeCustomerId: String(row.stripe_customer_id),
		sourceEventId: String(row.source_event_id),
		stripeObject: String(row.stripe_object),
		amountMicroUsd: Number(row.amount_micro_usd),
		currency: String(row.currency),
		livemode: Number(row.livemode),
		grantedAt: Number(row.granted_at),
		credited: Number(row.credited) === 1,
	};
}

function rowToSubscription(row: LibsqlRow): SubscriptionRecord {
	return {
		userId: String(row.user_id),
		stripeCustomerId: s(row.stripe_customer_id),
		stripeSubscriptionId: s(row.stripe_subscription_id),
		plan: s(row.plan),
		status: String(row.status),
		tier: String(row.tier) as Tier,
		currentPeriodEnd: row.current_period_end == null ? null : Number(row.current_period_end),
		livemode: Number(row.livemode),
		eventCreated: Number(row.event_created),
		sourceEventId: s(row.source_event_id),
		updatedAt: Number(row.updated_at),
	};
}
