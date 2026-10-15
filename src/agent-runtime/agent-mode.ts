/**
 * Choreograph modes v1 — the pure contract.
 *
 * A mode is a graph object in the agent's own graph: an exact subset of the
 * graph MCP tool surface plus permissions (a read/write ceiling, an optional
 * graph-scope fence and approval-required tools). A session running in a mode
 * sees and can call only those tools. Modes ATTENUATE the agent's existing
 * grant; they can never widen it.
 *
 * Data contract (shared with the Shrubbery Modes surface, which writes exactly
 * this into `urn:mnemosyne:local:graph:{graphId}:user:rdf`):
 *
 *   <urn:sophia:mode:{slug}> a agt:Mode ; rdfs:label "…" ;
 *       agt:access "read"|"write" ;            # exactly one; anything else ⇒ read
 *       agt:allowsTool "exact_tool_name" ;     # 0..n
 *       agt:graphScope <urn:graph:{graphId}> ; # 0..n; absent ⇒ no extra fence
 *       agt:requiresApproval "tool" ;          # 0..n
 *       agt:imageTransform "…" .               # cosmetic, ignored here
 *   <urn:sophia:agent:{agentId}> agt:defaultMode <m> ; agt:mayUseMode <m> .
 *
 * This module has no I/O. Readers live in `workflow/agent-mode-reader.ts`; the
 * enforcing gate lives in `capabilities/grant-gate.ts`.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@sophia-labs/canonical-json";
import { mintAgentUri } from "../agent-subject/agent-ontology.js";
import type { HostArgumentPolicyName } from "../capabilities/argument-policy.js";

export const AGT_NS = "http://mnemosyne.dev/agent#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
const AGT = {
	Mode: `${AGT_NS}Mode`,
	access: `${AGT_NS}access`,
	allowsTool: `${AGT_NS}allowsTool`,
	graphScope: `${AGT_NS}graphScope`,
	requiresApproval: `${AGT_NS}requiresApproval`,
	defaultMode: `${AGT_NS}defaultMode`,
	mayUseMode: `${AGT_NS}mayUseMode`,
} as const;

export const MODE_IRI = /^urn:sophia:mode:[a-z0-9][a-z0-9-]{0,63}$/;
const GRAPH_SCOPE_IRI = /^urn:graph:([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** Scope names that are pure reads in gardend's `_meta["sophia.local.requiredScopes"]`. */
const READ_ONLY_SCOPES = new Set(["rdf.query", "rdf.dump"]);
export const REQUIRED_SCOPES_META_KEY = "sophia.local.requiredScopes";

export type AgentModeAccess = "read" | "write";
export type ToolEffectClass = "read" | "write";

/** A parsed, normalized `agt:Mode`. Arrays are sorted and unique. */
export interface AgentModeV1 {
	readonly iri: string;
	readonly label: string;
	readonly access: AgentModeAccess;
	readonly allowsTool: readonly string[];
	/** `urn:graph:{graphId}` IRIs. Empty ⇒ no extra fence beyond today's. */
	readonly graphScope: readonly string[];
	readonly requiresApproval: readonly string[];
}

/** The digest-bound reference a session carries on its ontology binding. */
export interface AgentModeRefV1 {
	readonly iri: string;
	/** sha256 hex of the canonical mode (see `agentModeDigest`). */
	readonly digest: string;
}

/** The agent's mode configuration as read from its graph. */
export interface AgentModeCatalogV1 {
	readonly agentIri: string;
	readonly defaultMode?: string;
	readonly mayUseModes: readonly string[];
	/** Every referenced IRI that is typed `agt:Mode`, keyed by IRI. */
	readonly modes: ReadonlyMap<string, AgentModeV1>;
}

