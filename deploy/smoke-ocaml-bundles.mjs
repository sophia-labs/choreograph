#!/usr/bin/env node

/**
 * Runtime bundle smoke for the OCaml kernel: worker + Rust bridge + the bundled
 * opam switch, all under real bwrap. Third instance of the shape established by
 * smoke-jupyter-bundles.mjs (Python) and smoke-julia-bundles.mjs (Julia).
 *
 * The launch argv mirrors src/kernel-bridges.ts. It is duplicated rather than
 * imported because this harness also runs from deploy/package-runtime-bundles.sh
 * against staged tarballs, where no TypeScript build exists. The registry itself
 * is exercised end to end by poc/ocaml-kernel-http-proof.mjs.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

const [ocamlRoot, bridgeRoot, workerPath] = process.argv.slice(2);
if (!ocamlRoot || !bridgeRoot || !workerPath) {
	throw new Error("usage: smoke-ocaml-bundles.mjs <ocaml-root> <bridge-root> <worker.mjs>");
}

const OCAML_GUEST_ROOT = "/opt/runtime/ocaml";
const OCAML_SWITCH_GUEST = `${OCAML_GUEST_ROOT}/_opam`;
const OCAML_KERNEL_GUEST = `${OCAML_SWITCH_GUEST}/bin/ocaml-jupyter-kernel`;
const OCAML_MERLIN_GUEST = `${OCAML_SWITCH_GUEST}/bin/ocamlmerlin`;
const BRIDGE_GUEST = "/opt/choreograph-runtime/bridges/jupyter-bridge";
const WORKER_GUEST = "/sandbox/worker.mjs";

const TIMEOUT_MS = 30_000;
// The bridge allows 90 s for a cold kernel to open its IPC sockets and then
// 30 s for kernel_info. Stay outside that so a bridge failure wins the race and
// keeps its diagnostic stderr.
const STARTUP_TIMEOUT_MS = 150_000;
const INTERRUPT_TIMEOUT_MS = 10_000;
// How long an unflushed write is given to appear before it is called buffered.
// Generous on purpose: this bound decides a recorded finding, not a pass.
const BUFFERING_PROBE_MS = 3_000;

const OCAML_KERNEL_ARGV = [
	OCAML_KERNEL_GUEST,
	"-noinit",
	"--verbosity",
	"app",
	"--merlin",
	OCAML_MERLIN_GUEST,
	"--connection-file",
	"{connection_file}",
];

/**
 * Everything the switch needs to find is absolute inside the bundle. The
 * registry entry carries no env for this kernel, so neither does the smoke —
 * if a variable were required here, the artifact would not be self-contained.
 */
const OCAML_ENV = {};

