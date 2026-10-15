/**
 * Stripe REST client: form encoding, the base-URL rule, and what every request carries.
 *
 * The request tests run the real `stripePost` over the real `fetch` against a loopback Stripe
 * (`stripe-loopback-fixture.ts`), so header names and the wire encoding are exercised for real.
 *
 * RUN:  npx tsx --test src/test/stripe-api.test.ts
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { DEFAULT_STRIPE_API_VERSION, encodeStripeForm, resolveStripeBaseUrl, stripePost } from "../stripe-api.js";
import { startLoopbackStripe } from "./stripe-loopback-fixture.js";

describe("stripe-api: encodeStripeForm", () => {
	it("url-encodes keys + values, skips undefined, joins with &", () => {
		assert.equal(encodeStripeForm({ a: "1", b: 2, c: undefined }), "a=1&b=2");
		assert.equal(encodeStripeForm({ "line_items[0][price]": "price_pro" }), "line_items%5B0%5D%5Bprice%5D=price_pro");
		assert.equal(encodeStripeForm({ "metadata[user_id]": "u 1" }), "metadata%5Buser_id%5D=u%201");
		assert.equal(encodeStripeForm({}), "");
	});
});

describe("stripe-api: resolveStripeBaseUrl only ever points the secret key at Stripe or at this machine", () => {
	it("defaults to the real API", () => {
		assert.equal(resolveStripeBaseUrl(undefined), "https://api.stripe.com");
		assert.equal(resolveStripeBaseUrl(""), "https://api.stripe.com");
		assert.equal(resolveStripeBaseUrl("  "), "https://api.stripe.com");
		assert.equal(resolveStripeBaseUrl("https://api.stripe.com"), "https://api.stripe.com");
		assert.equal(resolveStripeBaseUrl("https://api.stripe.com/"), "https://api.stripe.com");
	});

	it("accepts a loopback address over plain http, with a port", () => {
		assert.equal(resolveStripeBaseUrl("http://127.0.0.1:4242"), "http://127.0.0.1:4242");
		assert.equal(resolveStripeBaseUrl("http://localhost:9000"), "http://localhost:9000");
		assert.equal(resolveStripeBaseUrl("http://[::1]:3000"), "http://[::1]:3000");
	});

	it("refuses every other host, scheme and disguise", () => {
		for (const bad of [
			"https://evil.example",
			"http://api.stripe.com",
			"https://api.stripe.com.evil.example",
			"https://api.stripe.com:8443",
			"https://user:pass@api.stripe.com",
			"https://127.0.0.1:4242",
			"http://192.168.1.10:4242",
			"http://169.254.169.254",
			"ftp://127.0.0.1",
			"not a url",
		]) {
			assert.throws(() => resolveStripeBaseUrl(bad), /STRIPE_API_BASE_URL/, bad);
		}
	});
});

describe("stripe-api: stripePost over a real loopback", () => {
	it("pins the API version, carries the key as a Bearer token and form-encodes the body", async () => {
		const stripe = await startLoopbackStripe({ "/v1/customers": { json: { id: "cus_1" } } });
		after(() => stripe.close());
		const res = await stripePost(
			"/v1/customers",
			{ "metadata[user_id]": "u 1", email: "ana@example.org" },
			{ secretKey: "sk_test_loop", baseUrl: stripe.baseUrl },
		);
		assert.deepEqual([res.ok, res.status, res.json.id], [true, 200, "cus_1"]);
		const [request] = stripe.to("/v1/customers");
		assert.equal(request.method, "POST");
		assert.equal(request.headers.authorization, "Bearer sk_test_loop");
		assert.equal(request.headers["content-type"], "application/x-www-form-urlencoded");
		assert.equal(request.headers["stripe-version"], DEFAULT_STRIPE_API_VERSION);
		assert.deepEqual(request.form, { "metadata[user_id]": "u 1", email: "ana@example.org" });
	});

	it("the pinned version has the shape of a Stripe version and is overridable", async () => {
		assert.match(DEFAULT_STRIPE_API_VERSION, /^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/);
		const stripe = await startLoopbackStripe({ "/v1/x": { json: {} } });
		after(() => stripe.close());
		await stripePost("/v1/x", {}, { secretKey: "sk", baseUrl: stripe.baseUrl, apiVersion: "2099-01-01.test" });
		assert.equal(stripe.to("/v1/x")[0].headers["stripe-version"], "2099-01-01.test");
	});

	it("sends the caller's Idempotency-Key verbatim, and a fresh one per request when it gives none", async () => {
		const stripe = await startLoopbackStripe({ "/v1/x": { json: {} } });
		after(() => stripe.close());
		const opts = { secretKey: "sk", baseUrl: stripe.baseUrl };
		await stripePost("/v1/x", {}, { ...opts, idempotencyKey: "sophia-customer-u1-abc" });
		await stripePost("/v1/x", {}, opts);
		await stripePost("/v1/x", {}, opts);
		const keys = stripe.to("/v1/x").map((request) => request.headers["idempotency-key"]);
		assert.equal(keys[0], "sophia-customer-u1-abc");
		assert.match(String(keys[1]), /^[0-9a-f-]{36}$/);
		assert.match(String(keys[2]), /^[0-9a-f-]{36}$/);
		assert.notEqual(keys[1], keys[2], "two logical requests are never one");
	});

	it("reports a Stripe error as ok=false with the status and the JSON body", async () => {
		const stripe = await startLoopbackStripe({
			"/v1/x": { status: 402, json: { error: { message: "Your card was declined." } } },
		});
		after(() => stripe.close());
		const res = await stripePost("/v1/x", {}, { secretKey: "sk", baseUrl: stripe.baseUrl });
		assert.equal(res.ok, false);
		assert.equal(res.status, 402);
		assert.deepEqual(res.json, { error: { message: "Your card was declined." } });
	});

	it("refuses a base URL that is not Stripe or loopback before sending anything", async () => {
		await assert.rejects(
			stripePost("/v1/x", {}, { secretKey: "sk_test_never_sent", baseUrl: "https://evil.example" }),
			/STRIPE_API_BASE_URL/,
		);
	});
});
