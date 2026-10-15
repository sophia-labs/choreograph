import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { AGENT_TOOL_GRANT_SCHEMA, type AgentToolGrantV1 } from "../workflow/agent-tool-grant.js";
import { stableJson } from "../workflow/agent-tool-manifest.js";
import {
	buildDomainVerdictEffectRequest,
	DOMAIN_VERDICT_CAPABILITY,
	DOMAIN_VERDICT_OPERATION,
} from "../workflow/domain-verdict-effect.js";
import type { GenericIngestRequest } from "../workflow/emporium-ingest.js";
import { documentUri, type GraphDocumentRead, type GraphWriter } from "../workflow/graph-writer.js";
import {
	executeProposedEffects,
	GraphProposedEffectExecutor,
	InMemoryEffectIdempotencyStore,
	PROPOSED_EFFECT_SCHEMA,
	type ProposedEffectV1,
} from "../workflow/proposed-effect.js";

const AGENT_ID = "agent-7368727562620001";
const EVIDENCE_SHA = "b".repeat(64);
const TARGET_SHA = "a".repeat(64);

class VerdictGraph implements GraphWriter {
	readonly ingests: GenericIngestRequest[] = [];
	readonly queries: string[] = [];
	private applied = false;
	constructor(private readonly scopeDeclared = true) {}

	async emporiumIngest(_graphId: string, request: GenericIngestRequest): Promise<unknown> {
		this.ingests.push(request);
		if (request.dry_run) {
			return { summary: { rdfInsert: this.applied ? 0 : request.payload.records.length * 4, rdfDelete: 0 } };
		}
		this.applied = true;
		return { ok: true };
	}

	async sparqlUpdate(): Promise<void> {}
	async sparqlQuery(_graphId: string, query: string): Promise<unknown> {
		this.queries.push(query);
		return { structuredContent: { resultType: "boolean", boolean: this.scopeDeclared } };
	}
	async searchDocuments(): Promise<[]> {
		return [];
	}
	async readDocument(graphId: string, documentId: string): Promise<GraphDocumentRead> {
		return { graphId, documentId, documentUri: documentUri(documentId), format: "markdown", blocks: [], raw: {} };
	}
	async writeDocument(): Promise<unknown> {
		return {};
	}
}

function grant(): AgentToolGrantV1 {
	return {
		schema: AGENT_TOOL_GRANT_SCHEMA,
		grantId: "grant-shrub-1",
		subjectAgentId: AGENT_ID,
		issuedBy: "user:platform-steward",
		authorityGraphId: "observatory",
		issuedAt: 1,
		status: "active",
		capabilities: [
			{
				capability: DOMAIN_VERDICT_CAPABILITY,
				operations: [DOMAIN_VERDICT_OPERATION],
				access: "write",
				approvalPolicy: "ordinary",
				fence: {
					graphIds: ["shrubbery-domain"],
					resourcePrefixes: ["domain:shrub:"],
					maxPayloadBytes: 262_144,
				},
				quota: { maxPerWave: 8 },
			},
		],
		sourceRefs: ["urn:sophia:review:domain-agent-grant:shrub-1"],
	};
}

function proposal(overrides: Partial<ProposedEffectV1> = {}): ProposedEffectV1 {
	return {
		schema: PROPOSED_EFFECT_SCHEMA,
		effectId: "verdict-1",
		idempotencyKey: "sandbox-hint-only",
		capability: DOMAIN_VERDICT_CAPABILITY,
		operation: DOMAIN_VERDICT_OPERATION,
		arguments: {
			resource: "domain:shrub:verdict",
			graphId: "shrubbery-domain",
			verdict: {
				domain: "shrub",
				capabilityId: "ACC-CAP-EDIT-001",
				mode: "local-cell",
				role: "local-owner",
				targetSha256: TARGET_SHA,
				outcome: "PASS",
				evidence: [
					{
						uri: `s3://sophia-evidence/sha256/${EVIDENCE_SHA}`,
						sha256: EVIDENCE_SHA,
						mediaType: "application/zip",
					},
				],
			},
		},
		reason: "File the scoped result returned by the acceptance instrument.",
		evidenceRefs: [`s3://sophia-evidence/sha256/${EVIDENCE_SHA}`],
		...overrides,
	};
}