/** What the host gate enforces for the graph MCP capability. */
export interface AgentModeFenceV1 {
	readonly mode: AgentModeV1;
	readonly digest: string;
	/**
	 * The graph the capability backend is bound to. When the mode carries a
	 * graph scope and this graph lies outside it, every call is denied.
	 */
	readonly boundGraphId?: string;
	/**
	 * Host-owned built-in modes only (never read from a graph): tools the host
	 * itself classifies as read. Used when the live cell omits `requiredScopes`
	 * for a tool; a live scope list, when present, still decides.
	 */
	readonly trustedReadTools?: readonly string[];
	/**
	 * Host-owned built-in modes only: a named argument policy the gate applies to every call
	 * (`src/capabilities/argument-policy.ts`). Never read from a graph.
	 */
	readonly argumentPolicy?: HostArgumentPolicyName;
}

export type AgentModeErrorCode =
	| "mode_unknown"
	| "mode_not_permitted"
	| "mode_required"
	| "mode_invalid"
	| "mode_unavailable"
	| "mode_current_mismatch";

export class AgentModeError extends Error {
	constructor(
		readonly code: AgentModeErrorCode,
		message: string,
		readonly details?: unknown,
	) {
		super(`${code}: ${message}`);
		this.name = "AgentModeError";
	}
}

/** Structured denial for a tool the mode marks as requiring human approval. */
export class AgentModeApprovalRequiredError extends Error {
	readonly code = "approval_required";
	constructor(
		readonly tool: string,
		readonly modeIri: string,
	) {
		super(
			`approval_required: tool '${tool}' requires human approval in mode <${modeIri}>; ` +
				"Choreograph modes v1 has no approval queue for tool calls, so the call is denied",
		);
		this.name = "AgentModeApprovalRequiredError";
	}
}

/** Structured denial for anything else the mode fence refuses. */
export class AgentModeDeniedError extends Error {
	readonly code = "mode_denied";
	constructor(
		readonly tool: string,
		readonly modeIri: string,
		readonly reason: "tool_outside_mode" | "write_in_read_mode" | "graph_outside_scope" | "argument_outside_mode",
		detail: string,
	) {
		super(`mode_denied(${reason}): tool '${tool}' in mode <${modeIri}>: ${detail}`);
		this.name = "AgentModeDeniedError";
	}
}

export function isModeIri(value: unknown): value is string {
	return typeof value === "string" && MODE_IRI.test(value);
}

/** `urn:graph:{graphId}` → graphId, or undefined when not a graph-scope IRI. */
export function graphIdFromScopeIri(value: string): string | undefined {
	return GRAPH_SCOPE_IRI.exec(value)?.[1];
}

export function graphScopeIri(graphId: string): string {
	return `urn:graph:${graphId}`;
}

/**
 * Effect class of a graph MCP tool from its `requiredScopes`: read iff every
 * scope is `*.read`, `rdf.query` or `rdf.dump`. No scopes (or unknown) ⇒ write.
 */
export function toolEffectClass(requiredScopes: readonly string[] | undefined): ToolEffectClass {
	if (!requiredScopes || requiredScopes.length === 0) return "write";
	return requiredScopes.every((scope) => scope.endsWith(".read") || READ_ONLY_SCOPES.has(scope)) ? "read" : "write";
}

/** Read `_meta["sophia.local.requiredScopes"]` from an MCP tools/list entry. */
export function requiredScopesFromToolMeta(meta: unknown): readonly string[] | undefined {
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
	const scopes = (meta as Record<string, unknown>)[REQUIRED_SCOPES_META_KEY];
	if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) return undefined;
	return scopes as string[];
}

/** Canonical digest: sha256 hex of canonicalJson of the normalized fields. */
export function agentModeDigest(mode: AgentModeV1): string {
	const canonical = {
		iri: mode.iri,
		label: mode.label,
		access: mode.access,
		allowsTool: sortedUnique(mode.allowsTool),
		graphScope: sortedUnique(mode.graphScope),
		requiresApproval: sortedUnique(mode.requiresApproval),
	};
	return createHash("sha256").update(canonicalJson(canonical)).digest("hex");
}

