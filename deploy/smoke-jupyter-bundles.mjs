#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [pythonRoot, bridgeRoot, kernelRuntimeRoot, workerPath] = process.argv.slice(2);
if (!pythonRoot || !bridgeRoot || !kernelRuntimeRoot || !workerPath) {
	throw new Error(
		"usage: smoke-jupyter-bundles.mjs <python-root> <bridge-root> <kernel-runtime-root> <worker.mjs>",
	);
}

const PYTHON_GUEST = "/opt/runtime/python/bin/python3";
const BRIDGE_GUEST = "/opt/choreograph-runtime/bridges/jupyter-bridge";
const KERNEL_RUNTIME_GUEST = "/opt/choreograph-runtime/sophia-kernel-runtime";
const KERNEL_RUNTIME_PYTHON_GUEST = `${KERNEL_RUNTIME_GUEST}/src`;
const WORKER_GUEST = "/sandbox/worker.mjs";
const TIMEOUT_MS = 30_000;
// The bridge allows 90 seconds for a cold kernel to open its IPC sockets and
// then 30 seconds for kernel_info. Keep the harness outside that production
// bound so a bridge failure wins the race and preserves its diagnostic stderr.
const STARTUP_TIMEOUT_MS = 150_000;

function bwrapArgs(command, extraMounts = []) {
	const args = [
		"--unshare-all",
		"--die-with-parent",
		"--ro-bind",
		"/usr",
		"/usr",
	];
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
		pythonRoot,
		"/opt/runtime/python",
		"--ro-bind",
		bridgeRoot,
		"/opt/choreograph-runtime/bridges",
		"--ro-bind",
		kernelRuntimeRoot,
		KERNEL_RUNTIME_GUEST,
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
		"--setenv",
		"PYTHONNOUSERSITE",
		"1",
		"--",
		...command,
	);
	return args;
}

