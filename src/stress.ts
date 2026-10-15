/**
 * Stress test runner for sandbox-validation.
 *
 * Runs OUTSIDE Docker, hitting the HTTP API at localhost:3456.
 * Parametrizable scenarios exercise concurrency, memory pressure,
 * timeout storms, rapid churn, and chaos injection.
 *
 * The API returns HTTP 202 with state="queued". The runner polls
 * GET /api/sandboxes/:id to track state transitions.
 *
 * Usage:
 *   tsx spike/sandbox-validation/stress.ts <scenario> [--base-url URL]
 *   tsx spike/sandbox-validation/stress.ts --list
 *   tsx spike/sandbox-validation/stress.ts --json '{ ... }'
 */

// ─── Types ──────────────────────────────────────────────────────────────

interface Scenario {
	name: string;
	description: string;
	/** Max concurrent sandbox spawns in flight */
	concurrency: number;
	/** Total sandboxes to spawn */
	total: number;
	/** Spread spawns over this many ms (0 = all at once) */
	rampUpMs: number;
	template: string;
	workerConfig: Record<string, unknown>;
	/** Cgroup resource limits */
	resources?: {
		memory_max_bytes?: number;
		cpu_quota_us?: number;
		pids_max?: number;
	};
	/** Sandbox API timeout_ms (wall-clock kill) */
	timeoutMs?: number;
	/** Kill each sandbox after this many ms (undefined = let it exit naturally) */
	killAfterMs?: number;
	/** Chaos injection */
	chaos?: {
		/** Fraction of sandboxes to kill randomly (0-1) */
		killRandomFraction?: number;
		/** Sudden burst: spawn this many additional sandboxes at offsetMs */
		burst?: { count: number; atMs: number };
	};
}

interface SpawnResult {
	sandboxId: string | null;
	httpStatus: number;
	/** HTTP round-trip latency (enqueue time) */
	latencyMs: number;
	state: string | null;
	error: string | null;
	/** Time from enqueue to reaching "running" state (ms), null if never reached */
	timeToRunningMs: number | null;
}

interface KillResult {
	sandboxId: string;
	httpStatus: number;
	latencyMs: number;
	error: string | null;
}

// ─── Built-in Scenarios ─────────────────────────────────────────────────

