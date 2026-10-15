/**
 * Graph projection for the canonical Agent Session execution journal.
 *
 * Choreograph's runtime store remains the computation authority. This module
 * materializes each settled journal cell as attributed RDF. Notebook layout
 * ownership is deliberately separate: runtime publication may seed a missing
 * layout/workspace, but never rewrites graph-authored UX configuration.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@sophia-labs/canonical-json";
import { str, userRdfGraphIri, xsdDateTime, xsdLong } from "../workflow/vocab.js";
import type { ExecutionCell } from "./execution-service.js";

export const COMPUTE_NS = "http://sophia.ai/compute#";
export const NOTEBOOK_FACE_ID = "compute.cell";

const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS_NS = "http://www.w3.org/2000/01/rdf-schema#";
const PROV_NS = "http://www.w3.org/ns/prov#";
const XSD_NS = "http://www.w3.org/2001/XMLSchema#";
const UX_NS = "http://mnemosyne.dev/ux#";
const SOPHIA_UX_NS = "http://sophia.ai/ux#";
const CENTER_REGION_IRI = `${SOPHIA_UX_NS}region-center`;
const GRAPH_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export interface NotebookProjectionIdentity {
	notebookIri: string;
	cellIri: string;
	surfaceIri: string;
	agentSessionIri: string;
}

export interface AgentNotebookProjectionInput {
	graphId: string;
	sessionId: string;
	cell: ExecutionCell;
	/** Stable workflow/session creation time used by the immutable layout document. */
	layoutAuthoredAt: number;
	/** Explicit proof/workspace policy. Projection alone never rearranges Garden. */
	attachToGardenCenter?: boolean;
}

export interface AgentNotebookLayoutSeedInput {
	graphId: string;
	sessionId: string;
	layoutAuthoredAt: number;
	/** Seed a workspace only when neither a workspace nor a center attachment exists. */
	attachToGardenCenter?: boolean;
}

export interface AgentNotebookLayoutCasMigrationInput {
	graphId: string;
	sessionId: string;
	/** Byte-exact layout value the caller read before requesting the migration. */
	currentLayoutJson: string;
	/** Byte-exact layout value the migration is allowed to replace. */
	expectedLayoutJson: string;
	/** Complete replacement LayoutDocument JSON. */
	replacementLayoutJson: string;
}

export interface AgentNotebookAttachedLayoutCasMigrationInput extends AgentNotebookLayoutCasMigrationInput {
	/** Exact surface currently attached to Garden's center region. */
	expectedCenterSurfaceIri: string;
}

export interface AgentNotebookFamilyLayoutInput {
	graphId: string;
	sessionId: string;
	/** Canonical Session subject consumed by the sealed family Face. */
	familyRootSessionIri: string;
	/** Byte-exact layout read from the graph before migration. */
	currentLayoutJson: string;
	updatedAt: number;
}

/**
 * A safe CAS refusal. Digests make the mismatch observable without copying an
 * authored LayoutDocument into logs or error telemetry.
 */
export class AgentNotebookLayoutCasMismatchError extends Error {
	readonly code = "agent_notebook_layout_cas_mismatch";
	readonly preserved = true;
	readonly surfaceIri: string;
	readonly expectedSha256: string;
	readonly actualSha256: string;

	constructor(surfaceIri: string, expectedLayoutJson: string, currentLayoutJson: string) {
		super("agent notebook layout CAS refused because the authored value changed");
		this.name = "AgentNotebookLayoutCasMismatchError";
		this.surfaceIri = surfaceIri;
		this.expectedSha256 = digest(expectedLayoutJson);
		this.actualSha256 = digest(currentLayoutJson);
	}
}

