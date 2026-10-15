#!/usr/bin/env node
/**
 * Strict type check of the host sources and their tests, as a ratchet.
 *
 * `pnpm check` and `pnpm build` type-check none of `src/`: the root tsconfig.json has `files: []` and builds only
 * `src/browser-service`, and tsconfig.acp.json only `src/acp`. This runs `tsc -p tsconfig.check.json` over every
 * `.ts` file under `src/` (tests and fixtures included) and compares the errors, file by file, with
 * `scripts/check-types.baseline.json`.
 *
 * The deployed lineage was never held to a type check and carries hundreds of errors, nearly all one pattern in
 * `src/workflow/runtime-store.ts`: a libSQL transaction (`args: InValue[]`) passed to a helper typed with the older
 * looser `RuntimeTx` (`args: unknown[]`). So the bar is not zero, it is "no worse": a file may not have more errors
 * than the baseline records, and a file the baseline does not list may have none. Everything written for the
 * Sobremesa release (billing-rate-card, the chat modules, session-transcript and their tests) is at zero.
 *
 *     pnpm check:types             fail if any file is worse than the baseline
 *     pnpm check:types --update    write the baseline (review the diff: it should only ever go down)
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = resolve(root, "scripts/check-types.baseline.json");
const update = process.argv.includes("--update");

const run = spawnSync("pnpm", ["exec", "tsc", "-p", "tsconfig.check.json", "--pretty", "false"], {
	cwd: root,
	encoding: "utf8",
	maxBuffer: 512 * 1024 * 1024,
});
if (run.error) throw run.error;

const counts = {};
for (const line of `${run.stdout}\n${run.stderr}`.split("\n")) {
	const match = /^(src\/[^()]+)\(\d+,\d+\): error TS\d+:/.exec(line);
	if (match) counts[match[1]] = (counts[match[1]] ?? 0) + 1;
}
const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
if (run.status !== 0 && total === 0) {
	console.error(`tsc failed without reporting a type error:\n${run.stdout}${run.stderr}`);
	process.exit(2);
}

const sorted = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

if (update) {
	writeFileSync(
		baselinePath,
		`${JSON.stringify({ note: "Type errors per file that this repository already had. Only ever lower.", maxErrorsPerFile: sorted(counts) }, null, "\t")}\n`,
	);
	console.log(`baseline written: ${total} errors in ${Object.keys(counts).length} files`);
	process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8")).maxErrorsPerFile;
const worse = Object.entries(counts).filter(([file, n]) => n > (baseline[file] ?? 0));
const better = Object.entries(baseline).filter(([file, n]) => (counts[file] ?? 0) < n);

for (const [file, n] of worse) {
	console.error(`WORSE   ${file}: ${n} type errors, the baseline allows ${baseline[file] ?? 0}`);
}
for (const [file, n] of better) {
	console.log(`better  ${file}: ${counts[file] ?? 0} type errors, the baseline still allows ${n} (run --update)`);
}
if (worse.length > 0) {
	console.error(`${worse.length} file(s) have more type errors than the baseline. See: pnpm exec tsc -p tsconfig.check.json`);
	process.exit(1);
}
console.log(`type check: ${total} errors in ${Object.keys(counts).length} files, none worse than the baseline`);
