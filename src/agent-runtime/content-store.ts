import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const SOPHIA_CONTENT_REF_SCHEMA = "sophia.content-ref.v1" as const;

export interface SophiaContentRefV1 {
	readonly schema: typeof SOPHIA_CONTENT_REF_SCHEMA;
	readonly uri: string;
	readonly digest: string;
	readonly bytes: number;
	readonly mediaType: string;
}

/** Content-addressed, host-owned memory bytes. Supports local proofs and AWS S3 unchanged. */
export class SophiaContentStore {
	private constructor(private readonly baseUrl: URL) {}

	static fromUrl(value: string): SophiaContentStore {
		const baseUrl = new URL(value.endsWith("/") ? value : `${value}/`);
		if (baseUrl.protocol !== "file:" && baseUrl.protocol !== "s3:") {
			throw new Error("memory CAS supports only file:// and s3:// stores");
		}
		if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
			throw new Error("memory CAS URL must not contain credentials, query, or fragment");
		}
		return new SophiaContentStore(baseUrl);
	}

	async put(body: Buffer | string, mediaType: string): Promise<SophiaContentRefV1> {
		if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mediaType)) throw new Error("memory CAS media type is invalid");
		const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
		const hex = createHash("sha256").update(bytes).digest("hex");
		const uri = this.objectUri(hex);
		if (uri.protocol === "file:") {
			const target = decodeURIComponent(uri.pathname);
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, bytes, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "EEXIST") throw error;
			});
		} else {
			await putS3(uri.toString(), mediaType, hex, bytes);
		}
		const ref: SophiaContentRefV1 = {
			schema: SOPHIA_CONTENT_REF_SCHEMA,
			uri: uri.toString(),
			digest: `sha256:${hex}`,
			bytes: bytes.byteLength,
			mediaType,
		};
		await this.get(ref, Math.max(1, bytes.byteLength));
		return ref;
	}

	async get(ref: SophiaContentRefV1, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
		validateSophiaContentRef(ref, maxBytes);
		const uri = this.assertOwned(ref.uri);
		let body: Buffer;
		if (uri.protocol === "file:") {
			const target = decodeURIComponent(uri.pathname);
			const metadata = await stat(target);
			if (!metadata.isFile()) throw new Error("memory CAS ref does not name a regular file");
			if (metadata.size > maxBytes) throw new Error("memory CAS object exceeds the read bound");
			body = await readFile(target);
		} else {
			body = await getS3(uri.toString(), maxBytes);
		}
		if (body.byteLength !== ref.bytes) throw new Error("memory CAS object length does not match its ref");
		const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
		if (digest !== ref.digest) throw new Error("memory CAS object digest does not match its ref");
		return body;
	}

	private objectUri(hex: string): URL {
		const uri = new URL(this.baseUrl.toString());
		uri.pathname = `${this.baseUrl.pathname.replace(/\/$/, "")}/sha256/${hex.slice(0, 2)}/${hex}`;
		return uri;
	}

	private assertOwned(value: string): URL {
		const uri = new URL(value);
		if (
			uri.protocol !== this.baseUrl.protocol ||
			uri.hostname !== this.baseUrl.hostname ||
			uri.username ||
			uri.password ||
			uri.search ||
			uri.hash
		) {
			throw new Error("memory CAS ref is outside the configured store");
		}
		const basePath = this.baseUrl.pathname.replace(/\/$/, "");
		if (!uri.pathname.startsWith(`${basePath}/sha256/`)) {
			throw new Error("memory CAS ref is outside the configured prefix");
		}
		return uri;
	}
}

export function validateSophiaContentRef(
	value: unknown,
	maxBytes = 64 * 1024 * 1024,
): asserts value is SophiaContentRefV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("memory CAS ref must be an object");
	const ref = value as Record<string, unknown>;
	const keys = Object.keys(ref).sort();
	if (JSON.stringify(keys) !== JSON.stringify(["bytes", "digest", "mediaType", "schema", "uri"])) {
		throw new Error("memory CAS ref has unknown or missing fields");
	}
	if (ref.schema !== SOPHIA_CONTENT_REF_SCHEMA) throw new Error("memory CAS ref schema is unsupported");
	if (typeof ref.uri !== "string" || ref.uri.length > 2048) throw new Error("memory CAS ref URI is invalid");
	if (typeof ref.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(ref.digest)) {
		throw new Error("memory CAS ref digest is invalid");
	}
	if (!Number.isSafeInteger(ref.bytes) || (ref.bytes as number) < 0 || (ref.bytes as number) > maxBytes) {
		throw new Error("memory CAS ref length is invalid");
	}
	if (typeof ref.mediaType !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(ref.mediaType)) {
		throw new Error("memory CAS ref media type is invalid");
	}
}

function putS3(uri: string, mediaType: string, sha256: string, body: Buffer): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const child = spawn(
			"aws",
			["s3", "cp", "-", uri, "--only-show-errors", "--content-type", mediaType, "--metadata", `sha256=${sha256}`],
			{ stdio: ["pipe", "ignore", "pipe"] },
		);
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`memory CAS aws s3 cp failed (${code ?? "signal"}): ${stderr.trim()}`));
		});
		child.stdin.end(body);
	});
}

function getS3(uri: string, maxBytes: number): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => {
		const child = spawn("aws", ["s3", "cp", uri, "-", "--only-show-errors"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		let bytes = 0;
		let stderr = "";
		let settled = false;
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			reject(error);
		};
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.byteLength;
			if (bytes > maxBytes) return fail(new Error("memory CAS S3 object exceeds the read bound"));
			chunks.push(chunk);
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
		});
		child.once("error", fail);
		child.once("close", (code) => {
			if (settled) return;
			settled = true;
			if (code === 0) resolve(Buffer.concat(chunks, bytes));
			else reject(new Error(`memory CAS aws s3 cp failed (${code ?? "signal"}): ${stderr.trim()}`));
		});
	});
}
