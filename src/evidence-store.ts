import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface EvidenceRef {
	readonly uri: string;
	readonly sha256: string;
	readonly bytes: number;
	readonly mediaType: string;
}

export interface EvidenceBlob {
	readonly ref: EvidenceRef;
	readonly body: Buffer;
}

export interface ThinEvidenceRef {
	readonly uri: string;
	readonly sha256: string;
}

/** Host-owned fat-evidence sink. Sandboxes receive immutable refs, never credentials. */
export class EvidenceStore {
	private constructor(private readonly baseUrl: URL) {}

	static fromUrl(value: string): EvidenceStore {
		const url = new URL(value);
		if (url.protocol !== "s3:" && url.protocol !== "file:") {
			throw new Error("evidence: only s3:// and file:// stores are supported");
		}
		return new EvidenceStore(url);
	}

	async put(
		segments: readonly string[],
		kind: string,
		extension: string,
		mediaType: string,
		body: Buffer | string,
	): Promise<EvidenceRef> {
		const safeSegments = segments.map(assertEvidenceId);
		const safeKind = assertEvidenceId(kind);
		const safeExtension = extension.replace(/^\./, "");
		if (!/^[a-z0-9]{1,12}$/.test(safeExtension)) throw new Error("evidence: invalid extension");
		const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const relative = [...safeSegments, `${safeKind}-sha256-${sha256}.${safeExtension}`].join("/");
		const uri = appendUrlPath(this.baseUrl, relative);

		if (this.baseUrl.protocol === "file:") {
			const target = uriToFilePath(uri);
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, bytes, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "EEXIST") throw error;
			});
		} else {
			await putS3(uri, mediaType, sha256, bytes);
		}
		return { uri, sha256, bytes: bytes.byteLength, mediaType };
	}

	/**
	 * Resolve and verify a thin ref from this store. The URI must remain beneath
	 * the configured prefix and the claimed length/digest must match the bytes.
	 */
	async get(ref: EvidenceRef, maxBytes = 16 * 1024 * 1024): Promise<EvidenceBlob> {
		const normalized = validateEvidenceRef(ref, maxBytes);
		const uri = this.assertOwnedUri(normalized.uri);
		let body: Buffer;
		if (uri.protocol === "file:") {
			const target = uriToFilePath(uri.toString());
			const metadata = await stat(target);
			if (!metadata.isFile()) throw new Error("evidence: ref does not name a regular file");
			if (metadata.size > maxBytes) throw new Error("evidence: object exceeds the read bound");
			body = await readFile(target);
		} else {
			body = await getS3(uri.toString(), maxBytes);
		}
		if (body.byteLength !== normalized.bytes) throw new Error("evidence: object length does not match its ref");
		const digest = createHash("sha256").update(body).digest("hex");
		if (digest !== normalized.sha256) throw new Error("evidence: object digest does not match its ref");
		return { ref: normalized, body };
	}

	/**
	 * Resolve a testimony ref that intentionally carries only URI + digest.
	 * This is used for the small beat manifest; the manifest itself contains
	 * complete length/media-type refs for its child screenshot/probe/trace.
	 */
	async getThin(ref: ThinEvidenceRef, maxBytes = 1024 * 1024): Promise<EvidenceBlob> {
		if (!ref || typeof ref !== "object") throw new Error("evidence: thin ref must be an object");
		if (typeof ref.uri !== "string" || ref.uri.length > 2048) throw new Error("evidence: invalid ref URI");
		if (!/^[a-f0-9]{64}$/.test(ref.sha256)) throw new Error("evidence: invalid ref digest");
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("evidence: invalid read bound");
		const uri = this.assertOwnedUri(ref.uri);
		const body =
			uri.protocol === "file:"
				? await readBoundedFile(uri.toString(), maxBytes)
				: await getS3(uri.toString(), maxBytes);
		const digest = createHash("sha256").update(body).digest("hex");
		if (digest !== ref.sha256) throw new Error("evidence: object digest does not match its ref");
		const normalized: EvidenceRef = {
			uri: uri.toString(),
			sha256: ref.sha256,
			bytes: body.byteLength,
			mediaType: inferMediaType(uri.pathname),
		};
		return { ref: normalized, body };
	}

	/** Bind an evidence URI to the logical run named by authenticated testimony. */
	assertRunUri(value: string, runId: string): void {
		const target = this.assertOwnedUri(value);
		const basePath = this.baseUrl.pathname.replace(/\/$/, "");
		const relative = target.pathname.slice(basePath.length + 1);
		const firstSegment = relative.split("/", 1)[0];
		let decoded: string;
		try {
			decoded = decodeURIComponent(firstSegment);
		} catch {
			throw new Error("evidence: ref carries malformed path encoding");
		}
		if (decoded !== runId) throw new Error("evidence: ref does not belong to the requested run");
	}

	private assertOwnedUri(value: string): URL {
		const target = new URL(value);
		if (
			target.protocol !== this.baseUrl.protocol ||
			target.username ||
			target.password ||
			target.search ||
			target.hash
		) {
			throw new Error("evidence: ref is outside the configured store");
		}
		if (target.protocol === "s3:" && target.hostname !== this.baseUrl.hostname) {
			throw new Error("evidence: ref is outside the configured bucket");
		}
		const basePath = this.baseUrl.pathname.replace(/\/$/, "");
		if (!target.pathname.startsWith(`${basePath}/`)) {
			throw new Error("evidence: ref is outside the configured prefix");
		}
		return target;
	}
}

