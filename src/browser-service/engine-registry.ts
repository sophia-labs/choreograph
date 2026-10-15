import { BrowserPool } from "./pool.js";
import {
	type BrowserEngine,
	type BrowserPoolContract,
	type PoolStats,
	RETIRED_BROWSER_ENGINE_REASON,
} from "./types.js";

export interface EngineHealth {
	readonly available: boolean;
	readonly experimental: boolean;
	readonly error?: string;
	readonly stats?: PoolStats;
}

export class BrowserEngineUnavailableError extends Error {
	readonly status = 503;
	constructor(
		readonly engine: BrowserEngine,
		message: string,
	) {
		super(message);
		this.name = "BrowserEngineUnavailableError";
	}
}

/** Owns independently healthy browser pools behind one session API. */
export class BrowserEngineRegistry {
	private readonly pools = new Map<BrowserEngine, BrowserPoolContract>();
	private readonly unavailable = new Map<BrowserEngine, string>();

	static async createFromEnvironment(): Promise<BrowserEngineRegistry> {
		const registry = new BrowserEngineRegistry();
		// A retired engine is never started. A host whose environment still names it (an older compose file)
		// gets Chromium alone, with the retired engine reported unavailable instead of a failed boot.
		registry.markUnavailable("camoufox", RETIRED_BROWSER_ENGINE_REASON);
		const requested = parseBrowserEngines(process.env.BROWSER_ENGINES);
		for (const engine of requested) {
			if (engine === "camoufox") {
				console.warn(`[browser-service] BROWSER_ENGINES names camoufox: ${RETIRED_BROWSER_ENGINE_REASON}`);
				continue;
			}
			try {
				const pool = await BrowserPool.create({
					minProcesses: integerEnv("CHROMIUM_MIN_PROCESSES"),
					maxProcesses: integerEnv("CHROMIUM_MAX_PROCESSES"),
					contextCap: integerEnv("CHROMIUM_CONTEXT_CAP"),
				});
				registry.register(pool);
			} catch (error) {
				registry.markUnavailable(engine, error instanceof Error ? error.message : String(error));
			}
		}
		if (registry.pools.size === 0) {
			throw new Error(`No browser engine started: ${JSON.stringify(Object.fromEntries(registry.unavailable))}`);
		}
		return registry;
	}

	register(pool: BrowserPoolContract): void {
		if (this.pools.has(pool.engine)) throw new Error(`Browser engine already registered: ${pool.engine}`);
		this.pools.set(pool.engine, pool);
		this.unavailable.delete(pool.engine);
	}

	markUnavailable(engine: BrowserEngine, reason: string): void {
		this.unavailable.set(engine, reason);
	}

	require(engine: BrowserEngine): BrowserPoolContract {
		const pool = this.pools.get(engine);
		if (pool) return pool;
		throw new BrowserEngineUnavailableError(
			engine,
			`Browser engine '${engine}' is unavailable: ${this.unavailable.get(engine) ?? "not configured"}`,
		);
	}

	stats() {
		const engines = Object.fromEntries(
			(["chromium", "camoufox"] as const).map((engine) => {
				const pool = this.pools.get(engine);
				const error = this.unavailable.get(engine);
				return [
					engine,
					pool
						? { available: true, experimental: engine === "camoufox", stats: pool.stats() }
						: { available: false, experimental: engine === "camoufox", ...(error ? { error } : {}) },
				] satisfies [BrowserEngine, EngineHealth];
			}),
		) as Record<BrowserEngine, EngineHealth>;
		const availableStats = [...this.pools.values()].map((pool) => pool.stats());
		return {
			processes: availableStats.reduce((sum, item) => sum + item.processes, 0),
			activeSessions: availableStats.reduce((sum, item) => sum + item.activeSessions, 0),
			totalSessionsServed: availableStats.reduce((sum, item) => sum + item.totalSessionsServed, 0),
			engines,
		};
	}

	async close(): Promise<void> {
		await Promise.allSettled([...this.pools.values()].map((pool) => pool.close()));
		this.pools.clear();
	}
}

export function parseBrowserEngines(value: string | undefined): readonly BrowserEngine[] {
	const candidates = (value ?? "chromium")
		.split(",")
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean);
	const engines = [...new Set(candidates)];
	for (const engine of engines) {
		if (engine !== "chromium" && engine !== "camoufox") throw new Error(`Unsupported browser engine: ${engine}`);
	}
	return engines as BrowserEngine[];
}

function integerEnv(name: string): number | undefined {
	const value = process.env[name]?.trim();
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
	return parsed;
}
