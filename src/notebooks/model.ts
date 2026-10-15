/** Shared Garden notebook room contract, mirrored from Shrubbery's notebook-document. */
import { createHash, randomUUID } from "node:crypto";
import * as Y from "yjs";

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export const NOTEBOOK_FORMAT = "sophia.notebook.v1";
export const NOTEBOOK_NS = "https://sophia-labs.com/ns/notebook#";
const MAX_IMPORT_BYTES = 768 * 1024;
const MAX_SOURCE_BYTES = 256 * 1024;

type JsonObject = Record<string, unknown>;
export interface NotebookCell {
	id: string;
	kind: "code" | "markdown" | "raw";
	language: string;
	source: string;
	fields: JsonObject;
	origin?: "garden";
}
export interface NotebookDocument {
	header: JsonObject;
	cells: NotebookCell[];
}

function object(value: unknown, label: string): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as JsonObject;
}
function sourceText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value) && value.every((part) => typeof part === "string")) return value.join("");
	throw new Error("Notebook cell source must be text or an array of text lines");
}
function stableId(value: unknown, used: Set<string>): string {
	let id = typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : "";
	if (!id || used.has(id)) id = `cell-${randomUUID()}`;
	used.add(id);
	return id;
}
function root(doc: Y.Doc): Y.Map<unknown> {
	return doc.getMap("sophia:notebook");
}
function xmlBlock(doc: Y.Doc, id: string): Y.XmlElement {
	const matches = doc
		.getXmlFragment("content")
		.toArray()
		.filter(
			(node) =>
				node instanceof Y.XmlElement && (node.getAttribute("data-block-id") ?? node.getAttribute("blockId")) === id,
		);
	if (matches.length !== 1 || !(matches[0] instanceof Y.XmlElement) || matches[0].nodeName !== "codeBlock")
		throw new Error(`Notebook cell ${id} has no unique Garden code block`);
	return matches[0];
}
function xmlText(block: Y.XmlElement): Y.XmlText {
	const children = block.toArray();
	if (children.length !== 1 || !(children[0] instanceof Y.XmlText))
		throw new Error("Notebook source is not one shared text");
	const deltas = children[0].toDelta();
	if (
		deltas.some(
			(part: { insert: unknown; attributes?: unknown }) =>
				typeof part.insert !== "string" || (part.attributes && Object.keys(part.attributes).length),
		)
	)
		throw new Error("Notebook source contains marks or embeds");
	return children[0];
}
function kernelName(header: JsonObject): string {
	const meta = object(header.metadata ?? {}, "Notebook metadata");
	const spec = object(meta.kernelspec ?? {}, "Notebook kernelspec");
	const info = object(meta.language_info ?? {}, "Notebook language_info");
	const value = spec.name ?? info.name ?? "python3";
	return value === "python" ? "python3" : String(value);
}
export function cellSourceVersion(cell: NotebookCell, header: JsonObject): string {
	return sha256(
		JSON.stringify({ source: cell.source, kernel: cell.kind === "code" ? kernelName(header) : cell.kind }),
	);
}
export function documentVersion(doc: Y.Doc): string {
	// A Yjs deletion may advance its delete set without advancing the state
	// vector. Include the projected room state so structural edits cannot reuse a
	// version after deletion.
	return sha256(`${Buffer.from(Y.encodeStateVector(doc)).toString("base64")}:${JSON.stringify(readNotebook(doc))}`);
}
export function parseIpynb(contents: string): NotebookDocument {
	if (Buffer.byteLength(contents, "utf8") > MAX_IMPORT_BYTES)
		throw new Error("Notebook MCP import exceeds 768 KiB; use the app for larger files");
	const raw = object(JSON.parse(contents) as unknown, "Notebook");
	if (raw.nbformat !== 4 || !Number.isInteger(raw.nbformat_minor) || !Array.isArray(raw.cells))
		throw new Error("Expected a Jupyter notebook in nbformat 4");
	const { cells: rawCells, ...header } = raw;
	object(header.metadata ?? {}, "Notebook metadata");
	const used = new Set<string>();
	const cells = rawCells.map((value, index) => {
		const cell = object(value, `Cell ${index + 1}`);
		if (cell.cell_type !== "code" && cell.cell_type !== "markdown" && cell.cell_type !== "raw")
			throw new Error(`Unsupported cell type in cell ${index + 1}`);
		const id = stableId(cell.id, used);
		const { source, ...fields } = cell;
		return {
			id,
			kind: cell.cell_type,
			language: cell.cell_type === "code" ? kernelName(header) : cell.cell_type,
			source: sourceText(source),
			fields: { ...fields, id },
		} as NotebookCell;
	});
	if (!cells.length) throw new Error("Notebook needs at least one cell");
	return { header: { ...header, nbformat_minor: Math.max(raw.nbformat_minor as number, 5) }, cells };
}
export function newNotebook(language: string, cellId = `cell-${randomUUID()}`): NotebookDocument {
	const kernel = language === "python" ? "python3" : language;
	return {
		header: {
			nbformat: 4,
			nbformat_minor: 5,
			metadata: { kernelspec: { name: kernel, display_name: language }, language_info: { name: language } },
		},
		cells: [
			{
				id: cellId,
				kind: "code",
				language,
				source: "",
				fields: { id: cellId, cell_type: "code", metadata: {}, outputs: [], execution_count: null },
			},
		],
	};
}
export function tiptapJson(notebook: NotebookDocument): JsonObject {
	return {
		type: "doc",
		content: notebook.cells.map((cell) => ({
			type: "codeBlock",
			attrs: { "data-block-id": cell.id, language: cell.language },
			content: [{ type: "text", text: cell.source || "\n" }],
		})),
	};
}
export function installMetadata(doc: Y.Doc, notebook: NotebookDocument): void {
	const map = root(doc),
		cells = new Y.Map<string>();
	doc.transact(() => {
		map.set("format", NOTEBOOK_FORMAT);
		map.set("header", JSON.stringify(notebook.header));
		map.set("cells", cells);
		for (const cell of notebook.cells) cells.set(cell.id, JSON.stringify(cell.fields));
		for (const cell of notebook.cells.filter((item) => item.source === "")) {
			const text = xmlText(xmlBlock(doc, cell.id));
			if (text.toString() === "\n") text.delete(0, 1);
		}
	}, "notebook-import");
}
export function readNotebook(doc: Y.Doc): NotebookDocument {
	const map = root(doc);
	if (map.get("format") !== NOTEBOOK_FORMAT) throw new Error("Garden document has no notebook metadata");
	const headerRaw = map.get("header"),
		fields = map.get("cells");
	if (typeof headerRaw !== "string" || !(fields instanceof Y.Map)) throw new Error("Notebook metadata is incomplete");
	const header = object(JSON.parse(headerRaw) as unknown, "Notebook header");
	const cells = doc
		.getXmlFragment("content")
		.toArray()
		.flatMap((node, index): NotebookCell[] => {
			if (node instanceof Y.XmlElement && node.nodeName === "paragraph") {
				const source = node
					.toArray()
					.map((child) => {
						if (!(child instanceof Y.XmlText)) throw new Error("Garden prose contains an unsupported embed");
						return child
							.toDelta()
							.map((part: { insert: unknown }) => {
								if (typeof part.insert !== "string") throw new Error("Garden prose contains an embed");
								return part.insert;
							})
							.join("");
					})
					.join("");
				if (!source.trim()) return [];
				const id = node.getAttribute("data-block-id") ?? node.getAttribute("blockId");
				if (typeof id !== "string" || !id) throw new Error("Garden prose has no stable ID");
				return [
					{
						id,
						kind: "markdown",
						language: "markdown",
						source,
						origin: "garden",
						fields: {
							id,
							cell_type: "markdown",
							metadata: { sophia: { gardenBlockType: "paragraph" } },
						},
					},
				];
			}
			if (!(node instanceof Y.XmlElement) || node.nodeName !== "codeBlock")
				throw new Error(`Garden block ${index + 1} is outside notebook cells`);
			const id = node.getAttribute("data-block-id") ?? node.getAttribute("blockId");
			if (typeof id !== "string" || !id) throw new Error(`Notebook block ${index + 1} has no ID`);
			const raw = fields.get(id);
			if (typeof raw !== "string") throw new Error(`Notebook cell ${id} has no metadata`);
			const cellFields = object(JSON.parse(raw) as unknown, `Cell ${id} metadata`);
			const kind = cellFields.cell_type;
			if (kind !== "code" && kind !== "markdown" && kind !== "raw")
				throw new Error(`Notebook cell ${id} has an invalid type`);
			const source = xmlText(node).toString();
			return [
				{
					id,
					kind,
					language: String(node.getAttribute("language") ?? (kind === "code" ? kernelName(header) : kind)),
					source,
					fields: cellFields,
				},
			];
		});
	return { header, cells };
}
export function exportIpynb(notebook: NotebookDocument): string {
	return `${JSON.stringify({ ...notebook.header, cells: notebook.cells.map((cell) => ({ ...cell.fields, id: cell.id, cell_type: cell.kind, source: cell.source })) }, null, 2)}\n`;
}
export function replaceSource(doc: Y.Doc, cellId: string, source: string, expectedSourceVersion: string): void {
	if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES || Buffer.from(source, "utf8").toString("utf8") !== source)
		throw new Error("Cell source must be lossless UTF-8 under 256 KiB");
	const notebook = readNotebook(doc),
		cell = notebook.cells.find((item) => item.id === cellId);
	if (!cell || cell.origin) throw new Error("Unknown editable notebook cell");
	if (cellSourceVersion(cell, notebook.header) !== expectedSourceVersion)
		throw new Error("Cell source version conflict; reread before editing");
	const shared = xmlText(xmlBlock(doc, cellId));
	const old = Array.from(cell.source),
		next = Array.from(source);
	let start = 0,
		end = 0;
	while (start < old.length && start < next.length && old[start] === next[start]) start++;
	while (
		end < old.length - start &&
		end < next.length - start &&
		old[old.length - end - 1] === next[next.length - end - 1]
	)
		end++;
	const prefix = old.slice(0, start).join("").length;
	const suffix = end ? old.slice(-end).join("").length : 0;
	doc.transact(() => {
		if (old.join("").length - prefix - suffix) shared.delete(prefix, old.join("").length - prefix - suffix);
		if (source.length - prefix - suffix) shared.insert(prefix, source.slice(prefix, source.length - suffix));
	}, "notebook-mcp-edit");
}
export function insertCell(doc: Y.Doc, afterCellId: string | null, kind: NotebookCell["kind"], source: string): string {
	if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) throw new Error("Cell source exceeds 256 KiB");
	const notebook = readNotebook(doc),
		id = `cell-${randomUUID()}`;
	const content = doc.getXmlFragment("content"),
		blocks = content.toArray();
	const after =
		afterCellId === null
			? blocks.reduce(
					(last, node, index) => (node instanceof Y.XmlElement && node.nodeName === "codeBlock" ? index : last),
					-1,
				)
			: blocks.findIndex(
					(node) =>
						node instanceof Y.XmlElement &&
						(node.getAttribute("data-block-id") ?? node.getAttribute("blockId")) === afterCellId,
				);
	if (afterCellId !== null && (after < 0 || !notebook.cells.some((cell) => cell.id === afterCellId)))
		throw new Error("Unknown preceding cell");
	const element = new Y.XmlElement("codeBlock"),
		text = new Y.XmlText();
	element.setAttribute("data-block-id", id);
	element.setAttribute("language", kind === "code" ? kernelName(notebook.header) : kind);
	if (source) text.insert(0, source);
	element.insert(0, [text]);
	const fields = root(doc).get("cells") as Y.Map<string>;
	doc.transact(() => {
		content.insert(after + 1, [element]);
		fields.set(
			id,
			JSON.stringify({
				id,
				cell_type: kind,
				metadata: {},
				...(kind === "code" ? { outputs: [], execution_count: null } : {}),
			}),
		);
	}, "notebook-mcp-insert");
	return id;
}
export function deleteCell(doc: Y.Doc, cellId: string): void {
	const notebook = readNotebook(doc),
		cell = notebook.cells.find((item) => item.id === cellId);
	if (!cell || cell.origin) throw new Error("Unknown editable notebook cell");
	if (notebook.cells.filter((item) => !item.origin).length <= 1)
		throw new Error("Cannot delete the last notebook cell");
	const content = doc.getXmlFragment("content");
	const index = content
		.toArray()
		.findIndex(
			(node) =>
				node instanceof Y.XmlElement &&
				(node.getAttribute("data-block-id") ?? node.getAttribute("blockId")) === cellId,
		);
	if (index < 0) throw new Error("Notebook cell disappeared");
	doc.transact(() => {
		content.delete(index, 1);
		(root(doc).get("cells") as Y.Map<string>).delete(cellId);
	}, "notebook-mcp-delete");
}
