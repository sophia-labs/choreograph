/**
 * A sitting never hangs its run, and a run can be stopped (2026-10-21, "Sleepers, as Dream reports": a clerk read the
 * same block two dozen times, reached its turn cap and went silent, and the run sat in `running` with the Censor never
 * started; nothing could end it).
 *
 * Under a real local-native orchestrator: a real server, real pi body processes, the host's own scripted models
 * (`mock:*`, served by the host's inference proxy, so no network and no key). Nothing is stubbed: the workflow goes in
 * over HTTP and the run comes back from the journal.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BODY_ENTRY = join(ROOT, "packages/agent-body/src/main.ts");

async function freePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => resolvePort(typeof address === "object" && address ? address.port : 0));
		});
	});
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const SCHEMA = '{ type: "object", required: ["items"], properties: { items: { type: "array" } } }';
const EXECUTION =
	'{ schema: "choreograph.execution-binding.v1", controller: "composite", modelUse: "agentic", isolation: "sandbox", effects: "capability-bound", reproducibility: "nondeterministic", capabilities: ["choreograph.agent"], authority: { minimumRole: "editor", dangerousOps: false }, mayInvokeChildren: false }';

/** One phase: a sitting that misbehaves, then a sitting after it, so the run shows whether the phase went on. */
function misbehavingSource(name: string, model: string, extra = ""): string {
	return `export const meta = {
	name: ${JSON.stringify(name)},
	description: "A sitting that misbehaves, then one that answers.",
	phases: [{ title: "work" }],
	execution: ${EXECUTION},
	inputs: { type: "object", additionalProperties: false, properties: {} },
}
phase("work")
const first = await agent("Read the block, then submit.", { label: "the Clerk", model: ${JSON.stringify(model)}, provider: "openrouter", toolMode: "none", schema: ${SCHEMA}${extra} })
const next = await agent("Say hello, then finish.", { label: "the Censor", model: "mock:done", provider: "openrouter", toolMode: "none", maxTurns: 4 })
return { first: { state: first.state, output: first.output, stopped: first.stopped ?? null }, next: { state: next.state } }
`;
}

/** Three clerks that never answer, then a phase that must never start once the run is stopped. */
function stalledSource(name: string): string {
	return `export const meta = {
	name: ${JSON.stringify(name)},
	description: "Three stalled sittings, then a phase after them.",
	phases: [{ title: "catalogue" }, { title: "censor" }],
	execution: ${EXECUTION},
	inputs: { type: "object", additionalProperties: false, properties: {} },
}
phase("catalogue")
await parallel([1, 2, 3].map((n) => () => agent("Catalogue item " + n + ".", { label: "the Clerk #" + n, model: "mock:stall", provider: "openrouter", toolMode: "none", schema: ${SCHEMA} })))
phase("censor")
await agent("Check them.", { label: "the Censor", model: "mock:done", provider: "openrouter", toolMode: "none", maxTurns: 4 })
return {}
`;
}

interface RunDetail {
	header: { status: string; ended_at: number | null };
	events: Array<{ type: string; label?: string | null; ts: number; payload?: Record<string, unknown> }>;
}

