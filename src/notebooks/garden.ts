import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import WebSocket from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import type { ExecutionCellOutput } from "../agent-runtime/execution-service.js";
import {
	cellSourceVersion,
	deleteCell,
	documentVersion,
	exportIpynb,
	insertCell,
	installMetadata,
	NOTEBOOK_FORMAT,
	NOTEBOOK_NS,
	type NotebookCell,
	type NotebookDocument,
	parseIpynb,
	readNotebook as readSharedNotebook,
	replaceSource,
	tiptapJson,
} from "./model.js";

export interface GardenConnection {
	apiUrl: string;
	mcpUrl: string;
	token: string;
	/** Gateway service identity; the gateway checks this subject against graph ACL. */
	onBehalfOf?: string;
}
export interface SourceBlock {
	id: string;
	language: string;
	text: string;
}
export interface SourceSnapshot {
	version: string;
	blocks: SourceBlock[];
}
export interface NotebookCellSnapshot {
	readonly documentId: string;
	readonly cellId: string;
	readonly source: string;
	readonly sourceVersion: string;
	readonly documentVersion: string;
	readonly kernel: "python3" | "julia" | "ocaml" | "cpp";
}
export interface NotebookExecutionRecord {
	executionId: string;
	generation: number;
	status: "running" | "ok" | "error" | "aborted" | "interrupted";
	outputs: ExecutionCellOutput[];
	executionCount?: number;
	durationMs?: number;
	outputTruncated?: boolean;
}
interface Room {
	doc: Y.Doc;
	provider: WebsocketProvider;
}
export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