export function agentModeRef(mode: AgentModeV1): AgentModeRefV1 {
	return { iri: mode.iri, digest: agentModeDigest(mode) };
}

export function validateAgentModeRef(value: unknown): asserts value is AgentModeRefV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new AgentModeError("mode_invalid", "mode ref must be an object");
	}
	const ref = value as Record<string, unknown>;
	const extra = Object.keys(ref).filter((key) => key !== "iri" && key !== "digest");
	if (extra.length > 0) throw new AgentModeError("mode_invalid", "mode ref has unexpected fields", { extra });
	if (!isModeIri(ref.iri)) throw new AgentModeError("mode_invalid", "mode ref iri is not a mode IRI");
	if (typeof ref.digest !== "string" || !SHA256_HEX.test(ref.digest)) {
		throw new AgentModeError("mode_invalid", "mode ref digest must be sha256 hex");
	}
}

/**
 * One SELECT returning every agent→mode edge and every relevant property of
 * each referenced mode in the graph's user RDF partition, where the editor
 * writes them. Other named graphs cannot inject assignments or definitions.
 */
export function buildAgentModeCatalogQuery(agentId: string, graphId: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(graphId)) {
		throw new AgentModeError("mode_invalid", "mode catalog graph id is invalid");
	}
	const agentIri = mintAgentUri(agentId);
	const userGraph = `urn:mnemosyne:local:graph:${graphId}:user:rdf`;
	return `SELECT ?rel ?mode ?p ?o WHERE {
  GRAPH <${userGraph}> {
    <${agentIri}> ?rel ?mode .
    FILTER (?rel IN (<${AGT.defaultMode}>, <${AGT.mayUseMode}>))
    OPTIONAL {
      ?mode ?p ?o .
      FILTER (?p IN (<${RDF_TYPE}>, <${RDFS_LABEL}>, <${AGT.access}>, <${AGT.allowsTool}>, <${AGT.graphScope}>, <${AGT.requiresApproval}>))
    }
  }
}
LIMIT 5000`;
}

/**
 * Parse a gardend `sparql_query` result (possibly MCP-wrapped) for
 * `buildAgentModeCatalogQuery`. Anything that is not a recognizable, complete
 * solutions result throws — mode resolution fails closed.
 */
export function parseAgentModeCatalog(agentId: string, result: unknown): AgentModeCatalogV1 {
	const agentIri = mintAgentUri(agentId);
	const rows = sparqlSolutionRows(result);
	if (rows.length >= 5000) {
		throw new AgentModeError("mode_unavailable", "mode catalog reached its row limit");
	}
	const defaults = new Set<string>();
	const mayUse = new Set<string>();
	const props = new Map<string, Map<string, Set<string>>>();
	for (const row of rows) {
		const rel = iriTerm(row.rel);
		const mode = iriTerm(row.mode);
		if (!rel || !mode) throw new AgentModeError("mode_invalid", "agent mode edge is not an IRI pair");
		if (rel === AGT.defaultMode) defaults.add(mode);
		else if (rel === AGT.mayUseMode) mayUse.add(mode);
		else continue;
		if (row.p === undefined || row.o === undefined) continue;
		const predicate = iriTerm(row.p);
		if (!predicate) continue;
		const byPredicate = props.get(mode) ?? new Map<string, Set<string>>();
		props.set(mode, byPredicate);
		const values = byPredicate.get(predicate) ?? new Set<string>();
		byPredicate.set(predicate, values);
		const object = predicate === RDF_TYPE || predicate === AGT.graphScope ? iriTerm(row.o) : literalTerm(row.o);
		if (object === undefined) {
			throw new AgentModeError("mode_invalid", `mode <${mode}> has a malformed ${predicate} value`);
		}
		values.add(object);
	}
	if (defaults.size > 1) {
		throw new AgentModeError("mode_invalid", `agent <${agentIri}> declares more than one agt:defaultMode`, {
			defaults: [...defaults].sort(),
		});
	}
	const modes = new Map<string, AgentModeV1>();
	for (const [iri, byPredicate] of props) {
		if (!byPredicate.get(RDF_TYPE)?.has(AGT.Mode)) continue;
		modes.set(iri, normalizeMode(iri, byPredicate));
	}
	const [defaultMode] = [...defaults];
	return {
		agentIri,
		...(defaultMode === undefined ? {} : { defaultMode }),
		mayUseModes: [...mayUse].sort(),
		modes,
	};
}

