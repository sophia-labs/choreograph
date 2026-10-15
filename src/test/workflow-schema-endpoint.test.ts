import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import { routeRequest } from "../orchestrator.js";

// Drive the REAL HTTP handler (routeRequest) for the api:WorkflowBinding face —
// GET /api/workflows/:name/schema. Same harness shape as runtime-routes.test.ts:
// a Readable-backed request + a tiny ServerResponse stand-in, no mocks of the
// handler or the registry. The registry is populated at orchestrator module load
// (importing ../orchestrator.js registers the ontological Domain Agent loop), so the route
// resolves a real registered workflow.

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

function makeRequest(method: string, url: string, headers: Record<string, string> = {}) {
	return Object.assign(Readable.from([]), { method, url, headers });
}

function jsonBody(response: MockResponse) {
	return JSON.parse(response.body || "{}");
}

// A JSON Schema is valid enough for our purposes if it is an object that declares
// `type: "object"` (the api:WorkflowBinding contract guarantees at least that).
function assertObjectSchema(schema: unknown, label: string) {
	assert.ok(schema && typeof schema === "object" && !Array.isArray(schema), `${label} must be a JSON object`);
	assert.equal((schema as Record<string, unknown>).type, "object", `${label} must declare type: "object"`);
}

describe("GET /api/workflows/:name/schema — api:WorkflowBinding face", () => {
	// F1 fix: the schema route is definitional (non-owner) data, but it is not
	// gateway-proxied and is therefore reachable directly against the EC2 origin,
	// so it now sits behind requireAuthenticatedOwner (same bearer-gate posture
	// as GET /api/workflows and GET /api/sandboxes). Authenticate via the
	// internal-service header pair, same pattern as runtime-routes.test.ts.
	// The handler never touches store/sessions/spawner/journal for this route,
	// so an empty ctx still suffices.
	const ctx = {} as never;
	const authHeaders = {
		"x-internal-service": "shared-secret",
		"x-user-id": "ada",
	};

	let previousSecret: string | undefined;
	beforeEach(() => {
		previousSecret = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "shared-secret";
	});
	afterEach(() => {
		if (previousSecret === undefined) {
			delete process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
			return;
		}
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = previousSecret;
	});

	it("returns 401 with www-authenticate when no auth is presented", async () => {
		const request = makeRequest("GET", "/api/workflows/domain-agent-activity-loop-v1/schema");
		const response = new MockResponse();

		await routeRequest(request as never, response as never, ctx);

		assert.equal(response.statusCode, 401);
		assert.equal(response.headers.get("www-authenticate"), 'Bearer realm="choreograph"');
	});

	it("returns 200 with the graph-defined Domain Agent input/output schemas", async () => {
		const request = makeRequest("GET", "/api/workflows/domain-agent-activity-loop-v1/schema", authHeaders);
		const response = new MockResponse();

		await routeRequest(request as never, response as never, ctx);

		assert.equal(response.statusCode, 200);
		const body = jsonBody(response);
		assert.equal(body.name, "domain-agent-activity-loop-v1");
		assert.equal(body.workflowUri, "urn:sophia:wf:domain-agent-activity-loop-v1");
		assert.match(body.definitionDigest, /^[0-9a-f]{64}$/);
		assert.equal(body.executor, "gated");

		// Both faces are real, valid JSON Schemas (not the permissive default).
		assertObjectSchema(body.inputSchema, "inputSchema");
		assertObjectSchema(body.outputSchema, "outputSchema");

		assert.deepEqual(body.inputSchema.required, ["definitionDocumentId", "trigger", "contextRefs"]);
		assert.ok(body.inputSchema.properties?.definitionDocumentId);
		assert.ok(body.inputSchema.properties?.trigger);
		assert.ok(body.outputSchema.properties?.response);
		assert.ok(body.outputSchema.properties?.proposedEffects);
	});

	it("does not register the two ontology-free agent workflow paths", async () => {
		for (const name of ["graph-survey-synthesize", "hoja-swarm-generate-v1"]) {
			const response = new MockResponse();
			await routeRequest(
				makeRequest("GET", `/api/workflows/${name}/schema`, authHeaders) as never,
				response as never,
				ctx,
			);
			assert.equal(response.statusCode, 404, name);
		}
	});

	it("returns 404 with a structured unknown_workflow envelope for an unregistered name", async () => {
		const request = makeRequest("GET", "/api/workflows/does-not-exist/schema", authHeaders);
		const response = new MockResponse();

		await routeRequest(request as never, response as never, ctx);

		assert.equal(response.statusCode, 404);
		const body = jsonBody(response);
		assert.ok(body.error && typeof body.error === "object", "404 body must carry a structured error");
		assert.equal(body.error.code, "unknown_workflow");
		assert.equal(typeof body.error.message, "string");
		assert.match(body.error.message, /does-not-exist/);
		assert.deepEqual(body.error.details, { name: "does-not-exist" });
	});
});