/** Uses ordinary Garden document identities, content fragments and codeBlocks. */
export class DevelopmentGarden {
	private rooms = new Map<string, Promise<Room>>();
	private readonly flushedVersions = new Map<string, string>();
	constructor(
		readonly connection: GardenConnection,
		readonly graphId: string,
	) {}
	static async fromManifest(path: string, graphId: string): Promise<DevelopmentGarden> {
		const connection = JSON.parse(await readFile(path, "utf8")) as GardenConnection;
		const url = new URL(connection.apiUrl);
		if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
			throw new Error("Local workspace requires a loopback Garden");
		const response = await fetch(`${connection.apiUrl}/health`, { signal: AbortSignal.timeout(5000) });
		if (!response.ok) throw new Error("Garden is unavailable");
		return new DevelopmentGarden(connection, graphId);
	}
	async call(name: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<any> {
		const response = await fetch(this.connection.mcpUrl, {
			method: "POST",
			signal: AbortSignal.timeout(timeoutMs),
			headers: {
				Authorization: `Bearer ${this.connection.token}`,
				...(this.connection.onBehalfOf ? { "x-pn-on-behalf-of": this.connection.onBehalfOf } : {}),
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
		});
		if (!response.ok) throw new Error(`Garden ${name}: HTTP ${response.status}`);
		const body = await response.text();
		const message = JSON.parse(
			body.startsWith("event:") || body.startsWith("data:")
				? body
						.split("\n")
						.find((line) => line.startsWith("data:"))!
						.slice(5)
				: body,
		);
		if (message.error || message.result?.isError)
			throw new Error(`Garden ${name}: ${JSON.stringify(message.error ?? message.result.content)}`);
		const result = message.result;
		if (result.structuredContent) return result.structuredContent;
		const content = result.content?.find((item: any) => item.type === "text")?.text;
		try {
			return JSON.parse(content);
		} catch {
			return content ?? result;
		}
	}
	async initialize(): Promise<void> {
		await this.call("create_graph", {
			graph_id: this.graphId,
			title: "Development workspace",
			graphIncarnation:
				this.graphId === "development-workspace-20260919"
					? "de7e10b0-2026-4919-8000-000000000001"
					: `${sha256(this.graphId).slice(0, 8)}-${sha256(this.graphId).slice(8, 12)}-4919-8000-${sha256(this.graphId).slice(12, 24)}`,
			operationId: "development-workspace-v1",
		});
	}
	async createDocument(id: string, title: string, blocks: SourceBlock[], parentId: string): Promise<void> {
		// Called only for an unregistered file; never replace a returning user's document.
		let exists = false;
		try {
			await this.call("read_document", { graphId: this.graphId, documentId: id, format: "json", maxChars: 1024 });
			exists = true;
		} catch (error) {
			if (!/not found|does not exist|missing document|404/i.test(String(error))) throw error;
		}
		if (exists) return;
		await this.call("create_document", { graphId: this.graphId, documentId: id, title, parentId });
		await this.call("write_document", {
			graphId: this.graphId,
			documentId: id,
			title,
			awaitDurable: true,
			tiptapJson: {
				type: "doc",
				content: blocks.map((block) => ({
					type: "codeBlock",
					attrs: { "data-block-id": block.id, language: block.language },
					content: [{ type: "text", text: block.text || "\n" }],
				})),
			},
		});
		// TipTap omits zero-length text children. Create the shared type through the
		// normal importer, then remove its sentinel through CRDT before enrollment.
		for (const block of blocks.filter((block) => block.text === "")) {
			const snapshot = await this.snapshot(id);
			await this.edit(id, block.id, "", snapshot.version);
		}
	}
	private async connect(id: string): Promise<Room> {
		const doc = new Y.Doc();
		const token = this.connection.token;
		const onBehalfOf = this.connection.onBehalfOf;
		class AuthenticatedWebSocket extends WebSocket {
			constructor(url: string) {
				super(url, {
					headers: {
						Authorization: `Bearer ${token}`,
						...(onBehalfOf ? { "x-pn-on-behalf-of": onBehalfOf } : {}),
					},
				});
			}
		}
		const base = this.connection.apiUrl.replace(/^http/, "ws");
		const provider = new WebsocketProvider(`${base}/hocuspocus/docs/${encodeURIComponent(this.graphId)}`, id, doc, {
			WebSocketPolyfill: AuthenticatedWebSocket as unknown as typeof globalThis.WebSocket,
			...(onBehalfOf ? { params: { user_id: onBehalfOf } } : {}),
			disableBc: true,
			resyncInterval: -1,
		});
		// The coordinator is a runtime observer, not an author/cursor. It owns
		// connection shutdown and has no local awareness to remove at process exit.
		provider.awareness.setLocalState(null);
		process.off("exit", provider._exitHandler);
		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`Garden room did not synchronize: ${id}`)), 15000);
				provider.on("sync", (synced: boolean) => {
					if (synced) {
						clearTimeout(timer);
						resolve();
					}
				});
			});
			return { doc, provider };
		} catch (error) {
			provider.destroy();
			doc.destroy();
			throw error;
		}
	}
	private room(id: string): Promise<Room> {
		let room = this.rooms.get(id);
		if (!room) {
			room = this.connect(id);
			this.rooms.set(id, room);
			room.catch(() => this.rooms.delete(id));
		}
		return room;
	}
	private source(room: Room, notebook = false): SourceSnapshot {
		const blocks = room.doc
			.getXmlFragment("content")
			.toArray()
			.filter(
				(node) =>
					!(
						node instanceof Y.XmlElement &&
						node.nodeName === "paragraph" &&
						(notebook ||
							node
								.toArray()
								.every(
									(child) =>
										child instanceof Y.XmlText &&
										child
											.toDelta()
											.every(
												(part: { insert: unknown }) =>
													typeof part.insert === "string" && part.insert.trim() === "",
											),
								))
					),
			)
			.map((node) => {
				if (!(node instanceof Y.XmlElement) || node.nodeName !== "codeBlock")
					throw new Error("Source document contains a non-code block");
				const children = node.toArray();
				if (children.length !== 1 || !(children[0] instanceof Y.XmlText))
					throw new Error("Source block must contain one shared text");
				const deltas = children[0].toDelta();
				if (
					deltas.some(
						(delta: any) => typeof delta.insert !== "string" || Object.keys(delta.attributes ?? {}).length,
					)
				)
					throw new Error("Source block contains rich-text marks or embeds");
				const blockId = node.getAttribute("data-block-id") ?? node.getAttribute("blockId");
				if (typeof blockId !== "string" || !blockId) throw new Error("Source block has no stable identity");
				return {
					id: blockId,
					language: String(node.getAttribute("language") ?? "text"),
					text: deltas.map((delta: any) => delta.insert).join(""),
				};
			});
		// The content digest includes deletions, which do not advance a Yjs state vector.
		const version = sha256(
			`${Buffer.from(Y.encodeStateVector(room.doc)).toString("base64")}:${JSON.stringify(blocks)}`,
		);
		return { version, blocks };
	}
	async snapshot(id: string): Promise<SourceSnapshot> {
		const room = await this.liveRoom(id);
		return this.source(room, id.startsWith("notebook-"));
	}
	async listNotebooks(
		cursor?: string,
		limit = 100,
	): Promise<{ notebooks: { documentId: string; title: string; updatedAt: string }[]; nextCursor: string | null }> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Notebook page limit must be 1–100");
		const page = await this.call("list_documents", { graphId: this.graphId, limit, ...(cursor ? { cursor } : {}) });
		if (!Array.isArray(page.documents)) throw new Error("Garden returned no document page");
		return {
			notebooks: page.documents
				.filter(
					(item: any) =>
						typeof item.documentId === "string" &&
						item.documentId.startsWith("notebook-") &&
						!item.documentId.startsWith("notebook-run-"),
				)
				.map((item: any) => ({
					documentId: item.documentId,
					title: String(item.title ?? item.documentId),
					updatedAt: String(item.updatedAt ?? ""),
				})),
			nextCursor: typeof page.page?.nextCursor === "string" ? page.page.nextCursor : null,
		};
	}
	async readNotebook(documentId: string): Promise<{ notebook: NotebookDocument; documentVersion: string }> {
		if (!documentId.startsWith("notebook-") || documentId.startsWith("notebook-run-"))
			throw new Error("Not a notebook document ID");
		const room = await this.liveRoom(documentId);
		return { notebook: readSharedNotebook(room.doc), documentVersion: documentVersion(room.doc) };
	}
	async editNotebookCell(documentId: string, cellId: string, source: string, expectedSourceVersion: string) {
		const room = await this.liveRoom(documentId);
		readSharedNotebook(room.doc);
		replaceSource(room.doc, cellId, source, expectedSourceVersion);
		await this.flush(documentId);
		const current = await this.readNotebook(documentId);
		const cell = current.notebook.cells.find((item) => item.id === cellId);
		if (!cell) throw new Error("Cell disappeared during edit");
		return {
			documentId,
			cellId,
			source: cell.source,
			sourceVersion: cellSourceVersion(cell, current.notebook.header),
			documentVersion: current.documentVersion,
			merged: cell.source !== source,
		};
	}
	async insertNotebookCell(
		documentId: string,
		afterCellId: string | null,
		kind: NotebookCell["kind"],
		source: string,
		expectedDocumentVersion: string,
	) {
		const room = await this.liveRoom(documentId);
		if (documentVersion(room.doc) !== expectedDocumentVersion)
			throw new Error("Notebook version conflict; reread before changing cells");
		const cellId = insertCell(room.doc, afterCellId, kind, source);
		await this.flush(documentId);
		const current = await this.readNotebook(documentId);
		return {
			documentId,
			cellId,
			documentVersion: current.documentVersion,
			merged: !current.notebook.cells.some((item) => item.id === cellId && item.source === source),
		};
	}
	async deleteNotebookCell(documentId: string, cellId: string, expectedDocumentVersion: string) {
		const room = await this.liveRoom(documentId);
		if (documentVersion(room.doc) !== expectedDocumentVersion)
			throw new Error("Notebook version conflict; reread before changing cells");
		deleteCell(room.doc, cellId);
		await this.flush(documentId);
		const current = await this.readNotebook(documentId);
		return {
			documentId,
			cellId,
			documentVersion: current.documentVersion,
			merged: current.notebook.cells.some((item) => item.id === cellId),
		};
	}
	async importNotebook(
		documentId: string,
		title: string,
		contents: string,
	): Promise<{ documentId: string; title: string }> {
		if (!/^notebook-[A-Za-z0-9_-]{8,100}$/.test(documentId) || documentId.startsWith("notebook-run-"))
			throw new Error("documentId must be a fresh notebook- prefixed stable ID");
		if (!title.trim() || title !== title.trim() || title.length > 200)
			throw new Error("Notebook title must be 1–200 normalized characters");
		const notebook = parseIpynb(contents);
		try {
			await this.call("create_document_once", {
				graph_id: this.graphId,
				document_id: documentId,
				title,
				tiptapJson: tiptapJson(notebook),
				order: Date.now(),
				parentId: null,
				awaitDurable: true,
			});
		} catch (error) {
			throw new Error(
				`Notebook creation may have been admitted. Retry the same tool with resumeOnly:true for documentId ${documentId}; do not replay create: ${String(error)}`,
			);
		}
		return this.reconcileNotebookImport(documentId, title, contents);
	}
	/** Resume an admitted import by exact ID and source, without replaying creation. */
	async reconcileNotebookImport(
		documentId: string,
		title: string,
		contents: string,
	): Promise<{ documentId: string; title: string; reconciled: boolean }> {
		if (!/^notebook-[A-Za-z0-9_-]{8,100}$/.test(documentId) || documentId.startsWith("notebook-run-"))
			throw new Error("Not a notebook document ID");
		const notebook = parseIpynb(contents);
		// This read proves the document already exists. Opening an unknown Y room
		// first could create an empty room and confuse an uncertain admission.
		const record = await this.call("read_document", {
			graphId: this.graphId,
			documentId,
			format: "json",
			maxChars: 1024,
		});
		const room = await this.liveRoom(documentId);
		let alreadyInstalled = false;
		if (room.doc.getMap("sophia:notebook").get("format") === NOTEBOOK_FORMAT) {
			if (JSON.stringify(readSharedNotebook(room.doc)) !== JSON.stringify(notebook))
				throw new Error("Existing notebook differs from the requested import; no changes made");
			alreadyInstalled = true;
		} else {
			if (record.title !== title)
				throw new Error("Existing document title differs from the requested import; no changes made");
			const blocks = room.doc
				.getXmlFragment("content")
				.toArray()
				.filter((node): node is Y.XmlElement => node instanceof Y.XmlElement && node.nodeName === "codeBlock");
			if (
				blocks.length !== notebook.cells.length ||
				blocks.some((node, index) => {
					const cell = notebook.cells[index];
					const text = node.toArray();
					return (
						(node.getAttribute("data-block-id") ?? node.getAttribute("blockId")) !== cell.id ||
						text.length !== 1 ||
						!(text[0] instanceof Y.XmlText) ||
						(cell.source ? text[0].toString() !== cell.source : !["", "\n"].includes(text[0].toString()))
					);
				})
			)
				throw new Error("Existing document source differs from the requested import; no changes made");
			installMetadata(room.doc, notebook);
		}
		const witness = await this.connect(documentId);
		try {
			let observed = false;
			for (let attempt = 0; attempt < 120; attempt++) {
				try {
					observed = JSON.stringify(readSharedNotebook(witness.doc)) === JSON.stringify(notebook);
				} catch {
					observed = false;
				}
				if (observed) break;
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			if (!observed) throw new Error("Garden did not receive notebook metadata");
		} finally {
			witness.provider.destroy();
			witness.doc.destroy();
		}
		await this.flush(documentId);
		await this.call("sparql_update", {
			graphId: this.graphId,
			update: `PREFIX nb: <${NOTEBOOK_NS}> INSERT DATA { <urn:mnemosyne:local:document:${documentId}> a nb:Notebook; nb:format ${JSON.stringify(NOTEBOOK_FORMAT)} . }`,
		});
		return { documentId, title: String(record.title ?? title), reconciled: alreadyInstalled };
	}
	async exportNotebook(documentId: string): Promise<string> {
		const { notebook } = await this.readNotebook(documentId);
		const contents = exportIpynb(notebook);
		if (Buffer.byteLength(contents, "utf8") > 1024 * 1024)
			throw new Error("MCP export exceeds 1 MiB; use the notebook app");
		return contents;
	}
	/** Read the same Y.Doc and codeBlock that Garden and the notebook app edit. */
	async notebookCell(documentId: string, cellId: string): Promise<NotebookCellSnapshot> {
		if (!documentId.startsWith("notebook-")) throw new Error("Not a Garden notebook document");
		const room = await this.liveRoom(documentId);
		const notebook = room.doc.getMap("sophia:notebook");
		if (notebook.get("format") !== "sophia.notebook.v1") throw new Error("Document has no notebook metadata");
		const cells = notebook.get("cells");
		if (!(cells instanceof Y.Map)) throw new Error("Notebook cell metadata is unavailable");
		const cellRaw = cells.get(cellId);
		if (typeof cellRaw !== "string") throw new Error("Notebook cell is unknown");
		const cell = JSON.parse(cellRaw) as { cell_type?: unknown };
		if (cell.cell_type !== "code") throw new Error("Only code cells can execute");
		const headerRaw = notebook.get("header");
		if (typeof headerRaw !== "string") throw new Error("Notebook header is unavailable");
		const header = JSON.parse(headerRaw) as {
			metadata?: { kernelspec?: { name?: string }; language_info?: { name?: string } };
		};
		const kind = header.metadata?.kernelspec?.name ?? header.metadata?.language_info?.name ?? "python3";
		const kernel = kind === "python" ? "python3" : kind;
		if (!["python3", "julia", "ocaml", "cpp"].includes(kernel))
			throw new Error(`Unsupported notebook kernel: ${kind}`);
		const blocks = this.source(room, true).blocks;
		const source = blocks.find((block) => block.id === cellId);
		if (!source) throw new Error("Notebook cell source is unavailable");
		return {
			documentId,
			cellId,
			source: source.text,
			sourceVersion: sha256(JSON.stringify({ source: source.text, kernel })),
			documentVersion: sha256(JSON.stringify(blocks)),
			kernel: kernel as NotebookCellSnapshot["kernel"],
		};
	}
	/** Update the notebook's latest visible output only while its source still matches the run. */
	async recordNotebookExecution(
		documentId: string,
		cellId: string,
		sourceVersion: string,
		record: NotebookExecutionRecord,
	): Promise<boolean> {
		const current = await this.notebookCell(documentId, cellId);
		if (current.sourceVersion !== sourceVersion) return false;
		const room = await this.liveRoom(documentId);
		const cells = room.doc.getMap("sophia:notebook").get("cells") as Y.Map<string>;
		const raw = cells.get(cellId);
		if (typeof raw !== "string") throw new Error("Notebook cell metadata disappeared");
		const fields = JSON.parse(raw) as Record<string, unknown>;
		const outputs = record.outputs.map((output) => {
			switch (output.kind) {
				case "stream":
					return { output_type: "stream", name: output.name ?? "stdout", text: output.text ?? "" };
				case "display":
					return { output_type: "display_data", data: output.data ?? {}, metadata: output.metadata ?? {} };
				case "result":
					return {
						output_type: "execute_result",
						data: output.data ?? { "text/plain": output.text ?? "" },
						metadata: output.metadata ?? {},
						execution_count: record.executionCount ?? null,
					};
				case "error":
					return {
						output_type: "error",
						ename: output.error?.ename ?? "Error",
						evalue: output.error?.evalue ?? "",
						traceback: output.error?.traceback ?? [],
					};
			}
			throw new Error("Unknown notebook output kind");
		});
		room.doc.transact(() => {
			cells.set(
				cellId,
				JSON.stringify({
					...fields,
					outputs,
					execution_count: record.executionCount ?? null,
					metadata: {
						...(fields.metadata && typeof fields.metadata === "object"
							? (fields.metadata as Record<string, unknown>)
							: {}),
						sophia: { lastExecutionId: record.executionId, sourceVersion, kernelGeneration: record.generation },
					},
				}),
			);
		}, "notebook-execution");
		await this.flush(documentId);
		return true;
	}
	private async liveRoom(id: string): Promise<Room> {
		const room = await this.room(id);
		if (room.provider.wsconnected && room.provider.synced) return room;
		await new Promise<void>((resolve, reject) => {
			const ready = () => {
				if (room.provider.wsconnected && room.provider.synced) {
					clearTimeout(timer);
					room.provider.off("sync", ready);
					resolve();
				}
			};
			const timer = setTimeout(() => {
				room.provider.off("sync", ready);
				reject(new Error(`Garden source is disconnected: ${id}`));
			}, 3000);
			room.provider.on("sync", ready);
			ready();
		});
		return room;
	}
	async watch(id: string, listener: () => void): Promise<() => void> {
		const room = await this.room(id);
		const synced = (value: boolean) => {
			if (value) listener();
		};
		room.doc.on("update", listener);
		room.provider.on("sync", synced);
		return () => {
			room.doc.off("update", listener);
			room.provider.off("sync", synced);
		};
	}
	/** All local versions are preflighted before any transaction. This is not a distributed CAS. */
	async editBatch(edits: { id: string; blockId: string; text: string; expectedVersion: string }[]) {
		const prepared = await Promise.all(edits.map(async (edit) => ({ edit, room: await this.room(edit.id) })));
		for (const { edit, room } of prepared) {
			if (Buffer.byteLength(edit.text) > 256 * 1024 || Buffer.from(edit.text).toString() !== edit.text)
				throw new Error("Invalid source text");
			if (!room.provider.wsconnected || !room.provider.synced) throw new Error("Garden source is disconnected");
			const source = this.source(room);
			if (
				source.version !== edit.expectedVersion ||
				source.blocks.length !== 1 ||
				source.blocks[0].id !== edit.blockId
			)
				throw new Error(`Source version conflict: ${edit.id}`);
		}
		// No awaits between the common preflight and every local transaction.
		for (const { edit, room } of prepared) {
			const shared = (room.doc.getXmlFragment("content").get(0) as Y.XmlElement).get(0) as Y.XmlText;
			room.doc.transact(() => {
				shared.delete(0, shared.length);
				if (edit.text) shared.insert(0, edit.text);
			}, "development-review");
		}
		return Promise.all(
			prepared.map(async ({ edit, room }) => {
				await this.flush(edit.id, this.source(room));
				return { id: edit.id, ...(await this.snapshot(edit.id)) };
			}),
		);
	}
	async edit(id: string, blockId: string, text: string, expectedVersion: string): Promise<SourceSnapshot> {
		if (Buffer.byteLength(text) > 256 * 1024) throw new Error("Source exceeds bound");
		if (Buffer.from(text, "utf8").toString("utf8") !== text) throw new Error("Source must be lossless UTF-8 text");
		const room = await this.room(id);
		if (!room.provider.wsconnected || !room.provider.synced) throw new Error("Garden source is disconnected");
		const before = this.source(room);
		if (before.version !== expectedVersion) throw new Error("Source version conflict");
		const node = room.doc
			.getXmlFragment("content")
			.toArray()
			.find(
				(node) =>
					node instanceof Y.XmlElement &&
					(node.getAttribute("data-block-id") ?? node.getAttribute("blockId")) === blockId,
			) as Y.XmlElement | undefined;
		if (!node) throw new Error("Unknown source block");
		const shared = node.get(0) as Y.XmlText;
		const old = before.blocks.find((block) => block.id === blockId)!.text;
		const oldPoints = Array.from(old),
			newPoints = Array.from(text);
		let common = 0;
		while (common < oldPoints.length && common < newPoints.length && oldPoints[common] === newPoints[common])
			common++;
		let end = 0;
		while (
			end < oldPoints.length - common &&
			end < newPoints.length - common &&
			oldPoints[oldPoints.length - end - 1] === newPoints[newPoints.length - end - 1]
		)
			end++;
		const prefix = oldPoints.slice(0, common).join("").length;
		const suffix = end ? oldPoints.slice(-end).join("").length : 0;
		room.doc.transact(() => {
			if (old.length - prefix - suffix) shared.delete(prefix, old.length - prefix - suffix);
			if (text.length - prefix - suffix) shared.insert(prefix, text.slice(prefix, text.length - suffix));
		}, "development-mcp");
		const after = this.source(room);
		await this.flush(id, after);
		return this.snapshot(id);
	}
	async flush(id: string, expected?: SourceSnapshot): Promise<void> {
		const room = await this.liveRoom(id);
		const snapshot = expected ?? (await this.snapshot(id));
		const notebook = id.startsWith("notebook-");
		if (this.source(room, notebook).version !== snapshot.version)
			throw new Error("Source changed before synchronization; retry");
		if (this.flushedVersions.get(id) === snapshot.version) return;
		// A distinct room connection witnesses remote receipt before requesting disk flush.
		const verifier = await this.connect(id);
		try {
			for (let n = 0; n < 100 && this.source(verifier, notebook).version !== snapshot.version; n++)
				await new Promise((resolve) => setTimeout(resolve, 20));
			if (this.source(verifier, notebook).version !== snapshot.version)
				throw new Error("Source changed during synchronization; retry");
			await this.call("flush_crdt", { graphId: this.graphId, documentId: id });
			this.flushedVersions.set(id, snapshot.version);
		} finally {
			verifier.provider.destroy();
			verifier.doc.destroy();
		}
	}
	async close(): Promise<void> {
		for (const value of this.rooms.values()) {
			const room = await value.catch(() => undefined);
			room?.provider.destroy();
			room?.doc.destroy();
		}
		this.rooms.clear();
	}
}
