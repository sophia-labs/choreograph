import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { providerCredentialOwnerHash, providerCredentialParameterName } from "../provider-credentials.js";

describe("owner-scoped provider credential names", () => {
	it("derives a stable opaque owner path without exposing the subject", () => {
		const owner = "cognito:personal-user-123";
		const hash = providerCredentialOwnerHash(owner);
		assert.match(hash, /^[a-f0-9]{64}$/);
		assert.equal(hash, providerCredentialOwnerHash(owner));
		const name = providerCredentialParameterName(
			"/sophia/dev/choreograph/provider-credentials/v1",
			owner,
			"openrouter",
		);
		assert.equal(name, `/sophia/dev/choreograph/provider-credentials/v1/${hash}/openrouter`);
		assert.equal(name.includes(owner), false);
	});

	it("refuses prefixes, owners and providers that would escape their path", () => {
		assert.throws(() => providerCredentialParameterName("relative/prefix", "o", "openrouter"), /prefix is invalid/);
		assert.throws(() => providerCredentialParameterName("/a/../b", "o", "openrouter"), /prefix is invalid/);
		assert.throws(() => providerCredentialParameterName("/a", "o\0x", "openrouter"), /owner user id is invalid/);
		assert.throws(() => providerCredentialParameterName("/a", "o", "Open Router!"), /provider id is invalid/);
	});
});