export interface NotebookGraphProxy {
	callTool(name: string, arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export function notebookProjectionIdentity(sessionId: string, cellRef: string): NotebookProjectionIdentity {
	const sessionDigest = digest(sessionId);
	return {
		notebookIri: `urn:sophia:agent-notebook:${sessionDigest}`,
		cellIri: `urn:sophia:compute-cell:${digest(cellRef)}`,
		surfaceIri: `urn:sophia:ux:surface:agent-notebook:${sessionDigest}`,
		agentSessionIri: `urn:sophia:agent-session:${sessionDigest}`,
	};
}

/** The graph-authored, polling notebook surface consumed by Shrubbery. */
export function buildAgentNotebookLayout(
	graphId: string,
	sessionId: string,
	layoutAuthoredAt: number,
): Record<string, unknown> {
	assertProjectionCoordinates(graphId, sessionId, layoutAuthoredAt);
	const { notebookIri } = notebookProjectionIdentity(sessionId, "layout");
	const authoredAt = new Date(layoutAuthoredAt).toISOString();
	const query = [
		`PREFIX comp: <${COMPUTE_NS}>`,
		"SELECT ?item ?graphId WHERE {",
		`  GRAPH <${userRdfGraphIri(graphId)}> {`,
		"    ?item a comp:ComputeCell ;",
		`      comp:notebook <${notebookIri}> ;`,
		"      comp:generation ?generation ;",
		"      comp:ordinal ?ordinal .",
		"  }",
		`  BIND(${str(graphId)} AS ?graphId)`,
		"}",
		"ORDER BY ?generation ?ordinal",
		"LIMIT 500",
	].join("\n");
	return {
		schemaVersion: 1,
		layoutId: `agent-notebook-${digest(sessionId).slice(0, 20)}`,
		scope: "session",
		graphId,
		rootNodeId: "notebook-cells",
		nodes: {
			"notebook-cells": {
				kind: "grid",
				id: "notebook-cells",
				flow: "stack",
				minCellWidth: 640,
				children: {
					kind: "collection",
					collection: { kind: "query", graphId, queryId: query },
					itemFaceId: NOTEBOOK_FACE_ID,
					itemParams: { graphId: "?graphId" },
					maxItems: 500,
					refreshSeconds: 1,
				},
				gridRevision: 0,
			},
		},
		createdAt: authoredAt,
		updatedAt: authoredAt,
	};
}

/** Build one deterministic, data-only cell projection. Exported for contract tests. */
export function buildAgentNotebookProjection(input: AgentNotebookProjectionInput): string {
	assertNotebookCoordinates(input.graphId, input.sessionId);
	if (input.cell.sessionId !== input.sessionId) {
		throw new Error("notebook projection session does not match the execution cell");
	}
	if (!Number.isSafeInteger(input.cell.ordinal) || input.cell.ordinal < 0) {
		throw new Error("notebook projection cell ordinal must be a non-negative safe integer");
	}
	if (!Number.isSafeInteger(input.cell.generation) || input.cell.generation < 0) {
		throw new Error("notebook projection cell generation must be a non-negative safe integer");
	}

	const { notebookIri, cellIri, surfaceIri, agentSessionIri } = notebookProjectionIdentity(
		input.sessionId,
		input.cell.cellRef,
	);
	const userGraph = userRdfGraphIri(input.graphId);
	const outputsJson = canonicalJson(input.cell.outputs);
	const hostRequestsJson = canonicalJson(input.cell.hostRequests);
	const executionCount =
		input.cell.executionCount === undefined
			? ""
			: `\n      comp:executionCount ${xsdLong(input.cell.executionCount)} ;`;

	return `PREFIX rdf: <${RDF_NS}>
PREFIX comp: <${COMPUTE_NS}>
PREFIX prov: <${PROV_NS}>
PREFIX xsd: <${XSD_NS}>
DELETE {
  GRAPH <${userGraph}> {
    <${cellIri}> ?cellPredicate ?cellObject .
  }
}
INSERT {
  GRAPH <${userGraph}> {
    <${notebookIri}> a comp:Notebook ;
      comp:sessionId ${str(input.sessionId)} ;
      comp:agentSession <${agentSessionIri}> ;
      comp:surface <${surfaceIri}> .
    <${cellIri}> a comp:ComputeCell ;
      comp:notebook <${notebookIri}> ;
      comp:cellRef ${str(input.cell.cellRef)} ;
      comp:sessionId ${str(input.sessionId)} ;
      comp:ordinal ${xsdLong(input.cell.ordinal)} ;
      comp:generation ${xsdLong(input.cell.generation)} ;
      comp:source ${str(input.cell.code)} ;
      comp:status ${str(input.cell.status)} ;${executionCount}
      comp:outputsJson ${str(outputsJson)} ;
      comp:hostRequestsJson ${str(hostRequestsJson)} ;
      comp:cellDigest ${str(input.cell.cellDigest)} ;
      comp:startedAt ${xsdLong(input.cell.startedAt)} ;
      comp:completedAt ${xsdLong(input.cell.completedAt)} ;
      comp:durationMs ${xsdLong(input.cell.durationMs)} ;
      prov:wasGeneratedBy <${agentSessionIri}> ;
      prov:generatedAtTime ${xsdDateTime(input.cell.completedAt)} .
  }
}
WHERE {
  OPTIONAL { GRAPH <${userGraph}> { <${cellIri}> ?cellPredicate ?cellObject . } }
}`;
}

/**
 * Seed the canonical notebook layout and optional workspace only when absent.
 * There is intentionally no DELETE clause: a previously authored layout or
 * center attachment remains byte-for-byte and triple-for-triple untouched.
 */
export function buildAgentNotebookLayoutSeed(input: AgentNotebookLayoutSeedInput): string {
	assertProjectionCoordinates(input.graphId, input.sessionId, input.layoutAuthoredAt);
	const { surfaceIri } = notebookProjectionIdentity(input.sessionId, "layout");
	const uxGraph = `urn:mnemosyne:local:graph:${input.graphId}:ux:config`;
	const layoutJson = canonicalJson(buildAgentNotebookLayout(input.graphId, input.sessionId, input.layoutAuthoredAt));
	const workspaceIri = `urn:sophia:ux:workspace:agent-notebook:${digest(input.graphId)}`;
	const rootEntryIri = `${workspaceIri}:root-0`;
	const freshWorkspaceInsert = input.attachToGardenCenter
		? `;
INSERT {
  GRAPH <${uxGraph}> {
    <${workspaceIri}> a sux:Workspace ;
      sux:localId "AgentNotebookWorkspace" ;
      rdfs:label "Agent Notebook Workspace" ;
      sux:renderedByComponent "app-shell" ;
      sux:hasRegion <${CENTER_REGION_IRI}> ;
      sux:hasRootEntry <${rootEntryIri}> .
    <${rootEntryIri}> a sux:RootEntry ;
      sux:atIndex "0"^^xsd:integer ;
      sux:rootRegion <${CENTER_REGION_IRI}> .
    <${CENTER_REGION_IRI}> a sux:Region ;
      sux:localId "region-center" ;
      rdfs:label "Agent Notebook" ;
      sux:order "0"^^xsd:integer ;
      sux:splitOrientation "vertical" ;
      sux:collapsible "false"^^xsd:boolean ;
      sux:resizable "true"^^xsd:boolean ;
      sux:sizeFraction "0.99"^^xsd:decimal ;
      sux:renderedByComponent "sh-layout-dashboard" ;
      sux:fragmentSurface <${surfaceIri}> .
  }
}
WHERE {
  FILTER NOT EXISTS { GRAPH <${uxGraph}> { ?workspace a sux:Workspace . } }
  FILTER NOT EXISTS { GRAPH <${uxGraph}> { <${CENTER_REGION_IRI}> sux:renderedByComponent ?existingComponent . } }
  FILTER NOT EXISTS { GRAPH <${uxGraph}> { <${CENTER_REGION_IRI}> sux:fragmentSurface ?existingSurface . } }
}`
		: "";

	return `PREFIX rdf: <${RDF_NS}>
PREFIX rdfs: <${RDFS_NS}>
PREFIX xsd: <${XSD_NS}>
PREFIX ux: <${UX_NS}>
PREFIX sux: <${SOPHIA_UX_NS}>
INSERT {
  GRAPH <${uxGraph}> {
    <${surfaceIri}> ux:layoutJson ${str(layoutJson)} .
  }
}
WHERE {
  FILTER NOT EXISTS { GRAPH <${uxGraph}> { <${surfaceIri}> ux:layoutJson ?existingLayout . } }
}${freshWorkspaceInsert}`;
}

/**
 * Build an explicit layout migration fenced twice by a byte-exact compare and
 * swap: locally against the caller's read, then atomically in SPARQL. Runtime
 * notebook publication never calls this helper.
 */
export function buildAgentNotebookLayoutCasMigration(input: AgentNotebookLayoutCasMigrationInput): string {
	assertNotebookCoordinates(input.graphId, input.sessionId);
	assertLayoutJson(input.expectedLayoutJson, "expected");
	assertLayoutJson(input.replacementLayoutJson, "replacement");
	const { surfaceIri } = notebookProjectionIdentity(input.sessionId, "layout");
	if (input.currentLayoutJson !== input.expectedLayoutJson) {
		throw new AgentNotebookLayoutCasMismatchError(surfaceIri, input.expectedLayoutJson, input.currentLayoutJson);
	}

	const uxGraph = `urn:mnemosyne:local:graph:${input.graphId}:ux:config`;
	const expected = str(input.expectedLayoutJson);
	return `PREFIX ux: <${UX_NS}>
DELETE {
  GRAPH <${uxGraph}> {
    <${surfaceIri}> ux:layoutJson ${expected} .
  }
}
INSERT {
  GRAPH <${uxGraph}> {
    <${surfaceIri}> ux:layoutJson ${str(input.replacementLayoutJson)} .
  }
}
WHERE {
  GRAPH <${uxGraph}> {
    <${surfaceIri}> ux:layoutJson ${expected} .
  }
}`;
}

/**
 * Turn the exact untouched runtime notebook seed into the Arc F split surface.
 * This is intentionally not a general layout rewriter: any authored change,
 * including harmless-looking formatting drift, preserves the graph value and
 * refuses the migration.
 */
export function buildAgentNotebookFamilyLayout(input: AgentNotebookFamilyLayoutInput): string {
	assertProjectionCoordinates(input.graphId, input.sessionId, input.updatedAt);
	assertSafeIri(input.familyRootSessionIri, "family root Session");
	const current = parseLayoutObject(input.currentLayoutJson, "current");
	const createdAt = current.createdAt;
	if (typeof createdAt !== "string") throw new Error("agent notebook current layout has no creation time");
	const authoredAt = Date.parse(createdAt);
	if (!Number.isSafeInteger(authoredAt) || authoredAt < 0) {
		throw new Error("agent notebook current layout has an invalid creation time");
	}
	const expectedSeed = canonicalJson(buildAgentNotebookLayout(input.graphId, input.sessionId, authoredAt));
	if (input.currentLayoutJson !== expectedSeed) {
		const { surfaceIri } = notebookProjectionIdentity(input.sessionId, "layout");
		throw new AgentNotebookLayoutCasMismatchError(surfaceIri, expectedSeed, input.currentLayoutJson);
	}
	const notebookNode = familyNotebookNode(
		(current.nodes as Record<string, unknown>)["notebook-cells"],
		input.graphId,
		input.familyRootSessionIri,
	);
	return canonicalJson({
		...current,
		rootNodeId: "agent-session-split",
		nodes: {
			"agent-session-split": {
				kind: "split",
				id: "agent-session-split",
				axis: "horizontal",
				startNodeId: "notebook-cells",
				endNodeId: "agent-session-family",
				startBasisPoints: 6500,
			},
			"notebook-cells": notebookNode,
			"agent-session-family": {
				kind: "leaf",
				id: "agent-session-family",
				descriptor: {
					schemaVersion: 1,
					faceId: "agent.session-family",
					resource: {
						kind: "graph",
						graphId: input.graphId,
						subjectIri: input.familyRootSessionIri,
					},
				},
				descriptorRevision: 0,
			},
		},
		updatedAt: new Date(input.updatedAt).toISOString(),
	});
}

function familyNotebookNode(value: unknown, graphId: string, familyRootSessionIri: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("agent notebook current layout has no notebook collection node");
	}
	const node = value as Record<string, unknown>;
	if (typeof node.children !== "object" || node.children === null || Array.isArray(node.children)) {
		throw new Error("agent notebook current layout has no notebook collection descriptor");
	}
	const children = node.children as Record<string, unknown>;
	if (typeof children.collection !== "object" || children.collection === null || Array.isArray(children.collection)) {
		throw new Error("agent notebook current layout has no notebook query collection");
	}
	return {
		...node,
		children: {
			...children,
			collection: {
				...(children.collection as Record<string, unknown>),
				queryId: buildAgentNotebookFamilyCellsQuery(graphId, familyRootSessionIri),
			},
		},
	};
}

/** Root and descendant notebooks joined through durable Session-family identity. */
export function buildAgentNotebookFamilyCellsQuery(graphId: string, familyRootSessionIri: string): string {
	if (!GRAPH_ID.test(graphId)) throw new Error(`notebook projection graph id is invalid: ${JSON.stringify(graphId)}`);
	assertSafeIri(familyRootSessionIri, "family root Session");
	return [
		`PREFIX comp: <${COMPUTE_NS}>`,
		"PREFIX agt: <http://mnemosyne.dev/agent#>",
		"PREFIX ar: <http://sophia.ai/agent-runtime#>",
		"SELECT ?item ?graphId WHERE {",
		`  GRAPH <${userRdfGraphIri(graphId)}> {`,
		"    {",
		`      BIND(<${familyRootSessionIri}> AS ?session)`,
		"      BIND(0 AS ?depth)",
		"    } UNION {",
		`      <${familyRootSessionIri}> (^ar:parentSession/ar:childSession)+ ?session .`,
		"      ?relation a ar:ChildSessionRelation ;",
		"        ar:childSession ?session ;",
		"        ar:depth ?depth .",
		"    }",
		"    ?session a agt:Session ;",
		"      agt:sessionId ?sessionId .",
		"    ?item a comp:ComputeCell ;",
		"      comp:sessionId ?sessionId ;",
		"      comp:generation ?generation ;",
		"      comp:ordinal ?ordinal .",
		"  }",
		`  BIND(${str(graphId)} AS ?graphId)`,
		"}",
		"ORDER BY ?depth ?sessionId ?generation ?ordinal",
		"LIMIT 500",
	].join("\n");
}

/**
 * Atomically replace an exact layout and its exact center attachment. Both
 * preconditions live in one WHERE clause, so neither half can move alone.
 */
export function buildAgentNotebookAttachedLayoutCasMigration(
	input: AgentNotebookAttachedLayoutCasMigrationInput,
): string {
	assertNotebookCoordinates(input.graphId, input.sessionId);
	assertLayoutJson(input.expectedLayoutJson, "expected");
	assertLayoutJson(input.replacementLayoutJson, "replacement");
	assertSafeIri(input.expectedCenterSurfaceIri, "expected center surface");
	const { surfaceIri } = notebookProjectionIdentity(input.sessionId, "layout");
	if (input.currentLayoutJson !== input.expectedLayoutJson) {
		throw new AgentNotebookLayoutCasMismatchError(surfaceIri, input.expectedLayoutJson, input.currentLayoutJson);
	}

	const uxGraph = `urn:mnemosyne:local:graph:${input.graphId}:ux:config`;
	const expected = str(input.expectedLayoutJson);
	return `PREFIX ux: <${UX_NS}>
PREFIX sux: <${SOPHIA_UX_NS}>
DELETE {
  GRAPH <${uxGraph}> {
    <${surfaceIri}> ux:layoutJson ${expected} .
    <${CENTER_REGION_IRI}> sux:fragmentSurface <${input.expectedCenterSurfaceIri}> .
  }
}
INSERT {
  GRAPH <${uxGraph}> {
    <${surfaceIri}> ux:layoutJson ${str(input.replacementLayoutJson)} .
    <${CENTER_REGION_IRI}> sux:fragmentSurface <${surfaceIri}> .
  }
}
WHERE {
  GRAPH <${uxGraph}> {
    <${surfaceIri}> ux:layoutJson ${expected} .
    <${CENTER_REGION_IRI}> sux:fragmentSurface <${input.expectedCenterSurfaceIri}> .
  }
}`;
}

export async function projectExecutionCellToNotebook(
	proxy: NotebookGraphProxy,
	input: AgentNotebookProjectionInput,
): Promise<void> {
	await proxy.callTool("sparql_update", {
		graphId: input.graphId,
		update: buildAgentNotebookProjection(input),
	});
	await proxy.callTool("sparql_update", {
		graphId: input.graphId,
		update: buildAgentNotebookLayoutSeed(input),
	});
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function assertNotebookCoordinates(graphId: string, sessionId: string): void {
	if (!GRAPH_ID.test(graphId)) throw new Error(`notebook projection graph id is invalid: ${JSON.stringify(graphId)}`);
	if (!sessionId || sessionId.length > 256) throw new Error("notebook projection session id is invalid");
}

function assertProjectionCoordinates(graphId: string, sessionId: string, layoutAuthoredAt: number): void {
	assertNotebookCoordinates(graphId, sessionId);
	if (!Number.isSafeInteger(layoutAuthoredAt) || layoutAuthoredAt < 0) {
		throw new Error("notebook projection layout time must be a non-negative safe integer");
	}
}

function assertLayoutJson(value: string, role: "expected" | "replacement"): void {
	parseLayoutObject(value, role);
}

function parseLayoutObject(value: string, role: "current" | "expected" | "replacement"): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error(`agent notebook ${role} layout must be valid JSON`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`agent notebook ${role} layout must encode an object`);
	}
	return parsed as Record<string, unknown>;
}

function assertSafeIri(value: string, role: string): void {
	if (!/^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|\\^`]+$/.test(value)) {
		throw new Error(`agent notebook ${role} IRI is invalid`);
	}
}
