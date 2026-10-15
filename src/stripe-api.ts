/**
 * Dep-free Stripe REST client (no SDK) — mirrors stripe-webhook.ts's no-dependency
 * posture. Form-encodes params (`application/x-www-form-urlencoded`, Stripe's wire
 * format, with bracket-notation keys passed pre-flattened by callers) and POSTs to
 * api.stripe.com with the secret key as a Bearer token.
 *
 * Every request is version-pinned (`Stripe-Version`) so a change of the account's default API version can
 * never change the shapes we read, and carries an `Idempotency-Key` so a duplicate of one logical request is
 * one request at Stripe. Stripe is the one external boundary the tests stand in for, and they do it with a
 * loopback HTTP server: `baseUrl` (from `STRIPE_API_BASE_URL`) exists for that and for nothing else, and is
 * limited to api.stripe.com or a loopback address so the secret key can never be pointed at another host.
 */

import { randomUUID } from "node:crypto";

export type StripeParams = Record<string, string | number | undefined>;

/**
 * The Stripe API version every request is pinned to. Any past version stays valid; pinning one keeps the
 * response shapes we read stable when the account's default version moves. Override with `STRIPE_API_VERSION`.
 */
export const DEFAULT_STRIPE_API_VERSION = "2025-03-31.basil";

const STRIPE_API_ORIGIN = "https://api.stripe.com";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The origin Stripe requests go to: the real API by default, or (tests) a loopback address over plain http.
 * Anything else throws, so a misconfigured environment cannot redirect the secret key to another host.
 */
export function resolveStripeBaseUrl(raw?: string): string {
	const value = raw?.trim();
	if (!value) return STRIPE_API_ORIGIN;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("STRIPE_API_BASE_URL is not a URL");
	}
	const plain = url.username === "" && url.password === "";
	const real = url.protocol === "https:" && url.hostname === "api.stripe.com" && url.port === "";
	const loopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
	if (!plain || !(real || loopback)) {
		throw new Error("STRIPE_API_BASE_URL must be https://api.stripe.com or a loopback address");
	}
	return url.origin;
}

/** Encode params as `application/x-www-form-urlencoded`; `undefined` values are skipped. */
export function encodeStripeForm(params: StripeParams): string {
	const parts: string[] = [];
	for (const [k, v] of Object.entries(params)) {
		if (v === undefined) continue;
		parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
	}
	return parts.join("&");
}

export interface StripeApiResult {
	ok: boolean;
	status: number;
	json: Record<string, unknown>;
}

export interface StripeRequestOptions {
	secretKey: string;
	fetchFn?: typeof fetch;
	/** Stripe API origin; only api.stripe.com or loopback (see `resolveStripeBaseUrl`). */
	baseUrl?: string;
	/** Pinned `Stripe-Version`; default `DEFAULT_STRIPE_API_VERSION`. */
	apiVersion?: string;
	/**
	 * Stripe `Idempotency-Key`: the same key with the same params returns the first response instead of doing
	 * it twice. Omitted, a fresh random key is sent, so no request is ever unkeyed.
	 */
	idempotencyKey?: string;
}

/** POST form-encoded params to a Stripe REST path; returns the parsed JSON + status. */
export async function stripePost(
	path: string,
	params: StripeParams,
	opts: StripeRequestOptions,
): Promise<StripeApiResult> {
	const fetchFn = opts.fetchFn ?? fetch;
	const res = await fetchFn(`${resolveStripeBaseUrl(opts.baseUrl)}${path}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${opts.secretKey}`,
			"content-type": "application/x-www-form-urlencoded",
			"stripe-version": opts.apiVersion?.trim() || DEFAULT_STRIPE_API_VERSION,
			"idempotency-key": opts.idempotencyKey ?? randomUUID(),
		},
		body: encodeStripeForm(params),
	});
	const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	return { ok: res.ok, status: res.status, json };
}
