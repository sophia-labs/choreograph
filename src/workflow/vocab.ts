/**
 * The `wf:` provenance vocabulary as code — the deterministic serialization
 * layer of "agents judge, code serializes".
 *
 * Source of truth: workflow-commons / wf-vocab.json (v0.2.0). Predicate names
 * and datatypes are load-bearing — the Garden frontend joins on them, and the
 * assertion suite rejects drift (notably `wf:run`, the v0.1 mistake; the correct
 * edge is `wf:partOfRun`). All run/agentRun subjects live in `urn:sophia:wf-run`
 * space, which travels verbatim through graph export/import.
 */

export const WF = "http://mnemosyne.dev/workflow#";
export const PROV = "http://www.w3.org/ns/prov#";
export const XSD = "http://www.w3.org/2001/XMLSchema#";
export const DCTERMS = "http://purl.org/dc/terms/";
export const PROTOCOL_VERSION = "0.2.0";

export const PREFIXES = [
	`PREFIX wf: <${WF}>`,
	`PREFIX prov: <${PROV}>`,
	`PREFIX xsd: <${XSD}>`,
	`PREFIX dcterms: <${DCTERMS}>`,
].join("\n");

/** Required predicates per class — used by the assertion self-check. */
export const REQUIRED_RUN_PREDICATES = [
	"wf:runId",
	"wf:workflowName",
	"wf:status",
	"wf:totalTokens",
	"wf:agentCount",
	"wf:durationMs",
	"prov:used",
	"prov:startedAtTime",
	"prov:endedAtTime",
] as const;

export const REQUIRED_AGENTRUN_PREDICATES = [
	"wf:partOfRun",
	"wf:label",
	"wf:phaseIndex",
	"wf:model",
	"wf:state",
	"wf:tokens",
	"wf:toolCalls",
	"wf:durationMs",
	"wf:queuedAt",
	"wf:startedAt",
	"wf:cached",
] as const;

// ─── URI minting ──────────────────────────────────────────────────────────

/**
 * Slug a node label for the agentRun URI suffix. Must mirror the frontend's
 * reverse-parse (wf-model.ts labelFromUri): collapse non `[A-Za-z0-9_-]` runs to
 * `-`, strip leading/trailing `-`, and PRESERVE case.
 */
export function slug(label: string): string {
	return label.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function mintRunUri(runId: string): string {
	return `urn:sophia:wf-run:${runId}`;
}

export function mintAgentRunUri(runId: string, label: string): string {
	return `urn:sophia:wf-run:${runId}:agent:${slug(label)}`;
}

export function mintWorkflowUri(workflowName: string): string {
	return `urn:sophia:wf:${workflowName}`;
}

/**
 * The cell's user-RDF authority named graph for a graph_id. This is the
 * UI-readable graph: Studio's Provenance/anatomy view and every `:projection:*`
 * materialization read from here, NOT from oxigraph's default (unnamed) graph.
 *
 * MUST mirror the deployed cell exactly — `garden/src-tauri/src/rdf_authority.rs`
 * `user_rdf_graph_iri` = `{graph_subject}:user:rdf` where graph_subject is
 * `urn:mnemosyne:local:graph:{graph_id}`. The cell's `sparql_update` executes
 * SPARQL VERBATIM against pyoxigraph (it does NOT auto-scope a bare `INSERT DATA`
 * to this graph — only the `rdf_load` N-triples path does), so a bare INSERT
 * lands in the default graph and is invisible to the FE. Provenance therefore
 * MUST emit a LITERAL `GRAPH <…:user:rdf>` clause. The validator
 * (`validate_sparql_update_authority`) admits this literal non-reserved IRI and
 * bans only `GRAPH ?`/`WITH ?` and `:projection:*` targets — see
 * `platform-next/gateway/src/ux_seed.rs` (`:ux:config`, the sibling reference).
 */
export function userRdfGraphIri(graphId: string): string {
	return `urn:mnemosyne:local:graph:${graphId}:user:rdf`;
}

// ─── Typed-literal serialization ────────────────────────────────────────────

export function iri(uri: string): string {
	return `<${uri}>`;
}

export function escapeLiteral(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t");
}

export function str(value: string): string {
	return `"${escapeLiteral(value)}"`;
}

export function xsdInt(n: number): string {
	return `"${Math.trunc(n)}"^^xsd:integer`;
}

/** xsd:long — required for wf:queuedAt / wf:startedAt (epoch ms). */
export function xsdLong(n: number): string {
	return `"${Math.trunc(n)}"^^xsd:long`;
}

export function xsdBool(b: boolean): string {
	return `"${b ? "true" : "false"}"^^xsd:boolean`;
}

export function xsdDateTime(epochMs: number): string {
	return `"${new Date(epochMs).toISOString()}"^^xsd:dateTime`;
}
