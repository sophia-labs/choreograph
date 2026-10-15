import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	AGENT_TOOL_GRANT_SCHEMA,
	type AgentToolGrantV1,
	assertGrantedToolbelt,
	parseAgentToolGrant,
	parseAgentToolManifest,
	reconcileToolbeltWithGrant,
} from "../workflow/agent-tool-grant.js";
import { buildLearner1ToolManifest, stableJson } from "../workflow/agent-tool-manifest.js";
import { documentUri, type GraphDocumentRead, type GraphWriter } from "../workflow/graph-writer.js";
import {
	authoritativeEffectIdempotencyKey,
	type CommittedPlatformReleaseTarget,
	executeProposedEffects,
	GraphProposedEffectExecutor,
	InMemoryEffectIdempotencyStore,
	PROPOSED_EFFECT_SCHEMA,
	type ProposedEffectExecutor,
	type ProposedEffectV1,
	proposedEffectDigest,
	RuntimeEffectHandoffStore,
	RuntimeEffectIdempotencyStore,
} from "../workflow/proposed-effect.js";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import { finalizeDomainAgentActivityRun } from "../workflow/script-domain-agent-activity-loop.js";
import type { RunRecord } from "../workflow/types.js";
import { phanesPrivacyFixture } from "./phanes-privacy-fixture.js";

class RecordingGraph implements GraphWriter {
	readonly updates: Array<{ graphId: string; update: string }> = [];
	readonly documents: Array<{ graphId: string; documentId: string; content: string }> = [];
	async sparqlUpdate(graphId: string, update: string): Promise<void> {
		this.updates.push({ graphId, update });
	}
	async sparqlQuery(): Promise<unknown> {
		return {};
	}
	async searchDocuments(): Promise<[]> {
		return [];
	}
	async readDocument(graphId: string, documentId: string): Promise<GraphDocumentRead> {
		return {
			graphId,
			documentId,
			documentUri: documentUri(documentId),
			format: "markdown",
			blocks: [],
			raw: {},
		};
	}
	async writeDocument(graphId: string, documentId: string, content: string): Promise<unknown> {
		this.documents.push({ graphId, documentId, content });
		return { documentId };
	}
}

class RecordingEffectExecutor implements ProposedEffectExecutor {
	readonly effects: ProposedEffectV1[] = [];
	async execute(effect: ProposedEffectV1): Promise<unknown> {
		this.effects.push(effect);
		return { accepted: true };
	}
}

const AGENT_ID = "agent-7068616e65730001";
const DEFAULT_TRIGGER = {
	kind: "phanes.manual.request",
	eventId: "manual-1",
	resource: "graph:phanes:manual-1",
} as const;

function grant(overrides: Partial<AgentToolGrantV1> = {}): AgentToolGrantV1 {
	return {
		schema: AGENT_TOOL_GRANT_SCHEMA,
		grantId: "grant-phanes-1",
		subjectAgentId: AGENT_ID,
		issuedBy: "user:platform-steward",
		authorityGraphId: "observatory",
		issuedAt: 1,
		status: "active",
		capabilities: [
			{
				capability: "mnemosyne",
				operations: ["recall", "search_documents", "remember", "sparql_update", "write_document"],
				access: "write",
				approvalPolicy: "ordinary",
				fence: { graphIds: ["phanes"], maxPayloadBytes: 16_384 },
				quota: { maxPerWave: 2 },
			},
		],
		sourceRefs: ["urn:sophia:grant-review:1"],
		...overrides,
	};
}

function effect(overrides: Partial<ProposedEffectV1> = {}): ProposedEffectV1 {
	return {
		schema: PROPOSED_EFFECT_SCHEMA,
		effectId: "effect-1",
		idempotencyKey: "phanes:message:1:response",
		capability: "mnemosyne",
		operation: "write_document",
		arguments: { graphId: "phanes", documentId: "reply-1", content: "Witnessed reply" },
		reason: "Persist the response selected by the activity wave.",
		evidenceRefs: ["urn:phanes:discord:message:1"],
		...overrides,
	};
}

