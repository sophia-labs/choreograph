/** The notebook tool family mounted as `notebooks_*` by sophia-mcp --sub. */
import { cellSourceVersion, exportIpynb, type NotebookCell, newNotebook } from "./model.js";
import type { NotebookWorkspace } from "./workspace.js";

const graph = { type: "string", minLength: 1 };
const id = { type: "string", minLength: 1, maxLength: 128 };
const text = { type: "string" };
const limit = { type: "integer", minimum: 1, maximum: 100 };
const readLimit = { type: "integer", minimum: 1, maximum: 50 };
type Schema = Record<string, unknown>;
function tool(name: string, description: string, required: string[], properties: Schema, scopes: string[]) {
	return {
		name,
		description,
		inputSchema: {
			type: "object",
			required,
			properties: { graphId: graph, ...properties },
			additionalProperties: false,
		},
		_meta: { "sophia.local.requiredScopes": scopes },
	};
}

/** The prefix belongs to sophia-mcp, so these descriptors carry bare names. */
export const notebookTools = [
	tool(
		"capabilities",
		"Show this notebook service's bound Garden graph, supported kernels and MCP size limits.",
		["graphId"],
		{},
		["documents.read"],
	),
	tool(
		"list",
		"Page through notebooks in this Garden workspace. The cursor pages all Garden documents, so a page may contain fewer notebooks than its limit.",
		["graphId"],
		{ cursor: { type: "string" }, limit },
		["documents.read"],
	),
	tool(
		"read",
		"Read stable cell IDs, exact shared source versions, kernel, and bounded output previews from one Garden notebook. Use cellId to inspect a large cell.",
		["graphId", "documentId"],
		{
			documentId: id,
			cellId: id,
			offset: { type: "integer", minimum: 0 },
			limit: readLimit,
			maxSourceChars: { type: "integer", minimum: 1, maximum: 262144 },
			includeOutputs: { type: "boolean" },
		},
		["documents.read"],
	),
	tool(
		"edit_cell",
		"Replace one shared cell's source only after matching its sourceVersion from read. CRDT concurrency may merge; inspect the returned source and merged flag.",
		["graphId", "documentId", "cellId", "source", "expectedSourceVersion"],
		{ documentId: id, cellId: id, source: text, expectedSourceVersion: id },
		["documents.write.crdt"],
	),
	tool(
		"insert_cell",
		"Insert a code, Markdown or raw cell after a stable cell ID (null appends). Requires the documentVersion from read; returns the new stable ID.",
		["graphId", "documentId", "afterCellId", "cellType", "source", "expectedDocumentVersion"],
		{
			documentId: id,
			afterCellId: { type: ["string", "null"] },
			cellType: { type: "string", enum: ["code", "markdown", "raw"] },
			source: text,
			expectedDocumentVersion: id,
		},
		["documents.write.crdt"],
	),
	tool(
		"delete_cell",
		"Delete one notebook-owned cell after matching documentVersion. Garden prose and the last notebook cell cannot be deleted here.",
		["graphId", "documentId", "cellId", "expectedDocumentVersion"],
		{ documentId: id, cellId: id, expectedDocumentVersion: id },
		["documents.write.crdt"],
	),
	tool(
		"create",
		"Create a blank notebook in Garden. Supply a fresh notebook- prefixed documentId. After an uncertain reply, use the same inputs with resumeOnly:true to inspect and finish without replay.",
		["graphId", "documentId", "title", "kernel"],
		{
			documentId: id,
			title: id,
			kernel: { type: "string", enum: ["python3", "julia", "ocaml", "cpp"] },
			resumeOnly: { type: "boolean" },
		},
		["documents.write.crdt", "workspace.write.crdt"],
	),
	tool(
		"import",
		"Import nbformat 4 JSON into a fresh Garden notebook document. Preserve IDs, metadata and outputs; limit 768 KiB. After an uncertain reply, use resumeOnly:true with the same inputs.",
		["graphId", "documentId", "title", "ipynb"],
		{ documentId: id, title: id, ipynb: { type: "string", maxLength: 786432 }, resumeOnly: { type: "boolean" } },
		["documents.write.crdt", "workspace.write.crdt"],
	),
	tool(
		"export",
		"Export the same shared Garden notebook as nbformat 4 JSON, retaining imported metadata and outputs. MCP output is limited to 1 MiB.",
		["graphId", "documentId"],
		{ documentId: id },
		["documents.read"],
	),
	tool(
		"runs",
		"Read the 25 most recent durable Choreograph execution intents and bounded result previews for this notebook.",
		["graphId", "documentId"],
		{ documentId: id },
		["documents.read", "wires.read"],
	),
	tool(
		"execute",
		"Execute one code cell in a hosted, isolated Choreograph kernel. Supply a stable executionId; retry reads its durable receipt without replay.",
		["graphId", "documentId", "cellId", "executionId"],
		{ documentId: id, cellId: id, executionId: id },
		["notebooks.execute"],
	),
] as const;

