/**
 * Filesystem bundle registry for sandbox mounts.
 *
 * Templates describe the sandbox's baseline isolation shape. Filesystem bundles
 * describe reusable host trees or files that can be mounted into that shape.
 * Bundles can be built in or loaded from a JSON manifest so prebuilt runtimes
 * and caches can be shared across many sandboxes without per-spawn setup.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
	CPP_RUNTIME_GUEST_ROOT,
	JULIA_RUNTIME_GUEST_ROOT,
	JUPYTER_BRIDGE_GUEST_ROOT,
	OCAML_RUNTIME_GUEST_ROOT,
	PYTHON_RUNTIME_GUEST_ROOT,
	resolveRuntimeBundleMounts,
	SOPHIA_AGENT_RUNTIME_BUNDLE_ID,
	SOPHIA_AGENT_RUNTIME_GUEST_ROOT,
	SOPHIA_KERNEL_RUNTIME_BUNDLE_ID,
	SOPHIA_KERNEL_RUNTIME_GUEST_ROOT,
} from "./runtime-bundles.js";

export type FilesystemMountMode = "ro" | "rw";

export interface FilesystemMount {
	hostPath: string;
	guestPath: string;
	mode: FilesystemMountMode;
}

export interface FilesystemMountInfo {
	guest_path: string;
	mode: FilesystemMountMode;
}

export interface FilesystemInfo {
	id: string;
	description: string;
	source: "builtin" | "manifest";
	mounts: FilesystemMountInfo[];
}

interface FilesystemDefinition {
	info: FilesystemInfo;
	resolveMounts: (ctx: ResolveFilesystemContext) => FilesystemMount[];
}

interface ResolveFilesystemContext {
	workspaceRoot: string;
}

interface ManifestFilesystemRecord {
	id: string;
	description: string;
	mounts: FilesystemMount[];
}

const FILESYSTEM_MANIFEST_ENV_VARS = [
	"CHOREOGRAPH_SANDBOX_FILESYSTEMS_MANIFEST",
	"SANDBOX_FILESYSTEMS_MANIFEST",
] as const;

const BUILTIN_FILESYSTEMS: Record<string, FilesystemDefinition> = {
	[SOPHIA_AGENT_RUNTIME_BUNDLE_ID]: {
		info: {
			id: SOPHIA_AGENT_RUNTIME_BUNDLE_ID,
			description: "Sophia agent semantic core with simple and constrained-Prime profiles",
			source: "builtin",
			mounts: [{ guest_path: SOPHIA_AGENT_RUNTIME_GUEST_ROOT, mode: "ro" }],
		},
		resolveMounts: () => resolveRuntimeBundleMounts(SOPHIA_AGENT_RUNTIME_BUNDLE_ID),
	},
	[SOPHIA_KERNEL_RUNTIME_BUNDLE_ID]: {
		info: {
			id: SOPHIA_KERNEL_RUNTIME_BUNDLE_ID,
			description: "Sophia-owned Python kernel control and harness runtime",
			source: "builtin",
			mounts: [{ guest_path: SOPHIA_KERNEL_RUNTIME_GUEST_ROOT, mode: "ro" }],
		},
		resolveMounts: () => resolveRuntimeBundleMounts(SOPHIA_KERNEL_RUNTIME_BUNDLE_ID),
	},
	"python-runtime": {
		info: {
			id: "python-runtime",
			description: "Bundled Python 3 runtime mounted read-only",
			source: "builtin",
			mounts: [{ guest_path: PYTHON_RUNTIME_GUEST_ROOT, mode: "ro" }],
		},
		resolveMounts: () => resolveRuntimeBundleMounts("python-runtime"),
	},
	"julia-runtime": {
		info: {
			id: "julia-runtime",
			description: "Bundled Julia runtime plus the baked IJulia depot, mounted read-only",
			source: "builtin",
			mounts: [{ guest_path: JULIA_RUNTIME_GUEST_ROOT, mode: "ro" }],
		},
		resolveMounts: () => resolveRuntimeBundleMounts("julia-runtime"),
	},
	"ocaml-runtime": {
		info: {
			id: "ocaml-runtime",
			description: "Bundled OCaml opam switch with ocaml-jupyter and its libzmq, mounted read-only",
			source: "builtin",
			mounts: [{ guest_path: OCAML_RUNTIME_GUEST_ROOT, mode: "ro" }],
		},
		resolveMounts: () => resolveRuntimeBundleMounts("ocaml-runtime"),
	},
	"cpp-runtime": {
		info: {
			id: "cpp-runtime",
			description: "Bundled xeus-cpp kernel with its clang-repl toolchain and sysroot, mounted read-only",
			source: "builtin",
			mounts: [{ guest_path: CPP_RUNTIME_GUEST_ROOT, mode: "ro" }],
		},
		resolveMounts: () => resolveRuntimeBundleMounts("cpp-runtime"),
	},
	"jupyter-bridge": {
		info: {
			id: "jupyter-bridge",
			description: "Jupyter ZMQ kernel bridge (NDJSON ↔ Jupyter wire protocol)",
			source: "builtin",
			mounts: [{ guest_path: JUPYTER_BRIDGE_GUEST_ROOT, mode: "ro" }],
		},
		resolveMounts: () => resolveRuntimeBundleMounts("jupyter-bridge"),
	},
	workspace: {
		info: {
			id: "workspace",
			description: "Shared workspace mounted read-only at /workspace",
			source: "builtin",
			mounts: [{ guest_path: "/workspace", mode: "ro" }],
		},
		resolveMounts: (ctx) => [{ hostPath: ctx.workspaceRoot, guestPath: "/workspace", mode: "ro" }],
	},
};

export function listFilesystems(): FilesystemInfo[] {
	const manifest = loadManifestFilesystems();
	const infos = [
		...Object.values(BUILTIN_FILESYSTEMS).map((entry) => entry.info),
		...manifest.map((entry) => ({
			id: entry.id,
			description: entry.description,
			source: "manifest" as const,
			mounts: entry.mounts.map((mount) => ({
				guest_path: mount.guestPath,
				mode: mount.mode,
			})),
		})),
	];
	return infos.sort((left, right) => left.id.localeCompare(right.id));
}

export function resolveFilesystemMounts(
	ids: readonly string[] | undefined,
	ctx: ResolveFilesystemContext,
): FilesystemMount[] {
	const requestedIds = ids ?? [];
	if (requestedIds.length === 0) {
		return [];
	}

	const registry = buildRegistry(loadManifestFilesystems());
	const mounts: FilesystemMount[] = [];
	const seenIds = new Set<string>();
	const seenMounts = new Set<string>();

	for (const id of requestedIds) {
		if (seenIds.has(id)) {
			continue;
		}
		seenIds.add(id);

		const entry = registry.get(id);
		if (!entry) {
			throw new Error(`Unknown filesystem bundle: ${id}`);
		}

		for (const mount of entry.resolveMounts(ctx)) {
			validateMount(mount, id);
			const key = `${mount.mode}:${mount.hostPath}:${mount.guestPath}`;
			if (seenMounts.has(key)) {
				continue;
			}
			seenMounts.add(key);
			mounts.push(mount);
		}
	}

	return mounts;
}

function buildRegistry(manifestFilesystems: ManifestFilesystemRecord[]): Map<string, FilesystemDefinition> {
	const registry = new Map<string, FilesystemDefinition>();

	for (const entry of Object.values(BUILTIN_FILESYSTEMS)) {
		registry.set(entry.info.id, entry);
	}

	for (const entry of manifestFilesystems) {
		if (registry.has(entry.id)) {
			throw new Error(`Filesystem bundle id conflicts with existing bundle: ${entry.id}`);
		}

		registry.set(entry.id, {
			info: {
				id: entry.id,
				description: entry.description,
				source: "manifest",
				mounts: entry.mounts.map((mount) => ({
					guest_path: mount.guestPath,
					mode: mount.mode,
				})),
			},
			resolveMounts: () => entry.mounts,
		});
	}

	return registry;
}

function loadManifestFilesystems(): ManifestFilesystemRecord[] {
	const manifestPath = resolveManifestPath();
	if (!manifestPath) {
		return [];
	}

	const manifestDir = dirname(manifestPath);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		throw new Error(
			`Failed to read sandbox filesystem manifest at ${manifestPath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!Array.isArray((parsed as { filesystems?: unknown }).filesystems)
	) {
		throw new Error(`Sandbox filesystem manifest must contain a filesystems array: ${manifestPath}`);
	}

	const filesystems = (parsed as { filesystems: unknown[] }).filesystems;
	const seenIds = new Set<string>();
	return filesystems.map((entry, index) => parseManifestFilesystem(entry, index, manifestDir, seenIds));
}

function resolveManifestPath(): string | undefined {
	for (const envName of FILESYSTEM_MANIFEST_ENV_VARS) {
		const rawPath = process.env[envName]?.trim();
		if (!rawPath) {
			continue;
		}
		return resolve(rawPath);
	}
	return undefined;
}

function parseManifestFilesystem(
	value: unknown,
	index: number,
	manifestDir: string,
	seenIds: Set<string>,
): ManifestFilesystemRecord {
	if (typeof value !== "object" || value === null) {
		throw new Error(`Filesystem manifest entry #${index + 1} must be an object`);
	}

	const candidate = value as {
		id?: unknown;
		description?: unknown;
		mounts?: unknown;
	};
	if (typeof candidate.id !== "string" || candidate.id.trim() === "") {
		throw new Error(`Filesystem manifest entry #${index + 1} is missing a string id`);
	}
	if (seenIds.has(candidate.id)) {
		throw new Error(`Filesystem manifest contains duplicate id: ${candidate.id}`);
	}
	seenIds.add(candidate.id);

	if (typeof candidate.description !== "string" || candidate.description.trim() === "") {
		throw new Error(`Filesystem bundle ${candidate.id} is missing a string description`);
	}
	if (!Array.isArray(candidate.mounts) || candidate.mounts.length === 0) {
		throw new Error(`Filesystem bundle ${candidate.id} must define at least one mount`);
	}

	return {
		id: candidate.id,
		description: candidate.description,
		mounts: candidate.mounts.map((mount, mountIndex) =>
			parseManifestMount(candidate.id, mount, mountIndex, manifestDir),
		),
	};
}

function parseManifestMount(bundleId: string, value: unknown, index: number, manifestDir: string): FilesystemMount {
	if (typeof value !== "object" || value === null) {
		throw new Error(`Filesystem bundle ${bundleId} mount #${index + 1} must be an object`);
	}

	const candidate = value as {
		host_path?: unknown;
		guest_path?: unknown;
		mode?: unknown;
	};
	if (typeof candidate.host_path !== "string" || candidate.host_path.trim() === "") {
		throw new Error(`Filesystem bundle ${bundleId} mount #${index + 1} is missing host_path`);
	}
	if (typeof candidate.guest_path !== "string" || candidate.guest_path.trim() === "") {
		throw new Error(`Filesystem bundle ${bundleId} mount #${index + 1} is missing guest_path`);
	}

	const mode = candidate.mode ?? "ro";
	if (mode !== "ro" && mode !== "rw") {
		throw new Error(`Filesystem bundle ${bundleId} mount #${index + 1} has invalid mode: ${String(mode)}`);
	}

	const hostPath = isAbsolute(candidate.host_path) ? candidate.host_path : resolve(manifestDir, candidate.host_path);

	return {
		hostPath,
		guestPath: candidate.guest_path,
		mode,
	};
}

function validateMount(mount: FilesystemMount, bundleId: string): void {
	if (!mount.guestPath.startsWith("/")) {
		throw new Error(`Filesystem bundle ${bundleId} guest path must be absolute: ${mount.guestPath}`);
	}
}
