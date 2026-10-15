/**
 * Host-authoritative Domain Verdict effect adapter.
 *
 * The sandbox supplies scoped testimony, never a projection target, subject,
 * timestamp, session witness, vocabulary, or apply flag. The host derives all
 * of those from the trusted activity turn, preflights Garden's registered
 * verdict pack, applies it, and proves a zero-delta replay.
 */

import { createHash } from "node:crypto";
import { mintAgentSessionUri } from "../agent-subject/agent-ontology.js";
import { stableJson } from "./agent-tool-manifest.js";
import type { GenericIngestRequest, GenericProjectionRecord } from "./emporium-ingest.js";
import type { GraphWriter } from "./graph-writer.js";
import type { EffectExecutionContext, ProposedEffectV1 } from "./proposed-effect.js";

export const DOMAIN_VERDICT_CAPABILITY = "domain.verdict";
export const DOMAIN_VERDICT_OPERATION = "write";
export const DOMAIN_VERDICT_VOCAB = "sophia-domain-verdict";

const DOMAIN_NS = "http://sophia.ai/domain#";
const SHA256 = /^[0-9a-f]{64}$/;
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const OUTCOMES = new Set(["PASS", "FAIL", "BLOCKED"]);

interface EvidenceInput {
	uri: string;
	sha256: string;
	mediaType?: string;
	label?: string;
}

interface VerdictInput {
	domain: string;
	capabilityId: string;
	mode: string;
	role: string;
	targetSha256: string;
	outcome: "PASS" | "FAIL" | "BLOCKED";
	evidence: EvidenceInput[];
	reason?: string;
}

export interface BuiltDomainVerdictEffect {
	readonly graphId: string;
	readonly verdictId: string;
	readonly request: GenericIngestRequest;
}

export function isDomainVerdictEffect(effect: ProposedEffectV1): boolean {
	return effect.capability === DOMAIN_VERDICT_CAPABILITY && effect.operation === DOMAIN_VERDICT_OPERATION;
}

export function buildDomainVerdictEffectRequest(
	effect: ProposedEffectV1,
	context: EffectExecutionContext,
): BuiltDomainVerdictEffect {
	if (!isDomainVerdictEffect(effect)) throw new Error("effect is not a domain verdict write");
	const arguments_ = exactRecord(effect.arguments, ["graphId", "graph_id", "resource", "verdict"], "arguments");
	if (arguments_.graphId !== undefined && arguments_.graph_id !== undefined) {
		throw new Error("arguments must not supply both graphId and graph_id");
	}
	const requestedGraph = optionalText(arguments_.graphId ?? arguments_.graph_id, "arguments.graphId");
	if (requestedGraph && requestedGraph !== context.graphId) {
		throw new Error("domain verdict target must be the trusted home graph");
	}
	const verdict = parseVerdictInput(arguments_.verdict);
	const resource = requiredText(arguments_.resource, "arguments.resource");
	if (resource !== `domain:${verdict.domain}:verdict`) {
		throw new Error("domain verdict resource does not match the verdict domain");
	}
	const evidenceUris = verdict.evidence.map((entry) => entry.uri);
	if (!sameStringSet(evidenceUris, effect.evidenceRefs)) {
		throw new Error("domain verdict evidence must equal the proposal evidenceRefs");
	}

	const asOf = new Date(context.now?.() ?? Date.now()).toISOString();
	const agentSessionUri = mintAgentSessionUri(context.agentId, context.runId);
	const seed = {
		domain: verdict.domain,
		capabilityId: verdict.capabilityId,
		mode: verdict.mode,
		role: verdict.role,
		targetSha256: verdict.targetSha256,
		outcome: verdict.outcome,
		evidence: verdict.evidence,
		asOf,
		agentSessionUri,
		reason: verdict.reason,
	};
	const verdictId = `urn:sophia:domain:${encodeURIComponent(verdict.domain)}:verdict:${digest(seed)}`;
	const document = {
		schema: "sophia.domain-verdict.v1" as const,
		verdictId,
		...seed,
	};
	const evidenceSubjects = verdict.evidence.map((entry) => `urn:sophia:domain:evidence:${digest(entry)}`);
	const records: GenericProjectionRecord[] = [
		{
			kind: "Verdict",
			localId: verdictId,
			domain: verdict.domain,
			capabilityId: verdict.capabilityId,
			modeId: verdict.mode,
			roleId: verdict.role,
			targetSha256: verdict.targetSha256,
			outcome: `${DOMAIN_NS}${verdict.outcome}`,
			asOf,
			agentSession: agentSessionUri,
			...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
			contentSha256: digest(document),
			sourceJson: stableJson(document),
			evidence: evidenceSubjects,
		},
		...verdict.evidence.map((entry, index) => ({
			kind: "EvidenceRef",
			localId: evidenceSubjects[index]!,
			hash: digest(entry),
			contentUri: entry.uri,
			contentSha256: entry.sha256,
			...(entry.mediaType === undefined ? {} : { mediaType: entry.mediaType }),
			...(entry.label === undefined ? {} : { label: entry.label }),
		})),
	];
	return {
		graphId: context.graphId,
		verdictId,
		request: {
			vocab: DOMAIN_VERDICT_VOCAB,
			dry_run: false,
			replace_class: false,
			payload: { kind: "generic", records },
		},
	};
}