const SCENARIOS: Record<string, Scenario> = {
	"spawn-flood": {
		name: "spawn-flood",
		description:
			"100 fast-exiting sandboxes at concurrency 20. " +
			"Tests cgroup assignment races, SQLite write contention, spawn throughput.",
		concurrency: 20,
		total: 100,
		rampUpMs: 0,
		template: "bare",
		workerConfig: { max_iterations: 3, sleep_ms: 50 },
	},

	"memory-pressure": {
		name: "memory-pressure",
		description:
			"20 sandboxes each allocating 8MB/iteration with 32MB cgroup limit. " +
			"Tests OOM detection, memory_peak_bytes accuracy, cgroup enforcement.",
		concurrency: 5,
		total: 20,
		rampUpMs: 2_000,
		template: "bare",
		workerConfig: { max_iterations: 10, sleep_ms: 200, memory_alloc_mb: 8 },
		resources: { memory_max_bytes: 32 * 1024 * 1024 },
	},

	"cpu-burn": {
		name: "cpu-burn",
		description:
			"15 sandboxes with heavy fibonacci computation and CPU quota. " +
			"Tests CPU accounting, cpu_usage_seconds histogram, throttling behavior.",
		concurrency: 5,
		total: 15,
		rampUpMs: 1_000,
		template: "bare",
		workerConfig: { max_iterations: 20, sleep_ms: 100, fibonacci_n: 40 },
		resources: { cpu_quota_us: 50_000 },
	},

	"long-saturation": {
		name: "long-saturation",
		description:
			"30 long-lived sandboxes alive simultaneously. " +
			"Tests active gauge accuracy, process table pressure, steady-state resource use.",
		concurrency: 10,
		total: 30,
		rampUpMs: 5_000,
		template: "bare",
		workerConfig: { max_iterations: 120, sleep_ms: 1000 },
	},

	"timeout-storm": {
		name: "timeout-storm",
		description:
			"50 sandboxes with 3s timeout but 60s worker lifetime. " +
			"All hit timeout → SIGTERM/SIGKILL escalation, cleanup ordering.",
		concurrency: 10,
		total: 50,
		rampUpMs: 3_000,
		template: "bare",
		workerConfig: { max_iterations: 600, sleep_ms: 100 },
		timeoutMs: 3_000,
	},

	"rapid-churn": {
		name: "rapid-churn",
		description:
			"100 sandboxes, each killed 500ms after reaching running. " +
			"Tests state machine edge cases, cgroup cleanup races, kill-during-spawn.",
		concurrency: 10,
		total: 100,
		rampUpMs: 0,
		template: "bare",
		workerConfig: { max_iterations: 600, sleep_ms: 100 },
		killAfterMs: 500,
	},

	"oom-cascade": {
		name: "oom-cascade",
		description:
			"30 sandboxes that deterministically OOM (allocate 64MB into 16MB limit). " +
			"Tests OOM detection reliability, error_detail population, exit metric labels.",
		concurrency: 10,
		total: 30,
		rampUpMs: 1_000,
		template: "bare",
		workerConfig: { max_iterations: 20, sleep_ms: 50, memory_alloc_mb: 64 },
		resources: { memory_max_bytes: 16 * 1024 * 1024 },
	},

	chaos: {
		name: "chaos",
		description:
			"Steady spawn rate with random kills and a burst at 10s. " +
			"Tests mixed lifecycle, concurrent kill+exit, metric consistency.",
		concurrency: 8,
		total: 40,
		rampUpMs: 15_000,
		template: "bare",
		workerConfig: { max_iterations: 60, sleep_ms: 500 },
		chaos: {
			killRandomFraction: 0.3,
			burst: { count: 20, atMs: 10_000 },
		},
	},

	"pids-limit": {
		name: "pids-limit",
		description: "10 sandboxes with pids.max=5. Worker can't fork beyond limit. " + "Tests pids cgroup enforcement.",
		concurrency: 5,
		total: 10,
		rampUpMs: 1_000,
		template: "bare",
		workerConfig: { max_iterations: 10, sleep_ms: 200 },
		resources: { pids_max: 5 },
	},
};

// ─── HTTP Client ────────────────────────────────────────────────────────

let BASE_URL = "http://localhost:3456";

