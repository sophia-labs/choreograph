/**
 * Change-set 5: defensive viewport pin.
 *
 * Live evidence (wfr-mt2faq28-p6a8l0): chromium-headless-shell in the deployed
 * playwright container refuses the E0.2 viewport pin at protocol level —
 * `browser.newContext: Protocol error (Browser.setDefaultViewport)` — while
 * local full chromium accepts it. The pin must degrade to a stamped caveat
 * (viewportPinned: false), never a mint crash. Non-viewport errors propagate.
 */
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../sessions.js";
import type { BrowserPoolContract, BrowserProcessHandle } from "../types.js";

function fakeContext() {
	return {
		addInitScript: vi.fn().mockResolvedValue(undefined),
		tracing: {
			start: vi.fn().mockResolvedValue(undefined),
			startChunk: vi.fn().mockResolvedValue(undefined),
		},
		newPage: vi.fn().mockResolvedValue({ on: vi.fn() }),
	};
}

function poolWithNewContext(newContext: (options?: Record<string, unknown>) => Promise<unknown>): {
	pool: BrowserPoolContract;
	newContext: typeof newContext;
} {
	const handle = {
		browser: { newContext } as unknown,
		engine: "chromium",
		browserVersion: "test-browser",
		id: 1,
		launchedAt: Date.now(),
		totalContexts: 0,
		activeContexts: 0,
	} as unknown as BrowserProcessHandle;
	const pool = {
		engine: "chromium",
		acquireProcess: vi.fn().mockResolvedValue(handle),
		releaseProcess: vi.fn().mockResolvedValue(undefined),
	} as unknown as BrowserPoolContract;
	return { pool, newContext };
}

describe("SessionManager defensive viewport pin", () => {
	it("mints unpinned with a stamped caveat when the engine refuses the viewport at protocol level", async () => {
		const calls: Array<Record<string, unknown> | undefined> = [];
		const newContext = vi.fn(async (options?: Record<string, unknown>) => {
			calls.push(options);
			if (calls.length === 1) {
				throw new Error("browser.newContext: Protocol error (Browser.setDefaultViewport): Not supported");
			}
			return fakeContext();
		});
		const { pool } = poolWithNewContext(newContext);
		const manager = new SessionManager(pool);
		const record = await manager.createSession({ engine: "chromium" });
		expect(record.viewportPinned).toBe(false);
		expect(newContext).toHaveBeenCalledTimes(2);
		expect(calls[0]?.viewport).toEqual({ width: 1280, height: 720 });
		expect(calls[1]?.viewport).toBeUndefined();
	});

	it("pins the viewport and stamps viewportPinned true on a compliant engine", async () => {
		const calls: Array<Record<string, unknown> | undefined> = [];
		const newContext = vi.fn(async (options?: Record<string, unknown>) => {
			calls.push(options);
			return fakeContext();
		});
		const { pool } = poolWithNewContext(newContext);
		const manager = new SessionManager(pool);
		const record = await manager.createSession({ engine: "chromium" });
		expect(record.viewportPinned).toBe(true);
		expect(newContext).toHaveBeenCalledTimes(1);
		expect(calls[0]?.viewport).toEqual({ width: 1280, height: 720 });
	});

	it("propagates non-viewport protocol errors without a retry", async () => {
		const newContext = vi.fn(async () => {
			throw new Error("browser.newContext: Protocol error (Target.createTarget): browser has crashed");
		});
		const { pool } = poolWithNewContext(newContext);
		const manager = new SessionManager(pool);
		await expect(manager.createSession({ engine: "chromium" })).rejects.toThrow(/Target.createTarget/);
		expect(newContext).toHaveBeenCalledTimes(1);
	});
});
