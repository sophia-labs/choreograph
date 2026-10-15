/**
 * Billing checkout + portal (WS-B initiation side). Creates Stripe Checkout Sessions for a one-time credit
 * top-up and Customer Portal sessions via the dep-free Stripe REST client. The route layer keeps this INERT
 * until STRIPE_SECRET_KEY is configured. The Stripe customer is linked to our userId (customer
 * `metadata.user_id` + the local customer_map) so the webhook folds resolve the caller.
 *
 * Sobremesa credits, money-in fixes (b) and (d):
 *  - a top-up is a USD `mode: payment` session that carries the top-up marker (`metadata[kind]=topup`) on the
 *    SESSION and on its PaymentIntent. The webhook credits only a paid session carrying that marker
 *    (`stripe-webhook.ts`), so without it a purchase would be received and never credited;
 *  - whole dollars from $5 to $200, checked HERE as well as at the gateway: `choreograph.example.invalid` is
 *    reachable without the gateway;
 *  - a subscription is refused (503 `subscriptions_unavailable`) before Stripe is touched: an invoice's money
 *    would double-credit and the entitlement route the tier push needs does not exist;
 *  - the customer is created with the caller's verified email when we know it, so Stripe's receipt can go out,
 *    under an Idempotency-Key that makes a duplicate create converge, and concurrent first checkouts of one
 *    person share ONE create;
 *  - every request is version-pinned and keyed (`stripe-api.ts`).
 */

import { createHash } from "node:crypto";
import type { BillingStore } from "./billing-store.js";
import { type StripeParams, stripePost } from "./stripe-api.js";

/** A top-up is whole dollars from $5 (a purchase smaller than that loses money to fees) ... */
export const MIN_TOPUP_CENTS = 500;
/** ... to $200, until a month of clean reconciliation (ruling 5). */
export const MAX_TOPUP_CENTS = 20_000;

export interface CheckoutDeps {
	billing: BillingStore;
	secretKey: string;
	successUrl: string;
	cancelUrl: string;
	portalReturnUrl: string;
	fetchFn?: typeof fetch;
	/** Stripe API origin (`STRIPE_API_BASE_URL`): only api.stripe.com or a loopback address, see `stripe-api.ts`. */
	baseUrl?: string;
	/** Pinned `Stripe-Version` (`STRIPE_API_VERSION`); default `DEFAULT_STRIPE_API_VERSION`. */
	apiVersion?: string;
}

export interface CheckoutRequest {
	kind: "subscription" | "topup";
	/** Required for `topup`: whole dollars from $5 to $200, in integer cents. */
	amountCents?: number;
	/** The caller's verified email, if the identity provider vouched for one (see `resolveCallerEmail`). */
	email?: string;
}

export type CheckoutRequestErrorCode = "invalid_topup_amount" | "invalid_checkout_kind" | "subscriptions_unavailable";

/** A request the person (or the SPA) can correct, or a capability that is off: never a Stripe failure. */
export class CheckoutRequestError extends Error {
	constructor(
		readonly code: CheckoutRequestErrorCode,
		message: string,
		readonly status: 400 | 503,
		/** Fields the route puts beside `error` and `message` (for example the bounds of a valid amount). */
		readonly details: Readonly<Record<string, unknown>> = {},
	) {
		super(message);
		this.name = "CheckoutRequestError";
	}
}

function assertTopupAmount(amountCents: unknown): number {
	if (
		typeof amountCents !== "number" ||
		!Number.isSafeInteger(amountCents) ||
		amountCents % 100 !== 0 ||
		amountCents < MIN_TOPUP_CENTS ||
		amountCents > MAX_TOPUP_CENTS
	) {
		throw new CheckoutRequestError(
			"invalid_topup_amount",
			`A top-up is a whole number of dollars, from $${MIN_TOPUP_CENTS / 100} to $${MAX_TOPUP_CENTS / 100}.`,
			400,
			{ minCents: MIN_TOPUP_CENTS, maxCents: MAX_TOPUP_CENTS },
		);
	}
	return amountCents;
}

/**
 * Stripe's key for a customer create: the same person with the same parameters is the same key, so a duplicate
 * (a retry, or a second process that missed our mapping) converges on one customer at Stripe instead of
 * orphaning a paying one. Another person or another email is another create.
 */
