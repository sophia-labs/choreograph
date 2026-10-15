#!/usr/bin/env node

/**
 * Runtime bundle smoke for the C++ kernel: worker + Rust bridge + the bundled
 * xeus-cpp/clang-repl toolchain, all under real bwrap. Fourth instance of the
 * shape established by smoke-jupyter-bundles.mjs (Python), then Julia, then
 * OCaml.
 *
 * The launch argv mirrors src/kernel-bridges.ts. It is duplicated rather than
 * imported because this harness also runs from deploy/package-runtime-bundles.sh
 * against staged tarballs, where no TypeScript build exists — but unlike the
 * other three, the duplication here is *checked*: the payload records the flags
 * its build verified, and the first assertion below compares them.
 *
 * ── WHAT IS DIFFERENT ABOUT THIS KERNEL ────────────────────────────────────
 * Three things, all read out of xeus-cpp 0.10.0 and xeus/xeus-zmq at main, and
 * all of them change what a check is allowed to assert:
 *
 *   1. There are no execute_result messages. At all. The block that publishes a
 *      mime bundle for a cell's value is commented out in
 *      src/xinterpreter.cpp:387-395, and `publish_execution_result` and
 *      `mime_repr` appear nowhere else in the repository. A C++ cell's value is
 *      whatever it printed.
 *
 *   2. transport:ipc is already correct. xeus-zmq builds every endpoint with
 *      `char sep = (transport == "tcp") ? ':' : '-';`
 *      (src/common/xmiddleware.cpp, get_end_point) — the hyphen the Jupyter
 *      convention and the Rust bridge both expect. OCaml needed a patch here;
 *      this kernel needs none, which is asserted rather than assumed below.
 *
 *   3. Interrupt kills the kernel. main.cpp:59 installs
 *      `signal(SIGINT, xcpp::stop_handler)` and xutils.cpp's stop_handler is
 *      `exit(0)`. The bridge interrupts by sending SIGINT to the kernel process
 *      (crates/jupyter-bridge/src/main.rs, BridgeCommand::Interrupt), so a stop
 *      on this kernel is a kill, running or idle. That is a product finding,
 *      not a bug in this harness, and the last three checks pin it down so it
 *      cannot regress quietly in either direction.
 *
 * NEEDS-CLOUD-PROOF markers below flag every assertion that was written from
 * upstream source without being executed. The first cloud build adjudicates
 * them; each one names what it expects and why, so a failure is a reading, not
 * a mystery.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [cppRoot, bridgeRoot, workerPath] = process.argv.slice(2);
if (!cppRoot || !bridgeRoot || !workerPath) {
	throw new Error("usage: smoke-cpp-bundles.mjs <cpp-root> <bridge-root> <worker.mjs>");
}

const CPP_GUEST_ROOT = "/opt/runtime/cpp";
const CPP_KERNEL_GUEST = `${CPP_GUEST_ROOT}/bin/xcpp`;
const CPP_TOOLCHAIN_GUEST = `${CPP_GUEST_ROOT}/share/choreograph`;
const CPP_STD = "c++20";
const BRIDGE_GUEST = "/opt/choreograph-runtime/bridges/jupyter-bridge";
const WORKER_GUEST = "/sandbox/worker.mjs";

const TIMEOUT_MS = 60_000;
// The bridge allows 90 s for a cold kernel to open its IPC sockets and then
// 30 s for kernel_info. Stay outside that so a bridge failure wins the race and
// keeps its diagnostic stderr. Cold here means building a full clang
// CompilerInstance, which is the slowest of the four kernels by a wide margin.
const STARTUP_TIMEOUT_MS = 150_000;
const INTERRUPT_TIMEOUT_MS = 10_000;
// How long an unarrived stream is given before it is called absent. Generous on
// purpose: this bound decides a recorded finding, not a pass.
const STREAM_PROBE_MS = 4_000;

/**
 * Everything after the connection file is compiler configuration, and it is
 * here because xeus-cpp cannot discover it inside the sandbox: its resource
 * directory comes from popen("clang -print-resource-dir") and its system
 * includes from popen("c++ -xc++ -E -v /dev/null") (CppInterOp v1.9.0
 * lib/CppInterOp/CppInterOp.cpp:3572 and :3589), and the sandbox has
 * PATH=/nonexistent and no compiler.
 */
