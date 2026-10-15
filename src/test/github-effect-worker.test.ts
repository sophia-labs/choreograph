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
	type GitHubEffectHost,
	GitHubEffectWorker,
	type GitHubFileChangeV1,
} from "../workflow/github-effect-worker.js";
import {
	type CommittedDevelopmentTarget,
	type ProposedEffectV1,
	proposedEffectDigest,
	proposedEffectExecutionDigest,
} from "../workflow/proposed-effect.js";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";

const AGENT = "agent-7068616e65730002";
const OWNER = "user:ada";
const HOME_GRAPH = "shrubbery-domain";
const CONTENT = Buffer.from("export const fixed = true\n");
const CONTENT_SHA = createHash("sha256").update(CONTENT).digest("hex");

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
		authorityGraphId: "observatory",
		issuedAt: 1,
		status: "active",
		capabilities: [
			{
				capability: "github",
				operations: ["branch.push", "pr.open", "pr.comment", "pr.merge"],
				access: "write",
				approvalPolicy: "ordinary",
				operationPolicies: { "pr.open": "notify", "pr.comment": "notify", "pr.merge": "human-always" },
				fence: {
					branchPrefixes: ["agent/shrub-1/"],
					resourcePrefixes: ["sophia-labs/shrubbery"],
					pathPrefixes: ["apps/", "packages/"],
					maxPayloadBytes: 1_048_576,
				},
				quota: { maxPerWave: 8, maxPerDay: 40, maxConcurrent: 1 },
			},
		],
		sourceRefs: ["urn:test:grant"],
		...overrides,
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
		...overrides,
	};
}

