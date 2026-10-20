/**
 * graph-plan-v1: a workflow whose definition is a named RDF graph (Vera, 2026-10-18).
 *
 * The definition is data, never code. One reviewed built-in (`script-graph-plan.ts`) walks it,
 * so a graph-authored workflow needs no `WORKFLOW_DYNAMIC_SOURCE`. The grammar is closed:
 *
 *   ?w a wf:Workflow ; wf:name "freud-ch1" ; dcterms:title "A catalogue of chapter I" .
 *   ?p a wf:Phase ; wf:partOfWorkflow ?w ; wf:order 1 ; dcterms:title "Day residue" .
 *   ?s a wf:AgentNode ; wf:inPhase ?p ; wf:label "the Reader" ; wf:agentType "segmenter" ;
 *      wf:instructions "…" ; wf:mode "once" | "perItem" ; wf:over ?collection ;
 *      wf:consumes ?collection ; wf:produces ?collection ; wf:itemSchema "{json schema of one item}" ;
 *      wf:checks ?collection ; wf:reads ?source .
 *   ?source a wf:Source ; wf:label "Chapter I" ; wf:documentId "doc-…" ; wf:fromBlock "block-…" ; wf:toBlock "block-…" .
 *   ?dest a wf:Destination ; wf:label "The book's margin" ; wf:kind "margin" ; wf:receives ?collection ;
 *      wf:documentId "doc-…" .
 *
 * Phases run in `wf:order`; the steps of a phase run in parallel. A `once` step runs one agent
 * (with the run input, or the whole of each collection it consumes); a `perItem` step runs one
 * agent per item of `wf:over`. Every step but a check produces a collection of items shaped by
 * `wf:itemSchema`. A check (`wf:checks`) runs once per item of the collection it checks, answers a
 * fixed verdict, and produces the items it passed. A step may only read collections produced in an
 * earlier phase, so the plan is acyclic by construction.
 *
 * Sources and destinations (2026-10-19, Vera: "first-class") name what a workflow reads and where its results go, so
 * an instruction can say "the book" instead of a document id and a person approves where a run will publish. A step
 * that reads sources is told them; a destination is where Publish puts what it receives. A plan without them compiles
 * to exactly what it did before (the new fields are absent, not empty), so its digest holds.
 *
 * Everything here is pure: the host reads the triples (`definitionQuery`), compiles them, and pins
 * the compiled plan's digest. What runs is exactly what was digested.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@sophia-labs/canonical-json";

export const GRAPH_PLAN_WORKFLOW_NAME = "graph-plan-v1";
export const GRAPH_PLAN_SCHEMA = "sophia.graph-plan.v1" as const;
export const WF = "http://mnemosyne.dev/workflow#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const DCT_TITLE = "http://purl.org/dc/terms/title";

export const GRAPH_PLAN_LIMITS = Object.freeze({
	phases: 6,
	steps: 12,
	sources: 6,
	destinations: 4,
	instructionsChars: 4000,
	schemaChars: 4000,
	itemsPerCollection: 200,
});

export type Term =
	| { readonly kind: "iri"; readonly value: string }
	| { readonly kind: "literal"; readonly value: string; readonly datatype?: string; readonly lang?: string }
	| { readonly kind: "blank"; readonly value: string };

export interface Triple {
	readonly s: string;
	readonly p: string;
	readonly o: Term;
}

export interface GraphPlanStepV1 {
	readonly iri: string;
	readonly id: string;
	readonly label: string;
	readonly job: string;
	readonly instructions: string;
	readonly mode: "once" | "perItem";
	readonly over?: string;
	readonly consumes: readonly string[];
	readonly produces?: string;
	readonly checks?: string;
	readonly itemSchema?: Record<string, unknown>;
	/** The sources (`wf:Source` IRIs) the step reads, sorted; absent when it reads none. */
	readonly reads?: readonly string[];
}

/** What a workflow reads: a document of this workspace, or a run of its blocks. */
export interface GraphPlanSourceV1 {
	readonly iri: string;
	readonly id: string;
	readonly label: string;
	readonly documentId: string;
	readonly fromBlock?: string;
	readonly toBlock?: string;
}

