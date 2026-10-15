import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

// HTTP integration suite: needs a live orchestrator. Opt in by pointing
// CHOREOGRAPH_API_TEST_BASE_URL at a running instance (e.g. http://localhost:3456,
// or the dev VM). Unset ⇒ the suite skips cleanly instead of failing the run.
// Mirrors the env-gated idiom in workflow-run.integration.test.ts.
const BASE_URL = process.env.CHOREOGRAPH_API_TEST_BASE_URL ?? "http://localhost:3456";
const apiTestSkip = process.env.CHOREOGRAPH_API_TEST_BASE_URL
	? false
	: "set CHOREOGRAPH_API_TEST_BASE_URL to a running orchestrator to run the HTTP API integration tests";
const INTERNAL_SERVICE_SECRET = "dev-internal-secret";
const AUTH_HEADERS = {
	"x-internal-service": INTERNAL_SERVICE_SECRET,
	"x-user-id": "api-test-user",
};
const OTHER_AUTH_HEADERS = {
	"x-internal-service": INTERNAL_SERVICE_SECRET,
	"x-user-id": "api-test-other-user",
};

async function api(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
	const res = await fetch(`${BASE_URL}${path}`, {
		method,
		headers: {
			...(body ? { "content-type": "application/json" } : {}),
			...(headers ?? {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const data = await res.json();
	return { status: res.status, data };
}

async function waitForState(
	sandboxId: string,
	targetStates: Set<string>,
	timeoutMs = 15_000,
): Promise<{ status: number; data: any }> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await api("GET", `/api/sandboxes/${sandboxId}`, undefined, AUTH_HEADERS);
		if (targetStates.has(res.data.sandbox?.state)) return res;
		await new Promise((r) => setTimeout(r, 300));
	}
	throw new Error(`Sandbox ${sandboxId} did not reach target state within ${timeoutMs}ms`);
}

const TERMINAL = new Set(["done", "truncated", "error", "timeout", "killed"]);

describe("HTTP API", { concurrency: false, skip: apiTestSkip }, () => {
	// Verify server is reachable
	before(async () => {
		try {
			await fetch(`${BASE_URL}/api/templates`);
		} catch {
			throw new Error(
				`Server not reachable at ${BASE_URL} (CHOREOGRAPH_API_TEST_BASE_URL). Start the orchestrator first.`,
			);
		}
	});

	it("GET /health returns queue stats and process info", async () => {
		const { status, data } = await api("GET", "/health");
		assert.equal(status, 200);
		assert.equal(data.status, "ok");
		assert.equal(typeof data.uptime_seconds, "number");
		assert.ok(data.queue);
		assert.equal(typeof data.queue.available, "number");
		assert.ok(data.process);
		assert.equal(typeof data.process.rss_bytes, "number");
		assert.equal(typeof data.process.heap_used_bytes, "number");
	});

	it("GET /api/templates returns template list", async () => {
		const { status, data } = await api("GET", "/api/templates");
		assert.equal(status, 200);
		assert.ok(Array.isArray(data.templates));
		assert.equal(data.templates.length, 3);
		const ids = data.templates.map((t: any) => t.id);
		assert.ok(!ids.includes("agent"));
		assert.ok(ids.includes("bare"));
		assert.ok(ids.includes("workspace"));
		assert.ok(ids.includes("python"));
	});

	it("GET /api/filesystems returns filesystem bundle list", async () => {
		const { status, data } = await api("GET", "/api/filesystems");
		assert.equal(status, 200);
		assert.ok(Array.isArray(data.filesystems));
		const ids = data.filesystems.map((t: any) => t.id);
		assert.ok(ids.includes("workspace"));
		assert.ok(ids.includes("python-runtime"));
		assert.ok(ids.includes("sophia-kernel-runtime"));
	});

	it("POST /api/sandboxes rejects unauthenticated callers", async () => {
		const { status, data } = await api("POST", "/api/sandboxes", {
			template: "bare",
		});
		assert.equal(status, 401);
		assert.match(data.error, /requires Authorization/i);
	});

	it("GET /api/sandboxes rejects unauthenticated callers", async () => {
		const { status, data } = await api("GET", "/api/sandboxes");
		assert.equal(status, 401);
		assert.match(data.error, /requires Authorization/i);
	});

	it("POST /api/sandboxes enqueues a sandbox (HTTP 202)", async () => {
		const { status, data } = await api(
			"POST",
			"/api/sandboxes",
			{
				template: "bare",
				worker_config: { max_iterations: 2, sleep_ms: 100 },
			},
			AUTH_HEADERS,
		);
		assert.equal(status, 202);
		assert.ok(data.sandbox);
		assert.ok(data.sandbox.sandbox_id);
		assert.equal(data.sandbox.template, "bare");
		assert.equal(data.sandbox.state, "queued");
	});

	it("POST /api/sandboxes tombstones direct agent execution", async () => {
		const { status, data } = await api(
			"POST",
			"/api/sandboxes",
			{
				template: "agent",
				worker_config: { kind: "agent", prompt: "fabricated authority" },
			},
			AUTH_HEADERS,
		);
		assert.equal(status, 410);
		assert.match(data.error, /ontology-resolved workflow Agent Node/i);
	});

	it("POST /api/sandboxes persists effective filesystem bundle IDs", async () => {
		const { status, data } = await api(
			"POST",
			"/api/sandboxes",
			{
				template: "workspace",
				filesystems: ["workspace"],
				worker_config: { max_iterations: 1, sleep_ms: 10 },
			},
			AUTH_HEADERS,
		);
		assert.equal(status, 202);
		assert.deepEqual(data.sandbox.filesystems, ["workspace"]);
	});

	it("GET /api/sandboxes lists sandboxes", async () => {
		const { status, data } = await api("GET", "/api/sandboxes", undefined, AUTH_HEADERS);
		assert.equal(status, 200);
		assert.ok(Array.isArray(data.sandboxes));
		assert.equal(typeof data.count, "number");
		assert.equal(data.count, data.sandboxes.length);
	});

	it("GET /api/sandboxes/:id returns sandbox detail", async () => {
		const spawn = await api(
			"POST",
			"/api/sandboxes",
			{
				template: "bare",
				worker_config: { max_iterations: 2, sleep_ms: 100 },
			},
			AUTH_HEADERS,
		);
		const id = spawn.data.sandbox.sandbox_id;

		const { status, data } = await api("GET", `/api/sandboxes/${id}`, undefined, AUTH_HEADERS);
		assert.equal(status, 200);
		assert.equal(data.sandbox.sandbox_id, id);
	});

	it("GET /api/sandboxes/:id returns 404 for unknown", async () => {
		const { status } = await api("GET", "/api/sandboxes/nonexistent-id", undefined, AUTH_HEADERS);
		assert.equal(status, 404);
	});

	it("sandbox detail is hidden from other authenticated users", async () => {
		const spawn = await api(
			"POST",
			"/api/sandboxes",
			{
				template: "bare",
				worker_config: { max_iterations: 2, sleep_ms: 100 },
			},
			AUTH_HEADERS,
		);
		const id = spawn.data.sandbox.sandbox_id;

		const { status } = await api("GET", `/api/sandboxes/${id}`, undefined, OTHER_AUTH_HEADERS);
		assert.equal(status, 404);
	});

	it("GET /api/sandboxes?state=invalid returns 400", async () => {
		const { status, data } = await api("GET", "/api/sandboxes?state=bogus", undefined, AUTH_HEADERS);
		assert.equal(status, 400);
		assert.ok(data.error.includes("Invalid state filter"));
	});

	it("GET /api/sandboxes?state=running filters correctly", async () => {
		const { status, data } = await api("GET", "/api/sandboxes?state=running", undefined, AUTH_HEADERS);
		assert.equal(status, 200);
		for (const s of data.sandboxes) {
			assert.equal(s.state, "running");
		}
	});

	it("GET /api/sandboxes only returns sandboxes owned by the caller", async () => {
		const spawn = await api(
			"POST",
			"/api/sandboxes",
			{
				template: "bare",
				worker_config: { max_iterations: 2, sleep_ms: 100 },
			},
			OTHER_AUTH_HEADERS,
		);
		const id = spawn.data.sandbox.sandbox_id;

		const ownList = await api("GET", "/api/sandboxes", undefined, AUTH_HEADERS);
		assert.equal(ownList.status, 200);
		assert.equal(
			ownList.data.sandboxes.some((sandbox: any) => sandbox.sandbox_id === id),
			false,
		);

		const otherList = await api("GET", "/api/sandboxes", undefined, OTHER_AUTH_HEADERS);
		assert.equal(otherList.status, 200);
		assert.equal(
			otherList.data.sandboxes.some((sandbox: any) => sandbox.sandbox_id === id),
			true,
		);
	});

	it("POST /api/sandboxes/:id/kill kills a running sandbox", async () => {
		const spawn = await api(
			"POST",
			"/api/sandboxes",
			{
				template: "bare",
				worker_config: { max_iterations: 600, sleep_ms: 1000 },
			},
			AUTH_HEADERS,
		);
		const id = spawn.data.sandbox.sandbox_id;

		// Wait until running (sandbox starts in queued, then transitions)
		await waitForState(id, new Set(["running"]));

		const { status, data } = await api("POST", `/api/sandboxes/${id}/kill`, undefined, AUTH_HEADERS);
		assert.equal(status, 200);
		assert.equal(data.sandbox.state, "killed");
	});

	it("POST /api/sandboxes/:id/kill returns 409 for non-running", async () => {
		const spawn = await api(
			"POST",
			"/api/sandboxes",
			{
				template: "bare",
				worker_config: { max_iterations: 2, sleep_ms: 100 },
			},
			AUTH_HEADERS,
		);
		const id = spawn.data.sandbox.sandbox_id;

		// Wait for it to finish
		await waitForState(id, TERMINAL);

		const { status } = await api("POST", `/api/sandboxes/${id}/kill`, undefined, AUTH_HEADERS);
		assert.equal(status, 409);
	});

	it("POST /api/sandboxes/:id/kill returns 404 for unknown", async () => {
		const { status } = await api("POST", "/api/sandboxes/nonexistent-id/kill", undefined, AUTH_HEADERS);
		assert.equal(status, 404);
	});

	it("POST /api/sandboxes/:id/kill returns 404 for sandboxes owned by another user", async () => {
		const spawn = await api(
			"POST",
			"/api/sandboxes",
			{
				template: "bare",
				worker_config: { max_iterations: 600, sleep_ms: 1000 },
			},
			AUTH_HEADERS,
		);
		const id = spawn.data.sandbox.sandbox_id;

		await waitForState(id, new Set(["running"]));

		const { status } = await api("POST", `/api/sandboxes/${id}/kill`, undefined, OTHER_AUTH_HEADERS);
		assert.equal(status, 404);

		await api("POST", `/api/sandboxes/${id}/kill`, undefined, AUTH_HEADERS);
	});
});
