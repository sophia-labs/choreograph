import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CapabilityBackend, HostedMcpToolDescriptor } from "../mnemosyne.js";

const execFileAsync = promisify(execFile);
const FACE_NAMES = new Set(["md", "html", "json", "xml"]);

export interface SoilCapabilityOptions {
	readonly binary: string;
	readonly roots: readonly string[];
	readonly timeoutMs?: number;
	readonly accessLevel?: "ro" | "rw";
	readonly dangerousOps?: boolean;
}

/** Bounded read-only adapter over the actual Soil CLI. */
export class SoilCapabilityBackend implements CapabilityBackend {
	readonly capabilityName = "soil";
	readonly accessLevel: "ro" | "rw";
	private readonly roots: readonly string[];
	private readonly timeoutMs: number;

	private constructor(
		private readonly binary: string,
		roots: readonly string[],
		timeoutMs: number,
		private readonly dangerousOps: boolean,
		accessLevel: "ro" | "rw",
	) {
		this.roots = roots;
		this.timeoutMs = timeoutMs;
		this.accessLevel = accessLevel;
	}

	static async create(options: SoilCapabilityOptions): Promise<SoilCapabilityBackend> {
		if (options.roots.length === 0) throw new Error("soil: at least one seed root is required");
		const roots = await Promise.all(options.roots.map((root) => realpath(root)));
		return new SoilCapabilityBackend(
			options.binary,
			roots,
			options.timeoutMs ?? 30_000,
			options.dangerousOps ?? false,
			options.accessLevel ?? "ro",
		);
	}

