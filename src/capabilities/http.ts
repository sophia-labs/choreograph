import { createHash } from "node:crypto";
import type { CapabilityBackend, HostedMcpToolDescriptor } from "../mnemosyne.js";

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface HttpCapabilityOptions {
	readonly baseUrl: string;
	readonly allowedOrigins?: readonly string[];
	/** URL path prefixes the capability may traverse, checked again after redirects. */
	readonly allowedPathPrefixes?: readonly string[];
	readonly headers?: Readonly<Record<string, string>>;
	readonly maxBodyBytes?: number;
	readonly fetchFn?: typeof fetch;
}

/** Read-only, origin-clamped HTTP face for markdown/HTML/XML/JSON projections. */
export class HttpCapabilityBackend implements CapabilityBackend {
	readonly capabilityName = "http";
	readonly accessLevel = "ro" as const;
	private readonly baseUrl: URL;
	private readonly allowedOrigins: ReadonlySet<string>;
	private readonly allowedPathPrefixes: readonly string[];
	private readonly headers: Readonly<Record<string, string>>;
	private readonly maxBodyBytes: number;
	private readonly fetchFn: typeof fetch;

	constructor(options: HttpCapabilityOptions) {
		this.baseUrl = new URL(options.baseUrl);
		this.allowedOrigins = new Set(
			(options.allowedOrigins ?? [this.baseUrl.origin]).map((origin) => new URL(origin).origin),
		);
		this.allowedPathPrefixes = (options.allowedPathPrefixes ?? []).map(normalizePathPrefix);
		this.headers = options.headers ?? {};
		this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
		this.fetchFn = options.fetchFn ?? fetch;
	}

	async callTool(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		if (tool !== "get" && tool !== "head") throw new Error(`http: unknown tool "${tool}"`);
		const target = this.resolveTarget(args.url ?? args.path);
		const accept = typeof args.accept === "string" ? args.accept : undefined;
		return this.request(tool === "head" ? "HEAD" : "GET", target, accept, signal);
	}

	async listTools(): Promise<readonly HostedMcpToolDescriptor[]> {
		return [
			{
				name: "get",
				destructive: false,
				description: "GET an origin-clamped textual Garden/Hoja face.",
				inputSchema: {
					type: "object",
					properties: { url: { type: "string" }, path: { type: "string" }, accept: { type: "string" } },
				},
			},
			{
				name: "head",
				destructive: false,
				description: "HEAD an origin-clamped Garden/Hoja resource.",
				inputSchema: {
					type: "object",
					properties: { url: { type: "string" }, path: { type: "string" }, accept: { type: "string" } },
				},
			},
		];
	}

	async close(): Promise<void> {}

	private resolveTarget(value: unknown): URL {
		if (typeof value !== "string" || !value.trim()) throw new Error("http: url or path must be a non-empty string");
		const target = new URL(value, this.baseUrl);
		this.assertAllowed(target);
		return target;
	}

	private assertAllowed(url: URL): void {
		if (!this.allowedOrigins.has(url.origin)) {
			throw new HttpCapabilityDeniedError(`http: origin '${url.origin}' is outside the capability allowlist`);
		}
		if (url.username || url.password) throw new HttpCapabilityDeniedError("http: URL credentials are not permitted");
		if (this.allowedPathPrefixes.length > 0) {
			const decodedPath = decodeSafePath(url.pathname);
			if (!this.allowedPathPrefixes.some((prefix) => pathIsWithin(decodedPath, prefix))) {
				throw new HttpCapabilityDeniedError(`http: path '${url.pathname}' is outside the capability scope`);
			}
		}
	}

	private async request(method: "GET" | "HEAD", initial: URL, accept: string | undefined, signal?: AbortSignal) {
		let target = initial;
		for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
			this.assertAllowed(target);
			const response = await this.fetchFn(target, {
				method,
				redirect: "manual",
				headers: { ...this.headers, ...(accept ? { accept } : {}) },
				signal,
			});
			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get("location");
				if (!location) throw new Error(`http: ${response.status} response omitted Location`);
				target = new URL(location, target);
				continue;
			}
			const contentType = response.headers.get("content-type") ?? "application/octet-stream";
			const headers = projectHeaders(response.headers);
			if (method === "HEAD") {
				return { url: target.toString(), status: response.status, ok: response.ok, contentType, headers };
			}
			const bytes = await readLimitedBody(response, this.maxBodyBytes);
			const textual = isTextualContentType(contentType);
			return {
				url: target.toString(),
				status: response.status,
				ok: response.ok,
				contentType,
				headers,
				body: textual ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString("base64"),
				bodyEncoding: textual ? "utf8" : "base64",
				bodyBytes: bytes.byteLength,
				bodySha256: createHash("sha256").update(bytes).digest("hex"),
			};
		}
		throw new Error(`http: exceeded ${MAX_REDIRECTS} redirects`);
	}
}

function normalizePathPrefix(value: string): string {
	const pathname = value.startsWith("http://") || value.startsWith("https://") ? new URL(value).pathname : value;
	const decoded = decodeSafePath(pathname);
	return decoded.endsWith("/") ? decoded : `${decoded}/`;
}

function decodeSafePath(pathname: string): string {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		throw new HttpCapabilityDeniedError("http: malformed percent-encoding in URL path");
	}
	if (decoded.includes("\\") || decoded.includes("\0")) {
		throw new HttpCapabilityDeniedError("http: ambiguous URL path encoding is not permitted");
	}
	return decoded;
}

function pathIsWithin(pathname: string, prefix: string): boolean {
	const barePrefix = prefix.slice(0, -1);
	return pathname === barePrefix || pathname.startsWith(prefix);
}

export class HttpCapabilityDeniedError extends Error {
	readonly code = "capability_denied";
	readonly status = 403;
}

function isTextualContentType(contentType: string): boolean {
	const normalized = contentType.toLowerCase();
	return (
		normalized.startsWith("text/") ||
		normalized.includes("json") ||
		normalized.includes("xml") ||
		normalized.includes("javascript") ||
		normalized.includes("x-www-form-urlencoded")
	);
}

function projectHeaders(headers: Headers): Record<string, string> {
	const allowed = new Set(["content-type", "content-length", "etag", "last-modified", "location"]);
	return Object.fromEntries([...headers.entries()].filter(([name]) => allowed.has(name.toLowerCase())));
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
	const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel().catch(() => {});
		throw new Error(`http: response exceeded ${maxBytes} byte capability limit`);
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new Error(`http: response exceeded ${maxBytes} byte capability limit`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}
