import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DevelopmentEffectError } from "../workflow/development-effect.js";
import { HostedScratchEffectHost, startHostedScratchEffectWorkerFromEnv } from "../workflow/scratch-effect-hosted.js";
import type { ScratchMaterializationRequestV1 } from "../workflow/scratch-effect-worker.js";

function host(fetchFn: typeof fetch): HostedScratchEffectHost {
	return new HostedScratchEffectHost({
		gatewayBaseUrl: "https://api.canary.example",
		serviceToken: "service-secret",
		fetchFn,
	});
}

function request(ownerPrincipal = "user:ada", graphId = "dev-shrub1-fix-hoja") {
	return {
		schema: "sophia.scratch-cell-materialization.v1",
		operation: "cell.launch",
		effectIndex: 0,
		proposalDigest: "a".repeat(64),
		executionDigest: "b".repeat(64),
		sourceTurnDigest: "c".repeat(64),
		sourceTurn: {},
		trigger: {},
		proposal: {},
		target: { ownerPrincipal, scratchGraphId: graphId },
		grant: {},
		runId: "wfr-scratch",
	} as unknown as ScratchMaterializationRequestV1;
}

describe("hosted scratch effect transport", () => {
	it("calls only the private materializer with service auth asserted as the immutable owner", async () => {
		let seen: { url: string; headers: Headers; body: unknown } | undefined;
		const transport = host(async (input, init) => {
			seen = {
				url: String(input),
				headers: new Headers(init?.headers),
				body: JSON.parse(String(init?.body)) as unknown,
			};
			return new Response(JSON.stringify({ created: true, deleted: false, receipt: {} }), {
				status: 201,
				headers: { "content-type": "application/json" },
			});
		});
		const body = request();
		const result = await transport.materialize(body);
		assert.deepEqual(result, { created: true, deleted: false, receipt: {} });
		assert.equal(seen?.url, "https://api.canary.example/internal/scratch-cells/materialize");
		assert.equal(seen?.headers.get("authorization"), "Bearer service-secret");
		assert.equal(seen?.headers.get("x-pn-on-behalf-of"), "ada");
		assert.deepEqual(seen?.body, body);
	});

	it("refuses non-user owners and graph ids outside the reserved private namespace before transport", async () => {
		let calls = 0;
		const transport = host(async () => {
			calls += 1;
			return new Response("{}");
		});
		for (const body of [request("agent:shrub-1"), request("user:ada", "shrubbery-domain")]) {
			await assert.rejects(
				transport.materialize(body),
				(error: unknown) => error instanceof DevelopmentEffectError && !error.retryable,
			);
		}
		assert.equal(calls, 0);
	});

	it("classifies gateway saturation as retryable and an authority rejection as terminal", async () => {
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

	it("is dormant by default and does not require host credentials while disabled", () => {
		assert.equal(startHostedScratchEffectWorkerFromEnv({} as never, {}), undefined);
	});
});
