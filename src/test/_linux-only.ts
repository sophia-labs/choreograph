import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * True when this host can run the real bwrap + cgroup-v2 sandbox tests.
 *
 * The orchestrator's sandbox primitive needs a Linux host with a cgroup v2
 * unified hierarchy and the `bwrap` binary on PATH. On macOS/Windows hosts
 * these are absent — the dev VM (`pnpm test:vm`) provides them. Evaluated once
 * at module load: the capability is static per host and the two suites that
 * use it run with `{ concurrency: false }`.
 */
export function bwrapAvailable(): boolean {
	if (process.platform !== "linux") return false;
	// `cgroup.controllers` only exists on the cgroup v2 unified hierarchy,
	// which is what src/cgroup.ts requires.
	if (!existsSync("/sys/fs/cgroup/cgroup.controllers")) return false;
	try {
		execFileSync("bwrap", ["--version"], { stdio: "ignore" });
	} catch {
		return false;
	}
	return true;
}

/**
 * node:test options object for Linux-only suites: `{}` to run normally, or
 * `{ skip: <reason> }` to skip cleanly off a bwrap/cgroup-v2 host. Spread into
 * a `describe(...)` options arg so the (crashing) `before()` hook never runs.
 *
 * Mirrors the `{ skip: ... }` idiom already used in
 * workflow-run.integration.test.ts.
 */
export const linuxOnly = bwrapAvailable()
	? {}
	: { skip: "requires a Linux host with cgroup v2 + bwrap (run inside the dev VM: `pnpm test:vm`)" };
