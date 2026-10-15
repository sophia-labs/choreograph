export const PERSONAL_PRIME_GRAPH_READ_TOOLS = [
	"quick_orient",
	"context_bundle",
	"list_documents",
	"read_document",
	"read_blocks",
	"query_blocks",
	"get_block",
	"get_document_history",
	"search_documents",
	"search_blocks",
	"sparql_query",
	"get_workspace",
	"get_wires",
	"traverse_wires",
	"list_wire_predicates",
	"get_important_blocks",
	"get_block_values",
	"get_values",
	"document_digest",
	"music",
	"recall",
] as const;

/**
 * A personal Prime definition is immutable authority, not a best-effort tool
 * preference. Prove its complete graph-scoped read surface exists before the
 * seeder writes the manifest, grant, or definition that pins it.
 *
 * Gateway control-plane tools (notably `list_graphs`) are intentionally not in
 * this list: a Choreograph capability adapter is bound to one exact graph and
 * receives only that cell's MCP surface.
 */
export function assertPersonalPrimeGraphReadToolsAvailable(availableToolNames: Iterable<string>): void {
	const available = new Set(availableToolNames);
	const missing = PERSONAL_PRIME_GRAPH_READ_TOOLS.filter((name) => !available.has(name));
	if (missing.length > 0) {
		throw new Error(`personal Prime graph tool surface is unavailable; missing: ${missing.join(", ")}`);
	}
}
