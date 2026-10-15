/**
 * Playwright process pool (Chromium).
 *
 * Context allocation, recycling, hard caps, session accounting, and teardown are
 * engine-neutral; engines differ only at process launch, and engine identity is
 * carried on every process. Camoufox, the second engine, was removed on
 * 2026-10-13 (its `camoufox-js` dependency brought the AGPL `ua-parser-js`).
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { type Browser, chromium } from "playwright";
import type { BrowserEngine, BrowserPoolContract, BrowserProcessHandle } from "./types.js";

export interface BrowserPoolOptions {
	readonly engine?: BrowserEngine;
	readonly launchBrowser?: () => Promise<Browser>;
	readonly minProcesses?: number;
	readonly maxProcesses?: number;
	readonly contextCap?: number;
	readonly recycleAfterMs?: number;
	readonly recycleAfterSessions?: number;
}

interface ResolvedBrowserPoolOptions {
	readonly engine: BrowserEngine;
	readonly launchBrowser: () => Promise<Browser>;
	readonly minProcesses: number;
	readonly maxProcesses: number;
	readonly contextCap: number;
	readonly recycleAfterMs: number;
	readonly recycleAfterSessions: number;
}

const CHROMIUM_DEFAULTS = {
	minProcesses: 3,
	maxProcesses: 5,
	contextCap: 20,
	recycleAfterMs: 60 * 60 * 1000,
	recycleAfterSessions: 100,
} as const;

const CHROMIUM_LAUNCH_ARGS = [
	"--headless=new",
	"--no-sandbox",
	"--disable-dev-shm-usage",
	"--disable-gpu",
	"--disable-extensions",
	"--disable-background-networking",
	"--disable-sync",
	"--mute-audio",
	"--force-renderer-accessibility=complete",
];

let nextProcessId = 1;

/** Resolve chromium-headless-shell, with regular Chromium as a local fallback. */
export function resolveHeadlessShellPath(): string {
	if (process.env.PLAYWRIGHT_HEADLESS_SHELL_PATH) {
		return process.env.PLAYWRIGHT_HEADLESS_SHELL_PATH;
	}

	const chromiumPath = chromium.executablePath();
	let segment = chromiumPath;
	let version: string | null = null;
	let msCacheDir: string | null = null;
	for (let i = 0; i < 10; i++) {
		segment = path.dirname(segment);
		const match = /^chromium-(\d+)$/.exec(path.basename(segment));
		if (match) {
			version = match[1];
			msCacheDir = path.dirname(segment);
			break;
		}
	}

	if (version && msCacheDir) {
		try {
			const result = execSync(
				`find "${msCacheDir}/chromium_headless_shell-${version}" -name "chrome-headless-shell" -not -path "*/\\.*" 2>/dev/null | head -1`,
				{ encoding: "utf8", timeout: 3000 },
			).trim();
			if (result) return result;
		} catch {
			// Use Playwright's ordinary Chromium binary for local development.
		}
	}

	return chromiumPath;
}

export async function launchChromiumBrowser(): Promise<Browser> {
	return chromium.launch({
		executablePath: resolveHeadlessShellPath(),
		args: CHROMIUM_LAUNCH_ARGS,
	});
}

export class BrowserPool implements BrowserPoolContract {
	readonly engine: BrowserEngine;
	private readonly options: ResolvedBrowserPoolOptions;
	private processes: BrowserProcessHandle[] = [];
	private warmSpawnPromise: Promise<BrowserProcessHandle> | null = null;
	private totalSessionsServed = 0;
	private closed = false;

	constructor(options: BrowserPoolOptions = {}) {
		this.options = resolveOptions(options);
		this.engine = this.options.engine;
	}

	static async create(options: BrowserPoolOptions = {}): Promise<BrowserPool> {
		const pool = new BrowserPool(options);
		const launches: Array<Promise<BrowserProcessHandle>> = [];
		for (let i = 0; i < pool.options.minProcesses; i++) launches.push(pool.launchProcess());
		const settled = await Promise.allSettled(launches);
		const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
		if (failures.length > 0) {
			await Promise.allSettled(
				settled
					.filter(
						(result): result is PromiseFulfilledResult<BrowserProcessHandle> => result.status === "fulfilled",
					)
					.map((result) => result.value.browser.close()),
			);
			throw failures[0].reason;
		}
		pool.processes = settled.map((result) => (result as PromiseFulfilledResult<BrowserProcessHandle>).value);
		return pool;
	}

