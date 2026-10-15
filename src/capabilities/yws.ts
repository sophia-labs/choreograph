import { createHash } from "node:crypto";
import WebSocket from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import type { HostedAuthContext } from "../auth.js";
import type { CapabilityBackend, HostedMcpToolDescriptor } from "../mnemosyne.js";

const MAX_UPDATE_BYTES = 8 * 1024 * 1024;

export interface YwsCapabilityOptions {
	readonly graphId: string;
	readonly graphOwner?: string;
	readonly ownerUserId: string;
	readonly authContext?: HostedAuthContext;
	readonly serverUrl?: string;
	readonly timeoutMs?: number;
	readonly accessLevel?: "ro" | "rw";
}

interface TipTapNode {
	readonly type?: string;
	readonly text?: string;
	readonly attrs?: Readonly<Record<string, unknown>>;
	readonly marks?: readonly Array<{ readonly type: string; readonly attrs?: Readonly<Record<string, unknown>> }>;
	readonly content?: readonly TipTapNode[];
}

/** Bounded y-protocol client for observation, editing, and convergence proofs. */
export class YwsCapabilityBackend implements CapabilityBackend {
	readonly capabilityName = "yws";
	readonly accessLevel: "ro" | "rw";
	private readonly serverUrl: string;
	private readonly timeoutMs: number;

	constructor(private readonly options: YwsCapabilityOptions) {
		this.serverUrl = options.serverUrl ?? resolveYwsServerUrl(options.graphId, options.graphOwner);
		this.timeoutMs = options.timeoutMs ?? 20_000;
		this.accessLevel = options.accessLevel ?? "ro";
	}

	async callTool(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const documentId = requiredId(args.documentId ?? args.document_id, "documentId");
		switch (tool) {
			case "snapshot":
				return this.snapshot(documentId, args.includeUpdate === true, signal);
			case "append_block":
				this.assertWritable();
				return this.appendBlock(documentId, parseBlock(args), signal);
			case "replace_tiptap":
				this.assertWritable();
				return this.replaceTipTap(documentId, parseTipTapDocument(args.tiptapJson ?? args.tiptap_json), signal);
			case "apply_update":
				this.assertWritable();
				return this.applyUpdate(documentId, decodeUpdate(args.updateBase64 ?? args.update_base64), signal);
			case "concurrent_append":
				this.assertWritable();
				return this.concurrentAppend(documentId, parseConcurrentBlocks(args.blocks), signal);
			default:
				throw new Error(`yws: unknown tool "${tool}"`);
		}
	}

	async listTools(): Promise<readonly HostedMcpToolDescriptor[]> {
		const tools: HostedMcpToolDescriptor[] = [
			{
				name: "snapshot",
				destructive: false,
				description:
					"Sync a bound Garden document over y-websocket and return state/update/content digests plus stable block ids.",
				inputSchema: {
					type: "object",
					properties: { documentId: { type: "string" }, includeUpdate: { type: "boolean" } },
					required: ["documentId"],
				},
			},
		];
		if (this.accessLevel === "rw") {
			tools.push(
				{
					name: "append_block",
					destructive: true,
					description: "Append one stable-id TipTap block over y-protocol and verify a second client observes it.",
					inputSchema: blockToolSchema(false),
				},
				{
					name: "replace_tiptap",
					destructive: true,
					description:
						"Replace the content fragment from bounded TipTap JSON while preserving supplied block ids.",
					inputSchema: {
						type: "object",
						properties: { documentId: { type: "string" }, tiptapJson: { type: "object" } },
						required: ["documentId", "tiptapJson"],
					},
				},
				{
					name: "apply_update",
					destructive: true,
					description: "Apply one bounded Yjs update-v1 payload and verify remote convergence.",
					inputSchema: {
						type: "object",
						properties: { documentId: { type: "string" }, updateBase64: { type: "string" } },
						required: ["documentId", "updateBase64"],
					},
				},
				{
					name: "concurrent_append",
					destructive: true,
					description:
						"Make two offline concurrent block appends from one synced state, reconnect, and prove both clients converge.",
					inputSchema: {
						type: "object",
						properties: {
							documentId: { type: "string" },
							blocks: { type: "array", minItems: 2, maxItems: 2, items: blockSchema() },
						},
						required: ["documentId", "blocks"],
					},
				},
			);
		}
		return tools;
	}

	async close(): Promise<void> {}

	private assertWritable(): void {
		if (this.accessLevel !== "rw") throw new YwsCapabilityDeniedError("yws: workflow authority is read-only");
	}

	private async snapshot(documentId: string, includeUpdate: boolean, signal?: AbortSignal): Promise<unknown> {
		const client = await this.connect(documentId, signal);
		try {
			return snapshotDoc(documentId, client.doc, includeUpdate);
		} finally {
			client.destroy();
		}
	}

