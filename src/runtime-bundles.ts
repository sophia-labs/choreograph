import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type RuntimeBundleMountMode = "ro" | "rw";

export interface RuntimeBundleMount {
	hostPath: string;
	guestPath: string;
	mode: RuntimeBundleMountMode;
}

interface RuntimeBundleManifestMountRecord {
	guest_path?: unknown;
	mode?: unknown;
	host_path?: unknown;
	local_subpath?: unknown;
}

interface RuntimeBundleManifestRecord {
	id?: unknown;
	description?: unknown;
	digest?: unknown;
	mounts?: unknown;
}

interface ParsedRuntimeBundleMountRecord {
	guestPath: string;
	mode: RuntimeBundleMountMode;
	hostPath?: string;
	localSubpath?: string;
}

interface ParsedRuntimeBundleRecord {
	id: string;
	description?: string;
	digest?: string;
	mounts: ParsedRuntimeBundleMountRecord[];
}

export interface RuntimeBundleDescriptor {
	id: string;
	description?: string;
	/** Canonical sha256 digest of the packaged artifact (without the `sha256:` prefix). */
	digest: string;
	mounts: RuntimeBundleMount[];
}

const RUNTIME_BUNDLE_MANIFEST_ENV_VARS = ["CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST", "RUNTIME_BUNDLE_MANIFEST"] as const;

const BUNDLE_CACHE_DIR_ENV_VARS = ["CHOREOGRAPH_BUNDLE_CACHE_DIR", "BUNDLE_CACHE_DIR"] as const;

export const SOPHIA_AGENT_RUNTIME_BUNDLE_ID = "sophia-agent-runtime";
export const SOPHIA_AGENT_RUNTIME_GUEST_ROOT = "/opt/choreograph-runtime/sophia-agent";
export const SOPHIA_AGENT_PACKAGE_ROOT = `${SOPHIA_AGENT_RUNTIME_GUEST_ROOT}/node_modules/@earendil-works/pi-coding-agent`;
export const SOPHIA_AGENT_SANDBOX_PATH = `${SOPHIA_AGENT_PACKAGE_ROOT}/dist/sophia/host-worker.js`;
export const SOPHIA_KERNEL_RUNTIME_BUNDLE_ID = "sophia-kernel-runtime";
export const SOPHIA_KERNEL_RUNTIME_GUEST_ROOT = "/opt/choreograph-runtime/sophia-kernel-runtime";
export const SOPHIA_KERNEL_RUNTIME_PYTHON_ROOT = `${SOPHIA_KERNEL_RUNTIME_GUEST_ROOT}/src`;
export const SOPHIA_AGENT_PYTHONPATH = [
	`${SOPHIA_AGENT_PACKAGE_ROOT}/dist/prime-agent-runtime/src`,
	`${SOPHIA_AGENT_PACKAGE_ROOT}/dist/skills/garden/src`,
].join(":");
export const JUPYTER_BRIDGE_GUEST_ROOT = "/opt/choreograph-runtime/bridges";
export const JUPYTER_BRIDGE_GUEST_PATH = `${JUPYTER_BRIDGE_GUEST_ROOT}/jupyter-bridge`;
export const PYTHON_RUNTIME_GUEST_ROOT = "/opt/runtime/python";
export const PYTHON_RUNTIME_BIN_DIR = `${PYTHON_RUNTIME_GUEST_ROOT}/bin`;
export const PYTHON_RUNTIME_SANDBOX_PATH = `${PYTHON_RUNTIME_BIN_DIR}/python3`;
export const JULIA_RUNTIME_GUEST_ROOT = "/opt/runtime/julia";
export const JULIA_RUNTIME_BIN_DIR = `${JULIA_RUNTIME_GUEST_ROOT}/bin`;
export const JULIA_RUNTIME_SANDBOX_PATH = `${JULIA_RUNTIME_BIN_DIR}/julia`;
/** Minor version of the pinned Julia in src/Dockerfile; names the baked environment. */
export const JULIA_RUNTIME_MINOR = "v1.11";
/**
 * Read-only depot baked at image/bundle build time: IJulia, its dependencies,
 * their artifacts, and their precompile caches. The sandbox has no network, so
 * anything missing here can never be fetched.
 */