function argsFor(workspace: NotebookWorkspace, name: string, value: unknown): Record<string, unknown> {
	const descriptor = notebookTools.find((tool) => tool.name === name);
	if (!descriptor) throw new Error(`Unknown notebook tool: ${name}`);
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Notebook tool arguments must be an object");
	const args = value as Record<string, unknown>;
	const properties = descriptor.inputSchema.properties as Record<string, Schema>;
	for (const key of Object.keys(args))
		if (!Object.hasOwn(properties, key)) throw new Error(`Unknown notebook argument: ${key}`);
	for (const key of descriptor.inputSchema.required)
		if (!(key in args)) throw new Error(`Missing notebook argument: ${key}`);
	if (args.graphId !== workspace.options.garden.graphId)
		throw new Error("Notebook tool graphId differs from the service's bound Garden graph");
	for (const [key, rule] of Object.entries(properties)) {
		if (!(key in args)) continue;
		const kind = rule.type;
		const accepted = Array.isArray(kind) ? kind : [kind];
		const value = args[key];
		if (
			!accepted.some((type) =>
				type === "null" ? value === null : type === "integer" ? Number.isInteger(value) : typeof value === type,
			)
		)
			throw new Error(`Invalid notebook argument: ${key}`);
		if (
			typeof value === "string" &&
			((typeof rule.minLength === "number" && value.length < rule.minLength) ||
				(typeof rule.maxLength === "number" && value.length > rule.maxLength))
		)
			throw new Error(`Notebook argument ${key} exceeds its length bound`);
		if (
			typeof value === "number" &&
			((typeof rule.minimum === "number" && value < rule.minimum) ||
				(typeof rule.maximum === "number" && value > rule.maximum))
		)
			throw new Error(`Notebook argument ${key} exceeds its numeric bound`);
		if (Array.isArray(rule.enum) && !rule.enum.includes(value)) throw new Error(`Invalid notebook argument: ${key}`);
	}
	return args;
}
function required(args: Record<string, unknown>, name: string): string {
	return args[name] as string;
}
function outputPreview(output: unknown, maxChars = 4096): Record<string, unknown> {
	if (!output || typeof output !== "object" || Array.isArray(output)) return { type: "unknown" };
	const item = output as Record<string, unknown>;
	const data = item.data && typeof item.data === "object" ? (item.data as Record<string, unknown>) : {};
	const raw = item.text ?? data["text/plain"] ?? item.evalue ?? "";
	const value = Array.isArray(raw) ? raw.join("") : typeof raw === "string" ? raw : "";
	return {
		type: String(item.output_type ?? item.kind ?? "unknown"),
		mimeTypes: Object.keys(data),
		text: value.slice(0, maxChars),
		truncated: value.length > maxChars,
	};
}
function cellView(
	cell: NotebookCell,
	header: Record<string, unknown>,
	maxSourceChars: number,
	includeOutputs: boolean,
	singleCell: boolean,
) {
	const fields = cell.fields;
	const meta =
		fields.metadata && typeof fields.metadata === "object" ? (fields.metadata as Record<string, unknown>) : {};
	const sophia = meta.sophia && typeof meta.sophia === "object" ? (meta.sophia as Record<string, unknown>) : {};
	const version = cellSourceVersion(cell, header);
	const outputs = Array.isArray(fields.outputs) ? fields.outputs : [];
	return {
		id: cell.id,
		type: cell.kind,
		language: cell.language,
		origin: cell.origin ?? "notebook",
		source: cell.source.slice(0, maxSourceChars),
		sourceTruncated: cell.source.length > maxSourceChars,
		sourceVersion: version,
		executionCount: fields.execution_count ?? null,
		outputCurrent: typeof sophia.sourceVersion === "string" ? sophia.sourceVersion === version : null,
		metadataKeys: Object.keys(meta),
		outputCount: outputs.length,
		...(includeOutputs
			? {
					outputs: outputs
						.slice(0, singleCell ? 20 : 4)
						.map((output) => outputPreview(output, singleCell ? 4096 : 1024)),
					outputsTruncated: outputs.length > (singleCell ? 20 : 4),
				}
			: {}),
	};
}