	private async appendBlock(documentId: string, block: TipTapNode, signal?: AbortSignal): Promise<unknown> {
		const client = await this.connect(documentId, signal);
		try {
			client.doc.transact(() => client.doc.getXmlFragment("content").push([tipTapNodeToYXml(block)]));
			const verifier = await this.waitForRemoteState(documentId, client.doc, signal);
			try {
				return { converged: true, snapshot: snapshotDoc(documentId, verifier.doc, false) };
			} finally {
				verifier.destroy();
			}
		} finally {
			client.destroy();
		}
	}

	private async replaceTipTap(documentId: string, document: TipTapNode, signal?: AbortSignal): Promise<unknown> {
		const client = await this.connect(documentId, signal);
		try {
			client.doc.transact(() => {
				const fragment = client.doc.getXmlFragment("content");
				if (fragment.length > 0) fragment.delete(0, fragment.length);
				const nodes = (document.content ?? []).map(tipTapNodeToYXml);
				if (nodes.length > 0) fragment.push(nodes);
			});
			const verifier = await this.waitForRemoteState(documentId, client.doc, signal);
			try {
				return { converged: true, snapshot: snapshotDoc(documentId, verifier.doc, false) };
			} finally {
				verifier.destroy();
			}
		} finally {
			client.destroy();
		}
	}

	private async applyUpdate(documentId: string, update: Uint8Array, signal?: AbortSignal): Promise<unknown> {
		const client = await this.connect(documentId, signal);
		try {
			Y.applyUpdate(client.doc, update, "choreograph-yws");
			const verifier = await this.waitForRemoteState(documentId, client.doc, signal);
			try {
				return { converged: true, snapshot: snapshotDoc(documentId, verifier.doc, false) };
			} finally {
				verifier.destroy();
			}
		} finally {
			client.destroy();
		}
	}

	private async concurrentAppend(
		documentId: string,
		blocks: readonly [TipTapNode, TipTapNode],
		signal?: AbortSignal,
	): Promise<unknown> {
		const left = await this.connect(documentId, signal);
		const right = await this.connect(documentId, signal);
		try {
			await waitForEqualState(left.doc, right.doc, this.timeoutMs, signal);
			left.provider.disconnect();
			right.provider.disconnect();
			left.doc.transact(() => left.doc.getXmlFragment("content").push([tipTapNodeToYXml(blocks[0])]));
			right.doc.transact(() => right.doc.getXmlFragment("content").push([tipTapNodeToYXml(blocks[1])]));
			left.provider.connect();
			right.provider.connect();
			await waitForEqualState(left.doc, right.doc, this.timeoutMs, signal);
			const expectedIds = blocks.map((block) => String(block.attrs?.["data-block-id"]));
			const snapshot = snapshotDoc(documentId, left.doc, false) as { blockIds: string[] };
			const bothPresent = expectedIds.every((id) => snapshot.blockIds.includes(id));
			if (!bothPresent) throw new Error("yws: concurrent append converged but lost a supplied block id");
			return { converged: true, bothPresent, expectedBlockIds: expectedIds, snapshot };
		} finally {
			left.destroy();
			right.destroy();
		}
	}

	private async waitForRemoteState(documentId: string, expected: Y.Doc, signal?: AbortSignal): Promise<YwsClient> {
		const verifier = await this.connect(documentId, signal);
		try {
			await waitForEqualState(expected, verifier.doc, this.timeoutMs, signal);
			return verifier;
		} catch (error) {
			verifier.destroy();
			throw error;
		}
	}

	private async connect(documentId: string, signal?: AbortSignal): Promise<YwsClient> {
		const doc = new Y.Doc();
		const auth = resolveWsAuth(this.options);
		const provider = new WebsocketProvider(this.serverUrl, documentId, doc, {
			connect: true,
			disableBc: true,
			resyncInterval: -1,
			params: auth.params,
			WebSocketPolyfill: auth.WebSocketPolyfill as unknown as typeof globalThis.WebSocket,
		});
		try {
			await waitForSync(provider, this.timeoutMs, signal);
			return {
				doc,
				provider,
				destroy: () => {
					provider.destroy();
					doc.destroy();
				},
			};
		} catch (error) {
			provider.destroy();
			doc.destroy();
			throw error;
		}
	}
}

interface YwsClient {
	readonly doc: Y.Doc;
	readonly provider: WebsocketProvider;
	destroy(): void;
}

export class YwsCapabilityDeniedError extends Error {
	readonly code = "capability_denied";
	readonly status = 403;
}

