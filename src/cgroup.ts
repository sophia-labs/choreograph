/**
 * Cgroup v2 lifecycle management for bwrap sandboxes.
 *
 * Handles the full lifecycle: init hierarchy -> create per-sandbox cgroup ->
 * set resource limits -> assign process -> read usage -> cleanup.
 *
 * Requires a cgroup v2 unified hierarchy with memory, cpu, pids controllers.
 * In Docker, this needs privileged mode.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { access, mkdir, readdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { cgroupStaleCleanups } from "./metrics.js";

const tracer = trace.getTracer("sandbox-mgmt.cgroup");
const CGROUP_FS_ROOT = "/sys/fs/cgroup";
// ─── Types ──────────────────────────────────────────────────────────────

export interface CgroupConfig {
	memory_max_bytes?: number;
	cpu_quota_us?: number;
	cpu_period_us?: number;
	pids_max?: number;
}

export interface CgroupLaunchCommand {
	command: string;
	args: string[];
}

const PREEXEC_CGROUP_SCRIPT = `
set -eu
cgroup_path=$1
shift
printf '%s' "$$" > "$cgroup_path/cgroup.procs"
exec "$@"
`;

/**
 * Move the child into its sandbox cgroup before it execs bubblewrap.
 *
 * Assigning from the parent after Node's `spawn` event races bwrap's user-
 * namespace creation; hardened kernels can reject that later cross-namespace
 * migration. A tiny pre-exec shell moves itself first, then `exec`s bwrap with
 * the same PID. Every namespace child inherits the cgroup membership.
 */
export function launchInCgroup(cgroupPath: string, command: string, args: readonly string[]): CgroupLaunchCommand {
	return {
		command: "/bin/sh",
		args: ["-c", PREEXEC_CGROUP_SCRIPT, "choreograph-cgroup-exec", cgroupPath, command, ...args],
	};
}

export interface CgroupUsage {
	memory_peak_bytes?: number;
	cpu_usage_us?: number;
}

export interface CgroupHierarchy {
	parentPath: string;
	managerPath: string;
	controllers: string[];
}

// ─── Discovery ──────────────────────────────────────────────────────────

function getOwnCgroupPath(): string {
	const content = readFileSync("/proc/self/cgroup", "utf-8").trim();
	// cgroup v2 unified: single line "0::/<path>"
	const match = content.match(/^0::(.+)$/m);
	if (!match) {
		throw new Error(`Cannot parse cgroup v2 from /proc/self/cgroup: ${content}`);
	}
	return match[1];
}

function getAvailableControllers(cgroupFsPath: string): string[] {
	try {
		return readFileSync(join(cgroupFsPath, "cgroup.controllers"), "utf-8").trim().split(/\s+/).filter(Boolean);
	} catch {
		return [];
	}
}

// ─── Initialization ─────────────────────────────────────────────────────

/**
 * Set up the cgroup hierarchy for sandbox management.
 *
 * Creates:
 *   <own-cgroup>/choreograph/          (parent, controllers delegated)
 *   <own-cgroup>/choreograph/manager/  (leaf for orchestrator process)
 *
 * The orchestrator must be in a leaf cgroup (manager/) so that the parent
 * (choreograph/) can delegate controllers to sandbox children. This is a
 * cgroup v2 constraint: a cgroup with processes cannot have subtree_control.
 *
 * If the process is already inside a choreograph hierarchy (e.g., docker exec
 * into a container where the orchestrator already initialized), reuses the
 * existing hierarchy rather than nesting another one inside the manager leaf.
 */
