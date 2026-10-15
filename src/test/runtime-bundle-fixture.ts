import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CPP_RUNTIME_GUEST_ROOT,
	JULIA_RUNTIME_GUEST_ROOT,
	JUPYTER_BRIDGE_GUEST_ROOT,
	OCAML_RUNTIME_GUEST_ROOT,
	PYTHON_RUNTIME_GUEST_ROOT,
	SOPHIA_AGENT_RUNTIME_BUNDLE_ID,
	SOPHIA_AGENT_RUNTIME_GUEST_ROOT,
	SOPHIA_KERNEL_RUNTIME_BUNDLE_ID,
	SOPHIA_KERNEL_RUNTIME_GUEST_ROOT,
} from "../runtime-bundles.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE_ROOT = resolve(TEST_DIR, "../..");

export interface RuntimeBundleFixture {
	manifestPath: string;
	bundleCacheDir: string;
	workspaceRoot: string;
	pythonRuntimeRoot: string;
	juliaRuntimeRoot: string;
	ocamlRuntimeRoot: string;
	cppRuntimeRoot: string;
	jupyterBridgeRoot: string;
	sophiaKernelRuntimeRoot: string;
	apply(): () => void;
	cleanup(): void;
}

export function createRuntimeBundleFixture(workspaceRoot = DEFAULT_WORKSPACE_ROOT): RuntimeBundleFixture {
	const tempDir = mkdtempSync(join(tmpdir(), "runtime-bundle-fixture-"));
	const bundleCacheDir = join(tempDir, "bundle-cache");
	const manifestPath = join(tempDir, "runtime-bundles.json");
	const pythonRuntimeRoot = join(tempDir, "python-runtime");
	const juliaRuntimeRoot = join(tempDir, "julia-runtime");
	const ocamlRuntimeRoot = join(tempDir, "ocaml-runtime");
	const cppRuntimeRoot = join(tempDir, "cpp-runtime");
	const jupyterBridgeRoot = join(tempDir, "jupyter-bridge");
	const sophiaKernelRuntimeRoot = join(tempDir, "sophia-kernel-runtime");
	for (const path of [
		bundleCacheDir,
		pythonRuntimeRoot,
		juliaRuntimeRoot,
		ocamlRuntimeRoot,
		cppRuntimeRoot,
		jupyterBridgeRoot,
		sophiaKernelRuntimeRoot,
	]) {
		mkdirSync(path, { recursive: true });
	}

	writeFileSync(
		manifestPath,
		JSON.stringify(
			{
				bundles: [
					{
						id: SOPHIA_AGENT_RUNTIME_BUNDLE_ID,
						description: "Sophia agent semantic runtime test bundle",
						digest: "a".repeat(64),
						mounts: [
							{
								guest_path: SOPHIA_AGENT_RUNTIME_GUEST_ROOT,
								host_path: workspaceRoot,
							},
						],
					},
					{
						id: SOPHIA_KERNEL_RUNTIME_BUNDLE_ID,
						description: "Sophia-owned Python kernel control and harness runtime",
						mounts: [
							{
								guest_path: SOPHIA_KERNEL_RUNTIME_GUEST_ROOT,
								host_path: sophiaKernelRuntimeRoot,
							},
						],
					},
					{
						id: "python-runtime",
						description: "Pinned third-party CPython and ipykernel sandbox guest payload",
						mounts: [
							{
								guest_path: PYTHON_RUNTIME_GUEST_ROOT,
								host_path: pythonRuntimeRoot,
							},
						],
					},
					{
						id: "julia-runtime",
						description: "Pinned portable Julia and baked IJulia depot sandbox guest payload",
						mounts: [
							{
								guest_path: JULIA_RUNTIME_GUEST_ROOT,
								host_path: juliaRuntimeRoot,
							},
						],
					},
					{
						id: "ocaml-runtime",
						description: "Pinned opam switch with ocaml-jupyter and its bundled libzmq guest payload",
						mounts: [
							{
								guest_path: OCAML_RUNTIME_GUEST_ROOT,
								host_path: ocamlRuntimeRoot,
							},
						],
					},
					{
						id: "cpp-runtime",
						description: "Pinned xeus-cpp with its clang-repl toolchain and sysroot guest payload",
						mounts: [
							{
								guest_path: CPP_RUNTIME_GUEST_ROOT,
								host_path: cppRuntimeRoot,
							},
						],
					},
					{
						id: "jupyter-bridge",
						description: "Sophia-owned native Rust Jupyter controller",
						mounts: [
							{
								guest_path: JUPYTER_BRIDGE_GUEST_ROOT,
								host_path: jupyterBridgeRoot,
							},
						],
					},
				],
			},
			null,
			2,
		),
		"utf8",
	);

	return {
		manifestPath,
		bundleCacheDir,
		workspaceRoot,
		pythonRuntimeRoot,
		juliaRuntimeRoot,
		ocamlRuntimeRoot,
		cppRuntimeRoot,
		jupyterBridgeRoot,
		sophiaKernelRuntimeRoot,
		apply() {
			const previousManifest = process.env.CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST;
			const previousCacheDir = process.env.CHOREOGRAPH_BUNDLE_CACHE_DIR;
			process.env.CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST = manifestPath;
			process.env.CHOREOGRAPH_BUNDLE_CACHE_DIR = bundleCacheDir;
			return () => {
				if (previousManifest == null) {
					delete process.env.CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST;
				} else {
					process.env.CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST = previousManifest;
				}
				if (previousCacheDir == null) {
					delete process.env.CHOREOGRAPH_BUNDLE_CACHE_DIR;
				} else {
					process.env.CHOREOGRAPH_BUNDLE_CACHE_DIR = previousCacheDir;
				}
			};
		},
		cleanup() {
			rmSync(tempDir, { recursive: true, force: true });
		},
	};
}
