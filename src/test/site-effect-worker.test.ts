import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { CaptureEmitter, ChoreographCaptureEvent } from "../observatory-capture.js";
import { type AgentToolGrantV1, grantDigest } from "../workflow/agent-tool-grant.js";
import { stableJson } from "../workflow/agent-tool-manifest.js";
import {
	type DomainSourceTurnV1,
	domainSourceTurnDigest,
	domainTriggerDigest,
} from "../workflow/domain-source-turn.js";
import type { GenericIngestRequest } from "../workflow/emporium-ingest.js";
import type { GraphDocumentRead, GraphWriter } from "../workflow/graph-writer.js";
import {
	type ProposedEffectV1,
	proposedEffectDigest,
	proposedEffectExecutionDigest,
} from "../workflow/proposed-effect.js";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import {
	REVIEWED_GARDEN_SITE_BUNDLE,
	SiteEffectExecutor,
	type SiteEffectHost,
	SiteEffectWorker,
	type SiteMaterializationRequestV1,
} from "../workflow/site-effect-worker.js";

const AGENT = "agent-7068616e65730002";
const OWNER = "user:ada";
const HOME_GRAPH = "shrubbery-domain";
const TARGET_GRAPH = "shrubbery-preview";

function sha(value: unknown): string {
	return createHash("sha256")
		.update(typeof value === "string" ? value : stableJson(value))
		.digest("hex");
}

function grant(overrides: Partial<AgentToolGrantV1> = {}): AgentToolGrantV1 {
	return {
		schema: "sophia.agent-toolbelt-grant.v1",
		grantId: "grant-shrub-1",
		subjectAgentId: AGENT,
		issuedBy: "user:platform-steward",
		authorityGraphId: "platform-domain",
		issuedAt: 1,
		status: "active",
		capabilities: [
			{
				capability: "site",
				operations: ["mint", "update", "publish", "retire"],
				access: "write",
				approvalPolicy: "ordinary",
				operationPolicies: { publish: "human-always", retire: "human-always" },
				fence: {
					graphIdPrefixes: ["shrubbery-"],
					resourcePrefixes: ["shrubbery"],
					pathPrefixes: ["/"],
					maxPayloadBytes: 16_384,
				},
				quota: { maxPerWave: 4 },
			},
		],
		sourceRefs: ["urn:test:grant"],
		...overrides,
	};
}

function evidence(operation: "mint" | "update" | "publish" | "retire", currentGrant = grant()) {
	const trigger = {
		kind: "site.request",
		eventId: `site-${operation}-1`,
		siteTarget: {
			ownerPrincipal: OWNER,
			graphId: TARGET_GRAPH,
			publicName: "shrubbery-preview",
			pathPrefix: "/",
		},
	};
	const sourceRef = `urn:test:site:${operation}:1`;
	const sourceTurn: DomainSourceTurnV1 = {
		schema: "sophia.domain-source-turn.v1",
		turnId: `turn:${sha({ ownerPrincipal: OWNER, graphId: HOME_GRAPH, agentId: AGENT, sourceRef })}`,
		sourceRef,
		sourceDigest: sha({ operation }),
		triggerDigest: domainTriggerDigest(trigger),
		contextDigest: sha([]),
		target: { ownerPrincipal: OWNER, graphId: HOME_GRAPH },
		agentId: AGENT,
		actorRef: "agent:shrub-1",
		ingress: { authMethod: "owner" },
		committedAt: 10,
	};
	const effectIndex = 0;
	const idempotencyKey = `effect:${sha({ sourceTurnId: sourceTurn.turnId, effectIndex })}`;
	const proposal: ProposedEffectV1 = {
		schema: "sophia.proposed-effect.v1",
		effectId: `site-${operation}`,
		idempotencyKey,
		capability: "site",
		operation,
		arguments: {
			...(operation === "mint" ? { title: "Shrubbery Preview" } : {}),
			...(operation === "update"
				? {
						records: [
							{
								kind: "Surface",
								localId: "workspace",
								label: "Workspace",
								workspace: "http://sophia.ai/ux#GardenDefault",
							},
						],
					}
				: {}),
			...trigger.siteTarget,
		},
		reason: `exercise site ${operation}`,
		evidenceRefs: [sourceRef],
	};
	const proposalDigest = proposedEffectDigest(proposal);
	return {
		idempotencyKey,
		executionDigest: proposedEffectExecutionDigest(proposal),
		proposalDigest,
		runId: `wfr-site-${operation}`,
		graphId: HOME_GRAPH,
		agentId: AGENT,
		actorRef: "agent:shrub-1",
		grantId: currentGrant.grantId,
		grantDocumentId: "grant-shrub-1",
		grantAuthorityGraphId: currentGrant.authorityGraphId,
		grantAuthorityOwnerPrincipal: "user:platform-steward",
		grantDigest: grantDigest(currentGrant),
		definitionDigest: "d".repeat(64),
		sourceTurnId: sourceTurn.turnId,
		sourceTurnDigest: domainSourceTurnDigest(sourceTurn),
		sourceOwnerPrincipal: OWNER,
		sourceTurn,
		capability: "site",
		operation,
		proposal,
		trigger,
		...(operation === "publish" || operation === "retire"
			? {
					approval: {
						effectId: proposal.effectId,
						grantId: currentGrant.grantId,
						proposalDigest,
						approvedBy: OWNER,
						approvedAt: 20,
					},
				}
			: {}),
		effectIndex,
		now: 100,
	};
}