function normalizeMode(iri: string, byPredicate: ReadonlyMap<string, ReadonlySet<string>>): AgentModeV1 {
	if (!isModeIri(iri)) throw new AgentModeError("mode_invalid", `mode IRI <${iri}> is not urn:sophia:mode:{slug}`);
	const labels = [...(byPredicate.get(RDFS_LABEL) ?? [])].sort();
	const accessValues = [...(byPredicate.get(AGT.access) ?? [])];
	// Exactly one "write" is the only way to get write; missing, duplicate or
	// unknown values fall to the read ceiling (fail closed).
	const access: AgentModeAccess = accessValues.length === 1 && accessValues[0] === "write" ? "write" : "read";
	const allowsTool = sortedUnique([...(byPredicate.get(AGT.allowsTool) ?? [])]);
	const requiresApproval = sortedUnique([...(byPredicate.get(AGT.requiresApproval) ?? [])]);
	for (const tool of [...allowsTool, ...requiresApproval]) {
		if (tool === "*" || !TOOL_NAME.test(tool)) {
			throw new AgentModeError("mode_invalid", `mode <${iri}> names a non-exact tool ${JSON.stringify(tool)}`);
		}
	}
	if (requiresApproval.some((tool) => !allowsTool.includes(tool))) {
		throw new AgentModeError("mode_invalid", `mode <${iri}> requires approval for a tool it does not allow`);
	}
	const graphScope = sortedUnique([...(byPredicate.get(AGT.graphScope) ?? [])]);
	for (const scope of graphScope) {
		if (!graphIdFromScopeIri(scope)) {
			throw new AgentModeError("mode_invalid", `mode <${iri}> has a graph scope that is not urn:graph:{graphId}`);
		}
	}
	return { iri, label: labels[0] ?? "", access, allowsTool, graphScope, requiresApproval };
}

/**
 * Select the session's mode. An explicit per-session choice must be the
 * default or one of `agt:mayUseMode`; otherwise `agt:defaultMode`. An agent
 * with no mode configuration keeps today's behavior (undefined). An agent that
 * declares usable modes but no default must name one explicitly.
 */
export function resolveSessionMode(catalog: AgentModeCatalogV1, requestedModeIri?: string): AgentModeV1 | undefined {
	if (requestedModeIri !== undefined) {
		if (!isModeIri(requestedModeIri)) {
			throw new AgentModeError(
				"mode_invalid",
				`requested mode ${JSON.stringify(requestedModeIri)} is not a mode IRI`,
			);
		}
		const permitted = requestedModeIri === catalog.defaultMode || catalog.mayUseModes.includes(requestedModeIri);
		if (!permitted) {
			throw new AgentModeError(
				"mode_not_permitted",
				`agent <${catalog.agentIri}> may not use mode <${requestedModeIri}>`,
				{ mayUseModes: catalog.mayUseModes, defaultMode: catalog.defaultMode ?? null },
			);
		}
		return requireMode(catalog, requestedModeIri);
	}
	if (catalog.defaultMode !== undefined) return requireMode(catalog, catalog.defaultMode);
	if (catalog.mayUseModes.length > 0) {
		throw new AgentModeError(
			"mode_required",
			`agent <${catalog.agentIri}> declares usable modes but no agt:defaultMode; select one per session`,
			{ mayUseModes: catalog.mayUseModes },
		);
	}
	return undefined;
}

function requireMode(catalog: AgentModeCatalogV1, iri: string): AgentModeV1 {
	const mode = catalog.modes.get(iri);
	if (!mode) throw new AgentModeError("mode_unknown", `mode <${iri}> is not an agt:Mode in the agent's graph`);
	return mode;
}

