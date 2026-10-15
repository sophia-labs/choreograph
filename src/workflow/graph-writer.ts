/**
 * GraphWriter — the orchestrator's typed handle on a graph, for the deterministic
 * (code-serializes) side of a workflow: searching documents, writing the
 * synthesis doc, running SPARQL, emitting provenance. Backed by a full-profile
 * HostedMnemosyneProxy (gateway service-auth). Defined as an interface so drivers
 * and the emitter can be unit-tested against a fake.
 */

import type { HostedMnemosyneProxy } from "../mnemosyne.js";
import { type EmporiumIngestAuth, type GenericIngestRequest, postEmporiumIngest } from "./emporium-ingest.js";
import { userRdfGraphIri } from "./vocab.js";

export interface FoundDocument {
	document_id: string;
	title?: string;
}

export type GraphDocumentReadFormat = "markdown" | "xml" | "json" | "ids_only";

export interface GraphDocumentBlock {
	blockId?: string;
	blockUri?: string;
	type?: string;
	text?: string;
	attrs?: Record<string, unknown>;
}

export interface GraphDocumentRead {
	graphId: string;
	documentId: string;
	documentUri: string;
	title?: string;
	format: GraphDocumentReadFormat;
	text?: string;
	blocks: GraphDocumentBlock[];
	blockCount?: number;
	revision?: number;
	changeId?: string;
	createdAt?: string;
	updatedAt?: string;
	raw: unknown;
}

export interface ReadDocumentOptions {
	format?: GraphDocumentReadFormat;
}

/**
 * How the cell should read the content of a write. Absent leaves it to the cell's detection, which reads
 * text with a Markdown hint (a backtick pair, `**`) as Markdown and rewrites it; JSON goes through
 * `writeJsonDocument` instead.
 */
export interface WriteDocumentOptions {
	format?: "markdown" | "plain";
}

export interface GraphWriter {
	sparqlUpdate(graphId: string, sparql: string): Promise<void>;
	sparqlQuery(graphId: string, sparql: string): Promise<unknown>;
	searchDocuments(graphId: string, query: string, limit: number): Promise<FoundDocument[]>;
	/** The whole document: a writer that pages (the hosted one) reads until the cell says it is complete. */
	readDocument(graphId: string, documentId: string, options?: ReadDocumentOptions): Promise<GraphDocumentRead>;
	writeDocument(
		graphId: string,
		documentId: string,
		content: string,
		options?: WriteDocumentOptions,
	): Promise<unknown>;
	/** Privileged registered-vocabulary projection lane; absent when no host auth is configured. */
	emporiumIngest?(graphId: string, request: GenericIngestRequest): Promise<unknown>;
}

export interface HostedGraphWriterOptions {
	readonly emporium?: {
		readonly baseUrl: string;
		readonly auth: EmporiumIngestAuth;
		readonly fetchFn?: typeof fetch;
	};
}

/**
 * Return JSON authored as document text. Garden's canonical Markdown face
 * renders a lossless JSON code block with its fence, one backtick longer than
 * the longest run inside the code and never shorter than three (garden r20261002
 * `markdown_export.rs`), so any fence of three or more backticks is accepted,
 * closed by a run at least as long. Raw one-line JSON from older seeds remains
 * valid during migration.
 */