export const JULIA_RUNTIME_DEPOT_GUEST_PATH = `${JULIA_RUNTIME_GUEST_ROOT}/depot`;
export const JULIA_RUNTIME_PROJECT_GUEST_PATH = `${JULIA_RUNTIME_DEPOT_GUEST_PATH}/environments/${JULIA_RUNTIME_MINOR}`;
export const JULIA_KERNEL_LAUNCHER_GUEST_PATH = `${JULIA_RUNTIME_GUEST_ROOT}/launch_kernel.jl`;
/**
 * Writable head of the stacked depot. Lives on the sandbox's tmpfs /tmp so
 * Julia has somewhere to put a compile cache it decides to build, while every
 * package still resolves out of the read-only baked depot behind it.
 */
export const JULIA_WRITABLE_DEPOT_GUEST_PATH = "/tmp/julia-depot";
export const OCAML_RUNTIME_GUEST_ROOT = "/opt/runtime/ocaml";
/**
 * The opam local switch. opam is not relocatable and OCaml is the sharpest case
 * of it: this prefix is written into lib/findlib.conf, into lib/ocaml/ld.conf,
 * into Config.standard_library, and into the `#!` line of every bytecode
 * executable in bin/. Julia's caches only *validate* the paths they recorded;
 * these are *executed*. The switch is therefore built at, and mounted at, the
 * same absolute path — moving the bundle breaks it irreparably.
 */
export const OCAML_RUNTIME_SWITCH_GUEST_PATH = `${OCAML_RUNTIME_GUEST_ROOT}/_opam`;
export const OCAML_RUNTIME_BIN_DIR = `${OCAML_RUNTIME_SWITCH_GUEST_PATH}/bin`;
export const OCAML_KERNEL_SANDBOX_PATH = `${OCAML_RUNTIME_BIN_DIR}/ocaml-jupyter-kernel`;
/**
 * Shared objects the switch's C stubs need and the sandbox does not otherwise
 * have: libzmq (built into the bundle) plus whatever the stubs' link closure
 * pulled in. The stubs carry an absolute RUNPATH to here, so the loader path
 * travels with the artifact instead of with an environment variable.
 */
export const OCAML_RUNTIME_LIB_GUEST_PATH = `${OCAML_RUNTIME_GUEST_ROOT}/lib`;
export const CPP_RUNTIME_GUEST_ROOT = "/opt/runtime/cpp";
export const CPP_RUNTIME_BIN_DIR = `${CPP_RUNTIME_GUEST_ROOT}/bin`;
export const CPP_KERNEL_SANDBOX_PATH = `${CPP_RUNTIME_BIN_DIR}/xcpp`;
/**
 * Version-free names for the three toolchain pieces xeus-cpp has to be told
 * about, published as symlinks by deploy/cpp-runtime/bake-runtime.sh.
 *
 * They exist for the same reason deploy/julia-runtime/launch_kernel.jl exists:
 * the real paths carry a version (`lib/clang/21`) and a conda triple
 * (`x86_64-conda-linux-gnu/sysroot`), and neither belongs in a registry entry
 * that would then need editing every time a pin moves. The build discovers
 * them, asserts them, and publishes them here.
 */
export const CPP_RUNTIME_TOOLCHAIN_DIR = `${CPP_RUNTIME_GUEST_ROOT}/share/choreograph`;
export const CPP_RUNTIME_RESOURCE_DIR = `${CPP_RUNTIME_TOOLCHAIN_DIR}/resource-dir`;
export const CPP_RUNTIME_GCC_TOOLCHAIN_DIR = `${CPP_RUNTIME_TOOLCHAIN_DIR}/gcc-toolchain`;
export const CPP_RUNTIME_SYSROOT_DIR = `${CPP_RUNTIME_TOOLCHAIN_DIR}/sysroot`;
/** xeus-cpp's own headers (xcpp::display and friends), mirroring upstream's `-I`. */
export const CPP_RUNTIME_INCLUDE_DIR = `${CPP_RUNTIME_GUEST_ROOT}/include`;
/**
 * Written by the build with the exact flags it verified a `#include <iostream>`
 * against. deploy/smoke-cpp-bundles.mjs reads it and refuses to run if the argv
 * below drifts from it — a registry and a payload that disagree about the
 * toolchain produce a kernel that starts and then cannot compile anything.
 */