	async acquireProcess(): Promise<BrowserProcessHandle> {
		if (this.closed) throw new Error(`${this.engine} BrowserPool is closed`);

		let chosen = this.processes.find((process) => this.hasCapacity(process));
		if (!chosen) {
			if (this.processes.length >= this.options.maxProcesses) {
				chosen = this.processes.find((process) => this.hasCapacity(process));
				if (!chosen) {
					throw new Error(
						`${this.engine} BrowserPool hard cap reached: all ${this.options.maxProcesses} processes ` +
							`are at CONTEXT_CAP (${this.options.contextCap}) or recycling`,
					);
				}
			} else {
				const process = await (this.warmSpawnPromise ?? this.launchProcess());
				this.warmSpawnPromise = null;
				if (!this.processes.includes(process)) this.processes.push(process);
				chosen = process;
			}
		}

		chosen.totalContexts++;
		chosen.activeContexts++;
		this.totalSessionsServed++;

		if (this.needsRecycle(chosen) && !this.warmSpawnPromise && this.processes.length < this.options.maxProcesses) {
			this.warmSpawnPromise = this.launchProcess().then((process) => {
				this.processes.push(process);
				return process;
			});
		}

		return chosen;
	}

	async releaseProcess(handle: BrowserProcessHandle): Promise<void> {
		handle.activeContexts = Math.max(0, handle.activeContexts - 1);
		if (this.needsRecycle(handle) && handle.activeContexts === 0) {
			this.processes = this.processes.filter((process) => process !== handle);
			await handle.browser.close().catch(() => {});
			await this.ensureMinimum();
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.allSettled(this.processes.map((process) => process.browser.close()));
		this.processes = [];
		if (this.warmSpawnPromise) {
			const process = await this.warmSpawnPromise.catch(() => null);
			if (process) await process.browser.close().catch(() => {});
			this.warmSpawnPromise = null;
		}
	}

	stats() {
		return {
			engine: this.engine,
			processes: this.processes.length,
			activeSessions: this.processes.reduce((sum, process) => sum + process.activeContexts, 0),
			totalSessionsServed: this.totalSessionsServed,
		};
	}

	/** Test-only process injection. */
	_injectProcess(handle: BrowserProcessHandle): void {
		this.processes.push(handle);
	}

	/** Test-only process reset. */
	_clearProcesses(): void {
		this.processes = [];
	}

	private async launchProcess(): Promise<BrowserProcessHandle> {
		const browser = await this.options.launchBrowser();
		return {
			browser,
			engine: this.engine,
			browserVersion: browser.version(),
			id: nextProcessId++,
			launchedAt: Date.now(),
			totalContexts: 0,
			activeContexts: 0,
		};
	}

	private needsRecycle(process: BrowserProcessHandle): boolean {
		return (
			Date.now() - process.launchedAt >= this.options.recycleAfterMs ||
			process.totalContexts >= this.options.recycleAfterSessions
		);
	}

	private hasCapacity(process: BrowserProcessHandle): boolean {
		return process.activeContexts < this.options.contextCap && !this.needsRecycle(process);
	}

	private async ensureMinimum(): Promise<void> {
		while (this.processes.length < this.options.minProcesses && !this.closed) {
			try {
				this.processes.push(await this.launchProcess());
			} catch {
				break;
			}
		}
	}
}

function resolveOptions(input: BrowserPoolOptions): ResolvedBrowserPoolOptions {
	const engine = input.engine ?? "chromium";
	if (engine !== "chromium" && !input.launchBrowser) {
		throw new Error(`Browser engine '${engine}' has no launcher in this build`);
	}
	const defaults = CHROMIUM_DEFAULTS;
	const resolved = {
		engine,
		launchBrowser: input.launchBrowser ?? launchChromiumBrowser,
		minProcesses: positiveInteger(input.minProcesses, defaults.minProcesses),
		maxProcesses: positiveInteger(input.maxProcesses, defaults.maxProcesses),
		contextCap: positiveInteger(input.contextCap, defaults.contextCap),
		recycleAfterMs: positiveInteger(input.recycleAfterMs, defaults.recycleAfterMs),
		recycleAfterSessions: positiveInteger(input.recycleAfterSessions, defaults.recycleAfterSessions),
	};
	if (resolved.maxProcesses < resolved.minProcesses) {
		throw new Error(`${engine} BrowserPool maxProcesses must be greater than or equal to minProcesses`);
	}
	return resolved;
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return Number.isInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}
