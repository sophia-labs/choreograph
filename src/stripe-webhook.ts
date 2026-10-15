/**
 * Stripe webhook ingestion (Billing I&E P1b) — dep-free signature verification
 * + event → fold dispatch. NO stripe SDK: the signing scheme is HMAC-SHA256 over
 * the EXACT raw body, which we verify directly (so the body MUST be read unparsed
 * — see orchestrator `readRawBody`; `readJsonBody` would trim+parse and break it).
 *
 * One webhook, four folds. Money IN: a paid top-up `checkout.session.completed` (or, for delayed
 * payment methods, `checkout.session.async_payment_succeeded`) → recordGrantAndCredit, under the grant
 * id `cs:<session>` for `amount_subtotal` (Sobremesa credits, E §4.4.5). `payment_intent.succeeded` is
 * acknowledged and NEVER credits: it also fires for a subscription invoice, and crediting both events
 * would pay one payment twice. Money OUT: `charge.refunded` and `charge.dispute.created` →
 * recordPaymentClawback, a signed negative adjustment against the top-up they belong to. Tier:
 * `customer.subscription.*` → recordSubscriptionAndFold. And `customer.created|updated` carrying
 * `metadata.user_id` → upsertCustomer (the cus_ ↔ Cognito-sub ownership link).
 *
 * What we understood but cannot lawfully credit or claw back (non-USD money, an unmapped customer, a
 * session naming someone else, a refund of a payment we never credited...) raises an ALARM: a durable
 * `billing_alarms` row plus one countable log line per event, never a silent skip. Those responses are
 * 200 when Stripe retrying would change nothing.
 *
 * The live endpoint needs `STRIPE_WEBHOOK_SECRET` (whsec_…) set; the no-mock tests sign synthetic events
 * with a test secret so the verification path is proven with REAL crypto — no stubs.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
	BillingAlarmInput,
	BillingAlarmKind,
	BillingStore,
	ClawbackResult,
	CreditGrantInput,
	PaymentClawbackInput,
	StripeWebhookInput,
	SubscriptionInput,
	Tier,
} from "./billing-store.js";
import { MONTHLY_TIER_CREDIT_MICRO_USD, subscriptionToTier } from "./billing-store.js";

export interface StripeSigResult {
	ok: boolean;
	reason?: string;
}

/**
 * Verify a `Stripe-Signature` header against the raw body + signing secret.
 * Header: `t=<unix>,v1=<hex>[,v1=<hex>…]`; signedPayload = `${t}.${rawBody}`;
 * expected = HMAC-SHA256(signedPayload, secret) hex; constant-time compare to
 * ANY v1; reject if `|now − t| > tolerance` (default 300s). Dep-free.
 */
export function verifyStripeSignature(
	rawBody: string,
	sigHeader: string | undefined,
	secret: string,
	opts?: { toleranceSecs?: number; nowSecs?: number },
): StripeSigResult {
	if (!secret) return { ok: false, reason: "no_secret" };
	if (!sigHeader) return { ok: false, reason: "no_signature_header" };
	const tolerance = opts?.toleranceSecs ?? 300;
	const now = opts?.nowSecs ?? Math.floor(Date.now() / 1000);
	let t: number | undefined;
	const v1s: string[] = [];
	for (const part of sigHeader.split(",")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		const k = part.slice(0, eq).trim();
		const v = part.slice(eq + 1).trim();
		if (k === "t") t = Number(v);
		else if (k === "v1") v1s.push(v);
	}
	if (t === undefined || Number.isNaN(t)) return { ok: false, reason: "no_timestamp" };
	if (Math.abs(now - t) > tolerance) return { ok: false, reason: "timestamp_out_of_tolerance" };
	if (v1s.length === 0) return { ok: false, reason: "no_v1" };
	const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex"), "hex");
	for (const v1 of v1s) {
		let candidate: Buffer;
		try {
			candidate = Buffer.from(v1, "hex");
		} catch {
			continue;
		}
		if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
			return { ok: true };
		}
	}
	return { ok: false, reason: "signature_mismatch" };
}

/**
 * TEST/DEV helper: produce a `Stripe-Signature` header the verifier accepts
 * (mirrors Stripe's signing so the no-mock test uses REAL HMAC, not a stub).
 */
