import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	MEANINGFUL_OBJECT_REF_SCHEMA,
	type MeaningfulObjectKind,
	type MeaningfulObjectRefV1,
} from "../agent-runtime/meaningful-object.js";
import { AGENT_ONTOLOGY_BINDING_SCHEMA, type AgentOntologyBindingV1 } from "../agent-runtime/ontology-binding.js";
import {
	AGENT_RUNTIME_BINDING_SCHEMA,
	PRIME_AGENT_RUNTIME_BASELINE,
	SIMPLE_AGENT_RUNTIME_BASELINE,
} from "../agent-runtime/profile.js";
import { mintAgentUri, STANDALONE_AGENT_IDENTITY_ALGORITHM } from "../agent-subject/agent-ontology.js";
import { compileWorkflow, runWorkflow } from "../workflow/harness.js";
import type { ChildInvocationRequestV1 } from "../workflow/invocation.js";
import { WorkflowProgramControlBackend } from "../workflow/program-control.js";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import {
	buildDomainAgentActivityInputs,
	DOMAIN_AGENT_ACTIVITY_LOOP_SCRIPT,
	materializeBoundFailureEffects,
	materializeBoundResultEffects,
} from "../workflow/script-domain-agent-activity-loop.js";
import type { AgentNodeResult, AgentNodeSpec } from "../workflow/types.js";
import { phanesPrivacyFixture } from "./phanes-privacy-fixture.js";

const TEST_AGENT_ID = "agent-7068616e65730001";

function promptResolution(bindingId: string, documentId: string) {
	return {
		binding: { bindingId },
		executionBinding: { bindingId: `${bindingId}-execution` },
		currentSnapshot: {
			documentId,
			snapshotId: `${documentId}-snapshot`,
			renderedDigest: "b".repeat(64),
		},
	};
}

function mo<Kind extends MeaningfulObjectKind>(
	kind: Kind,
	objectId: string,
	character: string,
	graphId: string,
): MeaningfulObjectRefV1<Kind> {
	return {
		schema: MEANINGFUL_OBJECT_REF_SCHEMA,
		kind,
		ownerPrincipal: "user:ada",
		graphId,
		objectId,
		version: "1",
		digest: `sha256:${character.repeat(64)}`,
	};
}

function runtimeBindings(graphId: string) {
	const pilotProfile = mo("agent-runtime-profile", "domain-pilot", "8", graphId);
	const emanationProfile = mo("agent-runtime-profile", "domain-emanation", "9", graphId);
	const core = {
		agent: mo("agent", mintAgentUri(TEST_AGENT_ID), "1", graphId),
		geist: mo("geist", "domain-geist", "2", graphId),
		prompt: mo("prompt", "domain-prompt", "3", graphId),
		skills: [mo("skill", "domain-attention", "4", graphId)],
		harness: mo("harness", "domain-agent-activity-loop-v1", "5", graphId),
		toolManifest: mo("tool-manifest", "domain-tools", "6", graphId),
		toolGrant: mo("tool-grant", "domain-grant", "7", graphId),
	};
	const ontology = (runtimeProfile: MeaningfulObjectRefV1<"agent-runtime-profile">): AgentOntologyBindingV1 => ({
		schema: AGENT_ONTOLOGY_BINDING_SCHEMA,
		subject: {
			agentId: TEST_AGENT_ID,
			agentUri: mintAgentUri(TEST_AGENT_ID),
			observerId: TEST_AGENT_ID,
			registeredName: "phanes",
			identityAlgorithm: STANDALONE_AGENT_IDENTITY_ALGORITHM,
		},
		objects: { ...core, runtimeProfile },
		resolvedAt: 1,
	});
	return {
		runtimes: {
			pilot: {
				schema: AGENT_RUNTIME_BINDING_SCHEMA,
				kind: "prime" as const,
				bundle: { id: "sophia-agent-runtime", digest: `sha256:${"a".repeat(64)}` },
				profileRef: pilotProfile,
				constraints: PRIME_AGENT_RUNTIME_BASELINE,
			},
			emanation: {
				schema: AGENT_RUNTIME_BINDING_SCHEMA,
				kind: "simple" as const,
				bundle: { id: "sophia-agent-runtime", digest: `sha256:${"a".repeat(64)}` },
				profileRef: emanationProfile,
				constraints: SIMPLE_AGENT_RUNTIME_BASELINE,
			},
		},
		ontologies: { pilot: ontology(pilotProfile), emanation: ontology(emanationProfile) },
	};
}

