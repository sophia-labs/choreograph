/**
 * Unit tests for the HTTP router — sessions and pool are fully mocked.
 *
 * We build the router directly (without starting a real server) and feed it
 * mock IncomingMessage / ServerResponse objects. No browser is launched.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { BrowserPool } from "../pool.js";
import { createRouter } from "../server.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRecord } from "../types.js";

// ---------------------------------------------------------------------------
// Minimal mock IncomingMessage
// ---------------------------------------------------------------------------

function mockReq(method: string, url: string, body?: unknown): IncomingMessage {
	const bodyStr = body !== undefined ? JSON.stringify(body) : "";
	const emitter = {
		method,
		url,
		on: (event: string, cb: (...args: any[]) => void) => {
			if (event === "data" && bodyStr) cb(bodyStr);
			if (event === "end") cb();
			return emitter;
		},
	};
	return emitter as unknown as IncomingMessage;
}

// ---------------------------------------------------------------------------
// Minimal mock ServerResponse
// ---------------------------------------------------------------------------

function mockRes(): ServerResponse & { _status: number; _body: string; _ended: boolean } {
	let _status = 0;
	let _body = "";
	let _ended = false;
	const res = {
		get _status() {
			return _status;
		},
		get _body() {
			return _body;
		},
		get _ended() {
			return _ended;
		},
		headersSent: false,
		writeHead(code: number) {
			_status = code;
			res.headersSent = true;
		},
		end(data?: string) {
			if (data) _body += data;
			_ended = true;
		},
	};
	return res as any;
}

// ---------------------------------------------------------------------------
// Mock pool / sessions
// ---------------------------------------------------------------------------

function buildMocks() {
	const mockRecord: SessionRecord = {
		sessionId: "test-session-id",
		context: { close: vi.fn() } as any,
		page: {
			goto: vi.fn().mockResolvedValue(null),
			goBack: vi.fn().mockResolvedValue(null),
			goForward: vi.fn().mockResolvedValue(null),
			reload: vi.fn().mockResolvedValue(null),
			url: vi.fn().mockReturnValue("https://example.com/"),
			ariaSnapshot: vi.fn().mockResolvedValue("- heading: Test Fixture"),
			waitForLoadState: vi.fn().mockResolvedValue(null),
			screenshot: vi.fn().mockResolvedValue(Buffer.from("png-bytes")),
			getByRole: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue([]) }),
		} as any,
		processHandle: { activeContexts: 1, totalContexts: 1 } as any,
		engine: "chromium",
		browserVersion: "test-browser",
		viewportPinned: true,
		boundOrigin: null,
		createdAt: Date.now(),
		lastSnapshotRefs: new Map(),
		consoleErrors: [],
		pageErrors: [],
		traceChunk: 0,
	};

	const pool: Partial<BrowserPool> = {
		stats: vi.fn().mockReturnValue({ processes: 3, activeSessions: 1, totalSessionsServed: 1 }),
	};

	const sessions: Partial<SessionManager> = {
		createSession: vi.fn().mockResolvedValue(mockRecord),
		get: vi.fn().mockImplementation((id: string) => (id === "test-session-id" ? mockRecord : undefined)),
		list: vi.fn().mockReturnValue([mockRecord]),
		closeSession: vi.fn().mockResolvedValue(undefined),
	};

	return { mockRecord, pool: pool as BrowserPool, sessions: sessions as SessionManager };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HTTP router (mocked)", () => {
	it("GET /health returns ok + stats", async () => {
		const { pool, sessions } = buildMocks();
		const router = createRouter(sessions, pool);
		const req = mockReq("GET", "/health");
		const res = mockRes();
		await router(req as any, res as any);
		expect(res._status).toBe(200);
		const body = JSON.parse(res._body);
		expect(body.ok).toBe(true);
		expect(body.stats.processes).toBe(3);
	});

	it("POST /sessions creates a session", async () => {
		const { pool, sessions } = buildMocks();
		const router = createRouter(sessions, pool);
		const req = mockReq("POST", "/sessions", { boundOrigin: "https://example.com" });
		const res = mockRes();
		await router(req as any, res as any);
		expect(res._status).toBe(201);
		const body = JSON.parse(res._body);
		expect(body.sessionId).toBe("test-session-id");
		expect(body.engine).toBe("chromium");
		expect(body.browserVersion).toBe("test-browser");
	});

	it("POST /sessions forwards an explicit Camoufox engine selection", async () => {
		const { pool, sessions } = buildMocks();
		const router = createRouter(sessions, pool);
		const req = mockReq("POST", "/sessions", { engine: "camoufox", boundOrigin: "https://example.com" });
		const res = mockRes();
		await router(req as any, res as any);
		expect(res._status).toBe(201);
		expect(sessions.createSession).toHaveBeenCalledWith({
			engine: "camoufox",
			storageStateRef: undefined,
			boundOrigin: "https://example.com",
		});
	});

	it("GET /sessions lists sessions", async () => {
		const { pool, sessions } = buildMocks();
		const router = createRouter(sessions, pool);
		const req = mockReq("GET", "/sessions");
		const res = mockRes();
		await router(req as any, res as any);
		expect(res._status).toBe(200);
		const body = JSON.parse(res._body);
		expect(Array.isArray(body)).toBe(true);
		expect(body[0].sessionId).toBe("test-session-id");
	});

	it("DELETE /sessions/:id closes the session", async () => {
		const { pool, sessions } = buildMocks();
		const router = createRouter(sessions, pool);
		const req = mockReq("DELETE", "/sessions/test-session-id");
		const res = mockRes();
		await router(req as any, res as any);
		expect(res._status).toBe(204);
		expect(sessions.closeSession).toHaveBeenCalledWith("test-session-id");
	});

	it("POST /sessions/unknown/navigate returns 404", async () => {
		const { pool, sessions } = buildMocks();
		const router = createRouter(sessions, pool);
		const req = mockReq("POST", "/sessions/no-such-session/navigate", { action: "reload" });
		const res = mockRes();
		await router(req as any, res as any);
		expect(res._status).toBe(404);
	});

	it("POST /sessions/:id/navigate with off-origin URL returns 403 when boundOrigin set", async () => {
		const { pool, sessions, mockRecord } = buildMocks();
		mockRecord.boundOrigin = "https://garden.example.invalid";
		const router = createRouter(sessions, pool);
		const req = mockReq("POST", "/sessions/test-session-id/navigate", {
			action: "url",
			url: "https://evil.com/steal",
		});
		const res = mockRes();
		await router(req as any, res as any);
		expect(res._status).toBe(403);
	});

	it("POST /sessions/:id/navigate with same-origin URL succeeds", async () => {
		const { pool, sessions, mockRecord } = buildMocks();
		mockRecord.boundOrigin = "https://garden.example.invalid";
		const router = createRouter(sessions, pool);
		const req = mockReq("POST", "/sessions/test-session-id/navigate", {
			action: "url",
			url: "https://garden.example.invalid/some/page",
		});
		const res = mockRes();
		await router(req as any, res as any);
		expect(res._status).toBe(200);
		expect(mockRecord.page.goto).toHaveBeenCalledWith("https://garden.example.invalid/some/page", expect.any(Object));
	});

	it("GET /unknown returns 404", async () => {
		const { pool, sessions } = buildMocks();
		const router = createRouter(sessions, pool);
		const req = mockReq("GET", "/totally-unknown");
		const res = mockRes();
		await router(req as any, res as any);
		expect(res._status).toBe(404);
	});
});