export function signStripePayload(rawBody: string, secret: string, tSecs: number): string {
	const sig = createHmac("sha256", secret).update(`${tSecs}.${rawBody}`, "utf8").digest("hex");
	return `t=${tSecs},v1=${sig}`;
}

// ─── Event mapping (pure) ───────────────────────────────────────────────────

interface StripeEventEnvelope {
	id: string;
	type: string;
	api_version?: string | null;
	created?: number | null;
	livemode?: boolean;
	data?: { object?: unknown };
}
interface SubObject {
	id?: string;
	customer?: string;
	status?: string;
	current_period_end?: number | null;
	items?: { data?: Array<{ price?: { id?: string } }> };
}
/** The parts of a Checkout Session the money-in path reads. Reference fields may arrive as an id or an object. */
interface CheckoutSessionObject {
	id?: string;
	mode?: string;
	payment_status?: string;
	customer?: unknown;
	client_reference_id?: string | null;
	metadata?: { kind?: string; user_id?: string } | null;
	amount_subtotal?: number | null;
	amount_total?: number | null;
	currency?: string | null;
	payment_intent?: unknown;
}
interface ChargeObject {
	id?: string;
	/** CUMULATIVE cents refunded on the charge so far. */
	amount_refunded?: number | null;
	currency?: string | null;
	customer?: unknown;
	payment_intent?: unknown;
}
interface DisputeObject {
	id?: string;
	amount?: number | null;
	currency?: string | null;
	charge?: unknown;
	payment_intent?: unknown;
}
interface CustomerObject {
	id?: string;
	email?: string | null;
	metadata?: { user_id?: string } | null;
}
interface InvoiceObject {
	id?: string;
	customer?: string;
	subscription?: string;
	billing_reason?: string;
	/** The billed line items — the first line's price is the order-independent tier source. */
	lines?: { data?: Array<{ price?: { id?: string } }> };
}

export type MappedEvent =
	| { kind: "customer"; userId: string; customerId: string; email: string | null }
	| { kind: "subscription"; customerId: string; webhook: StripeWebhookInput; sub: Omit<SubscriptionInput, "userId"> }
	| {
			kind: "grant";
			customerId: string;
			webhook: StripeWebhookInput;
			grant: Omit<CreditGrantInput, "userId">;
			/** The Checkout Session the money came in on: what an alarm points at. */
			objectId: string;
			/** Whom the session says it is for (`client_reference_id`, `metadata.user_id`): each must be the owner. */
			claimedUserIds: readonly string[];
	  }
	| {
			/** A paid top-up understood but not creditable as sent; the alarm says why. */
			kind: "refused";
			alarm: BillingAlarmKind;
			customerId: string | null;
			webhook: StripeWebhookInput;
			objectId: string;
			detail: string;
	  }
	| { kind: "clawback"; webhook: StripeWebhookInput; clawback: PaymentClawbackInput; objectId: string; detail: string }
	| {
			kind: "renewal";
			customerId: string;
			webhook: StripeWebhookInput;
			invoiceId: string;
			billingReason: string;
			priceId: string | undefined;
			livemode: number;
	  }
	| { kind: "ignored"; type: string; reason?: string };

function envelopeWebhook(event: StripeEventEnvelope, customerId: string | null): StripeWebhookInput {
	return {
		eventId: event.id,
		eventType: event.type,
		stripeCreated: event.created ?? null,
		apiVersion: event.api_version ?? null,
		livemode: event.livemode ? 1 : 0,
		stripeCustomerId: customerId,
		payloadSha256: null,
	};
}

/** A Stripe reference field: the id string, or (when a caller expanded it) an object carrying `id`. */
function idOf(value: unknown): string | null {
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value === "object" && value !== null) {
		const id = (value as { id?: unknown }).id;
		if (typeof id === "string" && id.length > 0) return id;
	}
	return null;
}

function positiveWholeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function currencyOf(value: unknown): string {
	return typeof value === "string" && value.length > 0 ? value.toLowerCase() : "unknown";
}

/** µUSD per cent: the ledger's unit is millionths of a dollar. */
const MICRO_USD_PER_CENT = 10_000;