/**
 * Attenuation only: granted ∩ mode.allowsTool, minus every tool whose effect
 * class is not provably read when the mode's ceiling is read. Unknown effect
 * class counts as write. Order of the granted list is preserved.
 */
export function attenuateToolsForMode(
	grantedTools: readonly string[],
	mode: AgentModeV1,
	effectClassOf: (tool: string) => ToolEffectClass | undefined,
): string[] {
	const allowed = new Set(mode.allowsTool);
	return grantedTools.filter(
		(tool) => allowed.has(tool) && (mode.access === "write" || effectClassOf(tool) === "read"),
	);
}

/** True when the mode's graph scope admits `graphId` (no scope ⇒ admits all). */
export function modeAdmitsGraph(mode: AgentModeV1, graphId: string): boolean {
	if (mode.graphScope.length === 0) return true;
	return mode.graphScope.includes(graphScopeIri(graphId));
}

/** `<session> agt:ranInMode <mode>` for callers that write the audit directly. */
export function serializeRanInMode(sessionIri: string, modeIri: string): string {
	if (!isModeIri(modeIri)) throw new AgentModeError("mode_invalid", "ranInMode object must be a mode IRI");
	return `PREFIX agt: <${AGT_NS}>\nINSERT DATA { <${sessionIri}> agt:ranInMode <${modeIri}> . }`;
}

function sortedUnique(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

function sparqlSolutionRows(value: unknown): Record<string, unknown>[] {
	const unwrapped = unwrapStructured(value);
	if (!isRecord(unwrapped) || !Array.isArray(unwrapped.rows)) {
		throw new AgentModeError("mode_unavailable", "sparql_query did not return a solutions result");
	}
	const resultType = unwrapped.resultType ?? unwrapped.result_type;
	if (resultType !== undefined && resultType !== "solutions") {
		throw new AgentModeError("mode_unavailable", `sparql_query returned ${String(resultType)}, not solutions`);
	}
	const warnings = Array.isArray(unwrapped.warnings) ? unwrapped.warnings : [];
	if (warnings.some((warning) => typeof warning === "string" && /truncat/i.test(warning))) {
		throw new AgentModeError("mode_unavailable", "mode catalog query result was truncated");
	}
	return unwrapped.rows.filter(isRecord);
}

function unwrapStructured(value: unknown): unknown {
	if (!isRecord(value)) return value;
	if (Array.isArray(value.rows)) return value;
	for (const key of ["structuredContent", "structured_content", "result"] as const) {
		if (value[key] !== undefined) return unwrapStructured(value[key]);
	}
	if (Array.isArray(value.content)) {
		for (const entry of value.content) {
			if (!isRecord(entry) || typeof entry.text !== "string") continue;
			try {
				return unwrapStructured(JSON.parse(entry.text) as unknown);
			} catch {
				// Continue with the next content entry.
			}
		}
	}
	return value;
}

/** gardend renders terms in N-Triples form; also accept `{type:"iri",value}`. */
function iriTerm(value: unknown): string | undefined {
	if (isRecord(value) && (value.type === "iri" || value.type === "uri") && typeof value.value === "string") {
		return value.value;
	}
	if (typeof value !== "string") return undefined;
	if (value.startsWith("<") && value.endsWith(">")) return value.slice(1, -1);
	if (/^(?:https?|urn):/.test(value)) return value;
	return undefined;
}

function literalTerm(value: unknown): string | undefined {
	if (isRecord(value) && value.type === "literal" && typeof value.value === "string") return value.value;
	if (typeof value !== "string") return undefined;
	const match = /^"((?:\\.|[^"\\])*)"(?:\^\^<[^>]+>|@[A-Za-z0-9-]+)?$/.exec(value);
	if (!match) return value.startsWith("<") ? undefined : value;
	try {
		return JSON.parse(`"${match[1]}"`) as string;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