export async function executeDomainVerdictEffect(
	effect: ProposedEffectV1,
	context: EffectExecutionContext,
	graph: GraphWriter,
): Promise<unknown> {
	if (!graph.emporiumIngest) throw new Error("Garden Emporium authority is unavailable");
	const built = buildDomainVerdictEffectRequest(effect, context);
	await assertDeclaredVerdictScope(graph, built.graphId, built.request.payload.records[0]!);
	const plan = await graph.emporiumIngest(built.graphId, { ...built.request, dry_run: true });
	const before = projectionDelta(plan);
	const applied = await graph.emporiumIngest(built.graphId, built.request);
	if (!isRecord(applied) || applied.ok !== true) throw new Error("Garden Emporium did not acknowledge the verdict");
	const replay = await graph.emporiumIngest(built.graphId, { ...built.request, dry_run: true });
	const after = projectionDelta(replay);
	if (after.rdfInsert !== 0 || after.rdfDelete !== 0) {
		throw new Error("Garden Emporium verdict did not converge on replay");
	}
	return {
		graphId: built.graphId,
		operation: "domain.verdict.write",
		verdictId: built.verdictId,
		vocab: DOMAIN_VERDICT_VOCAB,
		projection: "projection:domain-verdict",
		plannedDelta: before,
	};
}

async function assertDeclaredVerdictScope(
	graph: GraphWriter,
	graphId: string,
	record: GenericProjectionRecord,
): Promise<void> {
	if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(graphId)) {
		throw new Error("trusted home graph id is not a valid cloud graph id");
	}
	const domain = stableId(record.domain, "verdict.domain");
	const capabilityId = stableId(record.capabilityId, "verdict.capabilityId");
	const mode = stableId(record.modeId, "verdict.mode");
	const role = stableId(record.roleId, "verdict.role");
	const projection = `urn:mnemosyne:local:graph:${graphId}:projection:domain-manifest`;
	const query = `PREFIX domain: <${DOMAIN_NS}>
ASK {
  GRAPH <${projection}> {
    ?manifest a domain:DomainManifest ; domain:hasCapability ?claim .
    ?claim a domain:CapabilityClaim ;
      domain:domain ${sparqlText(domain)} ;
      domain:stableId ${sparqlText(capabilityId)} ;
      domain:mode ?modeNode ;
      domain:role ?roleNode .
    ?modeNode domain:stableId ${sparqlText(mode)} .
    ?roleNode domain:stableId ${sparqlText(role)} .
  }
}`;
	const result = await graph.sparqlQuery(graphId, query);
	if (sparqlBoolean(result) !== true) {
		throw new Error("domain verdict scope is not declared by the current manifest projection");
	}
}

