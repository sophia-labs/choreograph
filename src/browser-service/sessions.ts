/**
 * SessionManager — mint, track, and close BrowserContext sessions.
 *
 * Each session = one Playwright BrowserContext + its initial Page.
 * The context is loaded with the provided storageState (Cognito cookies/localStorage)
 * so the agent sees an authenticated browser.
 *
 * Navigation is origin-clamped: any attempt to navigate outside boundOrigin is
 * rejected with a 403. This prevents a session from escaping the system-under-test.
 *
 * MANDATORY: every context.close() path goes through closeSession() which wraps
 * it in a try/finally so unclosed contexts don't leak into the process.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { BrowserContextOptions } from "playwright";
import { BrowserEngineRegistry } from "./engine-registry.js";
import type { BrowserEngine, BrowserPoolContract, SessionRecord } from "./types.js";

/**
 * E0.2: one pinned viewport for every engine. Cross-engine perceptual diffs
 * must compare rendering, never default window sizes (dimensionsEqual was
 * false between engines before this pin).
 */
const PINNED_VIEWPORT = { width: 1280, height: 720 } as const;

const L0_INIT_SCRIPT = `(() => {
	const state = { mutations: { total: 0, added: 0, removed: 0, attributes: 0 }, layoutShifts: [], unhandledRejections: [] };
	Object.defineProperty(globalThis, "__sophiaL0", { value: state, configurable: false, enumerable: false });
	addEventListener("unhandledrejection", (event) => {
		const value = event.reason instanceof Error ? event.reason.message : String(event.reason ?? "unknown");
		state.unhandledRejections.push(value.slice(0, 512));
		if (state.unhandledRejections.length > 32) state.unhandledRejections.shift();
	});
	try {
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				state.layoutShifts.push({ value: Number(entry.value || 0), hadRecentInput: Boolean(entry.hadRecentInput), startTime: Number(entry.startTime || 0) });
			}
			if (state.layoutShifts.length > 64) state.layoutShifts.splice(0, state.layoutShifts.length - 64);
		}).observe({ type: "layout-shift", buffered: true });
	} catch {}
	const beginMutations = () => {
		if (!document.documentElement) return;
		new MutationObserver((records) => {
			for (const record of records) {
				state.mutations.total++;
				state.mutations.added += record.addedNodes.length;
				state.mutations.removed += record.removedNodes.length;
				if (record.type === "attributes") state.mutations.attributes++;
			}
		}).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
	};
	if (document.documentElement) beginMutations(); else addEventListener("DOMContentLoaded", beginMutations, { once: true });
})()`;

export class SessionManager {
	private sessions = new Map<string, SessionRecord>();

	constructor(private readonly engines: BrowserEngineRegistry | BrowserPoolContract) {}

	/**
	 * Mint a new authenticated BrowserContext session.
	 *
	 * storageStateRef: path to a Playwright storageState JSON file (optional).
	 * boundOrigin: if set, navigation outside this origin is rejected (optional).
	 */
	async createSession(opts: {
		engine?: BrowserEngine;
		storageStateRef?: string;
		boundOrigin?: string;
	}): Promise<SessionRecord> {
		const engine = opts.engine ?? "chromium";
		const pool = this.resolvePool(engine);
		const processHandle = await pool.acquireProcess();

		let contextOptions: BrowserContextOptions = {};
		if (opts.storageStateRef) {
			const raw = await readFile(opts.storageStateRef, "utf8");
			// Playwright accepts storageState as a path (string) or the parsed object.
			// We pass the parsed object so we don't need the file to remain on disk.
			contextOptions = { storageState: JSON.parse(raw) as BrowserContextOptions["storageState"] };
		}

		// E0.2: every engine gets the same pinned viewport so cross-engine
		// perceptual diffs measure rendering, never window size. Change-set 5:
		// some engine variants refuse the pin at protocol level (live:
		// chromium-headless-shell, Browser.setDefaultViewport). Retry exactly
		// once without the pin and stamp the caveat — a dimension mismatch
		// downstream becomes a KNOWN caveat, never a mint crash. Every other
		// error propagates unchanged.
		let context: import("playwright").BrowserContext;
		let viewportPinned = true;
		try {
			context = await processHandle.browser.newContext({ ...contextOptions, viewport: PINNED_VIEWPORT });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!/Protocol error.*[Vv]iewport/.test(message)) throw error;
			context = await processHandle.browser.newContext(contextOptions);
			viewportPinned = false;
		}
		await context.addInitScript({ content: L0_INIT_SCRIPT });
		await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
		await context.tracing.startChunk();

		// Open the initial page
		const page = await context.newPage();

		const sessionId = randomUUID();
		const consoleErrors: string[] = [];
		const pageErrors: string[] = [];
		page.on("console", (message) => {
			if (message.type() === "error") pushBounded(consoleErrors, message.text());
		});
		page.on("pageerror", (error) => pushBounded(pageErrors, error.message));

		const record: SessionRecord = {
			sessionId,
			context,
			page,
			processHandle,
			engine,
			browserVersion: processHandle.browserVersion,
			boundOrigin: opts.boundOrigin ?? null,
			createdAt: Date.now(),
			lastSnapshotRefs: new Map(),
			consoleErrors,
			pageErrors,
			traceChunk: 0,
			viewportPinned,
		};
		this.sessions.set(sessionId, record);
		return record;
	}

	get(sessionId: string): SessionRecord | undefined {
		return this.sessions.get(sessionId);
	}

	list(): SessionRecord[] {
		return Array.from(this.sessions.values());
	}

	/**
	 * Close a session's BrowserContext and release the process slot.
	 * MANDATORY finally-block: context.close() always runs.
	 */
	async closeSession(sessionId: string): Promise<void> {
		const record = this.sessions.get(sessionId);
		if (!record) return;
		this.sessions.delete(sessionId);
		try {
			await record.context.tracing.stop().catch(() => {});
			await record.context.close();
		} finally {
			await this.resolvePool(record.engine).releaseProcess(record.processHandle);
		}
	}

	/**
	 * Close all sessions (used during graceful shutdown).
	 */
	async closeAll(): Promise<void> {
		const ids = Array.from(this.sessions.keys());
		await Promise.allSettled(ids.map((id) => this.closeSession(id)));
	}

	private resolvePool(engine: BrowserEngine): BrowserPoolContract {
		if (this.engines instanceof BrowserEngineRegistry) return this.engines.require(engine);
		if (this.engines.engine !== engine) {
			throw new Error(`Browser engine '${engine}' is unavailable (only '${this.engines.engine}' is registered)`);
		}
		return this.engines;
	}
}

function pushBounded(target: string[], value: string): void {
	target.push(value.slice(0, 512));
	if (target.length > 32) target.shift();
}