class RecordingGraph implements GraphWriter {
	readonly ingests: GenericIngestRequest[] = [];

	async sparqlUpdate(): Promise<void> {}

	async sparqlQuery(): Promise<unknown> {
		const bundle = REVIEWED_GARDEN_SITE_BUNDLE;
		return {
			rows: [
				{
					definition: {
						type: "iri",
						value: `urn:mnemosyne:local:graph:${TARGET_GRAPH}:projection:site:definition:garden`,
					},
					bundleId: { type: "literal", value: bundle.bundleId },
					bundleVersion: { type: "literal", value: bundle.bundleVersion },
					package: { type: "literal", value: bundle.packageName },
					version: { type: "literal", value: bundle.version },
					layoutSha: { type: "literal", value: bundle.layoutSeedSha256 },
				},
			],
		};
	}

	async searchDocuments(): Promise<[]> {
		return [];
	}

	async readDocument(): Promise<GraphDocumentRead> {
		throw new Error("not used");
	}

	async writeDocument(): Promise<unknown> {
		return {};
	}

	async emporiumIngest(_graphId: string, request: GenericIngestRequest): Promise<unknown> {
		this.ingests.push(structuredClone(request));
		return { ok: true, summary: { rdfInsert: request.dry_run ? 1 : 0, rdfDelete: 0 } };
	}
}

class RecordingHost implements SiteEffectHost {
	readonly target = new RecordingGraph();
	readonly registry = new RecordingGraph();
	readonly creates: unknown[] = [];
	readonly materializations: SiteMaterializationRequestV1[] = [];

	constructor(readonly currentGrant: AgentToolGrantV1) {}

	async readGrant(): Promise<string> {
		return JSON.stringify(this.currentGrant);
	}

	async ensureGraph(input: unknown): Promise<unknown> {
		this.creates.push(input);
		return { created: true };
	}

	async targetGraph(): Promise<GraphWriter> {
		return this.target;
	}

	async routeRegistryGraph(): Promise<{ graphId: string; writer: GraphWriter }> {
		return { graphId: "platform-domain", writer: this.registry };
	}

	async materialize(_ownerPrincipal: string, request: SiteMaterializationRequestV1): Promise<unknown> {
		this.materializations.push(structuredClone(request));
		return { receipt: { receiptId: `receipt:${request.proposal.idempotencyKey}` } };
	}
}

class RecordingCapture implements CaptureEmitter {
	readonly events: ChoreographCaptureEvent[] = [];

	emit(event: ChoreographCaptureEvent): void {
		this.events.push(structuredClone(event));
	}
}