function parseVerdictInput(value: unknown): VerdictInput {
	const input = exactRecord(
		value,
		["domain", "capabilityId", "mode", "role", "targetSha256", "outcome", "evidence", "reason"],
		"arguments.verdict",
	);
	const domain = stableId(input.domain, "verdict.domain");
	const capabilityId = stableId(input.capabilityId, "verdict.capabilityId");
	const mode = stableId(input.mode, "verdict.mode");
	const role = stableId(input.role, "verdict.role");
	const targetSha256 = requiredText(input.targetSha256, "verdict.targetSha256");
	if (!SHA256.test(targetSha256)) throw new Error("verdict.targetSha256 must be lowercase sha256");
	const outcome = requiredText(input.outcome, "verdict.outcome");
	if (!OUTCOMES.has(outcome)) throw new Error("verdict.outcome must be PASS, FAIL, or BLOCKED");
	if (!Array.isArray(input.evidence) || input.evidence.length === 0 || input.evidence.length > 100) {
		throw new Error("verdict.evidence must contain 1..100 content-addressed references");
	}
	const evidence = input.evidence.map((entry, index) => parseEvidence(entry, index));
	const reason = optionalText(input.reason, "verdict.reason");
	return {
		domain,
		capabilityId,
		mode,
		role,
		targetSha256,
		outcome: outcome as VerdictInput["outcome"],
		evidence,
		reason,
	};
}

function parseEvidence(value: unknown, index: number): EvidenceInput {
	const input = exactRecord(value, ["uri", "sha256", "mediaType", "label"], `verdict.evidence[${index}]`);
	const uri = requiredText(input.uri, `verdict.evidence[${index}].uri`);
	try {
		const parsed = new URL(uri);
		if (!parsed.protocol) throw new Error("missing scheme");
	} catch {
		throw new Error(`verdict.evidence[${index}].uri must be absolute`);
	}
	const sha256 = requiredText(input.sha256, `verdict.evidence[${index}].sha256`);
	if (!SHA256.test(sha256)) throw new Error(`verdict.evidence[${index}].sha256 must be lowercase sha256`);
	return {
		uri,
		sha256,
		...(input.mediaType === undefined
			? {}
			: { mediaType: requiredText(input.mediaType, `verdict.evidence[${index}].mediaType`) }),
		...(input.label === undefined ? {} : { label: requiredText(input.label, `verdict.evidence[${index}].label`) }),
	};
}

function projectionDelta(value: unknown): { rdfInsert: number; rdfDelete: number } {
	if (!isRecord(value) || !isRecord(value.summary)) throw new Error("Garden Emporium dry-run omitted summary");
	const rdfInsert = value.summary.rdfInsert;
	const rdfDelete = value.summary.rdfDelete;
	if (!Number.isSafeInteger(rdfInsert) || !Number.isSafeInteger(rdfDelete)) {
		throw new Error("Garden Emporium dry-run returned an invalid RDF delta");
	}
	return { rdfInsert: rdfInsert as number, rdfDelete: rdfDelete as number };
}

function exactRecord(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unexpected.length) throw new Error(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty text`);
	return value;
}

function optionalText(value: unknown, label: string): string | undefined {
	return value === undefined ? undefined : requiredText(value, label);
}

function stableId(value: unknown, label: string): string {
	const text = requiredText(value, label);
	if (!STABLE_ID.test(text)) throw new Error(`${label} must be a stable id`);
	return text;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
	return (
		left.length === right.length && new Set(left).size === left.length && left.every((entry) => right.includes(entry))
	);
}

function digest(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

function sparqlText(value: string): string {
	return JSON.stringify(value);
}

function sparqlBoolean(value: unknown): boolean | undefined {
	if (!isRecord(value)) return undefined;
	const resultType = value.resultType ?? value.result_type;
	if (resultType === "boolean" && typeof value.boolean === "boolean") return value.boolean;
	for (const key of ["structuredContent", "structured_content", "result"] as const) {
		const nested = sparqlBoolean(value[key]);
		if (nested !== undefined) return nested;
	}
	if (typeof value.text === "string") return sparqlBooleanFromText(value.text);
	if (Array.isArray(value.content)) {
		for (const entry of value.content) {
			if (!isRecord(entry) || typeof entry.text !== "string") continue;
			const nested = sparqlBooleanFromText(entry.text);
			if (nested !== undefined) return nested;
		}
	}
	return undefined;
}

function sparqlBooleanFromText(value: string): boolean | undefined {
	try {
		return sparqlBoolean(JSON.parse(value) as unknown);
	} catch {
		return undefined;
	}
}