export function initCgroupHierarchy(): CgroupHierarchy {
	return tracer.startActiveSpan("cgroup.init_hierarchy", (span) => {
		try {
			const ownCgroup = getOwnCgroupPath();
			const ownFsPath = join("/sys/fs/cgroup", ownCgroup);

			console.error(`[cgroup] own cgroup: ${ownCgroup}`);
			console.error(`[cgroup] cgroup fs path: ${ownFsPath}`);

			// Detect existing hierarchy: if our cgroup path contains "/choreograph/",
			// the orchestrator already set up delegation. Reuse it to avoid nesting
			// inside the manager leaf (which has no subtree_control).
			const idx = ownCgroup.indexOf("/choreograph");
			if (idx !== -1) {
				const existingParentPath = join("/sys/fs/cgroup", ownCgroup.substring(0, idx), "choreograph");
				const existingManagerPath = join(existingParentPath, "manager");
				const controllers = getAvailableControllers(existingParentPath);
				if (controllers.length > 0 && existsSync(existingManagerPath)) {
					console.error(`[cgroup] reusing existing hierarchy at ${existingParentPath}`);
					console.error(`[cgroup] active controllers: ${controllers.join(", ")}`);
					span.setAttributes({
						"cgroup.parent_path": existingParentPath,
						"cgroup.manager_path": existingManagerPath,
						"cgroup.controllers": controllers.join(", "),
						"cgroup.reused": true,
					});
					span.end();
					return { parentPath: existingParentPath, managerPath: existingManagerPath, controllers };
				}
			}

			const parentPath = join(ownFsPath, "choreograph");
			const managerPath = join(parentPath, "manager");

			// Create hierarchy
			mkdirSync(parentPath, { recursive: true });
			mkdirSync(managerPath, { recursive: true });

			// Move ALL processes from the root cgroup to the manager leaf.
			// cgroup v2 requires that a cgroup with subtree_control has no processes
			// directly in it. In Docker privileged mode, the container's init and
			// our process are all in the root cgroup.
			try {
				const rootProcs = readFileSync(join(ownFsPath, "cgroup.procs"), "utf-8").trim();
				if (rootProcs) {
					const pids = rootProcs
						.split("\n")
						.map((s) => parseInt(s, 10))
						.filter((n) => n > 0);
					for (const pid of pids) {
						try {
							writeFileSync(join(managerPath, "cgroup.procs"), String(pid));
						} catch {
							// Some kernel threads can't be moved — that's OK
						}
					}
					console.error(`[cgroup] moved ${pids.length} process(es) to manager leaf`);
				}
			} catch (err) {
				console.warn(`[cgroup] failed to read root cgroup.procs: ${err}`);
				// Fall back to moving just ourselves
				writeFileSync(join(managerPath, "cgroup.procs"), String(process.pid));
			}

			// Enable controllers on the root cgroup (now empty of processes)
			const available = getAvailableControllers(ownFsPath);
			const wanted = ["memory", "cpu", "pids"].filter((c) => available.includes(c));

			if (wanted.length > 0) {
				const controlStr = wanted.map((c) => `+${c}`).join(" ");
				try {
					writeFileSync(join(ownFsPath, "cgroup.subtree_control"), controlStr);
					console.error(`[cgroup] enabled controllers on root: ${controlStr}`);
				} catch (err) {
					console.warn(`[cgroup] failed to enable controllers on root: ${err}`);
				}

				// Delegate to choreograph's children
				try {
					writeFileSync(join(parentPath, "cgroup.subtree_control"), controlStr);
					console.error(`[cgroup] delegated controllers to choreograph children: ${controlStr}`);
				} catch (err) {
					console.warn(`[cgroup] failed to delegate controllers: ${err}`);
				}
			} else {
				console.warn(`[cgroup] no controllers available at ${ownFsPath}`);
			}

			const controllers = getAvailableControllers(parentPath);
			console.error(`[cgroup] active controllers for sandboxes: ${controllers.join(", ") || "(none)"}`);

			span.setAttributes({
				"cgroup.parent_path": parentPath,
				"cgroup.manager_path": managerPath,
				"cgroup.controllers": controllers.join(", "),
			});
			span.end();
			return { parentPath, managerPath, controllers };
		} catch (err) {
			span.recordException(err as Error);
			span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
			span.end();
			throw err;
		}
	});
}

// ─── Per-Sandbox Cgroup ─────────────────────────────────────────────────

export async function createSandboxCgroup(
	parentPath: string,
	sandboxId: string,
	config: CgroupConfig,
): Promise<string> {
	return tracer.startActiveSpan("cgroup.create", async (span) => {
		const cgroupPath = join(parentPath, `sandbox-${sandboxId}`);
		try {
			await mkdir(cgroupPath);

			span.setAttributes({
				"sandbox.id": sandboxId,
				"cgroup.path": cgroupPath,
			});

			if (config.memory_max_bytes != null) {
				span.setAttribute("cgroup.memory_max_bytes", config.memory_max_bytes);
				await writeAndVerifyMemoryLimit(cgroupPath, config.memory_max_bytes);
				await writeAndVerifyCgroupValue(cgroupPath, "memory.swap.max", "0");
			}

			if (config.cpu_quota_us != null) {
				const period = config.cpu_period_us ?? 100000;
				span.setAttribute("cgroup.cpu_quota_us", config.cpu_quota_us);
				span.setAttribute("cgroup.cpu_period_us", period);
				await writeAndVerifyCgroupValue(cgroupPath, "cpu.max", `${config.cpu_quota_us} ${period}`);
			}

			if (config.pids_max != null) {
				span.setAttribute("cgroup.pids_max", config.pids_max);
				await writeAndVerifyCgroupValue(cgroupPath, "pids.max", String(config.pids_max));
			}

			return cgroupPath;
		} catch (err) {
			await rmdir(cgroupPath).catch(() => {});
			const message = `Failed to create bounded sandbox cgroup ${cgroupPath}: ${(err as Error).message}`;
			span.recordException(err as Error);
			span.setStatus({ code: SpanStatusCode.ERROR, message });
			throw new Error(message, { cause: err });
		} finally {
			span.end();
		}
	});
}