/** A paid Checkout top-up session: credit it, refuse it with an alarm, or say why it is not ours. */
function mapCheckoutSession(event: StripeEventEnvelope): MappedEvent {
	const type = event.type;
	const obj = (event.data?.object ?? {}) as CheckoutSessionObject;
	// Only a one-off top-up session is money in. A subscription session's money arrives, and is credited, as its
	// invoices; anything that does not carry our marker is not ours to credit.
	if (!obj.id || obj.mode !== "payment" || obj.metadata?.kind !== "topup") {
		return { kind: "ignored", type, reason: "not_a_topup" };
	}
	// `completed` also fires for delayed payment methods before the money settles; the async event says when it has.
	if (obj.payment_status !== "paid") return { kind: "ignored", type, reason: "payment_not_settled" };

	const customerId = idOf(obj.customer);
	const refused = (alarm: BillingAlarmKind, detail: string): MappedEvent => ({
		kind: "refused",
		alarm,
		customerId,
		webhook: envelopeWebhook(event, customerId),
		objectId: obj.id ?? "",
		detail,
	});
	const subtotal = obj.amount_subtotal;
	if (!positiveWholeNumber(subtotal) || !Number.isSafeInteger(subtotal * MICRO_USD_PER_CENT)) {
		return refused("bad_topup_amount", `amount_subtotal=${JSON.stringify(subtotal ?? null)} on a paid top-up`);
	}
	if (!customerId) return refused("unmapped_customer", "a paid top-up session carries no customer");

	const paymentIntentId = idOf(obj.payment_intent);
	// The credit is the pre-tax subtotal; the charge (tax included) is what a refund is a share of.
	const chargeAmountCents = positiveWholeNumber(obj.amount_total) ? obj.amount_total : subtotal;
	const claimed = [obj.client_reference_id, obj.metadata?.user_id];
	return {
		kind: "grant",
		customerId,
		webhook: envelopeWebhook(event, customerId),
		grant: {
			// Idempotency on the SESSION, the identity of a top-up. The PaymentIntent's `pi:` id is an alias: money
			// the previous release credited under it is not credited again.
			grantId: `cs:${obj.id}`,
			stripeCustomerId: customerId,
			sourceEventId: event.id,
			stripeObject: "checkout_session",
			amountMicroUsd: subtotal * MICRO_USD_PER_CENT,
			currency: currencyOf(obj.currency),
			livemode: event.livemode ? 1 : 0,
			...(paymentIntentId
				? { aliases: [`pi:${paymentIntentId}`], payment: { paymentIntentId, chargeAmountCents } }
				: {}),
		},
		objectId: obj.id,
		claimedUserIds: claimed.filter((id): id is string => typeof id === "string" && id.length > 0),
	};
}

/** A refund or a dispute: the money returned, to claw back from the top-up it belongs to. */
function mapClawback(event: StripeEventEnvelope): MappedEvent {
	const type = event.type;
	const live = event.livemode ? 1 : 0;
	if (type === "charge.refunded") {
		const obj = (event.data?.object ?? {}) as ChargeObject;
		if (!obj.id || !positiveWholeNumber(obj.amount_refunded)) return { kind: "ignored", type, reason: "no_refund" };
		const paymentIntentId = idOf(obj.payment_intent);
		return {
			kind: "clawback",
			webhook: envelopeWebhook(event, idOf(obj.customer)),
			clawback: {
				kind: "refund",
				// One adjustment per cumulative refund state: a redelivery of a state already taken is a no-op.
				adjustmentId: `refund:${obj.id}:${obj.amount_refunded}`,
				paymentIntentId,
				currency: currencyOf(obj.currency),
				livemode: live,
				affectedCents: obj.amount_refunded,
				reason: "Refund of a credit purchase",
			},
			objectId: obj.id,
			detail: `payment_intent=${paymentIntentId ?? "-"} refunded_cents=${obj.amount_refunded}`,
		};
	}
	const obj = (event.data?.object ?? {}) as DisputeObject;
	if (!obj.id || !positiveWholeNumber(obj.amount)) return { kind: "ignored", type, reason: "no_dispute" };
	const paymentIntentId = idOf(obj.payment_intent);
	return {
		kind: "clawback",
		webhook: envelopeWebhook(event, null),
		clawback: {
			kind: "dispute",
			adjustmentId: `dispute:${obj.id}`,
			paymentIntentId,
			currency: currencyOf(obj.currency),
			livemode: live,
			affectedCents: obj.amount,
			reason: "Dispute on a credit purchase",
		},
		objectId: obj.id,
		detail: `payment_intent=${paymentIntentId ?? "-"} charge=${idOf(obj.charge) ?? "-"} disputed_cents=${obj.amount}`,
	};
}

