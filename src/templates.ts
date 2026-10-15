/**
 * Named bwrap argument presets for sandbox templates.
 *
 * Templates define the sandbox's baseline isolation shape. Reusable filesystem
 * bundles define what host content gets bind-mounted into that shape.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, normalize, resolve } from "node:path";
import { resolveFilesystemMounts } from "./filesystems.js";
import { PYTHON_RUNTIME_BIN_DIR } from "./runtime-bundles.js";

// ─── Types ──────────────────────────────────────────────────────────────

export type TemplateId = "agent" | "bare" | "workspace" | "python";

export interface TemplateInfo {
	id: TemplateId;
	description: string;
	default_filesystems?: string[];
}

export interface WorkerEntrypoint {
	hostScriptPath?: string;
	sandboxEntrypointPath?: string;
}

export interface PrivateSandboxMount {
	hostPath: string;
	guestPath:
		| "/workspace"
		| "/stage-input"
		| "/stage-output"
		| "/stage-runtime"
		| "/stage-model"
		| "/candidate"
		| "/sandbox/prime-daemon"
		| `/opt/sophia/extensions/${string}`
		| `/opt/sophia/reviewed-skills/sha256-${string}`;
	mode: "ro" | "rw";
}

interface BuildArgsOptions {
	nodeExecutable: string;
	worker: WorkerEntrypoint;
	workspaceRoot: string;
	env?: Record<string, string>;
	filesystems?: string[];
	privateMounts?: readonly PrivateSandboxMount[];
}

function buildRuntimePath(nodeExecutable: string): string {
	return Array.from(new Set([dirname(nodeExecutable), "/usr/bin", "/bin"])).join(":");
}

// ─── Base Args ──────────────────────────────────────────────────────────

function baseArgs(opts: BuildArgsOptions): string[] {
	const runtimePath = buildRuntimePath(opts.nodeExecutable);

	return [
		// Namespace isolation
		"--unshare-all",
		"--die-with-parent",

		// Host runtime (read-only). /lib64 exists only on x86_64 (arm64 loaders
		// live under /usr/lib, reached via the /lib symlink below) — bind it only
		// where the host actually has it, or bwrap dies at spawn on aarch64.
		"--ro-bind",
		"/usr",
		"/usr",
		...(existsSync("/lib64") ? ["--ro-bind", "/lib64", "/lib64"] : []),
		"--symlink",
		"/usr/lib",
		"/lib",
		"--symlink",
		"/usr/bin",
		"/bin",
		"--symlink",
		"/usr/sbin",
		"/sbin",
		"--ro-bind",
		opts.nodeExecutable,
		opts.nodeExecutable,

		"--tmpfs",
		"/sandbox",

		// Writable scratch
		"--tmpfs",
		"/tmp",

		// Kernel interfaces
		"--proc",
		"/proc",
		"--dev",
		"/dev",

		// Drop all capabilities
		"--cap-drop",
		"ALL",

		// Clean environment
		"--clearenv",
		"--setenv",
		"HOME",
		"/tmp",
		"--setenv",
		"NODE_NO_WARNINGS",
		"1",
		"--setenv",
		"PATH",
		runtimePath,
	];
}

function withEnv(args: string[], env: Record<string, string>): string[] {
	const envArgs: string[] = [];
	for (const [key, value] of Object.entries(env)) {
		envArgs.push("--setenv", key, value);
	}
	return [...args, ...envArgs];
}

function withFilesystemMounts(args: string[], opts: BuildArgsOptions): string[] {
	const mounts = resolveFilesystemMounts(opts.filesystems, {
		workspaceRoot: opts.workspaceRoot,
	});
	for (const mount of mounts) {
		args.push(mount.mode === "rw" ? "--bind" : "--ro-bind", mount.hostPath, mount.guestPath);
	}
	return args;
}

function withPrivateMounts(args: string[], opts: BuildArgsOptions): string[] {
	const seenGuests = new Set<string>();
	let extensionRootCreated = false;
	let reviewedSkillsRootCreated = false;
	for (const mount of opts.privateMounts ?? []) {
		if (!isAbsolute(mount.hostPath)) {
			throw new Error(`Private sandbox mount host path must be absolute: ${mount.hostPath}`);
		}
		const fixedGuest = [
			"/workspace",
			"/stage-input",
			"/stage-output",
			"/stage-runtime",
			"/stage-model",
			"/candidate",
			"/sandbox/prime-daemon",
		].includes(mount.guestPath);
		const extensionGuest = /^\/opt\/sophia\/extensions\/[a-z0-9][a-z0-9._-]{0,127}$/.test(mount.guestPath);
		const reviewedSkillGuest = /^\/opt\/sophia\/reviewed-skills\/sha256-[a-f0-9]{64}$/.test(mount.guestPath);
		if ((!fixedGuest && !extensionGuest && !reviewedSkillGuest) || normalize(mount.guestPath) !== mount.guestPath) {
			throw new Error(`Private sandbox mount guest path is not allowlisted: ${mount.guestPath}`);
		}
		if (mount.guestPath === "/candidate" && mount.mode !== "rw") {
			throw new Error("Candidate workspace private mount must be writable");
		}
		if (mount.guestPath === "/workspace" && mount.mode !== "rw") {
			throw new Error("Personal workspace private mount must be writable");
		}
		if ((extensionGuest || reviewedSkillGuest) && mount.mode !== "ro") {
			throw new Error("Prime extension private mounts must be read-only");
		}
		if (seenGuests.has(mount.guestPath)) {
			throw new Error(`Duplicate private sandbox mount guest path: ${mount.guestPath}`);
		}
		seenGuests.add(mount.guestPath);
		if (extensionGuest && !extensionRootCreated) {
			args.push("--dir", "/opt", "--dir", "/opt/sophia", "--dir", "/opt/sophia/extensions");
			extensionRootCreated = true;
		}
		if (reviewedSkillGuest && !reviewedSkillsRootCreated) {
			args.push("--dir", "/opt", "--dir", "/opt/sophia", "--dir", "/opt/sophia/reviewed-skills");
			reviewedSkillsRootCreated = true;
		}
		args.push("--dir", mount.guestPath);
		args.push(mount.mode === "rw" ? "--bind" : "--ro-bind", mount.hostPath, mount.guestPath);
	}
	return args;
}

function withEntrypoint(args: string[], opts: BuildArgsOptions): string[] {
	if (opts.worker.hostScriptPath) {
		return [
			...args,
			"--ro-bind",
			opts.worker.hostScriptPath,
			"/sandbox/worker.mjs",
			"--",
			opts.nodeExecutable,
			"/sandbox/worker.mjs",
		];
	}

	if (opts.worker.sandboxEntrypointPath) {
		return [...args, "--", opts.nodeExecutable, opts.worker.sandboxEntrypointPath];
	}

	throw new Error("Worker entrypoint must provide either hostScriptPath or sandboxEntrypointPath");
}

// ─── Templates ──────────────────────────────────────────────────────────

function buildBareArgs(opts: BuildArgsOptions): string[] {
	let args = baseArgs(opts);
	args = withFilesystemMounts(args, opts);
	args = withPrivateMounts(args, opts);
	if (opts.env) args = withEnv(args, opts.env);
	return withEntrypoint(args, opts);
}

function buildWorkspaceArgs(opts: BuildArgsOptions): string[] {
	return buildBareArgs(opts);
}

function buildAgentArgs(opts: BuildArgsOptions): string[] {
	let args = baseArgs(opts);
	args = withFilesystemMounts(args, opts);
	args = withPrivateMounts(args, opts);
	args.push("--setenv", "CHOREOGRAPH_SANDBOX", "1");
	if (opts.env) {
		args = withEnv(args, opts.env);
	}
	return withEntrypoint(args, opts);
}

function buildPythonArgs(opts: BuildArgsOptions): string[] {
	let args = baseArgs(opts);
	args = withFilesystemMounts(args, opts);
	args = withPrivateMounts(args, opts);
	// Writable home for pip/venv
	args.push("--tmpfs", "/home/sandbox");
	args = withEnv(args, {
		HOME: "/home/sandbox",
		PATH: `${PYTHON_RUNTIME_BIN_DIR}:${buildRuntimePath(opts.nodeExecutable)}`,
		...(opts.env ?? {}),
	});
	return withEntrypoint(args, opts);
}

// ─── Registry ───────────────────────────────────────────────────────────

const TEMPLATES: Record<
	TemplateId,
	{
		info: TemplateInfo;
		buildArgs: (opts: BuildArgsOptions) => string[];
	}
> = {
	agent: {
		info: {
			id: "agent",
			description: "Bare + Sophia agent semantic runtime mounted read-only",
			default_filesystems: ["sophia-agent-runtime"],
		},
		buildArgs: buildAgentArgs,
	},
	bare: {
		info: { id: "bare", description: "Minimal Node.js runtime with namespace isolation" },
		buildArgs: buildBareArgs,
	},
	workspace: {
		info: {
			id: "workspace",
			description: "Bare + repo mounted read-only at /workspace",
			default_filesystems: ["workspace"],
		},
		buildArgs: buildWorkspaceArgs,
	},
	python: {
		info: {
			id: "python",
			description: "Bare + Python 3 with writable home directory",
			default_filesystems: ["python-runtime"],
		},
		buildArgs: buildPythonArgs,
	},
};

export function getTemplate(id: string): (typeof TEMPLATES)[TemplateId] | undefined {
	return TEMPLATES[id as TemplateId];
}

export function listTemplates(): TemplateInfo[] {
	return Object.values(TEMPLATES).map((t) => t.info);
}

export function resolveTemplateFilesystemIds(templateId: string, extraFilesystems?: readonly string[]): string[] {
	const template = getTemplate(templateId);
	if (!template) {
		throw new Error(`Unknown template: ${templateId}`);
	}

	return Array.from(new Set([...(template.info.default_filesystems ?? []), ...(extraFilesystems ?? [])]));
}

export function buildBwrapArgs(
	templateId: string,
	worker: string | WorkerEntrypoint,
	env?: Record<string, string>,
	options?: { filesystems?: string[]; privateMounts?: readonly PrivateSandboxMount[] },
): string[] {
	const template = getTemplate(templateId);
	if (!template) {
		throw new Error(`Unknown template: ${templateId}`);
	}

	const workerEntry =
		typeof worker === "string"
			? { hostScriptPath: resolve(worker) }
			: {
					hostScriptPath: worker.hostScriptPath ? resolve(worker.hostScriptPath) : undefined,
					sandboxEntrypointPath: worker.sandboxEntrypointPath,
				};

	const workspaceRoot = process.env.WORKSPACE_ROOT
		? resolve(process.env.WORKSPACE_ROOT)
		: existsSync("/workspace")
			? "/workspace"
			: resolve(process.cwd());

	return template.buildArgs({
		nodeExecutable: process.execPath,
		worker: workerEntry,
		workspaceRoot,
		env,
		filesystems: resolveTemplateFilesystemIds(templateId, options?.filesystems),
		privateMounts: options?.privateMounts,
	});
}
