/**
 * Destructive-op classification — the conservative gate the authority backend
 * consults before deciding whether a tool call needs a driver's permission.
 *
 * CA-1 / S3 — the default-gate-unknown allowlist.
 *
 * The design rule is FAIL-CLOSED: a tool the classifier has never seen is
 * treated as destructive ({@link isDestructive} returns `true`), so it is gated
 * behind a permission request rather than waved through. Only an explicit
 * allowlist of read-shaped tools (and tools whose names match a read-shaped
 * prefix) is classed as non-destructive. This is the same posture as the gate's
 * write-flag enforcement in ../mnemosyne.ts (the `writes` capability defaults
 * conservative), lifted to the per-tool granularity CA-1 needs: an agent that
 * mints a brand-new tool name does not get a silent write.
 *
 * Pure + substrate-blind: no I/O, no CRDT, no Pi import — a total `string →
 * boolean` fold over a literal allowlist.
 */

/**
 * Tool names known to be non-destructive (reads / introspection). Anything NOT
 * in this set — and not matching a {@link NON_DESTRUCTIVE_PREFIXES} prefix — is
 * gated. Keep this list exact and small; err toward gating.
 */
export const NON_DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set<string>([
	"read_document",
	"read_blocks",
	"get_block",
	"get_values",
	"get_workspace",
	"list_documents",
	"list_graphs",
	"search_documents",
	"search_blocks",
	"query_blocks",
	"sparql_query",
	"document_digest",
	"get_wires",
	"traverse_wires",
	"list_wire_predicates",
	"recall",
	"semantic_search",
	"surface",
	"quick_orient",
	"context_bundle",
	"read_a11y_tree",
	"screenshot",
]);

/**
 * Name prefixes whose tools are non-destructive by convention (read-shaped
 * verbs). A tool like `get_foo` or `list_bar` is treated as a read. Mutating
 * verbs (`write_`, `create_`, `delete_`, `update_`, `edit_`, `insert_`, …) are
 * deliberately ABSENT — they fall through to the default-gate.
 */
export const NON_DESTRUCTIVE_PREFIXES: readonly string[] = ["read_", "get_", "list_", "search_", "query_"];

/**
 * Classify a tool call as destructive (needs a driver's permission) or not.
 *
 * FAIL-CLOSED: an unknown tool name → `true` (gate it). A name is non-destructive
 * only if it is in {@link NON_DESTRUCTIVE_TOOLS} or begins with one of
 * {@link NON_DESTRUCTIVE_PREFIXES}. Pure.
 */
export function isDestructive(tool: string): boolean {
	if (NON_DESTRUCTIVE_TOOLS.has(tool)) return false;
	for (const prefix of NON_DESTRUCTIVE_PREFIXES) {
		if (tool.startsWith(prefix)) return false;
	}
	// Default-gate: unknown / write-shaped tools are destructive.
	return true;
}
