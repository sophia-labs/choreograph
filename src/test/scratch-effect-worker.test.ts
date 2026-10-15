import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type AgentToolGrantV1, grantDigest } from "../workflow/agent-tool-grant.js";
import { stableJson } from "../workflow/agent-tool-manifest.js";
import {
	type DomainSourceTurnV1,
	domainSourceTurnDigest,
	domainTriggerDigest,
} from "../workflow/domain-source-turn.js";
import {
	type CommittedDevelopmentTarget,
	type ProposedEffectV1,
	proposedEffectDigest,
	proposedEffectExecutionDigest,
} from "../workflow/proposed-effect.js";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import {
	SCRATCH_RECEIPT_SCHEMA,
	type ScratchEffectHost,
	ScratchEffectWorker,
	type ScratchMaterializationRequestV1,
} from "../workflow/scratch-effect-worker.js";

const AGENT = "agent-7068616e65730002";
const OWNER = "user:ada";
const HOME_GRAPH = "shrubbery-domain";

function sha(value: unknown): string {
	return createHash("sha256")
		.update(typeof value === "string" ? value : stableJson(value))
		.digest("hex");
}

function grant(maxTtlHours = 8): AgentToolGrantV1 {
	return {
		schema: "sophia.agent-toolbelt-grant.v1",
		grantId: "grant-shrub-1",
		subjectAgentId: AGENT,
		issuedBy: "user:platform-steward",
		authorityGraphId: "observatory",
		issuedAt: 1,
		status: "active",
		capabilities: [
			{
				capability: "cell.scratch",
				operations: ["cell.launch", "cell.inspect", "cell.teardown"],
				access: "write",
				approvalPolicy: "ordinary",
				fence: {
					graphIdPrefixes: ["dev-shrub1-"],
					resourcePrefixes: ["sophia-labs/shrubbery"],
					maxPayloadBytes: 1_048_576,
					maxTtlHours,
				},
				quota: { maxPerWave: 2, maxConcurrent: 1 },
			},
		],
		sourceRefs: ["urn:test:grant"],
	};
}

function target(overrides: Partial<CommittedDevelopmentTarget> = {}): CommittedDevelopmentTarget {
	return {
		ownerPrincipal: OWNER,
		repository: "sophia-labs/shrubbery",
		sourceRevision: "a".repeat(40),
		baseBranch: "main",
		branchName: "agent/shrub-1/fix-hoja",
		scratchGraphId: "dev-shrub1-fix-hoja",
		scenarioDigest: "b".repeat(64),
		imageDigest: `sha256:${"c".repeat(64)}`,
		seedDigest: "d".repeat(64),
		ttlHours: 8,
		...overrides,
	};
}

function evidence(currentGrant = grant(), targetValue = target()) {
	const trigger = {
		kind: "shrubbery.finding.fail",
		eventId: "scratch-launch-1",
		developmentTarget: targetValue,
	};
	const sourceRef = "urn:test:scratch:launch:1";
	const sourceTurn: DomainSourceTurnV1 = {
		schema: "sophia.domain-source-turn.v1",
		turnId: `turn:${sha({ ownerPrincipal: OWNER, graphId: HOME_GRAPH, agentId: AGENT, sourceRef })}`,
		sourceRef,
		sourceDigest: sha({ operation: "cell.launch" }),
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
		effectId: "scratch-cell-launch",
		idempotencyKey,
		capability: "cell.scratch",
		operation: "cell.launch",
		arguments: {
			...targetValue,
			resource: targetValue.repository,
			graphId: targetValue.scratchGraphId,
		},
		reason: "replay the exact failing scenario in an ephemeral cell",
		evidenceRefs: [sourceRef],
	};
	return {
		idempotencyKey,
		executionDigest: proposedEffectExecutionDigest(proposal),
		proposalDigest: proposedEffectDigest(proposal),
		runId: "wfr-scratch-launch",
		graphId: HOME_GRAPH,
		agentId: AGENT,
		actorRef: "agent:shrub-1",
		grantId: currentGrant.grantId,
		grantDocumentId: "grant-shrub-1",
		grantAuthorityGraphId: currentGrant.authorityGraphId,
		grantAuthorityOwnerPrincipal: "user:platform-steward",
		grantDigest: grantDigest(currentGrant),
		definitionDigest: "e".repeat(64),
		sourceTurnId: sourceTurn.turnId,
		sourceTurnDigest: domainSourceTurnDigest(sourceTurn),
		sourceOwnerPrincipal: OWNER,
		sourceTurn,
		capability: "cell.scratch",
		operation: "cell.launch",
		proposal,
		trigger,
		effectIndex,
		now: 100,
	};
}

