import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostedBuildEffectHost, startHostedBuildEffectWorkerFromEnv } from "../workflow/build-effect-hosted.js";
import type { BuildMaterializationRequestV1 } from "../workflow/build-effect-worker.js";
import { DevelopmentEffectError } from "../workflow/development-effect.js";

function host(fetchFn: typeof fetch): HostedBuildEffectHost {
	return new HostedBuildEffectHost({
		gatewayBaseUrl: "https://api.canary.example",
		serviceToken: "service-secret",
		fetchFn,
	});
}

function request(ownerPrincipal = "user:ada") {
	return {
		schema: "sophia.build-materialization.v1",
		operation: "build.plan",
		effectIndex: 0,
		proposalDigest: "a".repeat(64),
		effectiveProposalDigest: "d".repeat(64),
		executionDigest: "b".repeat(64),
		sourceTurnDigest: "c".repeat(64),
		sourceTurn: {},
		trigger: {},
		proposal: {},
		target: { ownerPrincipal },
		grant: {},
		estimatedCostMicrousd: 2_000_000,
		runId: "wfr-build",
	} as unknown as BuildMaterializationRequestV1;
}

describe("hosted native-build effect transport", () => {
	it("calls only the private materializer with service auth asserted as the immutable owner", async () => {
		let seen: { url: string; headers: Headers; body: unknown } | undefined;
		const transport = host(async (input, init) => {
			seen = {
				url: String(input),
				headers: new Headers(init?.headers),
				body: JSON.parse(String(init?.body)) as unknown,
			};
			return new Response(JSON.stringify({ created: true, receipt: {} }), {
				status: 201,
				headers: { "content-type": "application/json" },
			});
		});
		const body = request();
		const result = await transport.materialize(body);
		assert.deepEqual(result, { created: true, receipt: {} });
		assert.equal(seen?.url, "https://api.canary.example/internal/builds/materialize");
		assert.equal(seen?.headers.get("authorization"), "Bearer service-secret");
		assert.equal(seen?.headers.get("x-pn-on-behalf-of"), "ada");
		assert.deepEqual(seen?.body, body);
	});

	it("refuses a non-user owner before transport", async () => {
		let calls = 0;
		const transport = host(async () => {
			calls += 1;
			return new Response("{}");
		});
		await assert.rejects(
			transport.materialize(request("agent:shrub-1")),
			(error: unknown) => error instanceof DevelopmentEffectError && !error.retryable,
		);
		assert.equal(calls, 0);
	});

	it("classifies service saturation as retryable and authority rejection as terminal", async () => {
		for (const [status, retryable] of [
			[429, true],
			[503, true],
			[403, false],
		] as const) {
			const transport = host(async () => new Response("{}", { status }));
			await assert.rejects(
				transport.materialize(request()),
				(error: unknown) => error instanceof DevelopmentEffectError && error.retryable === retryable,
			);
		}
	});

	it("is dormant by default and requires no host credentials while disabled", () => {
		assert.equal(startHostedBuildEffectWorkerFromEnv({} as never, {}), undefined);
	});

	it("refuses a handoff lease shorter than the bounded host operations", () => {
		assert.throws(
			() =>
				startHostedBuildEffectWorkerFromEnv({} as never, {
					BUILD_EFFECT_WORKER_ENABLED: "1",
					BUILD_EFFECT_LEASE_MS: "1000",
					MNEMOSYNE_GATEWAY_BASE_URL: "https://api.canary.example",
					MNEMOSYNE_SERVICE_TOKEN: "service-secret",
				}),
			/lease.*grant reread/i,
		);
	});
});
