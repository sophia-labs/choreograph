/**
 * A loopback tap for the calls the host must bill at OpenRouter's own charge (the fallback of `openrouter-fallback.ts`).
 *
 * OpenRouter streams what a call cost in its final SSE chunk (`usage.cost`, with the generation id and the provider
 * that served it); on 2026-10-01 that figure equalled OpenRouter's own generation record (`total_cost`) for 276 of 276
 * calls, to a nanodollar. Pi, which makes the call, reads token counts from that chunk and discards the cost. So a call
 * that must be billed at the charge is sent to a local forwarder instead of OpenRouter: it forwards the request
 * unchanged, streams the response back to Pi byte for byte, and keeps the last usage chunk for the host.
 *
 * One server, started on first use on 127.0.0.1 and an ephemeral port, never keeps the process alive. Each call gets a
 * single-use path; anything else is a 404. The provider's key travels in the request as it would to OpenRouter and is
 * never logged or kept.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface TappedUsage {
	/** What OpenRouter reports it charged for the call, in USD. */
	readonly costUsd: number;
	readonly generationId: string | null;
	readonly provider: string | null;
}

export interface UsageTapSession {
	/** Where Pi should send the call instead of the provider's base URL. */
	readonly baseUrl: string;
	/** The last usage chunk with a cost, once the response has ended; undefined if there was none. */
	usage(): Promise<TappedUsage | undefined>;
	close(): void;
}

interface Session {
	readonly upstream: string;
	readonly resolve: (usage: TappedUsage | undefined) => void;
	used: boolean;
}

/** Headers that belong to one hop, or that the tap sets itself. */
const HOP_HEADERS = new Set([
	"host",
	"connection",
	"content-length",
	"transfer-encoding",
	"keep-alive",
	"accept-encoding",
	"upgrade",
	"te",
	"trailer",
	"proxy-connection",
]);

export class OpenRouterUsageTap {
	private server?: Server;
	private port = 0;
	private starting?: Promise<void>;
	private readonly sessions = new Map<string, Session>();

	constructor(private readonly fetchImpl: typeof fetch = fetch) {}

	async open(upstreamBaseUrl: string): Promise<UsageTapSession> {
		await this.start();
		const id = randomUUID();
		let resolve!: (usage: TappedUsage | undefined) => void;
		const settled = new Promise<TappedUsage | undefined>((done) => {
			resolve = done;
		});
		this.sessions.set(id, { upstream: upstreamBaseUrl.replace(/\/$/, ""), resolve, used: false });
		return {
			baseUrl: `http://127.0.0.1:${this.port}/tap/${id}`,
			usage: () => settled,
			close: () => {
				this.sessions.delete(id);
				resolve(undefined);
			},
		};
	}

	private start(): Promise<void> {
		if (this.server) return Promise.resolve();
		this.starting ??= new Promise<void>((resolve, reject) => {
			const server = createServer((request, response) => {
				void this.handle(request, response);
			});
			server.on("error", reject);
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				this.port = typeof address === "object" && address ? address.port : 0;
				server.unref();
				this.server = server;
				resolve();
			});
		});
		return this.starting;
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const match = /^\/tap\/([0-9a-f-]{36})(\/[^?#]*)(\?[^#]*)?$/.exec(request.url ?? "");
		const session = match ? this.sessions.get(match[1]) : undefined;
		if (!match || !session || session.used) {
			response.writeHead(404, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "no such tap", code: 404 } }));
			return;
		}
		session.used = true;
		const body = await readBody(request);
		const headers: Record<string, string> = { "accept-encoding": "identity" };
		for (const [name, value] of Object.entries(request.headers)) {
			if (typeof value === "string" && !HOP_HEADERS.has(name.toLowerCase())) headers[name] = value;
		}
		const controller = new AbortController();
		response.on("close", () => {
			if (!response.writableEnded) controller.abort();
		});
		let upstream: Response;
		try {
			upstream = await this.fetchImpl(`${session.upstream}${match[2]}${match[3] ?? ""}`, {
				method: request.method ?? "POST",
				headers,
				...(body.length > 0 ? { body } : {}),
				signal: controller.signal,
			});
		} catch {
			response.writeHead(502, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "the usage tap could not reach the provider", code: 502 } }));
			session.resolve(undefined);
			return;
		}
		const outgoing: Record<string, string> = {};
		const contentType = upstream.headers.get("content-type");
		if (contentType) outgoing["content-type"] = contentType;
		const headerGenerationId = upstream.headers.get("x-generation-id");
		if (headerGenerationId) outgoing["x-generation-id"] = headerGenerationId;
		response.writeHead(upstream.status, outgoing);
		const scanner = new UsageScanner(headerGenerationId);
		try {
			if (upstream.body) {
				for await (const part of upstream.body as unknown as AsyncIterable<Uint8Array>) {
					response.write(part);
					scanner.push(part);
				}
			}
			scanner.end();
			response.end();
		} catch {
			response.destroy();
		}
		session.resolve(scanner.usage);
	}
}

/** Reads SSE `data:` lines (or a whole JSON body) and keeps the last one that carries a usage cost. */
class UsageScanner {
	usage: TappedUsage | undefined;
	private readonly decoder = new TextDecoder();
	private buffer = "";
	private whole = "";

	constructor(private readonly headerGenerationId: string | null) {}

	push(part: Uint8Array): void {
		const text = this.decoder.decode(part, { stream: true });
		this.buffer += text;
		if (this.whole.length < 4_000_000) this.whole += text;
		for (let newline = this.buffer.indexOf("\n"); newline >= 0; newline = this.buffer.indexOf("\n")) {
			this.line(this.buffer.slice(0, newline));
			this.buffer = this.buffer.slice(newline + 1);
		}
	}

	end(): void {
		const rest = this.decoder.decode();
		this.buffer += rest;
		this.whole += rest;
		if (this.buffer) this.line(this.buffer);
		this.buffer = "";
		// A non-streamed answer is one JSON body.
		if (!this.usage && this.whole.trim().startsWith("{")) this.take(this.whole);
	}

	private line(raw: string): void {
		const line = raw.trim();
		if (!line.startsWith("data:")) return;
		const data = line.slice(5).trim();
		if (data && data !== "[DONE]") this.take(data);
	}

	private take(json: string): void {
		let chunk: unknown;
		try {
			chunk = JSON.parse(json);
		} catch {
			return;
		}
		if (typeof chunk !== "object" || chunk === null) return;
		const record = chunk as { id?: unknown; provider?: unknown; usage?: { cost?: unknown } };
		const cost = record.usage?.cost;
		if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return;
		this.usage = {
			costUsd: cost,
			generationId: typeof record.id === "string" && record.id ? record.id : this.headerGenerationId,
			provider: typeof record.provider === "string" && record.provider ? record.provider : null,
		};
	}
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks);
}
