import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { resolveBridge, resolvePythonRuntimeBridge } from "../kernel-bridges.js";
import {
	CPP_KERNEL_SANDBOX_PATH,
	CPP_RUNTIME_GCC_TOOLCHAIN_DIR,
	CPP_RUNTIME_GUEST_ROOT,
	CPP_RUNTIME_RESOURCE_DIR,
	CPP_RUNTIME_STD,
	CPP_RUNTIME_SYSROOT_DIR,
	CPP_RUNTIME_TOOLCHAIN_DIR,
	JULIA_KERNEL_LAUNCHER_GUEST_PATH,
	JULIA_RUNTIME_DEPOT_GUEST_PATH,
	JULIA_RUNTIME_SANDBOX_PATH,
	JULIA_WRITABLE_DEPOT_GUEST_PATH,
	JUPYTER_BRIDGE_GUEST_PATH,
	OCAML_KERNEL_SANDBOX_PATH,
	OCAML_RUNTIME_GUEST_ROOT,
	OCAML_RUNTIME_SWITCH_GUEST_PATH,
	PYTHON_RUNTIME_SANDBOX_PATH,
	SOPHIA_AGENT_RUNTIME_BUNDLE_ID,
	SOPHIA_AGENT_RUNTIME_GUEST_ROOT,
	SOPHIA_KERNEL_RUNTIME_BUNDLE_ID,
	SOPHIA_KERNEL_RUNTIME_PYTHON_ROOT,
} from "../runtime-bundles.js";
import { buildBwrapArgs, resolveTemplateFilesystemIds } from "../templates.js";
import { createRuntimeBundleFixture, type RuntimeBundleFixture } from "./runtime-bundle-fixture.js";