export async function callNotebookTool(workspace: NotebookWorkspace, name: string, value: unknown): Promise<unknown> {
	const a = argsFor(workspace, name, value),
		garden = workspace.options.garden;
	const graphId = garden.graphId;
	switch (name) {
		case "capabilities":
			return {
				graphId,
				format: "sophia.notebook.v1",
				kernels: workspace.supportedNotebookKernels(),
				limits: { importBytes: 768 * 1024, exportBytes: 1024 * 1024, sourceBytes: 256 * 1024 },
			};
		case "list":
			return {
				graphId,
				...(await garden.listNotebooks(a.cursor as string | undefined, a.limit as number | undefined)),
			};
		case "read": {
			const documentId = required(a, "documentId"),
				{ notebook, documentVersion } = await garden.readNotebook(documentId);
			const selected = a.cellId ? notebook.cells.filter((cell) => cell.id === a.cellId) : notebook.cells;
			if (a.cellId && !selected.length) throw new Error("Unknown notebook cell");
			const offset = a.cellId ? 0 : ((a.offset as number) ?? 0);
			const pageSize = a.cellId ? 1 : ((a.limit as number) ?? 20);
			const cells = selected.slice(offset, offset + pageSize);
			const maxSourceChars = (a.maxSourceChars as number) ?? (a.cellId ? 262144 : 16384);
			const meta =
				notebook.header.metadata && typeof notebook.header.metadata === "object"
					? (notebook.header.metadata as Record<string, unknown>)
					: {};
			let remainingSourceChars = 262144;
			return {
				graphId,
				documentId,
				documentVersion,
				nbformat: notebook.header.nbformat,
				nbformatMinor: notebook.header.nbformat_minor,
				kernelSpec: meta.kernelspec ?? null,
				cellCount: notebook.cells.length,
				cells: cells.map((cell) => {
					const budget = Math.max(0, Math.min(maxSourceChars, remainingSourceChars));
					remainingSourceChars -= Math.min(cell.source.length, budget);
					return cellView(cell, notebook.header, budget, a.includeOutputs !== false, Boolean(a.cellId));
				}),
				nextOffset: offset + cells.length < selected.length ? offset + cells.length : null,
			};
		}
		case "edit_cell":
			return garden.editNotebookCell(
				required(a, "documentId"),
				required(a, "cellId"),
				required(a, "source"),
				required(a, "expectedSourceVersion"),
			);
		case "insert_cell":
			return garden.insertNotebookCell(
				required(a, "documentId"),
				a.afterCellId as string | null,
				a.cellType as NotebookCell["kind"],
				required(a, "source"),
				required(a, "expectedDocumentVersion"),
			);
		case "delete_cell":
			return garden.deleteNotebookCell(
				required(a, "documentId"),
				required(a, "cellId"),
				required(a, "expectedDocumentVersion"),
			);
		case "create": {
			const documentId = required(a, "documentId"),
				title = required(a, "title");
			const contents = exportIpynb(newNotebook(required(a, "kernel"), `cell-${documentId.slice(-32)}`));
			return a.resumeOnly === true
				? garden.reconcileNotebookImport(documentId, title, contents)
				: garden.importNotebook(documentId, title, contents);
		}
		case "import":
			return a.resumeOnly === true
				? garden.reconcileNotebookImport(required(a, "documentId"), required(a, "title"), required(a, "ipynb"))
				: garden.importNotebook(required(a, "documentId"), required(a, "title"), required(a, "ipynb"));
		case "export":
			return {
				graphId,
				documentId: required(a, "documentId"),
				ipynb: await garden.exportNotebook(required(a, "documentId")),
			};
		case "runs":
			return {
				graphId,
				documentId: required(a, "documentId"),
				runs: await workspace.listSharedNotebookRuns(required(a, "documentId")),
			};
		case "execute": {
			const result = await workspace.executeSharedNotebookCell(
				required(a, "documentId"),
				required(a, "cellId"),
				required(a, "executionId"),
			);
			return {
				graphId,
				documentId: result.documentId,
				cellId: result.cellId,
				executionId: result.id,
				kernel: result.kernel,
				sourceVersion: result.sourceVersion,
				currentOutput: result.currentOutput,
				status: result.record.status,
				executionCount: result.record.executionCount,
				durationMs: result.record.durationMs,
				outputs: result.record.outputs.slice(0, 20).map((output) => outputPreview(output)),
				outputsTruncated: result.record.outputTruncated === true || result.record.outputs.length > 20,
			};
		}
		default:
			throw new Error(`Unknown notebook tool: ${name}`);
	}
}