export function resolveYwsServerUrl(graphId: string, graphOwner?: string): string {
	const explicit = process.env.CHOREOGRAPH_YWS_SERVER_URL?.trim();
	if (explicit) {
		const expanded = explicit
			.replaceAll("{graphId}", encodeURIComponent(graphId))
			.replaceAll("{graphOwner}", encodeURIComponent(graphOwner?.trim() ?? ""));
		return expanded.replace(/\/$/, "");
	}
	const base = process.env.MNEMOSYNE_GATEWAY_BASE_URL?.trim() ?? process.env.GARDEN_HTTP_BASE_URL?.trim();
	if (!base) throw new Error("yws: CHOREOGRAPH_YWS_SERVER_URL or a Garden/gateway base URL is required");
	const url = new URL(base);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	const graphPath = graphOwner?.trim()
		? `/o/${encodeURIComponent(graphOwner.trim())}/g/${encodeURIComponent(graphId)}`
		: `/g/${encodeURIComponent(graphId)}`;
	url.pathname = `${url.pathname.replace(/\/$/, "")}${graphPath}/hocuspocus/docs/${encodeURIComponent(graphId)}`;
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}

function resolveWsAuth(options: YwsCapabilityOptions): {
	params: Record<string, string>;
	WebSocketPolyfill: typeof WebSocket;
} {
	const params: Record<string, string> = { user_id: options.ownerUserId };
	const headers: Record<string, string> = {};
	const serviceToken = process.env.MNEMOSYNE_SERVICE_TOKEN?.trim();
	if (serviceToken) {
		headers.Authorization = `Bearer ${serviceToken}`;
		headers["x-pn-on-behalf-of"] = options.ownerUserId;
	} else if (options.authContext?.method === "delegated_bearer") {
		params.token = options.authContext.bearerToken;
		headers.Authorization = `Bearer ${options.authContext.bearerToken}`;
	} else {
		const directToken =
			process.env.MNEMOSYNE_MCP_ACCESS_TOKEN?.trim() ?? process.env.MNEMOSYNE_MCP_BEARER_TOKEN?.trim();
		if (directToken) {
			params.token = directToken;
			headers.Authorization = `Bearer ${directToken}`;
		}
	}

	const Polyfill = class AuthenticatedWebSocket extends WebSocket {
		constructor(address: string | URL, protocols?: string | string[]) {
			super(address, protocols, { headers });
		}
	};
	return { params, WebSocketPolyfill: Polyfill };
}

function waitForSync(provider: WebsocketProvider, timeoutMs: number, signal?: AbortSignal): Promise<void> {
	if (provider.synced) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (done: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			provider.off("sync", onSync);
			provider.off("connection-error", onError);
			signal?.removeEventListener("abort", onAbort);
			done();
		};
		const onSync = (synced: boolean) => {
			if (synced) finish(resolve);
		};
		const onError = (error: unknown) =>
			finish(() => reject(error instanceof Error ? error : new Error(String(error))));
		const onAbort = () => finish(() => reject(signal?.reason ?? new Error("yws: aborted")));
		const timer = setTimeout(
			() => finish(() => reject(new Error(`yws: sync timed out after ${timeoutMs}ms`))),
			timeoutMs,
		);
		provider.on("sync", onSync);
		provider.on("connection-error", onError);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function waitForEqualState(left: Y.Doc, right: Y.Doc, timeoutMs: number, signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (signal?.aborted) throw signal.reason ?? new Error("yws: aborted");
		if (sha256(Y.encodeStateAsUpdate(left)) === sha256(Y.encodeStateAsUpdate(right))) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`yws: clients did not converge within ${timeoutMs}ms`);
}

function snapshotDoc(documentId: string, doc: Y.Doc, includeUpdate: boolean): Record<string, unknown> {
	const stateVector = Y.encodeStateVector(doc);
	const update = Y.encodeStateAsUpdate(doc);
	const contentXml = doc.getXmlFragment("content").toString();
	const blockIds = [...contentXml.matchAll(/data-block-id="([^"]+)"/g)].map((match) => match[1]).sort();
	return {
		documentId,
		stateVectorBase64: Buffer.from(stateVector).toString("base64"),
		stateVectorSha256: sha256(stateVector),
		updateSha256: sha256(update),
		updateBytes: update.byteLength,
		...(includeUpdate ? { updateBase64: Buffer.from(update).toString("base64") } : {}),
		contentXml,
		contentXmlSha256: sha256(contentXml),
		blockIds,
		shareTypes: [...doc.share.keys()].sort(),
	};
}

function parseBlock(args: Record<string, unknown>): TipTapNode {
	const id = requiredId(args.blockId ?? args.block_id, "blockId");
	const text = boundedText(args.text, "text", 64 * 1024);
	const type = typeof args.type === "string" ? requiredNodeName(args.type) : "paragraph";
	return { type, attrs: { "data-block-id": id }, ...(text ? { content: [{ type: "text", text }] } : {}) };
}

