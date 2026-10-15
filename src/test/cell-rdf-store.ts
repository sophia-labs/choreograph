/**
 * A real in-process SPARQL cell for tests: the same Oxigraph engine gardend
 * embeds, answering `sparql_query` in gardend's result shape
 * (`{resultType, variables, rows: [{var: N-Triples term}], quadCount}`),
 * wrapped as an MCP CallToolResult the way the hosted proxy returns it.
 */
import { Store } from "oxigraph";
import { graphScopeIri } from "../agent-runtime/agent-mode.js";
import { mintAgentUri } from "../agent-subject/agent-ontology.js";
import { scopeUpdateToUserRdfGraph } from "../workflow/graph-writer.js";

export class CellRdfStore {
	private readonly store = new Store();

	/** Seed a non-user named graph when testing the mode authority boundary. */
	updateRaw(sparql: string): void {
		this.store.update(sparql);
	}

	/** gardend executes `sparql_update` verbatim; the hosted writer pre-scopes it. */
	update(graphId: string, sparql: string): void {
		this.store.update(scopeUpdateToUserRdfGraph(graphId, sparql));
	}

	/** gardend `sparql_query`, MCP-wrapped. */
	query(sparql: string): unknown {
		const results = this.store.query(sparql);
		const quadCount = this.store.size;
		const body =
			typeof results === "boolean"
				? { resultType: "boolean", variables: [], rows: [], boolean: results, quadCount }
				: {
						resultType: "solutions",
						variables: [] as string[],
						rows: (results as Map<string, { toString(): string }>[]).map((row) =>
							Object.fromEntries([...row].map(([name, term]) => [name, term.toString()])),
						),
						quadCount,
					};
		return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
	}
}

export interface SeedModeInput {
	readonly slug: string;
	readonly label: string;
	/** Raw `agt:access` literals; omit for "missing". */
	readonly access?: readonly string[];
	readonly allowsTool?: readonly string[];
	readonly graphScope?: readonly string[];
	readonly requiresApproval?: readonly string[];
	readonly imageTransform?: string;
}

/**
 * Write modes exactly as the Shrubbery Modes surface does: MCP `sparql_update`
 * into the agent graph's `:user:rdf` named graph.
 */
export function seedAgentModes(
	cell: CellRdfStore,
	graphId: string,
	input: {
		readonly agentId: string;
		readonly modes: readonly SeedModeInput[];
		readonly defaultMode?: string;
		readonly mayUseModes?: readonly string[];
	},
): void {
	const lines: string[] = [];
	for (const mode of input.modes) {
		const subject = `<urn:sophia:mode:${mode.slug}>`;
		lines.push(`${subject} a agt:Mode ; rdfs:label ${JSON.stringify(mode.label)} .`);
		for (const access of mode.access ?? []) lines.push(`${subject} agt:access ${JSON.stringify(access)} .`);
		for (const tool of mode.allowsTool ?? []) lines.push(`${subject} agt:allowsTool ${JSON.stringify(tool)} .`);
		for (const graph of mode.graphScope ?? []) lines.push(`${subject} agt:graphScope <${graphScopeIri(graph)}> .`);
		for (const tool of mode.requiresApproval ?? []) {
			lines.push(`${subject} agt:requiresApproval ${JSON.stringify(tool)} .`);
		}
		if (mode.imageTransform) lines.push(`${subject} agt:imageTransform ${JSON.stringify(mode.imageTransform)} .`);
	}
	const agent = `<${mintAgentUri(input.agentId)}>`;
	if (input.defaultMode) lines.push(`${agent} agt:defaultMode <urn:sophia:mode:${input.defaultMode}> .`);
	for (const slug of input.mayUseModes ?? []) lines.push(`${agent} agt:mayUseMode <urn:sophia:mode:${slug}> .`);
	cell.update(
		graphId,
		`PREFIX agt: <http://mnemosyne.dev/agent#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
INSERT DATA {
${lines.join("\n")}
}`,
	);
}
