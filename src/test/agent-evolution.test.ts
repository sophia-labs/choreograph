import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	AGENT_EMBODIMENT_SCHEMA,
	AGENT_RUNTIME_BINDING_V2_SCHEMA,
	type AgentEmbodimentV1,
	AgentEvolutionFault,
	type AgentRuntimeBindingV2,
	computeEvaluationSetDigest,
	digestAgentRuntimeBindingV2,
	EMBODIMENT_CANDIDATE_SCHEMA,
	type EmbodimentCandidateV1,
	EVALUATION_POLICY_SCHEMA,
	EVOLUTION_PROPOSAL_SCHEMA,
	type EvaluationPolicyV1,
	type EvolutionProposalV1,
	PROMOTION_DECISION_SCHEMA,
	type PromotionDecisionV1,
	validateAgentEmbodiment,
	validateEvaluationPolicy,
	validateEvolutionProposal,
	validatePromotionDecision,
} from "../agent-runtime/evolution.js";
import { AgentEvolutionStore, EmbodimentActivationConflictError } from "../agent-runtime/evolution-store.js";
import {
	EXTENSION_VERIFICATION_RUN_SCHEMA,
	type ExtensionVerificationRunV1,
} from "../agent-runtime/extension-evaluation.js";
import {
	createMeaningfulObjectRef,
	MEANINGFUL_OBJECT_REF_SCHEMA,
	type MeaningfulObjectKind,
	type MeaningfulObjectRefV1,
} from "../agent-runtime/meaningful-object.js";
import {
	AGENT_ONTOLOGY_BINDING_SCHEMA,
	type AgentOntologyBindingV1,
	digestAgentOntologyBinding,
} from "../agent-runtime/ontology-binding.js";
import { PRIME_AGENT_RUNTIME_BASELINE } from "../agent-runtime/profile.js";
import { mintAgentUri, STANDALONE_AGENT_IDENTITY_ALGORITHM } from "../agent-subject/agent-ontology.js";

const owner = "user:test-owner";
const agentId = "agent-0123456789abcdef";
const graphId = "g-evolution";
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function externalRef<Kind extends MeaningfulObjectKind>(
	kind: Kind,
	objectId: string,
	character: string,
	principal = owner,
): MeaningfulObjectRefV1<Kind> {
	return {
		schema: MEANINGFUL_OBJECT_REF_SCHEMA,
		kind,
		ownerPrincipal: principal,
		graphId,
		objectId,
		version: "1",
		digest: `sha256:${character.repeat(64)}`,
	};
}

const profileRef = externalRef("agent-runtime-profile", "prime-profile", "1");
const evaluationSuiteRef = externalRef("evaluation-suite", "extension-security-and-abi", "2");
const sourceCompositionRef = externalRef("source-composition", "source-composition-001", "4");
const changeSetRef = externalRef("change-set", "change-set-001", "5");
const patchSetRef = externalRef("patch-set", "patch-set-001", "6");
const buildReceiptRef = externalRef("build-receipt", "build-receipt-001", "7");
const releaseArtifactRef = externalRef("release-artifact", "prime-extension-001", "8");
const extensionSkillRef = externalRef("skill", "skill-extension-001", "9");

function runtime(overlays: AgentRuntimeBindingV2["overlays"] = []): AgentRuntimeBindingV2 {
	return {
		schema: AGENT_RUNTIME_BINDING_V2_SCHEMA,
		kind: "prime",
		baseBundle: {
			id: "sophia-agent-runtime",
			digest: `sha256:${"a".repeat(64)}`,
		},
		overlays,
		profileRef,
		constraints: PRIME_AGENT_RUNTIME_BASELINE,
		extensionAbi: "sophia.prime-extension.v1",
	};
}

