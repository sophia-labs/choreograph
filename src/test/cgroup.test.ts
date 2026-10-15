import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	type CgroupHierarchy,
	cleanupStaleCgroups,
	createSandboxCgroup,
	initCgroupHierarchy,
	launchInCgroup,
	readUsage,
	removeSandboxCgroup,
} from "../cgroup.js";
import { linuxOnly } from "./_linux-only.js";

describe("cgroup startup cleanup authority", () => {
	it("fails closed before supervisor startup when a stale cgroup cannot be verified empty", async () => {
		const directory = mkdtempSync(join(tmpdir(), "cgroup-stale-failure-"));
		const stale = join(directory, "sandbox-stale");
		mkdirSync(stale);
		writeFileSync(join(stale, "cgroup.kill"), "");
		writeFileSync(join(stale, "cgroup.procs"), "424242\n");
		writeFileSync(join(stale, "cgroup.events"), "populated 1\n");
		let supervisorStarted = false;
		try {
			await assert.rejects(async () => {
				await cleanupStaleCgroups(directory, { reapDeadlineMs: 5, pollMs: 1 });
				supervisorStarted = true;
			}, /remained populated/);
			assert.equal(supervisorStarted, false);
			assert.equal(existsSync(stale), true, "unverified stale process identity must remain available for repair");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("cgroup v2", { concurrency: false, ...linuxOnly }, () => {
	let hierarchy: CgroupHierarchy;

	before(() => {
		hierarchy = initCgroupHierarchy();
	});

	after(async () => {
		await cleanupStaleCgroups(hierarchy.parentPath);
	});

	describe("initCgroupHierarchy()", () => {
		it("creates parent and manager directories", () => {
			assert.ok(existsSync(hierarchy.parentPath), "parent path should exist");
			assert.ok(existsSync(hierarchy.managerPath), "manager path should exist");
		});

		it("enables memory, cpu, pids controllers", () => {
			assert.ok(hierarchy.controllers.includes("memory"), "should have memory controller");
			assert.ok(hierarchy.controllers.includes("cpu"), "should have cpu controller");
			assert.ok(hierarchy.controllers.includes("pids"), "should have pids controller");
		});
	});

	describe("createSandboxCgroup()", () => {
		it("creates cgroup directory with resource limits", async () => {
			const cgroupPath = await createSandboxCgroup(hierarchy.parentPath, "test-limits", {
				memory_max_bytes: 50_000_000,
				pids_max: 64,
			});

			try {
				assert.ok(existsSync(cgroupPath));

				const memMax = parseInt(readFileSync(join(cgroupPath, "memory.max"), "utf-8").trim(), 10);
				// Kernel rounds to page boundary (4096 bytes)
				assert.ok(Math.abs(memMax - 50_000_000) < 4096, `memory.max should be ~50000000, got ${memMax}`);

				const pidsMax = readFileSync(join(cgroupPath, "pids.max"), "utf-8").trim();
				assert.equal(pidsMax, "64");
			} finally {
				await removeSandboxCgroup(cgroupPath);
			}
		});

		it("sets memory.swap.max=0 when memory limit is set", async () => {
			const cgroupPath = await createSandboxCgroup(hierarchy.parentPath, "test-swap", {
				memory_max_bytes: 10_000_000,
			});

			try {
				const swapMax = readFileSync(join(cgroupPath, "memory.swap.max"), "utf-8").trim();
				assert.equal(swapMax, "0");
			} finally {
				await removeSandboxCgroup(cgroupPath);
			}
		});

		it("sets cpu.max with quota and period", async () => {
			const cgroupPath = await createSandboxCgroup(hierarchy.parentPath, "test-cpu", {
				cpu_quota_us: 50000,
				cpu_period_us: 100000,
			});

			try {
				const cpuMax = readFileSync(join(cgroupPath, "cpu.max"), "utf-8").trim();
				assert.equal(cpuMax, "50000 100000");
			} finally {
				await removeSandboxCgroup(cgroupPath);
			}
		});
	});

	describe("readUsage()", () => {
		it("returns object with memory and cpu fields for empty cgroup", async () => {
			const cgroupPath = await createSandboxCgroup(hierarchy.parentPath, "test-usage", {});

			try {
				const usage = await readUsage(cgroupPath);
				assert.equal(typeof usage, "object");
				// Empty cgroup should have 0 or undefined for memory
				if (usage.memory_peak_bytes !== undefined) {
					assert.equal(typeof usage.memory_peak_bytes, "number");
				}
				if (usage.cpu_usage_us !== undefined) {
					assert.equal(typeof usage.cpu_usage_us, "number");
				}
			} finally {
				await removeSandboxCgroup(cgroupPath);
			}
		});
	});

	describe("launchInCgroup()", () => {
		it("places bubblewrap before user-namespace creation and accounts its work", async () => {
			const cgroupPath = await createSandboxCgroup(hierarchy.parentPath, "test-preexec", {});
			try {
				const launch = launchInCgroup(cgroupPath, "bwrap", ["--unshare-all", "--ro-bind", "/", "/", "true"]);
				const child = spawn(launch.command, launch.args, { stdio: ["ignore", "pipe", "pipe"] });
				let stderr = "";
				child.stderr?.setEncoding("utf8");
				child.stderr?.on("data", (chunk: string) => {
					stderr += chunk;
				});
				const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
				assert.equal(signal, null, stderr);
				assert.equal(code, 0, stderr);
				const usage = await readUsage(cgroupPath);
				assert.ok(
					usage.memory_peak_bytes != null && usage.memory_peak_bytes > 0,
					`pre-exec cgroup should account memory, got ${usage.memory_peak_bytes}`,
				);
			} finally {
				await removeSandboxCgroup(cgroupPath);
			}
		});
	});

	describe("removeSandboxCgroup()", () => {
		it("removes cgroup directory", async () => {
			const cgroupPath = await createSandboxCgroup(hierarchy.parentPath, "test-remove", {});
			assert.ok(existsSync(cgroupPath));
			await removeSandboxCgroup(cgroupPath);
			assert.ok(!existsSync(cgroupPath));
		});

		it("handles already-removed path gracefully", async () => {
			// Should not throw
			await removeSandboxCgroup("/sys/fs/cgroup/nonexistent-path");
		});
	});

	describe("cleanupStaleCgroups()", () => {
		it("removes orphaned sandbox-* directories", async () => {
			const cg1 = await createSandboxCgroup(hierarchy.parentPath, "stale-1", {});
			const cg2 = await createSandboxCgroup(hierarchy.parentPath, "stale-2", {});
			assert.ok(existsSync(cg1));
			assert.ok(existsSync(cg2));

			const cleaned = await cleanupStaleCgroups(hierarchy.parentPath);
			assert.ok(cleaned >= 2, `should clean at least 2, got ${cleaned}`);
			assert.ok(!existsSync(cg1));
			assert.ok(!existsSync(cg2));
		});
	});
});
