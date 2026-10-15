/**
 * Kernel bridge registry — maps kernel kinds to bridge implementations.
 *
 * Each kernel kind resolves to:
 *   - filesystem bundles needed in the sandbox
 *   - command to launch the bridge process (guest paths)
 *   - environment variables for the bridge
 *
 * The bridge process speaks NDJSON on stdio, translating between
 * worker commands and the underlying language runtime.
 *
 * Adding a new kernel: ship the bridge in a runtime bundle, add the filesystem
 * bundle in filesystems.ts, and add a registry entry here.
 */
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CPP_KERNEL_SANDBOX_PATH,
	CPP_RUNTIME_GCC_TOOLCHAIN_DIR,
	CPP_RUNTIME_INCLUDE_DIR,
	CPP_RUNTIME_RESOURCE_DIR,
	CPP_RUNTIME_STD,
	CPP_RUNTIME_SYSROOT_DIR,
	JULIA_KERNEL_LAUNCHER_GUEST_PATH,
	JULIA_RUNTIME_DEPOT_GUEST_PATH,
	JULIA_RUNTIME_PROJECT_GUEST_PATH,
	JULIA_RUNTIME_SANDBOX_PATH,
	JULIA_WRITABLE_DEPOT_GUEST_PATH,
	JUPYTER_BRIDGE_GUEST_PATH,
	OCAML_KERNEL_SANDBOX_PATH,
	OCAML_RUNTIME_BIN_DIR,
	PYTHON_RUNTIME_SANDBOX_PATH,
	SOPHIA_AGENT_RUNTIME_BUNDLE_ID,
	SOPHIA_KERNEL_RUNTIME_BUNDLE_ID,
	SOPHIA_KERNEL_RUNTIME_PYTHON_ROOT,
} from "./runtime-bundles.js";

export interface BridgeResolution {
	/** Filesystem bundle IDs required (merged with template defaults) */
	filesystems: string[];
	/** Command to run inside the sandbox (guest paths) */
	command: string[];
	/** Extra env vars for the bridge process */
	env: Record<string, string>;
}

function pythonBridge(protocol: "kernel" | "runtime"): BridgeResolution {
	return {
		// Prime's admitted skill documents and bundled helper packages are part of
		// the exact agent-runtime artifact. The leased kernel is a separate sandbox,
		// so it must receive that same artifact read-only rather than inheriting or
		// guessing worker-local paths.
		filesystems: [
			"python-runtime",
			"jupyter-bridge",
			SOPHIA_KERNEL_RUNTIME_BUNDLE_ID,
			SOPHIA_AGENT_RUNTIME_BUNDLE_ID,
		],
		command: [
			JUPYTER_BRIDGE_GUEST_PATH,
			"--protocol",
			protocol,
			"--python",
			PYTHON_RUNTIME_SANDBOX_PATH,
			"--runtime-root",
			SOPHIA_KERNEL_RUNTIME_PYTHON_ROOT,
		],
		env: {},
	};
}

/**
 * The bridge takes the Julia launch line as an explicit argv template rather
 * than knowing anything about Julia: one `--kernel-argv` per argument, no shell,
 * and `{connection_file}` substituted at spawn.
 *
 * The argv mirrors IJulia's own kernelspec (`julia -i --color=yes … -e 'import
 * IJulia; IJulia.run_kernel()' {connection_file}`), with the `-e` expression
 * replaced by the launcher shipped in the bundle so no depot hash leaks in here.
 */