export function unwrapAuthoredJsonDocument(text: string): string {
	const trimmed = text.trim();
	const fenced = /^(`{3,})json[\t ]*\r?\n([\s\S]*?)\r?\n\1`*[\t ]*$/i.exec(trimmed);
	return fenced?.[2] ?? trimmed;
}

/** JSON text as a fenced `json` code block, fenced one backtick longer than its longest run (at least three). */
export function fencedJsonDocument(json: string): string {
	const longest = Math.max(0, ...[...json.matchAll(/`+/g)].map((match) => match[0].length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}json\n${json}\n${fence}\n`;
}

/** A JSON document did not read back as the JSON written. */
export class JsonDocumentWriteError extends Error {
	constructor(
		message: string,
		readonly details: { readonly graphId: string; readonly documentId: string },
	) {
		super(message);
		this.name = "JsonDocumentWriteError";
	}
}

/**
 * Write a value as a JSON document the cell keeps exactly: a fenced `json` code block, written as Markdown (a
 * code block's text is never reflowed or unescaped), then read back and compared byte for byte. Written bare and
 * without a format, JSON holding a backtick pair or `**` is parsed as Markdown and the stored text changes (the
 * backslash of an escaped quote is lost); written as plain text, its newlines and runs of spaces are folded.
 */
export async function writeJsonDocument(
	graph: GraphWriter,
	graphId: string,
	documentId: string,
	value: unknown,
): Promise<unknown> {
	const json = JSON.stringify(value, null, 2);
	const result = await graph.writeDocument(graphId, documentId, fencedJsonDocument(json), { format: "markdown" });
	const back = await graph.readDocument(graphId, documentId, { format: "markdown" });
	if (unwrapAuthoredJsonDocument(back.text ?? "") !== json) {
		throw new JsonDocumentWriteError(
			`document '${documentId}' in graph '${graphId}' did not read back as the JSON written`,
			{ graphId, documentId },
		);
	}
	return result;
}

/** The page `read_document` is asked for (garden's largest, `document_mcp_service.rs` MAX_READ_CHARS). */
export const READ_DOCUMENT_PAGE_CHARS = 262_144;
/** The longest document the host reads whole; a longer one is refused rather than read without end. */
export const MAX_DOCUMENT_READ_CHARS = 4 * 1024 * 1024;
/**
 * The most pages the host reads for one document: the bound at garden's default page (65,536 characters), so a cell
 * that pages smaller than it is asked to can still be read whole, and one that trickles cannot keep the host reading.
 */
export const MAX_DOCUMENT_READ_PAGES = MAX_DOCUMENT_READ_CHARS / 65_536;

/** A paged read the host refuses: the cell's pages do not add up to one whole, unchanging document. */
export class DocumentReadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DocumentReadError";
	}
}

interface ReadPage {
	readonly text: string;
	/** Characters as the cell counts them (Unicode scalar values, Rust `chars()`), not UTF-16 code units. */
	readonly chars: number;
	readonly complete?: boolean;
	readonly offset?: number;
	readonly nextOffset?: number | null;
	readonly totalChars?: number;
	readonly graphId?: string;
	readonly documentId?: string;
	readonly revision?: number;
}

function readPage(raw: unknown): ReadPage {
	const parsed = unwrapMcpPayload(raw);
	const record = isRecord(parsed) ? parsed : {};
	const text = typeof record.content === "string" ? record.content : "";
	const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
	return {
		text,
		chars: [...text].length,
		...(typeof record.complete === "boolean" ? { complete: record.complete } : {}),
		...(number(record.offset) !== undefined ? { offset: number(record.offset) } : {}),
		...(record.nextOffset === null ? { nextOffset: null } : {}),
		...(number(record.nextOffset) !== undefined ? { nextOffset: number(record.nextOffset) } : {}),
		...(number(record.totalChars) !== undefined ? { totalChars: number(record.totalChars) } : {}),
		...(typeof record.graph_id === "string" ? { graphId: record.graph_id } : {}),
		...(typeof record.document_id === "string" ? { documentId: record.document_id } : {}),
		...(number(record.revision) !== undefined ? { revision: number(record.revision) } : {}),
	};
}

/**
 * Read a document whole from a cell that pages `read_document` (garden since r20260807a, 2026-08-07: `offset`,
 * `nextOffset`, `complete`, `totalChars` on every page). Strict (exam 1): it succeeds only when a page says
 * `complete: true`; every page begins exactly where the last ended (the first at 0), and an unfinished page carries text
 * and names the offset right after it; the graph, the document, its revision and its total are the same on every page;
 * a completed read holds exactly the total; no page and no document is over `MAX_DOCUMENT_READ_CHARS`, and no read takes
 * more than `MAX_DOCUMENT_READ_PAGES` pages. A cell's error answer to the first page is returned as it is (callers read
 * `raw.isError` and classify a missing document); an error after it is refused.
 */
async function readDocumentPages(
	call: (offset: number | undefined) => Promise<unknown>,
	graphId: string,
	documentId: string,
): Promise<{ readonly first: unknown; readonly text: string }> {
	const refuse = (message: string): never => {
		throw new DocumentReadError(`read_document '${documentId}': ${message}`);
	};
	const firstRaw = await call(undefined);
	if (isRecord(firstRaw) && firstRaw.isError === true) return { first: firstRaw, text: "" };
	const first = readPage(firstRaw);
	let current = first;
	let raw: unknown = firstRaw;
	let expected = 0;
	let text = "";
	for (let pages = 1; ; pages += 1) {
		if (isRecord(raw) && raw.isError === true) refuse("the cell answered an error in the middle of the document");
		if (current.complete === undefined) refuse("the cell did not say whether the document is complete");
		if (current.offset !== expected) {
			refuse(`a page began at offset ${String(current.offset)}, not ${String(expected)} where the last ended`);
		}
		if (pages > 1) {
			for (const key of ["graphId", "documentId", "revision", "totalChars"] as const) {
				if (current[key] !== first[key]) {
					refuse(
						`the document changed while it was read (${key} ${String(first[key])} became ${String(current[key])})`,
					);
				}
			}
		}
		// Exam 2, D: the cell must say whose page this is, and it must be the one asked for. Garden sends `graph_id` and
		// `document_id` on every read; a page that names neither (or another) is not proof of what was read.
		if (current.graphId !== graphId) {
			refuse(
				current.graphId === undefined
					? "the cell did not say which graph the page is from"
					: `the cell answered for another graph (${current.graphId}, not ${graphId})`,
			);
		}
		if (current.documentId !== documentId) {
			refuse(
				current.documentId === undefined
					? "the cell did not say which document the page is from"
					: `the cell answered for another document's identity (${current.documentId})`,
			);
		}
		if (first.totalChars !== undefined && first.totalChars > MAX_DOCUMENT_READ_CHARS) {
			refuse(
				`the document is longer than ${String(MAX_DOCUMENT_READ_CHARS)} characters (${String(first.totalChars)})`,
			);
		}
		if (expected + current.chars > MAX_DOCUMENT_READ_CHARS) {
			refuse(`the document is longer than ${String(MAX_DOCUMENT_READ_CHARS)} characters`);
		}
		// Garden sends `totalChars` on every page (since r20260807a, the floor this reader is released against): without it
		// a "complete" page proves nothing about the document's length. `revision` stays optional (cells between
		// r20260807a and r20260807b did not send it) and must agree across pages.
		if (current.totalChars === undefined) refuse("the cell did not say how long the document is (totalChars)");
		text += current.text;
		expected += current.chars;
		if (current.complete) {
			if (current.totalChars !== undefined && expected !== current.totalChars) {
				refuse(`the cell said complete at ${String(expected)} of ${String(current.totalChars)} characters`);
			}
			return { first: firstRaw, text };
		}
		if (current.chars === 0)
			refuse(`an unfinished page at offset ${String(current.offset)} was empty: the read did not advance`);
		if (current.nextOffset !== expected) {
			refuse(`a page ending at offset ${String(expected)} named the next offset ${String(current.nextOffset)}`);
		}
		if (pages >= MAX_DOCUMENT_READ_PAGES) {
			refuse(`the document did not complete within ${String(MAX_DOCUMENT_READ_PAGES)} pages`);
		}
		raw = await call(expected);
		current = readPage(raw);
	}
}

/** A run that may not write to its graph tried to (`readOnlyGraphWriter`). */
export class GraphWriteRefusedError extends Error {
	constructor(operation: string) {
		super(`this run may not write to its graph (${operation})`);
		this.name = "GraphWriteRefusedError";
	}
}

/**
 * The graph as a run that must not write to it sees it (a Reader workspace chat, exam 1): reads pass through, and every
 * write (SPARQL update, document write, Emporium ingest) is refused before it leaves the host.
 */
export function readOnlyGraphWriter(graph: GraphWriter): GraphWriter {
	return {
		sparqlUpdate: async () => {
			throw new GraphWriteRefusedError("sparql_update");
		},
		sparqlQuery: (graphId, sparql) => graph.sparqlQuery(graphId, sparql),
		searchDocuments: (graphId, query, limit) => graph.searchDocuments(graphId, query, limit),
		readDocument: (graphId, documentId, options) => graph.readDocument(graphId, documentId, options),
		writeDocument: async () => {
			throw new GraphWriteRefusedError("write_document");
		},
		...(graph.emporiumIngest
			? {
					emporiumIngest: async () => {
						throw new GraphWriteRefusedError("emporium ingest");
					},
				}
			: {}),
	};
}

export function makeHostedGraphWriter(
	proxy: HostedMnemosyneProxy,
	options: HostedGraphWriterOptions = {},
): GraphWriter {
	const writer: GraphWriter = {
		async sparqlUpdate(graphId, sparql) {
			// GAP-2 FIX: scope every provenance write to the cell's UI-readable
			// user-RDF named graph. The cell executes SPARQL verbatim, so a bare
			// `INSERT DATA { … }` lands in the default graph (invisible to Studio's
			// Provenance view). `scopeUpdateToUserRdfGraph` wraps the update body in
			// a LITERAL `GRAPH <…:user:rdf>` clause (admitted by the cell validator).
			// Tool args use the cell contract `{ graphId, update }` (camelCase) — the
			// cell reads ONLY camelCase keys (emporium_engine/gateway.py:277,
			// garden rdf_mcp_inputs.rs), so the prior snake_case args silently
			// degraded to an empty update on a strict cell.
			await proxy.callTool("sparql_update", {
				graphId,
				update: scopeUpdateToUserRdfGraph(graphId, sparql),
			});
		},
		async sparqlQuery(graphId, sparql) {
			return proxy.callTool("sparql_query", { graphId, query: sparql });
		},
		async searchDocuments(graphId, query, limit) {
			const raw = await proxy.callTool("search_documents", { graph_id: graphId, query, limit });
			return extractFoundDocuments(raw);
		},
		async readDocument(graphId, documentId, options) {
			const format = options?.format ?? "markdown";
			const request = { graph_id: graphId, document_id: documentId, format };
			if (format === "ids_only") {
				return normalizeGraphDocumentRead(await proxy.callTool("read_document", request), {
					graphId,
					documentId,
					format,
				});
			}
			// The cell answers one bounded page (65,536 characters unless asked for more); read until it says the
			// document is complete, page by page, strictly (`readDocumentPages`), so a document is never parsed truncated,
			// stitched from two revisions, or read without end.
			const { first, text } = await readDocumentPages(
				(offset) =>
					proxy.callTool("read_document", {
						...request,
						maxChars: READ_DOCUMENT_PAGE_CHARS,
						...(offset === undefined ? {} : { offset }),
					}),
				graphId,
				documentId,
			);
			const normalized = normalizeGraphDocumentRead(first, { graphId, documentId, format });
			return isRecord(first) && first.isError === true ? normalized : { ...normalized, text };
		},
		async writeDocument(graphId, documentId, content, options) {
			return proxy.callTool("write_document", {
				graph_id: graphId,
				document_id: documentId,
				content,
				...(options?.format ? { format: options.format } : {}),
			});
		},
	};
	if (options.emporium) {
		writer.emporiumIngest = async (graphId, request) => {
			const result = await postEmporiumIngest(
				options.emporium!.baseUrl,
				graphId,
				request,
				options.emporium!.auth,
				options.emporium!.fetchFn,
			);
			if (!result.ok) {
				throw new Error(`Garden Emporium ingest returned HTTP ${result.status ?? "transport-error"}`);
			}
			if (!result.body) return { ok: true, status: result.status };
			try {
				return JSON.parse(result.body) as unknown;
			} catch {
				throw new Error("Garden Emporium ingest returned non-JSON success content");
			}
		};
	}
	return writer;
}

/**
 * GAP-2 FIX — scope a provenance SPARQL update to the cell's UI-readable user-RDF
 * named graph by wrapping the operation body in a LITERAL `GRAPH <…:user:rdf>`
 * clause. The deployed cell executes `sparql_update` VERBATIM against pyoxigraph
 * (only the separate `rdf_load` path auto-scopes), so an unwrapped
 * `INSERT DATA { … }` lands in the DEFAULT graph and is invisible to Studio's
 * Provenance/anatomy view and all `:projection:*` materializers (which read the
 * `:user:rdf` authority graph). See `vocab.ts userRdfGraphIri` for the cell
 * contract; the reference pattern is `platform-next/gateway/src/ux_seed.rs`.
 *
 * Handles the operation shapes our serializers emit — `INSERT DATA { … }`,
 * `DELETE DATA { … }`, and the pattern-form `DELETE WHERE { … }` (idempotency).
 * The PREFIX preamble (before the keyword) is left untouched. The wrap is a
 * no-op if the body already carries a `GRAPH` clause or no recognised operation
 * is found (the update then files verbatim — preserving prior behavior for any
 * future operation shape rather than silently corrupting it).
 *
 * Uses balanced-brace scanning from the first `{` after the operation keyword,
 * not a regex, so a body with nested grouping (none today, but robust) is wrapped
 * whole.
 */
export function scopeUpdateToUserRdfGraph(graphId: string, sparql: string): string {
	const target = userRdfGraphIri(graphId);
	// Already explicitly graph-scoped (e.g. a future caller, or a re-wrap) → leave
	// it. Match the SPARQL `GRAPH` keyword in CLAUSE position only (`GRAPH <iri>`
	// or `GRAPH ?var`), NOT the substring "graph" inside a literal such as
	// `wf:workflowName "graph-survey-synthesize"` or `wf:agentType "graph-surveyor"`.
	if (/\bGRAPH\s+[<?]/i.test(sparql)) {
		return sparql;
	}
	// Match the FIRST top-level operation keyword and its opening brace. The
	// serializers emit exactly one operation per update string.
	const opMatch = /\b(INSERT\s+DATA|DELETE\s+DATA|DELETE\s+WHERE)\b\s*\{/i.exec(sparql);
	if (!opMatch) {
		return sparql;
	}
	const braceOpen = opMatch.index + opMatch[0].length - 1; // index of the `{`
	const braceClose = matchingBrace(sparql, braceOpen);
	if (braceClose < 0) {
		return sparql; // unbalanced — file verbatim rather than mangle
	}
	const head = sparql.slice(0, braceOpen + 1); // up to & incl. the operation `{`
	const body = sparql.slice(braceOpen + 1, braceClose); // inner triples/pattern
	const tail = sparql.slice(braceClose); // the operation's closing `}` + trailing
	// head { …  →  head {  GRAPH <iri> { … }  } …  — the GRAPH close is added; the
	// operation's own `}` (kept in `tail`) closes the INSERT DATA / DELETE block.
	return `${head}\n\tGRAPH <${target}> {${body}}\n${tail}`;
}

/** Index of the `}` matching the `{` at `openIdx`, or -1 if unbalanced. */
function matchingBrace(s: string, openIdx: number): number {
	let depth = 0;
	for (let i = openIdx; i < s.length; i++) {
		if (s[i] === "{") {
			depth++;
		} else if (s[i] === "}") {
			depth--;
			if (depth === 0) {
				return i;
			}
		}
	}
	return -1;
}

/**
 * Best-effort extraction of document ids from an MCP tool result. The hosted MCP
 * returns a CallToolResult ({ content:[{type:text,text}], structuredContent }) —
 * shapes vary, so we walk the payload (and any embedded JSON text) collecting any
 * object carrying a `document_id`.
 */
export function extractFoundDocuments(raw: unknown): FoundDocument[] {
	const found: FoundDocument[] = [];
	const seen = new Set<string>();

	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const entry of value) {
				visit(entry);
			}
			return;
		}
		if (value && typeof value === "object") {
			const record = value as Record<string, unknown>;
			const id = record.document_id ?? record.documentId ?? record.id;
			if (typeof id === "string" && id && !seen.has(id)) {
				seen.add(id);
				const title = typeof record.title === "string" ? record.title : undefined;
				found.push({ document_id: id, title });
			}
			// MCP text content frequently carries a JSON string payload.
			if (typeof record.text === "string") {
				const parsed = tryParseJson(record.text);
				if (parsed !== undefined) {
					visit(parsed);
				}
			}
			for (const child of Object.values(record)) {
				if (child && typeof child === "object") {
					visit(child);
				}
			}
		}
	};

	visit(raw);
	return found;
}