function context() {
	const sourceRef = "urn:shrubbery:acceptance:tick:1";
	const trigger = { kind: "shrubbery.acceptance.tick", eventId: "tick-1" };
	const turnId = `turn:${createHash("sha256")
		.update(
			stableJson({
				ownerPrincipal: "user:specialist",
				graphId: "shrubbery-domain",
				agentId: AGENT_ID,
				sourceRef,
			}),
		)
		.digest("hex")}`;
	return {
		runId: "wfr-shrub-1",
		graphId: "shrubbery-domain",
		agentId: AGENT_ID,
		actorRef: "agent:domain-trigger",
		sourceTurn: {
			schema: "sophia.domain-source-turn.v1" as const,
			turnId,
			sourceRef,
			sourceDigest: "2".repeat(64),
			triggerDigest: createHash("sha256").update(stableJson(trigger)).digest("hex"),
			contextDigest: "4".repeat(64),
			target: { ownerPrincipal: "user:specialist", graphId: "shrubbery-domain" },
			agentId: AGENT_ID,
			actorRef: "agent:domain-trigger",
			ingress: { authMethod: "owner" as const },
			committedAt: 1,
		},
		trigger,
		grant: grant(),
		now: () => Date.parse("2026-08-03T12:00:00.000Z"),
	};
}

describe("Domain Verdict host effect", () => {
	it("derives authority fields and converges through Garden Emporium", async () => {
		const graph = new VerdictGraph();
		const receipts = await executeProposedEffects({
			proposals: [proposal()],
			context: context(),
			executor: new GraphProposedEffectExecutor(graph),
			idempotency: new InMemoryEffectIdempotencyStore(),
		});

		assert.equal(receipts[0]?.outcome, "executed");
		assert.equal(graph.queries.length, 1);
		assert.match(graph.queries[0]!, /projection:domain-manifest/);
		assert.match(graph.queries[0]!, /domain:stableId "ACC-CAP-EDIT-001"/);
		assert.deepEqual(
			graph.ingests.map((request) => request.dry_run),
			[true, false, true],
		);
		const applied = graph.ingests[1]!;
		assert.equal(applied.vocab, "sophia-domain-verdict");
		assert.equal(applied.replace_class, false);
		const verdict = applied.payload.records.find((record) => record.kind === "Verdict")!;
		assert.match(verdict.localId, /^urn:sophia:domain:shrub:verdict:[0-9a-f]{64}$/);
		assert.equal(verdict.asOf, "2026-08-03T12:00:00.000Z");
		assert.equal(verdict.agentSession, `urn:sophia:agent:${AGENT_ID}:session:wfr-shrub-1`);
		assert.equal(verdict.outcome, "http://sophia.ai/domain#PASS");
		const evidence = applied.payload.records.find((record) => record.kind === "EvidenceRef")!;
		assert.match(evidence.localId, /^urn:sophia:domain:evidence:[0-9a-f]{64}$/);
		assert.equal(evidence.hash, evidence.localId.slice(-64));
		assert.equal("verdictId" in (proposal().arguments.verdict as object), false);
	});

	it("binds domain and graph to the grant before the projection adapter runs", async () => {
		const graph = new VerdictGraph();
		const escaped = proposal({
			arguments: {
				...(proposal().arguments as Record<string, unknown>),
				resource: "domain:platform:verdict",
			},
		});
		const receipts = await executeProposedEffects({
			proposals: [escaped],
			context: context(),
			executor: new GraphProposedEffectExecutor(graph),
			idempotency: new InMemoryEffectIdempotencyStore(),
		});
		assert.equal(receipts[0]?.outcome, "denied");
		assert.equal(receipts[0]?.decisionCode, "resource-fence-denied");
		assert.equal(graph.ingests.length, 0);
	});

	it("rejects sandbox attempts to supply host-owned verdict fields", () => {
		const raw = proposal();
		const verdict = raw.arguments.verdict as Record<string, unknown>;
		assert.throws(
			() =>
				buildDomainVerdictEffectRequest(
					{
						...raw,
						arguments: { ...raw.arguments, verdict: { ...verdict, asOf: "2099-01-01T00:00:00Z" } },
					},
					context(),
				),
			/unsupported fields: asOf/,
		);
	});

	it("rejects ambiguous graph aliases and undeclared manifest scopes", async () => {
		const raw = proposal();
		assert.throws(
			() =>
				buildDomainVerdictEffectRequest(
					{ ...raw, arguments: { ...raw.arguments, graph_id: "shrubbery-domain" } },
					context(),
				),
			/both graphId and graph_id/,
		);

		const graph = new VerdictGraph(false);
		const receipts = await executeProposedEffects({
			proposals: [proposal()],
			context: context(),
			executor: new GraphProposedEffectExecutor(graph),
			idempotency: new InMemoryEffectIdempotencyStore(),
		});
		assert.equal(receipts[0]?.outcome, "error");
		assert.match(receipts[0]?.error ?? "", /scope is not declared/);
		assert.equal(graph.ingests.length, 0);
	});
});