function juliaBridge(): BridgeResolution {
	const kernelArgv = [
		JULIA_RUNTIME_SANDBOX_PATH,
		// Interactive: IJulia relies on SIGINT raising InterruptException in the
		// running cell instead of terminating the process. Interrupt dies without it.
		"-i",
		// The bridge strips ANSI out of tracebacks, so upstream's colored errors
		// arrive clean and we keep IJulia's own formatting.
		"--color=yes",
		"--startup-file=no",
		"--history-file=no",
		// Pin the environment explicitly instead of leaning on `@v#.#` resolution
		// order across the stacked depot.
		`--project=${JULIA_RUNTIME_PROJECT_GUEST_PATH}`,
		JULIA_KERNEL_LAUNCHER_GUEST_PATH,
		"{connection_file}",
	];

	return {
		filesystems: ["julia-runtime", "jupyter-bridge"],
		command: [
			JUPYTER_BRIDGE_GUEST_PATH,
			"--protocol",
			"kernel",
			"--kernel-name",
			"julia",
			...kernelArgv.flatMap((argument) => ["--kernel-argv", argument]),
		],
		env: {
			// Writable tmpfs head, read-only baked depot behind it. Julia searches
			// every entry for packages, artifacts and precompile caches, so the
			// cache lands in tmpfs while the payload resolves from the mount.
			JULIA_DEPOT_PATH: `${JULIA_WRITABLE_DEPOT_GUEST_PATH}:${JULIA_RUNTIME_DEPOT_GUEST_PATH}`,
			JULIA_HISTORY: `${JULIA_WRITABLE_DEPOT_GUEST_PATH}/repl_history.jl`,
			// The sandbox has no network: fail fast and legibly rather than hanging
			// on a package-server timeout if anything ever tries to resolve.
			JULIA_PKG_OFFLINE: "true",
			JULIA_NUM_THREADS: "1",
		},
	};
}

/**
 * ocaml-jupyter takes its connection file behind `--connection-file` rather
 * than positionally, which costs the bridge nothing: `{connection_file}` is
 * substituted wherever it appears in the template.
 *
 * There is no env here at all, and that is the point. Everything OCaml needs to
 * find — its stdlib, its stublibs, the libzmq those stubs dlopen — is an
 * absolute path baked into the bundle at the guest path it is mounted at, so
 * the loader configuration travels with the artifact instead of with this
 * record. Julia needed a stacked JULIA_DEPOT_PATH because it wants a writable
 * head; OCaml's toplevel compiles in memory and writes nothing.
 */
function ocamlBridge(): BridgeResolution {
	const kernelArgv = [
		OCAML_KERNEL_SANDBOX_PATH,
		// Without this the toplevel loads ./.ocamlinit or $HOME/.ocamlinit if one
		// happens to exist. Both are tmpfs here, so today that file is never
		// there — but a sandbox whose behaviour depends on whether a scratch file
		// exists is not a sandbox we can reason about.
		"-noinit",
		"--verbosity",
		"app",
		// Merlin serves completion and inspection only, and is deliberately not in
		// the bundle. Naming it inside the bundle makes a complete_request degrade
		// to "not found" instead of silently executing whatever `ocamlmerlin` the
		// host's /usr happens to provide on the sandbox PATH.
		"--merlin",
		`${OCAML_RUNTIME_BIN_DIR}/ocamlmerlin`,
		"--connection-file",
		"{connection_file}",
	];

	return {
		filesystems: ["ocaml-runtime", "jupyter-bridge"],
		command: [
			JUPYTER_BRIDGE_GUEST_PATH,
			"--protocol",
			"kernel",
			"--kernel-name",
			"ocaml",
			...kernelArgv.flatMap((argument) => ["--kernel-argv", argument]),
		],
		env: {},
	};
}

