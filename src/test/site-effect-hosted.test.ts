import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostedSiteEffectHost, reviewedBundleFromEnv } from "../workflow/site-effect-hosted.js";
import { SiteEffectError, type SiteMaterializationRequestV1 } from "../workflow/site-effect-worker.js";

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function host(fetchFn: typeof fetch): HostedSiteEffectHost {
	return new HostedSiteEffectHost({
		gatewayBaseUrl: "https://api.canary.example",
		serviceToken: "service-secret",
		routeRegistryOwnerPrincipal: "user:platform-steward",
		routeRegistryGraphId: "platform-domain",
		fetchFn,
	});
}

describe("hosted site effect transport", () => {
	it("creates a graph under the exact committed owner and stamps replay custody", async () => {
		const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
		const transport = host(async (input, init) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			calls.push({ url: String(input), headers: new Headers(init?.headers), body });
			const params = body.params as { name: string; arguments: Record<string, unknown> };
			return json({
				jsonrpc: "2.0",
				id: body.id,
				result: {
					structuredContent:
						params.name === "list_graphs"
							? []
							: {
									owner: "user:ada",
									graphId: "shrubbery-preview",
									description: params.arguments.description,
								},
				},
			});
		});
		const description = `Sophia site graph; materialized by effect:${"a".repeat(64)}`;
		await transport.ensureGraph({
			ownerPrincipal: "user:ada",
			graphId: "shrubbery-preview",
			title: "Preview",
			description,
			idempotencyKey: `effect:${"a".repeat(64)}`,
		});
		assert.equal(calls.length, 2);
		assert.ok(calls.every((call) => call.url === "https://api.canary.example/control/mcp"));
		assert.ok(calls.every((call) => call.headers.get("authorization") === "Bearer service-secret"));
		assert.ok(calls.every((call) => call.headers.get("x-pn-on-behalf-of") === "ada"));
		const create = calls[1]?.body.params as { name: string; arguments: Record<string, unknown> };
		assert.equal(create.name, "create_graph");
		assert.deepEqual(create.arguments, {
			owner: "user:ada",
			graphId: "shrubbery-preview",
			title: "Preview",
			description,
		});
	});

	it("accepts only an existing graph stamped by the same effect", async () => {
		const exactDescription = `Sophia site graph; materialized by effect:${"b".repeat(64)}`;
		for (const [description, accepted] of [
			[exactDescription, true],
			["someone else's graph", false],
		] as const) {
			const transport = host(async () =>
				json({
					jsonrpc: "2.0",
					id: "x",
					result: {
						structuredContent: [
							{ owner: "user:ada", graphId: "shrubbery-preview", description, lifecycleState: "active" },
						],
					},
				}),
			);
			const execute = transport.ensureGraph({
				ownerPrincipal: "user:ada",
				graphId: "shrubbery-preview",
				title: "Preview",
				description: exactDescription,
				idempotencyKey: `effect:${"b".repeat(64)}`,
			});
			if (accepted) await execute;
			else {
				await assert.rejects(
					execute,
					(error: unknown) => error instanceof SiteEffectError && error.code === "site-graph-already-exists",
				);
			}
		}
	});

	it("calls the private materializer with service auth asserted as the immutable owner", async () => {
		let seen: { url: string; headers: Headers; body: unknown } | undefined;
		const transport = host(async (input, init) => {
			seen = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
			return json({ created: true, receipt: { receiptId: "site-receipt-1" } }, 201);
		});
		const request = {
			schema: "sophia.site-materialization.v1",
			operation: "publish",
			effectIndex: 0,
			proposalDigest: "a".repeat(64),
			executionDigest: "b".repeat(64),
			sourceTurnDigest: "c".repeat(64),
			sourceTurn: {},
			trigger: {},
			proposal: {},
			route: {},
			interpreter: {},
			grant: {},
		} as unknown as SiteMaterializationRequestV1;
		const result = await transport.materialize("user:ada", request);
		assert.deepEqual(result, { created: true, receipt: { receiptId: "site-receipt-1" } });
		assert.equal(seen?.url, "https://api.canary.example/internal/site-publications/materialize");
		assert.equal(seen?.headers.get("authorization"), "Bearer service-secret");
		assert.equal(seen?.headers.get("x-pn-on-behalf-of"), "ada");
		assert.deepEqual(seen?.body, request);
	});

	it("requires bundle pin overrides as one atomic reviewed tuple", () => {
		assert.equal(reviewedBundleFromEnv({}).bundleId, "garden");
		assert.throws(
			() => reviewedBundleFromEnv({ SITE_BUNDLE_ID: "other" }),
			/reviewed site bundle override is incomplete/,
		);
	});
});
