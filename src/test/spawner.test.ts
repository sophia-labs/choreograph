import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type CgroupHierarchy, cleanupStaleCgroups, initCgroupHierarchy, inspectProcessTreeCgroup } from "../cgroup.js";
import { type SandboxRecord, SandboxStore } from "../sandbox-store.js";
import { SandboxSpawner } from "../spawner.js";
import { linuxOnly } from "./_linux-only.js";
import { createRuntimeBundleFixture, type RuntimeBundleFixture } from "./runtime-bundle-fixture.js";

const TERMINAL_STATES = new Set(["done", "truncated", "error", "timeout", "killed"]);
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = resolve(TEST_DIR, "../worker.mjs");
const WORKSPACE_ROOT = existsSync("/workspace") ? "/workspace" : resolve(TEST_DIR, "../..");

async function waitForTerminal(store: SandboxStore, sandboxId: string, timeoutMs = 15_000): Promise<SandboxRecord> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const record = store.get(sandboxId);
		if (record && TERMINAL_STATES.has(record.state)) return record;
		await new Promise((r) => setTimeout(r, 200));
	}
	const final = store.get(sandboxId);
	throw new Error(`Sandbox ${sandboxId} did not reach terminal state within ${timeoutMs}ms (state: ${final?.state})`);
}