function context(grantValue: AgentToolGrantV1, trigger: Readonly<Record<string, unknown>> = DEFAULT_TRIGGER) {
	const sourceRef = "urn:phanes:discord:source-event:1";
	const turnId = `turn:${createHash("sha256")
		.update(
			stableJson({
				ownerPrincipal: "user:ada",
				graphId: "phanes",
				agentId: AGENT_ID,
				sourceRef,
			}),
		)
		.digest("hex")}`;
	return {
		runId: "wfr-phanes-1",
		graphId: "phanes",
		agentId: AGENT_ID,
		actorRef: "agent:phanes-listener",
		sourceTurn: {
			schema: "sophia.domain-source-turn.v1" as const,
			turnId,
			sourceRef,
			sourceDigest: "2".repeat(64),
			triggerDigest: createHash("sha256").update(stableJson(trigger)).digest("hex"),
			contextDigest: "4".repeat(64),
			target: { ownerPrincipal: "user:ada", graphId: "phanes" },
			agentId: AGENT_ID,
			actorRef: "agent:phanes-listener",
			ingress: { authMethod: "internal-service" as const, adapter: "discord" },
			committedAt: 1,
		},
		trigger,
		grant: grantValue,
		now: () => 100,
	};
}

describe("Phanes-standard proposed-effect host edge", () => {
	it("requires a typed destructive bit on every declared manifest tool", () => {
		const manifest = buildLearner1ToolManifest({
			agentId: AGENT_ID,
			graphId: "phanes",
			ownerUserId: "user:ada",
			now: 1,
		});
		const [first, ...rest] = manifest.tools;
		assert.ok(first);
		const { destructive: _destructive, ...legacyTool } = first;
		assert.throws(
			() => parseAgentToolManifest({ ...manifest, tools: [legacyTool, ...rest] }),
			/needs a destructive boolean/,
		);
	});

	it("executes an ordinary in-fence effect exactly once and returns replay testimony", async () => {
		const graph = new RecordingGraph();
		const idempotency = new InMemoryEffectIdempotencyStore();
		const proposal = effect();
		const first = await executeProposedEffects({
			proposals: [proposal],
			context: context(grant()),
			executor: new GraphProposedEffectExecutor(graph),
			idempotency,
		});
		const replay = await executeProposedEffects({
			proposals: [proposal],
			context: context(grant()),
			executor: new GraphProposedEffectExecutor(graph),
			idempotency,
		});

		assert.equal(first[0]?.outcome, "executed");
		assert.equal(replay[0]?.outcome, "duplicate");
		assert.equal(graph.documents.length, 1);
		assert.deepEqual(graph.documents[0], {
			graphId: "phanes",
			documentId: "reply-1",
			content: "Witnessed reply",
		});
	});

	it("denies an out-of-fence proposal before the executor sees it", async () => {
		const graph = new RecordingGraph();
		const receipts = await executeProposedEffects({
			proposals: [effect({ arguments: { graphId: "sophia-code-lab", documentId: "escape", content: "no" } })],
			context: context(grant()),
			executor: new GraphProposedEffectExecutor(graph),
			idempotency: new InMemoryEffectIdempotencyStore(),
		});
		assert.equal(receipts[0]?.outcome, "denied");
		assert.equal(receipts[0]?.decisionCode, "graph-fence-denied");
		assert.equal(graph.documents.length, 0);
	});

	it("holds human-always effects pending and does not mistake proposal for permission", async () => {
		const graph = new RecordingGraph();
		const idempotency = new InMemoryEffectIdempotencyStore();
		const humanGrant = grant({
			capabilities: [{ ...grant().capabilities[0], approvalPolicy: "human-always" }],
		});
		const receipts = await executeProposedEffects({
			proposals: [effect()],
			context: context(humanGrant),
			executor: new GraphProposedEffectExecutor(graph),
			idempotency,
		});
		assert.equal(receipts[0]?.outcome, "pending-approval");
		assert.equal(graph.documents.length, 0);

		const approved = await executeProposedEffects({
			proposals: [effect()],
			context: {
				...context(humanGrant),
				approvals: [
					{
						effectId: "effect-1",
						grantId: humanGrant.grantId,
						proposalDigest: proposedEffectDigest(effect()),
						approvedBy: "user:ada",
						approvedAt: 101,
					},
				],
			},
			executor: new GraphProposedEffectExecutor(graph),
			idempotency,
		});
		assert.equal(approved[0]?.outcome, "executed");
		assert.equal(approved[0]?.decisionCode, "human-approved");
		assert.equal(graph.documents.length, 1);
	});

	it("applies a human boundary to one operation without over-gating its capability siblings", async () => {
		const graph = new RecordingGraph();
		const splitGrant = grant({
			capabilities: [
				{
					...grant().capabilities[0],
					approvalPolicy: "ordinary",
					operationPolicies: { write_document: "human-always" },
				},
			],
		});
		const pending = await executeProposedEffects({
			proposals: [effect()],
			context: context(splitGrant),
			executor: new GraphProposedEffectExecutor(graph),
			idempotency: new InMemoryEffectIdempotencyStore(),
		});
		assert.equal(pending[0]?.outcome, "pending-approval");

		const ordinarySibling = await executeProposedEffects({
			proposals: [
				effect({
					effectId: "effect-2",
					idempotencyKey: "phanes:message:1:triple",
					operation: "sparql_update",
					arguments: { graphId: "phanes", update: "INSERT DATA { <urn:a> <urn:b> <urn:c> }" },
				}),
			],
			context: context(splitGrant),
			executor: new GraphProposedEffectExecutor(graph),
			idempotency: new InMemoryEffectIdempotencyStore(),
		});
		assert.equal(ordinarySibling[0]?.outcome, "executed");
		assert.equal(graph.updates.length, 1);
	});

	it("intersects declared tools with steward authority and fails closed for a required gap", () => {
		const manifest = buildLearner1ToolManifest({
			agentId: AGENT_ID,
			graphId: "phanes",
			ownerUserId: "user:ada",
			now: 1,
		});
		const readOnlyGrant = parseAgentToolGrant({
			...grant(),
			capabilities: [{ ...grant().capabilities[0], access: "read" }],
		});
		const effective = reconcileToolbeltWithGrant({ manifest, grant: readOnlyGrant, now: 10 });
		assert.deepEqual(effective.tools.map((tool) => tool.name).sort(), ["recall", "search_documents"]);
		assert.throws(() => assertGrantedToolbelt(effective), /required declared tools are not authorized/);
	});

	it("requires an exact steward operation for every direct tool", () => {
		const manifest = buildLearner1ToolManifest({
			agentId: AGENT_ID,
			graphId: "phanes",
			ownerUserId: "user:ada",
			now: 1,
		});
		const exactGrant = grant({
			capabilities: [{ ...grant().capabilities[0], operations: ["recall"] }],
		});
		const effective = reconcileToolbeltWithGrant({ manifest, grant: exactGrant, now: 10 });
		assert.deepEqual(
			effective.tools.map((tool) => tool.name),
			["recall"],
		);
		assert.ok(effective.failures.some((failure) => failure.reason === "tool operation is absent from grant"));
		assert.throws(() => assertGrantedToolbelt(effective), /required declared tools are not authorized/);
	});

	it("persists idempotency across host-edge adapter lifetimes in the real libSQL store", async () => {
		const dir = mkdtempSync(join(tmpdir(), "effect-idempotency-"));
		try {
			const runtime = new WorkflowRuntimeStore(join(dir, "runtime.sqlite"));
			await runtime.init();
			const graph = new RecordingGraph();
			const first = await executeProposedEffects({
				proposals: [effect()],
				context: context(grant()),
				executor: new GraphProposedEffectExecutor(graph),
				idempotency: new RuntimeEffectIdempotencyStore(runtime),
			});
			const second = await executeProposedEffects({
				proposals: [effect()],
				context: context(grant()),
				executor: new GraphProposedEffectExecutor(graph),
				idempotency: new RuntimeEffectIdempotencyStore(runtime),
			});
			assert.equal(first[0]?.outcome, "executed");
			assert.equal(second[0]?.outcome, "duplicate");
			assert.equal(graph.documents.length, 1);
			const hostKey = authoritativeEffectIdempotencyKey(context(grant()), 0);
			assert.notEqual(hostKey, effect().idempotencyKey);
			assert.equal((await runtime.getEffectIdempotency(hostKey))?.status, "complete");
			runtime.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("derives idempotency from the trusted trigger and refuses a changed body at the same effect position", async () => {
		const graph = new RecordingGraph();
		const idempotency = new InMemoryEffectIdempotencyStore();
		const triggerContext = {
			...context(grant(), { eventId: "manual-message-1", resource: "graph:phanes:message:1" }),
			runId: "wfr-first-embodiment",
			definitionDigest: "a".repeat(64),
		};
		const first = await executeProposedEffects({
			proposals: [effect({ idempotencyKey: "sandbox-hint-one" })],
			context: triggerContext,
			executor: new GraphProposedEffectExecutor(graph),
			idempotency,
		});
		const replay = await executeProposedEffects({
			proposals: [effect({ idempotencyKey: "sandbox-hint-two" })],
			context: {
				...triggerContext,
				runId: "wfr-second-embodiment",
				definitionDigest: "b".repeat(64),
				grant: grant({ grantId: "grant-phanes-reissued" }),
			},
			executor: new GraphProposedEffectExecutor(graph),
			idempotency,
		});
		const conflict = await executeProposedEffects({
			proposals: [effect({ arguments: { graphId: "phanes", documentId: "reply-1", content: "changed" } })],
			context: { ...triggerContext, runId: "wfr-third-embodiment" },
			executor: new GraphProposedEffectExecutor(graph),
			idempotency,
		});

		assert.equal(first[0]?.outcome, "executed");
		assert.equal(replay[0]?.outcome, "duplicate");
		assert.equal(conflict[0]?.decisionCode, "idempotency-conflict");
		assert.equal(graph.documents.length, 1);
	});

	it("binds Discord execution coordinates to the host-observed turn", async () => {
		const privacy = phanesPrivacyFixture("01ARZ3NDEKTSV4RRFFQ69G5FAV");
		const executor = new RecordingEffectExecutor();
		const discordGrant = grant({
			capabilities: [
				{
					capability: "discord",
					operations: ["message.reply"],
					access: "write",
					approvalPolicy: "ordinary",
					fence: { resourcePrefixes: ["discord-context:"] },
					quota: { maxPerWave: 1 },
				},
			],
		});
		const trigger = privacy.trigger;
		const proposal = effect({
			capability: "discord",
			operation: "message.reply",
			arguments: { text: "The semantic response." },
		});
		const receipts = await executeProposedEffects({
			proposals: [proposal],
			context: context(discordGrant, trigger),
			executor,
			idempotency: new InMemoryEffectIdempotencyStore(),
		});

		assert.equal(receipts[0]?.outcome, "executed");
		assert.equal(executor.effects.length, 1);
		assert.equal(executor.effects[0]?.arguments.resource, trigger.resource);
		assert.equal(executor.effects[0]?.arguments.contextHandle, trigger.privacyContextHandle);
		assert.equal(executor.effects[0]?.arguments.channelHandle, trigger.channelHandle);
		assert.equal(executor.effects[0]?.arguments.replyToMessageHandle, trigger.messageHandle);
		assert.equal(executor.effects[0]?.arguments.responseHandle, trigger.responseHandle);
		assert.notEqual(executor.effects[0]?.idempotencyKey, proposal.idempotencyKey);

		const escaped = await executeProposedEffects({
			proposals: [{ ...proposal, arguments: { text: "escape", channelHandle: privacy.otherChannelHandle } }],
			context: context(discordGrant, { ...trigger, eventId: "01ARZ3NDEKTSV4RRFFQ69G5FAW" }),
			executor,
			idempotency: new InMemoryEffectIdempotencyStore(),
		});
		assert.equal(escaped[0]?.decisionCode, "trigger-channel-mismatch");
		assert.equal(executor.effects.length, 1);
	});

	it("binds every site coordinate to the committed trigger instead of the sandbox proposal", async () => {
		const executor = new RecordingEffectExecutor();
		const siteGrant = grant({
			capabilities: [
				{
					capability: "site",
					operations: ["mint", "update", "publish", "retire"],
					access: "write",
					approvalPolicy: "ordinary",
					operationPolicies: { publish: "human-always" },
					fence: {
						graphIds: ["shrubbery-preview"],
						resourcePrefixes: ["shrubbery"],
						pathPrefixes: ["/"],
					},
					quota: { maxPerWave: 4 },
				},
			],
		});
		const trigger = {
			kind: "site.request",
			eventId: "site-source-1",
			siteTarget: {
				ownerPrincipal: "user:ada",
				graphId: "shrubbery-preview",
				publicName: "shrubbery-preview",
				pathPrefix: "/",
			},
		};
		const mint = effect({
			capability: "site",
			operation: "mint",
			arguments: { title: "A model-proposed title" },
		});
		const receipts = await executeProposedEffects({
			proposals: [mint],
			context: context(siteGrant, trigger),
			executor,
			idempotency: new InMemoryEffectIdempotencyStore(),
		});

		assert.equal(receipts[0]?.outcome, "executed");
		assert.deepEqual(executor.effects[0]?.arguments, {
			title: "A model-proposed title",
			ownerPrincipal: "user:ada",
			graphId: "shrubbery-preview",
			publicName: "shrubbery-preview",
			pathPrefix: "/",
		});

		for (const [arguments_, code] of [
			[{ graphId: "same-slug-other-target" }, "trigger-graph-mismatch"],
			[{ ownerPrincipal: "user:someone-else" }, "trigger-owner-mismatch"],
			[{ publicName: "stolen-name" }, "trigger-public-name-mismatch"],
			[{ pathPrefix: "/admin" }, "trigger-path-mismatch"],
		] as const) {
			const denied = await executeProposedEffects({
				proposals: [effect({ capability: "site", operation: "mint", arguments: arguments_ })],
				context: context(siteGrant, trigger),
				executor,
				idempotency: new InMemoryEffectIdempotencyStore(),
			});
			assert.equal(denied[0]?.decisionCode, code);
		}

		const publish = effect({ capability: "site", operation: "publish", arguments: {} });
		const pending = await executeProposedEffects({
			proposals: [publish],
			context: context(siteGrant, trigger),
			executor,
			idempotency: new InMemoryEffectIdempotencyStore(),
		});
		assert.equal(pending[0]?.outcome, "pending-approval");
	});

	it("keeps Development Domain instruments under the freeform turn's committed target", async () => {
		const executor = new RecordingEffectExecutor();
		const developmentGrant = grant({
			capabilities: [
				{
					capability: "github",
					operations: ["branch.push", "pr.open", "pr.comment", "pr.merge"],
					access: "write",
					approvalPolicy: "ordinary",
					operationPolicies: { "pr.open": "notify", "pr.merge": "human-always" },
					fence: {
						branchPrefixes: ["agent/shrub-1/"],
						resourcePrefixes: ["sophia-labs/shrubbery"],
						pathPrefixes: ["apps/", "packages/"],
					},
					quota: { maxPerWave: 8 },
				},
			],
		});
		const target = {
			ownerPrincipal: "user:ada",
			repository: "sophia-labs/shrubbery",
			sourceRevision: "a".repeat(40),
			baseBranch: "main",
			branchName: "agent/shrub-1/fix-hoja",
			scratchGraphId: "dev-shrub1-fix-hoja",
			scenarioDigest: "b".repeat(64),
		};
		const trigger = { kind: "shrubbery.finding.fail", eventId: "finding-1", developmentTarget: target };
		const push = effect({
			capability: "github",
			operation: "branch.push",
			arguments: {
				changes: [{ path: "packages/domain-kit/src/fix.ts", contentBase64: "Zml4" }],
			},
		});
		const receipts = await executeProposedEffects({
			proposals: [push],
			context: context(developmentGrant, trigger),
			executor,
			idempotency: new InMemoryEffectIdempotencyStore(),
		});

		assert.equal(receipts[0]?.outcome, "executed");
		assert.deepEqual(executor.effects[0]?.arguments, {
			changes: [{ path: "packages/domain-kit/src/fix.ts", contentBase64: "Zml4" }],
			ownerPrincipal: "user:ada",
			repository: "sophia-labs/shrubbery",
			sourceRevision: "a".repeat(40),
			baseBranch: "main",
			branchName: "agent/shrub-1/fix-hoja",
			scratchGraphId: "dev-shrub1-fix-hoja",
			scenarioDigest: "b".repeat(64),
			resource: "sophia-labs/shrubbery",
			branch: "agent/shrub-1/fix-hoja",
			baseSha: "a".repeat(40),
		});

		for (const [arguments_, code] of [
			[{ repository: "sophia-labs/other", changes: [{ path: "packages/a.ts" }] }, "trigger-repository-mismatch"],
			[{ branchName: "main", changes: [{ path: "packages/a.ts" }] }, "trigger-branch-mismatch"],
			[
				{
					branchName: "agent/shrub-1/fix-hoja",
					branch_name: "main",
					changes: [{ path: "packages/a.ts" }],
				},
				"trigger-branch-mismatch",
			],
			[{ changes: [{ path: "infra/secrets.ts" }] }, "path-fence-denied"],
			[{ changes: [{ path: "packages/../secrets.ts" }] }, "path-fence-denied"],
		] as const) {
			const denied = await executeProposedEffects({
				proposals: [effect({ capability: "github", operation: "branch.push", arguments: arguments_ })],
				context: context(developmentGrant, trigger),
				executor,
				idempotency: new InMemoryEffectIdempotencyStore(),
			});
			assert.equal(denied[0]?.decisionCode, code);
		}
		const prefixLookalike = await executeProposedEffects({
			proposals: [push],
			context: context(developmentGrant, {
				...trigger,
				eventId: "finding-prefix-lookalike",
				developmentTarget: { ...target, repository: "sophia-labs/shrubbery-evil" },
			}),
			executor,
			idempotency: new InMemoryEffectIdempotencyStore(),
		});
		assert.equal(prefixLookalike[0]?.decisionCode, "resource-fence-denied");

		const missingTarget = await executeProposedEffects({
			proposals: [push],
			context: context(developmentGrant, { kind: "manual", eventId: "no-development-target" }),
			executor,
			idempotency: new InMemoryEffectIdempotencyStore(),
		});
		assert.equal(missingTarget[0]?.outcome, "denied");
		assert.equal(missingTarget[0]?.decisionCode, "trigger-development-target-invalid");

		const mergeTarget = {
			...target,
			pullNumber: 42,
			expectedHeadSha: "c".repeat(40),
		};
		const pendingMerge = await executeProposedEffects({
			proposals: [effect({ capability: "github", operation: "pr.merge", arguments: {} })],
			context: context(developmentGrant, {
				kind: "github.pull-request.reviewed",
				eventId: "review-42",
				developmentTarget: mergeTarget,
			}),
			executor,
			idempotency: new InMemoryEffectIdempotencyStore(),
		});
		assert.equal(pendingMerge[0]?.outcome, "pending-approval");
		assert.equal(executor.effects.length, 1);
	});

	it("binds platform realization to the owner-confirmed saved plan and strips sandbox arguments", async () => {
		const executor = new RecordingEffectExecutor();
		const platformGrant = grant({
			capabilities: [
				{
					capability: "platform.release",
					operations: ["platform.release.apply"],
					access: "write",
					approvalPolicy: "notify",
					fence: { resourcePrefixes: ["canary/cloud2-platform"], maxPayloadBytes: 16_384 },
					quota: { maxPerWave: 1, maxConcurrent: 1 },
				},
			],
		});
		const sourceRevision = "a".repeat(40);
		const body = {
			system: { name: "cloud2-platform", digest: `sha256:${"1".repeat(64)}` },
			environment: { name: "canary", digest: `sha256:${"2".repeat(64)}` },
			release: { name: "candidate", digest: `sha256:${"3".repeat(64)}` },
			source: { repository: "sophia-labs/cloud", revision: sourceRevision },
			observedState: {
				snapshotDigest: `sha256:${"4".repeat(64)}`,
				planningViewDigest: `sha256:${"5".repeat(64)}`,
			},
			previousRealization: null,
			guards: [],
			actions: [{ actionId: "rollout.platform-release", driver: "legacy-script" }],
		};
		const planDigest = `sha256:${createHash("sha256").update(stableJson(body)).digest("hex")}` as const;
		const target: CommittedPlatformReleaseTarget = {
			ownerPrincipal: "user:ada",
			resource: "canary/cloud2-platform",
			plan: {
				apiVersion: "sophia.cloud/v1",
				kind: "RealizationPlan",
				digest: planDigest,
				applicable: true,
				body,
				envelope: { createdAt: "2026-08-05T00:00:00Z", plannerVersion: "0.2.0" },
			},
			planDigest,
			confirmation: `apply:canary:cloud2-platform:${planDigest.slice(7, 15)}`,
			sourceRevision,
		};
		const trigger = { kind: "platform.release.requested", eventId: "release-1", platformReleaseTarget: target };
		const proposal = effect({
			capability: "platform.release",
			operation: "platform.release.apply",
			arguments: {},
			reason: "apply the exact saved plan confirmed by the owner",
		});
		const receipts = await executeProposedEffects({
			proposals: [proposal],
			context: context(platformGrant, trigger),
			executor,
			idempotency: new InMemoryEffectIdempotencyStore(),
		});
		assert.equal(receipts[0]?.outcome, "executed");
		assert.deepEqual(executor.effects[0]?.arguments, {
			resource: target.resource,
			planDigest: target.planDigest,
			sourceRevision: target.sourceRevision,
			confirmation: target.confirmation,
		});

		for (const [arguments_, code] of [
			[{ resource: "production/cloud2-platform" }, "trigger-resource-mismatch"],
			[{ planDigest: `sha256:${"0".repeat(64)}` }, "trigger-plan-digest-mismatch"],
			[{ confirmation: "apply:canary:cloud2-platform:wrong" }, "trigger-confirmation-mismatch"],
			[{ plan: target.plan }, "trigger-plan-smuggling-denied"],
		] as const) {
			const denied = await executeProposedEffects({
				proposals: [{ ...proposal, arguments: arguments_ }],
				context: context(platformGrant, trigger),
				executor,
				idempotency: new InMemoryEffectIdempotencyStore(),
			});
			assert.equal(denied[0]?.decisionCode, code);
		}
	});

	it("refuses effect execution when the supplied trigger is not the committed trigger", async () => {
		const committed = context(grant(), DEFAULT_TRIGGER);
		await assert.rejects(
			executeProposedEffects({
				proposals: [effect()],
				context: { ...committed, trigger: { ...DEFAULT_TRIGGER, eventId: "changed-after-commit" } },
				executor: new RecordingEffectExecutor(),
				idempotency: new InMemoryEffectIdempotencyStore(),
			}),
			/effect trigger differs from its committed source turn/,
		);
	});

	it("durably hands Discord work to the listener instead of claiming it was executed", async () => {
		const privacy = phanesPrivacyFixture("01ARZ3NDEKTSV4RRFFQ69G5FAX");
		const root = mkdtempSync(join(tmpdir(), "effect-handoff-integration-"));
		const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
		try {
			await runtime.init();
			const discordGrant = grant({
				capabilities: [
					{
						capability: "discord",
						operations: ["message.reply"],
						access: "write",
						approvalPolicy: "ordinary",
						fence: { resourcePrefixes: ["discord-context:"] },
						quota: { maxPerWave: 1 },
					},
				],
			});
			const trigger = privacy.trigger;
			const proposal = effect({
				capability: "discord",
				operation: "message.reply",
				arguments: { text: "The durable reply." },
			});
			const handoffContext = {
				...context(discordGrant, trigger),
				grantDocumentId: "grant-phanes-1",
				grantAuthorityOwnerPrincipal: "user:platform-steward",
				definitionDigest: "d".repeat(64),
				trigger,
			};
			const first = await executeProposedEffects({
				proposals: [proposal],
				context: handoffContext,
				executor: new GraphProposedEffectExecutor(new RecordingGraph()),
				idempotency: new RuntimeEffectIdempotencyStore(runtime),
				handoff: new RuntimeEffectHandoffStore(runtime),
			});
			assert.equal(first[0]?.outcome, "handed-off");
			assert.equal(first[0]?.decisionCode, "host-handoff-ready");
			const record = await runtime.getEffectHandoff(first[0]!.idempotencyKey);
			assert.equal(record?.state, "ready");
			assert.equal((record?.proposal as ProposedEffectV1).arguments.contextHandle, privacy.contextHandle);
			assert.equal((record?.proposal as ProposedEffectV1).arguments.channelHandle, privacy.channelHandle);
			assert.equal((record?.proposal as ProposedEffectV1).arguments.replyToMessageHandle, privacy.messageHandle);
			assert.equal((record?.proposal as ProposedEffectV1).arguments.responseHandle, privacy.responseHandle);
			assert.equal(await runtime.getEffectIdempotency(first[0]!.idempotencyKey), null);

			const replay = await executeProposedEffects({
				proposals: [{ ...proposal, idempotencyKey: "another sandbox hint" }],
				context: { ...handoffContext, runId: "wfr-retry" },
				executor: new GraphProposedEffectExecutor(new RecordingGraph()),
				idempotency: new RuntimeEffectIdempotencyStore(runtime),
				handoff: new RuntimeEffectHandoffStore(runtime),
			});
			assert.equal(replay[0]?.outcome, "handed-off");
			assert.equal(replay[0]?.decisionCode, "host-handoff-replay");

			const unwitnessed = await executeProposedEffects({
				proposals: [proposal],
				context: {
					...context(discordGrant, { ...trigger, eventId: "01ARZ3NDEKTSV4RRFFQ69G5FAY" }),
				},
				executor: new GraphProposedEffectExecutor(new RecordingGraph()),
				idempotency: new RuntimeEffectIdempotencyStore(runtime),
				handoff: new RuntimeEffectHandoffStore(runtime),
			});
			assert.equal(unwitnessed[0]?.outcome, "error");
			assert.equal(unwitnessed[0]?.decisionCode, "host-handoff-error");
		} finally {
			runtime.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("marks a failed activity and durably hands off its graph-authored placeholder replacement", async () => {
		const privacy = phanesPrivacyFixture("01ARZ3NDEKTSV4RRFFQ69G5FAZ");
		const dir = mkdtempSync(join(tmpdir(), "domain-agent-failure-finalize-"));
		try {
			const runtime = new WorkflowRuntimeStore(join(dir, "runtime.sqlite"));
			await runtime.init();
			const graph = new RecordingGraph();
			const discordGrant = grant({
				capabilities: [
					{
						capability: "discord",
						operations: ["message.edit"],
						access: "write",
						approvalPolicy: "ordinary",
						fence: { resourcePrefixes: ["discord-context:"] },
						quota: { maxPerWave: 1 },
					},
				],
			});
			const trigger = privacy.trigger;
			const run: RunRecord = {
				runId: "wfr-phanes-failed-wave",
				workflowName: "domain-agent-activity-loop-v1",
				workflowUri: "urn:sophia:wf:domain-agent-activity-loop-v1",
				status: "completed",
				startedAt: 1,
				endedAt: 2,
				durationMs: 1,
				agentCount: 1,
				totalTokens: 10,
				agents: [],
				output: {
					response: null,
					proposedEffects: [],
					failure: {
						schema: "sophia.domain-agent-activity-failure.v1",
						code: "activity_execution_failed",
					},
				},
			};
			const inputs = {
				config: { graphId: "phanes", model: "thinkingmachines/inkling" },
				args: {},
				hostContext: {
					schema: "sophia.domain-agent-host-context.v1",
					agentId: AGENT_ID,
					definitionDigest: "a".repeat(64),
					grant: discordGrant,
					grantDocumentId: "grant-phanes-write-v2",
					grantAuthorityOwnerPrincipal: "user:platform-steward",
					toolbelt: {} as never,
					approvals: [],
					maxProposedEffects: 1,
					sourceTurn: context(discordGrant, trigger).sourceTurn,
					trigger,
					triggerBinding: { kind: "discord.message.mention", enabled: true, ingress: "internal-service" },
					resultEffectBinding: {
						schema: "sophia.domain-result-effect-binding.v1",
						kind: "discord-placeholder-edit",
						failureContent: "The turn was recorded, but I couldn't complete a response.",
					},
				},
			} as const;

			await finalizeDomainAgentActivityRun({
				run,
				inputs,
				graph,
				runtime,
				graphId: "phanes",
				ownerUserId: "user:ada",
				actorRef: "agent:phanes-listener",
			});

			assert.equal(run.status, "failed");
			assert.match(run.note ?? "", /failed before producing a contracted response/);
			assert.equal(run.effectReceipts?.[0]?.outcome, "handed-off");
			const handoff = await runtime.getEffectHandoff(run.effectReceipts![0]!.idempotencyKey);
			assert.equal(handoff?.state, "ready");
			assert.equal((handoff?.proposal as ProposedEffectV1).operation, "message.edit");
			assert.equal(
				(handoff?.proposal as ProposedEffectV1).arguments.text,
				"The turn was recorded, but I couldn't complete a response.",
			);
			runtime.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("finalizes a disposable activity wave at the trusted host edge and persists testimony", async () => {
		const dir = mkdtempSync(join(tmpdir(), "domain-agent-finalize-"));
		try {
			const runtime = new WorkflowRuntimeStore(join(dir, "runtime.sqlite"));
			await runtime.init();
			const graph = new RecordingGraph();
			const proposal = effect();
			const run: RunRecord = {
				runId: "wfr-phanes-finalize-1",
				workflowName: "domain-agent-activity-loop-v1",
				workflowUri: "urn:sophia:wf:domain-agent-activity-loop-v1",
				status: "completed",
				startedAt: 1,
				endedAt: 2,
				durationMs: 1,
				agentCount: 2,
				totalTokens: 10,
				agents: [],
				output: { response: { text: "hello" }, proposedEffects: [proposal] },
			};
			const inputs = {
				config: { graphId: "phanes", model: "thinkingmachines/inkling" },
				args: {},
				hostContext: {
					schema: "sophia.domain-agent-host-context.v1",
					agentId: AGENT_ID,
					definitionDigest: "a".repeat(64),
					grant: grant(),
					grantDocumentId: "grant-phanes-1",
					grantAuthorityOwnerPrincipal: "user:platform-steward",
					toolbelt: {} as never,
					approvals: [],
					maxProposedEffects: 2,
					sourceTurn: context(grant()).sourceTurn,
					trigger: DEFAULT_TRIGGER,
					triggerBinding: { kind: "phanes.manual.request", enabled: true, ingress: "owner" },
				},
			} as const;

			await finalizeDomainAgentActivityRun({
				run,
				inputs,
				graph,
				runtime,
				graphId: "phanes",
				ownerUserId: "user:ada",
				actorRef: "agent:phanes-listener",
			});
			assert.equal(run.effectReceipts?.[0]?.outcome, "executed");
			assert.equal(graph.documents.filter((doc) => doc.documentId === "reply-1").length, 1);
			const testimony = graph.documents.find((doc) => doc.documentId === "effect-receipts-wfr-phanes-finalize-1");
			assert.ok(testimony);
			assert.match(testimony.content, /sophia\.effect-receipt-batch\.v1/);

			await finalizeDomainAgentActivityRun({
				run,
				inputs,
				graph,
				runtime,
				graphId: "phanes",
				ownerUserId: "user:ada",
				actorRef: "agent:phanes-listener",
			});
			assert.equal(run.effectReceipts?.[0]?.outcome, "duplicate");
			assert.equal(graph.documents.filter((doc) => doc.documentId === "reply-1").length, 1);
			runtime.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