describe("a sitting stops itself, and a run can be stopped", { concurrency: false }, () => {
	let child: ChildProcess | undefined;
	let dataDir = "";
	let base = "";
	let log = "";
	const secret = `test-secret-${Math.random().toString(36).slice(2)}`;
	const headers = { "content-type": "application/json", "x-internal-service": secret, "x-user-id": "owner" };

	before(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "choreograph-autostop-"));
		const port = await freePort();
		base = `http://127.0.0.1:${port}`;
		child = spawn(process.execPath, ["--import", "tsx", "src/orchestrator.ts"], {
			cwd: ROOT,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				PORT: String(port),
				DATA_DIR: dataDir,
				CHOREOGRAPH_SANDBOX_MODE: "local-native",
				CHOREOGRAPH_BIND_HOST: "127.0.0.1",
				OTEL_SDK_DISABLED: "true",
				BILLING_FEE_BPS: "0",
				MNEMOSYNE_INTERNAL_SERVICE_SECRET: secret,
				WORKFLOW_DYNAMIC_SOURCE: "1",
				CHOREOGRAPH_LOCAL_AGENT_DEFAULTS: "1",
				SOPHIA_AGENT_RUNTIME_ENTRYPOINT: BODY_ENTRY,
			},
		});
		child.stdout?.on("data", (chunk) => {
			log += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			log += chunk;
		});
		for (let attempt = 0; ; attempt += 1) {
			try {
				if ((await fetch(`${base}/health`)).ok) break;
			} catch {
				// not listening yet
			}
			if (attempt > 240) throw new Error(`the orchestrator never answered /health:\n${log.slice(-4000)}`);
			await sleep(250);
		}
	});

	after(async () => {
		child?.kill("SIGTERM");
		await sleep(500);
		rmSync(dataDir, { recursive: true, force: true });
	});

	async function start(name: string, source: string): Promise<string> {
		const response = await fetch(`${base}/api/workflows/run`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				workflow_name: name,
				workflow_source: source,
				workflow_args: {},
				graph_id: "autostop-e2e",
				graph_owner: "user:owner",
			}),
		});
		const started = (await response.json()) as { runId?: string };
		assert.equal(response.status, 202, JSON.stringify(started));
		assert.ok(started.runId);
		return started.runId;
	}

	async function detail(runId: string): Promise<RunDetail> {
		return (await (await fetch(`${base}/api/workflows/runs/${runId}`, { headers })).json()) as RunDetail;
	}

	async function finished(runId: string, waitMs = 45_000): Promise<RunDetail> {
		const deadline = Date.now() + waitMs;
		while (Date.now() < deadline) {
			const run = await detail(runId);
			if (["completed", "failed", "stopped"].includes(run.header.status)) return run;
			await sleep(250);
		}
		throw new Error(`run ${runId} did not finish in ${waitMs}ms:\n${log.slice(-4000)}`);
	}

	const outcomeOf = (run: RunDetail, label: string) =>
		run.events.find((event) => (event.type === "error" || event.type === "node_done") && event.label === label);
	const returned = (run: RunDetail) =>
		run.events.find((event) => event.type === "run_done")?.payload as Record<string, unknown> | undefined;

	it("ends a sitting at its turn cap with its reason, and the phase goes on", { timeout: 90_000 }, async () => {
		const run = await finished(
			await start("autostop-turns", misbehavingSource("autostop-turns", "mock:wander", ", maxTurns: 3")),
		);
		const clerk = outcomeOf(run, "the Clerk");
		assert.equal(clerk?.type, "error", log.slice(-3000));
		assert.equal(clerk?.payload?.output, "Stopped after 3 turns without an answer.");
		assert.equal(clerk?.payload?.turns, 3);
		assert.equal(outcomeOf(run, "the Censor")?.type, "node_done", "the sitting after the capped one ran");
	});

	it("ends a sitting that repeats one call, with its reason, and the phase goes on", { timeout: 90_000 }, async () => {
		const run = await finished(
			await start("autostop-repeat", misbehavingSource("autostop-repeat", "mock:repeat_tool", ", maxTurns: 20")),
		);
		const clerk = outcomeOf(run, "the Clerk");
		assert.equal(clerk?.type, "error", log.slice(-3000));
		assert.equal(
			clerk?.payload?.output,
			"Stopped after calling read_blocks 4 times in a row with the same arguments.",
		);
		// Each call named the same arguments in a new order: still the same call, and the fourth was the last.
		const calls = run.events.filter((event) => event.type === "tool_call" && event.label === "the Clerk");
		assert.equal(calls.length, 4);
		assert.equal(new Set(calls.map((call) => JSON.stringify(call.payload?.args))).size, 4);
		assert.equal(outcomeOf(run, "the Censor")?.type, "node_done", "the sitting after the looping one ran");
	});

	it("ends a sitting at its wall clock, with its reason, and the phase goes on", { timeout: 90_000 }, async () => {
		const began = Date.now();
		const run = await finished(
			await start("autostop-clock", misbehavingSource("autostop-clock", "mock:stall", ", maxWallTimeMs: 3000")),
		);
		const clerk = outcomeOf(run, "the Clerk");
		assert.equal(clerk?.type, "error", log.slice(-3000));
		assert.equal(clerk?.payload?.output, "Stopped after 3 seconds without an answer.");
		assert.equal(clerk?.payload?.state, "timeout");
		assert.equal(outcomeOf(run, "the Censor")?.type, "node_done", "the sitting after the stalled one ran");
		assert.ok(Date.now() - began < 40_000, "the stalled sitting did not hold the run");
	});

	it(
		"stops a run: its live sittings end, no new one starts, and the run says who stopped it",
		{ timeout: 90_000 },
		async () => {
			const stalledBefore = log.split("inference_request: provider=openrouter model=mock:stall").length;
			const runId = await start("stop-a-run", stalledSource("stop-a-run"));
			// Wait until all three clerks are live and each is stalled inside its first model call, as the clerk was.
			const deadline = Date.now() + 45_000;
			while (log.split("inference_request: provider=openrouter model=mock:stall").length - stalledBefore < 3) {
				assert.ok(Date.now() < deadline, `the clerks never reached their model call:\n${log.slice(-3000)}`);
				await sleep(250);
			}

			const asked = Date.now();
			const response = await fetch(`${base}/api/workflows/runs/${runId}/stop`, {
				method: "POST",
				headers,
				body: JSON.stringify({ reason: "it is going nowhere" }),
			});
			const body = (await response.json()) as {
				run: {
					status: string;
					stoppedBy: string | null;
					stopRequestedAt: number | null;
					stopReason: string | null;
				};
				alreadyEnded: boolean;
				stoppedSittings: number;
			};
			assert.equal(response.status, 200, JSON.stringify(body));
			assert.equal(body.run.status, "stopped");
			assert.equal(body.run.stoppedBy, "owner");
			assert.equal(body.run.stopReason, "it is going nowhere");
			assert.ok(body.run.stopRequestedAt !== null && body.run.stopRequestedAt >= asked);
			assert.equal(body.alreadyEnded, false);
			assert.equal(body.stoppedSittings, 3);

			const run = await detail(runId);
			assert.equal(run.header.status, "stopped");
			for (const n of [1, 2, 3]) {
				const clerk = outcomeOf(run, `the Clerk #${n}`);
				assert.equal(clerk?.type, "error");
				assert.equal(clerk?.payload?.output, "Stopped by owner.");
			}
			assert.equal(
				run.events.some((event) => event.label === "the Censor"),
				false,
				"no sitting started after the stop",
			);
			const said = run.events.find((event) => event.type === "log");
			assert.equal(said?.payload?.msg, "Stopped by owner: it is going nowhere");
			assert.deepEqual(said?.payload?.stop, {
				by: "owner",
				at: body.run.stopRequestedAt,
				reason: "it is going nowhere",
			});
			const done = returned(run);
			assert.equal(done?.status, "stopped");
			assert.deepEqual(done?.stop, said?.payload?.stop);
			// The run's end is recorded after every sitting's.
			const ends = run.events.filter((event) => event.type === "error").map((event) => event.ts);
			const doneAt = run.events.find((event) => event.type === "run_done")?.ts ?? 0;
			assert.ok(ends.every((ts) => ts <= doneAt));

			// Asking again changes nothing.
			const again = await fetch(`${base}/api/workflows/runs/${runId}/stop`, { method: "POST", headers });
			const againBody = (await again.json()) as { run: { status: string }; alreadyEnded: boolean };
			assert.equal(again.status, 200);
			assert.equal(againBody.alreadyEnded, true);
			assert.equal(againBody.run.status, "stopped");
			assert.equal((await detail(runId)).events.length, run.events.length);
		},
	);

	it("refuses a stop from anyone but the run's owner, and for a run that does not exist", async () => {
		const missing = await fetch(`${base}/api/workflows/runs/wfr-nope/stop`, { method: "POST", headers });
		assert.equal(missing.status, 404);
		const runId = await start("stop-not-yours", misbehavingSource("stop-not-yours", "mock:done"));
		const stranger = await fetch(`${base}/api/workflows/runs/${runId}/stop`, {
			method: "POST",
			headers: { ...headers, "x-user-id": "someone-else" },
		});
		assert.equal(stranger.status, 403);
		await finished(runId);
	});
});
