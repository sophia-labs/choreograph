#!/usr/bin/env node

/**
 * Runtime bundle smoke for the Julia kernel: worker + Rust bridge + the bundled
 * Julia/IJulia payload, all under real bwrap. Same shape as
 * smoke-jupyter-bundles.mjs, which does this for the Python payload.
 *
 * The launch argv and env mirror src/kernel-bridges.ts. They are duplicated
 * rather than imported because this harness also runs from
 * deploy/package-runtime-bundles.sh against staged tarballs, where no
 * TypeScript build exists. The registry itself is exercised end to end by the
 * orchestrator-level proof (poc/julia-kernel-http-proof.mjs).
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

const [juliaRoot, bridgeRoot, workerPath] = process.argv.slice(2);
if (!juliaRoot || !bridgeRoot || !workerPath) {
	throw new Error("usage: smoke-julia-bundles.mjs <julia-root> <bridge-root> <worker.mjs>");
}

const JULIA_GUEST_ROOT = "/opt/runtime/julia";
const JULIA_GUEST = `${JULIA_GUEST_ROOT}/bin/julia`;
const JULIA_DEPOT_GUEST = `${JULIA_GUEST_ROOT}/depot`;
const JULIA_PROJECT_GUEST = `${JULIA_DEPOT_GUEST}/environments/v1.11`;
const JULIA_LAUNCHER_GUEST = `${JULIA_GUEST_ROOT}/launch_kernel.jl`;
const JULIA_WRITABLE_DEPOT = "/tmp/julia-depot";
const BRIDGE_GUEST = "/opt/choreograph-runtime/bridges/jupyter-bridge";
const WORKER_GUEST = "/sandbox/worker.mjs";

const TIMEOUT_MS = 30_000;
// The bridge allows 90 s for a cold kernel to open its IPC sockets and then
// 30 s for kernel_info. Stay outside that so a bridge failure wins the race and
// keeps its diagnostic stderr.
const STARTUP_TIMEOUT_MS = 150_000;
// Julia unwinds a SIGINT through the scheduler rather than a C-level signal
// handler, so it is measurably less instant than CPython's. Still a hard bound.
const INTERRUPT_TIMEOUT_MS = 10_000;

const JULIA_KERNEL_ARGV = [
	JULIA_GUEST,
	"-i",
	"--color=yes",
	"--startup-file=no",
	"--history-file=no",
	`--project=${JULIA_PROJECT_GUEST}`,
	JULIA_LAUNCHER_GUEST,
	"{connection_file}",
];

const JULIA_ENV = {
	JULIA_DEPOT_PATH: `${JULIA_WRITABLE_DEPOT}:${JULIA_DEPOT_GUEST}`,
	JULIA_HISTORY: `${JULIA_WRITABLE_DEPOT}/repl_history.jl`,
	JULIA_PKG_OFFLINE: "true",
	JULIA_NUM_THREADS: "1",
};

function bridgeCommand({ julia = JULIA_GUEST, bridge = BRIDGE_GUEST, launcher = JULIA_LAUNCHER_GUEST } = {}) {
	const argv = [...JULIA_KERNEL_ARGV];
	argv[0] = julia;
	argv[argv.length - 2] = launcher;
	return [
		bridge,
		"--protocol",
		"kernel",
		"--kernel-name",
		"julia",
		...argv.flatMap((argument) => ["--kernel-argv", argument]),
	];
}

function bwrapArgs(command, extraMounts = []) {
	const args = ["--unshare-all", "--die-with-parent", "--ro-bind", "/usr", "/usr"];
	if (existsSync("/lib64")) {
		args.push("--ro-bind", "/lib64", "/lib64");
	}
	args.push(
		"--symlink",
		"/usr/lib",
		"/lib",
		"--symlink",
		"/usr/bin",
		"/bin",
		"--dir",
		"/opt",
		"--dir",
		"/opt/runtime",
		"--dir",
		"/opt/choreograph-runtime",
		"--ro-bind",
		juliaRoot,
		JULIA_GUEST_ROOT,
		"--ro-bind",
		bridgeRoot,
		"/opt/choreograph-runtime/bridges",
		...extraMounts,
		"--tmpfs",
		"/tmp",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--cap-drop",
		"ALL",
		"--clearenv",
		"--setenv",
		"HOME",
		"/tmp",
		"--setenv",
		"PATH",
		"/nonexistent",
	);
	for (const [key, value] of Object.entries(JULIA_ENV)) {
		args.push("--setenv", key, value);
	}
	args.push("--", ...command);
	return args;
}

function withTimeout(promise, label, timeoutMs = TIMEOUT_MS) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
		}),
	]).finally(() => clearTimeout(timer));
}

class NdjsonProcess {
	constructor(label, command, commandArgs) {
		this.label = label;
		this.events = [];
		this.stderr = "";
		this.waiters = new Set();
		this.child = spawn(command, commandArgs, { stdio: ["pipe", "pipe", "pipe"] });
		this.exit = new Promise((resolve, reject) => {
			this.child.once("error", reject);
			this.child.once("close", (code, signal) => {
				for (const waiter of this.waiters) {
					waiter.reject(
						new Error(`${label} exited before ${waiter.label}: code=${code} signal=${signal}\n${this.stderr}`),
					);
				}
				this.waiters.clear();
				resolve({ code, signal });
			});
		});

		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk) => {
			this.stderr = (this.stderr + chunk).slice(-64 * 1024);
		});

		const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
		lines.on("line", (line) => {
			let event;
			try {
				event = JSON.parse(line);
			} catch (error) {
				this.child.kill("SIGKILL");
				for (const waiter of this.waiters) {
					waiter.reject(new Error(`${label} stdout was not NDJSON: ${line}\n${error}`));
				}
				this.waiters.clear();
				return;
			}
			this.events.push(event);
			for (const waiter of [...this.waiters]) {
				if (waiter.predicate(event, this.events)) {
					this.waiters.delete(waiter);
					waiter.resolve(event);
				}
			}
		});
	}

	send(message) {
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	waitFor(predicate, label, timeoutMs = TIMEOUT_MS) {
		const existing = this.events.find((event) => predicate(event, this.events));
		if (existing) return Promise.resolve(existing);
		return withTimeout(
			new Promise((resolve, reject) => {
				this.waiters.add({ predicate, label, resolve, reject });
			}),
			label,
			timeoutMs,
		);
	}

	waitForInput(kind, inputId, timeoutMs = TIMEOUT_MS) {
		return this.waitFor(
			(event) => event.kind === kind && event.input_id === inputId,
			`${kind} for ${inputId}`,
			timeoutMs,
		);
	}
}

class BridgeProcess extends NdjsonProcess {
	constructor(options = {}) {
		super("bridge", "bwrap", bwrapArgs(bridgeCommand(options)));
	}
}

class WorkerProcess extends NdjsonProcess {
	constructor() {
		super(
			"worker",
			"bwrap",
			bwrapArgs([process.execPath, WORKER_GUEST], ["--dir", "/sandbox", "--ro-bind", workerPath, WORKER_GUEST]),
		);
	}

	waitForEvent(type, label = type, timeoutMs = TIMEOUT_MS) {
		return this.waitFor(
			(message) => message.kind === "event" && message.event?.type === type,
			label,
			timeoutMs,
		);
	}
}

async function executeKernel(bridge, inputId, code, timeoutMs = TIMEOUT_MS) {
	bridge.send({ kind: "exec", input_id: inputId, code });
	await Promise.all([
		bridge.waitForInput("reply", inputId, timeoutMs),
		bridge.waitForInput("idle", inputId, timeoutMs),
	]);
	return bridge.events.filter((event) => event.input_id === inputId);
}

function resultText(events) {
	return events.find((event) => event.kind === "result")?.data?.["text/plain"];
}

const checks = [];
function record(name, detail = "") {
	checks.push({ name, detail });
	console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function smokeKernel() {
	const coldStart = Date.now();
	const bridge = new BridgeProcess();
	const ready = await bridge.waitFor((event) => event.kind === "ready", "kernel ready", STARTUP_TIMEOUT_MS);
	const coldReadyMs = Date.now() - coldStart;
	assert.equal(ready.kernel, "julia", "the bridge must report the kernel name it was launched with");
	record("kernel_ready (cold spawn → ready)", `${coldReadyMs} ms`);

	// The biggest technical risk in this slice: the sandbox is --unshare-all, so
	// ZMQ has to speak ipc:// over unix sockets. Ask the live kernel what it
	// actually bound, from inside its own process.
	let events = await executeKernel(
		bridge,
		"ipc",
		`import IJulia
p = IJulia.profile
socks = ["$(p["ip"])-$(p[k])" for k in ("shell_port", "iopub_port", "control_port", "stdin_port", "hb_port")]
(p["transport"], count(issocket, socks), count(startswith("/"), socks))`,
	);
	const ipcVerdict = resultText(events);
	assert.equal(
		ipcVerdict,
		'("ipc", 5, 5)',
		`IJulia must bind all five channels as unix-domain ipc sockets, got: ${ipcVerdict}`,
	);
	record("ZMQ.jl honours transport:ipc from the connection file", ipcVerdict);

	events = await executeKernel(bridge, "result", "6 * 7");
	assert.equal(resultText(events), "42");
	record("execute_result text/plain === 42");

	bridge.send({ kind: "exec", input_id: "streams", code: 'println("hello")\nprintln(stderr, "warning")\nnothing' });
	const [stdout, stderr] = await Promise.all([
		bridge.waitFor(
			(event) => event.kind === "stream" && event.input_id === "streams" && event.name === "stdout",
			"stdout stream",
		),
		bridge.waitFor(
			(event) => event.kind === "stream" && event.input_id === "streams" && event.name === "stderr",
			"stderr stream",
		),
	]);
	await Promise.all([bridge.waitForInput("reply", "streams"), bridge.waitForInput("idle", "streams")]);
	assert.equal(stdout.text, "hello\n");
	assert.equal(stderr.text, "warning\n");
	record("stdout + stderr streams");

	events = await executeKernel(
		bridge,
		"display",
		`struct Garden end
Base.show(io::IO, ::MIME"text/html", ::Garden) = print(io, "<b>garden</b>")
display(Garden())
nothing`,
	);
	assert.equal(events.find((event) => event.kind === "display")?.data?.["text/html"], "<b>garden</b>");
	record("display_data text/html");

	events = await executeKernel(bridge, "state-a", "x = 40");
	assert.equal(resultText(events), "40");
	events = await executeKernel(bridge, "state-b", "x + 2");
	assert.equal(resultText(events), "42", "the Julia session must persist across cells");
	record("cross-cell state persistence (x=40 … x+2 → 42)");

	events = await executeKernel(bridge, "error", 'error("boom")');
	const error = events.find((event) => event.kind === "error");
	assert.ok(error, "a failing cell must emit a kernel error");
	// IJulia evaluates every cell through include_string, so a cell exception
	// surfaces wrapped: ename is LoadError with the real cause inside evalue.
	// That is a genuine difference from ipykernel and a renderer has to unwrap it.
	assert.ok(
		["LoadError", "ErrorException"].includes(error.ename),
		`unexpected Julia error ename: ${error.ename}`,
	);
	assert.match(`${error.evalue}\n${(error.traceback ?? []).join("\n")}`, /boom/);
	assert.ok(Array.isArray(error.traceback) && error.traceback.length > 0, "a real Julia traceback is required");
	assert.doesNotMatch(JSON.stringify(error.traceback), /\\u001b|\x1b/, "tracebacks must not contain ANSI escapes");
	assert.equal(
		events.find((event) => event.kind === "reply")?.status,
		"error",
		"a failing cell must reply with status=error",
	);
	record("real Julia error + traceback", `${error.ename}: ${error.evalue.trim().split("\n")[0]}`);

	bridge.send({
		kind: "exec",
		input_id: "interrupt",
		code: 'println("interrupt-ready")\nflush(stdout)\nsleep(60)',
	});
	await bridge.waitForInput("busy", "interrupt");
	// `busy` fires before the cell body necessarily starts. Interrupting in that
	// gap can land before `sleep` and leave the cell asleep for a minute, which
	// would make this a scheduler race rather than a test.
	await bridge.waitFor(
		(event) =>
			event.kind === "stream" &&
			event.input_id === "interrupt" &&
			event.name === "stdout" &&
			event.text.includes("interrupt-ready"),
		"interrupt execution marker",
	);
	const interruptedAt = Date.now();
	bridge.send({ kind: "interrupt" });
	const interrupted = await bridge.waitForInput("error", "interrupt", INTERRUPT_TIMEOUT_MS);
	await bridge.waitForInput("idle", "interrupt", INTERRUPT_TIMEOUT_MS);
	const interruptMs = Date.now() - interruptedAt;
	// Same include_string wrapping as above: assert on the cause, wherever the
	// wrapper put it, rather than on a shape that would let a hang pass.
	assert.match(
		`${interrupted.ename}\n${interrupted.evalue}\n${(interrupted.traceback ?? []).join("\n")}`,
		/InterruptException/,
		`interrupt must surface an InterruptException, got ${interrupted.ename}: ${interrupted.evalue}`,
	);
	assert.ok(interruptMs < INTERRUPT_TIMEOUT_MS, `interrupt must settle within ${INTERRUPT_TIMEOUT_MS}ms`);
	record(
		"interrupt of a running sleep(60) → InterruptException",
		`${interruptMs} ms, ename=${interrupted.ename}`,
	);

	events = await executeKernel(bridge, "recover", "1 + 1");
	assert.equal(resultText(events), "2");
	record("kernel recovers after interrupt");

	bridge.send({ kind: "close" });
	bridge.child.stdin.end();
	const status = await withTimeout(bridge.exit, "kernel bridge exit");
	assert.equal(status.code, 0, bridge.stderr);
	record("clean bridge shutdown (exit 0)");

	return coldReadyMs;
}

async function smokeMissingGuest() {
	for (const options of [{ julia: `${JULIA_GUEST_ROOT}/bin/missing` }, { launcher: `${JULIA_GUEST_ROOT}/missing.jl` }]) {
		const bridge = new BridgeProcess(options);
		bridge.child.stdin.end();
		const status = await withTimeout(bridge.exit, "missing guest failure", STARTUP_TIMEOUT_MS);
		assert.notEqual(status.code, 0, "a missing Julia guest must fail closed");
		assert.equal(
			bridge.events.some((event) => event.kind === "ready"),
			false,
			"a missing Julia guest must never emit ready",
		);
	}
	record("missing Julia guest fails closed (binary + launcher)");
}

async function smokeWorkerKernel() {
	const worker = new WorkerProcess();
	worker.send({
		kind: "init",
		config: { mode: "kernel", kernel: "julia", bridge_command: bridgeCommand() },
	});
	const ready = await worker.waitForEvent("kernel_ready", "kernel_ready", STARTUP_TIMEOUT_MS);
	assert.equal(ready.event.kernel, "julia");

	worker.send({
		kind: "kernel_execute",
		input_id: "worker-kernel",
		code: 'println(Sys.BINDIR)\n6 * 7',
	});
	const [stream, result, reply, idle] = await Promise.all([
		worker.waitForEvent("kernel_stream"),
		worker.waitForEvent("kernel_result"),
		worker.waitForEvent("kernel_reply"),
		worker.waitForEvent("kernel_idle"),
	]);
	assert.equal(stream.event.input_id, "worker-kernel");
	assert.equal(stream.event.name, "stdout");
	assert.equal(stream.event.text, `${JULIA_GUEST_ROOT}/bin\n`);
	assert.equal(result.event.data?.["text/plain"], "42");
	assert.equal(reply.event.status, "ok");
	assert.equal(idle.event.input_id, "worker-kernel");

	worker.send({ kind: "kernel_close" });
	worker.child.stdin.end();
	const status = await withTimeout(worker.exit, "kernel worker exit");
	assert.equal(status.code, 0, worker.stderr);
	assert.equal(
		worker.events.filter((message) => message.kind === "event" && message.event?.type === "kernel_exit").length,
		1,
		"the worker must emit exactly one kernel_exit",
	);
	const terminal = worker.events.filter((message) => message.kind === "result");
	assert.equal(terminal.length, 1, "the worker must emit exactly one terminal result");
	assert.equal(terminal[0].result?.status, "done");
	record("worker mode:kernel kernel:julia round trip");
}

console.log("julia runtime bundle smoke — worker + Rust bridge + bundled Julia/IJulia under bwrap");
const coldReadyMs = await smokeKernel();
await smokeMissingGuest();
await smokeWorkerKernel();
console.log(`\n${checks.length}/${checks.length} checks passed — julia kernel cold-ready in ${coldReadyMs} ms`);