function parseConcurrentBlocks(value: unknown): readonly [TipTapNode, TipTapNode] {
	if (!Array.isArray(value) || value.length !== 2) throw new Error("yws: blocks must contain exactly two entries");
	return [parseBlock(value[0] as Record<string, unknown>), parseBlock(value[1] as Record<string, unknown>)];
}

function parseTipTapDocument(value: unknown): TipTapNode {
	const root = parseTipTapNode(value, 0);
	if (root.type !== "doc") throw new Error("yws: TipTap root type must be doc");
	return root;
}

function parseTipTapNode(value: unknown, depth: number): TipTapNode {
	if (depth > 32 || typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("yws: invalid or excessively deep TipTap node");
	}
	const input = value as Record<string, unknown>;
	const type = requiredNodeName(input.type);
	const text = input.text === undefined ? undefined : boundedText(input.text, "text", 64 * 1024);
	const attrs = parseAttributes(input.attrs);
	const marks = parseMarks(input.marks);
	const content = input.content === undefined ? undefined : parseContent(input.content, depth + 1);
	return {
		type,
		...(text !== undefined ? { text } : {}),
		...(attrs ? { attrs } : {}),
		...(marks ? { marks } : {}),
		...(content ? { content } : {}),
	};
}

function parseContent(value: unknown, depth: number): TipTapNode[] {
	if (!Array.isArray(value) || value.length > 10_000) throw new Error("yws: TipTap content must be a bounded array");
	return value.map((node) => parseTipTapNode(node, depth));
}

function parseAttributes(value: unknown): Record<string, unknown> | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("yws: attrs must be an object");
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length > 64) throw new Error("yws: too many attributes");
	const attrs: Record<string, unknown> = {};
	for (const [key, item] of entries) {
		if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/.test(key)) throw new Error("yws: invalid attribute name");
		const encoded = JSON.stringify(item);
		if (encoded === undefined || encoded.length > 4096) throw new Error("yws: invalid or oversized attribute");
		attrs[key] = item;
	}
	return attrs;
}

function parseMarks(value: unknown): TipTapNode["marks"] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > 32) throw new Error("yws: marks must be a bounded array");
	return value.map((mark) => {
		if (typeof mark !== "object" || mark === null || Array.isArray(mark)) throw new Error("yws: invalid mark");
		const input = mark as Record<string, unknown>;
		return {
			type: requiredNodeName(input.type),
			...(input.attrs !== undefined ? { attrs: parseAttributes(input.attrs) } : {}),
		};
	});
}

function tipTapNodeToYXml(node: TipTapNode): Y.XmlElement | Y.XmlText {
	if (node.type === "text") {
		const text = new Y.XmlText();
		if (node.text) {
			const marks = Object.fromEntries((node.marks ?? []).map((mark) => [mark.type, mark.attrs ?? {}]));
			text.insert(0, node.text, Object.keys(marks).length > 0 ? marks : undefined);
		}
		return text;
	}
	const element = new Y.XmlElement(node.type ?? "paragraph");
	for (const [key, value] of Object.entries(node.attrs ?? {})) {
		if (value !== null && value !== undefined) element.setAttribute(key, xmlAttributeValue(value));
	}
	for (const child of node.content ?? []) element.push([tipTapNodeToYXml(child)]);
	return element;
}

function xmlAttributeValue(value: unknown): string {
	return typeof value === "string"
		? value
		: typeof value === "number" || typeof value === "boolean"
			? String(value)
			: JSON.stringify(value);
}

function decodeUpdate(value: unknown): Uint8Array {
	if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
		throw new Error("yws: updateBase64 is invalid");
	const update = Buffer.from(value, "base64");
	if (update.byteLength === 0 || update.byteLength > MAX_UPDATE_BYTES)
		throw new Error("yws: updateBase64 is empty or oversized");
	return update;
}

function requiredId(value: unknown, name: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
		throw new Error(`yws: ${name} is required and has an invalid format`);
	}
	return value;
}

function requiredNodeName(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value))
		throw new Error("yws: invalid TipTap node name");
	return value;
}

function boundedText(value: unknown, name: string, max: number): string {
	if (typeof value !== "string" || value.length > max) throw new Error(`yws: ${name} must be a bounded string`);
	return value;
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function blockSchema(): Record<string, unknown> {
	return {
		type: "object",
		properties: { blockId: { type: "string" }, type: { type: "string" }, text: { type: "string" } },
		required: ["blockId", "text"],
	};
}

function blockToolSchema(concurrent: boolean): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			documentId: { type: "string" },
			blockId: { type: "string" },
			type: { type: "string" },
			text: { type: "string" },
		},
		required: ["documentId", "blockId", "text"],
		...(concurrent ? { description: "concurrent" } : {}),
	};
}