export const CPP_RUNTIME_TOOLCHAIN_MANIFEST = `${CPP_RUNTIME_TOOLCHAIN_DIR}/toolchain.json`;
/** The `-std=` the kernel offers; must equal CPP_STD in Dockerfile.kernels. */
export const CPP_RUNTIME_STD = "c++20";

export function resolveRuntimeBundleMounts(bundleId: string): RuntimeBundleMount[] {
	const { bundlesById, manifestDir } = loadRuntimeBundleManifest();
	const bundle = bundlesById.get(bundleId);
	if (!bundle) throw new Error(`Unknown runtime bundle: ${bundleId}`);
	return resolveBundleMounts(bundle, manifestDir);
}

/**
 * Resolve the trusted manifest record used to execute a runtime bundle.
 *
 * Runtime bindings use `sha256:<hex>` Meaningful Object digests while the
 * deployment manifest stores the bare archive hex. Keeping normalization here
 * gives the spawn admission boundary one unambiguous artifact identity.
 */
export function resolveRuntimeBundleDescriptor(bundleId: string): RuntimeBundleDescriptor {
	const localBody = localAgentBodyDescriptor(bundleId);
	if (localBody) return localBody;
	const { bundlesById, manifestDir } = loadRuntimeBundleManifest();
	const bundle = bundlesById.get(bundleId);
	if (!bundle) {
		throw new Error(`Unknown runtime bundle: ${bundleId}`);
	}
	if (!bundle.digest || !/^[a-f0-9]{64}$/.test(bundle.digest)) {
		throw new Error(`Runtime bundle ${bundle.id} must define a lowercase sha256 digest`);
	}
	if (bundle.id === SOPHIA_AGENT_RUNTIME_BUNDLE_ID) {
		const explicitSourceMounts = bundle.mounts.filter((mount) => mount.hostPath !== undefined);
		if (explicitSourceMounts.length > 0) {
			if (explicitSourceMounts.length !== 1 || bundle.mounts.length !== 1) {
				throw new Error("Explicit Sophia source runtime must be one sealed read-only mount");
			}
			const sourceRoot = resolveBundleMountHostPath(bundle, explicitSourceMounts[0], manifestDir);
			const actual = isAgentBodyRoot(sourceRoot)
				? digestAgentBodyArtifact(sourceRoot)
				: digestSophiaAgentSourceTree(
						join(sourceRoot, "packages", "coding-agent", "src", "sophia", "host-worker.ts"),
					);
			if (actual !== `sha256:${bundle.digest}`) {
				throw new Error(
					`Runtime bundle ${bundle.id} manifest digest does not attest its mounted source bytes: ${actual}`,
				);
			}
		}
	}

	const mounts = resolveBundleMounts(bundle, manifestDir);
	return {
		id: bundle.id,
		...(bundle.description ? { description: bundle.description } : {}),
		digest: bundle.digest,
		mounts,
	};
}

function resolveBundleMounts(bundle: ParsedRuntimeBundleRecord, manifestDir: string): RuntimeBundleMount[] {
	return bundle.mounts.map((mount, index) => {
		const hostPath = resolveBundleMountHostPath(bundle, mount, manifestDir);
		if (!existsSync(hostPath)) {
			throw new Error(`Runtime bundle ${bundle.id} mount #${index + 1} host path does not exist: ${hostPath}`);
		}
		return {
			hostPath,
			guestPath: mount.guestPath,
			mode: mount.mode,
		};
	});
}

/**
 * Content attestation for the TypeScript source-mode Prime runtime used by the
 * macOS local-native harness. This is deliberately a source-tree digest, not a
 * caller supplied label: every executable source file plus the lock/config
 * inputs that select its dependencies contributes to the hash.
 */
