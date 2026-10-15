import { describe, expect, it, vi } from "vitest";
import { BrowserEngineRegistry, BrowserEngineUnavailableError, parseBrowserEngines } from "../engine-registry.js";
import { BrowserPool } from "../pool.js";
import type { BrowserEngine, BrowserPoolContract } from "../types.js";

function fakePool(engine: BrowserEngine): BrowserPoolContract {
	return {
		engine,
		acquireProcess: vi.fn(),
		releaseProcess: vi.fn(),
		close: vi.fn().mockResolvedValue(undefined),
		stats: () => ({ engine, processes: 1, activeSessions: 2, totalSessionsServed: 3 }),
	};
}

describe("BrowserEngineRegistry", () => {
	it("advertises each engine's health independently", () => {
		const registry = new BrowserEngineRegistry();
		registry.register(fakePool("chromium"));
		registry.markUnavailable("camoufox", "binary not installed");

		const health = registry.stats();
		expect(health.engines.chromium.available).toBe(true);
		expect(health.engines.camoufox.available).toBe(false);
		expect(health.engines.camoufox.experimental).toBe(true);
		expect(health.engines.camoufox.error).toContain("binary not installed");
		expect(health.processes).toBe(1);
	});

	it("fails a requested unavailable engine with an explicit 503 error", () => {
		const registry = new BrowserEngineRegistry();
		registry.markUnavailable("camoufox", "not fetched");
		expect(() => registry.require("camoufox")).toThrow(BrowserEngineUnavailableError);
		try {
			registry.require("camoufox");
		} catch (error) {
			expect((error as BrowserEngineUnavailableError).status).toBe(503);
		}
	});

	it("defaults to Chromium; still parses the retired camoufox name; refuses unknown engines", () => {
		expect(parseBrowserEngines(undefined)).toEqual(["chromium"]);
		expect(parseBrowserEngines("camoufox,chromium,camoufox")).toEqual(["camoufox", "chromium"]);
		expect(() => parseBrowserEngines("webkit")).toThrow(/unsupported browser engine/i);
	});

	it("starts Chromium alone and reports Camoufox retired, even when the environment still names it", async () => {
		const create = vi.spyOn(BrowserPool, "create").mockResolvedValue(fakePool("chromium") as unknown as BrowserPool);
		vi.stubEnv("BROWSER_ENGINES", "chromium,camoufox");
		try {
			const registry = await BrowserEngineRegistry.createFromEnvironment();
			expect(create).toHaveBeenCalledOnce();
			const health = registry.stats();
			expect(health.engines.chromium.available).toBe(true);
			expect(health.engines.camoufox.available).toBe(false);
			expect(health.engines.camoufox.error).toMatch(/retired/);
			expect(() => registry.require("camoufox")).toThrow(BrowserEngineUnavailableError);
		} finally {
			vi.unstubAllEnvs();
			create.mockRestore();
		}
	});
});