function ontology(skillRefs: readonly MeaningfulObjectRefV1<"skill">[] = []): AgentOntologyBindingV1 {
	return {
		schema: AGENT_ONTOLOGY_BINDING_SCHEMA,
		subject: {
			agentId,
			agentUri: mintAgentUri(agentId),
			observerId: agentId,
			registeredName: "owner-prime",
			identityAlgorithm: STANDALONE_AGENT_IDENTITY_ALGORITHM,
		},
		objects: {
			agent: externalRef("agent", "agent-owner-prime", "b"),
			geist: externalRef("geist", "geist-owner-prime", "c"),
			prompt: externalRef("prompt", "prompt-owner-prime", "d"),
			skills: [...skillRefs],
			harness: externalRef("harness", "harness-owner-prime", "e"),
			toolManifest: externalRef("tool-manifest", "tools-owner-prime", "f"),
			toolGrant: externalRef("tool-grant", "grant-owner-prime", "0"),
			runtimeProfile: profileRef,
		},
		resolvedAt: 1_000,
	};
}

function embodiment(input: {
	id: string;
	runtime: AgentRuntimeBindingV2;
	ontology: AgentOntologyBindingV1;
	predecessorRef?: MeaningfulObjectRefV1<"embodiment">;
}): AgentEmbodimentV1 {
	return {
		schema: AGENT_EMBODIMENT_SCHEMA,
		embodimentId: input.id,
		ownerPrincipal: owner,
		agentId,
		runtimeBinding: input.runtime,
		runtimeBindingDigest: digestAgentRuntimeBindingV2(input.runtime),
		ontologyBinding: input.ontology,
		ontologyBindingDigest: digestAgentOntologyBinding(input.ontology),
		...(input.predecessorRef
			? { predecessorRef: input.predecessorRef, rollbackTargetRef: input.predecessorRef }
			: {}),
		createdAt: 1_000,
	};
}

function policy(): EvaluationPolicyV1 {
	return {
		schema: EVALUATION_POLICY_SCHEMA,
		policyId: "user-extension-v1",
		policyVersion: "1",
		ownerPrincipal: owner,
		evolutionClass: "extension",
		requiredSuites: [{ suiteRef: evaluationSuiteRef, required: true, maximumAgeMs: 86_400_000 }],
		thresholds: {
			requiredPassRate: 1,
			maximumNewSecurityFailures: 0,
			maximumCostRegressionPermille: 100,
			maximumLatencyRegressionPermille: 100,
		},
		approverPolicy: "owner",
		watchPolicy: {
			sessions: 3,
			durationMs: 3_600_000,
			automaticRollbackOn: ["host-protocol-fault", "security-denial-regression"],
		},
	};
}

async function makeStore(): Promise<AgentEvolutionStore> {
	const root = mkdtempSync(join(tmpdir(), "agent-evolution-"));
	roots.push(root);
	const store = new AgentEvolutionStore(join(root, "evolution.sqlite"));
	await store.init();
	return store;
}

