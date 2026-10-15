import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { localNativeSandboxEnvironment, resolveLocalNativeSourceProjectRoot } from "../spawner.js";

describe("host-edge secret boundary", () => {
	it("does not pass provider, capability, service, or effect credentials into local-native sandboxes", () => {
		const environment = localNativeSandboxEnvironment({
			PATH: "/usr/bin:/bin",
			OPENROUTER_API_KEY: "model-proxy-key",
			DEEPSEEK_API_KEY: "direct-model-proxy-key",
			OPENAI_API_KEY: "openai-model-proxy-key",
			GITHUB_EFFECT_TOKEN: "repository-authority",
			DISCORD_TOKEN: "discord-authority",
			PHANES_CAPABILITY_TOKEN: "discord-capability-authority",
			PHANES_TRANSCRIBE_TOKEN: "private-ingress-authority",
			MNEMOSYNE_INTERNAL_SERVICE_SECRET: "internal-service-authority",
			MNEMOSYNE_SERVICE_TOKEN: "gateway-service-authority",
			GARDEN_LOOPBACK_TOKEN: "garden-authority",
			STRIPE_SECRET_KEY: "billing-authority",
			AWS_PROFILE: "terraform-user",
			PROVIDER_CREDENTIALS_SSM_PREFIX: "/sophia/dev/choreograph/provider-credentials/v1",
			PROVIDER_CREDENTIALS_KMS_KEY_ID: "alias/choreograph-provider-credentials",
			SSH_AUTH_SOCK: "/tmp/agent.sock",
			CUSTOM_ACCESS_TOKEN: "future-authority",
		});
		for (const name of [
			"GITHUB_EFFECT_TOKEN",
			"OPENROUTER_API_KEY",
			"DEEPSEEK_API_KEY",
			"OPENAI_API_KEY",
			"DISCORD_TOKEN",
			"PHANES_CAPABILITY_TOKEN",
			"PHANES_TRANSCRIBE_TOKEN",
			"MNEMOSYNE_INTERNAL_SERVICE_SECRET",
			"MNEMOSYNE_SERVICE_TOKEN",
			"GARDEN_LOOPBACK_TOKEN",
			"STRIPE_SECRET_KEY",
			"AWS_PROFILE",
			"PROVIDER_CREDENTIALS_SSM_PREFIX",
			"PROVIDER_CREDENTIALS_KMS_KEY_ID",
			"SSH_AUTH_SOCK",
			"CUSTOM_ACCESS_TOKEN",
		]) {
			assert.equal(environment[name], undefined, `${name} crossed the host boundary`);
		}
		assert.equal(environment.PATH, "/usr/bin:/bin");
		assert.equal(environment.CHOREOGRAPH_SANDBOX, "local-native");
	});

	it("launches a TypeScript runtime from the nearest project tsconfig", () => {
		assert.equal(resolveLocalNativeSourceProjectRoot(resolve("src/spawner.ts")), process.cwd());
	});
});
