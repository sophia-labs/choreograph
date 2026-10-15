import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { routeRequest } from "../orchestrator.js";

class MockResponse {
	statusCode = 200;
	body = "";
	setHeader() {}
	end(chunk?: string) {
		if (chunk) this.body += chunk;
	}
	setTimeout() {}
}

function request(content: string) {
	return Object.assign(Readable.from([JSON.stringify({ content })]), {
		method: "POST",
		url: "/api/sessions/session-proof/message",
		headers: {
			"x-internal-service": "proof-secret",
			"x-user-id": "user-alpha-0001",
		},
	});
}

describe("legacy chat execution tombstone", () => {
	it("returns 410 without persisting, enqueueing, billing, or testifying", async (test) => {
		const priorSecret = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "proof-secret";
		test.after(() => {
			if (priorSecret === undefined) delete process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
			else process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = priorSecret;
		});

		let sideEffects = 0;
		const ctx = {
			sessions: {
				async getSession() {
					return {
						session_id: "session-proof",
						user_id: "user-alpha-0001",
						model: "mock:done",
						graph_id: "organism-dev",
					};
				},
				async appendMessages() {
					sideEffects++;
				},
				async appendUserMessage() {
					sideEffects++;
				},
			},
			billing: {
				async getCredit() {
					sideEffects++;
				},
			},
			spawner: {
				enqueue() {
					sideEffects++;
					return { sandbox_id: "sandbox-proof" };
				},
			},
			capture: {
				emit() {
					sideEffects++;
				},
			},
		} as never;
		const response = new MockResponse();

		await routeRequest(request("must never reach an executor") as never, response as never, ctx);

		assert.equal(response.statusCode, 410);
		assert.deepEqual(JSON.parse(response.body), {
			error: "Legacy chat execution was removed; invoke a graph-defined Agent workflow",
			session_id: "session-proof",
		});
		assert.equal(sideEffects, 0);
	});
});