async function prepareEligibleCandidate(store: AgentEvolutionStore): Promise<{
	base: AgentEmbodimentV1;
	baseRef: MeaningfulObjectRefV1<"embodiment">;
	next: AgentEmbodimentV1;
	nextRef: MeaningfulObjectRefV1<"embodiment">;
	candidate: EmbodimentCandidateV1;
	candidateRef: MeaningfulObjectRefV1<"embodiment-candidate">;
	decision: PromotionDecisionV1;
	decisionRef: MeaningfulObjectRefV1<"promotion-decision">;
}> {
	const incumbentRuntime = runtime();
	const base = embodiment({ id: "embodiment-001", runtime: incumbentRuntime, ontology: ontology() });
	const baseRef = await store.publishEvolutionObject({
		kind: "embodiment",
		graphId,
		version: "1",
		document: base,
		createdAt: 1_000,
	});
	await store.initializeActiveEmbodiment({ embodimentRef: baseRef, embodiment: base, now: 1_000 });

	const evaluationPolicy = policy();
	const policyRef = await store.publishEvolutionObject({
		kind: "evaluation-policy",
		graphId,
		version: "1",
		document: evaluationPolicy,
		createdAt: 1_001,
	});
	const proposal: EvolutionProposalV1 = {
		schema: EVOLUTION_PROPOSAL_SCHEMA,
		proposalId: "proposal-001",
		ownerPrincipal: owner,
		agentId,
		scope: { kind: "agent", agentId },
		proposedBy: agentId,
		targetLayer: "extension",
		expectedEmbodimentRef: baseRef,
		expectedEmbodimentDigest: baseRef.digest,
		problemStatement: "Repeated repository inspections lack a deterministic manifest summarizer.",
		rationale: "A narrow read-only extension can summarize manifests without widening grants.",
		evidenceRefs: [externalRef("testimony", "failure-observation-001", "1")],
		desiredOutcome: "Produce a stable JSON manifest summary.",
		nonGoals: ["No network access", "No shared runtime changes"],
		requestedSourceComposition: sourceCompositionRef,
		requestedEvaluationPolicy: policyRef,
		requestedAt: 1_002,
	};
	const proposalRef = await store.publishEvolutionObject({
		kind: "evolution-proposal",
		graphId,
		version: "1",
		document: proposal,
		createdAt: 1_002,
	});

	const overlay = {
		role: "user-extension" as const,
		ownerPrincipal: owner,
		artifact: releaseArtifactRef,
		manifestRef: extensionSkillRef,
		order: 0,
	};
	const nextRuntime = runtime([overlay]);
	const nextOntology = ontology([extensionSkillRef]);
	const next = embodiment({
		id: "embodiment-002",
		runtime: nextRuntime,
		ontology: nextOntology,
		predecessorRef: baseRef,
	});
	const nextRef = await store.publishEvolutionObject({
		kind: "embodiment",
		graphId,
		version: "1",
		document: next,
		createdAt: 1_003,
	});
	const verificationRun: ExtensionVerificationRunV1 = {
		schema: EXTENSION_VERIFICATION_RUN_SCHEMA,
		runId: "verification-001",
		ownerPrincipal: owner,
		agentId,
		candidateId: "candidate-001",
		candidateRuntimeBindingDigest: digestAgentRuntimeBindingV2(nextRuntime),
		artifactRef: releaseArtifactRef,
		artifactDigest: `sha256:${"8".repeat(64)}`,
		policyRef,
		suiteRef: evaluationSuiteRef,
		suiteDigest: `sha256:${"3".repeat(64)}`,
		securityIssues: [],
		cases: [
			{
				caseId: "abi-and-behavior",
				passed: true,
				deterministic: true,
				inputSchemaValid: true,
				outputSchemaValid: true,
				durationMs: 1,
				outputDigest: `sha256:${"4".repeat(64)}`,
			},
		],
		passed: true,
		passRate: 1,
		newSecurityFailures: 0,
		modelCalls: 0,
		tokens: 0,
		costUsdMicros: 0,
		startedAt: 1_003,
		completedAt: 1_004,
	};
	const evaluationRunRef = createMeaningfulObjectRef({
		kind: "verification-run",
		ownerPrincipal: owner,
		graphId,
		objectId: verificationRun.runId,
		version: "1",
		value: verificationRun,
	});
	const verificationRunRefs = [evaluationRunRef];
	const candidate: EmbodimentCandidateV1 = {
		schema: EMBODIMENT_CANDIDATE_SCHEMA,
		candidateId: "candidate-001",
		ownerPrincipal: owner,
		agentId,
		targetLayer: "extension",
		proposalRef,
		embodimentRef: nextRef,
		expectedIncumbent: baseRef,
		expectedIncumbentDigest: baseRef.digest,
		sourceCompositionRef,
		changeSetRef,
		patchSetRefs: [patchSetRef],
		buildReceiptRef,
		artifactRefs: [releaseArtifactRef],
		runtimeBinding: nextRuntime,
		runtimeBindingDigest: digestAgentRuntimeBindingV2(nextRuntime),
		ontologyBinding: nextOntology,
		ontologyBindingDigest: digestAgentOntologyBinding(nextOntology),
		evaluationPolicyRef: policyRef,
		verificationRunRefs,
		evaluationSetDigest: computeEvaluationSetDigest(verificationRunRefs),
		stateCompatibility: {
			readableCheckpointVersions: ["prime-checkpoint.v1"],
			writableCheckpointVersion: "prime-checkpoint.v1",
			reversible: true,
			coldStartAllowed: true,
		},
		createdAt: 1_004,
		expiresAt: 100_000,
		status: "eligible",
	};
	const candidateRef = await store.publishEvolutionObject({
		kind: "embodiment-candidate",
		graphId,
		version: "1",
		document: candidate,
		createdAt: 1_004,
	});
	const decision: PromotionDecisionV1 = {
		schema: PROMOTION_DECISION_SCHEMA,
		decisionId: "promotion-001",
		ownerPrincipal: owner,
		agentId,
		targetLayer: "extension",
		candidateRef,
		candidateDigest: candidateRef.digest,
		expectedIncumbentDigest: baseRef.digest,
		evaluationPolicyRef: policyRef,
		evaluationSetDigest: candidate.evaluationSetDigest,
		verdict: "approved",
		decidedBy: owner,
		approvalAuthority: "owner",
		decidedAt: 1_005,
		expiresAt: 100_000,
		reason: "The extension passes the pinned policy and stays within the existing grant.",
	};
	const decisionRef = await store.publishEvolutionObject({
		kind: "promotion-decision",
		graphId,
		version: "1",
		document: decision,
		createdAt: 1_005,
	});
	await store.recordCandidateEvaluation({
		candidateRef,
		verificationRuns: [{ ref: evaluationRunRef, run: verificationRun }],
		evaluatedBy: "service:independent-evaluator",
		evaluatedAt: 1_006,
	});
	return { base, baseRef, next, nextRef, candidate, candidateRef, decision, decisionRef };
}