async function spawnSandbox(scenario: Scenario): Promise<SpawnResult> {
	const start = performance.now();
	try {
		const body: Record<string, unknown> = {
			template: scenario.template,
			worker_config: scenario.workerConfig,
		};
		if (scenario.resources) body.resources = scenario.resources;
		if (scenario.timeoutMs) body.timeout_ms = scenario.timeoutMs;

		let res: Response;
		let retries = 0;
		while (true) {
			res = await fetch(`${BASE_URL}/api/sandboxes`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (res.status === 503 && retries < 5) {
				const retryAfter = parseInt(res.headers.get("Retry-After") ?? "2", 10);
				await sleep(retryAfter * 1000);
				retries++;
				continue;
			}
			break;
		}

		const data = (await res.json()) as Record<string, unknown>;
		const sandbox = data.sandbox as Record<string, unknown> | undefined;
		return {
			sandboxId: (sandbox?.sandbox_id as string) ?? null,
			httpStatus: res.status,
			latencyMs: performance.now() - start,
			state: (sandbox?.state as string) ?? null,
			error: res.status >= 400 ? ((data.error as string) ?? `HTTP ${res.status}`) : null,
			timeToRunningMs: null,
		};
	} catch (err) {
		return {
			sandboxId: null,
			httpStatus: 0,
			latencyMs: performance.now() - start,
			state: null,
			error: err instanceof Error ? err.message : String(err),
			timeToRunningMs: null,
		};
	}
}

async function killSandbox(sandboxId: string): Promise<KillResult> {
	const start = performance.now();
	try {
		const res = await fetch(`${BASE_URL}/api/sandboxes/${sandboxId}/kill`, {
			method: "POST",
		});
		const data = (await res.json()) as Record<string, unknown>;
		return {
			sandboxId,
			httpStatus: res.status,
			latencyMs: performance.now() - start,
			error: res.status >= 400 ? ((data.error as string) ?? null) : null,
		};
	} catch (err) {
		return {
			sandboxId,
			httpStatus: 0,
			latencyMs: performance.now() - start,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

async function getSandbox(sandboxId: string): Promise<Record<string, unknown> | null> {
	try {
		const res = await fetch(`${BASE_URL}/api/sandboxes/${sandboxId}`);
		if (!res.ok) return null;
		const data = (await res.json()) as Record<string, unknown>;
		return (data.sandbox as Record<string, unknown>) ?? null;
	} catch {
		return null;
	}
}

const TERMINAL_STATES = new Set(["done", "truncated", "error", "timeout", "killed"]);

/** Poll until sandbox reaches running or terminal state. Returns time to running (ms) or null. */
async function waitForRunning(sandboxId: string, enqueueTime: number, timeoutMs = 30_000): Promise<number | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const sandbox = await getSandbox(sandboxId);
		if (!sandbox) return null;
		if (sandbox.state === "running") return performance.now() - enqueueTime;
		if (TERMINAL_STATES.has(sandbox.state as string)) return null; // exited before running
		await sleep(20);
	}
	return null;
}

// ─── Concurrency Control ────────────────────────────────────────────────

class Semaphore {
	private waiting: Array<() => void> = [];
	private current = 0;

	constructor(private readonly max: number) {}

	async acquire(): Promise<void> {
		if (this.current < this.max) {
			this.current++;
			return;
		}
		return new Promise<void>((resolve) => {
			this.waiting.push(() => {
				this.current++;
				resolve();
			});
		});
	}

	release(): void {
		this.current--;
		const next = this.waiting.shift();
		if (next) next();
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Stats ──────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, idx)];
}

function printStats(
	label: string,
	results: Array<{ latencyMs: number; httpStatus: number; error: string | null }>,
): void {
	if (results.length === 0) return;

	const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
	const successes = results.filter((r) => r.httpStatus >= 200 && r.httpStatus < 300).length;
	const errors = results.filter((r) => r.httpStatus === 0 || r.httpStatus >= 400);
	const statusCounts = new Map<number, number>();
	for (const r of results) {
		statusCounts.set(r.httpStatus, (statusCounts.get(r.httpStatus) ?? 0) + 1);
	}

	console.log(`\n── ${label} ──`);
	console.log(`  total:     ${results.length}`);
	console.log(`  success:   ${successes}  errors: ${errors.length}`);
	console.log(`  status:    ${[...statusCounts.entries()].map(([k, v]) => `${k}×${v}`).join("  ")}`);
	console.log(
		`  latency:   p50=${percentile(latencies, 50).toFixed(0)}ms  p95=${percentile(latencies, 95).toFixed(0)}ms  p99=${percentile(latencies, 99).toFixed(0)}ms  max=${percentile(latencies, 100).toFixed(0)}ms`,
	);

	// Show unique errors
	const errorMsgs = new Map<string, number>();
	for (const e of errors) {
		const msg = e.error ?? `HTTP ${e.httpStatus}`;
		errorMsgs.set(msg, (errorMsgs.get(msg) ?? 0) + 1);
	}
	if (errorMsgs.size > 0) {
		console.log(`  errors:`);
		for (const [msg, count] of errorMsgs) {
			console.log(`    ${count}× ${msg.slice(0, 120)}`);
		}
	}
}

function printTerminalStates(spawnResults: SpawnResult[], sandboxStates: Map<string, string>): void {
	const states = new Map<string, number>();
	for (const state of sandboxStates.values()) {
		states.set(state, (states.get(state) ?? 0) + 1);
	}
	// Include spawn failures
	const spawnFailures = spawnResults.filter((r) => r.sandboxId === null).length;
	if (spawnFailures > 0) {
		states.set("spawn_failed", spawnFailures);
	}

	console.log(`\n── Terminal States ──`);
	for (const [state, count] of [...states.entries()].sort((a, b) => b[1] - a[1])) {
		const bar = "█".repeat(Math.min(count, 60));
		console.log(`  ${state.padEnd(14)} ${String(count).padStart(4)}  ${bar}`);
	}
}

// ─── Runner ─────────────────────────────────────────────────────────────

async function runScenario(scenario: Scenario): Promise<void> {
	console.log(`\n╔══════════════════════════════════════════════════════════╗`);
	console.log(`║  Stress: ${scenario.name.padEnd(47)} ║`);
	console.log(`╚══════════════════════════════════════════════════════════╝`);
	console.log(`  ${scenario.description}`);
	console.log(
		`  concurrency=${scenario.concurrency}  total=${scenario.total}  rampUp=${scenario.rampUpMs}ms  template=${scenario.template}`,
	);
	if (scenario.resources) {
		const r = scenario.resources;
		const parts: string[] = [];
		if (r.memory_max_bytes) parts.push(`mem=${(r.memory_max_bytes / 1024 / 1024).toFixed(0)}MB`);
		if (r.cpu_quota_us) parts.push(`cpu=${r.cpu_quota_us}us`);
		if (r.pids_max) parts.push(`pids=${r.pids_max}`);
		console.log(`  resources: ${parts.join("  ")}`);
	}
	if (scenario.timeoutMs) console.log(`  timeout: ${scenario.timeoutMs}ms`);
	if (scenario.killAfterMs != null) console.log(`  killAfter: ${scenario.killAfterMs}ms`);
	if (scenario.chaos) console.log(`  chaos: ${JSON.stringify(scenario.chaos)}`);
	console.log();

	const sem = new Semaphore(scenario.concurrency);
	const spawnResults: SpawnResult[] = [];
	const killResults: KillResult[] = [];
	const activeSandboxIds: string[] = [];
	const startTime = performance.now();

	// Progress tracker
	let enqueued = 0;
	let running = 0;
	let done = 0;
	const progressInterval = setInterval(() => {
		const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
		const errors = spawnResults.filter((r) => r.error).length;
		process.stdout.write(
			`\r  [${elapsed}s] enqueued=${enqueued}/${scenario.total}  running=${running}  done=${done}  errors=${errors}  kills=${killResults.length}    `,
		);
	}, 500);

	// ── Phase 1: Enqueue all sandboxes (fast HTTP POSTs) ──────────────
	// The semaphore only gates the HTTP POST rate, NOT lifecycle tracking.

	async function enqueueOne(): Promise<void> {
		await sem.acquire();
		try {
			const result = await spawnSandbox(scenario);
			spawnResults.push(result);
			enqueued++;
			if (result.sandboxId) {
				activeSandboxIds.push(result.sandboxId);
			}
		} finally {
			sem.release();
		}
	}

	const delayPerSpawn = scenario.total > 1 && scenario.rampUpMs > 0 ? scenario.rampUpMs / (scenario.total - 1) : 0;

	const enqueuePromises: Promise<void>[] = [];
	for (let i = 0; i < scenario.total; i++) {
		if (i > 0 && delayPerSpawn > 0) {
			await sleep(delayPerSpawn);
		}
		enqueuePromises.push(enqueueOne());
	}

	// Chaos: burst spawn
	if (scenario.chaos?.burst) {
		const burst = scenario.chaos.burst;
		setTimeout(() => {
			console.log(`\n  [chaos] burst: spawning ${burst.count} sandboxes`);
			for (let i = 0; i < burst.count; i++) {
				enqueuePromises.push(enqueueOne());
			}
		}, burst.atMs);
	}

	// Wait for all enqueues to complete
	await Promise.all(enqueuePromises);

	const enqueueElapsed = (performance.now() - startTime) / 1000;
	console.log(
		`\n  enqueue complete: ${enqueued} in ${enqueueElapsed.toFixed(2)}s (${(enqueued / enqueueElapsed).toFixed(0)}/s)`,
	);

	// ── Phase 2: Track lifecycle (poll for running + terminal) ─────────

	const enqueueTimeById = new Map<string, number>();
	for (const r of spawnResults) {
		if (r.sandboxId) enqueueTimeById.set(r.sandboxId, startTime + r.latencyMs - r.latencyMs); // approximation
	}
	// Use a single timestamp for all — they were enqueued nearly simultaneously
	const batchEnqueueTime = performance.now();

	// Chaos: random kills
	let chaosKillInterval: ReturnType<typeof setInterval> | undefined;
	if (scenario.chaos?.killRandomFraction) {
		const fraction = scenario.chaos.killRandomFraction;
		chaosKillInterval = setInterval(async () => {
			if (activeSandboxIds.length === 0) return;
			const numToKill = Math.max(1, Math.floor(activeSandboxIds.length * fraction * 0.2));
			for (let i = 0; i < numToKill; i++) {
				if (activeSandboxIds.length === 0) break;
				const idx = Math.floor(Math.random() * activeSandboxIds.length);
				const id = activeSandboxIds.splice(idx, 1)[0];
				const kr = await killSandbox(id);
				killResults.push(kr);
			}
		}, 2_000);
	}

	// Track which sandboxes have reached running (for killAfterMs and TTR tracking)
	const reachedRunning = new Set<string>();
	const killScheduled = new Set<string>();

	// Poll loop: check sandbox states until all are terminal
	const maxWaitMs = Math.max(
		30_000,
		((scenario.workerConfig.max_iterations as number) ?? 60) * ((scenario.workerConfig.sleep_ms as number) ?? 1000) +
			15_000,
	);
	const pollDeadline = performance.now() + maxWaitMs;

	while (activeSandboxIds.length > 0 && performance.now() < pollDeadline) {
		// Poll a batch of active sandboxes
		const batch = activeSandboxIds.slice(0, 20);
		const checks = await Promise.all(batch.map((id) => getSandbox(id)));

		for (let i = 0; i < batch.length; i++) {
			const id = batch[i];
			const sandbox = checks[i];
			if (!sandbox) continue;
			const state = sandbox.state as string;

			// Track time-to-running
			if (state === "running" && !reachedRunning.has(id)) {
				reachedRunning.add(id);
				running++;
				const result = spawnResults.find((r) => r.sandboxId === id);
				if (result) {
					result.timeToRunningMs = performance.now() - batchEnqueueTime;
				}

				// Schedule kill if configured
				if (scenario.killAfterMs != null && !killScheduled.has(id)) {
					killScheduled.add(id);
					setTimeout(async () => {
						const kr = await killSandbox(id);
						killResults.push(kr);
					}, scenario.killAfterMs);
				}
			}

			// Remove from active if terminal
			if (TERMINAL_STATES.has(state)) {
				const idx = activeSandboxIds.indexOf(id);
				if (idx !== -1) {
					activeSandboxIds.splice(idx, 1);
					done++;
					if (reachedRunning.has(id)) running--;
				}
			}
		}

		await sleep(100);
	}

	if (chaosKillInterval) clearInterval(chaosKillInterval);
	clearInterval(progressInterval);

	const totalElapsed = (performance.now() - startTime) / 1000;
	console.log(`\r  [${totalElapsed.toFixed(1)}s] complete.${" ".repeat(60)}`);

	// Collect terminal states
	const sandboxStates = new Map<string, string>();
	for (const r of spawnResults) {
		if (r.sandboxId) {
			const sandbox = await getSandbox(r.sandboxId);
			sandboxStates.set(r.sandboxId, (sandbox?.state as string) ?? "unknown");
		}
	}

	// Print results
	console.log(`\n${"═".repeat(60)}`);
	console.log(
		`  Scenario: ${scenario.name}  |  Elapsed: ${totalElapsed.toFixed(1)}s  |  Throughput: ${(spawnResults.length / totalElapsed).toFixed(1)} spawns/s`,
	);
	console.log(`${"═".repeat(60)}`);

	// HTTP enqueue stats
	printStats("Enqueue (HTTP)", spawnResults);

	// Time-to-running stats
	const ttrValues = spawnResults.filter((r) => r.timeToRunningMs != null).map((r) => r.timeToRunningMs!);
	if (ttrValues.length > 0) {
		const sorted = ttrValues.sort((a, b) => a - b);
		const neverReached = spawnResults.filter((r) => r.sandboxId && r.timeToRunningMs == null).length;
		console.log(`\n── Time to Running ──`);
		console.log(`  reached:   ${ttrValues.length}  never: ${neverReached}`);
		console.log(
			`  latency:   p50=${percentile(sorted, 50).toFixed(0)}ms  p95=${percentile(sorted, 95).toFixed(0)}ms  p99=${percentile(sorted, 99).toFixed(0)}ms  max=${percentile(sorted, 100).toFixed(0)}ms`,
		);
	}

	if (killResults.length > 0) {
		printStats("Kills", killResults);
	}
	printTerminalStates(spawnResults, sandboxStates);
}

// ─── CLI ────────────────────────────────────────────────────────────────

function printUsage(): void {
	console.log(`Usage:`);
	console.log(`  tsx stress.ts <scenario>           Run a built-in scenario`);
	console.log(`  tsx stress.ts --list               List available scenarios`);
	console.log(`  tsx stress.ts --json '{...}'        Run a custom scenario from JSON`);
	console.log(`  tsx stress.ts --all                 Run all scenarios sequentially`);
	console.log();
	console.log(`Options:`);
	console.log(`  --base-url URL   Override API base (default: http://localhost:3456)`);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	// Parse --base-url
	const baseUrlIdx = args.indexOf("--base-url");
	if (baseUrlIdx !== -1 && args[baseUrlIdx + 1]) {
		BASE_URL = args[baseUrlIdx + 1];
		args.splice(baseUrlIdx, 2);
	}

	if (args.length === 0 || args[0] === "--help") {
		printUsage();
		console.log(`\nScenarios:`);
		for (const [name, s] of Object.entries(SCENARIOS)) {
			console.log(`  ${name.padEnd(20)} ${s.description.slice(0, 70)}`);
		}
		process.exit(0);
	}

	if (args[0] === "--list") {
		console.log(`\nAvailable scenarios:\n`);
		for (const [name, s] of Object.entries(SCENARIOS)) {
			console.log(`  ${name}`);
			console.log(`    ${s.description}`);
			console.log(`    concurrency=${s.concurrency}  total=${s.total}  rampUp=${s.rampUpMs}ms`);
			console.log();
		}
		process.exit(0);
	}

	// Verify API is reachable
	try {
		const res = await fetch(`${BASE_URL}/health`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = (await res.json()) as Record<string, unknown>;
		console.log(`API health: ${JSON.stringify(data)}`);
	} catch (err) {
		console.error(`Cannot reach API at ${BASE_URL}: ${err instanceof Error ? err.message : err}`);
		console.error(`Is docker compose up?`);
		process.exit(1);
	}

	if (args[0] === "--json") {
		const scenario = JSON.parse(args[1]) as Scenario;
		await runScenario(scenario);
	} else if (args[0] === "--all") {
		for (const scenario of Object.values(SCENARIOS)) {
			await runScenario(scenario);
			console.log(`\n  Pausing 5s between scenarios...\n`);
			await sleep(5_000);
		}
	} else {
		for (const name of args) {
			const scenario = SCENARIOS[name];
			if (!scenario) {
				console.error(`Unknown scenario: ${name}`);
				console.error(`Available: ${Object.keys(SCENARIOS).join(", ")}`);
				process.exit(1);
			}
			await runScenario(scenario);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