/** Where a workflow's results go when a person publishes them. One kind in v1: comments in a document's margin. */
export interface GraphPlanDestinationV1 {
	readonly iri: string;
	readonly id: string;
	readonly label: string;
	readonly kind: "margin";
	/** The collection it receives. */
	readonly receives: string;
	/** The document whose margin, for findings that name no `documentId` of their own. */
	readonly documentId?: string;
}

export interface GraphPlanPhaseV1 {
	readonly iri: string;
	readonly title: string;
	readonly order: number;
	readonly steps: readonly GraphPlanStepV1[];
}

export interface GraphPlanV1 {
	readonly schema: typeof GRAPH_PLAN_SCHEMA;
	readonly workflow: string;
	readonly name: string;
	readonly title: string;
	readonly phases: readonly GraphPlanPhaseV1[];
	/** Sorted by IRI; absent when there are none. */
	readonly sources?: readonly GraphPlanSourceV1[];
	/** Sorted by IRI; absent when there are none. */
	readonly destinations?: readonly GraphPlanDestinationV1[];
}

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BLOCK_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export class GraphPlanError extends Error {
	constructor(readonly problems: readonly string[]) {
		super(`the workflow graph is not a runnable plan: ${problems.join("; ")}`);
		this.name = "GraphPlanError";
	}
}

/** The one read of a definition: every triple of one named graph, nothing else. */
export function definitionQuery(definitionGraphIri: string): string {
	assertIri(definitionGraphIri, "definition graph");
	return `SELECT ?s ?p ?o WHERE { GRAPH <${definitionGraphIri}> { ?s ?p ?o } }`;
}

