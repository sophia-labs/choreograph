/**
 * An in-process, Garden-shaped MCP cell for route tests: a real MCP server
 * (the SDK's Streamable HTTP transport) over a real document map. It answers
 * the way gardend does: an absent document is a tool error whose text is
 * `document not found: <id>`, and tools/list carries
 * `_meta["sophia.local.requiredScopes"]`.
 */

import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const TOOLS: ReadonlyArray<{ name: string; scopes: string[] }> = [
	{ name: "search_documents", scopes: ["documents.read"] },
	{ name: "read_document", scopes: ["documents.read"] },
	{ name: "write_document", scopes: ["documents.write"] },
	{ name: "sparql_query", scopes: ["rdf.query"] },
	{ name: "sparql_update", scopes: ["rdf.update"] },
];

/** A scope set a viewer may use: every scope a read (`*.read`, `rdf.query`). */
function readOnlyScopes(scopes: readonly string[]): boolean {
	return scopes.length > 0 && scopes.every((scope) => scope.endsWith(".read") || scope === "rdf.query");
}

/** The tools this cell serves by default, by name. */
export const HARNESS_CELL_TOOLS: readonly string[] = Object.freeze(TOOLS.map((tool) => tool.name));

export class GardenDocumentCell {
	readonly documents = new Map<string, string>();
	/**
	 * The tools the cell serves, with their required scopes (and, when given, the input schema tools/list carries, as
	 * garden serves its catalog's verbatim), when a test needs others; `undefined` serves the five.
	 */
	tools:
		| ReadonlyArray<{
				readonly name: string;
				readonly scopes: readonly string[];
				readonly inputSchema?: Readonly<Record<string, unknown>>;
		  }>
		| undefined;
	/** Page tools/list this many at a time (garden pages with `nextCursor`); `undefined` answers one page. */
	pageSize: number | undefined;
	/**
	 * The person's role as the cell's signed lease would carry it. A viewer is served only tools whose scopes are all
	 * reads, and any other call is refused, as garden's `mcp_tool_visible_for_role` / `authorize_mcp_role` do.
	 */
	role: "viewer" | undefined;
	/** Calls the cell refused for the role. */
	readonly refused: Array<{ tool: string; args: Record<string, unknown> }> = [];
	readonly calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
	readonly bearers: string[] = [];
	private http?: HttpServer;
	url = "";

	async start(): Promise<void> {
		this.http = createServer((request, response) => {
			this.bearers.push(String(request.headers.authorization ?? ""));
			const server = this.mcpServer();
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			response.on("close", () => {
				void transport.close();
				void server.close();
			});
			void server
				.connect(transport)
				.then(() => transport.handleRequest(request, response))
				.catch((error: unknown) => {
					response.statusCode = 500;
					response.end(String(error));
				});
		});
		await new Promise<void>((resolve) => this.http!.listen(0, "127.0.0.1", resolve));
		const address = this.http.address() as AddressInfo;
		this.url = `http://127.0.0.1:${address.port}/mcp`;
	}

	async stop(): Promise<void> {
		await new Promise<void>((resolve) => {
			if (!this.http) return resolve();
			this.http.closeAllConnections?.();
			this.http.close(() => resolve());
		});
	}

	private mcpServer(): Server {
		const server = new Server({ name: "garden-document-cell", version: "1.0.0" }, { capabilities: { tools: {} } });
		server.setRequestHandler(ListToolsRequestSchema, async (request) => {
			const served = (this.tools ?? TOOLS).filter((tool) => this.role !== "viewer" || readOnlyScopes(tool.scopes));
			const all = served.map((tool) => ({
				name: tool.name,
				description: tool.name,
				inputSchema: ("inputSchema" in tool && tool.inputSchema
					? tool.inputSchema
					: { type: "object", properties: {} }) as { type: "object"; [key: string]: unknown },
				_meta: { "sophia.local.requiredScopes": tool.scopes },
			}));
			if (this.pageSize === undefined) return { tools: all };
			const start = Number(request.params?.cursor ?? 0);
			const next = start + this.pageSize;
			return { tools: all.slice(start, next), ...(next < all.length ? { nextCursor: String(next) } : {}) };
		});
		server.setRequestHandler(CallToolRequestSchema, async (request) => {
			const args = (request.params.arguments ?? {}) as Record<string, unknown>;
			const tool = request.params.name;
			this.calls.push({ tool, args });
			if (this.role === "viewer") {
				const scopes = (this.tools ?? TOOLS).find((candidate) => candidate.name === tool)?.scopes ?? [];
				if (!readOnlyScopes(scopes)) {
					this.refused.push({ tool, args });
					return {
						isError: true,
						content: [{ type: "text", text: `permission denied: ${tool} requires editor` }],
					};
				}
			}
			const documentId = String(args.document_id ?? args.documentId ?? "");
			if (tool === "read_document") {
				const content = this.documents.get(documentId);
				if (content === undefined) {
					return { isError: true, content: [{ type: "text", text: `document not found: ${documentId}` }] };
				}
				return {
					content: [
						{
							type: "text",
							// Garden's reply (`document_mcp_service.rs`): the page fields it always sends, so the host's strict
							// paged reader meets the real shape (exam 2, weak test: this used to omit them).
							text: JSON.stringify(
								args.format === "ids_only"
									? { document_id: documentId, format: "ids_only", block_ids: [], block_count: 0 }
									: gardenReadPage(String(args.graph_id ?? "g1"), documentId, content, args),
							),
						},
					],
				};
			}
			if (tool === "write_document") {
				this.documents.set(documentId, String(args.content ?? ""));
				return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
			}
			if (tool === "sparql_query") {
				return {
					content: [{ type: "text", text: JSON.stringify({ resultType: "solutions", variables: [], rows: [] }) }],
				};
			}
			if (tool === "search_documents") {
				return { content: [{ type: "text", text: JSON.stringify({ results: [] }) }] };
			}
			return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
		});
		return server;
	}
}

/** One page of garden's `read_document` (offset and maxChars in Unicode scalar values, as the cell counts them). */
function gardenReadPage(graphId: string, documentId: string, content: string, args: Record<string, unknown>) {
	const chars = [...content];
	const offset = Math.min(Number(args.offset ?? 0) || 0, chars.length);
	const maxChars = Math.min(Math.max(Number(args.maxChars ?? args.max_chars ?? 65_536) || 65_536, 1), 262_144);
	const visible = chars.slice(offset, offset + maxChars).join("");
	const next = offset + [...visible].length;
	const complete = next >= chars.length;
	return {
		graph_id: graphId,
		document_id: documentId,
		format: String(args.format ?? "markdown"),
		content: visible,
		fragment: offset > 0 || !complete,
		offset,
		nextOffset: complete ? null : next,
		complete,
		totalChars: chars.length,
		maxChars,
		revision: 1,
	};
}