function bridgeCommand(protocol) {
	return [
		BRIDGE_GUEST,
		"--protocol",
		protocol,
		"--python",
		PYTHON_GUEST,
		"--runtime-root",
		KERNEL_RUNTIME_PYTHON_GUEST,
	];
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

class BridgeProcess {
	constructor(
		protocol,
		{ python = PYTHON_GUEST, bridge = BRIDGE_GUEST, extraArgs = [], sandbox = true } = {},
	) {
		this.events = [];
		this.stderr = "";
		this.waiters = new Set();
		const command = sandbox ? "bwrap" : `${bridgeRoot}/jupyter-bridge`;
		const commandArgs = sandbox
			? bwrapArgs([
					bridge,
					"--protocol",
					protocol,
					"--python",
					python,
					"--runtime-root",
					KERNEL_RUNTIME_PYTHON_GUEST,
					...extraArgs,
				])
			: [
					"--protocol",
					protocol,
					"--python",
					`${pythonRoot}/bin/python3`,
					"--runtime-root",
					`${kernelRuntimeRoot}/src`,
					...extraArgs,
				];
		this.child = spawn(command, commandArgs, {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PYTHONPATH: "/tmp/host-poison" },
		});
		this.exit = new Promise((resolve, reject) => {
			this.child.once("error", reject);
			this.child.once("close", (code, signal) => {
				for (const waiter of this.waiters) {
					waiter.reject(
						new Error(
							`bridge exited before ${waiter.label}: code=${code} signal=${signal}\n${this.stderr}`,
						),
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
					waiter.reject(new Error(`bridge stdout was not NDJSON: ${line}\n${error}`));
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

class WorkerProcess {
	constructor() {
		this.events = [];
		this.stderr = "";
		this.waiters = new Set();
		this.child = spawn(
			"bwrap",
			bwrapArgs([process.execPath, WORKER_GUEST], [
				"--dir",
				"/sandbox",
				"--ro-bind",
				workerPath,
				WORKER_GUEST,
			]),
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		this.exit = new Promise((resolve, reject) => {
			this.child.once("error", reject);
			this.child.once("close", (code, signal) => {
				for (const waiter of this.waiters) {
					waiter.reject(
						new Error(
							`worker exited before ${waiter.label}: code=${code} signal=${signal}\n${this.stderr}`,
						),
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
					waiter.reject(new Error(`worker stdout was not NDJSON: ${line}\n${error}`));
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

	waitForEvent(type, label = type, timeoutMs = TIMEOUT_MS) {
		return this.waitFor(
			(message) => message.kind === "event" && message.event?.type === type,
			label,
			timeoutMs,
		);
	}
}

async function smokeRuntime() {
	const bridge = new BridgeProcess("runtime");
	await bridge.waitFor(
		(event) => event.kind === "ready",
		"runtime ready",
		STARTUP_TIMEOUT_MS,
	);

	const inputs = [
		{
			input_id: "probe",
			code: "import dill, httpx, json, mcp, os, pathlib, sys, tyro, ipykernel, jupyter_client, zmq, rlm, rlm.mcp_base, rlm.skill\nprint(json.dumps([os.environ['PYTHONPATH'], str(pathlib.Path(rlm.__file__).parent), sys.executable], separators=(',', ':')))\nTrue",
		},
		{
			input_id: "one",
			code: "import sys\nx = 40\nprint('hello')\nprint('warning', file=sys.stderr)\nx + 2",
		},
		{ input_id: "two", code: "x += 3\nx" },
		{ input_id: "error", code: "print('before-error')\n1 / 0" },
		{ input_id: "recover", code: "6 * 7" },
	];
	for (const input of inputs) {
		bridge.send({ kind: "exec", ...input });
	}
	// The close is deliberately immediate: every already accepted command must
	// finish FIFO before the Rust controller shuts the kernel down.
	bridge.send({ kind: "close" });
	bridge.child.stdin.end();

	const status = await withTimeout(bridge.exit, "runtime bridge exit");
	assert.equal(status.code, 0, bridge.stderr);
	const results = bridge.events.filter((event) => event.kind === "exec_result");
	assert.deepEqual(
		results.map((event) => event.input_id),
		inputs.map((input) => input.input_id),
		"runtime close must drain every accepted input in FIFO order",
	);
	assert.equal(results[0].ok, true);
	assert.deepEqual(
		JSON.parse(results[0].stdout.trim()),
		[KERNEL_RUNTIME_PYTHON_GUEST, `${KERNEL_RUNTIME_PYTHON_GUEST}/rlm`, PYTHON_GUEST],
		"runtime paths must retain their exact guest identities",
	);
	assert.equal(results[0].result, "True");
	assert.equal(results[1].stdout, "hello\n");
	assert.equal(results[1].stderr, "warning\n");
	assert.equal(results[1].result, "42");
	assert.equal(results[2].result, "43", "the Python scope must persist across requests");
	assert.equal(results[3].ok, false);
	assert.match(results[3].error, /ZeroDivisionError: division by zero/);
	assert.doesNotMatch(results[3].error, /\u001b|\x1b/, "runtime errors must not contain ANSI escapes");
	assert.equal(results[4].ok, true, "the runtime must recover after an exception");
	assert.equal(results[4].result, "42");
}

async function executeKernel(bridge, inputId, code) {
	bridge.send({ kind: "exec", input_id: inputId, code });
	await Promise.all([
		bridge.waitForInput("reply", inputId),
		bridge.waitForInput("idle", inputId),
	]);
	return bridge.events.filter((event) => event.input_id === inputId);
}

async function smokeKernel() {
	const bridge = new BridgeProcess("kernel");
	await bridge.waitFor(
		(event) => event.kind === "ready",
		"kernel ready",
		STARTUP_TIMEOUT_MS,
	);

	let events = await executeKernel(bridge, "result", "6 * 7");
	assert.equal(events.find((event) => event.kind === "result")?.data?.["text/plain"], "42");

	events = await executeKernel(
		bridge,
		"display",
		"from IPython.display import display, HTML\ndisplay(HTML('<b>garden</b>'))",
	);
	assert.equal(events.find((event) => event.kind === "display")?.data?.["text/html"], "<b>garden</b>");

	events = await executeKernel(bridge, "error", "raise ValueError('boom')");
	const error = events.find((event) => event.kind === "error");
	assert.equal(error?.ename, "ValueError");
	assert.doesNotMatch(JSON.stringify(error?.traceback), /\\u001b|\x1b/);

	bridge.send({
		kind: "exec",
		input_id: "interrupt",
		code: "import time\nprint('interrupt-ready', flush=True)\ntime.sleep(60)",
	});
	await bridge.waitForInput("busy", "interrupt");
	// `busy` is emitted before the cell necessarily begins executing. Sending
	// SIGINT in that gap can be consumed before `sleep`, leaving the cell asleep
	// for 60 seconds and turning this into a flaky scheduler race. The stream
	// marker proves the cell reached its interruptible body while retaining the
	// five-second interruption requirement below.
	await bridge.waitFor(
		(event) =>
			event.kind === "stream" &&
			event.input_id === "interrupt" &&
			event.name === "stdout" &&
			event.text === "interrupt-ready\n",
		"interrupt execution marker",
	);
	const interruptedAt = Date.now();
	bridge.send({ kind: "interrupt" });
	const interrupted = await bridge.waitForInput("error", "interrupt", 5_000);
	await bridge.waitForInput("idle", "interrupt", 5_000);
	assert.equal(interrupted.ename, "KeyboardInterrupt");
	assert.ok(Date.now() - interruptedAt < 5_000, "interrupt must settle within five seconds");

	events = await executeKernel(bridge, "recover", "1 + 1");
	assert.equal(events.find((event) => event.kind === "result")?.data?.["text/plain"], "2");

	bridge.send({ kind: "close" });
	bridge.child.stdin.end();
	const status = await withTimeout(bridge.exit, "kernel bridge exit");
	assert.equal(status.code, 0, bridge.stderr);
}

async function smokeMissingGuest() {
	for (const options of [
		{ python: "/opt/runtime/python/bin/missing" },
		{ bridge: "/opt/choreograph-runtime/bridges/missing" },
	]) {
		const bridge = new BridgeProcess("runtime", options);
		bridge.child.stdin.end();
		const status = await withTimeout(bridge.exit, "missing guest failure");
		assert.notEqual(status.code, 0, "missing guest executable must fail closed");
		assert.equal(
			bridge.events.some((event) => event.kind === "ready"),
			false,
			"missing guest executable must never emit ready",
		);
	}
}

function smokeConsoleEntrypoint() {
	const result = spawnSync("bwrap", bwrapArgs(["/opt/runtime/python/bin/ipython", "--version"]), {
		encoding: "utf8",
	});
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.match(result.stdout, /^9\.15\.0\s*$/);
}

async function smokeDrainTimeout() {
	const bridge = new BridgeProcess("runtime", {
		extraArgs: ["--drain-timeout-ms", "100"],
	});
	await bridge.waitFor(
		(event) => event.kind === "ready",
		"drain-timeout ready",
		STARTUP_TIMEOUT_MS,
	);
	bridge.send({ kind: "exec", input_id: "slow", code: "import time\ntime.sleep(60)" });
	bridge.send({ kind: "close" });
	bridge.child.stdin.end();
	const status = await withTimeout(bridge.exit, "drain-timeout exit", 15_000);
	assert.notEqual(status.code, 0, "a close drain timeout must fail the bridge");
	const result = bridge.events.find(
		(event) => event.kind === "exec_result" && event.input_id === "slow",
	);
	assert.equal(result?.ok, false);
	assert.equal(result?.error, "runtime close drain timed out");
}

async function smokeWorkerRuntime() {
	const worker = new WorkerProcess();
	worker.send({
		kind: "init",
		config: {
			mode: "runtime",
			runtime: "python",
			bridge_command: bridgeCommand("runtime"),
		},
	});
	await worker.waitForEvent("runtime_ready", "runtime_ready", STARTUP_TIMEOUT_MS);
	worker.send({
		kind: "runtime_input",
		input_id: "worker-runtime",
		code: "import sys\nprint(sys.executable)\n6 * 7",
	});
	const [stdout, result] = await Promise.all([
		worker.waitForEvent("runtime_stdout"),
		worker.waitForEvent("runtime_result"),
	]);
	assert.equal(stdout.event.input_id, "worker-runtime");
	assert.equal(stdout.event.text, `${PYTHON_GUEST}\n`);
	assert.deepEqual(result.event, {
		type: "runtime_result",
		input_id: "worker-runtime",
		ok: true,
		result: "42",
	});

	worker.send({ kind: "runtime_close" });
	worker.child.stdin.end();
	const status = await withTimeout(worker.exit, "runtime worker exit");
	assert.equal(status.code, 0, worker.stderr);
	assert.equal(
		worker.events.filter(
			(message) => message.kind === "event" && message.event?.type === "runtime_exit",
		).length,
		1,
		"the worker must emit exactly one runtime_exit",
	);
	const terminal = worker.events.filter((message) => message.kind === "result");
	assert.equal(terminal.length, 1, "the worker must emit exactly one terminal result");
	assert.equal(terminal[0].result?.status, "done");
}

async function smokeWorkerKernel() {
	const worker = new WorkerProcess();
	worker.send({
		kind: "init",
		config: {
			mode: "kernel",
			kernel: "python3",
			bridge_command: bridgeCommand("kernel"),
		},
	});
	await worker.waitForEvent("kernel_ready", "kernel_ready", STARTUP_TIMEOUT_MS);
	worker.send({
		kind: "kernel_execute",
		input_id: "worker-kernel",
		code: "import sys\nprint(sys.executable)\n6 * 7",
	});
	const [stream, result, reply, idle] = await Promise.all([
		worker.waitForEvent("kernel_stream"),
		worker.waitForEvent("kernel_result"),
		worker.waitForEvent("kernel_reply"),
		worker.waitForEvent("kernel_idle"),
	]);
	assert.equal(stream.event.input_id, "worker-kernel");
	assert.equal(stream.event.name, "stdout");
	assert.equal(stream.event.text, `${PYTHON_GUEST}\n`);
	assert.equal(result.event.input_id, "worker-kernel");
	assert.equal(result.event.data?.["text/plain"], "42");
	assert.equal(reply.event.status, "ok");
	assert.equal(idle.event.input_id, "worker-kernel");

	worker.send({ kind: "kernel_close" });
	worker.child.stdin.end();
	const status = await withTimeout(worker.exit, "kernel worker exit");
	assert.equal(status.code, 0, worker.stderr);
	assert.equal(
		worker.events.filter(
			(message) => message.kind === "event" && message.event?.type === "kernel_exit",
		).length,
		1,
		"the worker must emit exactly one kernel_exit",
	);
	const terminal = worker.events.filter((message) => message.kind === "result");
	assert.equal(terminal.length, 1, "the worker must emit exactly one terminal result");
	assert.equal(terminal[0].result?.status, "done");
}

function descendants(parentPid) {
	const discovered = [];
	const pending = [parentPid];
	while (pending.length > 0) {
		const pid = pending.shift();
		let children;
		try {
			children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
				.trim()
				.split(/\s+/)
				.filter(Boolean)
				.map(Number);
		} catch {
			continue;
		}
		for (const child of children) {
			discovered.push(child);
			pending.push(child);
		}
	}
	return discovered;
}

function commandLine(pid) {
	try {
		return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
	} catch {
		return "";
	}
}

async function waitForProcess(rootPid, pattern, label) {
	return withTimeout(
		(async () => {
			for (;;) {
				const match = [rootPid, ...descendants(rootPid)].find((pid) => pattern.test(commandLine(pid)));
				if (match) return match;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		})(),
		label,
		5_000,
	);
}

async function smokeParentDeath() {
	if (process.platform !== "linux") return;
	// This one deliberately runs the artifact directly (the behavioral suite
	// above is bwrapped). The process topology is equivalent: bwrap ultimately
	// execs the bridge as the sandbox-root process, which then directly spawns
	// ipykernel. Direct execution makes the host PID exactly the Rust controller
	// PID, so PR_SET_PDEATHSIG can be falsified independently of namespace
	// teardown. The assertion below follows the exact captured child PID.
	const bridge = new BridgeProcess("runtime", { sandbox: false });
	await bridge.waitFor(
		(event) => event.kind === "ready",
		"parent-death ready",
		STARTUP_TIMEOUT_MS,
	);
	const kernelPid = await waitForProcess(
		bridge.child.pid,
		/ipykernel_launcher/,
		"find ipykernel pid",
	);
	process.kill(bridge.child.pid, "SIGKILL");
	bridge.child.stdin.end();
	await withTimeout(bridge.exit, "bridge exit after SIGKILL", 5_000);
	await withTimeout(
		(async () => {
			while (existsSync(`/proc/${kernelPid}`)) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		})(),
		"ipykernel parent-death cleanup",
		2_000,
	);
	assert.equal(existsSync(`/proc/${kernelPid}`), false, "SIGKILLed bridge must not orphan ipykernel");
}

await smokeRuntime();
await smokeKernel();
await smokeMissingGuest();
smokeConsoleEntrypoint();
await smokeDrainTimeout();
await smokeWorkerRuntime();
await smokeWorkerKernel();
await smokeParentDeath();
console.log("runtime bundle smoke: worker + Rust bridge + bundled Python/Jupyter passed under bwrap");