async function writeAndVerifyMemoryLimit(cgroupPath: string, requested: number): Promise<void> {
	const path = join(cgroupPath, "memory.max");
	await writeFile(path, String(requested));
	const raw = (await readFile(path, "utf-8")).trim();
	const actual = Number(raw);

	// The kernel rounds byte limits down to its page size. Any positive finite
	// value at or below the request is at least as restrictive as requested;
	// "max", zero, a larger value, or an unparsable response is not.
	if (!Number.isSafeInteger(actual) || actual <= 0 || actual > requested) {
		throw new Error(
			`memory.max verification failed: requested ${JSON.stringify(String(requested))}, read ${JSON.stringify(raw)}`,
		);
	}
}

async function writeAndVerifyCgroupValue(cgroupPath: string, filename: string, value: string): Promise<void> {
	const path = join(cgroupPath, filename);
	await writeFile(path, value);
	const actual = (await readFile(path, "utf-8")).trim();
	if (actual !== value) {
		throw new Error(
			`${filename} verification failed: requested ${JSON.stringify(value)}, read ${JSON.stringify(actual)}`,
		);
	}
}

function expectedProcessCgroupPath(cgroupPath: string): string {
	if (cgroupPath === CGROUP_FS_ROOT) return "/";
	if (!cgroupPath.startsWith(`${CGROUP_FS_ROOT}/`)) {
		throw new Error(`Cgroup path is outside ${CGROUP_FS_ROOT}: ${cgroupPath}`);
	}
	return cgroupPath.slice(CGROUP_FS_ROOT.length);
}

async function getProcessCgroupPath(pid: number): Promise<string | undefined> {
	try {
		const content = await readFile(`/proc/${pid}/cgroup`, "utf-8");
		const match = content.match(/^0::(.*)$/m);
		if (!match) return undefined;
		return match[1] || "/";
	} catch {
		return undefined;
	}
}

async function getDescendantPids(pid: number): Promise<number[]> {
	const descendants: number[] = [];
	try {
		const raw = await readFile(`/proc/${pid}/task/${pid}/children`, "utf-8");
		const children = raw
			.trim()
			.split(/\s+/)
			.map((value) => Number.parseInt(value, 10))
			.filter((value) => value > 0);
		for (const child of children) {
			descendants.push(child, ...(await getDescendantPids(child)));
		}
	} catch {
		// The process may have exited while its tree is being inspected.
	}
	return descendants;
}

export interface ProcessTreeCgroupInspection {
	live: number[];
	outside: number[];
}

/** Read-only proof that the pre-exec launcher placed the entire live tree. */
export async function inspectProcessTreeCgroup(cgroupPath: string, pid: number): Promise<ProcessTreeCgroupInspection> {
	const expected = expectedProcessCgroupPath(cgroupPath);
	const discovered = [...new Set([pid, ...(await getDescendantPids(pid))])];
	const live: number[] = [];
	const outside: number[] = [];
	for (const candidate of discovered) {
		const membership = await getProcessCgroupPath(candidate);
		if (membership == null) continue;
		live.push(candidate);
		if (membership !== expected) outside.push(candidate);
	}
	live.sort((left, right) => left - right);
	outside.sort((left, right) => left - right);
	return { live, outside };
}

// ─── Resource Usage ─────────────────────────────────────────────────────

export async function readUsage(cgroupPath: string): Promise<CgroupUsage> {
	return tracer.startActiveSpan("cgroup.read_usage", async (span) => {
		const usage: CgroupUsage = {};

		// memory.peak — peak memory usage (Linux 5.19+)
		try {
			const peak = (await readFile(join(cgroupPath, "memory.peak"), "utf-8")).trim();
			if (peak !== "max") {
				usage.memory_peak_bytes = parseInt(peak, 10);
			}
		} catch {
			// memory.peak not available, try memory.current as fallback
			try {
				const current = (await readFile(join(cgroupPath, "memory.current"), "utf-8")).trim();
				usage.memory_peak_bytes = parseInt(current, 10);
			} catch {
				// no memory accounting available
			}
		}

		// cpu.stat — parse usage_usec
		try {
			const stat = await readFile(join(cgroupPath, "cpu.stat"), "utf-8");
			const match = stat.match(/^usage_usec\s+(\d+)$/m);
			if (match) {
				usage.cpu_usage_us = parseInt(match[1], 10);
			}
		} catch {
			// no cpu accounting available
		}

		span.setAttributes({
			"cgroup.path": cgroupPath,
		});
		if (usage.memory_peak_bytes != null) {
			span.setAttribute("cgroup.memory_peak_bytes", usage.memory_peak_bytes);
		}
		if (usage.cpu_usage_us != null) {
			span.setAttribute("cgroup.cpu_usage_us", usage.cpu_usage_us);
		}
		span.end();
		return usage;
	});
}

