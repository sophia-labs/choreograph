import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { routeRequest } from "../orchestrator.js";

class MockResponse {
	statusCode = 200;
	headers = new Map<string, string>();
	body = "";

	setHeader(name: string, value: string) {
		this.headers.set(name.toLowerCase(), value);
	}

	end(chunk?: string) {
		if (chunk) {
			this.body += chunk;
		}
	}

	setTimeout(_timeoutMs: number) {}
}

function makeRequest(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
	return Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
		method,
		url,
		headers,
	});
}

function jsonBody(response: MockResponse) {
	return JSON.parse(response.body || "{}");
}

describe("runtime routes", () => {
	const sandbox = {
		sandbox_id: "sandbox-runtime-1",
		owner_user_id: "ada",
		state: "running",
		template: "workspace",
	};
	const authHeaders = {
		"x-internal-service": "shared-secret",
		"x-user-id": "ada",
	};

	it("POST /api/sandboxes/:id/input forwards code to the runtime sandbox", async (t) => {
		const previousSecret = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "shared-secret";
		t.after(() => {
			if (previousSecret === undefined) {
				delete process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
				return;
			}
			process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = previousSecret;
		});

		const calls: Array<{ sandboxId: string; code: string }> = [];
		const ctx = {
			store: {
				get(sandboxId: string) {
					return sandboxId === sandbox.sandbox_id ? sandbox : undefined;
				},
			},
			sessions: {},
			spawner: {
				sendRuntimeInput(sandboxId: string, code: string) {
					calls.push({ sandboxId, code });
					return {
						sandbox,
						inputId: "input-0",
					};
				},
			},
		} as any;

		const request = makeRequest(
			"POST",
			`/api/sandboxes/${sandbox.sandbox_id}/input`,
			{ code: "value + 1" },
			authHeaders,
		);
		const response = new MockResponse();

		await routeRequest(request as any, response as any, ctx);

		assert.equal(response.statusCode, 202);
		assert.deepEqual(calls, [{ sandboxId: sandbox.sandbox_id, code: "value + 1" }]);
		assert.equal(jsonBody(response).inputId, "input-0");
	});

	it("POST /api/sandboxes/:id/close delegates runtime shutdown to the spawner", async (t) => {
		const previousSecret = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "shared-secret";
		t.after(() => {
			if (previousSecret === undefined) {
				delete process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
				return;
			}
			process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = previousSecret;
		});

		const calls: string[] = [];
		const ctx = {
			store: {
				get(sandboxId: string) {
					return sandboxId === sandbox.sandbox_id ? sandbox : undefined;
				},
			},
			sessions: {},
			spawner: {
				closeRuntime(sandboxId: string) {
					calls.push(sandboxId);
					return sandbox;
				},
			},
		} as any;

		const request = makeRequest("POST", `/api/sandboxes/${sandbox.sandbox_id}/close`, undefined, authHeaders);
		const response = new MockResponse();

		await routeRequest(request as any, response as any, ctx);

		assert.equal(response.statusCode, 202);
		assert.deepEqual(calls, [sandbox.sandbox_id]);
		assert.equal(jsonBody(response).sandbox.sandbox_id, sandbox.sandbox_id);
	});
});