describe("SandboxSpawner", { concurrency: false, ...linuxOnly }, () => {
	let hierarchy: CgroupHierarchy;
	let store: SandboxStore;
	let spawner: SandboxSpawner;
	let tempDir: string;
	let runtimeBundles: RuntimeBundleFixture;
	let restoreRuntimeEnv: (() => void) | undefined;

	before(async () => {
		process.env.WORKSPACE_ROOT = WORKSPACE_ROOT;
		runtimeBundles = createRuntimeBundleFixture(WORKSPACE_ROOT);
		restoreRuntimeEnv = runtimeBundles.apply();
		hierarchy = initCgroupHierarchy();
		await cleanupStaleCgroups(hierarchy.parentPath);
		tempDir = mkdtempSync(join(tmpdir(), "spawner-test-"));
		store = new SandboxStore(join(tempDir, "test.sqlite"));
		spawner = new SandboxSpawner(store, hierarchy, {
			workerScript: WORKER_SCRIPT,
			defaultTimeoutMs: 30_000,
		});
	});

	after(async () => {
		await spawner.shutdownAll();
		store.close();
		rmSync(tempDir, { recursive: true, force: true });
		await cleanupStaleCgroups(hierarchy.parentPath);
		restoreRuntimeEnv?.();
		runtimeBundles.cleanup();
		delete process.env.WORKSPACE_ROOT;
	});

	it("spawn + clean exit: state=done, exit_code=0, memory_peak_bytes > 0", async () => {
		const record = await spawner.spawn({
			template: "bare",
			resources: { memory_max_bytes: 134_217_728 },
			worker_config: { max_iterations: 3, sleep_ms: 100 },
		});

		const final = await waitForTerminal(store, record.sandbox_id);
		assert.equal(final.state, "done");
		assert.equal(final.exit_code, 0);
		assert.ok(
			final.memory_peak_bytes != null && final.memory_peak_bytes > 0,
			`memory_peak_bytes should be > 0, got ${final.memory_peak_bytes}`,
		);
		assert.ok(
			final.cpu_usage_us != null && final.cpu_usage_us > 0,
			`cpu_usage_us should be > 0, got ${final.cpu_usage_us}`,
		);
	});

	it("places the bwrap worker and command grandchild in the bounded cgroup before init", async () => {
		const record = await spawner.spawn({
			template: "bare",
			resources: {
				memory_max_bytes: 134_217_728,
				cpu_quota_us: 50_000,
				cpu_period_us: 100_000,
				pids_max: 16,
			},
			timeout_ms: 10_000,
			worker_config: {
				mode: "command",
				command: ["node", "-e", "setTimeout(() => {}, 2500)"],
			},
		});

		assert.equal(record.state, "running");
		assert.ok(record.pid != null, "running sandbox should expose its bwrap PID");
		assert.ok(record.cgroup_path, "running sandbox should expose its cgroup path");

		let inspection = await inspectProcessTreeCgroup(record.cgroup_path, record.pid);
		const deadline = Date.now() + 2000;
		while (inspection.live.length < 3 && Date.now() < deadline) {
			await new Promise((resolvePoll) => setTimeout(resolvePoll, 50));
			inspection = await inspectProcessTreeCgroup(record.cgroup_path, record.pid);
		}

		assert.ok(
			inspection.live.length >= 3,
			`expected bwrap, worker, and command processes; observed PIDs: ${inspection.live.join(", ")}`,
		);
		assert.deepEqual(
			inspection.outside,
			[],
			`all live sandbox descendants must be in ${record.cgroup_path}; outside: ${inspection.outside.join(", ")}`,
		);

		const final = await waitForTerminal(store, record.sandbox_id, 10_000);
		assert.equal(final.state, "done");
		assert.ok(
			final.memory_peak_bytes != null && final.memory_peak_bytes > 0,
			`bounded command should report cgroup memory usage, got ${final.memory_peak_bytes}`,
		);
	});

	it("fails closed and records an error when a requested cgroup limit cannot be applied", async () => {
		const record = await spawner.spawn({
			template: "bare",
			resources: { pids_max: -1 },
			worker_config: { max_iterations: 1 },
		});

		assert.equal(record.state, "error");
		assert.match(record.error_detail ?? "", /Failed to create bounded sandbox cgroup/);
		assert.equal(spawner.getActive().has(record.sandbox_id), false);
		assert.equal(existsSync(join(hierarchy.parentPath, `sandbox-${record.sandbox_id}`)), false);
	});

	it("kill: state=killed, memory_peak_bytes > 0", async () => {
		const record = await spawner.spawn({
			template: "bare",
			resources: { memory_max_bytes: 134_217_728 },
			worker_config: { max_iterations: 600, sleep_ms: 1000, memory_alloc_mb: 1 },
		});

		// Wait until running
		let current = store.get(record.sandbox_id);
		while (current?.state !== "running") {
			await new Promise((r) => setTimeout(r, 100));
			current = store.get(record.sandbox_id);
		}

		// Let it allocate some memory
		await new Promise((r) => setTimeout(r, 2000));

		await spawner.kill(record.sandbox_id);
		const final = await waitForTerminal(store, record.sandbox_id);

		assert.equal(final.state, "killed");
		assert.ok(
			final.memory_peak_bytes != null && final.memory_peak_bytes > 0,
			`memory_peak_bytes should be > 0 after kill, got ${final.memory_peak_bytes}`,
		);
	});

	it("timeout: state=timeout", async () => {
		const record = await spawner.spawn({
			template: "bare",
			resources: { memory_max_bytes: 134_217_728 },
			timeout_ms: 2000,
			worker_config: { max_iterations: 600, sleep_ms: 1000 },
		});

		const final = await waitForTerminal(store, record.sandbox_id, 10_000);
		assert.equal(final.state, "timeout");
	});

	it("OOM: state=error, exit_code=137, error_detail contains OOM", async () => {
		const record = await spawner.spawn({
			template: "bare",
			resources: { memory_max_bytes: 10_000_000 },
			worker_config: { max_iterations: 100, sleep_ms: 100, memory_alloc_mb: 5 },
		});

		const final = await waitForTerminal(store, record.sandbox_id, 15_000);
		assert.equal(final.state, "error");
		assert.equal(final.exit_code, 137);
		assert.ok(final.error_detail?.includes("OOM"), `error_detail should mention OOM, got: ${final.error_detail}`);
	});

	it("command workload can read the repo through the workspace template", async () => {
		const record = await spawner.spawn({
			template: "workspace",
			worker_config: {
				mode: "command",
				command: ["node", "-e", "require('node:fs').accessSync('/workspace/package.json')"],
			},
		});

		const final = await waitForTerminal(store, record.sandbox_id, 15_000);
		assert.equal(final.state, "done");
		assert.equal(final.exit_code, 0);
	});

	it("command workload fails without the workspace template mount", async () => {
		const record = await spawner.spawn({
			template: "bare",
			worker_config: {
				mode: "command",
				command: ["node", "-e", "require('node:fs').accessSync('/workspace/package.json')"],
			},
		});

		const final = await waitForTerminal(store, record.sandbox_id, 15_000);
		assert.equal(final.state, "error");
		assert.notEqual(final.exit_code, 0);
	});

	it("command workload can read a manifest-defined prebuilt filesystem bundle", async () => {
		const bundleDir = mkdtempSync(join(tmpdir(), "sandbox-bundle-test-"));
		const prebuiltRoot = join(bundleDir, "runtime-cache");
		const manifestPath = join(bundleDir, "filesystems.json");
		mkdirSync(prebuiltRoot);
		writeFileSync(join(prebuiltRoot, "hello.txt"), "warm sandbox filesystem", "utf8");
		writeFileSync(
			manifestPath,
			JSON.stringify({
				filesystems: [
					{
						id: "runtime-cache",
						description: "Prebuilt runtime cache",
						mounts: [
							{
								host_path: "./runtime-cache",
								guest_path: "/opt/runtime-cache",
							},
						],
					},
				],
			}),
			"utf8",
		);

		process.env.CHOREOGRAPH_SANDBOX_FILESYSTEMS_MANIFEST = manifestPath;
		try {
			const record = await spawner.spawn({
				template: "bare",
				filesystems: ["runtime-cache"],
				worker_config: {
					mode: "command",
					command: ["node", "-e", "require('node:fs').accessSync('/opt/runtime-cache/hello.txt')"],
				},
			});

			const final = await waitForTerminal(store, record.sandbox_id, 15_000);
			assert.equal(final.state, "done");
			assert.equal(final.exit_code, 0);
			assert.deepEqual(final.filesystems, ["runtime-cache"]);
		} finally {
			delete process.env.CHOREOGRAPH_SANDBOX_FILESYSTEMS_MANIFEST;
			rmSync(bundleDir, { recursive: true, force: true });
		}
	});

	it("shutdownAll: kills all active sandboxes", async () => {
		const r1 = await spawner.spawn({
			template: "bare",
			resources: { memory_max_bytes: 134_217_728 },
			worker_config: { max_iterations: 600, sleep_ms: 1000 },
		});
		const r2 = await spawner.spawn({
			template: "bare",
			resources: { memory_max_bytes: 134_217_728 },
			worker_config: { max_iterations: 600, sleep_ms: 1000 },
		});

		assert.ok(spawner.getActive().size >= 2, "should have at least 2 active");

		const shutdown = spawner.shutdownAll();
		assert.throws(
			() =>
				spawner.enqueue({
					template: "bare",
					worker_config: { max_iterations: 1, sleep_ms: 1 },
				}),
			/Sandbox admission is closed during shutdown/,
			"the synchronous shutdown latch must reject work before the first drain await",
		);
		await shutdown;

		assert.equal(spawner.getActive().size, 0, "active map should be empty");

		const f1 = store.get(r1.sandbox_id)!;
		const f2 = store.get(r2.sandbox_id)!;
		assert.ok(TERMINAL_STATES.has(f1.state), `sandbox 1 should be terminal, got ${f1.state}`);
		assert.ok(TERMINAL_STATES.has(f2.state), `sandbox 2 should be terminal, got ${f2.state}`);
	});
});
