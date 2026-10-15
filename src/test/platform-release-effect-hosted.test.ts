import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type PlatformRealizationRequestV1, PlatformReleaseEffectError } from "../workflow/platform-release-effect.js";
import {
	HostedPlatformReleaseEffectHost,
	startHostedPlatformReleaseEffectWorkerFromEnv,
} from "../workflow/platform-release-effect-hosted.js";

function host(fetchFn: typeof fetch): HostedPlatformReleaseEffectHost {
	return new HostedPlatformReleaseEffectHost({
		gatewayBaseUrl: "https://api.canary.example",
		serviceToken: "service-secret",
		fetchFn,
	});
}

function request(ownerPrincipal = "user:ada") {
	return {
		schema: "sophia.platform-realization.v1",
		effectIndex: 0,
		proposalDigest: "a".repeat(64),
		effectiveProposalDigest: "b".repeat(64),
		executionDigest: "c".repeat(64),
		sourceTurnDigest: "d".repeat(64),
		sourceTurn: {},
		trigger: {},
		proposal: {},
		target: { ownerPrincipal },
		grant: {},
		runId: "wfr-platform-release",
	} as unknown as PlatformRealizationRequestV1;
}

describe("hosted platform release effect transport", () => {
	it("calls only the private realization route with service auth asserted as the immutable owner", async () => {
		let seen: { url: string; headers: Headers; body: unknown } | undefined;
		const transport = host(async (input, init) => {
			seen = {
				url: String(input),
				headers: new Headers(init?.headers),
				body: JSON.parse(String(init?.body)) as unknown,
			};
			return new Response(JSON.stringify({ created: true, receipt: {} }), { status: 201 });
		});
		const body = request();
		assert.deepEqual(await transport.materialize(body), { created: true, receipt: {} });
		assert.equal(seen?.url, "https://api.canary.example/internal/realizations/materialize");
		assert.equal(seen?.headers.get("authorization"), "Bearer service-secret");
		assert.equal(seen?.headers.get("x-pn-on-behalf-of"), "ada");
		assert.deepEqual(seen?.body, body);
	});

	it("refuses non-user owners and classifies authority failures as terminal", async () => {
		let calls = 0;
		const transport = host(async () => {
			calls += 1;
			return new Response("{}", { status: 403 });
		});
		await assert.rejects(
			transport.materialize(request("agent:cloud-release")),
			(error: unknown) => error instanceof PlatformReleaseEffectError && !error.retryable,
		);
		assert.equal(calls, 0);
		await assert.rejects(
			transport.materialize(request()),
			(error: unknown) => error instanceof PlatformReleaseEffectError && !error.retryable,
		);
	});

	it("is dormant by default and refuses a lease shorter than its bounded calls", () => {
		assert.equal(startHostedPlatformReleaseEffectWorkerFromEnv({} as never, {}), undefined);
		assert.throws(
			() =>
				startHostedPlatformReleaseEffectWorkerFromEnv({} as never, {
					PLATFORM_RELEASE_EFFECT_WORKER_ENABLED: "1",
					PLATFORM_RELEASE_EFFECT_LEASE_MS: "1000",
					MNEMOSYNE_GATEWAY_BASE_URL: "https://api.canary.example",
					MNEMOSYNE_SERVICE_TOKEN: "service-secret",
				}),
			/lease.*grant reread/i,
		);
	});
});