	async callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
		switch (tool) {
			case "export": {
				const target = await this.resolvePath(args.path, [".sd"]);
				const face = typeof args.face === "string" ? args.face : "md";
				if (!FACE_NAMES.has(face)) throw new Error(`soil: unsupported face '${face}'`);
				const result = await this.run(["export", target, "--as", face]);
				return { face, body: result.stdout, stderr: result.stderr };
			}
			case "roundtrip": {
				const inline = args.body === undefined ? undefined : boundedBody(args.body);
				const target =
					inline === undefined
						? await this.resolvePath(args.path, [".md", ".markdown"])
						: path.join(this.roots[0], `.soil-roundtrip-${randomUUID()}.md`);
				try {
					if (inline !== undefined) await writeFile(target, inline, { flag: "wx" });
					const result = await this.run(["roundtrip", target]);
					return { ok: true, stdout: result.stdout, stderr: result.stderr };
				} finally {
					if (inline !== undefined) await unlink(target).catch(() => {});
				}
			}
			case "materialize": {
				this.assertWritable();
				const target = await this.resolveWritablePath(args.path, ".sd");
				const bytes = decodeSeed(args.updateBase64 ?? args.update_base64);
				await atomicWrite(target, bytes);
				return { ok: true, path: path.relative(this.roots[0], target), bytes: bytes.byteLength };
			}
			case "import": {
				this.assertWritable();
				const target = await this.resolveWritablePath(args.path, ".sd");
				const format = args.format === "json" ? "json" : "md";
				const body = boundedBody(args.body);
				const source = path.join(path.dirname(target), `.soil-import-${randomUUID()}.${format}`);
				try {
					await writeFile(source, body, { flag: "wx" });
					const result = await this.run(["import", source, "--output", target]);
					return {
						ok: true,
						path: path.relative(this.roots[0], target),
						stdout: result.stdout,
						stderr: result.stderr,
					};
				} finally {
					await unlink(source).catch(() => {});
				}
			}
			case "delete": {
				this.assertWritable();
				if (!this.dangerousOps) throw new SoilCapabilityDeniedError("soil: delete requires dangerousOps authority");
				const target = await this.resolvePath(args.path, [".sd"]);
				await unlink(target);
				return { ok: true, deleted: path.relative(this.roots[0], target) };
			}
			default:
				throw new Error(`soil: unknown tool "${tool}"`);
		}
	}

	async listTools(): Promise<readonly HostedMcpToolDescriptor[]> {
		const tools: HostedMcpToolDescriptor[] = [
			{
				name: "export",
				destructive: false,
				description: "Project an allowlisted .sd seed as markdown, HTML, TipTap JSON, or XML through Soil.",
				inputSchema: {
					type: "object",
					properties: {
						path: { type: "string" },
						face: { type: "string", enum: ["md", "html", "json", "xml"] },
					},
					required: ["path"],
				},
			},
			{
				name: "roundtrip",
				destructive: false,
				description: "Run Soil's markdown → Y.Doc bytes → markdown fixpoint proof on an allowlisted file.",
				inputSchema: {
					type: "object",
					properties: { path: { type: "string" }, body: { type: "string" } },
					anyOf: [{ required: ["path"] }, { required: ["body"] }],
				},
			},
		];
		if (this.accessLevel === "rw") {
			tools.push(
				{
					name: "materialize",
					destructive: true,
					description: "Atomically materialize bounded Yjs update-v1 bytes as an allowlisted .sd seed.",
					inputSchema: {
						type: "object",
						properties: { path: { type: "string" }, updateBase64: { type: "string" } },
						required: ["path", "updateBase64"],
					},
				},
				{
					name: "import",
					destructive: true,
					description: "Import bounded Markdown or TipTap JSON through the real Soil implementation.",
					inputSchema: {
						type: "object",
						properties: {
							path: { type: "string" },
							format: { type: "string", enum: ["md", "json"] },
							body: { type: "string" },
						},
						required: ["path", "format", "body"],
					},
				},
			);
			if (this.dangerousOps) {
				tools.push({
					name: "delete",
					destructive: true,
					description: "Delete one allowlisted .sd scenario seed (dangerousOps authority required).",
					inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
				});
			}
		}
		return tools;
	}

	async close(): Promise<void> {}

	private async resolvePath(value: unknown, extensions: readonly string[]): Promise<string> {
		if (typeof value !== "string" || !value.trim()) throw new Error("soil: path must be a non-empty string");
		const candidate = path.isAbsolute(value) ? value : path.resolve(this.roots[0], value);
		const resolved = await realpath(candidate);
		if (!this.roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
			throw new SoilCapabilityDeniedError("soil: path escapes the configured seed roots");
		}
		if (!extensions.includes(path.extname(resolved).toLowerCase())) {
			throw new SoilCapabilityDeniedError(`soil: expected one of ${extensions.join(", ")}`);
		}
		return resolved;
	}

	private async resolveWritablePath(value: unknown, extension: string): Promise<string> {
		if (typeof value !== "string" || !value.trim()) throw new Error("soil: path must be a non-empty string");
		const candidate = path.isAbsolute(value) ? path.normalize(value) : path.resolve(this.roots[0], value);
		if (path.extname(candidate).toLowerCase() !== extension)
			throw new SoilCapabilityDeniedError(`soil: expected ${extension}`);
		const parent = await realpath(path.dirname(candidate));
		if (!this.roots.some((root) => parent === root || parent.startsWith(`${root}${path.sep}`))) {
			throw new SoilCapabilityDeniedError("soil: path escapes the configured seed roots");
		}
		return candidate;
	}

	private assertWritable(): void {
		if (this.accessLevel !== "rw") throw new SoilCapabilityDeniedError("soil: workflow authority is read-only");
	}

	private async run(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
		return execFileAsync(this.binary, args, {
			timeout: this.timeoutMs,
			maxBuffer: 8 * 1024 * 1024,
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
		});
	}
}

function decodeSeed(value: unknown): Buffer {
	if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
		throw new Error("soil: updateBase64 is invalid");
	const bytes = Buffer.from(value, "base64");
	if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024)
		throw new Error("soil: seed is empty or oversized");
	return bytes;
}

function boundedBody(value: unknown): string {
	if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 8 * 1024 * 1024) {
		throw new Error("soil: import body must be a bounded string");
	}
	return value;
}

async function atomicWrite(target: string, body: Buffer): Promise<void> {
	const staging = `${target}.tmp-${randomUUID()}`;
	try {
		await writeFile(staging, body, { flag: "wx" });
		await rename(staging, target);
	} finally {
		await unlink(staging).catch(() => {});
	}
}

export class SoilCapabilityDeniedError extends Error {
	readonly code = "capability_denied";
	readonly status = 403;
}