export function digestSophiaAgentSourceTree(entrypoint: string): string {
	const root = resolveSophiaAgentSourceRoot(entrypoint);
	const roots = [
		"package.json",
		"pnpm-lock.yaml",
		"pnpm-workspace.yaml",
		"tsconfig.json",
		"tsconfig.base.json",
		"packages/agent/package.json",
		"packages/agent/src",
		"packages/ai/package.json",
		"packages/ai/src",
		"packages/coding-agent/package.json",
		"packages/coding-agent/src",
		"packages/tui/package.json",
		"packages/tui/src",
		"prime-agent-runtime",
	];
	const files = roots.flatMap((candidate) => collectAttestedFiles(root, resolve(root, candidate))).sort();
	if (files.length === 0 || !files.includes(resolve(entrypoint))) {
		throw new Error(`Sophia runtime attestation does not include its entrypoint: ${entrypoint}`);
	}
	const hash = createHash("sha256");
	hash.update("sophia-agent-source-tree.v2\0");
	for (const path of files) {
		const logicalPath = relative(root, path).split(sep).join("/");
		const stat = lstatSync(path);
		hash.update(logicalPath);
		hash.update("\0");
		if (stat.isSymbolicLink()) throw new Error(`Sophia runtime source attestation rejects symlinks: ${path}`);
		hash.update("file\0");
		hash.update(readFileSync(path));
		hash.update("\0");
	}
	return `sha256:${hash.digest("hex")}`;
}

/**
 * The local-native agent body: either the Prime source tree (the hosted body, run from source) or Choreograph's own
 * pi body (`packages/agent-body`, from source or bundled). Its digest is what a runtime binding pins and what
 * `admitAgentExecution` re-derives before every spawn.
 */
export function digestLocalAgentRuntime(entrypoint: string): string {
	const body = findAgentBodyRoot(entrypoint);
	return body ? digestAgentBodyArtifact(body) : digestSophiaAgentSourceTree(entrypoint);
}

/** `package.json` `name` that marks the root of Choreograph's pi agent body, in source or bundled form. */
export const AGENT_BODY_PACKAGE_NAME = "@sophia-labs/choreograph-agent-body";