const CPP_CLANG_ARGS = [
	`-std=${CPP_STD}`,
	"-resource-dir",
	`${CPP_TOOLCHAIN_GUEST}/resource-dir`,
	`--gcc-toolchain=${CPP_TOOLCHAIN_GUEST}/gcc-toolchain`,
	`--sysroot=${CPP_TOOLCHAIN_GUEST}/sysroot`,
	"-I",
	`${CPP_GUEST_ROOT}/include`,
];

const CPP_KERNEL_ARGV = [CPP_KERNEL_GUEST, "-f", "{connection_file}", ...CPP_CLANG_ARGS];

/** The bundle is read-only and /tmp is the sandbox's tmpfs; clang-repl needs one writable path. */
const CPP_ENV = { TMPDIR: "/tmp" };

function bridgeCommand({ kernel = CPP_KERNEL_GUEST, bridge = BRIDGE_GUEST } = {}) {
	const argv = [...CPP_KERNEL_ARGV];
	argv[0] = kernel;
	return [
		bridge,
		"--protocol",
		"kernel",
		"--kernel-name",
		"cpp",
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
		cppRoot,
		CPP_GUEST_ROOT,
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
	for (const [key, value] of Object.entries(CPP_ENV)) {
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
			// A wedged kernel is silent by definition; the bridge's stderr is the
			// only place its diagnosis exists, so a timeout must carry it. xcpp is
			// also the one kernel that writes to its own stderr on the way up —
			// clang's `-v` banner — so that stream is unusually informative here.
		).catch((error) => {
			throw new Error(`${error.message}\n--- ${this.label} stderr ---\n${this.stderr}`);
		});
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
		return this.waitFor((message) => message.kind === "event" && message.event?.type === type, label, timeoutMs);
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

function streamText(events, name) {
	return events
		.filter((event) => event.kind === "stream" && event.name === name)
		.map((event) => event.text)
		.join("");
}

const checks = [];
function record(name, detail = "") {
	checks.push({ name, detail });
	console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ""}`);
}

/**
 * The cell that answers the transport question from the kernel's namespace
 * rather than from the kernel's opinion: /proc/net/unix is the OS socket table
 * and /proc/net/tcp state 0A is LISTEN.
 *
 * It also happens to be the widest header test in the battery — <fstream>,
 * <sstream>, <string>, <vector>, <algorithm> — so if the bundled sysroot and
 * libstdc++ headers are not reachable, this cell is where it shows, loudly,
 * before any subtler check has a chance to be confusing.
 */
const IPC_VERDICT_CELL = `#include <algorithm>
#include <fstream>
#include <iostream>
#include <iterator>
#include <sstream>
#include <string>
#include <vector>

std::string slurp(const char* path) {
    std::ifstream in(path, std::ios::binary);
    return std::string((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
}

std::vector<std::string> lines_of(const char* path) {
    std::vector<std::string> out;
    std::ifstream in(path);
    std::string line;
    while (std::getline(in, line)) out.push_back(line);
    return out;
}

std::string connection_file_from_cmdline() {
    std::string raw = slurp("/proc/self/cmdline");
    std::vector<std::string> argv;
    std::string current;
    for (char c : raw) {
        if (c == '\\0') { argv.push_back(current); current.clear(); }
        else current.push_back(c);
    }
    if (!current.empty()) argv.push_back(current);
    for (std::size_t i = 0; i + 1 < argv.size(); ++i)
        if (argv[i] == "-f") return argv[i + 1];
    return std::string();
}

std::string connection_file = connection_file_from_cmdline();
std::string connection_json = slurp(connection_file.c_str());
bool ipc = connection_json.find("\\"transport\\":\\"ipc\\"") != std::string::npos;

std::vector<std::string> unix_paths;
for (const std::string& line : lines_of("/proc/net/unix")) {
    std::size_t space = line.find_last_of(' ');
    if (space == std::string::npos || space + 1 >= line.size()) continue;
    if (line[space + 1] != '/') continue;
    unix_paths.push_back(line.substr(space + 1));
}

std::string prefix = connection_file.substr(0, connection_file.rfind(".json"));
int bound = 0;
for (int channel = 1; channel <= 5; ++channel) {
    std::ostringstream socket_path;
    socket_path << prefix << "-" << channel;
    if (std::find(unix_paths.begin(), unix_paths.end(), socket_path.str()) != unix_paths.end()) ++bound;
}

int listeners = 0;
for (const char* table : {"/proc/net/tcp", "/proc/net/tcp6"}) {
    bool header = true;
    for (const std::string& line : lines_of(table)) {
        if (header) { header = false; continue; }
        std::istringstream fields(line);
        std::string slot, local, remote, state;
        if (fields >> slot >> local >> remote >> state && state == "0A") ++listeners;
    }
}

std::cout << "ipc=" << (ipc ? 1 : 0) << " unix=" << bound << " tcp=" << listeners << std::endl;`;

function assertToolchainAgreement() {
	// Before anything is launched. The payload writes the flags its build
	// verified a #include <iostream> against; this harness and src/kernel-bridges.ts
	// carry the flags the kernel is actually launched with. A kernel launched
	// with flags nothing proved starts fine and then cannot compile anything,
	// which presents as a user error and is not one.
	const manifestPath = `${cppRoot}/share/choreograph/toolchain.json`;
	assert.ok(existsSync(manifestPath), `the payload must carry its toolchain manifest at ${manifestPath}`);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	assert.equal(manifest.schema, "choreograph.cpp-runtime/1");
	assert.deepEqual(
		manifest.clang_args,
		CPP_CLANG_ARGS,
		"the launch flags must be exactly the ones the payload build verified",
	);
	assert.equal(manifest.std, CPP_STD);
	record(
		"payload toolchain manifest agrees with the launch argv",
		`xeus-cpp ${manifest.xeus_cpp_version}, CppInterOp ${manifest.cppinterop_version}, LLVM ${manifest.llvm_major}`,
	);
}

async function smokeKernel() {
	const coldStart = Date.now();
	const bridge = new BridgeProcess();
	const ready = await bridge.waitFor((event) => event.kind === "ready", "kernel ready", STARTUP_TIMEOUT_MS);
	const coldReadyMs = Date.now() - coldStart;
	assert.equal(ready.kernel, "cpp", "the bridge must report the kernel name it was launched with");
	record("kernel_ready (cold spawn → ready)", `${coldReadyMs} ms`);

	// The transport question, settled from /proc. Unlike OCaml this needs no
	// patch — xeus-zmq's get_end_point already uses '-' for every non-tcp
	// transport — but "no patch needed" is a claim about someone else's source
	// and this is the check that makes it a claim about this bundle.
	let events = await executeKernel(bridge, "ipc", IPC_VERDICT_CELL);
	const ipcVerdict = streamText(events, "stdout").trim();
	assert.equal(
		ipcVerdict,
		"ipc=1 unix=5 tcp=0",
		`the kernel must bind all five channels as unix-domain sockets and open no TCP listener, got: ${ipcVerdict}`,
	);
	record("transport:ipc — 5/5 channels are unix sockets, 0 TCP listeners", ipcVerdict);

	// The value of a C++ cell is what it printed, because there is nothing else.
	events = await executeKernel(bridge, "value", "#include <iostream>\nstd::cout << 6 * 7 << std::endl;");
	assert.equal(streamText(events, "stdout"), "42\n");
	assert.equal(events.find((event) => event.kind === "reply")?.status, "ok");
	record("a printed value reaches iopub as stdout", "6 * 7 → '42'");

	// And this is why. xeus-cpp 0.10.0 src/xinterpreter.cpp:387-395 — the block
	// that would publish a mime bundle for a cell's value is commented out, and
	// publish_execution_result appears nowhere else in the project. So a bare
	// expression is a successful cell with no output at all. Any renderer that
	// waits for an execute_result on this kernel waits forever.
	events = await executeKernel(bridge, "bare-expression", "6 * 7;");
	assert.equal(
		events.filter((event) => event.kind === "result").length,
		0,
		"xeus-cpp publishes no execute_result: the mime-bundle path is commented out upstream",
	);
	assert.equal(events.find((event) => event.kind === "reply")?.status, "ok");
	record("a bare expression yields no execute_result", "upstream publishes none, for any cell");

	// NEEDS-CLOUD-PROOF. Read from source, not run: interpreter::redirect_output
	// swaps std::cout's streambuf for m_cout_buffer, which publishes a stream
	// message on every flush (src/xinterpreter.cpp:473-491) — so std::cout is
	// live during a cell. StreamRedirectRAII separately captures file
	// descriptors 1 and 2 around Cpp::Process and re-emits only the stdout half,
	// via `std::cout << out`, in its destructor (lines 86-94) — so printf lands
	// at the end of the cell rather than when it was called. The two paths are
	// distinguishable and this records which one each write took.
	events = await executeKernel(
		bridge,
		"printf",
		'#include <cstdio>\nstd::printf("from-printf\\n");\nstd::fflush(stdout);',
	);
	assert.match(
		streamText(events, "stdout"),
		/from-printf/,
		"a file-descriptor write must survive StreamRedirectRAII's capture and re-emission",
	);
	record("printf output survives the fd-level capture", JSON.stringify(streamText(events, "stdout")));

	// NEEDS-CLOUD-PROOF, and the finding this battery exists to catch if true:
	// StreamRedirectRAII's destructor assigns the captured *stderr* to `err` and
	// re-emits only `out`. `err` is written to std::cerr solely when
	// compilation_result is set (line 356). So on a cell that compiles, anything
	// written to file descriptor 2 is captured and dropped — while std::cerr,
	// which goes through m_cerr_buffer and never touches fd 2, arrives normally.
	events = await executeKernel(
		bridge,
		"stderr-paths",
		'#include <cstdio>\n#include <iostream>\nstd::fprintf(stderr, "from-fprintf\\n");\nstd::fflush(stderr);\nstd::cerr << "from-cerr" << std::endl;',
	);
	const stderrText = streamText(events, "stderr");
	assert.match(stderrText, /from-cerr/, "std::cerr bypasses the fd capture and must reach iopub");
	assert.doesNotMatch(
		stderrText,
		/from-fprintf/,
		"a successful cell's file-descriptor stderr is captured into `err` and never published",
	);
	record("std::cerr reaches iopub; fprintf(stderr) is swallowed on success", JSON.stringify(stderrText));

	events = await executeKernel(bridge, "state-a", "int cell_state = 40;");
	assert.equal(events.find((event) => event.kind === "reply")?.status, "ok");
	events = await executeKernel(bridge, "state-b", "#include <iostream>\nstd::cout << cell_state + 2 << std::endl;");
	assert.equal(streamText(events, "stdout"), "42\n", "the clang-repl session must persist across cells");
	record("cross-cell state persistence (int cell_state = 40 … cell_state + 2 → 42)");

	// A compile error. Cpp::Process returning true means the compilation failed
	// (src/xinterpreter.cpp:352-357), and the reply carries a fixed ename with
	// the whole diagnostic folded into evalue behind a literal prefix.
	events = await executeKernel(bridge, "compile-error", "int not_an_int = \"definitely a string\";");
	const compileError = events.find((event) => event.kind === "error");
	assert.ok(compileError, "a compile error must emit a kernel error");
	assert.equal(compileError.ename, "Error: ");
	assert.match(compileError.evalue, /^Compilation error! /);
	// traceback is exactly one element, and it is ename + evalue concatenated —
	// there is no stack, no source excerpt and no caret line. A renderer that
	// shows a traceback shows the same string it already showed as the header.
	assert.equal(compileError.traceback.length, 1);
	assert.equal(compileError.traceback[0], compileError.ename + compileError.evalue);
	assert.doesNotMatch(JSON.stringify(compileError.traceback), /\\u001b/, "tracebacks must not contain ANSI escapes");
	assert.equal(events.find((event) => event.kind === "reply")?.status, "error");
	record("compile error", compileError.evalue.slice(0, 120));

	// NEEDS-CLOUD-PROOF. A thrown C++ exception has to unwind out of JIT'd code
	// and into xcpp's own try/catch around Cpp::Process to be reported at all
	// (src/xinterpreter.cpp:335-350); whether ORC's unwind registration makes
	// that work is a property of clang-repl, not of xeus-cpp, and no source read
	// settles it. If it does not, the process dies here instead — which this
	// harness reports as the kernel exiting mid-cell, and which is worth
	// knowing.
	events = await executeKernel(
		bridge,
		"runtime-error",
		'#include <stdexcept>\nthrow std::runtime_error("boom from cpp");',
	);
	const runtimeError = events.find((event) => event.kind === "error");
	assert.ok(runtimeError, "a thrown exception must emit a kernel error");
	assert.equal(
		runtimeError.ename,
		"Standard Exception: ",
		"a std::exception is reported under a different ename than a compile error",
	);
	assert.equal(runtimeError.evalue, "boom from cpp");
	assert.equal(events.find((event) => event.kind === "reply")?.status, "error");
	record("runtime error is distinguishable from a compile error", `${runtimeError.ename}${runtimeError.evalue}`);

	// The kernel still works after both.
	events = await executeKernel(bridge, "recover", "#include <iostream>\nstd::cout << 1 + 1 << std::endl;");
	assert.equal(streamText(events, "stdout"), "2\n");
	record("kernel recovers after a compile error and a thrown exception");

	bridge.send({ kind: "close" });
	bridge.child.stdin.end();
	const status = await withTimeout(bridge.exit, "kernel bridge exit");
	assert.equal(status.code, 0, bridge.stderr);
	record("clean bridge shutdown (exit 0)");

	return coldReadyMs;
}

/**
 * Interrupt, both paths, on their own kernels — because on this kernel an
 * interrupt is terminal and there is nothing left to reuse.
 *
 *   main.cpp:59          signal(SIGINT, xcpp::stop_handler);
 *   xutils.cpp:49-52     void stop_handler(int) { exit(0); }
 *
 * and the bridge's interrupt is a SIGINT to the kernel process. There is no
 * second path to fall back on: xeus-cpp's kernel.json sets no interrupt_mode,
 * so Jupyter's own default is signal rather than message; its
 * interrupt_request_impl is a no-op that only satisfies the pure virtual
 * (src/xinterpreter.cpp:485-488); and xeus-cpp runs on
 * xeus::make_xserver_default, whose single poll loop cannot service the control
 * channel while execute_request_impl is running anyway.
 *
 * So the check is not "does the cell abort" — it is "does the kernel die
 * predictably, promptly, and legibly, in both the busy and the idle case". The
 * OCaml battery caught two upstream bugs by interrupting while idle, and the
 * same probe is kept here for the same reason: idle is a different code path
 * and it is the one nobody tests.
 */
async function smokeInterrupt({ label, busy }) {
	const bridge = new BridgeProcess();
	await bridge.waitFor((event) => event.kind === "ready", "kernel ready", STARTUP_TIMEOUT_MS);

	let inputId;
	if (busy) {
		inputId = "interrupt-busy";
		bridge.send({
			kind: "exec",
			input_id: inputId,
			// volatile so the loop survives optimization, and a print first so the
			// cell is observably inside its own body rather than merely dispatched.
			code: `#include <iostream>
std::cout << "interrupt-ready" << std::endl;
volatile long long spin = 0;
while (true) { spin = spin + 1; }`,
		});
		await bridge.waitForInput("busy", inputId);
		// NEEDS-CLOUD-PROOF: std::cout is expected to be live mid-cell, because
		// m_cout_buffer publishes on flush and never touches file descriptor 1.
		// If that is wrong the marker never arrives and the interrupt is timed
		// from `busy` plus a delay instead — recorded either way, because which
		// one happened is itself the answer to "is stdout live".
		const marker = await bridge
			.waitFor(
				(event) =>
					event.kind === "stream" &&
					event.input_id === inputId &&
					event.name === "stdout" &&
					event.text.includes("interrupt-ready"),
				"interrupt execution marker",
				STREAM_PROBE_MS,
			)
			.then(() => true)
			.catch(() => false);
		if (!marker) {
			await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
		record(`${label}: stdout during a running cell is ${marker ? "live" : "not live"}`);
	} else {
		// Idle means idle: run a cell to completion first, so the SIGINT lands
		// between requests rather than during one.
		await executeKernel(bridge, "before-idle-interrupt", "#include <iostream>\nstd::cout << 1 << std::endl;");
	}

	const interruptedAt = Date.now();
	bridge.send({ kind: "interrupt" });
	const status = await withTimeout(bridge.exit, `${label} bridge exit`, INTERRUPT_TIMEOUT_MS);
	const interruptMs = Date.now() - interruptedAt;

	// exit(0) in the signal handler, so the kernel's status is a clean zero and
	// the bridge — which has nothing left to shut down — reports the same.
	// The kill is legible only in what did NOT happen.
	assert.equal(status.code, 0, `interrupt must terminate the kernel cleanly\n${bridge.stderr}`);
	if (busy) {
		assert.equal(
			bridge.events.some((event) => event.kind === "reply" && event.input_id === inputId),
			false,
			"an interrupted cell never receives a reply: the kernel exits inside it",
		);
		assert.equal(
			bridge.events.some((event) => event.kind === "idle" && event.input_id === inputId),
			false,
			"an interrupted cell never returns to idle",
		);
	}
	record(`${label}: interrupt terminates the kernel`, `${interruptMs} ms, exit ${status.code}`);
}

async function smokeRecoveryAfterInterrupt() {
	// Recovery on this kernel means a new process, not a resumed session. The
	// distinction matters to whatever supervises kernels, so it is proven rather
	// than assumed: a fresh bridge comes up and works after two kills.
	const bridge = new BridgeProcess();
	await bridge.waitFor((event) => event.kind === "ready", "kernel ready", STARTUP_TIMEOUT_MS);
	const events = await executeKernel(bridge, "after-interrupt", "#include <iostream>\nstd::cout << 2 + 2 << std::endl;");
	assert.equal(streamText(events, "stdout"), "4\n");
	bridge.send({ kind: "close" });
	bridge.child.stdin.end();
	const status = await withTimeout(bridge.exit, "recovery bridge exit");
	assert.equal(status.code, 0, bridge.stderr);
	record("a fresh kernel comes up and works after an interrupt killed the previous one");
}

async function smokeMissingGuest() {
	const bridge = new BridgeProcess({ kernel: `${CPP_GUEST_ROOT}/bin/missing-kernel` });
	bridge.child.stdin.end();
	const status = await withTimeout(bridge.exit, "missing guest failure", STARTUP_TIMEOUT_MS);
	assert.notEqual(status.code, 0, "a missing C++ guest must fail closed");
	assert.equal(
		bridge.events.some((event) => event.kind === "ready"),
		false,
		"a missing C++ guest must never emit ready",
	);
	record("missing C++ guest fails closed");
}

async function smokeWorkerKernel() {
	const worker = new WorkerProcess();
	worker.send({
		kind: "init",
		config: { mode: "kernel", kernel: "cpp", bridge_command: bridgeCommand() },
	});
	const ready = await worker.waitForEvent("kernel_ready", "kernel_ready", STARTUP_TIMEOUT_MS);
	assert.equal(ready.event.kernel, "cpp");

	worker.send({
		kind: "kernel_execute",
		input_id: "worker-kernel",
		// __FILE__-free proof from inside the interpreter that the running image
		// is the bundled one: the resource directory it was configured with is the
		// bundle's, and only the bundle's clang can preprocess this at all.
		code: `#include <iostream>
std::cout << "cxx=" << __cplusplus << " answer=" << 6 * 7 << std::endl;`,
	});
	const [stream, reply, idle] = await Promise.all([
		worker.waitForEvent("kernel_stream"),
		worker.waitForEvent("kernel_reply"),
		worker.waitForEvent("kernel_idle"),
	]);
	assert.equal(stream.event.input_id, "worker-kernel");
	assert.equal(stream.event.name, "stdout");
	// 202002L is the value of __cplusplus for -std=c++20. If the registry's
	// -std= never reached Clang, this is where it shows.
	assert.equal(stream.event.text, "cxx=202002 answer=42\n");
	assert.equal(reply.event.status, "ok");
	assert.equal(idle.event.input_id, "worker-kernel");
	assert.equal(
		worker.events.filter((message) => message.kind === "event" && message.event?.type === "kernel_result").length,
		0,
		"no execute_result exists on this kernel, so the worker must forward none",
	);

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
	record("worker mode:kernel kernel:cpp round trip");
}

console.log("cpp runtime bundle smoke — worker + Rust bridge + bundled xeus-cpp/clang-repl under bwrap");
assertToolchainAgreement();
const coldReadyMs = await smokeKernel();
await smokeInterrupt({ label: "busy", busy: true });
await smokeInterrupt({ label: "idle", busy: false });
await smokeRecoveryAfterInterrupt();
await smokeMissingGuest();
await smokeWorkerKernel();
console.log(`\n${checks.length}/${checks.length} checks passed — cpp kernel cold-ready in ${coldReadyMs} ms`);