describe("Phanes-standard durable site effect edge", () => {
	it("mints through Garden dry-run/apply/replay and Platform materialization, then persists one receipt", async () => {
		const root = mkdtempSync(join(tmpdir(), "site-effect-mint-"));
		const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
		const currentGrant = grant();
		const host = new RecordingHost(currentGrant);
		const capture = new RecordingCapture();
		try {
			await runtime.init();
			const offered = evidence("mint", currentGrant);
			await runtime.offerEffectHandoff(offered);
			const worker = new SiteEffectWorker(runtime, host, new SiteEffectExecutor(host), {
				consumer: "site-test",
				leaseMs: 1_000,
				now: () => 200,
				capture,
			});
			assert.equal(await worker.runOnce(), true);

			const record = await runtime.getEffectHandoff(offered.idempotencyKey);
			assert.equal(record?.state, "executed");
			assert.equal(host.creates.length, 1);
			assert.equal(host.target.ingests.length, 3, "site seed crosses dry-run/apply/replay");
			assert.equal(host.registry.ingests.length, 3, "route intent crosses dry-run/apply/replay");
			assert.equal(host.materializations.length, 1);
			assert.equal(host.materializations[0]?.route.ownerPrincipal, OWNER);
			assert.equal(host.materializations[0]?.route.graphId, TARGET_GRAPH);
			assert.equal(host.materializations[0]?.proposal.idempotencyKey, offered.idempotencyKey);
			assert.match(host.materializations[0]?.interpreter.siteDefinitionDigest ?? "", /^[0-9a-f]{64}$/);
			assert.deepEqual(
				capture.events.map((event) => event.kind),
				["site.mint", "site.route"],
			);
			for (const event of capture.events) {
				assert.equal(event.graphId, TARGET_GRAPH);
				assert.equal(event.onBehalfOf, OWNER);
				if (!event.kind.startsWith("site.")) continue;
				assert.equal(event.payload.effectKey, offered.idempotencyKey);
				assert.equal(event.payload.sourceTurnDigest, offered.sourceTurnDigest);
				assert.equal(event.payload.grantDigest, offered.grantDigest);
				assert.match(event.payload.interpreterDigest ?? "", /^[0-9a-f]{64}$/);
			}
			assert.equal(await worker.runOnce(), false, "executed work is not claimable again");
		} finally {
			runtime.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("carries the persisted human witness across the host boundary for publish", async () => {
		const root = mkdtempSync(join(tmpdir(), "site-effect-publish-"));
		const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
		const currentGrant = grant();
		const host = new RecordingHost(currentGrant);
		const capture = new RecordingCapture();
		try {
			await runtime.init();
			const offered = evidence("publish", currentGrant);
			await runtime.offerEffectHandoff(offered);
			const worker = new SiteEffectWorker(runtime, host, undefined, {
				consumer: "site-test",
				leaseMs: 1_000,
				now: () => 200,
				capture,
			});
			await worker.runOnce();
			assert.equal(host.creates.length, 0);
			assert.equal(host.materializations[0]?.approval?.approvedBy, OWNER);
			assert.equal(host.materializations[0]?.approval?.proposalDigest, offered.proposalDigest);
			const route = host.registry.ingests[1]?.payload.records[0];
			assert.equal(route?.publicationState, "published");
			assert.equal(route?.approvedBy, OWNER);
			assert.deepEqual(
				capture.events.map((event) => event.kind),
				["site.publish", "site.route"],
			);
		} finally {
			runtime.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails terminally if the current steward grant bytes changed after handoff", async () => {
		const root = mkdtempSync(join(tmpdir(), "site-effect-grant-drift-"));
		const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
		const witnessed = grant();
		const changed = grant({ issuedAt: 2 });
		const host = new RecordingHost(changed);
		const capture = new RecordingCapture();
		try {
			await runtime.init();
			const offered = evidence("mint", witnessed);
			await runtime.offerEffectHandoff(offered);
			const worker = new SiteEffectWorker(runtime, host, undefined, {
				consumer: "site-test",
				leaseMs: 1_000,
				now: () => 200,
				capture,
			});
			await worker.runOnce();
			const record = await runtime.getEffectHandoff(offered.idempotencyKey);
			assert.equal(record?.state, "failed-terminal");
			assert.deepEqual(record?.completion, {
				schema: "sophia.site-effect-completion.v1",
				code: "grant-digest-changed",
			});
			assert.equal(host.creates.length, 0);
			assert.equal(host.materializations.length, 0);
			assert.equal(capture.events.length, 1);
			const event = capture.events[0];
			assert.equal(event?.kind, "site.mint");
			assert.equal(event?.outcome, "error");
			if (event?.kind === "site.mint") assert.equal(event.payload.reasonCode, "grant-digest-changed");
		} finally {
			runtime.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses update records that try to seize host-owned route or interpreter authority", async () => {
		const currentGrant = grant();
		const host = new RecordingHost(currentGrant);
		const offered = evidence("update", currentGrant);
		const proposal = offered.proposal as ProposedEffectV1;
		const escaped: ProposedEffectV1 = {
			...proposal,
			arguments: {
				...proposal.arguments,
				records: [{ kind: "SiteDefinition", localId: "attacker", interpreterVersion: "latest" }],
			},
		};
		const record = {
			...offered,
			proposal: escaped,
			executionDigest: proposedEffectExecutionDigest(escaped),
			state: "claimed" as const,
			attempt: 1,
			consumer: "site-test",
			claim_token: "claim",
			lease_expires_at: 1_000,
			not_before: 0,
			completion: null,
			created_at: 0,
			updated_at: 0,
			completed_at: null,
			idempotency_key: offered.idempotencyKey,
			execution_digest: proposedEffectExecutionDigest(escaped),
			proposal_digest: offered.proposalDigest,
			run_id: offered.runId,
			graph_id: offered.graphId,
			agent_id: offered.agentId,
			actor_ref: offered.actorRef,
			grant_id: offered.grantId,
			grant_document_id: offered.grantDocumentId,
			grant_authority_graph_id: offered.grantAuthorityGraphId,
			grant_authority_owner_principal: offered.grantAuthorityOwnerPrincipal,
			grant_digest: offered.grantDigest,
			definition_digest: offered.definitionDigest,
			source_turn_id: offered.sourceTurnId,
			source_turn_digest: offered.sourceTurnDigest,
			source_owner_principal: offered.sourceOwnerPrincipal,
			source_turn: offered.sourceTurn,
			capability: offered.capability,
			operation: offered.operation,
			trigger: offered.trigger,
			approval: null,
			effect_index: offered.effectIndex,
		};
		await assert.rejects(
			() =>
				new SiteEffectExecutor(host).execute(record as never, {
					grant: currentGrant,
					digest: grantDigest(currentGrant),
				}),
			(error: unknown) => error instanceof Error && error.message.includes("site-update-records-invalid"),
		);
	});
});