class RecordingHost implements ScratchEffectHost {
	readonly requests: ScratchMaterializationRequestV1[] = [];

	constructor(readonly currentGrant: AgentToolGrantV1) {}

	async readGrant(): Promise<string> {
		return JSON.stringify(this.currentGrant);
	}

	async materialize(request: ScratchMaterializationRequestV1) {
		this.requests.push(structuredClone(request));
		return {
			created: true,
			deleted: false,
			receipt: {
				schema: SCRATCH_RECEIPT_SCHEMA,
				receiptId: `scratch-receipt:${"f".repeat(64)}`,
				requestDigest: "1".repeat(64),
				effectIdempotencyKey: request.proposal.idempotencyKey,
				sourceTurnId: request.sourceTurn.turnId,
				operation: request.operation,
				ownerPrincipal: request.target.ownerPrincipal,
				graphId: request.target.scratchGraphId,
				scratchId: "gardend-s-test-dev-shrub1-fix-hoja",
				repository: request.target.repository,
				sourceRevision: request.target.sourceRevision,
				scenarioDigest: request.target.scenarioDigest,
				imageDigest: request.target.imageDigest,
				seedDigest: request.target.seedDigest,
				ttlHours: request.target.ttlHours,
				invocationId: request.runId,
				state: "ready" as const,
				podUid: "uid-scratch",
				createdAtMs: 200,
				expiresAtMs: 28_800_200,
				observedAtMs: 200,
			},
		};
	}
}

describe("Phanes-standard scratch-cell effect edge", () => {
	it("rereads current authority, materializes once, and persists a content-addressed receipt", async () => {
		const root = mkdtempSync(join(tmpdir(), "scratch-effect-launch-"));
		const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
		const currentGrant = grant();
		const host = new RecordingHost(currentGrant);
		try {
			await runtime.init();
			const offered = evidence(currentGrant);
			await runtime.offerEffectHandoff(offered);
			const worker = new ScratchEffectWorker(runtime, host, undefined, {
				consumer: "scratch-test",
				leaseMs: 1_000,
				now: () => 200,
			});
			assert.equal(await worker.runOnce(), true);
			assert.equal(host.requests.length, 1);
			assert.equal(host.requests[0]?.target.ttlHours, 8);
			assert.equal(host.requests[0]?.target.imageDigest, `sha256:${"c".repeat(64)}`);
			const record = await runtime.getEffectHandoff(offered.idempotencyKey);
			assert.equal(record?.state, "executed");
			assert.deepEqual(record?.completion, {
				schema: "sophia.scratch-effect-completion.v1",
				idempotencyKey: offered.idempotencyKey,
				operation: "cell.launch",
				ownerPrincipal: OWNER,
				graphId: "dev-shrub1-fix-hoja",
				repository: "sophia-labs/shrubbery",
				scenarioDigest: "b".repeat(64),
				imageDigest: `sha256:${"c".repeat(64)}`,
				seedDigest: "d".repeat(64),
				ttlHours: 8,
				created: true,
				deleted: false,
				receipt: (record?.completion as { receipt: unknown }).receipt,
			});
			assert.equal(await worker.runOnce(), false);
		} finally {
			runtime.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("independently refuses a launch whose committed TTL exceeds the current grant fence", async () => {
		const root = mkdtempSync(join(tmpdir(), "scratch-effect-ttl-"));
		const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
		const currentGrant = grant(4);
		const host = new RecordingHost(currentGrant);
		try {
			await runtime.init();
			const offered = evidence(currentGrant, target({ ttlHours: 8 }));
			await runtime.offerEffectHandoff(offered);
			const worker = new ScratchEffectWorker(runtime, host, undefined, {
				consumer: "scratch-test",
				leaseMs: 1_000,
				now: () => 200,
			});
			await worker.runOnce();
			const record = await runtime.getEffectHandoff(offered.idempotencyKey);
			assert.equal(record?.state, "failed-terminal");
			assert.deepEqual(record?.completion, {
				schema: "sophia.scratch-effect-completion.v1",
				code: "grant-ttl-denied",
			});
			assert.equal(host.requests.length, 0);
		} finally {
			runtime.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