function evidence(
	operation: "branch.push" | "pr.open" | "pr.comment" | "pr.merge",
	currentGrant = grant(),
	targetValue = target(),
) {
	const trigger = {
		kind: "shrubbery.finding.fail",
		eventId: `github-${operation}-1`,
		developmentTarget: targetValue,
	};
	const sourceRef = `urn:test:github:${operation}:1`;
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
	const operationArguments: Record<string, unknown> =
		operation === "branch.push"
			? {
					baseSha: targetValue.sourceRevision,
					commitMessage: "Fix the Hoja regression",
					changes: [
						{
							path: "packages/domain-kit/src/fix.ts",
							mode: "100644",
							contentBase64: CONTENT.toString("base64"),
							contentSha256: CONTENT_SHA,
						},
					],
				}
			: operation === "pr.open"
				? { head: targetValue.branchName, base: targetValue.baseBranch, title: "Fix Hoja", body: "Evidence" }
				: operation === "pr.comment"
					? { pullNumber: targetValue.pullNumber, body: "Replay is green" }
					: {
							pullNumber: targetValue.pullNumber,
							expectedHeadSha: targetValue.expectedHeadSha,
							mergeMethod: "squash",
						};
	const proposal: ProposedEffectV1 = {
		schema: "sophia.proposed-effect.v1",
		effectId: `github-${operation}`,
		idempotencyKey,
		capability: "github",
		operation,
		arguments: {
			...operationArguments,
			...targetValue,
			resource: targetValue.repository,
			branch: targetValue.branchName,
		},
		reason: `exercise GitHub ${operation}`,
		evidenceRefs: [sourceRef],
	};
	const proposalDigest = proposedEffectDigest(proposal);
	return {
		idempotencyKey,
		executionDigest: proposedEffectExecutionDigest(proposal),
		proposalDigest,
		runId: `wfr-github-${operation}`,
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
		capability: "github",
		operation,
		proposal,
		trigger,
		...(operation === "pr.merge"
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

class RecordingHost implements GitHubEffectHost {
	readonly pushes: Array<{
		target: CommittedDevelopmentTarget;
		idempotencyKey: string;
		message: string;
		changes: readonly GitHubFileChangeV1[];
	}> = [];
	readonly merges: unknown[] = [];

	constructor(readonly currentGrant: AgentToolGrantV1) {}

	async readGrant(): Promise<string> {
		return JSON.stringify(this.currentGrant);
	}

	async pushBranch(input: (typeof this.pushes)[number]) {
		this.pushes.push(structuredClone(input));
		return { headSha: "c".repeat(40), url: "https://github.com/sophia-labs/shrubbery/commit/c" };
	}

	async openPullRequest() {
		return { pullNumber: 42, headSha: "c".repeat(40), url: "https://github.com/sophia-labs/shrubbery/pull/42" };
	}

	async commentPullRequest() {
		return { pullNumber: 42, url: "https://github.com/sophia-labs/shrubbery/pull/42#issuecomment-1" };
	}

	async mergePullRequest(input: unknown) {
		this.merges.push(structuredClone(input));
		return { pullNumber: 42, headSha: "c".repeat(40), merged: true as const };
	}
}

describe("Phanes-standard durable GitHub effect edge", () => {
	it("rereads the current grant, validates content, executes once, and persists a content-free receipt", async () => {
		const root = mkdtempSync(join(tmpdir(), "github-effect-push-"));
		const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
		const currentGrant = grant();
		const host = new RecordingHost(currentGrant);
		try {
			await runtime.init();
			const offered = evidence("branch.push", currentGrant);
			await runtime.offerEffectHandoff(offered);
			const worker = new GitHubEffectWorker(runtime, host, undefined, {
				consumer: "github-test",
				leaseMs: 1_000,
				now: () => 200,
			});
			assert.equal(await worker.runOnce(), true);
			const record = await runtime.getEffectHandoff(offered.idempotencyKey);
			assert.equal(record?.state, "executed");
			assert.equal(host.pushes.length, 1);
			assert.equal(host.pushes[0]?.target.repository, "sophia-labs/shrubbery");
			assert.equal(host.pushes[0]?.changes[0]?.contentSha256, CONTENT_SHA);
			assert.deepEqual(record?.completion, {
				schema: "sophia.github-effect-completion.v1",
				idempotencyKey: offered.idempotencyKey,
				operation: "branch.push",
				repository: "sophia-labs/shrubbery",
				branchName: "agent/shrub-1/fix-hoja",
				scenarioDigest: "b".repeat(64),
				headSha: "c".repeat(40),
				url: "https://github.com/sophia-labs/shrubbery/commit/c",
			});
			assert.equal(await worker.runOnce(), false);
		} finally {
			runtime.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails terminally before a credentialed call when the current grant bytes drift", async () => {
		const root = mkdtempSync(join(tmpdir(), "github-effect-grant-drift-"));
		const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
		const witnessed = grant();
		const host = new RecordingHost(grant({ issuedAt: 2 }));
		try {
			await runtime.init();
			const offered = evidence("branch.push", witnessed);
			await runtime.offerEffectHandoff(offered);
			const worker = new GitHubEffectWorker(runtime, host, undefined, {
				consumer: "github-test",
				leaseMs: 1_000,
				now: () => 200,
			});
			await worker.runOnce();
			const record = await runtime.getEffectHandoff(offered.idempotencyKey);
			assert.equal(record?.state, "failed-terminal");
			assert.deepEqual(record?.completion, {
				schema: "sophia.github-effect-completion.v1",
				code: "grant-digest-changed",
			});
			assert.equal(host.pushes.length, 0);
		} finally {
			runtime.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("independently refuses a merge handoff with no persisted human approval", async () => {
		const root = mkdtempSync(join(tmpdir(), "github-effect-merge-approval-"));
		const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
		const currentGrant = grant();
		const host = new RecordingHost(currentGrant);
		try {
			await runtime.init();
			const offered = evidence(
				"pr.merge",
				currentGrant,
				target({ pullNumber: 42, expectedHeadSha: "c".repeat(40) }),
			);
			await runtime.offerEffectHandoff({ ...offered, approval: undefined });
			const worker = new GitHubEffectWorker(runtime, host, undefined, {
				consumer: "github-test",
				leaseMs: 1_000,
				now: () => 200,
			});
			await worker.runOnce();
			const record = await runtime.getEffectHandoff(offered.idempotencyKey);
			assert.equal(record?.state, "failed-terminal");
			assert.deepEqual(record?.completion, {
				schema: "sophia.github-effect-completion.v1",
				code: "github-human-approval-required",
			});
			assert.equal(host.merges.length, 0);
		} finally {
			runtime.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