function sourceTurn(graphId: string) {
	return {
		schema: "sophia.domain-source-turn.v1" as const,
		turnId: `turn:${"1".repeat(64)}`,
		sourceRef: `urn:test:source:${graphId}`,
		sourceDigest: "2".repeat(64),
		triggerDigest: "3".repeat(64),
		contextDigest: "4".repeat(64),
		target: { ownerPrincipal: "user:ada", graphId },
		agentId: TEST_AGENT_ID,
		actorRef: "user:ada",
		ingress: { authMethod: "owner" as const },
		committedAt: 1,
	};
}

function result(spec: AgentNodeSpec, structured?: unknown): AgentNodeResult {
	return {
		label: spec.label,
		phaseIndex: spec.phaseIndex,
		state: "done",
		output: spec.label.startsWith("emanation-") ? `finding:${spec.label}` : `done:${spec.label}`,
		structured,
		model: spec.model,
		agentId: spec.agentId,
		turns: 1,
		toolCalls: 1,
		tokens: 10,
		queuedAt: 1,
		startedAt: 2,
		durationMs: 3,
		agentType: spec.agentType,
	};
}

describe("generic Domain Agent activity loop", () => {
	it("deterministically binds a typed Phanes result to the host-owned Discord placeholder", () => {
		const privacy = phanesPrivacyFixture("01ARZ3NDEKTSV4RRFFQ69G5FAV");
		const effects = materializeBoundResultEffects(
			{
				resultEffectBinding: {
					schema: "sophia.domain-result-effect-binding.v1",
					kind: "discord-placeholder-edit",
				},
				maxProposedEffects: 2,
				trigger: privacy.trigger,
				sourceTurn: sourceTurn("phanes"),
			} as never,
			{ response: { content: "A witnessed answer." } },
			[],
			"wfr-phanes",
		);
		assert.deepEqual(effects, [
			{
				schema: "sophia.proposed-effect.v1",
				effectId: "host-response-edit:wfr-phanes",
				idempotencyKey: `discord-response:turn:${"1".repeat(64)}`,
				capability: "discord",
				operation: "message.edit",
				arguments: {
					resource: `discord-context:${privacy.contextHandle}`,
					contextHandle: privacy.contextHandle,
					channelHandle: privacy.channelHandle,
					responseHandle: privacy.responseHandle,
					text: "A witnessed answer.",
				},
				reason: "Apply the graph-bound typed Domain Agent response to the host-owned Discord placeholder.",
				evidenceRefs: ["urn:test:source:phanes"],
			},
		]);
	});

	it("materializes an activity failure through the graph-authored Discord effect boundary", () => {
		const privacy = phanesPrivacyFixture("01ARZ3NDEKTSV4RRFFQ69G5FAW");
		const effects = materializeBoundFailureEffects(
			{
				resultEffectBinding: {
					schema: "sophia.domain-result-effect-binding.v1",
					kind: "discord-placeholder-edit",
					failureContent:
						"I hit a problem while working on that. The turn was recorded, but I couldn't complete a response.",
				},
				maxProposedEffects: 2,
				trigger: privacy.trigger,
				sourceTurn: sourceTurn("phanes"),
			} as never,
			"wfr-phanes-failed",
		);
		assert.deepEqual(effects, [
			{
				schema: "sophia.proposed-effect.v1",
				effectId: "host-response-failure-edit:wfr-phanes-failed",
				idempotencyKey: `discord-response-failure:turn:${"1".repeat(64)}:wfr-phanes-failed`,
				capability: "discord",
				operation: "message.edit",
				arguments: {
					resource: `discord-context:${privacy.contextHandle}`,
					contextHandle: privacy.contextHandle,
					channelHandle: privacy.channelHandle,
					responseHandle: privacy.responseHandle,
					text: "I hit a problem while working on that. The turn was recorded, but I couldn't complete a response.",
				},
				reason: "Replace the host-owned Discord placeholder with the graph-bound activity failure response.",
				evidenceRefs: ["urn:test:source:phanes"],
			},
		]);
	});

	it("lets the pilot choose bounded Inkling-Small emanations and keeps them read-only", async () => {
		const specs: AgentNodeSpec[] = [];
		const compiled = compileWorkflow(DOMAIN_AGENT_ACTIVITY_LOOP_SCRIPT);
		const inputs = buildDomainAgentActivityInputs({
			graphId: "phanes",
			sourceTurn: sourceTurn("phanes"),
			request: {
				definitionDocumentId: "domain-agent-definition",
				trigger: { kind: "discord.message", text: "What changed?" },
				contextRefs: ["urn:phanes:discord:message:1"],
			},
			resolved: {
				...runtimeBindings("phanes"),
				definition: {
					agentId: TEST_AGENT_ID,
					charterDocumentId: "phanes-charter",
					grantRef: {
						ownerPrincipal: "user:platform-steward",
						graphId: "observatory",
						documentId: "grant-phanes",
					},
					budgets: { maxProposedEffects: 2 },
					responseSchema: {
						type: "object",
						required: ["text"],
						properties: { text: { type: "string" } },
						additionalProperties: false,
					},
				},
				definitionDigest: "a".repeat(64),
				prompt: promptResolution("apb-phanes", "phanes-prompt"),
				grant: { grantId: "grant-phanes" },
				toolbelt: { schema: "sophia.granted-toolbelt.v1" },
				pilot: { model: "thinkingmachines/inkling", maxTurns: 12, graphAccess: "write" },
				emanation: {
					enabled: true,
					model: "thinkingmachines/inkling-small",
					maxEmanations: 2,
					maxTurns: 5,
				},
				pilotToolInclude: ["context_bundle", "recall", "remember", "search_documents"],
				emanationToolInclude: ["recall", "search_documents"],
				programs: [],
				maxProgramInvocations: 0,
				systemPrompt: "You are Phanes. Attend, judge, and answer under the bound effect policy.",
			} as never,
		});
		let now = 100;
		const run = await runWorkflow(
			{
				runId: "wfr-activity-proof",
				now: () => now++,
				async runNode(spec) {
					specs.push(spec);
					if (spec.label === "pilot-attend") {
						return result(spec, {
							reason: "Two independent lookups will help.",
							program: null,
							tasks: [
								{ label: "history", task: "Inspect recent channel context." },
								{ label: "memory", task: "Recall related commitments." },
								{ label: "excess", task: "This must be clipped by the policy." },
							],
						});
					}
					if (spec.label === "pilot-respond") {
						return result(spec, {
							response: { text: "A witnessed answer." },
							proposedEffects: [
								{
									schema: "sophia.proposed-effect.v1",
									effectId: "reply-1",
									idempotencyKey: "discord:1:reply",
									capability: "discord",
									operation: "message.reply",
									arguments: { channelId: "c1", text: "A witnessed answer." },
									reason: "Answer the trigger.",
									evidenceRefs: ["urn:phanes:discord:message:1"],
								},
							],
						});
					}
					return result(spec);
				},
			},
			compiled,
			inputs,
		);

		assert.equal(run.status, "completed");
		assert.equal(run.agentCount, 4);
		assert.deepEqual(run.output, {
			response: { text: "A witnessed answer." },
			proposedEffects: [
				{
					schema: "sophia.proposed-effect.v1",
					effectId: "reply-1",
					idempotencyKey: "discord:1:reply",
					capability: "discord",
					operation: "message.reply",
					arguments: { channelId: "c1", text: "A witnessed answer." },
					reason: "Answer the trigger.",
					evidenceRefs: ["urn:phanes:discord:message:1"],
				},
			],
			delegated: true,
			programInvocation: null,
			failure: null,
			emanations: [
				{ label: "history", output: "finding:emanation-1" },
				{ label: "memory", output: "finding:emanation-2" },
			],
		});
		const pilots = specs.filter((spec) => spec.agentType === "domain-agent-pilot");
		const emanations = specs.filter((spec) => spec.agentType === "domain-agent-emanation");
		assert.equal(pilots.length, 2);
		assert.ok(pilots.every((spec) => spec.model === "thinkingmachines/inkling"));
		assert.ok(pilots.every((spec) => spec.graphAccess === "write"));
		assert.ok(
			pilots.every((spec) => spec.includeTools?.join(",") === "context_bundle,recall,remember,search_documents"),
		);
		assert.equal(emanations.length, 2);
		assert.ok(emanations.every((spec) => spec.model === "thinkingmachines/inkling-small"));
		assert.ok(emanations.every((spec) => spec.graphAccess === "read"));
		assert.ok(emanations.every((spec) => spec.includeTools?.join(",") === "recall,search_documents"));
		assert.ok(specs.every((spec) => spec.strictToolManifest));
		assert.ok(specs.every((spec) => spec.agentId === TEST_AGENT_ID));
		assert.ok(pilots.every((spec) => spec.runtime?.kind === "prime"));
		assert.ok(emanations.every((spec) => spec.runtime?.kind === "simple"));
		assert.ok(specs.every((spec) => spec.ontology?.subject.observerId === TEST_AGENT_ID));
	});

	it("adjudicates a queued ontological directive at Phanes's later respond beat", async (t) => {
		const directory = mkdtempSync(join(tmpdir(), "phanes-domain-beats-"));
		const runtime = new WorkflowRuntimeStore(join(directory, "runtime.sqlite"));
		t.after(() => {
			runtime.close();
			rmSync(directory, { recursive: true, force: true });
		});
		await runtime.init();
		const runId = "wfr-phanes-dynamic-beat";
		await runtime.createWorkflowInstance({
			runId,
			workflowName: "domain-agent-activity-loop-v1",
			graphId: "phanes",
			ownerUserId: "ada",
			inputs: {},
			startedAt: 10,
		});
		const claim = await runtime.claimWorkflowDriver(runId, {
			clientId: "vehicle-test",
			claimTs: 20,
			now: 20,
			expectedRevision: 0,
		});
		assert.equal(claim?.applied, true);
		const queued = await runtime.queueWorkflowBeatAmendment(runId, {
			clientId: "vehicle-test",
			amendmentId: "respond-with-provenance",
			kind: "directive",
			targetBeatId: "respond",
			payload: { text: "Name the Meaningful Object testimony in the final response." },
			expectedRevision: claim?.control.revision ?? -1,
			leaseEpoch: claim?.control.driverLease?.epoch ?? -1,
			now: 21,
		});
		assert.equal(queued?.applied, true, "CAS enqueue is proposal receipt, not final acceptance");
		const disallowed = await runtime.queueWorkflowBeatAmendment(runId, {
			clientId: "vehicle-test",
			amendmentId: "reorder-fixed-domain-phases",
			kind: "reorder",
			targetBeatId: "respond",
			payload: { order: ["respond"] },
			expectedRevision: queued?.control.revision ?? -1,
			leaseEpoch: queued?.control.driverLease?.epoch ?? -1,
			now: 22,
		});
		assert.equal(disallowed?.applied, true, "the proposal awaits definition-policy adjudication");

		const inputs = buildDomainAgentActivityInputs({
			graphId: "phanes",
			sourceTurn: sourceTurn("phanes"),
			request: {
				definitionDocumentId: "domain-agent-definition",
				trigger: { kind: "discord.message", text: "What changed?" },
				contextRefs: ["urn:phanes:discord:message:1"],
			},
			resolved: {
				...runtimeBindings("phanes"),
				definition: {
					agentId: TEST_AGENT_ID,
					charterDocumentId: "phanes-charter",
					grantRef: {
						ownerPrincipal: "user:platform-steward",
						graphId: "observatory",
						documentId: "grant-phanes",
					},
					budgets: { maxProposedEffects: 2 },
					responseSchema: {
						type: "object",
						required: ["text"],
						properties: { text: { type: "string" } },
						additionalProperties: false,
					},
				},
				definitionDigest: "a".repeat(64),
				prompt: promptResolution("apb-phanes", "phanes-prompt"),
				grant: { grantId: "grant-phanes" },
				toolbelt: { schema: "sophia.granted-toolbelt.v1" },
				pilot: {
					provider: "openrouter",
					model: "thinkingmachines/inkling",
					maxTurns: 12,
					graphAccess: "read",
				},
				emanation: {
					enabled: false,
					provider: "openrouter",
					model: "thinkingmachines/inkling-small",
					maxEmanations: 0,
					maxTurns: 5,
				},
				pilotToolInclude: ["recall"],
				emanationToolInclude: ["recall"],
				programs: [],
				maxProgramInvocations: 0,
				systemPrompt: "You are Phanes.",
			} as never,
		});
		const specs: AgentNodeSpec[] = [];
		let now = 30;
		const run = await runWorkflow(
			{
				runId,
				now: () => now++,
				control: new WorkflowProgramControlBackend(runtime, runId, () => now++),
				async runNode(spec) {
					specs.push(spec);
					if (spec.label === "pilot-attend") {
						return result(spec, { reason: "No delegation needed.", program: null, tasks: [] });
					}
					return result(spec, {
						response: { text: "Meaningful Object testimony says it changed." },
						proposedEffects: [],
					});
				},
			},
			compileWorkflow(DOMAIN_AGENT_ACTIVITY_LOOP_SCRIPT),
			inputs,
		);

		assert.equal(run.status, "completed");
		const responseSpec = specs.find((spec) => spec.label === "pilot-respond");
		assert.match(responseSpec?.prompt ?? "", /Name the Meaningful Object testimony/);
		const control = await runtime.getWorkflowControl(runId);
		assert.deepEqual(
			control?.amendments.map((amendment) => [
				amendment.id,
				amendment.state,
				amendment.appliedBeatId,
				amendment.rejection,
			]),
			[
				["respond-with-provenance", "applied", "respond", undefined],
				[
					"reorder-fixed-domain-phases",
					"rejected",
					"respond",
					"reorder is outside this workflow definition policy",
				],
			],
		);
	});

	it("lets the freeform pilot select a digest-pinned program and integrates its witnessed result", async () => {
		const digest = "b".repeat(64);
		const inputs = buildDomainAgentActivityInputs({
			graphId: "shrubbery-domain",
			sourceTurn: sourceTurn("shrubbery-domain"),
			request: {
				definitionDocumentId: "domain-agent-definition",
				trigger: { kind: "shrubbery.acceptance.tick", reason: "stale claim" },
				contextRefs: ["urn:shrubbery:claim:editor-create"],
			},
			resolved: {
				...runtimeBindings("shrubbery-domain"),
				definition: {
					agentId: TEST_AGENT_ID,
					charterDocumentId: "shrub-1-charter",
					grantRef: {
						ownerPrincipal: "user:platform-steward",
						graphId: "observatory",
						documentId: "grant-shrub-1",
					},
					budgets: { maxProposedEffects: 2 },
					responseSchema: {
						type: "object",
						required: ["text"],
						properties: { text: { type: "string" } },
						additionalProperties: false,
					},
				},
				definitionDigest: "a".repeat(64),
				prompt: promptResolution("apb-shrub-1", "shrub-prompt"),
				grant: { grantId: "grant-shrub-1" },
				toolbelt: { schema: "sophia.granted-toolbelt.v1" },
				pilot: { model: "thinkingmachines/inkling", maxTurns: 12, graphAccess: "read" },
				emanation: {
					enabled: true,
					model: "thinkingmachines/inkling-small",
					maxEmanations: 2,
					maxTurns: 5,
				},
				pilotToolInclude: ["recall", "search_documents"],
				emanationToolInclude: ["recall", "search_documents"],
				programs: [
					{
						programId: "acceptance",
						title: "Shrubbery acceptance journey",
						description: "Exercise one stale capability claim and return testimony.",
						workflowName: "shrubbery-acceptance-v1",
						workflowUri: "urn:sophia:wf:shrubbery-acceptance-v1",
						definitionDigest: digest,
						inputSchema: {
							type: "object",
							required: ["claimRef"],
							properties: { claimRef: { type: "string" } },
							additionalProperties: false,
						},
						authority: {
							capability: "workflow",
							operation: "loom_run",
							access: "write",
							resourceRef: "shrubbery:program:acceptance",
						},
						graph: { mode: "home" },
					},
				],
				maxProgramInvocations: 1,
				systemPrompt: "You are shrub-1, a general domain colleague.",
			} as never,
		});
		const childRequests: ChildInvocationRequestV1[] = [];
		let now = 100;
		const run = await runWorkflow(
			{
				runId: "wfr-program-choice-proof",
				now: () => now++,
				async invoke(request) {
					childRequests.push(request);
					return {
						invocationId: "inv-child-acceptance",
						status: "completed",
						output: { verdict: "PASS", evidenceRef: "urn:evidence:sha256:123" },
					};
				},
				async runNode(spec) {
					if (spec.label === "pilot-attend") {
						return result(spec, {
							reason: "The stale claim calls for the acceptance instrument.",
							tasks: [],
							program: {
								programId: "acceptance",
								input: { claimRef: "urn:shrubbery:claim:editor-create" },
							},
						});
					}
					return result(spec, {
						response: { text: "The stale claim passed with fresh evidence." },
						proposedEffects: [],
					});
				},
			},
			compileWorkflow(DOMAIN_AGENT_ACTIVITY_LOOP_SCRIPT),
			inputs,
		);

		assert.deepEqual(childRequests, [
			{
				workflowName: "shrubbery-acceptance-v1",
				workflowUri: "urn:sophia:wf:shrubbery-acceptance-v1",
				definitionDigest: digest,
				input: { claimRef: "urn:shrubbery:claim:editor-create" },
			},
		]);
		assert.deepEqual(run.output, {
			response: { text: "The stale claim passed with fresh evidence." },
			proposedEffects: [],
			delegated: false,
			emanations: [],
			failure: null,
			programInvocation: {
				programId: "acceptance",
				workflowName: "shrubbery-acceptance-v1",
				invocationId: "inv-child-acceptance",
				status: "completed",
				output: { verdict: "PASS", evidenceRef: "urn:evidence:sha256:123" },
			},
		});
	});

	it("returns a typed failure Meaningful Object when the pilot omits its delegation plan", async () => {
		const inputs = buildDomainAgentActivityInputs({
			graphId: "phanes",
			sourceTurn: sourceTurn("phanes"),
			request: {
				definitionDocumentId: "domain-agent-definition",
				trigger: { kind: "discord.message", text: "What changed?" },
				contextRefs: ["urn:phanes:discord:message:1"],
			},
			resolved: {
				...runtimeBindings("phanes"),
				definition: {
					agentId: TEST_AGENT_ID,
					charterDocumentId: "phanes-charter",
					grantRef: {
						ownerPrincipal: "user:platform-steward",
						graphId: "observatory",
						documentId: "grant-phanes",
					},
					budgets: { maxProposedEffects: 2 },
					responseSchema: { type: "object" },
				},
				definitionDigest: "a".repeat(64),
				prompt: {
					binding: { bindingId: "apb-phanes" },
					executionBinding: { bindingId: "apb-phanes" },
					currentSnapshot: {
						documentId: "phanes-prompt",
						snapshotId: "phanes-prompt-v1",
						renderedDigest: `sha256:${"b".repeat(64)}`,
					},
				},
				grant: { grantId: "grant-phanes" },
				toolbelt: { schema: "sophia.granted-toolbelt.v1" },
				pilot: { model: "thinkingmachines/inkling", maxTurns: 12, graphAccess: "write" },
				emanation: {
					enabled: true,
					model: "thinkingmachines/inkling-small",
					maxEmanations: 2,
					maxTurns: 5,
				},
				pilotToolInclude: ["context_bundle", "remember"],
				emanationToolInclude: [],
				programs: [],
				maxProgramInvocations: 0,
				systemPrompt: "You are Phanes.",
			} as never,
		});
		const run = await runWorkflow(
			{
				runId: "wfr-activity-failure-proof",
				now: () => 100,
				async runNode(spec) {
					return result(spec);
				},
			},
			compileWorkflow(DOMAIN_AGENT_ACTIVITY_LOOP_SCRIPT),
			inputs,
		);

		assert.equal(run.status, "completed");
		assert.deepEqual(run.output, {
			response: null,
			proposedEffects: [],
			delegated: false,
			emanations: [],
			programInvocation: null,
			failure: {
				schema: "sophia.domain-agent-activity-failure.v1",
				code: "activity_execution_failed",
			},
		});
	});
});