export function normalizeGraphDocumentRead(
	raw: unknown,
	fallback: { graphId: string; documentId: string; format?: GraphDocumentReadFormat },
): GraphDocumentRead {
	const parsed = unwrapMcpPayload(raw);
	const record = isRecord(parsed) ? parsed : {};
	const graphId =
		stringField(record, ["graph_id", "graphId"]) ??
		stringField(isRecord(raw) ? raw : {}, ["graph_id", "graphId"]) ??
		fallback.graphId;
	const documentId =
		stringField(record, ["document_id", "documentId", "id"]) ??
		stringField(isRecord(raw) ? raw : {}, ["document_id", "documentId", "id"]) ??
		fallback.documentId;
	const format = normalizeReadFormat(stringField(record, ["format"]) ?? fallback.format);
	const text = documentTextFromRecord(record, parsed);
	const blocks = extractDocumentBlocks(parsed, documentId);
	const blockCount = numberField(record, ["block_count", "blockCount"]);

	return {
		graphId,
		documentId,
		documentUri: documentUri(documentId),
		title: stringField(record, ["title", "name"]),
		format,
		text,
		blocks,
		blockCount: blockCount ?? (blocks.length > 0 ? blocks.length : undefined),
		revision: numberField(record, ["revision", "rev"]),
		changeId: stringField(record, ["change_id", "changeId", "snapshot_id", "snapshotId"]),
		createdAt: stringField(record, ["created_at", "createdAt"]),
		updatedAt: stringField(record, ["updated_at", "updatedAt"]),
		raw,
	};
}

