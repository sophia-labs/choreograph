import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authMethodLabel, extractBearerToken, resolveHostedAuthContext, resolveHostedCallerUserId } from "../auth.js";

describe("auth helpers", () => {
	it("extracts delegated bearer auth from Authorization header", () => {
		const auth = resolveHostedAuthContext({
			authorization: "Bearer jwt-token",
		});

		assert.deepEqual(auth, {
			method: "delegated_bearer",
			bearerToken: "jwt-token",
		});
		assert.equal(authMethodLabel(auth), "delegated_bearer");
	});

	it("extracts internal-service auth from headers", () => {
		const auth = resolveHostedAuthContext(
			{
				"x-internal-service": "shared-secret",
				"x-user-id": "ada",
			},
			{
				expectedInternalServiceSecret: "shared-secret",
			},
		);

		assert.deepEqual(auth, {
			method: "internal_service",
			internalServiceSecret: "shared-secret",
			userId: "ada",
		});
	});

	it("returns undefined when no auth headers are present", () => {
		assert.equal(resolveHostedAuthContext({}), undefined);
		assert.equal(authMethodLabel(undefined), "none");
	});

	it("rejects non-bearer authorization headers", () => {
		assert.throws(
			() => resolveHostedAuthContext({ authorization: "Basic abc123" }),
			/Authorization header must use the Bearer scheme/,
		);
	});

	it("rejects internal-service auth without user id", () => {
		assert.throws(
			() =>
				resolveHostedAuthContext(
					{ "x-internal-service": "shared-secret" },
					{ expectedInternalServiceSecret: "shared-secret" },
				),
			/X-User-ID is required/,
		);
	});

	it("rejects internal-service auth with the wrong shared secret", () => {
		assert.throws(
			() =>
				resolveHostedAuthContext(
					{
						"x-internal-service": "wrong-secret",
						"x-user-id": "ada",
					},
					{ expectedInternalServiceSecret: "shared-secret" },
				),
			/X-Internal-Service is invalid/,
		);
	});

	it("extractBearerToken trims the bearer token", () => {
		assert.equal(extractBearerToken("Bearer   token-123   "), "token-123");
		assert.equal(extractBearerToken("Basic token-123"), undefined);
	});

	it("resolves delegated bearer callers through /profile/me", async () => {
		const userId = await resolveHostedCallerUserId({
			apiBaseUrl: "https://api.tabula.example.invalid",
			authContext: {
				method: "delegated_bearer",
				bearerToken: "jwt-token",
			},
			fetchFn: async (input, init) => {
				assert.equal(String(input), "https://api.tabula.example.invalid/profile/me");
				const headers = new Headers(init?.headers);
				assert.equal(headers.get("authorization"), "Bearer jwt-token");
				return new Response(JSON.stringify({ user_id: "ada" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		});

		assert.equal(userId, "ada");
	});
});