function bridgeCommand({ kernel = OCAML_KERNEL_GUEST, bridge = BRIDGE_GUEST } = {}) {
	const argv = [...OCAML_KERNEL_ARGV];
	argv[0] = kernel;
	return [
		bridge,
		"--protocol",
		"kernel",
		"--kernel-name",
		"ocaml",
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
		ocamlRoot,
		OCAML_GUEST_ROOT,
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
	for (const [key, value] of Object.entries(OCAML_ENV)) {
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
			// only place its diagnosis exists, so a timeout must carry it.
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

/**
 * Last, not first. ocaml-jupyter evaluates a cell phrase by phrase and emits an
 * execute_result for every phrase whose toplevel printer produced output, so a
 * multi-phrase cell legitimately yields several — unlike ipykernel or IJulia,
 * which emit at most one. The cell's value is the last one.
 */
function resultText(events) {
	return events.filter((event) => event.kind === "result").at(-1)?.data?.["text/plain"];
}

/**
 * Same value, with a stray leading newline removed.
 *
 * ocaml-jupyter reads its phrase output with Buffer.contents *before* the
 * Format writer is flushed, so unwinding the toplevel mid-print can leave bytes
 * behind that surface at the head of a later phrase. Observed after an
 * interrupt in some runs and not others — the drift is real but not reliable
 * enough to assert either way, so post-interrupt checks compare the value and
 * report the prefix separately.
 */
function phraseValue(events) {
	return resultText(events)?.replace(/^\n+/, "");
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
	assert.equal(ready.kernel, "ocaml", "the bridge must report the kernel name it was launched with");
	record("kernel_ready (cold spawn → ready)", `${coldReadyMs} ms`);

	// The biggest technical risk in this slice. ocaml-jupyter formats every
	// channel address as "<transport>://<ip>:<port>", which under transport:ipc
	// binds unix sockets one character away from where any conforming client
	// looks; deploy/ocaml-runtime/0001-connection-info-ipc-address.patch fixes it.
	//
	// The verdict comes from the kernel's namespace rather than from the kernel's
	// opinion: /proc/net/unix is the OS socket table, and /proc/net/tcp state 0A
	// is LISTEN. A single phrase, so a single execute_result.
	let events = await executeKernel(
		bridge,
		"ipc",
		`let read_lines path = In_channel.with_open_text path In_channel.input_lines in
let cmdline =
  In_channel.with_open_bin "/proc/self/cmdline" In_channel.input_all
  |> String.split_on_char '\\000'
in
let rec connection_file = function
  | "--connection-file" :: path :: _ -> path
  | _ :: tl -> connection_file tl
  | [] -> failwith "the kernel was launched without --connection-file"
in
let connection_file = connection_file cmdline in
let connection_json = In_channel.with_open_text connection_file In_channel.input_all in
let contains needle haystack =
  let n = String.length needle and h = String.length haystack in
  let rec go i = i + n <= h && (String.sub haystack i n = needle || go (i + 1)) in
  go 0
in
let bound_unix_sockets =
  read_lines "/proc/net/unix"
  |> List.filter_map (fun line ->
       match String.rindex_opt line ' ' with
       | Some i when i + 1 < String.length line && line.[i + 1] = '/' ->
         Some (String.sub line (i + 1) (String.length line - i - 1))
       | _ -> None)
in
let prefix = Filename.remove_extension connection_file in
let channels = List.init 5 (fun i -> Printf.sprintf "%s-%d" prefix (i + 1)) in
let bound = List.filter (fun path -> List.mem path bound_unix_sockets) channels in
let tcp_listeners =
  [ "/proc/net/tcp"; "/proc/net/tcp6" ]
  |> List.concat_map read_lines
  |> List.filter (fun line ->
       match String.split_on_char ' ' line |> List.filter (fun s -> s <> "") with
       | _ :: _ :: _ :: state :: _ -> state = "0A"
       | _ -> false)
  |> List.length
in
(contains "\\"transport\\":\\"ipc\\"" connection_json, List.length bound, tcp_listeners);;`,
	);
	const ipcVerdict = resultText(events)?.trim();
	assert.equal(
		ipcVerdict,
		"- : bool * int * int = (true, 5, 0)",
		`the kernel must bind all five channels as unix-domain sockets and open no TCP listener, got: ${ipcVerdict}`,
	);
	record("transport:ipc — 5/5 channels are unix sockets, 0 TCP listeners", ipcVerdict);

	events = await executeKernel(bridge, "result", "6 * 7;;");
	// The OCaml toplevel's own phrase printer, verbatim and with its newline.
	// There is no bare "42" anywhere in the protocol — the type is part of the
	// value a renderer receives.
	assert.equal(resultText(events), "- : int = 42\n");
	record("execute_result text/plain === '- : int = 42'");

	bridge.send({
		kind: "exec",
		input_id: "streams",
		// No explicit flush: print_newline/prerr_newline flush by construction in
		// OCaml's Stdlib, so a line-terminated write is already complete.
		code: 'print_endline "hello";\nprerr_endline "warning";;',
	});
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

	// A write with no trailing newline. ocaml-jupyter forwards the REPL child's
	// output with Lwt_io.read_line, so a partial line has nowhere to go however
	// hard the cell flushes — and it is not merely delayed. It waits in the pipe
	// until some *later* cell terminates the line, and is then delivered as that
	// cell's stdout. Silent cross-cell output attribution, which neither
	// ipykernel nor IJulia does; both forward partial writes as they arrive.
	bridge.send({ kind: "exec", input_id: "partial", code: 'print_string "partial"; flush stdout;;' });
	await Promise.all([bridge.waitForInput("reply", "partial"), bridge.waitForInput("idle", "partial")]);
	const partialStreamed = await bridge
		.waitFor(
			(event) => event.kind === "stream" && event.input_id === "partial" && event.name === "stdout",
			"partial stdout stream",
			BUFFERING_PROBE_MS,
		)
		.then(() => true)
		.catch(() => false);
	assert.equal(partialStreamed, false, "a partial line cannot reach iopub through a line-oriented reader");

	events = await executeKernel(bridge, "carried", 'print_endline "-carried";;');
	const carried = events.find((event) => event.kind === "stream" && event.name === "stdout");
	assert.equal(carried?.text, "partial-carried\n");
	assert.equal(carried?.input_id, "carried", "the previous cell's partial write arrives labelled as this one");
	record("a write without a trailing newline is re-attributed to the next cell", JSON.stringify(carried.text));

	events = await executeKernel(bridge, "state-a", "let x = 40;;");
	assert.equal(resultText(events), "val x : int = 40\n");
	events = await executeKernel(bridge, "state-b", "x + 2;;");
	assert.equal(resultText(events), "- : int = 42\n", "the OCaml session must persist across cells");
	record("cross-cell state persistence (let x = 40 … x + 2 → 42)");

	events = await executeKernel(bridge, "error", 'failwith "boom";;');
	const error = events.find((event) => event.kind === "error");
	assert.ok(error, "a failing cell must emit a kernel error");
	// ocaml-jupyter carries no exception class and no message in the header
	// fields: ename is the literal "error" and evalue is a category word. The
	// whole diagnostic is traceback[0]. A renderer showing "ename: evalue" —
	// which is what most of them do — would display nothing useful.
	assert.equal(error.ename, "error");
	assert.equal(error.evalue, "runtime_error");
	assert.ok(Array.isArray(error.traceback) && error.traceback.length > 0, "a real OCaml diagnostic is required");
	assert.match(error.traceback.join("\n"), /Exception: Failure "boom"\./);
	assert.doesNotMatch(JSON.stringify(error.traceback), /\\u001b|\x1b/, "tracebacks must not contain ANSI escapes");
	assert.equal(
		events.find((event) => event.kind === "reply")?.status,
		"error",
		"a failing cell must reply with status=error",
	);
	record("real OCaml error + diagnostic", error.traceback.join(" ").trim());

	// A compile error is a different code path in ocaml-jupyter (the phrase never
	// runs), and a different evalue. Both have to reach the bridge.
	events = await executeKernel(bridge, "type-error", "1 + true;;");
	const typeError = events.find((event) => event.kind === "error");
	assert.ok(typeError, "a type error must emit a kernel error");
	assert.equal(typeError.evalue, "compile_error");
	assert.match(typeError.traceback.join("\n"), /has type bool\n\s+but an expression was expected of type int/);
	// The caret line proves the diagnostic carries source locations, which is the
	// part a renderer needs and the part ANSI stripping could have eaten.
	assert.match(typeError.traceback.join("\n"), /1 \| 1 \+ true;;\n\s+\^\^\^\^/);
	record("compile error is distinguishable from a runtime error", typeError.evalue);

	bridge.send({
		kind: "exec",
		input_id: "interrupt",
		// A tail-recursive spin rather than a sleep: it needs no module beyond
		// Stdlib, and it interrupts at an OCaml poll point, which is the harder
		// case than waking a blocked syscall.
		code: `let () = print_endline "interrupt-ready"; flush stdout in
let rec spin n acc = if n = 0 then acc else spin (n - 1) (acc + 1) in
spin 100_000_000_000 0;;`,
	});
	await bridge.waitForInput("busy", "interrupt");
	// `busy` fires before the cell body necessarily starts. Interrupting in that
	// gap would make this a scheduler race rather than a test.
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
	const interruptReply = await bridge.waitForInput("reply", "interrupt", INTERRUPT_TIMEOUT_MS);
	await bridge.waitForInput("idle", "interrupt", INTERRUPT_TIMEOUT_MS);
	const interruptMs = Date.now() - interruptedAt;
	// SIGINT reaches the kernel process, which turns it into Sys.Break, forwards
	// it to the forked REPL child, and the child unwinds the running phrase.
	// What actually happens, asserted rather than hoped for. SIGINT reaches the
	// kernel process, becomes Sys.Break, and is relayed to the forked REPL child
	// — but the break lands *inside* Toploop.execute_phrase, which catches it
	// itself and reports "Interrupted." through the ordinary phrase printer. So
	// ocaml-jupyter's dedicated interrupt reporting (ename "interrupt", the
	// SHELL_ABORT reply) is not the path that fires; an interrupted cell is
	// indistinguishable from a failed one except by the text of traceback[0].
	assert.equal(interrupted.ename, "error");
	assert.equal(interrupted.evalue, "runtime_error");
	assert.match(interrupted.traceback.join("\n"), /Interrupted\./);
	assert.equal(interruptReply.status, "error");
	assert.ok(interruptMs < INTERRUPT_TIMEOUT_MS, `interrupt must settle within ${INTERRUPT_TIMEOUT_MS}ms`);
	record(
		"interrupt of a running spin → Interrupted.",
		`${interruptMs} ms, ename=${interrupted.ename}, evalue=${interrupted.evalue}, reply=${interruptReply.status}`,
	);

	events = await executeKernel(bridge, "recover", "1 + 1;;");
	const strayPrefix = resultText(events).length - phraseValue(events).length;
	assert.equal(phraseValue(events), "- : int = 2\n");
	record("kernel recovers after interrupt", `${strayPrefix} stray leading newline(s) on the next result`);

	// The other interrupt path, and the reason this bundle carries a second
	// patch. A stop pressed after a cell has already finished delivers SIGINT
	// while the REPL child is blocked reading its control channel, so Sys.Break
	// escapes to Process.create_child_process's own handler — which replies to
	// the *previous* cell with SHELL_ABORT. Upstream serializes that as "abort";
	// the Jupyter spec says "aborted", and a strict client rejects the reply and
	// loses the shell channel, taking the whole kernel down with it.
	// The bridge has already retired the previous execution, so it emits nothing
	// for this reply — the only observable is whether its shell channel survives
	// decoding it. Unpatched, the bridge dies here with
	//   Jupyter shell channel failed: Error deserializing content for msg_type
	//   `execute_reply`: unknown variant `abort`, expected one of `ok`, `error`,
	//   `aborted`
	// and every later cell times out. Give the failure time before asking for
	// more work, so a pass means survival rather than a race won.
	bridge.send({ kind: "interrupt" });
	await new Promise((resolve) => setTimeout(resolve, 1_000));
	// Two cells, not one. The second patch keeps the bridge alive; the third
	// keeps the kernel *correct*. Without it the abandoned reply stays in the
	// REPL's status mvar and is consumed as the next cell's status, so the
	// kernel runs one reply ahead forever and every subsequent execute_result
	// arrives after its own idle — outputs vanish silently, which is worse than
	// a crash. Both cells must answer with their own value.
	events = await executeKernel(bridge, "after-idle-interrupt", "2 + 2;;");
	assert.equal(phraseValue(events), "- : int = 4\n", "an interrupt received while idle must not kill the kernel");
	events = await executeKernel(bridge, "after-idle-interrupt-2", "3 + 3;;");
	assert.equal(phraseValue(events), "- : int = 6\n", "the reply channel must not stay one cell behind");
	record("interrupt received while idle leaves the kernel usable and in step");

	bridge.send({ kind: "close" });
	bridge.child.stdin.end();
	const status = await withTimeout(bridge.exit, "kernel bridge exit");
	assert.equal(status.code, 0, bridge.stderr);
	record("clean bridge shutdown (exit 0)");

	return coldReadyMs;
}

async function smokeMissingGuest() {
	const bridge = new BridgeProcess({ kernel: `${OCAML_SWITCH_GUEST}/bin/missing-kernel` });
	bridge.child.stdin.end();
	const status = await withTimeout(bridge.exit, "missing guest failure", STARTUP_TIMEOUT_MS);
	assert.notEqual(status.code, 0, "a missing OCaml guest must fail closed");
	assert.equal(
		bridge.events.some((event) => event.kind === "ready"),
		false,
		"a missing OCaml guest must never emit ready",
	);
	record("missing OCaml guest fails closed");
}

async function smokeWorkerKernel() {
	const worker = new WorkerProcess();
	worker.send({
		kind: "init",
		config: { mode: "kernel", kernel: "ocaml", bridge_command: bridgeCommand() },
	});
	const ready = await worker.waitForEvent("kernel_ready", "kernel_ready", STARTUP_TIMEOUT_MS);
	assert.equal(ready.event.kernel, "ocaml");

	worker.send({
		kind: "kernel_execute",
		input_id: "worker-kernel",
		code: `let () = print_endline Sys.executable_name; flush stdout in
6 * 7;;`,
	});
	const [stream, result, reply, idle] = await Promise.all([
		worker.waitForEvent("kernel_stream"),
		worker.waitForEvent("kernel_result"),
		worker.waitForEvent("kernel_reply"),
		worker.waitForEvent("kernel_idle"),
	]);
	assert.equal(stream.event.input_id, "worker-kernel");
	assert.equal(stream.event.name, "stdout");
	// Proof from inside the toplevel that the running image is the bundled one.
	assert.equal(stream.event.text, `${OCAML_KERNEL_GUEST}\n`);
	assert.equal(result.event.data?.["text/plain"], "- : int = 42\n");
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
	record("worker mode:kernel kernel:ocaml round trip");
}

console.log("ocaml runtime bundle smoke — worker + Rust bridge + bundled opam switch under bwrap");
const coldReadyMs = await smokeKernel();
await smokeMissingGuest();
await smokeWorkerKernel();
console.log(`\n${checks.length}/${checks.length} checks passed — ocaml kernel cold-ready in ${coldReadyMs} ms`);