/** Map a verified Stripe event to a fold intent. Pure (no I/O). */
export function mapStripeEvent(event: StripeEventEnvelope): MappedEvent {
	const type = event.type;
	const live = event.livemode ? 1 : 0;

	if (type === "customer.created" || type === "customer.updated") {
		const obj = (event.data?.object ?? {}) as CustomerObject;
		const customerId = obj.id;
		const userId = obj.metadata?.user_id;
		if (!customerId || !userId) return { kind: "ignored", type };
		return { kind: "customer", userId, customerId, email: obj.email ?? null };
	}

	if (type.startsWith("customer.subscription.")) {
		const obj = (event.data?.object ?? {}) as SubObject;
		const customerId = obj.customer;
		if (!customerId) return { kind: "ignored", type };
		// A deletion event is a cancellation regardless of the carried status.
		const status = type === "customer.subscription.deleted" ? "canceled" : (obj.status ?? "canceled");
		const plan = obj.items?.data?.[0]?.price?.id ?? "";
		return {
			kind: "subscription",
			customerId,
			webhook: envelopeWebhook(event, customerId),
			sub: {
				stripeCustomerId: customerId,
				stripeSubscriptionId: obj.id ?? "",
				plan,
				status,
				currentPeriodEnd: obj.current_period_end ?? null,
				livemode: live,
			},
		};
	}

	if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
		return mapCheckoutSession(event);
	}

	// The PaymentIntent behind a top-up is credited from its SESSION. This event ALSO fires for a subscription
	// invoice's payment, and crediting it as a top-up would pay one payment twice: acknowledge, never credit.
	if (type === "payment_intent.succeeded") {
		return { kind: "ignored", type, reason: "credited_from_checkout_session" };
	}

	if (type === "charge.refunded" || type === "charge.dispute.created") return mapClawback(event);

	if (type === "invoice.payment_succeeded") {
		const obj = (event.data?.object ?? {}) as InvoiceObject;
		const customerId = obj.customer;
		const invoiceId = obj.id;
		const billingReason = obj.billing_reason ?? "";
		// The billed price lives on the invoice itself — the order-independent tier
		// source (a not-yet-folded or later-changed subscription cannot distort it).
		const priceId = obj.lines?.data?.[0]?.price?.id;
		// Only RECURRING subscription invoices grant monthly credits:
		// subscription_create (first paid month) + subscription_cycle (renewals).
		// One-off / manual / proration invoices are acked but never deposit.
		const recurring = billingReason === "subscription_create" || billingReason === "subscription_cycle";
		if (!customerId || !invoiceId || !recurring) return { kind: "ignored", type };
		return {
			kind: "renewal",
			customerId,
			webhook: envelopeWebhook(event, customerId),
			invoiceId,
			billingReason,
			priceId,
			livemode: live,
		};
	}

	return { kind: "ignored", type };
}

// ─── Process (verify → parse → map → resolve → dispatch) ────────────────────

export interface StripeWebhookDeps {
	billing: BillingStore;
	secret: string;
	planTierMap?: Record<string, Tier>;
	/** Push a newly-applied tier to the gateway entitlements store (P1c). Called
	 *  ONLY when a subscription fold actually changes state; best-effort (a throw
	 *  is logged, never fails the webhook). Omit to skip — the `subscription_state`
	 *  row is the SoR + reconcilable. */
	pushTier?: (userId: string, tier: Tier) => Promise<void>;
	/** Clock override for the signature timestamp-tolerance check (tests). */
	nowSecs?: number;
	/** Where an ALARM line goes: one countable line per alarm, once per event. Default `console.error`. */
	log?: (line: string) => void;
}

export interface StripeWebhookResult {
	status: number;
	body: Record<string, unknown>;
}

/** The body of a paid top-up that was understood and refused, with the alarm that says why. */
function refusedGrantBody(alarm: BillingAlarmKind): Record<string, unknown> {
	return { kind: "grant", credited: false, isNewGrant: false, alarm };
}