/**
 * xeus-cpp takes its connection file behind `-f`, exactly like ipykernel, and
 * passes every other argv element straight through to Clang unparsed — libxeus
 * strips `-f <file>` first (xeus src/xhelper.cpp, extract_filename), and
 * xeus-cpp forwards the remainder to Cpp::CreateInterpreter
 * (xeus-cpp 0.10.0 src/xinterpreter.cpp:246). So this argv is one third kernel
 * launch line and two thirds compiler configuration.
 *
 * The compiler configuration is here because it cannot be discovered there.
 * xeus-cpp finds its resource directory by running `clang -print-resource-dir`
 * and its system includes by running `c++ -xc++ -E -v /dev/null`, both through
 * popen (CppInterOp v1.9.0 lib/CppInterOp/CppInterOp.cpp:3572 and :3589). The
 * sandbox is --unshare-all with PATH=/nonexistent and carries no compiler, so
 * both return nothing and clang-repl comes up with no builtin headers and no
 * standard library. Naming the paths is what makes the kernel work; naming them
 * *inside the bundle* is what keeps it from silently compiling against
 * whatever headers the host's /usr happens to have.
 *
 * `-resource-dir` is doing double duty: xeus-cpp skips its own detection if and
 * only if that literal string appears in argv (src/xinterpreter.cpp:35-48), so
 * passing it is both the configuration and the switch that disables the guess.
 *
 * Every path is a symlink published by deploy/cpp-runtime/bake-runtime.sh, so
 * no LLVM version and no conda triple appears here.
 */
function cppBridge(): BridgeResolution {
	const kernelArgv = [
		CPP_KERNEL_SANDBOX_PATH,
		"-f",
		"{connection_file}",
		`-std=${CPP_RUNTIME_STD}`,
		"-resource-dir",
		CPP_RUNTIME_RESOURCE_DIR,
		`--gcc-toolchain=${CPP_RUNTIME_GCC_TOOLCHAIN_DIR}`,
		`--sysroot=${CPP_RUNTIME_SYSROOT_DIR}`,
		// xeus-cpp's own headers, mirroring the `-I @XEUS_CPP_INCLUDE_DIR@` in
		// every kernel.json the project installs.
		"-I",
		CPP_RUNTIME_INCLUDE_DIR,
	];

	return {
		filesystems: ["cpp-runtime", "jupyter-bridge"],
		command: [
			JUPYTER_BRIDGE_GUEST_PATH,
			"--protocol",
			"kernel",
			"--kernel-name",
			"cpp",
			...kernelArgv.flatMap((argument) => ["--kernel-argv", argument]),
		],
		env: {
			// clang-repl writes nothing we know of, but the JIT's diagnostic paths
			// and anything a cell does with std::tmpfile land wherever TMPDIR says.
			// The sandbox's /tmp is a tmpfs and the bundle is read-only, so the one
			// writable place is named explicitly rather than inherited from libc's
			// default — a payload whose writable needs are implicit is a payload
			// that fails the first time the default changes.
			TMPDIR: "/tmp",
		},
	};
}

const BRIDGE_REGISTRY: Record<string, () => BridgeResolution> = {
	python3: () => pythonBridge("kernel"),
	julia: juliaBridge,
	ocaml: ocamlBridge,
	cpp: cppBridge,
};

export function resolveBridge(kernel: string): BridgeResolution {
	const resolver = BRIDGE_REGISTRY[kernel];
	if (!resolver) {
		throw new Error(`Unknown kernel kind: ${kernel}`);
	}
	return resolver();
}

export function resolvePythonRuntimeBridge(): BridgeResolution {
	return pythonBridge("runtime");
}

/** Resolve host paths for macOS/local-native process-separation proofs. */
export function resolveLocalPythonBridge(protocol: "kernel" | "runtime" = "kernel"): BridgeResolution {
	const binary = process.env.SOPHIA_JUPYTER_BRIDGE_PATH?.trim();
	const python = process.env.SOPHIA_PRIME_KERNEL_PYTHON?.trim();
	if (!binary || !isAbsolute(binary)) {
		throw new Error("local-native kernel execution requires absolute SOPHIA_JUPYTER_BRIDGE_PATH");
	}
	if (!python || !isAbsolute(python)) {
		throw new Error("local-native kernel execution requires absolute SOPHIA_PRIME_KERNEL_PYTHON");
	}
	const runtimeRoot = resolve(fileURLToPath(new URL("../packages/sophia-kernel-runtime/src", import.meta.url)));
	return {
		filesystems: [],
		command: [binary, "--protocol", protocol, "--python", python, "--runtime-root", runtimeRoot],
		env: {},
	};
}