export function documentUri(documentId: string): string {
	return documentId.startsWith("urn:mnemosyne:") ? documentId : `urn:mnemosyne:local:document:${documentId}`;
}

export function documentBlockUri(documentId: string, blockId: string): string {
	return `${documentUri(documentId)}#block-${blockId}`;
}

function unwrapMcpPayload(raw: unknown): unknown {
	const structured = firstStructuredContent(raw);
	if (structured !== undefined) return structured;
	const text = extractTextFromMcpContent(raw);
	if (text) {
		return tryParseJson(text) ?? { content: text };
	}
	return raw;
}

function firstStructuredContent(value: unknown): unknown {
	if (!isRecord(value)) return undefined;
	if (value.structuredContent !== undefined) return value.structuredContent;
	if (value.structured_content !== undefined) return value.structured_content;
	return undefined;
}

function extractTextFromMcpContent(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.text === "string") return value.text;
	const content = value.content;
	if (!Array.isArray(content)) return undefined;
	const parts = content
		.map((entry) => (isRecord(entry) && typeof entry.text === "string" ? entry.text : undefined))
		.filter((entry): entry is string => entry !== undefined);
	return parts.length > 0 ? parts.join("\n") : undefined;
}

function documentTextFromRecord(record: Record<string, unknown>, parsed: unknown): string | undefined {
	const direct = stringField(record, ["content", "text", "markdown", "xml", "body"]);
	if (direct !== undefined) return direct;
	const nested = isRecord(parsed) ? parsed : {};
	const tiptap = asRecord(nested.tiptapJson) ?? asRecord(nested.tiptap_json);
	if (tiptap) return textFromTipTapNode(tiptap).join("\n").trim() || undefined;
	return undefined;
}

