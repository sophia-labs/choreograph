/**
 * The caller's email, for Stripe's receipt and for nothing else (Sobremesa money-in fix d).
 *
 * Identity is the token's `sub`; the email only lets Stripe address a receipt, so it is trusted only when the
 * Cognito pool verified it, and it is best-effort: a token, a header or a pool that cannot produce one yields
 * `undefined`, never an error that could fail a checkout.
 *
 * RUN:  npx tsx --test src/test/auth-email.test.ts
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolveCallerEmail, verifiedEmailClaim } from "../auth.js";

describe("verifiedEmailClaim: only an email the pool verified", () => {
	it("returns a well-formed email whose verification is true (boolean or the string Cognito sometimes sends)", () => {
		assert.equal(verifiedEmailClaim({ email: "ana@example.org", email_verified: true }), "ana@example.org");
		assert.equal(verifiedEmailClaim({ email: "ana@example.org", email_verified: "true" }), "ana@example.org");
		assert.equal(verifiedEmailClaim({ email: "  ana@example.org  ", email_verified: true }), "ana@example.org");
	});

	it("returns nothing for an email that was not verified, or whose verification is unknown", () => {
		assert.equal(verifiedEmailClaim({ email: "ana@example.org", email_verified: false }), undefined);
		assert.equal(verifiedEmailClaim({ email: "ana@example.org", email_verified: "false" }), undefined);
		assert.equal(verifiedEmailClaim({ email: "ana@example.org" }), undefined);
		assert.equal(verifiedEmailClaim({ email: "ana@example.org", email_verified: 1 }), undefined);
	});

	it("returns nothing for a claim that is not an address", () => {
		for (const email of [
			undefined,
			null,
			42,
			"",
			"   ",
			"no-at-sign",
			"two@@example.org",
			"a b@example.org",
			`${"a".repeat(250)}@x.io`,
		]) {
			assert.equal(verifiedEmailClaim({ email, email_verified: true }), undefined, String(email));
		}
	});
});

describe("resolveCallerEmail: best effort, never throws", () => {
	let pool: string | undefined;
	beforeEach(() => {
		pool = process.env.COGNITO_USER_POOL_ID;
		delete process.env.COGNITO_USER_POOL_ID;
	});
	afterEach(() => {
		if (pool === undefined) delete process.env.COGNITO_USER_POOL_ID;
		else process.env.COGNITO_USER_POOL_ID = pool;
	});

	it("has no email without a Cognito pool: the /profile/me fallback proves an identity, not an address", async () => {
		assert.equal(await resolveCallerEmail({ authorization: "Bearer tok-ana" }), undefined);
	});

	it("has no email for a request with no credentials, an internal-service caller, or a malformed header", async () => {
		assert.equal(await resolveCallerEmail({}), undefined);
		assert.equal(await resolveCallerEmail({ "x-internal-service": "wrong", "x-user-id": "ana" }), undefined);
		assert.equal(await resolveCallerEmail({ authorization: "Basic abc" }), undefined);
	});
});