describe("kernel bridge registry", () => {
	it("binds the python3 kernel to the Sophia control runtime", () => {
		const bridge = resolveBridge("python3");
		assert.deepEqual(bridge.filesystems, [
			"python-runtime",
			"jupyter-bridge",
			SOPHIA_KERNEL_RUNTIME_BUNDLE_ID,
			SOPHIA_AGENT_RUNTIME_BUNDLE_ID,
		]);
		assert.deepEqual(bridge.command, [
			JUPYTER_BRIDGE_GUEST_PATH,
			"--protocol",
			"kernel",
			"--python",
			PYTHON_RUNTIME_SANDBOX_PATH,
			"--runtime-root",
			SOPHIA_KERNEL_RUNTIME_PYTHON_ROOT,
		]);
		assert.deepEqual(bridge.env, {});
	});

	it("binds the python runtime bridge to the same Sophia control runtime", () => {
		assert.deepEqual(resolvePythonRuntimeBridge().command, [
			JUPYTER_BRIDGE_GUEST_PATH,
			"--protocol",
			"runtime",
			"--python",
			PYTHON_RUNTIME_SANDBOX_PATH,
			"--runtime-root",
			SOPHIA_KERNEL_RUNTIME_PYTHON_ROOT,
		]);
	});

	it("resolves the julia kernel to its own runtime bundle", () => {
		const bridge = resolveBridge("julia");
		assert.deepEqual(bridge.filesystems, ["julia-runtime", "jupyter-bridge"]);
	});

	it("passes the julia launch line as an explicit argv template", () => {
		const { command } = resolveBridge("julia");
		assert.equal(command[0], JUPYTER_BRIDGE_GUEST_PATH);
		assert.deepEqual(command.slice(1, 5), ["--protocol", "kernel", "--kernel-name", "julia"]);

		const argv: string[] = [];
		for (let index = 5; index < command.length; index += 2) {
			assert.equal(command[index], "--kernel-argv", `expected --kernel-argv at position ${index}`);
			argv.push(command[index + 1]);
		}

		assert.equal(argv[0], JULIA_RUNTIME_SANDBOX_PATH);
		// -i is load-bearing: without it SIGINT terminates Julia instead of
		// raising InterruptException in the running cell, and interrupt dies.
		assert.ok(argv.includes("-i"), "the julia kernel must be launched interactively");
		assert.equal(argv.at(-2), JULIA_KERNEL_LAUNCHER_GUEST_PATH);
		assert.equal(argv.at(-1), "{connection_file}");
		assert.equal(
			argv.filter((argument) => argument.includes("{connection_file}")).length,
			1,
			"exactly one argv element carries the connection file",
		);
		// No depot hashes may leak into the registry: the launcher exists so the
		// argv survives an IJulia version bump.
		assert.ok(
			argv.every((argument) => !/packages\/IJulia/.test(argument)),
			"the argv must not name a content-addressed depot path",
		);
	});

	it("stacks a writable depot in front of the read-only baked depot", () => {
		const { env } = resolveBridge("julia");
		assert.equal(env.JULIA_DEPOT_PATH, `${JULIA_WRITABLE_DEPOT_GUEST_PATH}:${JULIA_RUNTIME_DEPOT_GUEST_PATH}`);
		assert.ok(env.JULIA_DEPOT_PATH.startsWith("/tmp/"), "the writable depot head must live on the sandbox tmpfs");
		// The sandbox is --unshare-all; a package-server round trip could only hang.
		assert.equal(env.JULIA_PKG_OFFLINE, "true");
	});

	it("resolves the ocaml kernel to its own runtime bundle", () => {
		const bridge = resolveBridge("ocaml");
		assert.deepEqual(bridge.filesystems, ["ocaml-runtime", "jupyter-bridge"]);
	});

	it("passes the ocaml launch line as an explicit argv template", () => {
		const { command } = resolveBridge("ocaml");
		assert.equal(command[0], JUPYTER_BRIDGE_GUEST_PATH);
		assert.deepEqual(command.slice(1, 5), ["--protocol", "kernel", "--kernel-name", "ocaml"]);

		const argv: string[] = [];
		for (let index = 5; index < command.length; index += 2) {
			assert.equal(command[index], "--kernel-argv", `expected --kernel-argv at position ${index}`);
			argv.push(command[index + 1]);
		}

		assert.equal(argv[0], OCAML_KERNEL_SANDBOX_PATH);
		// Unlike IJulia, ocaml-jupyter takes the connection file behind a flag.
		// The pair has to stay adjacent and last, and exactly one element may
		// carry the placeholder or the bridge's substitution is ambiguous.
		assert.deepEqual(argv.slice(-2), ["--connection-file", "{connection_file}"]);
		assert.equal(
			argv.filter((argument) => argument.includes("{connection_file}")).length,
			1,
			"exactly one argv element carries the connection file",
		);
		// A stray .ocamlinit on the sandbox tmpfs must not be able to change what
		// the kernel evaluates.
		assert.ok(argv.includes("-noinit"), "the ocaml toplevel must not load an init file");
		// Merlin is not in the bundle; naming it inside the bundle keeps a
		// completion request from reaching a host binary on the sandbox PATH.
		assert.ok(
			argv.some(
				(argument, index) =>
					argv[index - 1] === "--merlin" && argument.startsWith(`${OCAML_RUNTIME_SWITCH_GUEST_PATH}/`),
			),
			"the merlin path must be pinned inside the bundle",
		);
	});

	it("bakes no environment for the ocaml kernel", () => {
		// The whole loader configuration — stdlib, stublibs, and the libzmq those
		// stubs dlopen — is absolute inside the artifact: the shebang, ld.conf and
		// an RUNPATH set at the guest path. Nothing here may be load-bearing, or a
		// bundle would only work when launched through this record.
		assert.deepEqual(resolveBridge("ocaml").env, {});
	});

	it("resolves the cpp kernel to its own runtime bundle", () => {
		const bridge = resolveBridge("cpp");
		assert.deepEqual(bridge.filesystems, ["cpp-runtime", "jupyter-bridge"]);
	});

	it("passes the cpp launch line as an explicit argv template", () => {
		const { command } = resolveBridge("cpp");
		assert.equal(command[0], JUPYTER_BRIDGE_GUEST_PATH);
		assert.deepEqual(command.slice(1, 5), ["--protocol", "kernel", "--kernel-name", "cpp"]);

		const argv: string[] = [];
		for (let index = 5; index < command.length; index += 2) {
			assert.equal(command[index], "--kernel-argv", `expected --kernel-argv at position ${index}`);
			argv.push(command[index + 1]);
		}

		assert.equal(argv[0], CPP_KERNEL_SANDBOX_PATH);
		// xeus-cpp takes the connection file behind -f, like ipykernel. libxeus's
		// extract_filename strips exactly that pair before anything else sees argv.
		assert.deepEqual(argv.slice(1, 3), ["-f", "{connection_file}"]);
		assert.equal(
			argv.filter((argument) => argument.includes("{connection_file}")).length,
			1,
			"exactly one argv element carries the connection file",
		);
	});

	it("hands the cpp kernel a toolchain it cannot discover for itself", () => {
		const { command } = resolveBridge("cpp");
		const argv = command.filter((_, index) => index > 5 && (index - 6) % 2 === 0);

		// The literal string "-resource-dir" is a switch as well as a flag:
		// xeus-cpp only skips its popen("clang -print-resource-dir") probe when it
		// finds this exact token in argv. The sandbox has no clang and no PATH, so
		// the probe returning empty is not a fallback, it is a broken kernel.
		const resourceIndex = argv.indexOf("-resource-dir");
		assert.notEqual(resourceIndex, -1, "the cpp kernel must be given an explicit resource directory");
		assert.equal(argv[resourceIndex + 1], CPP_RUNTIME_RESOURCE_DIR);

		// Standard library and libc headers, likewise. CppInterOp finds these by
		// running `c++ -xc++ -E -v /dev/null`, which cannot work in the sandbox.
		assert.ok(argv.includes(`--gcc-toolchain=${CPP_RUNTIME_GCC_TOOLCHAIN_DIR}`));
		assert.ok(argv.includes(`--sysroot=${CPP_RUNTIME_SYSROOT_DIR}`));
		assert.ok(argv.includes(`-std=${CPP_RUNTIME_STD}`));

		// Every path handed to the compiler must be inside the bundle. A single
		// host path here would make the kernel compile against whatever headers
		// the machine underneath happens to have, which is how a kernel passes in
		// the build image and fails on the fleet.
		for (const argument of argv.slice(1)) {
			const path = argument.startsWith("-") ? argument.replace(/^[^=]*=/, "") : argument;
			if (!path.startsWith("/")) {
				continue;
			}
			assert.ok(path.startsWith(`${CPP_RUNTIME_GUEST_ROOT}/`), `cpp argv path must live inside the bundle: ${path}`);
		}

		// And the version-carrying ones must arrive through the build's symlinks,
		// so an LLVM bump never edits this file.
		for (const argument of [CPP_RUNTIME_RESOURCE_DIR, CPP_RUNTIME_GCC_TOOLCHAIN_DIR, CPP_RUNTIME_SYSROOT_DIR]) {
			assert.ok(
				argument.startsWith(`${CPP_RUNTIME_TOOLCHAIN_DIR}/`),
				`toolchain paths must be the build's published names: ${argument}`,
			);
			assert.doesNotMatch(argument, /\d/, "no version may leak into a toolchain path");
		}
	});

	it("names the one writable place the cpp kernel has", () => {
		// Unlike OCaml, which needs nothing, and unlike Julia, which needs a depot
		// head, clang-repl's only writable need is a temporary directory. The
		// bundle is read-only and /tmp is the sandbox's tmpfs, so it is named
		// rather than inherited from libc's compiled-in default.
		const { env } = resolveBridge("cpp");
		assert.deepEqual(env, { TMPDIR: "/tmp" });
	});

	it("rejects unknown kernels", () => {
		assert.throws(() => resolveBridge("ruby"), /Unknown kernel kind: ruby/);
	});
});