function validateEvidenceRef(ref: EvidenceRef, maxBytes: number): EvidenceRef {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("evidence: invalid read bound");
	if (!ref || typeof ref !== "object") throw new Error("evidence: ref must be an object");
	const record = ref as unknown as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	if (JSON.stringify(keys) !== JSON.stringify(["bytes", "mediaType", "sha256", "uri"])) {
		throw new Error("evidence: ref must contain exactly uri, sha256, bytes, and mediaType");
	}
	if (typeof ref.uri !== "string" || ref.uri.length > 2048) throw new Error("evidence: invalid ref URI");
	if (!/^[a-f0-9]{64}$/.test(ref.sha256)) throw new Error("evidence: invalid ref digest");
	if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > maxBytes) {
		throw new Error("evidence: invalid or oversized ref length");
	}
	if (typeof ref.mediaType !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(ref.mediaType)) {
		throw new Error("evidence: invalid media type");
	}
	return { uri: ref.uri, sha256: ref.sha256, bytes: ref.bytes, mediaType: ref.mediaType };
}

function assertEvidenceId(value: string): string {
	if (!EVIDENCE_ID.test(value)) throw new Error(`evidence: invalid path identifier ${JSON.stringify(value)}`);
	return value;
}

function appendUrlPath(base: URL, relative: string): string {
	const copy = new URL(base.toString());
	copy.pathname = `${copy.pathname.replace(/\/$/, "")}/${relative}`;
	return copy.toString();
}

function uriToFilePath(uri: string): string {
	const url = new URL(uri);
	return decodeURIComponent(url.pathname);
}

async function readBoundedFile(uri: string, maxBytes: number): Promise<Buffer> {
	const target = uriToFilePath(uri);
	const metadata = await stat(target);
	if (!metadata.isFile()) throw new Error("evidence: ref does not name a regular file");
	if (metadata.size > maxBytes) throw new Error("evidence: object exceeds the read bound");
	return readFile(target);
}

function inferMediaType(pathname: string): string {
	const extension = path.extname(pathname).toLowerCase();
	if (extension === ".json") return "application/json";
	if (extension === ".png") return "image/png";
	if (extension === ".yaml" || extension === ".yml") return "application/yaml";
	if (extension === ".zip") return "application/zip";
	return "application/octet-stream";
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
			else reject(new Error(`evidence: aws s3 cp failed (${code ?? "signal"}): ${stderr.trim()}`));
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
			if (bytes > maxBytes) {
				fail(new Error("evidence: S3 object exceeds the read bound"));
				return;
			}
			chunks.push(chunk);
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
		});
		child.once("error", (error) => fail(error));
		child.once("close", (code) => {
			if (settled) return;
			settled = true;
			if (code === 0) resolve(Buffer.concat(chunks, bytes));
			else reject(new Error(`evidence: aws s3 cp failed (${code ?? "signal"}): ${stderr.trim()}`));
		});
	});
}