function customerIdempotencyKey(userId: string, params: StripeParams): string {
	const canonical = JSON.stringify(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	return `sophia-customer-${userId}-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

/** The customer creates in flight, per ledger and person: a second concurrent first checkout awaits the first. */
const customersInFlight = new WeakMap<BillingStore, Map<string, Promise<string>>>();

/** Get the user's Stripe customer, creating (and linking) one if absent. `email` is best effort and never fails a checkout. */
export function ensureStripeCustomer(deps: CheckoutDeps, userId: string, email?: string): Promise<string> {
	let byPerson = customersInFlight.get(deps.billing);
	if (!byPerson) {
		byPerson = new Map();
		customersInFlight.set(deps.billing, byPerson);
	}
	const running = byPerson.get(userId);
	if (running) return running;
	const people = byPerson;
	const attempt = resolveStripeCustomer(deps, userId, email).finally(() => people.delete(userId));
	people.set(userId, attempt);
	return attempt;
}

async function resolveStripeCustomer(deps: CheckoutDeps, userId: string, email?: string): Promise<string> {
	const existing = await deps.billing.getCustomer(userId);
	if (existing) {
		// A customer mapped before we knew an address gets it once, so its receipts can go out. A customer that
		// already has one is left alone, and a failed attach changes nothing.
		if (!existing.email && email) {
			try {
				const attached = await stripePost(`/v1/customers/${existing.stripeCustomerId}`, { email }, deps);
				if (attached.ok) await deps.billing.upsertCustomer(userId, existing.stripeCustomerId, email);
			} catch {
				// The checkout goes on without it.
			}
		}
		return existing.stripeCustomerId;
	}
	const params: StripeParams = { "metadata[user_id]": userId, ...(email ? { email } : {}) };
	const res = await stripePost("/v1/customers", params, {
		...deps,
		idempotencyKey: customerIdempotencyKey(userId, params),
	});
	const customerId = typeof res.json.id === "string" ? res.json.id : "";
	if (!res.ok || !customerId) {
		throw new Error(`stripe customer create failed: ${res.status} ${JSON.stringify(res.json)}`);
	}
	await deps.billing.upsertCustomer(userId, customerId, email ?? null);
	return customerId;
}

/** Create a Checkout Session for a credit top-up; returns the hosted checkout URL. */
export async function createCheckoutSession(
	deps: CheckoutDeps,
	userId: string,
	req: CheckoutRequest,
): Promise<{ url: string }> {
	if ((req.kind as string) === "subscription") {
		throw new CheckoutRequestError(
			"subscriptions_unavailable",
			"Subscriptions are not available yet; credits are bought as top-ups.",
			503,
		);
	}
	if (req.kind !== "topup") {
		throw new CheckoutRequestError("invalid_checkout_kind", "kind must be 'topup'", 400);
	}
	// Refused before Stripe is touched (and before a customer is created for a request that can never succeed).
	const amount = assertTopupAmount(req.amountCents);
	const customerId = await ensureStripeCustomer(deps, userId, req.email);
	const params: StripeParams = {
		mode: "payment",
		customer: customerId,
		"line_items[0][price_data][currency]": "usd",
		"line_items[0][price_data][product_data][name]": "Sophia credit top-up",
		"line_items[0][price_data][unit_amount]": amount,
		"line_items[0][quantity]": 1,
		client_reference_id: userId,
		// The marker the webhook credits on, on the session and on its PaymentIntent (which names the charge a
		// later refund or dispute claws back).
		"metadata[kind]": "topup",
		"metadata[user_id]": userId,
		"payment_intent_data[metadata][kind]": "topup",
		"payment_intent_data[metadata][user_id]": userId,
		success_url: deps.successUrl,
		cancel_url: deps.cancelUrl,
	};
	// No idempotency key chosen here: a second purchase is a second session, never a replay of the first.
	const res = await stripePost("/v1/checkout/sessions", params, deps);
	const url = typeof res.json.url === "string" ? res.json.url : "";
	if (!res.ok || !url) {
		throw new Error(`stripe checkout session failed: ${res.status} ${JSON.stringify(res.json)}`);
	}
	return { url };
}

/** Create a Customer Portal session; returns the portal URL. Requires an existing customer. */
export async function createPortalSession(deps: CheckoutDeps, userId: string): Promise<{ url: string }> {
	const existing = await deps.billing.getCustomer(userId);
	if (!existing) throw new Error("no_billing_customer");
	const res = await stripePost(
		"/v1/billing_portal/sessions",
		{ customer: existing.stripeCustomerId, return_url: deps.portalReturnUrl },
		deps,
	);
	const url = typeof res.json.url === "string" ? res.json.url : "";
	if (!res.ok || !url) {
		throw new Error(`stripe portal session failed: ${res.status} ${JSON.stringify(res.json)}`);
	}
	return { url };
}