/** Which alarm, if any, a claw-back that did not apply owes: money we cannot match or convert. */
function clawbackAlarmKind(result: ClawbackResult): BillingAlarmKind | undefined {
	if (result.applied) return undefined;
	if (result.reason === "unmatched_payment") return "unmatched_payment";
	if (result.reason === "currency_mismatch") return "clawback_currency_mismatch";
	return undefined;
}

/**
 * Record a durable alarm and, the first time this event raises it, log one line for the log pipeline to
 * count. Only ids and reasons are logged: never an email, a token or a secret.
 */
async function raiseAlarm(deps: StripeWebhookDeps, alarm: BillingAlarmInput): Promise<void> {
	if (!(await deps.billing.recordBillingAlarm(alarm))) return;
	const parts = [
		`[stripe-webhook] ALARM ${alarm.kind}`,
		`event=${alarm.eventId ?? "-"}`,
		`type=${alarm.eventType ?? "-"}`,
		`object=${alarm.objectId ?? "-"}`,
		`user=${alarm.userId ?? "-"}`,
	];
	if (alarm.detail) parts.push(alarm.detail);
	(deps.log ?? ((line: string) => console.error(line)))(parts.join(" "));
}

/**
 * Verify → parse → map → resolve user → dispatch the fold. Returns the HTTP
 * status + body. Fully testable with a real BillingStore + real signatures.
 * May throw on a billing-store error; the route wraps it to a 5xx so Stripe
 * retries (never crash the request loop).
 */
