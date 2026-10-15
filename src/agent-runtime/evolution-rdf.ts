import type { EvolutionObjectRecord } from "./evolution-store.js";
import type { MeaningfulObjectRefV1 } from "./meaningful-object.js";

const NS = "https://sophia.dev/ontology/agent-evolution#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const XSD_INTEGER = "http://www.w3.org/2001/XMLSchema#integer";

export interface EvolutionProjectionSink {
	publish(record: EvolutionObjectRecord, ntriples: string): Promise<void>;
}

/** Minimal Garden writer face, kept narrower than the workflow GraphWriter. */
export interface EvolutionSparqlWriter {
	sparqlUpdate(graphId: string, update: string): Promise<void>;
}

/**
 * Production adapter from the durable evolution outbox to Garden's RDF lane.
 * `GraphWriter` supplies named-graph scoping, auth, and the gateway transport;
 * this adapter contributes only a bounded, deterministic INSERT DATA body.
 */
export class GardenEvolutionProjectionSink implements EvolutionProjectionSink {
	constructor(private readonly writer: EvolutionSparqlWriter) {}

	async publish(record: EvolutionObjectRecord, ntriples: string): Promise<void> {
		if (Buffer.byteLength(ntriples) > 1_048_576) throw new Error("evolution RDF projection exceeds 1 MiB");
		if (!ntriples.trim()) throw new Error("evolution RDF projection is empty");
		await this.writer.sparqlUpdate(record.ref.graphId, `INSERT DATA {\n${ntriples}}`);
	}
}

/**
 * Deterministic, bounded semantic projection for Garden/Emporium.
 *
 * Source bytes, patches, prompts, and arbitrary JSON are deliberately excluded.
 * They remain in Git/CAS. RDF receives identity, lifecycle state, provenance
 * edges, exact content digests, and the small decision vocabulary needed to
 * query an Agent's generational history.
 */
export function serializeEvolutionObjectRdf(record: EvolutionObjectRecord): string {
	const subject = iri(refIri(record.ref));
	const triples = new Set<string>();
	const emitIri = (predicate: string, object: string) => triples.add(`${subject} ${iri(predicate)} ${iri(object)} .`);
	const emitLiteral = (predicate: string, value: string) =>
		triples.add(`${subject} ${iri(predicate)} ${literal(value)} .`);
	const emitInteger = (predicate: string, value: number) =>
		triples.add(`${subject} ${iri(predicate)} "${value}"^^${iri(XSD_INTEGER)} .`);

	emitIri(RDF_TYPE, `${NS}${className(record.ref.kind)}`);
	emitLiteral(`${NS}ownerPrincipal`, record.ref.ownerPrincipal);
	emitLiteral(`${NS}graphId`, record.ref.graphId);
	emitLiteral(`${NS}objectId`, record.ref.objectId);
	emitLiteral(`${NS}version`, record.ref.version);
	emitLiteral(`${NS}digest`, record.ref.digest);
	if (record.agentId) emitLiteral(`${NS}agentId`, record.agentId);
	emitInteger(`${NS}createdAt`, record.createdAt);

	if (isRecord(record.document)) {
		const schema = record.document.schema;
		if (typeof schema === "string") emitLiteral(`${NS}schema`, schema);
		for (const key of [
			"status",
			"targetLayer",
			"verdict",
			"approvalAuthority",
			"mode",
			"proposedBy",
			"decidedBy",
			"committedBy",
		] as const) {
			const value = record.document[key];
			if (typeof value === "string") emitLiteral(`${NS}${key}`, value);
		}
		for (const key of ["requestedAt", "decidedAt", "committedAt", "expiresAt", "transactionRevision"] as const) {
			const value = record.document[key];
			if (typeof value === "number" && Number.isSafeInteger(value)) emitInteger(`${NS}${key}`, value);
		}
		projectReferenceEdges(record.document, (key, ref) => {
			emitIri(`${NS}${referencePredicate(key)}`, refIri(ref));
		});
	}
	return `${[...triples].sort().join("\n")}\n`;
}

export function refIri(ref: MeaningfulObjectRefV1): string {
	return `urn:sophia:mo:${encode(ref.ownerPrincipal)}:${encode(ref.graphId)}:${encode(ref.kind)}:${encode(ref.objectId)}:${encode(ref.version)}:${ref.digest.slice("sha256:".length)}`;
}

function projectReferenceEdges(
	value: Record<string, unknown>,
	emit: (key: string, ref: MeaningfulObjectRefV1) => void,
): void {
	for (const [key, item] of Object.entries(value)) {
		if (isMeaningfulObjectRef(item)) {
			emit(key, item);
			continue;
		}
		if (Array.isArray(item)) {
			for (const member of item) if (isMeaningfulObjectRef(member)) emit(key, member);
		}
	}
}

function referencePredicate(key: string): string {
	const normalized = key.endsWith("Refs") ? key.slice(0, -1) : key;
	return normalized.startsWith("has") ? normalized : `has${normalized[0]?.toUpperCase() ?? ""}${normalized.slice(1)}`;
}

function className(kind: string): string {
	return kind
		.split("-")
		.map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
		.join("");
}

function isMeaningfulObjectRef(value: unknown): value is MeaningfulObjectRefV1 {
	return (
		isRecord(value) &&
		value.schema === "sophia.meaningful-object-ref.v1" &&
		typeof value.kind === "string" &&
		typeof value.ownerPrincipal === "string" &&
		typeof value.graphId === "string" &&
		typeof value.objectId === "string" &&
		typeof value.version === "string" &&
		typeof value.digest === "string"
	);
}

function encode(value: string): string {
	return encodeURIComponent(value).replaceAll("%", "~");
}

function iri(value: string): string {
	if (!/^[^<>"{}|\\^`\u0000-\u0020]+$/.test(value)) throw new Error("RDF IRI contains a denied character");
	return `<${value}>`;
}

function literal(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r")}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
