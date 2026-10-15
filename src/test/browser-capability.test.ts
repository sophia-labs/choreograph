/**
 * subject.web BrowserCapabilityBackend tests — HTTP client mock.
 *
 * All tests use an injectable fetchFn so no real HTTP is needed.
 * Verifies:
 *   (b) The browser HTTP client correctly implements the garden-browser-service contract.
 *   - Session creation (POST /sessions) → sessionId captured, not forwarded
 *   - navigate, read_a11y_tree, act, screenshot tool calls
 *   - Session close (DELETE /sessions/:id) on close()
 *   - Error propagation (4xx/5xx from service)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BrowserCapabilityBackend,
	BrowserCapabilityDeniedError,
	resolveBrowserServiceUrl,
} from "../browser-capability.js";
import { createDefaultHostCapabilityCatalog } from "../capabilities/default-catalog.js";

// ─── Mock fetch builder ────────────────────────────────────────────────────

interface MockCall {
	method: string;
	url: string;
	body?: unknown;
}

function makeMockFetch(responses: Array<{ status: number; body?: unknown }>): {
	fetchFn: typeof fetch;
	calls: MockCall[];
} {
	const calls: MockCall[] = [];
	let index = 0;

	const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		let body: unknown;
		try {
			body = init?.body ? JSON.parse(String(init.body)) : undefined;
		} catch {
			body = init?.body;
		}
		calls.push({ method: init?.method ?? "GET", url, body });

		const resp = responses[index++];
		if (!resp) throw new Error(`Mock fetch: no response configured for call ${index}`);

		const bodyText = resp.body !== undefined ? JSON.stringify(resp.body) : "";
		return new Response(bodyText || null, {
			status: resp.status,
			headers: { "content-type": "application/json" },
		});
	};

	return { fetchFn: fetchFn as typeof fetch, calls };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("BrowserCapabilityBackend", () => {
	it("create() mints a browser session and captures sessionId", async () => {
		const { fetchFn, calls } = makeMockFetch([{ status: 201, body: { sessionId: "sess-abc" } }]);

		const backend = new BrowserCapabilityBackend({
			serviceBaseUrl: "http://127.0.0.1:7771",
			boundOrigin: "https://garden.example.invalid",
			fetchFn,
		});

		const { sessionId } = await backend.create();
		assert.equal(sessionId, "sess-abc");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].method, "POST");
		assert.equal(calls[0].url, "http://127.0.0.1:7771/sessions");
		assert.deepEqual(calls[0].body, { boundOrigin: "https://garden.example.invalid" });
	});

	it("create() sends storageStateRef when provided", async () => {
		const { fetchFn, calls } = makeMockFetch([{ status: 201, body: { sessionId: "sess-xyz" } }]);

		const backend = new BrowserCapabilityBackend({
			serviceBaseUrl: "http://127.0.0.1:7771",
			storageStateRef: "/tmp/state.json",
			boundOrigin: "https://example.com",
			fetchFn,
		});

		await backend.create();
		assert.deepEqual(calls[0].body, { storageStateRef: "/tmp/state.json", boundOrigin: "https://example.com" });
	});

	it("navigate tool — sends action and url to the service", async () => {
		const { fetchFn, calls } = makeMockFetch([
			{ status: 201, body: { sessionId: "sess-1" } },
			{ status: 200, body: { url: "https://example.com/page" } },
		]);

		const backend = new BrowserCapabilityBackend({ serviceBaseUrl: "http://127.0.0.1:7771", fetchFn });
		await backend.create();

		const result = await backend.callTool("navigate", { action: "url", url: "https://example.com/page" });
		assert.deepEqual(result, { url: "https://example.com/page" });

		assert.equal(calls[1].method, "POST");
		assert.equal(calls[1].url, "http://127.0.0.1:7771/sessions/sess-1/navigate");
		assert.deepEqual(calls[1].body, { action: "url", url: "https://example.com/page" });
	});

	it("read_a11y_tree tool — sends empty body and returns snapshot + refs", async () => {
		const snapshot = "- heading level=1: Welcome";
		const refs = { "button:Submit": "ref-0" };

		const { fetchFn, calls } = makeMockFetch([
			{ status: 201, body: { sessionId: "sess-2" } },
			{ status: 200, body: { snapshot, refs } },
		]);

		const backend = new BrowserCapabilityBackend({ serviceBaseUrl: "http://127.0.0.1:7771", fetchFn });
		await backend.create();

		const result = await backend.callTool("read_a11y_tree", {});
		assert.deepEqual(result, { snapshot, refs });

		assert.equal(calls[1].method, "POST");
		assert.equal(calls[1].url, "http://127.0.0.1:7771/sessions/sess-2/read_a11y_tree");
	});

	it("act tool — sends ref + action + value and returns changed + new snapshot", async () => {
		const { fetchFn, calls } = makeMockFetch([
			{ status: 201, body: { sessionId: "sess-3" } },
			{ status: 200, body: { changed: true, snapshot: "- textbox: hello", refs: {} } },
		]);

		const backend = new BrowserCapabilityBackend({ serviceBaseUrl: "http://127.0.0.1:7771", fetchFn });
		await backend.create();

		const result = await backend.callTool("act", { ref: "ref-0", action: "type", value: "hello" });
		assert.deepEqual(result, { changed: true, snapshot: "- textbox: hello", refs: {} });

		assert.equal(calls[1].method, "POST");
		assert.equal(calls[1].url, "http://127.0.0.1:7771/sessions/sess-3/act");
		assert.deepEqual(calls[1].body, { ref: "ref-0", action: "type", value: "hello" });
	});

	it("screenshot tool — sends optional ref and returns base64 PNG", async () => {
		const { fetchFn, calls } = makeMockFetch([
			{ status: 201, body: { sessionId: "sess-4" } },
			{ status: 200, body: { data: "iVBORw0KGgo=", mimeType: "image/png" } },
		]);

		const backend = new BrowserCapabilityBackend({ serviceBaseUrl: "http://127.0.0.1:7771", fetchFn });
		await backend.create();

		const result = await backend.callTool("screenshot", { ref: "ref-1" });
		assert.deepEqual(result, { data: "iVBORw0KGgo=", mimeType: "image/png" });

		assert.equal(calls[1].method, "POST");
		assert.equal(calls[1].url, "http://127.0.0.1:7771/sessions/sess-4/screenshot");
		assert.deepEqual(calls[1].body, { ref: "ref-1" });
	});

	it("screenshot tool — omits ref when not provided", async () => {
		const { fetchFn, calls } = makeMockFetch([
			{ status: 201, body: { sessionId: "sess-5" } },
			{ status: 200, body: { data: "base64data", mimeType: "image/png" } },
		]);

		const backend = new BrowserCapabilityBackend({ serviceBaseUrl: "http://127.0.0.1:7771", fetchFn });
		await backend.create();

		await backend.callTool("screenshot", {});
		assert.deepEqual(calls[1].body, {});
	});

	it("close() sends DELETE /sessions/:id and clears sessionId", async () => {
		const { fetchFn, calls } = makeMockFetch([{ status: 201, body: { sessionId: "sess-6" } }, { status: 204 }]);

		const backend = new BrowserCapabilityBackend({ serviceBaseUrl: "http://127.0.0.1:7771", fetchFn });
		await backend.create();
		await backend.close();

		assert.equal(calls[1].method, "DELETE");
		assert.equal(calls[1].url, "http://127.0.0.1:7771/sessions/sess-6");
	});

	it("close() is idempotent (second call is a no-op)", async () => {
		const { fetchFn, calls } = makeMockFetch([{ status: 201, body: { sessionId: "sess-7" } }, { status: 204 }]);

		const backend = new BrowserCapabilityBackend({ serviceBaseUrl: "http://127.0.0.1:7771", fetchFn });
		await backend.create();
		await backend.close();
		await backend.close(); // second call — should not throw

		assert.equal(calls.length, 2); // only the first DELETE
	});

	it("service 403 (origin clamping) propagates as Error", async () => {
		const { fetchFn } = makeMockFetch([
			{ status: 201, body: { sessionId: "sess-8" } },
			{ status: 403, body: { error: "OriginClampError: https://evil.com is not allowed" } },
		]);

		const backend = new BrowserCapabilityBackend({ serviceBaseUrl: "http://127.0.0.1:7771", fetchFn });
		await backend.create();

		await assert.rejects(
			() => backend.callTool("navigate", { action: "url", url: "https://evil.com" }),
			(err: Error) => {
				assert.ok(err.message.includes("403"), `expected 403 in message, got: ${err.message}`);
				return true;
			},
		);
	});

	it("unknown tool throws an Error", async () => {
		const { fetchFn } = makeMockFetch([{ status: 201, body: { sessionId: "sess-9" } }]);

		const backend = new BrowserCapabilityBackend({ serviceBaseUrl: "http://127.0.0.1:7771", fetchFn });
		await backend.create();

		await assert.rejects(() => backend.callTool("nonexistent_tool", {}), /unknown tool "nonexistent_tool"/);
	});

	it("callTool before create() throws", async () => {
		const { fetchFn } = makeMockFetch([]);
		const backend = new BrowserCapabilityBackend({ serviceBaseUrl: "http://127.0.0.1:7771", fetchFn });

		await assert.rejects(() => backend.callTool("navigate", { action: "reload" }), /session not created/);
	});

	it("listTools returns the browser action and L0 evidence tools", async () => {
		const { fetchFn } = makeMockFetch([]);
		const backend = new BrowserCapabilityBackend({ serviceBaseUrl: "http://127.0.0.1:7771", fetchFn });

		const tools = await backend.listTools();
		const names = tools.map((t) => t.name);
		assert.deepEqual(names, ["navigate", "read_a11y_tree", "act", "screenshot", "probe", "capture_beat"]);
	});

	it("binds a named engine capability and names the engine on the session request", async () => {
		const { fetchFn, calls } = makeMockFetch([
			{
				status: 201,
				body: { sessionId: "cr-1", engine: "chromium", browserVersion: "Chromium 130" },
			},
		]);
		const backend = new BrowserCapabilityBackend({
			serviceBaseUrl: "http://127.0.0.1:7771",
			engine: "chromium",
			capabilityName: "browser.chromium",
			fetchFn,
		});

		const session = await backend.create();
		assert.deepEqual(calls[0].body, { engine: "chromium" });
		assert.deepEqual(session, { sessionId: "cr-1", engine: "chromium", browserVersion: "Chromium 130" });
		assert.equal(backend.capabilityName, "browser.chromium");
		assert.equal(backend.engine, "chromium");
	});

	it("offers no browser.camoufox capability: the engine is retired", () => {
		const names = createDefaultHostCapabilityCatalog().list();
		assert.ok(names.includes("browser") && names.includes("browser.chromium"));
		assert.ok(!names.includes("browser.camoufox"));
	});

	it("probe returns compact engine-tagged L0 evidence", async () => {
		const probe = {
			engine: "chromium",
			browserVersion: "Chromium 130",
			url: "https://example.com",
			title: "Example",
			readyState: "complete",
			contentType: "text/html",
			viewport: { width: 1280, height: 720 },
			bodyTextSha256: "abc123",
		};
		const { fetchFn, calls } = makeMockFetch([
			{ status: 201, body: { sessionId: "probe-1", engine: "chromium", browserVersion: "Chromium 130" } },
			{ status: 200, body: probe },
		]);
		const backend = new BrowserCapabilityBackend({ serviceBaseUrl: "http://127.0.0.1:7771", fetchFn });
		await backend.create();
		assert.deepEqual(await backend.callTool("probe", {}), probe);
		assert.equal(calls[1].url, "http://127.0.0.1:7771/sessions/probe-1/probe");
	});

	it("capabilityName and accessLevel are correct", () => {
		const { fetchFn } = makeMockFetch([]);

		const rw = new BrowserCapabilityBackend({ serviceBaseUrl: "http://127.0.0.1:7771", fetchFn });
		assert.equal(rw.capabilityName, "subject.web");
		assert.equal(rw.accessLevel, "rw"); // default

		const ro = new BrowserCapabilityBackend({ serviceBaseUrl: "http://127.0.0.1:7771", accessLevel: "ro", fetchFn });
		assert.equal(ro.accessLevel, "ro");
	});

	it("attenuates viewer bindings to evidence-only browser tools", async () => {
		const { fetchFn } = makeMockFetch([{ status: 201, body: { sessionId: "sess-ro" } }]);
		const backend = new BrowserCapabilityBackend({
			serviceBaseUrl: "http://127.0.0.1:7771",
			accessLevel: "ro",
			fetchFn,
		});
		await backend.create();
		assert.equal(
			(await backend.listTools()).some((tool) => tool.name === "act"),
			false,
		);
		await assert.rejects(() => backend.callTool("act", { ref: "e1", action: "click" }), BrowserCapabilityDeniedError);
	});

	it("trailing slash on serviceBaseUrl is trimmed", async () => {
		const { fetchFn, calls } = makeMockFetch([{ status: 201, body: { sessionId: "sess-10" } }]);

		const backend = new BrowserCapabilityBackend({
			serviceBaseUrl: "http://127.0.0.1:7771/",
			fetchFn,
		});
		await backend.create();
		assert.equal(calls[0].url, "http://127.0.0.1:7771/sessions");
	});
});

describe("resolveBrowserServiceUrl", () => {
	it("returns override when provided", () => {
		assert.equal(resolveBrowserServiceUrl("http://custom:9999"), "http://custom:9999");
	});

	it("falls back to env vars or defaults", () => {
		const orig = { host: process.env.BROWSER_SERVICE_HOST, port: process.env.BROWSER_SERVICE_PORT };
		delete process.env.BROWSER_SERVICE_HOST;
		delete process.env.BROWSER_SERVICE_PORT;

		assert.equal(resolveBrowserServiceUrl(), "http://127.0.0.1:7771");

		process.env.BROWSER_SERVICE_HOST = "10.0.0.1";
		process.env.BROWSER_SERVICE_PORT = "8888";
		assert.equal(resolveBrowserServiceUrl(), "http://10.0.0.1:8888");

		// Restore
		if (orig.host !== undefined) process.env.BROWSER_SERVICE_HOST = orig.host;
		else delete process.env.BROWSER_SERVICE_HOST;
		if (orig.port !== undefined) process.env.BROWSER_SERVICE_PORT = orig.port;
		else delete process.env.BROWSER_SERVICE_PORT;
	});
});