describe("kernel runtime sandbox mounts", () => {
	let runtimeBundles: RuntimeBundleFixture;
	let restoreRuntimeEnv: (() => void) | undefined;

	before(() => {
		runtimeBundles = createRuntimeBundleFixture();
		restoreRuntimeEnv = runtimeBundles.apply();
	});

	after(() => {
		restoreRuntimeEnv?.();
		runtimeBundles.cleanup();
	});

	it("mounts Prime's exact agent runtime read-only into its leased Python kernel", () => {
		const filesystems = resolveTemplateFilesystemIds("bare", resolveBridge("python3").filesystems);
		const args = buildBwrapArgs("bare", "/tmp/worker.mjs", undefined, { filesystems });
		const roBinds: Array<[string, string]> = [];
		const writableBinds: Array<[string, string]> = [];
		for (const [index, arg] of args.entries()) {
			if (arg === "--ro-bind" && index + 2 < args.length) roBinds.push([args[index + 1], args[index + 2]]);
			if (arg === "--bind" && index + 2 < args.length) writableBinds.push([args[index + 1], args[index + 2]]);
		}
		assert.ok(
			roBinds.some(
				([host, guest]) => host === runtimeBundles.workspaceRoot && guest === SOPHIA_AGENT_RUNTIME_GUEST_ROOT,
			),
			"the kernel must see the same digest-pinned Prime skills and helpers as its worker",
		);
		assert.equal(
			writableBinds.filter(([, guest]) => guest.startsWith(SOPHIA_AGENT_RUNTIME_GUEST_ROOT)).length,
			0,
			"the agent runtime must never be writable from the kernel",
		);
	});

	it("mounts the julia runtime read-only at its baked guest path", () => {
		const filesystems = resolveTemplateFilesystemIds("bare", resolveBridge("julia").filesystems);
		const args = buildBwrapArgs("bare", "/tmp/worker.mjs", undefined, { filesystems });

		const bindsFor = (flag: string): Array<[string, string]> => {
			const binds: Array<[string, string]> = [];
			for (const [index, arg] of args.entries()) {
				if (arg === flag && index + 2 < args.length) {
					binds.push([args[index + 1], args[index + 2]]);
				}
			}
			return binds;
		};

		assert.ok(
			bindsFor("--ro-bind").some(
				([host, guest]) => host === runtimeBundles.juliaRuntimeRoot && guest === "/opt/runtime/julia",
			),
			"the julia runtime bundle must be bind-mounted at the path its precompile caches were baked against",
		);
		assert.equal(
			bindsFor("--bind").filter(([, guest]) => guest.startsWith("/opt/runtime/julia")).length,
			0,
			"the julia runtime must never be mounted writable",
		);
	});

	it("mounts the ocaml switch read-only at the prefix it was built against", () => {
		const filesystems = resolveTemplateFilesystemIds("bare", resolveBridge("ocaml").filesystems);
		const args = buildBwrapArgs("bare", "/tmp/worker.mjs", undefined, { filesystems });

		const bindsFor = (flag: string): Array<[string, string]> => {
			const binds: Array<[string, string]> = [];
			for (const [index, arg] of args.entries()) {
				if (arg === flag && index + 2 < args.length) {
					binds.push([args[index + 1], args[index + 2]]);
				}
			}
			return binds;
		};

		assert.ok(
			bindsFor("--ro-bind").some(
				([host, guest]) => host === runtimeBundles.ocamlRuntimeRoot && guest === OCAML_RUNTIME_GUEST_ROOT,
			),
			"the ocaml bundle must be bind-mounted at the prefix baked into its shebangs, ld.conf and RUNPATHs",
		);
		assert.equal(
			bindsFor("--bind").filter(([, guest]) => guest.startsWith(OCAML_RUNTIME_GUEST_ROOT)).length,
			0,
			"the ocaml switch must never be mounted writable",
		);
	});

	it("mounts the cpp toolchain read-only at the prefix it was installed at", () => {
		const filesystems = resolveTemplateFilesystemIds("bare", resolveBridge("cpp").filesystems);
		const args = buildBwrapArgs("bare", "/tmp/worker.mjs", undefined, { filesystems });

		const bindsFor = (flag: string): Array<[string, string]> => {
			const binds: Array<[string, string]> = [];
			for (const [index, arg] of args.entries()) {
				if (arg === flag && index + 2 < args.length) {
					binds.push([args[index + 1], args[index + 2]]);
				}
			}
			return binds;
		};

		assert.ok(
			bindsFor("--ro-bind").some(
				([host, guest]) => host === runtimeBundles.cppRuntimeRoot && guest === CPP_RUNTIME_GUEST_ROOT,
			),
			"the cpp bundle must be bind-mounted at the conda prefix baked into its RPATHs and toolchain symlinks",
		);
		assert.equal(
			bindsFor("--bind").filter(([, guest]) => guest.startsWith(CPP_RUNTIME_GUEST_ROOT)).length,
			0,
			"the cpp toolchain must never be mounted writable",
		);
	});
});
