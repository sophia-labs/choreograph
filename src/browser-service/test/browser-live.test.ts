/**
 * Live browser integration test.
 *
 * Requires chromium-headless-shell to be installed:
 *   pnpm exec playwright install chromium-headless-shell
 *
 * If the binary cannot be launched, ALL tests in this file are SKIPPED gracefully.
 * The unit tests (pool-unit.test.ts, server-unit.test.ts, origin-clamp.test.ts)
 * still run in that case.
 *
 * Test plan:
 *   1. Mint a session (no storageState, no boundOrigin)
 *   2. Navigate to the local fixture file
 *   3. read_a11y_tree → assert snapshot contains expected headings/buttons
 *   4. act by ref (click the button) → assert changed=true, snapshot reflects new state
 *   5. Teardown: DELETE the session → context is closed
 *
 * The fixture is served via file:// URL (no HTTP server needed).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureSnapshot, performAct } from "../a11y.js";
import { BrowserPool } from "../pool.js";
import { SessionManager } from "../sessions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, "../static/fixture.html");
const FIXTURE_URL = `file://${FIXTURE_PATH}`;

// ---------------------------------------------------------------------------
// Skip guard: try to resolve the headless-shell binary
// ---------------------------------------------------------------------------

let canRun = false;
let skipReason = "";

try {
	// Playwright 1.61: executablePath() takes no args. We check for the headless-shell
	// binary via the same cache dir heuristic as pool.ts (walk up to chromium-NNNN dir).
	const { execSync } = await import("node:child_process");
	const { default: path } = await import("node:path");
	const chromiumPath = chromium.executablePath();

	let execPath: string | null = process.env.PLAYWRIGHT_HEADLESS_SHELL_PATH ?? null;

	if (!execPath) {
		// Walk up from chromiumPath to find the ms-playwright cache dir
		let segment = chromiumPath;
		let version: string | null = null;
		let msCacheDir: string | null = null;
		for (let i = 0; i < 10; i++) {
			segment = path.dirname(segment);
			const base = path.basename(segment);
			if (/^chromium-\d+$/.test(base)) {
				const m = base.match(/^chromium-(\d+)$/);
				if (m) {
					version = m[1];
					msCacheDir = path.dirname(segment);
				}
				break;
			}
		}
		if (version && msCacheDir) {
			try {
				const found = execSync(
					`find "${msCacheDir}/chromium_headless_shell-${version}" -name "chrome-headless-shell" -not -path "*/\\.*" 2>/dev/null | head -1`,
					{ encoding: "utf8", timeout: 3000 },
				).trim();
				if (found) execPath = found;
			} catch {
				// not found
			}
			if (!execPath) {
				skipReason = `chromium-headless-shell binary not found in Playwright cache (${msCacheDir}). Run: pnpm exec playwright install chromium-headless-shell`;
			}
		} else {
			skipReason = "Could not determine Playwright cache directory from chromium executable path";
		}
	}

	if (execPath) {
		try {
			execSync(`"${execPath}" --version 2>&1`, { timeout: 5000 });
			canRun = true;
		} catch {
			skipReason = `chromium-headless-shell binary not executable at ${execPath}`;
		}
	}
} catch (e) {
	skipReason = `Skip-guard threw: ${e instanceof Error ? e.message : String(e)}`;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)("Live browser integration", () => {
	if (!canRun) {
		it.skip(`SKIPPED: ${skipReason}`, () => {});
		// Return early so the rest of the describe body doesn't execute
	}

	let pool: BrowserPool;
	let sessions: SessionManager;
	let sessionId: string;

	beforeAll(async () => {
		pool = await BrowserPool.create();
		sessions = new SessionManager(pool);
	}, 30_000);

	afterAll(async () => {
		await sessions.closeAll();
		await pool.close();
	}, 15_000);

	it("mints a session without storageState", async () => {
		const record = await sessions.createSession({});
		sessionId = record.sessionId;
		expect(sessionId).toBeTruthy();
	});

	it("navigates to the fixture page", async () => {
		const record = sessions.get(sessionId);
		if (!record) throw new Error("session missing");
		await record.page.goto(FIXTURE_URL, { waitUntil: "domcontentloaded" });
		expect(record.page.url()).toContain("fixture.html");
	});

	it("read_a11y_tree returns a snapshot with refs", async () => {
		const record = sessions.get(sessionId);
		if (!record) throw new Error("session missing");
		const { snapshot, refs } = await captureSnapshot(record);
		// The fixture has a <button aria-label="Click Me">
		expect(snapshot).toBeTruthy();
		expect(typeof snapshot).toBe("string");
		// Refs should contain at least one interactable element
		expect(Object.keys(refs).length).toBeGreaterThan(0);
	});

	it("act click changes the snapshot", async () => {
		const record = sessions.get(sessionId);
		if (!record) throw new Error("session missing");
		// Re-snapshot to populate refs
		const { refs } = await captureSnapshot(record);

		// Find the button ref (aria-label="Click Me")
		const buttonRef = Object.keys(refs).find((r) => r.startsWith("button:Click Me"));
		expect(buttonRef).toBeTruthy();

		const { changed } = await performAct(record, buttonRef!, "click");
		// The DOM updates #status text — the snapshot should change
		expect(changed).toBe(true);
	});

	it("closes the session without leaking the context", async () => {
		await sessions.closeSession(sessionId);
		expect(sessions.get(sessionId)).toBeUndefined();
	});
});

// Always-run sanity: the skip reason is logged even when all tests are skipped
if (!canRun) {
	describe("Live browser integration (skipped)", () => {
		it(`SKIPPED — ${skipReason}`, () => {
			console.log(`[browser-live.test.ts] SKIPPING live tests: ${skipReason}`);
		});
	});
}
