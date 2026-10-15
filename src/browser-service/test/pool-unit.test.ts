/**
 * Unit tests for BrowserPool logic — browser is fully mocked.
 *
 * We inject fake BrowserProcessHandles so no real Playwright processes are spawned.
 * Tests cover: capacity cap, acquire/release, recycle logic.
 */

import { describe, expect, it, vi } from "vitest";
import { BrowserPool } from "../pool.js";
import type { BrowserProcessHandle } from "../types.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeFakeHandle(overrides: Partial<BrowserProcessHandle> = {}): BrowserProcessHandle {
	return {
		browser: {
			close: vi.fn().mockResolvedValue(undefined),
		} as any,
		engine: "chromium",
		browserVersion: "test-browser",
		id: Math.floor(Math.random() * 10000),
		launchedAt: Date.now(),
		totalContexts: 0,
		activeContexts: 0,
		...overrides,
	};
}

/**
 * Build a BrowserPool with injected fake handles and the real acquireProcess logic,
 * but with launchProcess replaced so no real browsers are spawned.
 */
async function buildMockPool(handles: BrowserProcessHandle[]): Promise<BrowserPool> {
	// Create an empty pool without the real BrowserPool.create() (which calls launchProcess)
	const pool = new BrowserPool();
	pool._clearProcesses();
	for (const h of handles) {
		pool._injectProcess(h);
	}
	return pool;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BrowserPool (mocked)", () => {
	it("refuses an engine this build has no launcher for (the retired camoufox)", () => {
		expect(() => new BrowserPool({ engine: "camoufox" })).toThrow(/no launcher/);
	});

	it("acquireProcess increments activeContexts and totalContexts", async () => {
		const h = makeFakeHandle();
		const pool = await buildMockPool([h]);

		const result = await pool.acquireProcess();
		expect(result).toBe(h);
		expect(h.activeContexts).toBe(1);
		expect(h.totalContexts).toBe(1);
	});

	it("releaseProcess decrements activeContexts", async () => {
		const h = makeFakeHandle();
		const pool = await buildMockPool([h]);

		await pool.acquireProcess();
		expect(h.activeContexts).toBe(1);

		// Release — pool has only one handle so it won't close (not past recycle threshold)
		// Manually stub _ensureMinimum to be a no-op for isolated test
		await pool.releaseProcess(h);
		expect(h.activeContexts).toBe(0);
	});

	it("throws when all processes are at CONTEXT_CAP", async () => {
		// Simulate a handle that's already at context cap (20 active)
		const h = makeFakeHandle({ activeContexts: 20, totalContexts: 20 });
		const pool = await buildMockPool([h, h, h, h, h]); // 5 identical over-cap handles

		await expect(pool.acquireProcess()).rejects.toThrow(/hard cap/i);
	});

	it("uses first handle with capacity among multiple handles", async () => {
		const h1 = makeFakeHandle({ id: 1, activeContexts: 20 }); // at cap
		const h2 = makeFakeHandle({ id: 2, activeContexts: 0 }); // free
		const pool = await buildMockPool([h1, h2]);

		const result = await pool.acquireProcess();
		expect(result.id).toBe(h2.id);
	});

	it("skips recycled processes when assigning capacity", async () => {
		const old = makeFakeHandle({
			id: 10,
			launchedAt: Date.now() - 2 * 60 * 60 * 1000, // 2h old → needs recycle
			activeContexts: 0,
			totalContexts: 50,
		});
		const fresh = makeFakeHandle({ id: 20, activeContexts: 0, totalContexts: 0 });
		const pool = await buildMockPool([old, fresh]);

		const result = await pool.acquireProcess();
		expect(result.id).toBe(fresh.id);
	});

	it("stats reports correct counts", async () => {
		const h1 = makeFakeHandle({ activeContexts: 2 });
		const h2 = makeFakeHandle({ activeContexts: 3 });
		const pool = await buildMockPool([h1, h2]);

		const stats = pool.stats();
		expect(stats.processes).toBe(2);
		expect(stats.activeSessions).toBe(5);
		expect(stats.totalSessionsServed).toBe(0); // no acquires via pool yet
	});

	it("totalSessionsServed increments on each acquire", async () => {
		const h = makeFakeHandle();
		const pool = await buildMockPool([h]);

		await pool.acquireProcess();
		await pool.acquireProcess();
		expect(pool.stats().totalSessionsServed).toBe(2);
	});
});
