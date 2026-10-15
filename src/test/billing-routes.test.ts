/**
 * Billing routes — auth gating on GET /api/billing/* (WS-B, post-review hardening).
 * Exercises the routeRequest auth block WITHOUT Cognito: missing auth → 401, the
 * internal-service identity-assertion path is rejected (bearer-only) → 403, and a
 * malformed Authorization → 400. The happy bearer path needs a real Cognito JWKS
 * and belongs to the VM integration suite; these prove the security-relevant gates.
 *
 * RUN:  npx tsx --test src/test/billing-routes.test.ts
 */

import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { after, describe, it } from "node:test";
import { routeRequest } from "../orchestrator.js";

type Ctx = Parameters<typeof routeRequest>[2];
const ctx = {} as unknown as Ctx;

function mockReq(method: string, url: string, headers: Record<string, string>): IncomingMessage {
	return { method, url, headers } as unknown as IncomingMessage;
}

function mockRes() {
	const state = { statusCode: 200, body: undefined as unknown, headers: {} as Record<string, unknown> };
	const res = {
		get statusCode() {
			return state.statusCode;
		},
		set statusCode(v: number) {
			state.statusCode = v;
		},
		setHeader(k: string, v: unknown) {
			state.headers[k] = v;
		},
		end(s?: string) {
			state.body = s ? JSON.parse(s) : undefined;
		},
	};
	return { res: res as unknown as ServerResponse, state };
}

describe("billing routes: auth gating on /api/billing/*", () => {
	for (const [headers, status] of [
		[{}, 401],
		[{ authorization: "Basic Zm9v" }, 400],
		[{ "x-internal-service": "synthetic", "x-user-id": "other" }, 400],
	] as const) {
		it(`usage events rejects non-human authentication (${status})`, async () => {
			const { res, state } = mockRes();
			await routeRequest(mockReq("GET", "/api/billing/usage/events", headers), res, ctx);
			assert.equal(state.statusCode, status);
		});
	}
	it("missing auth → 401", async () => {
		const { res, state } = mockRes();
		await routeRequest(mockReq("GET", "/api/billing/balance", {}), res, ctx);
		assert.equal(state.statusCode, 401);
	});

	it("internal-service identity assertion is rejected (bearer-only) → 403", async () => {
		const prev = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "test-internal-secret";
		after(() => {
			if (prev === undefined) delete process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
			else process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = prev;
		});
		const { res, state } = mockRes();
		await routeRequest(
			mockReq("GET", "/api/billing/subscription", {
				"x-internal-service": "test-internal-secret",
				"x-user-id": "victim-user",
			}),
			res,
			ctx,
		);
		assert.equal(state.statusCode, 403);
		assert.equal((state.body as { error: string }).error, "billing reads are bearer-only");
	});

	it("a non-Bearer Authorization header → 400", async () => {
		const { res, state } = mockRes();
		await routeRequest(mockReq("GET", "/api/billing/usage", { authorization: "Basic Zm9v" }), res, ctx);
		assert.equal(state.statusCode, 400);
	});

	it("POST /api/billing/checkout is wired + auth-gated (missing auth → 401)", async () => {
		const { res, state } = mockRes();
		await routeRequest(mockReq("POST", "/api/billing/checkout", {}), res, ctx);
		assert.equal(state.statusCode, 401);
	});
});