// ─── Cleanup ────────────────────────────────────────────────────────────

export async function removeSandboxCgroup(
	cgroupPath: string,
	options: { reapDeadlineMs?: number; pollMs?: number } = {},
): Promise<void> {
	try {
		await access(cgroupPath);
	} catch (error) {
		if (nodeErrorCode(error) === "ENOENT") return;
		throw error;
	}

	await tracer.startActiveSpan("cgroup.remove", async (span) => {
		span.setAttribute("cgroup.path", cgroupPath);
		try {
			let usedCgroupKill = true;
			try {
				await writeFile(join(cgroupPath, "cgroup.kill"), "1");
			} catch (error) {
				if (nodeErrorCode(error) !== "ENOENT") throw error;
				usedCgroupKill = false;
			}
			let signalled = 0;
			const deadline = Date.now() + (options.reapDeadlineMs ?? 5_000);
			while (true) {
				const procs = await readCgroupProcesses(cgroupPath);
				if (procs.length === 0 && (await cgroupReportsUnpopulated(cgroupPath))) break;
				if (!usedCgroupKill) {
					for (const pid of procs) {
						try {
							process.kill(pid, "SIGKILL");
							signalled += 1;
						} catch (error) {
							if (nodeErrorCode(error) !== "ESRCH") throw error;
						}
					}
				}
				if (Date.now() >= deadline) {
					throw new Error(`Cgroup ${cgroupPath} remained populated after verified reap deadline`);
				}
				await new Promise<void>((resolve) => setTimeout(resolve, options.pollMs ?? 25));
			}
			span.setAttributes({
				"cgroup.kill_used": usedCgroupKill,
				"cgroup.signalled_processes": signalled,
			});
			await rmdir(cgroupPath);
			try {
				await access(cgroupPath);
				throw new Error(`Cgroup ${cgroupPath} still exists after removal`);
			} catch (error) {
				if (nodeErrorCode(error) !== "ENOENT") throw error;
			}
		} catch (error) {
			span.recordException(error as Error);
			span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
			throw error;
		} finally {
			span.end();
		}
	});
}

async function readCgroupProcesses(cgroupPath: string): Promise<number[]> {
	const raw = (await readFile(join(cgroupPath, "cgroup.procs"), "utf-8")).trim();
	if (!raw) return [];
	return raw
		.split("\n")
		.map((value) => Number.parseInt(value, 10))
		.filter((value) => Number.isSafeInteger(value) && value > 0);
}

async function cgroupReportsUnpopulated(cgroupPath: string): Promise<boolean> {
	try {
		const events = await readFile(join(cgroupPath, "cgroup.events"), "utf-8");
		const match = events.match(/^populated\s+([01])$/m);
		if (!match) throw new Error(`Cgroup ${cgroupPath} has malformed cgroup.events testimony`);
		return match[1] === "0";
	} catch (error) {
		if (nodeErrorCode(error) === "ENOENT") return true;
		throw error;
	}
}

function nodeErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

/**
 * Clean up orphaned sandbox cgroups from a previous crashed orchestrator.
 */
export async function cleanupStaleCgroups(
	parentPath: string,
	options: { reapDeadlineMs?: number; pollMs?: number } = {},
): Promise<number> {
	return tracer.startActiveSpan("cgroup.cleanup_stale", async (span) => {
		let cleaned = 0;

		span.setAttribute("cgroup.parent_path", parentPath);

		try {
			const entries = await readdir(parentPath, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory() && entry.name.startsWith("sandbox-")) {
					const cgroupPath = join(parentPath, entry.name);
					console.error(`[cgroup] cleaning up stale cgroup: ${entry.name}`);
					await removeSandboxCgroup(cgroupPath, options);
					cleaned++;
				}
			}
		} catch (error) {
			if (nodeErrorCode(error) !== "ENOENT") throw error;
			// parent doesn't exist yet, nothing to clean
		}

		if (cleaned > 0) {
			console.error(`[cgroup] cleaned up ${cleaned} stale cgroup(s)`);
			cgroupStaleCleanups.add(cleaned);
		}

		span.setAttribute("cgroup.cleaned_count", cleaned);
		span.end();
		return cleaned;
	});
}