describe("owner-scoped Agent evolution contracts", () => {
	it("validates a complete Embodiment and produces order-independent canonical digests", () => {
		const binding = runtime();
		const reordered = {
			extensionAbi: binding.extensionAbi,
			constraints: binding.constraints,
			profileRef: binding.profileRef,
			overlays: binding.overlays,
			baseBundle: binding.baseBundle,
			kind: binding.kind,
			schema: binding.schema,
		} as AgentRuntimeBindingV2;
		assert.equal(digestAgentRuntimeBindingV2(binding), digestAgentRuntimeBindingV2(reordered));
		validateAgentEmbodiment(embodiment({ id: "embodiment-valid", runtime: binding, ontology: ontology() }));
	});

	it("fails closed on platform scope, cross-owner refs, digest drift, evaluator overlays, and self-approval", () => {
		const binding = runtime();
		const base = embodiment({ id: "embodiment-invalid-probe", runtime: binding, ontology: ontology() });
		const baseRef = createMeaningfulObjectRef({
			kind: "embodiment",
			ownerPrincipal: owner,
			graphId,
			objectId: base.embodimentId,
			version: "1",
			value: base,
		});
		const evaluationPolicy = policy();
		const policyRef = createMeaningfulObjectRef({
			kind: "evaluation-policy",
			ownerPrincipal: owner,
			graphId,
			objectId: evaluationPolicy.policyId,
			version: "1",
			value: evaluationPolicy,
		});
		const proposal: EvolutionProposalV1 = {
			schema: EVOLUTION_PROPOSAL_SCHEMA,
			proposalId: "proposal-invalid-probe",
			ownerPrincipal: owner,
			agentId,
			scope: { kind: "agent", agentId },
			proposedBy: agentId,
			targetLayer: "extension",
			expectedEmbodimentRef: baseRef,
			expectedEmbodimentDigest: baseRef.digest,
			problemStatement: "A repeated limitation.",
			rationale: "A bounded extension can address it.",
			evidenceRefs: [],
			desiredOutcome: "The limitation is removed.",
			nonGoals: [],
			requestedEvaluationPolicy: policyRef,
			requestedAt: 1,
		};
		validateEvolutionProposal(proposal);
		assert.throws(
			() => validateEvolutionProposal({ ...proposal, scope: { kind: "platform", agentId } }),
			AgentEvolutionFault,
		);
		assert.throws(
			() =>
				validateEvolutionProposal({
					...proposal,
					requestedEvaluationPolicy: { ...policyRef, ownerPrincipal: "user:someone-else" },
				}),
			AgentEvolutionFault,
		);
		assert.throws(
			() => validateEvolutionProposal({ ...proposal, expectedEmbodimentDigest: `sha256:${"0".repeat(64)}` }),
			AgentEvolutionFault,
		);
		assert.throws(
			() =>
				validateAgentEmbodiment({
					...base,
					runtimeBinding: {
						...binding,
						overlays: [
							{
								role: "evaluation-fixture",
								ownerPrincipal: owner,
								artifact: releaseArtifactRef,
								manifestRef: extensionSkillRef,
								order: 0,
							},
						],
					},
				}),
			AgentEvolutionFault,
		);
		const fakeCandidateRef = externalRef("embodiment-candidate", "candidate-self-approved", "a");
		const decision: PromotionDecisionV1 = {
			schema: PROMOTION_DECISION_SCHEMA,
			decisionId: "promotion-self-approved",
			ownerPrincipal: owner,
			agentId,
			targetLayer: "extension",
			candidateRef: fakeCandidateRef,
			candidateDigest: fakeCandidateRef.digest,
			expectedIncumbentDigest: baseRef.digest,
			evaluationPolicyRef: policyRef,
			evaluationSetDigest: `sha256:${"b".repeat(64)}`,
			verdict: "approved",
			decidedBy: agentId,
			approvalAuthority: "owner",
			decidedAt: 1,
			expiresAt: 2,
		};
		assert.throws(() => validatePromotionDecision(decision), AgentEvolutionFault);
		assert.throws(
			() => validateEvaluationPolicy({ ...evaluationPolicy, ownerPrincipal: "platform:sophia" }),
			AgentEvolutionFault,
		);
	});
});

