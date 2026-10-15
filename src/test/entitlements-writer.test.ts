/**
 * Entitlements writer (Billing I&E P1c, choreograph side) — REAL loopback HTTP,
 * NO MOCKS. A real node:http server stands in for the gateway and captures the
 * PUT, so the URL / service-token bearer / body are proven against an actual
 * socket (the gateway's DynamoDB round-trip is validated separately at
 * localstack/canary). The injected `fetchImpl` is just Node's real `fetch`.
 *
 * RUN:  from the repository root
 *       npx tsx --test src/test/entitlements-writer.test.ts
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { after, describe, it } from "node:test";
import { pushTierToGateway } from "../entitlements-writer.js";

interface Captured {
	method?: string;
	url?: string;
	auth?: string;
	contentType?: string;
	body: string;
}

/** A real loopback HTTP server that captures one request and replies `status`. */
async function captureServer(status: number): Promise<{ baseUrl: string; captured: Captured; close: () => void }> {
	const captured: Captured = { body: "" };
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		captured.method = req.method;
		captured.url = req.url;
		captured.auth = req.headers.authorization;
		captured.contentType = req.headers["content-type"];
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			captured.body = Buffer.concat(chunks).toString("utf8");
			res.statusCode = status;
			res.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	return { baseUrl: `http://127.0.0.1:${port}`, captured, close: () => server.close() };
}

describe("entitlements-writer: pushTierToGateway (real loopback HTTP)", () => {
	it("PUTs /internal/entitlements/{sub} with the service-token bearer + {tier}", async () => {
		const srv = await captureServer(204);
		after(() => srv.close());
		const res = await pushTierToGateway("sub_abc", "pro", { baseUrl: srv.baseUrl, serviceToken: "svc_secret" });
		assert.deepEqual(res, { ok: true, status: 204 });
		assert.equal(srv.captured.method, "PUT");
		assert.equal(srv.captured.url, "/internal/entitlements/sub_abc");
		assert.equal(srv.captured.auth, "Bearer svc_secret");
		assert.equal(srv.captured.contentType, "application/json");
		assert.deepEqual(JSON.parse(srv.captured.body), { tier: "pro" });
	});

	it("url-encodes the subject, trims a trailing slash, and surfaces non-2xx as ok:false", async () => {
		const srv = await captureServer(401);
		after(() => srv.close());
		const res = await pushTierToGateway("sub/x y", "free", { baseUrl: `${srv.baseUrl}/`, serviceToken: "x" });
		assert.deepEqual(res, { ok: false, status: 401 });
		assert.equal(srv.captured.url, `/internal/entitlements/${encodeURIComponent("sub/x y")}`);
	});
});