function isAgentBodyRoot(directory: string): boolean {
	const manifest = join(directory, "package.json");
	if (!existsSync(manifest)) return false;
	try {
		return (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name === AGENT_BODY_PACKAGE_NAME;
	} catch {
		return false;
	}
}

function findAgentBodyRoot(entrypoint: string): string | undefined {
	let directory = dirname(resolve(entrypoint));
	while (true) {
		if (isAgentBodyRoot(directory)) return directory;
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

/**
 * Content attestation for the pi agent body: every file under its root (its `package.json` pins pi exactly), with
 * the same exclusions as the Prime source attestation, and tests left out. A bundled body is one directory of
 * files; a source body is `src/`, `package.json` and `tsconfig.json`, which is what decides what runs.
 */
export function digestAgentBodyArtifact(root: string): string {
	const absoluteRoot = resolve(root);
	if (!isAgentBodyRoot(absoluteRoot)) throw new Error(`Not a Choreograph agent body: ${absoluteRoot}`);
	const files = collectAttestedFiles(absoluteRoot, absoluteRoot)
		.filter((path) => {
			const logical = relative(absoluteRoot, path).split(sep);
			return logical[0] !== "test" && logical[0] !== "scripts";
		})
		.sort();
	const hash = createHash("sha256");
	hash.update("choreograph-agent-body.v1\0");
	for (const path of files) {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) throw new Error(`Agent body attestation rejects symlinks: ${path}`);
		hash.update(relative(absoluteRoot, path).split(sep).join("/"));
		hash.update("\0file\0");
		hash.update(readFileSync(path));
		hash.update("\0");
	}
	return `sha256:${hash.digest("hex")}`;
}

/**
 * Without a runtime bundle manifest, a local-native Choreograph whose `SOPHIA_AGENT_RUNTIME_ENTRYPOINT` names the pi
 * body attests that body itself: the descriptor is derived, not configured, so a packaged Choreograph needs no
 * manifest file and no digest written at packaging time. Hosted Choreograph always has a manifest and never gets here.
 */
function localAgentBodyDescriptor(bundleId: string): RuntimeBundleDescriptor | undefined {
	if (bundleId !== SOPHIA_AGENT_RUNTIME_BUNDLE_ID || resolveRuntimeBundleManifestPath()) return undefined;
	if (process.env.CHOREOGRAPH_SANDBOX_MODE?.trim() !== "local-native") return undefined;
	const entrypoint = process.env.SOPHIA_AGENT_RUNTIME_ENTRYPOINT?.trim();
	if (!entrypoint) return undefined;
	const root = findAgentBodyRoot(entrypoint);
	if (!root) return undefined;
	return {
		id: SOPHIA_AGENT_RUNTIME_BUNDLE_ID,
		description: "Choreograph's pi agent body (local-native)",
		digest: digestAgentBodyArtifact(root).slice("sha256:".length),
		mounts: [],
	};
}

export function listRuntimeBundles(): Array<{ id: string; description?: string; digest?: string }> {
	const { bundlesById } = loadRuntimeBundleManifest();
	return Array.from(bundlesById.values()).map((bundle) => ({
		id: bundle.id,
		description: bundle.description,
		digest: bundle.digest,
	}));
}

function loadRuntimeBundleManifest(): {
	manifestPath: string;
	manifestDir: string;
	bundlesById: Map<string, ParsedRuntimeBundleRecord>;
} {
	const manifestPath = resolveRuntimeBundleManifestPath();
	if (!manifestPath) {
		throw new Error("Runtime bundle manifest is not configured. Set CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST.");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		throw new Error(
			`Failed to read runtime bundle manifest at ${manifestPath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { bundles?: unknown }).bundles)) {
		throw new Error(`Runtime bundle manifest must contain a bundles array: ${manifestPath}`);
	}

	const bundlesById = new Map<string, ParsedRuntimeBundleRecord>();
	const manifestDir = dirname(manifestPath);
	for (const [index, value] of (parsed as { bundles: unknown[] }).bundles.entries()) {
		const bundle = parseRuntimeBundleRecord(value, index);
		if (bundlesById.has(bundle.id)) {
			throw new Error(`Runtime bundle manifest contains duplicate id: ${bundle.id}`);
		}
		bundlesById.set(bundle.id, bundle);
	}

	return {
		manifestPath,
		manifestDir,
		bundlesById,
	};
}

function resolveRuntimeBundleManifestPath(): string | undefined {
	for (const envName of RUNTIME_BUNDLE_MANIFEST_ENV_VARS) {
		const rawPath = process.env[envName]?.trim();
		if (!rawPath) {
			continue;
		}
		return resolve(rawPath);
	}
	return undefined;
}

function resolveBundleCacheDir(): string | undefined {
	for (const envName of BUNDLE_CACHE_DIR_ENV_VARS) {
		const rawPath = process.env[envName]?.trim();
		if (!rawPath) {
			continue;
		}
		return resolve(rawPath);
	}
	return undefined;
}

function parseRuntimeBundleRecord(value: unknown, index: number): ParsedRuntimeBundleRecord {
	if (typeof value !== "object" || value === null) {
		throw new Error(`Runtime bundle entry #${index + 1} must be an object`);
	}

	const candidate = value as RuntimeBundleManifestRecord;
	if (typeof candidate.id !== "string" || candidate.id.trim() === "") {
		throw new Error(`Runtime bundle entry #${index + 1} is missing a string id`);
	}
	if (!Array.isArray(candidate.mounts) || candidate.mounts.length === 0) {
		throw new Error(`Runtime bundle ${candidate.id} must define at least one mount`);
	}
	if (candidate.description != null && typeof candidate.description !== "string") {
		throw new Error(`Runtime bundle ${candidate.id} description must be a string when provided`);
	}
	if (candidate.digest != null && (typeof candidate.digest !== "string" || candidate.digest.trim() === "")) {
		throw new Error(`Runtime bundle ${candidate.id} digest must be a non-empty string when provided`);
	}

	return {
		id: candidate.id.trim(),
		description: candidate.description?.trim(),
		digest: candidate.digest?.trim(),
		mounts: candidate.mounts.map((mount, mountIndex) =>
			parseRuntimeBundleMountRecord(candidate.id!.trim(), mount, mountIndex),
		),
	};
}

function parseRuntimeBundleMountRecord(
	bundleId: string,
	value: unknown,
	index: number,
): ParsedRuntimeBundleMountRecord {
	if (typeof value !== "object" || value === null) {
		throw new Error(`Runtime bundle ${bundleId} mount #${index + 1} must be an object`);
	}

	const candidate = value as RuntimeBundleManifestMountRecord;
	if (typeof candidate.guest_path !== "string" || candidate.guest_path.trim() === "") {
		throw new Error(`Runtime bundle ${bundleId} mount #${index + 1} is missing guest_path`);
	}
	const mode = candidate.mode ?? "ro";
	if (mode !== "ro" && mode !== "rw") {
		throw new Error(`Runtime bundle ${bundleId} mount #${index + 1} has invalid mode: ${String(mode)}`);
	}

	if (candidate.host_path != null && (typeof candidate.host_path !== "string" || candidate.host_path.trim() === "")) {
		throw new Error(`Runtime bundle ${bundleId} mount #${index + 1} host_path must be a string when provided`);
	}
	if (
		candidate.local_subpath != null &&
		(typeof candidate.local_subpath !== "string" || candidate.local_subpath.trim() === "")
	) {
		throw new Error(`Runtime bundle ${bundleId} mount #${index + 1} local_subpath must be a string when provided`);
	}
	if (candidate.host_path == null && candidate.local_subpath == null) {
		return {
			guestPath: candidate.guest_path.trim(),
			mode,
		};
	}

	return {
		guestPath: candidate.guest_path.trim(),
		mode,
		hostPath: candidate.host_path?.trim(),
		localSubpath: candidate.local_subpath?.trim(),
	};
}

function resolveBundleMountHostPath(
	bundle: ParsedRuntimeBundleRecord,
	mount: ParsedRuntimeBundleMountRecord,
	manifestDir: string,
): string {
	if (mount.hostPath) {
		return isAbsolute(mount.hostPath) ? mount.hostPath : resolve(manifestDir, mount.hostPath);
	}

	if (!bundle.digest) {
		throw new Error(`Runtime bundle ${bundle.id} must define a digest when mounts do not provide host_path`);
	}

	const bundleCacheDir = resolveBundleCacheDir();
	if (!bundleCacheDir) {
		throw new Error(`Runtime bundle ${bundle.id} requires CHOREOGRAPH_BUNDLE_CACHE_DIR for cached resolution`);
	}

	return mount.localSubpath
		? resolve(bundleCacheDir, bundle.digest, mount.localSubpath)
		: resolve(bundleCacheDir, bundle.digest);
}

function resolveSophiaAgentSourceRoot(entrypoint: string): string {
	const absoluteEntrypoint = resolve(entrypoint);
	if (!existsSync(absoluteEntrypoint)) {
		throw new Error(`Sophia local-native entrypoint does not exist: ${absoluteEntrypoint}`);
	}
	let directory = dirname(absoluteEntrypoint);
	while (true) {
		if (
			existsSync(join(directory, "pnpm-lock.yaml")) &&
			existsSync(join(directory, "packages", "coding-agent", "src"))
		) {
			return directory;
		}
		const parent = dirname(directory);
		if (parent === directory) {
			throw new Error(`Could not locate the Sophia agent source root above ${absoluteEntrypoint}`);
		}
		directory = parent;
	}
}

function collectAttestedFiles(root: string, candidate: string): string[] {
	if (!existsSync(candidate)) return [];
	const stat = lstatSync(candidate);
	if (stat.isFile() || stat.isSymbolicLink()) return [candidate];
	if (!stat.isDirectory()) return [];
	const files: string[] = [];
	for (const entry of readdirSync(candidate, { withFileTypes: true })) {
		if (SOURCE_ATTESTATION_EXCLUDED_NAMES.has(entry.name)) continue;
		const path = join(candidate, entry.name);
		if (!path.startsWith(`${root}${sep}`)) {
			throw new Error(`Sophia runtime attestation escaped its source root: ${path}`);
		}
		files.push(...collectAttestedFiles(root, path));
	}
	return files;
}

const SOURCE_ATTESTATION_EXCLUDED_NAMES = new Set([
	".git",
	".DS_Store",
	".venv",
	"__pycache__",
	"coverage",
	"dist",
	"node_modules",
	"target",
]);