function extractDocumentBlocks(value: unknown, documentId: string): GraphDocumentBlock[] {
	const source = unwrapBlocksSource(value);
	if (!Array.isArray(source)) return [];
	return source
		.map((entry): GraphDocumentBlock | undefined => {
			if (typeof entry === "string") {
				return { blockId: entry, blockUri: documentBlockUri(documentId, entry) };
			}
			if (!isRecord(entry)) return undefined;
			const blockId = stringField(entry, ["id", "block_id", "blockId", "nodeId"]);
			const type = stringField(entry, ["type", "block_type", "blockType", "tag"]);
			const renderedNodeText = textFromTipTapNode(entry).join("\n").trim();
			const text = (stringField(entry, ["text", "content", "markdown"]) ?? renderedNodeText) || undefined;
			const attrs = asRecord(entry.attrs) ?? asRecord(entry.attributes);
			return {
				blockId,
				blockUri: blockId ? documentBlockUri(documentId, blockId) : undefined,
				type,
				text,
				attrs,
			};
		})
		.filter((entry): entry is GraphDocumentBlock => entry !== undefined);
}

function unwrapBlocksSource(value: unknown): unknown[] | undefined {
	if (Array.isArray(value)) return value;
	if (!isRecord(value)) return undefined;
	if (Array.isArray(value.blocks)) return value.blocks;
	if (Array.isArray(value.block_ids)) return value.block_ids;
	if (Array.isArray(value.blockIds)) return value.blockIds;
	const tree = asRecord(value.tree);
	if (tree && Array.isArray(tree.blocks)) return tree.blocks;
	return undefined;
}

function textFromTipTapNode(node: unknown): string[] {
	if (typeof node === "string") return [node];
	if (Array.isArray(node)) return node.flatMap(textFromTipTapNode);
	if (!isRecord(node)) return [];
	const own = typeof node.text === "string" ? [node.text] : [];
	const content = Array.isArray(node.content) ? node.content.flatMap(textFromTipTapNode) : [];
	return [...own, ...content];
}

function normalizeReadFormat(value: string | undefined): GraphDocumentReadFormat {
	return value === "xml" || value === "json" || value === "ids_only" ? value : "markdown";
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim()) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tryParseJson(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
		return undefined;
	}
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}