export function assertIri(value: string, what: string): void {
	if (!/^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|\\^`]+$/.test(value)) {
		throw new GraphPlanError([`${what} is not an IRI: ${JSON.stringify(value)}`]);
	}
}

/** Parse one N-Triples term as gardend's `sparql_query` rows carry it (`<iri>`, `"lit"^^<dt>`, `"lit"@en`, `_:b`). */
export function parseTerm(raw: string): Term {
	const text = raw.trim();
	if (text.startsWith("<") && text.endsWith(">")) return { kind: "iri", value: text.slice(1, -1) };
	if (text.startsWith("_:")) return { kind: "blank", value: text.slice(2) };
	if (text.startsWith('"')) {
		let i = 1;
		let value = "";
		while (i < text.length && text[i] !== '"') {
			if (text[i] === "\\") {
				const next = text[i + 1];
				const simple: Record<string, string> = {
					n: "\n",
					r: "\r",
					t: "\t",
					'"': '"',
					"\\": "\\",
					b: "\b",
					f: "\f",
					"'": "'",
				};
				if (next === "u" || next === "U") {
					const len = next === "u" ? 4 : 8;
					value += String.fromCodePoint(Number.parseInt(text.slice(i + 2, i + 2 + len), 16));
					i += 2 + len;
					continue;
				}
				value += simple[next] ?? next;
				i += 2;
				continue;
			}
			value += text[i];
			i += 1;
		}
		const rest = text.slice(i + 1);
		if (rest.startsWith("^^<") && rest.endsWith(">")) return { kind: "literal", value, datatype: rest.slice(3, -1) };
		if (rest.startsWith("@")) return { kind: "literal", value, lang: rest.slice(1) };
		return { kind: "literal", value };
	}
	// A bare token (some SPARQL faces print plain literals unquoted): keep it as a literal.
	return { kind: "literal", value: text };
}

/** Accept the shapes a `sparql_query` tool result arrives in (structuredContent, a text part, or the rows themselves). */
export function triplesFromSparqlResult(result: unknown): Triple[] {
	const rows = findRows(result);
	if (!rows) throw new GraphPlanError(["the graph answered something that is not a SELECT result"]);
	const triples: Triple[] = [];
	for (const row of rows) {
		if (!isRecord(row)) continue;
		const s = typeof row.s === "string" ? parseTerm(row.s) : undefined;
		const p = typeof row.p === "string" ? parseTerm(row.p) : undefined;
		const o = typeof row.o === "string" ? parseTerm(row.o) : undefined;
		if (!s || !p || !o || s.kind === "literal" || p.kind !== "iri") continue;
		triples.push({ s: s.kind === "blank" ? `_:${s.value}` : s.value, p: p.value, o });
	}
	return triples;
}

function findRows(value: unknown): unknown[] | undefined {
	if (Array.isArray(value)) return value;
	if (!isRecord(value)) return undefined;
	if (Array.isArray(value.rows)) return value.rows;
	if (isRecord(value.structuredContent)) return findRows(value.structuredContent);
	if (isRecord(value.result)) return findRows(value.result);
	if (Array.isArray(value.content)) {
		for (const part of value.content) {
			if (isRecord(part) && typeof part.text === "string") {
				try {
					const parsed = findRows(JSON.parse(part.text));
					if (parsed) return parsed;
				} catch {
					// not JSON; keep looking
				}
			}
		}
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compile a definition graph's triples into a plan, or refuse with every problem found. */
export function compileGraphPlan(triples: readonly Triple[]): GraphPlanV1 {
	const problems: string[] = [];
	const bySubject = new Map<string, Triple[]>();
	for (const t of triples) {
		if (t.s.startsWith("_:") || t.o.kind === "blank") {
			problems.push("blank nodes are not allowed in a workflow definition; name every subject");
			continue;
		}
		const list = bySubject.get(t.s) ?? [];
		list.push(t);
		bySubject.set(t.s, list);
	}
	const typed = (cls: string) =>
		[...bySubject.entries()]
			.filter(([, ts]) => ts.some((t) => t.p === RDF_TYPE && t.o.kind === "iri" && t.o.value === WF + cls))
			.map(([s]) => s)
			.sort();
	const one = (s: string, p: string, what: string): Term | undefined => {
		const values = (bySubject.get(s) ?? []).filter((t) => t.p === p).map((t) => t.o);
		if (values.length > 1) problems.push(`${short(s)} has ${values.length} ${what}; it needs exactly one`);
		return values[0];
	};
	const literal = (s: string, p: string, what: string, required: boolean): string | undefined => {
		const term = one(s, p, what);
		if (!term) {
			if (required) problems.push(`${short(s)} has no ${what}`);
			return undefined;
		}
		if (term.kind !== "literal") {
			problems.push(`${short(s)}'s ${what} must be text, not ${term.value}`);
			return undefined;
		}
		return term.value;
	};
	const iriOf = (s: string, p: string, what: string, required: boolean): string | undefined => {
		const term = one(s, p, what);
		if (!term) {
			if (required) problems.push(`${short(s)} has no ${what}`);
			return undefined;
		}
		if (term.kind !== "iri") {
			problems.push(`${short(s)}'s ${what} must be an IRI, not "${term.value}"`);
			return undefined;
		}
		return term.value;
	};
	const iris = (s: string, p: string): string[] =>
		(bySubject.get(s) ?? [])
			.filter((t) => t.p === p && t.o.kind === "iri")
			.map((t) => t.o.value)
			.sort();

	const workflows = typed("Workflow");
	if (workflows.length !== 1) {
		problems.push(`a definition holds exactly one wf:Workflow; this one holds ${workflows.length}`);
		throw new GraphPlanError(problems);
	}
	const workflow = workflows[0];
	const name = literal(workflow, `${WF}name`, "wf:name", true) ?? "";
	const title = literal(workflow, DCT_TITLE, "dcterms:title", false) ?? name;

	const phaseIris = typed("Phase").filter((p) => iris(p, `${WF}partOfWorkflow`).includes(workflow));
	for (const orphan of typed("Phase").filter((p) => !phaseIris.includes(p))) {
		problems.push(`${short(orphan)} is a phase of no workflow here (wf:partOfWorkflow)`);
	}
	if (phaseIris.length === 0) problems.push("the workflow has no phases");
	if (phaseIris.length > GRAPH_PLAN_LIMITS.phases) problems.push(`at most ${GRAPH_PLAN_LIMITS.phases} phases`);
	const phases = phaseIris.map((p) => {
		const orderText = literal(p, `${WF}order`, "wf:order", true);
		const order = orderText === undefined ? Number.NaN : Number(orderText);
		if (orderText !== undefined && !Number.isInteger(order))
			problems.push(`${short(p)}'s wf:order must be a whole number`);
		return { iri: p, title: literal(p, DCT_TITLE, "dcterms:title", false) ?? short(p), order };
	});
	const orders = phases.map((p) => p.order).filter((o) => Number.isInteger(o));
	if (new Set(orders).size !== orders.length) problems.push("two phases share a wf:order");
	phases.sort((a, b) => a.order - b.order);
	const phaseIndex = new Map(phases.map((p, i) => [p.iri, i]));

	const stepIris = typed("AgentNode");
	if (stepIris.length === 0) problems.push("the workflow has no steps (wf:AgentNode)");
	if (stepIris.length > GRAPH_PLAN_LIMITS.steps) problems.push(`at most ${GRAPH_PLAN_LIMITS.steps} steps`);
	const producedBy = new Map<string, { step: string; phase: number }>();
	const steps = stepIris.map((s) => {
		const phase = iriOf(s, `${WF}inPhase`, "wf:inPhase", true);
		if (phase && !phaseIndex.has(phase))
			problems.push(`${short(s)} is in ${short(phase)}, which is not a phase of this workflow`);
		const label = literal(s, `${WF}label`, "wf:label", true) ?? short(s);
		const job = literal(s, `${WF}agentType`, "wf:agentType", false) ?? "agent";
		const instructions = literal(s, `${WF}instructions`, "wf:instructions", true) ?? "";
		if (instructions.length > GRAPH_PLAN_LIMITS.instructionsChars) {
			problems.push(`${short(s)}'s instructions are longer than ${GRAPH_PLAN_LIMITS.instructionsChars} characters`);
		}
		const checks = iriOf(s, `${WF}checks`, "wf:checks", false);
		const modeText = literal(s, `${WF}mode`, "wf:mode", false) ?? (checks ? "perItem" : "once");
		if (modeText !== "once" && modeText !== "perItem")
			problems.push(`${short(s)}'s wf:mode is "${modeText}"; use "once" or "perItem"`);
		const mode: "once" | "perItem" = modeText === "perItem" ? "perItem" : "once";
		let over = iriOf(s, `${WF}over`, "wf:over", false);
		if (checks) {
			if (mode !== "perItem") problems.push(`${short(s)} checks a collection, so it runs once per item`);
			if (over && over !== checks) problems.push(`${short(s)} checks ${short(checks)} but runs over ${short(over)}`);
			over = checks;
		}
		if (mode === "perItem" && !over) problems.push(`${short(s)} runs per item but names no collection (wf:over)`);
		const consumes = iris(s, `${WF}consumes`);
		const reads = iris(s, `${WF}reads`);
		const produces = iriOf(s, `${WF}produces`, "wf:produces", !checks);
		const schemaText = literal(s, `${WF}itemSchema`, "wf:itemSchema", !checks);
		let itemSchema: Record<string, unknown> | undefined;
		if (schemaText !== undefined) {
			if (schemaText.length > GRAPH_PLAN_LIMITS.schemaChars) problems.push(`${short(s)}'s item schema is too long`);
			try {
				const parsed: unknown = JSON.parse(schemaText);
				if (!isRecord(parsed)) throw new Error("not an object");
				itemSchema = parsed;
			} catch {
				problems.push(`${short(s)}'s wf:itemSchema is not a JSON Schema object`);
			}
		}
		if (produces) {
			const prior = producedBy.get(produces);
			if (prior) problems.push(`${short(produces)} is produced by both ${short(prior.step)} and ${short(s)}`);
			producedBy.set(produces, { step: s, phase: phase ? (phaseIndex.get(phase) ?? -1) : -1 });
		}
		return {
			iri: s,
			id: localId(s),
			label,
			job,
			instructions,
			mode,
			...(over ? { over } : {}),
			consumes,
			...(produces ? { produces } : {}),
			...(checks ? { checks } : {}),
			...(itemSchema ? { itemSchema } : {}),
			...(reads.length > 0 ? { reads } : {}),
			phase: phase ?? "",
		};
	});
	for (const step of steps) {
		const at = phaseIndex.get(step.phase) ?? -1;
		for (const read of [...(step.over ? [step.over] : []), ...step.consumes]) {
			const source = producedBy.get(read);
			if (!source) problems.push(`${short(step.iri)} reads ${short(read)}, which no step produces`);
			else if (source.phase >= at)
				problems.push(`${short(step.iri)} reads ${short(read)} before an earlier phase has produced it`);
		}
	}
	const ids = steps.map((s) => s.id);
	if (new Set(ids).size !== ids.length)
		problems.push("two steps share a local name; give each step its own IRI fragment");

	const sourceIris = typed("Source");
	if (sourceIris.length > GRAPH_PLAN_LIMITS.sources) problems.push(`at most ${GRAPH_PLAN_LIMITS.sources} sources`);
	const sources: GraphPlanSourceV1[] = sourceIris.map((s) => {
		const label = literal(s, `${WF}label`, "wf:label", true) ?? short(s);
		const documentId = literal(s, `${WF}documentId`, "wf:documentId", true);
		if (documentId !== undefined && !DOCUMENT_ID.test(documentId))
			problems.push(`${short(s)}'s wf:documentId is not a document id`);
		const block = (name: "fromBlock" | "toBlock"): string | undefined => {
			const value = literal(s, `${WF}${name}`, `wf:${name}`, false);
			if (value !== undefined && !BLOCK_ID.test(value)) problems.push(`${short(s)}'s wf:${name} is not a block id`);
			return value;
		};
		const fromBlock = block("fromBlock");
		const toBlock = block("toBlock");
		return {
			iri: s,
			id: localId(s),
			label,
			documentId: documentId ?? "",
			...(fromBlock ? { fromBlock } : {}),
			...(toBlock ? { toBlock } : {}),
		};
	});
	for (const step of steps) {
		for (const read of step.reads ?? []) {
			if (!sourceIris.includes(read))
				problems.push(
					`${short(step.iri)} reads ${short(read)}, which is not a source of this workflow (wf:Source)`,
				);
		}
	}

	const destinationIris = typed("Destination");
	if (destinationIris.length > GRAPH_PLAN_LIMITS.destinations)
		problems.push(`at most ${GRAPH_PLAN_LIMITS.destinations} destinations`);
	const destinations: GraphPlanDestinationV1[] = destinationIris.map((d) => {
		const label = literal(d, `${WF}label`, "wf:label", true) ?? short(d);
		const kind = literal(d, `${WF}kind`, "wf:kind", true);
		if (kind !== undefined && kind !== "margin") problems.push(`${short(d)}'s wf:kind is "${kind}"; use "margin"`);
		const receives = iriOf(d, `${WF}receives`, "wf:receives", true);
		if (receives && !producedBy.has(receives))
			problems.push(`${short(d)} receives ${short(receives)}, which no step produces`);
		const documentId = literal(d, `${WF}documentId`, "wf:documentId", false);
		if (documentId !== undefined && !DOCUMENT_ID.test(documentId))
			problems.push(`${short(d)}'s wf:documentId is not a document id`);
		return {
			iri: d,
			id: localId(d),
			label,
			kind: "margin" as const,
			receives: receives ?? "",
			...(documentId ? { documentId } : {}),
		};
	});
	if (problems.length > 0) throw new GraphPlanError([...new Set(problems)]);

	return {
		schema: GRAPH_PLAN_SCHEMA,
		workflow,
		name,
		title,
		phases: phases.map((p) => ({
			iri: p.iri,
			title: p.title,
			order: p.order,
			steps: steps
				.filter((s) => s.phase === p.iri)
				.map(({ phase: _phase, ...step }) => step)
				.sort((a, b) => a.iri.localeCompare(b.iri)),
		})),
		...(sources.length > 0 ? { sources } : {}),
		...(destinations.length > 0 ? { destinations } : {}),
	};
}

/** The digest a run pins: sha256 over the canonical JSON of the compiled plan. */
export function graphPlanDigest(plan: GraphPlanV1): string {
	return `sha256:${createHash("sha256").update(canonicalJson(plan)).digest("hex")}`;
}

/** The output schema a step's agent must answer: an object holding its items, or a check's verdict. */
export function stepOutputSchema(step: GraphPlanStepV1): Record<string, unknown> {
	if (step.checks) {
		return {
			type: "object",
			additionalProperties: false,
			required: ["ok"],
			properties: {
				ok: { type: "boolean" },
				reason: { type: "string" },
				nearest: { type: "string" },
			},
		};
	}
	return {
		type: "object",
		additionalProperties: false,
		required: ["items"],
		properties: {
			items: {
				type: "array",
				maxItems: GRAPH_PLAN_LIMITS.itemsPerCollection,
				items: step.itemSchema ?? { type: "object" },
			},
		},
	};
}

export function localId(iri: string): string {
	const tail = iri.split(/[#/:]/).filter(Boolean).pop() ?? iri;
	return tail.replace(/[^A-Za-z0-9_-]/g, "_");
}

function short(iri: string): string {
	return localId(iri);
}