export async function processStripeWebhook(
	rawBody: string,
	sigHeader: string | undefined,
	deps: StripeWebhookDeps,
): Promise<StripeWebhookResult> {
	const sig = verifyStripeSignature(rawBody, sigHeader, deps.secret, { nowSecs: deps.nowSecs });
	if (!sig.ok) return { status: 400, body: { error: "signature", reason: sig.reason ?? "invalid" } };

	let event: StripeEventEnvelope;
	try {
		event = JSON.parse(rawBody) as StripeEventEnvelope;
	} catch {
		return { status: 400, body: { error: "bad_json" } };
	}
	if (!event.id || !event.type) return { status: 400, body: { error: "not_a_stripe_event" } };

	const mapped = mapStripeEvent(event);
	if (mapped.kind === "ignored") {
		return { status: 200, body: { ignored: mapped.type, ...(mapped.reason ? { reason: mapped.reason } : {}) } };
	}

	if (mapped.kind === "customer") {
		await deps.billing.upsertCustomer(mapped.userId, mapped.customerId, mapped.email);
		return { status: 200, body: { kind: "customer", customer: mapped.customerId } };
	}

	const payloadSha256 = createHash("sha256").update(rawBody, "utf8").digest("hex");
	const webhook = { ...mapped.webhook, payloadSha256 };
	const alarm = (kind: BillingAlarmKind, userId: string | null, objectId: string, detail: string) =>
		raiseAlarm(deps, { kind, eventId: event.id, eventType: event.type, userId, objectId, detail });

	// A paid top-up that cannot be credited as sent. Retrying would change nothing: 200, and the alarm says why.
	if (mapped.kind === "refused") {
		const owner = mapped.customerId ? await deps.billing.getUserByCustomer(mapped.customerId) : undefined;
		await alarm(mapped.alarm, owner ?? null, mapped.objectId, mapped.detail);
		return { status: 200, body: refusedGrantBody(mapped.alarm) };
	}

	// A refund or a dispute names the PAYMENT, not the customer: found through the PaymentIntent link recorded
	// when the top-up was credited. Money we cannot match is 200 (a payment we will never match must not be
	// retried for days) and an alarm.
	if (mapped.kind === "clawback") {
		const result = await deps.billing.recordPaymentClawback(webhook, mapped.clawback);
		const raised = clawbackAlarmKind(result);
		if (raised) await alarm(raised, null, mapped.objectId, mapped.detail);
		return { status: 200, body: { kind: "clawback", ...result, ...(raised ? { alarm: raised } : {}) } };
	}

	// subscription | renewal | grant: resolve the cus_ → Cognito sub. Unmapped → 409 so
	// Stripe retries (the customer.created that maps it may not have landed yet). For a paid
	// top-up it is also an alarm: the money is taken and there is nobody to credit.
	const userId = await deps.billing.getUserByCustomer(mapped.customerId);
	if (!userId) {
		if (mapped.kind === "grant") {
			await alarm("unmapped_customer", null, mapped.customerId, `checkout_session=${mapped.objectId}`);
		}
		return { status: 409, body: { error: "unmapped_customer", customer: mapped.customerId } };
	}

	if (mapped.kind === "subscription") {
		const res = await deps.billing.recordSubscriptionAndFold(webhook, { ...mapped.sub, userId }, deps.planTierMap);
		// Push the new tier to the gateway ONLY when the fold actually changed
		// state. Best-effort: subscription_state is the SoR, so a push failure is
		// logged + reconcilable and never fails the webhook (Stripe will retry).
		if (res.applied && deps.pushTier) {
			try {
				await deps.pushTier(userId, res.tier);
			} catch (err) {
				console.warn(
					`[stripe-webhook] tier push failed for ${userId} (${res.tier}): ${err instanceof Error ? err.message : err}`,
				);
			}
		}
		return { status: 200, body: { kind: "subscription", applied: res.applied, tier: res.tier } };
	}

	if (mapped.kind === "renewal") {
		// The monthly bonus-credit deposit. Resolve the tier from the INVOICE'S OWN
		// line-item price first — it is order-independent (a subscription fold that
		// hasn't landed yet, or a later up/downgrade, cannot distort it) and reflects
		// what was actually billed this cycle. Fall back to the stored subscription
		// only when the invoice carries no price; and if THAT hasn't folded yet,
		// return 409 so Stripe retries — never 200-and-silently-lose the credit
		// (Stripe treats 200 as delivered and will not redeliver). Idempotent on the
		// invoice id (`in:<invoice>`); the AMOUNT is the platform's per-tier monthly
		// allowance, NOT the Stripe charge.
		let tier: Tier;
		if (mapped.priceId) {
			tier = subscriptionToTier(mapped.priceId, "active", deps.planTierMap);
		} else {
			const sub = await deps.billing.getSubscription(userId);
			if (!sub) {
				return { status: 409, body: { error: "subscription_unresolved", invoice: mapped.invoiceId } };
			}
			tier = sub.tier;
		}
		const amountMicroUsd = MONTHLY_TIER_CREDIT_MICRO_USD[tier];
		if (!(amountMicroUsd > 0)) {
			return { status: 200, body: { kind: "renewal", credited: false, tier, reason: "no_monthly_credit_for_tier" } };
		}
		const res = await deps.billing.recordGrantAndCredit(webhook, {
			grantId: `in:${mapped.invoiceId}`,
			userId,
			stripeCustomerId: mapped.customerId,
			sourceEventId: event.id,
			stripeObject: "invoice",
			amountMicroUsd,
			currency: "usd",
			livemode: mapped.livemode,
		});
		return {
			status: 200,
			body: { kind: "renewal", credited: res.credited, isNewGrant: res.isNewGrant, tier, amountMicroUsd },
		};
	}

	// A session that names someone other than its customer's owner is never credited to either.
	const named = mapped.claimedUserIds.find((claimed) => claimed !== userId);
	if (named !== undefined) {
		const detail = `session names ${named}; customer ${mapped.customerId} belongs to ${userId}`;
		await alarm("user_mismatch", userId, mapped.objectId, detail);
		return { status: 200, body: refusedGrantBody("user_mismatch") };
	}

	const res = await deps.billing.recordGrantAndCredit(webhook, { ...mapped.grant, userId });
	// Live money in another currency is recorded but never converted or credited: an alarm, not a silent skip.
	const foreign = mapped.grant.livemode === 1 && mapped.grant.currency !== "usd";
	if (foreign) {
		const minorUnits = mapped.grant.amountMicroUsd / MICRO_USD_PER_CENT;
		const detail = `minor_units=${minorUnits} currency=${mapped.grant.currency}`;
		await alarm("non_usd_payment", userId, mapped.objectId, detail);
	}
	return {
		status: 200,
		body: {
			kind: "grant",
			credited: res.credited,
			isNewGrant: res.isNewGrant,
			...(res.suppressedLegacy ? { suppressedLegacy: true } : {}),
			...(foreign ? { alarm: "non_usd_payment" } : {}),
		},
	};
}
