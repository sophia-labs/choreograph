#!/usr/bin/env node

/**
 * Assembles the bounded JSON summary that deploy/kernel-image-acceptance.sh
 * writes to stdout, and nothing else writes to stdout.
 *
 * It exists as its own file for one reason: log tails are arbitrary bytes.
 * ANSI escapes, embedded quotes, a NUL from a crashed kernel, a 40 MB line
 * from a runaway loop — hand-rolled JSON escaping in bash is how an acceptance
 * summary becomes unparseable exactly on the runs where somebody needs to read
 * it. Everything here is size-bounded before it is serialized.
 *
 * The contract with the platform-next side is the object shape below, at
 * schema "choreograph.kernel-image-acceptance/1". `accepted` is the verdict;
 * the exit code of the shell script carries the same verdict, and that is what
 * a Job condition should key on.
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";

const MAX_LINE_CHARS = 400;
const MAX_REASON_CHARS = 2_000;
const MAX_SUMMARY_BYTES = 256 * 1024;

const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
const CONTROL_BYTES = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		if (!key.startsWith("--")) {
			throw new Error(`unexpected argument: ${key}`);
		}
		options[key.slice(2)] = argv[index + 1] ?? "";
	}
	return options;
}

/** Printable, single-line, bounded. Control bytes are dropped, not passed through. */
function sanitizeLine(line) {
	const printable = line.replace(ANSI_ESCAPE, "").replace(CONTROL_BYTES, "");
	if (printable.length <= MAX_LINE_CHARS) {
		return printable;
	}
	return `${printable.slice(0, MAX_LINE_CHARS)}…[+${printable.length - MAX_LINE_CHARS} chars]`;
}

function readTail(path, lines) {
	let descriptor;
	try {
		const size = statSync(path).size;
		// Read only the last window of the file. A battery that wedges printing is
		// exactly the case where the whole log must not be loaded to describe it.
		const window = Math.min(size, Math.max(lines, 1) * (MAX_LINE_CHARS + 1) * 2);
		const buffer = Buffer.alloc(window);
		descriptor = openSync(path, "r");
		readSync(descriptor, buffer, 0, window, size - window);
		const tail = buffer
			.toString("utf8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.slice(-lines)
			.map(sanitizeLine);
		return { tail, log_bytes: size };
	} catch (error) {
		return {
			tail: [`(log unavailable: ${error instanceof Error ? error.message : String(error)})`],
			log_bytes: 0,
		};
	} finally {
		if (descriptor !== undefined) {
			closeSync(descriptor);
		}
	}
}

function readRecords(path) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});
}

function readImageMetadata(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		// Absent metadata is a finding, not a crash: it means the image under test
		// was built by something other than Dockerfile.kernels.
		return null;
	}
}

const options = parseArgs(process.argv.slice(2));
const tailLines = Number.parseInt(options["tail-lines"] ?? "40", 10) || 40;
const outcome = options.outcome ?? "environment";
const records = readRecords(options.records ?? "");

const batteries = records.map((record) => {
	const { tail, log_bytes } = readTail(record.log, tailLines);
	return {
		kernel: record.kernel,
		status: record.status,
		exit_code: record.exit_code,
		duration_ms: record.duration_ms,
		recorded_checks: record.checks,
		log: record.log,
		log_bytes,
		tail,
	};
});

const failure = batteries.find((battery) => battery.status !== "pass");
const summary = {
	schema: "choreograph.kernel-image-acceptance/1",
	accepted: outcome === "accepted",
	outcome,
	reason: (options.reason ?? "").slice(0, MAX_REASON_CHARS) || null,
	started_at: options["started-at"] ?? null,
	duration_ms: Number.parseInt(options["duration-ms"] ?? "0", 10) || 0,
	requested: (options.requested ?? "").split(/\s+/).filter(Boolean),
	log_dir: options["log-dir"] ?? null,
	image: readImageMetadata(options["image-metadata"] ?? ""),
	batteries,
	failed_kernel: failure?.kernel ?? null,
};

let serialized = JSON.stringify(summary);
if (Buffer.byteLength(serialized) > MAX_SUMMARY_BYTES) {
	// Drop the tails rather than truncate the JSON: a caller that cannot parse
	// the verdict is worse off than one that has to open the log files.
	summary.batteries = summary.batteries.map((battery) => ({
		...battery,
		tail: battery.tail.slice(-5),
		tail_truncated: true,
	}));
	serialized = JSON.stringify(summary);
}
process.stdout.write(`${serialized}\n`);