describe("AgentEvolutionStore", () => {
	it("rebases only an unevolved bootstrap head onto a fresh host binding", async () => {
		const store = await makeStore();
		const base = embodiment({
			id: "embodiment-bootstrap-old",
			runtime: runtime(),
			ontology: ontology(),
		});
		const baseRef = await store.publishEvolutionObject({
			kind: "embodiment",
			graphId,
			version: "1",
			document: base,
			createdAt: 1_000,
		});
		const head = await store.initializeActiveEmbodiment({ embodimentRef: baseRef, embodiment: base, now: 1_000 });
		const fresh = embodiment({
			id: "embodiment-bootstrap-fresh",
			runtime: runtime(),
			ontology: { ...ontology(), resolvedAt: 2_000 },
		});
		const freshRef = await store.publishEvolutionObject({
			kind: "embodiment",
			graphId,
			version: "1",
			document: fresh,
			createdAt: 2_000,
		});
		const rebound = await store.rebindBootstrapEmbodiment({
			expectedHead: head,
			embodimentRef: freshRef,
			embodiment: fresh,
			now: 2_000,
		});
		assert.equal(rebound.embodimentRef.digest, freshRef.digest);
		assert.equal(rebound.revision, 2);
		await assert.rejects(
			() =>
				store.rebindBootstrapEmbodiment({
					expectedHead: head,
					embodimentRef: baseRef,
					embodiment: base,
					now: 3_000,
				}),
			EmbodimentActivationConflictError,
		);
		store.close();
	});

	it("pins a canary without changing the future-session head", async () => {
		const store = await makeStore();
		const scenario = await prepareEligibleCandidate(store);
		const committed = await store.commitActivation({
			activationId: "activation-canary-001",
			graphId,
			version: "1",
			ownerPrincipal: owner,
			agentId,
			expectedIncumbentRef: scenario.baseRef,
			nextEmbodimentRef: scenario.nextRef,
			candidateRef: scenario.candidateRef,
			promotionDecisionRef: scenario.decisionRef,
			mode: "canary-session",
			committedBy: owner,
			committedAt: 1_010,
		});
		assert.equal(committed.head.embodimentRef.digest, scenario.baseRef.digest);
		assert.equal(
			(await store.resolveEmbodiment({ ownerPrincipal: owner, agentId }))?.embodimentRef.digest,
			scenario.baseRef.digest,
		);
		assert.equal(
			(
				await store.resolveEmbodiment({
					ownerPrincipal: owner,
					agentId,
					canaryActivationId: committed.activation.activationId,
				})
			)?.embodimentRef.digest,
			scenario.nextRef.digest,
		);
		store.close();
	});

	it("admits one concurrent activation winner, preserves the old generation, and rolls back", async () => {
		const store = await makeStore();
		const scenario = await prepareEligibleCandidate(store);
		const activate = (activationId: string) =>
			store.commitActivation({
				activationId,
				graphId,
				version: "1",
				ownerPrincipal: owner,
				agentId,
				expectedIncumbentRef: scenario.baseRef,
				nextEmbodimentRef: scenario.nextRef,
				candidateRef: scenario.candidateRef,
				promotionDecisionRef: scenario.decisionRef,
				mode: "future-sessions" as const,
				committedBy: owner,
				committedAt: 1_010,
			});
		const results = await Promise.allSettled([activate("activation-future-a"), activate("activation-future-b")]);
		const fulfilled = results.filter((result) => result.status === "fulfilled");
		const rejected = results.filter((result) => result.status === "rejected");
		assert.equal(fulfilled.length, 1);
		assert.equal(rejected.length, 1);
		assert.ok(rejected[0]?.status === "rejected" && rejected[0].reason instanceof EmbodimentActivationConflictError);
		const activation = fulfilled[0];
		assert.equal(activation?.status, "fulfilled");
		if (activation?.status !== "fulfilled") throw new Error("activation unexpectedly failed");
		assert.equal(activation.value.head.embodimentRef.digest, scenario.nextRef.digest);
		assert.ok(await store.getEvolutionObject(scenario.baseRef), "incumbent remains reachable after succession");

		const rollback = await store.commitRollback({
			decisionId: "rollback-001",
			graphId,
			version: "1",
			ownerPrincipal: owner,
			agentId,
			activationRef: activation.value.activationRef,
			targetEmbodimentRef: scenario.baseRef,
			evidenceRefs: [externalRef("testimony", "canary-regression-001", "c")],
			decidedBy: owner,
			automatic: false,
			reason: "Exercise the required rollback path.",
			decidedAt: 1_020,
			quarantineCurrent: false,
		});
		assert.equal(rollback.head.embodimentRef.digest, scenario.baseRef.digest);
		assert.equal(rollback.head.revision, 3);
		assert.ok(await store.getEvolutionObject(rollback.decisionRef));
		store.close();
	});

	it("denies activation without independent eligibility and rejects owner or incumbent drift", async () => {
		const store = await makeStore();
		const scenario = await prepareEligibleCandidate(store);
		const alienExpected = { ...scenario.baseRef, ownerPrincipal: "user:someone-else" };
		await assert.rejects(
			() =>
				store.commitActivation({
					activationId: "activation-alien",
					graphId,
					version: "1",
					ownerPrincipal: "user:someone-else",
					agentId,
					expectedIncumbentRef: alienExpected,
					nextEmbodimentRef: scenario.nextRef,
					candidateRef: scenario.candidateRef,
					promotionDecisionRef: scenario.decisionRef,
					mode: "future-sessions",
					committedBy: "user:someone-else",
					committedAt: 1_010,
				}),
			EmbodimentActivationConflictError,
		);

		const unevaluatedCandidate: EmbodimentCandidateV1 = {
			...scenario.candidate,
			candidateId: "candidate-unevaluated",
			status: "eligible",
		};
		const unevaluatedRef = await store.publishEvolutionObject({
			kind: "embodiment-candidate",
			graphId,
			version: "1",
			document: unevaluatedCandidate,
			createdAt: 1_011,
		});
		const unevaluatedDecision: PromotionDecisionV1 = {
			...scenario.decision,
			decisionId: "promotion-unevaluated",
			candidateRef: unevaluatedRef,
			candidateDigest: unevaluatedRef.digest,
		};
		const unevaluatedDecisionRef = await store.publishEvolutionObject({
			kind: "promotion-decision",
			graphId,
			version: "1",
			document: unevaluatedDecision,
			createdAt: 1_012,
		});
		await assert.rejects(
			() =>
				store.commitActivation({
					activationId: "activation-unevaluated",
					graphId,
					version: "1",
					ownerPrincipal: owner,
					agentId,
					expectedIncumbentRef: scenario.baseRef,
					nextEmbodimentRef: scenario.nextRef,
					candidateRef: unevaluatedRef,
					promotionDecisionRef: unevaluatedDecisionRef,
					mode: "future-sessions",
					committedBy: owner,
					committedAt: 1_013,
				}),
			/independently recorded evaluation/,
		);
		store.close();
	});
});
