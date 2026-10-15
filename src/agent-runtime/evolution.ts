import { createHash } from "node:crypto";
import { CANONICAL_AGENT_ID } from "../agent-subject/agent-ontology.js";
import {
	type MeaningfulObjectKind,
	type MeaningfulObjectRefV1,
	sameMeaningfulObjectRef,
	validateMeaningfulObjectRef,
} from "./meaningful-object.js";
import {
	type AgentOntologyBindingV1,
	assertAgentOntologyRuntimeMatch,
	digestAgentOntologyBinding,
	validateAgentOntologyBinding,
} from "./ontology-binding.js";
import {
	AGENT_RUNTIME_BINDING_SCHEMA,
	type AgentRuntimeBundleRefV1,
	type AgentRuntimeKind,
	type AgentRuntimeConstraintsV2 as BaseAgentRuntimeConstraintsV2,
	validateResolvedAgentRuntimeBinding,
} from "./profile.js";

export const AGENT_RUNTIME_BINDING_V2_SCHEMA = "choreograph.agent-runtime-binding.v2" as const;
export const AGENT_EMBODIMENT_SCHEMA = "sophia.agent-embodiment.v1" as const;
export const EVOLUTION_PROPOSAL_SCHEMA = "sophia.evolution-proposal.v1" as const;
export const EMBODIMENT_CANDIDATE_SCHEMA = "sophia.embodiment-candidate.v1" as const;
export const EVALUATION_POLICY_SCHEMA = "sophia.agent-evaluation-policy.v1" as const;
export const PROMOTION_DECISION_SCHEMA = "sophia.promotion-decision.v1" as const;
export const EMBODIMENT_ACTIVATION_SCHEMA = "sophia.embodiment-activation.v1" as const;
export const ROLLBACK_DECISION_SCHEMA = "sophia.rollback-decision.v1" as const;

export type EvolutionLayer = "harness" | "extension" | "embodiment" | "constitutional-core";
export type ActivatableEvolutionLayer = Exclude<EvolutionLayer, "constitutional-core">;
export type RuntimeOverlayRole = "user-extension" | "project-extension" | "evaluation-fixture";
export type EvolutionObjectKind =
	| "embodiment"
	| "evolution-proposal"
	| "embodiment-candidate"
	| "evaluation-policy"
	| "promotion-decision"
	| "embodiment-activation"
	| "rollback-decision";

/** The first service is intentionally narrower than the eventual scope lattice. */
export interface AgentEvolutionScopeV1 {
	readonly kind: "agent";
	readonly agentId: string;
}

export interface RuntimeOverlayRefV1 {
	readonly role: RuntimeOverlayRole;
	readonly ownerPrincipal: string;
	readonly artifact: MeaningfulObjectRefV1<"release-artifact">;
	readonly manifestRef: MeaningfulObjectRefV1<"skill" | "tool-manifest" | "harness">;
	readonly order: number;
}

export interface AgentRuntimeBindingV2 {
	readonly schema: typeof AGENT_RUNTIME_BINDING_V2_SCHEMA;
	readonly kind: AgentRuntimeKind;
	readonly baseBundle: AgentRuntimeBundleRefV1;
	readonly overlays: readonly RuntimeOverlayRefV1[];
	readonly profileRef: MeaningfulObjectRefV1<"agent-runtime-profile">;
	readonly constraints: BaseAgentRuntimeConstraintsV2;
	readonly extensionAbi: string;
}

export interface AgentEmbodimentV1 {
	readonly schema: typeof AGENT_EMBODIMENT_SCHEMA;
	readonly embodimentId: string;
	readonly ownerPrincipal: string;
	readonly agentId: string;
	readonly runtimeBinding: AgentRuntimeBindingV2;
	readonly runtimeBindingDigest: string;
	readonly ontologyBinding: AgentOntologyBindingV1;
	readonly ontologyBindingDigest: string;
	readonly predecessorRef?: MeaningfulObjectRefV1<"embodiment">;
	readonly rollbackTargetRef?: MeaningfulObjectRefV1<"embodiment">;
	readonly createdAt: number;
}

export interface EvolutionProposalV1 {
	readonly schema: typeof EVOLUTION_PROPOSAL_SCHEMA;
	readonly proposalId: string;
	readonly ownerPrincipal: string;
	readonly agentId: string;
	readonly scope: AgentEvolutionScopeV1;
	readonly proposedBy: string;
	readonly targetLayer: EvolutionLayer;
	readonly expectedEmbodimentRef: MeaningfulObjectRefV1<"embodiment">;
	readonly expectedEmbodimentDigest: string;
	readonly problemStatement: string;
	readonly rationale: string;
	readonly evidenceRefs: readonly MeaningfulObjectRefV1[];
	readonly desiredOutcome: string;
	readonly nonGoals: readonly string[];
	readonly requestedSourceComposition?: MeaningfulObjectRefV1<"source-composition">;
	readonly requestedEvaluationPolicy: MeaningfulObjectRefV1<"evaluation-policy">;
	readonly requestedAt: number;
}

export interface EmbodimentCandidateV1 {
	readonly schema: typeof EMBODIMENT_CANDIDATE_SCHEMA;
	readonly candidateId: string;
	readonly ownerPrincipal: string;
	readonly agentId: string;
	readonly targetLayer: ActivatableEvolutionLayer;
	readonly proposalRef: MeaningfulObjectRefV1<"evolution-proposal">;
	readonly embodimentRef: MeaningfulObjectRefV1<"embodiment">;
	readonly expectedIncumbent: MeaningfulObjectRefV1<"embodiment">;
	readonly expectedIncumbentDigest: string;
	readonly sourceCompositionRef: MeaningfulObjectRefV1<"source-composition">;
	readonly changeSetRef: MeaningfulObjectRefV1<"change-set">;
	readonly patchSetRefs: readonly MeaningfulObjectRefV1<"patch-set">[];
	readonly buildReceiptRef: MeaningfulObjectRefV1<"build-receipt">;
	readonly artifactRefs: readonly MeaningfulObjectRefV1<"release-artifact">[];
	readonly runtimeBinding: AgentRuntimeBindingV2;
	readonly runtimeBindingDigest: string;
	readonly ontologyBinding: AgentOntologyBindingV1;
	readonly ontologyBindingDigest: string;
	readonly evaluationPolicyRef: MeaningfulObjectRefV1<"evaluation-policy">;
	readonly verificationRunRefs: readonly MeaningfulObjectRefV1<"verification-run">[];
	readonly evaluationSetDigest: string;
	readonly stateCompatibility: {
		readonly readableCheckpointVersions: readonly string[];
		readonly writableCheckpointVersion: string;
		readonly migrationArtifactRef?: MeaningfulObjectRefV1;
		readonly reversible: boolean;
		readonly coldStartAllowed: boolean;
	};
	readonly createdAt: number;
	readonly expiresAt: number;
	readonly status: "candidate" | "eligible" | "ineligible" | "stale" | "quarantined";
}

export interface EvaluationPolicyV1 {
	readonly schema: typeof EVALUATION_POLICY_SCHEMA;
	readonly policyId: string;
	readonly policyVersion: string;
	readonly ownerPrincipal: string;
	readonly evolutionClass: EvolutionLayer;
	readonly requiredSuites: readonly {
		readonly suiteRef: MeaningfulObjectRefV1<"evaluation-suite">;
		readonly required: boolean;
		readonly maximumAgeMs?: number;
	}[];
	readonly thresholds: {
		readonly requiredPassRate: number;
		readonly maximumNewSecurityFailures: 0;
		readonly maximumCostRegressionPermille?: number;
		readonly maximumLatencyRegressionPermille?: number;
	};
	readonly approverPolicy: "owner" | "two-party" | "shared-release";
	readonly watchPolicy: {
		readonly sessions?: number;
		readonly durationMs?: number;
		readonly automaticRollbackOn: readonly string[];
	};
}

export interface PromotionDecisionV1 {
	readonly schema: typeof PROMOTION_DECISION_SCHEMA;
	readonly decisionId: string;
	readonly ownerPrincipal: string;
	readonly agentId: string;
	readonly targetLayer: ActivatableEvolutionLayer;
	readonly candidateRef: MeaningfulObjectRefV1<"embodiment-candidate">;
	readonly candidateDigest: string;
	readonly expectedIncumbentDigest: string;
	readonly evaluationPolicyRef: MeaningfulObjectRefV1<"evaluation-policy">;
	readonly evaluationSetDigest: string;
	readonly verdict: "approved" | "rejected";
	readonly decidedBy: string;
	readonly approvalAuthority: "owner" | "steward";
	readonly decidedAt: number;
	readonly expiresAt: number;
	readonly reason?: string;
}

export interface EmbodimentActivationV1 {
	readonly schema: typeof EMBODIMENT_ACTIVATION_SCHEMA;
	readonly activationId: string;
	readonly ownerPrincipal: string;
	readonly agentId: string;
	readonly expectedIncumbentRef: MeaningfulObjectRefV1<"embodiment">;
	readonly expectedIncumbentDigest: string;
	readonly nextEmbodimentRef: MeaningfulObjectRefV1<"embodiment">;
	readonly nextEmbodimentDigest: string;
	readonly candidateRef: MeaningfulObjectRefV1<"embodiment-candidate">;
	readonly promotionDecisionRef: MeaningfulObjectRefV1<"promotion-decision">;
	readonly mode: "future-sessions" | "canary-session" | "safe-point-resume";
	readonly rollbackTargetRef: MeaningfulObjectRefV1<"embodiment">;
	readonly committedBy: string;
	readonly committedAt: number;
	readonly transactionRevision: number;
}

export interface RollbackDecisionV1 {
	readonly schema: typeof ROLLBACK_DECISION_SCHEMA;
	readonly decisionId: string;
	readonly ownerPrincipal: string;
	readonly agentId: string;
	readonly activationRef: MeaningfulObjectRefV1<"embodiment-activation">;
	readonly fromEmbodimentRef: MeaningfulObjectRefV1<"embodiment">;
	readonly fromEmbodimentDigest: string;
	readonly toEmbodimentRef: MeaningfulObjectRefV1<"embodiment">;
	readonly toEmbodimentDigest: string;
	readonly evidenceRefs: readonly MeaningfulObjectRefV1[];
	readonly decidedBy: string;
	readonly automatic: boolean;
	readonly reason: string;
	readonly decidedAt: number;
	readonly transactionRevision: number;
}

export type EvolutionDocumentV1 =
	| AgentEmbodimentV1
	| EvolutionProposalV1
	| EmbodimentCandidateV1
	| EvaluationPolicyV1
	| PromotionDecisionV1
	| EmbodimentActivationV1
	| RollbackDecisionV1;

export class AgentEvolutionFault extends Error {
	readonly code = "agent_evolution_invalid";

	constructor(
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "AgentEvolutionFault";
	}
}

export function validateAgentRuntimeBindingV2(value: unknown): asserts value is AgentRuntimeBindingV2 {
	const binding = asRecord(value, "runtime binding v2");
	knownKeys(binding, ["schema", "kind", "baseBundle", "overlays", "profileRef", "constraints", "extensionAbi"]);
	if (binding.schema !== AGENT_RUNTIME_BINDING_V2_SCHEMA) fault("runtime binding v2 schema is unsupported");
	validateResolvedAgentRuntimeBinding({
		schema: AGENT_RUNTIME_BINDING_SCHEMA,
		kind: binding.kind,
		bundle: binding.baseBundle,
		profileRef: binding.profileRef,
		constraints: binding.constraints,
	});
	if (!Array.isArray(binding.overlays)) fault("runtime binding v2 overlays must be an array");
	for (let index = 0; index < binding.overlays.length; index += 1) {
		const overlay = asRecord(binding.overlays[index], `runtime overlay ${index}`);
		knownKeys(overlay, ["role", "ownerPrincipal", "artifact", "manifestRef", "order"]);
		if (
			!new Set(["user-extension", "project-extension", "evaluation-fixture"]).has(
				string(overlay.role, "overlay.role"),
			)
		) {
			fault("runtime overlay role is unsupported", { role: overlay.role });
		}
		userPrincipal(overlay.ownerPrincipal, "overlay.ownerPrincipal");
		ref(overlay.artifact, "release-artifact", "overlay.artifact");
		ref(overlay.manifestRef, undefined, "overlay.manifestRef");
		const manifestKind = (overlay.manifestRef as MeaningfulObjectRefV1).kind;
		if (!new Set(["skill", "tool-manifest", "harness"]).has(manifestKind)) {
			fault("runtime overlay manifest kind is unsupported", { manifestKind });
		}
		if (integer(overlay.order, "overlay.order") !== index) {
			fault("runtime overlays must use contiguous canonical order", { expected: index, actual: overlay.order });
		}
		const owner = string(overlay.ownerPrincipal, "overlay.ownerPrincipal");
		assertRefOwner(overlay.artifact as MeaningfulObjectRefV1, owner, "overlay.artifact");
		assertRefOwner(overlay.manifestRef as MeaningfulObjectRefV1, owner, "overlay.manifestRef");
	}
	nonEmptyString(binding.extensionAbi, "runtime binding v2 extensionAbi");
}

export function digestAgentRuntimeBindingV2(binding: AgentRuntimeBindingV2): string {
	validateAgentRuntimeBindingV2(binding);
	return digest(binding);
}

export function validateAgentEmbodiment(value: unknown): asserts value is AgentEmbodimentV1 {
	const embodiment = asRecord(value, "Agent Embodiment");
	knownKeys(embodiment, [
		"schema",
		"embodimentId",
		"ownerPrincipal",
		"agentId",
		"runtimeBinding",
		"runtimeBindingDigest",
		"ontologyBinding",
		"ontologyBindingDigest",
		"predecessorRef",
		"rollbackTargetRef",
		"createdAt",
	]);
	if (embodiment.schema !== AGENT_EMBODIMENT_SCHEMA) fault("Agent Embodiment schema is unsupported");
	nonEmptyString(embodiment.embodimentId, "embodimentId");
	const owner = userPrincipal(embodiment.ownerPrincipal, "ownerPrincipal");
	const agentId = agentIdentity(embodiment.agentId, "agentId");
	validateAgentRuntimeBindingV2(embodiment.runtimeBinding);
	assertDigestEquals(
		embodiment.runtimeBindingDigest,
		digestAgentRuntimeBindingV2(embodiment.runtimeBinding),
		"runtimeBindingDigest",
	);
	validateAgentOntologyBinding(embodiment.ontologyBinding);
	assertDigestEquals(
		embodiment.ontologyBindingDigest,
		digestAgentOntologyBinding(embodiment.ontologyBinding),
		"ontologyBindingDigest",
	);
	assertOntologyOwner(embodiment.ontologyBinding, owner);
	assertAgentOntologyRuntimeMatch(embodiment.ontologyBinding, {
		agentId,
		runtimeProfileRef: embodiment.runtimeBinding.profileRef,
	});
	for (const overlay of embodiment.runtimeBinding.overlays) {
		if (overlay.role === "evaluation-fixture") fault("an Embodiment cannot activate evaluation-fixture overlays");
		if (overlay.ownerPrincipal !== owner) fault("runtime overlay owner differs from Embodiment owner");
	}
	optionalOwnedRef(embodiment.predecessorRef, "embodiment", owner, "predecessorRef");
	optionalOwnedRef(embodiment.rollbackTargetRef, "embodiment", owner, "rollbackTargetRef");
	epoch(embodiment.createdAt, "createdAt");
}

export function digestAgentEmbodiment(embodiment: AgentEmbodimentV1): string {
	validateAgentEmbodiment(embodiment);
	return digest(embodiment);
}

export function validateEvolutionProposal(value: unknown): asserts value is EvolutionProposalV1 {
	const proposal = asRecord(value, "evolution proposal");
	knownKeys(proposal, [
		"schema",
		"proposalId",
		"ownerPrincipal",
		"agentId",
		"scope",
		"proposedBy",
		"targetLayer",
		"expectedEmbodimentRef",
		"expectedEmbodimentDigest",
		"problemStatement",
		"rationale",
		"evidenceRefs",
		"desiredOutcome",
		"nonGoals",
		"requestedSourceComposition",
		"requestedEvaluationPolicy",
		"requestedAt",
	]);
	if (proposal.schema !== EVOLUTION_PROPOSAL_SCHEMA) fault("evolution proposal schema is unsupported");
	nonEmptyString(proposal.proposalId, "proposalId");
	const owner = userPrincipal(proposal.ownerPrincipal, "ownerPrincipal");
	const agentId = agentIdentity(proposal.agentId, "agentId");
	const scope = asRecord(proposal.scope, "scope");
	knownKeys(scope, ["kind", "agentId"]);
	if (scope.kind !== "agent" || scope.agentId !== agentId) fault("only exact Agent-scoped evolution is supported");
	nonEmptyString(proposal.proposedBy, "proposedBy");
	oneOf(proposal.targetLayer, ["harness", "extension", "embodiment", "constitutional-core"], "targetLayer");
	ownedRef(proposal.expectedEmbodimentRef, "embodiment", owner, "expectedEmbodimentRef");
	assertDigestEquals(
		proposal.expectedEmbodimentDigest,
		(proposal.expectedEmbodimentRef as MeaningfulObjectRefV1).digest,
		"expectedEmbodimentDigest",
	);
	nonEmptyString(proposal.problemStatement, "problemStatement");
	nonEmptyString(proposal.rationale, "rationale");
	ownedRefArray(proposal.evidenceRefs, undefined, owner, "evidenceRefs", false);
	nonEmptyString(proposal.desiredOutcome, "desiredOutcome");
	stringArray(proposal.nonGoals, "nonGoals");
	optionalOwnedRef(proposal.requestedSourceComposition, "source-composition", owner, "requestedSourceComposition");
	ownedRef(proposal.requestedEvaluationPolicy, "evaluation-policy", owner, "requestedEvaluationPolicy");
	epoch(proposal.requestedAt, "requestedAt");
}

export function digestEvolutionProposal(proposal: EvolutionProposalV1): string {
	validateEvolutionProposal(proposal);
	return digest(proposal);
}

export function computeEvaluationSetDigest(refs: readonly MeaningfulObjectRefV1<"verification-run">[]): string {
	for (const item of refs) ref(item, "verification-run", "verificationRunRefs item");
	const canonical = [...refs].sort((left, right) => referenceKey(left).localeCompare(referenceKey(right)));
	if (new Set(canonical.map(referenceKey)).size !== canonical.length) fault("evaluation set contains duplicate runs");
	return digest(canonical);
}

export function validateEmbodimentCandidate(
	value: unknown,
	context?: { readonly proposal?: EvolutionProposalV1; readonly embodiment?: AgentEmbodimentV1 },
): asserts value is EmbodimentCandidateV1 {
	const candidate = asRecord(value, "Embodiment candidate");
	knownKeys(candidate, [
		"schema",
		"candidateId",
		"ownerPrincipal",
		"agentId",
		"targetLayer",
		"proposalRef",
		"embodimentRef",
		"expectedIncumbent",
		"expectedIncumbentDigest",
		"sourceCompositionRef",
		"changeSetRef",
		"patchSetRefs",
		"buildReceiptRef",
		"artifactRefs",
		"runtimeBinding",
		"runtimeBindingDigest",
		"ontologyBinding",
		"ontologyBindingDigest",
		"evaluationPolicyRef",
		"verificationRunRefs",
		"evaluationSetDigest",
		"stateCompatibility",
		"createdAt",
		"expiresAt",
		"status",
	]);
	if (candidate.schema !== EMBODIMENT_CANDIDATE_SCHEMA) fault("Embodiment candidate schema is unsupported");
	nonEmptyString(candidate.candidateId, "candidateId");
	const owner = userPrincipal(candidate.ownerPrincipal, "ownerPrincipal");
	const agentId = agentIdentity(candidate.agentId, "agentId");
	oneOf(candidate.targetLayer, ["harness", "extension", "embodiment"], "targetLayer");
	ownedRef(candidate.proposalRef, "evolution-proposal", owner, "proposalRef");
	ownedRef(candidate.embodimentRef, "embodiment", owner, "embodimentRef");
	ownedRef(candidate.expectedIncumbent, "embodiment", owner, "expectedIncumbent");
	assertDigestEquals(
		candidate.expectedIncumbentDigest,
		(candidate.expectedIncumbent as MeaningfulObjectRefV1).digest,
		"expectedIncumbentDigest",
	);
	ownedRef(candidate.sourceCompositionRef, "source-composition", owner, "sourceCompositionRef");
	ownedRef(candidate.changeSetRef, "change-set", owner, "changeSetRef");
	ownedRefArray(candidate.patchSetRefs, "patch-set", owner, "patchSetRefs", true);
	ownedRef(candidate.buildReceiptRef, "build-receipt", owner, "buildReceiptRef");
	ownedRefArray(candidate.artifactRefs, "release-artifact", owner, "artifactRefs", true);
	validateAgentRuntimeBindingV2(candidate.runtimeBinding);
	for (const overlay of candidate.runtimeBinding.overlays) {
		if (overlay.role === "evaluation-fixture") fault("candidate runtime cannot include evaluator fixtures");
		if (overlay.ownerPrincipal !== owner) fault("candidate runtime overlay owner differs from candidate owner");
	}
	assertDigestEquals(
		candidate.runtimeBindingDigest,
		digestAgentRuntimeBindingV2(candidate.runtimeBinding),
		"runtimeBindingDigest",
	);
	validateAgentOntologyBinding(candidate.ontologyBinding);
	assertOntologyOwner(candidate.ontologyBinding, owner);
	assertAgentOntologyRuntimeMatch(candidate.ontologyBinding, {
		agentId,
		runtimeProfileRef: candidate.runtimeBinding.profileRef,
	});
	assertDigestEquals(
		candidate.ontologyBindingDigest,
		digestAgentOntologyBinding(candidate.ontologyBinding),
		"ontologyBindingDigest",
	);
	ownedRef(candidate.evaluationPolicyRef, "evaluation-policy", owner, "evaluationPolicyRef");
	const candidateStatus = oneOf(
		candidate.status,
		["candidate", "eligible", "ineligible", "stale", "quarantined"],
		"status",
	);
	const verificationRefs = ownedRefArray(
		candidate.verificationRunRefs,
		"verification-run",
		owner,
		"verificationRunRefs",
		candidateStatus !== "candidate",
	) as readonly MeaningfulObjectRefV1<"verification-run">[];
	assertDigestEquals(
		candidate.evaluationSetDigest,
		computeEvaluationSetDigest(verificationRefs),
		"evaluationSetDigest",
	);
	const state = asRecord(candidate.stateCompatibility, "stateCompatibility");
	knownKeys(state, [
		"readableCheckpointVersions",
		"writableCheckpointVersion",
		"migrationArtifactRef",
		"reversible",
		"coldStartAllowed",
	]);
	const readable = stringArray(state.readableCheckpointVersions, "readableCheckpointVersions");
	if (new Set(readable).size !== readable.length) fault("readable checkpoint versions contain duplicates");
	const writable = nonEmptyString(state.writableCheckpointVersion, "writableCheckpointVersion");
	if (!readable.includes(writable)) fault("writable checkpoint version must also be readable");
	optionalOwnedRef(state.migrationArtifactRef, undefined, owner, "migrationArtifactRef");
	boolean(state.reversible, "reversible");
	boolean(state.coldStartAllowed, "coldStartAllowed");
	const createdAt = epoch(candidate.createdAt, "createdAt");
	const expiresAt = epoch(candidate.expiresAt, "expiresAt");
	if (expiresAt <= createdAt) fault("candidate expiresAt must be after createdAt");
	if (context?.proposal) {
		validateEvolutionProposal(context.proposal);
		if (context.proposal.ownerPrincipal !== owner || context.proposal.agentId !== agentId) {
			fault("candidate owner or Agent differs from its proposal");
		}
		if (
			!sameMeaningfulObjectRef(
				candidate.expectedIncumbent as MeaningfulObjectRefV1,
				context.proposal.expectedEmbodimentRef,
			)
		) {
			fault("candidate incumbent differs from the proposal target");
		}
		if (candidate.targetLayer !== context.proposal.targetLayer) fault("candidate target layer differs from proposal");
	}
	if (context?.embodiment) {
		validateAgentEmbodiment(context.embodiment);
		if (context.embodiment.ownerPrincipal !== owner || context.embodiment.agentId !== agentId) {
			fault("candidate Embodiment owner or Agent differs from candidate");
		}
		if (
			context.embodiment.runtimeBindingDigest !== candidate.runtimeBindingDigest ||
			context.embodiment.ontologyBindingDigest !== candidate.ontologyBindingDigest
		) {
			fault("candidate bindings differ from its proposed Embodiment");
		}
	}
}

export function digestEmbodimentCandidate(candidate: EmbodimentCandidateV1): string {
	validateEmbodimentCandidate(candidate);
	return digest(candidate);
}

export function validateEvaluationPolicy(value: unknown): asserts value is EvaluationPolicyV1 {
	const policy = asRecord(value, "evaluation policy");
	knownKeys(policy, [
		"schema",
		"policyId",
		"policyVersion",
		"ownerPrincipal",
		"evolutionClass",
		"requiredSuites",
		"thresholds",
		"approverPolicy",
		"watchPolicy",
	]);
	if (policy.schema !== EVALUATION_POLICY_SCHEMA) fault("evaluation policy schema is unsupported");
	nonEmptyString(policy.policyId, "policyId");
	nonEmptyString(policy.policyVersion, "policyVersion");
	const owner = userPrincipal(policy.ownerPrincipal, "ownerPrincipal");
	const evolutionClass = oneOf(
		policy.evolutionClass,
		["harness", "extension", "embodiment", "constitutional-core"],
		"evolutionClass",
	);
	if (!Array.isArray(policy.requiredSuites) || policy.requiredSuites.length === 0) {
		fault("evaluation policy requires at least one suite");
	}
	const suiteKeys = new Set<string>();
	for (const item of policy.requiredSuites) {
		const suite = asRecord(item, "required suite");
		knownKeys(suite, ["suiteRef", "required", "maximumAgeMs"]);
		ownedRef(suite.suiteRef, "evaluation-suite", owner, "suiteRef");
		boolean(suite.required, "required suite required");
		if (suite.maximumAgeMs !== undefined) positiveInteger(suite.maximumAgeMs, "maximumAgeMs");
		const key = referenceKey(suite.suiteRef as MeaningfulObjectRefV1);
		if (suiteKeys.has(key)) fault("evaluation policy contains a duplicate suite");
		suiteKeys.add(key);
	}
	const thresholds = asRecord(policy.thresholds, "thresholds");
	knownKeys(thresholds, [
		"requiredPassRate",
		"maximumNewSecurityFailures",
		"maximumCostRegressionPermille",
		"maximumLatencyRegressionPermille",
	]);
	const passRate = number(thresholds.requiredPassRate, "requiredPassRate");
	if (passRate < 0 || passRate > 1) fault("requiredPassRate must be between zero and one");
	if (thresholds.maximumNewSecurityFailures !== 0) fault("new security failures must never be allowed");
	optionalNonNegativeInteger(thresholds.maximumCostRegressionPermille, "maximumCostRegressionPermille");
	optionalNonNegativeInteger(thresholds.maximumLatencyRegressionPermille, "maximumLatencyRegressionPermille");
	const approver = oneOf(policy.approverPolicy, ["owner", "two-party", "shared-release"], "approverPolicy");
	if (evolutionClass === "constitutional-core" && approver !== "shared-release") {
		fault("constitutional-core evolution requires the shared release lane");
	}
	if (evolutionClass !== "constitutional-core" && approver === "shared-release") {
		fault("owner-scoped evolution cannot claim shared-release authority");
	}
	const watch = asRecord(policy.watchPolicy, "watchPolicy");
	knownKeys(watch, ["sessions", "durationMs", "automaticRollbackOn"]);
	if (watch.sessions !== undefined) positiveInteger(watch.sessions, "watchPolicy.sessions");
	if (watch.durationMs !== undefined) positiveInteger(watch.durationMs, "watchPolicy.durationMs");
	stringArray(watch.automaticRollbackOn, "watchPolicy.automaticRollbackOn");
}

export function validatePromotionDecision(
	value: unknown,
	context?: { readonly candidate?: EmbodimentCandidateV1; readonly policy?: EvaluationPolicyV1 },
): asserts value is PromotionDecisionV1 {
	const decision = asRecord(value, "promotion decision");
	knownKeys(decision, [
		"schema",
		"decisionId",
		"ownerPrincipal",
		"agentId",
		"targetLayer",
		"candidateRef",
		"candidateDigest",
		"expectedIncumbentDigest",
		"evaluationPolicyRef",
		"evaluationSetDigest",
		"verdict",
		"decidedBy",
		"approvalAuthority",
		"decidedAt",
		"expiresAt",
		"reason",
	]);
	if (decision.schema !== PROMOTION_DECISION_SCHEMA) fault("promotion decision schema is unsupported");
	nonEmptyString(decision.decisionId, "decisionId");
	const owner = userPrincipal(decision.ownerPrincipal, "ownerPrincipal");
	const agentId = agentIdentity(decision.agentId, "agentId");
	oneOf(decision.targetLayer, ["harness", "extension", "embodiment"], "targetLayer");
	ownedRef(decision.candidateRef, "embodiment-candidate", owner, "candidateRef");
	assertDigestEquals(
		decision.candidateDigest,
		(decision.candidateRef as MeaningfulObjectRefV1).digest,
		"candidateDigest",
	);
	digestString(decision.expectedIncumbentDigest, "expectedIncumbentDigest");
	ownedRef(decision.evaluationPolicyRef, "evaluation-policy", owner, "evaluationPolicyRef");
	digestString(decision.evaluationSetDigest, "evaluationSetDigest");
	oneOf(decision.verdict, ["approved", "rejected"], "verdict");
	const decidedBy = nonEmptyString(decision.decidedBy, "decidedBy");
	if (decidedBy === agentId) fault("an Agent cannot be its own sole promotion approver");
	oneOf(decision.approvalAuthority, ["owner", "steward"], "approvalAuthority");
	const decidedAt = epoch(decision.decidedAt, "decidedAt");
	const expiresAt = epoch(decision.expiresAt, "expiresAt");
	if (expiresAt <= decidedAt) fault("promotion decision expiresAt must be after decidedAt");
	if (decision.reason !== undefined) nonEmptyString(decision.reason, "reason");
	if (context?.candidate) {
		validateEmbodimentCandidate(context.candidate);
		if (context.candidate.ownerPrincipal !== owner || context.candidate.agentId !== agentId) {
			fault("promotion decision owner or Agent differs from candidate");
		}
		if (
			decision.targetLayer !== context.candidate.targetLayer ||
			decision.expectedIncumbentDigest !== context.candidate.expectedIncumbentDigest ||
			decision.evaluationSetDigest !== context.candidate.evaluationSetDigest ||
			!sameMeaningfulObjectRef(
				decision.evaluationPolicyRef as MeaningfulObjectRefV1,
				context.candidate.evaluationPolicyRef,
			)
		) {
			fault("promotion decision is not bound to the exact candidate evidence");
		}
	}
	if (context?.policy) {
		validateEvaluationPolicy(context.policy);
		if (context.policy.ownerPrincipal !== owner || context.policy.evolutionClass !== decision.targetLayer) {
			fault("promotion decision policy does not apply to this owner and layer");
		}
		if (context.policy.approverPolicy === "two-party" && decision.approvalAuthority !== "steward") {
			fault("two-party policy requires steward approval");
		}
	}
}

export function validateEmbodimentActivation(value: unknown): asserts value is EmbodimentActivationV1 {
	const activation = asRecord(value, "Embodiment activation");
	knownKeys(activation, [
		"schema",
		"activationId",
		"ownerPrincipal",
		"agentId",
		"expectedIncumbentRef",
		"expectedIncumbentDigest",
		"nextEmbodimentRef",
		"nextEmbodimentDigest",
		"candidateRef",
		"promotionDecisionRef",
		"mode",
		"rollbackTargetRef",
		"committedBy",
		"committedAt",
		"transactionRevision",
	]);
	if (activation.schema !== EMBODIMENT_ACTIVATION_SCHEMA) fault("Embodiment activation schema is unsupported");
	nonEmptyString(activation.activationId, "activationId");
	const owner = userPrincipal(activation.ownerPrincipal, "ownerPrincipal");
	agentIdentity(activation.agentId, "agentId");
	ownedRef(activation.expectedIncumbentRef, "embodiment", owner, "expectedIncumbentRef");
	assertDigestEquals(
		activation.expectedIncumbentDigest,
		(activation.expectedIncumbentRef as MeaningfulObjectRefV1).digest,
		"expectedIncumbentDigest",
	);
	ownedRef(activation.nextEmbodimentRef, "embodiment", owner, "nextEmbodimentRef");
	assertDigestEquals(
		activation.nextEmbodimentDigest,
		(activation.nextEmbodimentRef as MeaningfulObjectRefV1).digest,
		"nextEmbodimentDigest",
	);
	if (activation.nextEmbodimentDigest === activation.expectedIncumbentDigest) {
		fault("activation must create a new Embodiment generation");
	}
	ownedRef(activation.candidateRef, "embodiment-candidate", owner, "candidateRef");
	ownedRef(activation.promotionDecisionRef, "promotion-decision", owner, "promotionDecisionRef");
	oneOf(activation.mode, ["future-sessions", "canary-session", "safe-point-resume"], "mode");
	ownedRef(activation.rollbackTargetRef, "embodiment", owner, "rollbackTargetRef");
	if (
		!sameMeaningfulObjectRef(
			activation.rollbackTargetRef as MeaningfulObjectRefV1,
			activation.expectedIncumbentRef as MeaningfulObjectRefV1,
		)
	) {
		fault("first-generation activation rollback target must be the exact incumbent");
	}
	nonEmptyString(activation.committedBy, "committedBy");
	epoch(activation.committedAt, "committedAt");
	positiveInteger(activation.transactionRevision, "transactionRevision");
}

export function validateRollbackDecision(value: unknown): asserts value is RollbackDecisionV1 {
	const decision = asRecord(value, "rollback decision");
	knownKeys(decision, [
		"schema",
		"decisionId",
		"ownerPrincipal",
		"agentId",
		"activationRef",
		"fromEmbodimentRef",
		"fromEmbodimentDigest",
		"toEmbodimentRef",
		"toEmbodimentDigest",
		"evidenceRefs",
		"decidedBy",
		"automatic",
		"reason",
		"decidedAt",
		"transactionRevision",
	]);
	if (decision.schema !== ROLLBACK_DECISION_SCHEMA) fault("rollback decision schema is unsupported");
	nonEmptyString(decision.decisionId, "decisionId");
	const owner = userPrincipal(decision.ownerPrincipal, "ownerPrincipal");
	agentIdentity(decision.agentId, "agentId");
	ownedRef(decision.activationRef, "embodiment-activation", owner, "activationRef");
	ownedRef(decision.fromEmbodimentRef, "embodiment", owner, "fromEmbodimentRef");
	assertDigestEquals(
		decision.fromEmbodimentDigest,
		(decision.fromEmbodimentRef as MeaningfulObjectRefV1).digest,
		"fromEmbodimentDigest",
	);
	ownedRef(decision.toEmbodimentRef, "embodiment", owner, "toEmbodimentRef");
	assertDigestEquals(
		decision.toEmbodimentDigest,
		(decision.toEmbodimentRef as MeaningfulObjectRefV1).digest,
		"toEmbodimentDigest",
	);
	if (decision.toEmbodimentDigest === decision.fromEmbodimentDigest) fault("rollback target must differ from current");
	ownedRefArray(decision.evidenceRefs, undefined, owner, "evidenceRefs", false);
	nonEmptyString(decision.decidedBy, "decidedBy");
	boolean(decision.automatic, "automatic");
	nonEmptyString(decision.reason, "reason");
	epoch(decision.decidedAt, "decidedAt");
	positiveInteger(decision.transactionRevision, "transactionRevision");
}

export function validateEvolutionDocument(
	kind: EvolutionObjectKind,
	value: unknown,
): asserts value is EvolutionDocumentV1 {
	switch (kind) {
		case "embodiment":
			return validateAgentEmbodiment(value);
		case "evolution-proposal":
			return validateEvolutionProposal(value);
		case "embodiment-candidate":
			return validateEmbodimentCandidate(value);
		case "evaluation-policy":
			return validateEvaluationPolicy(value);
		case "promotion-decision":
			return validatePromotionDecision(value);
		case "embodiment-activation":
			return validateEmbodimentActivation(value);
		case "rollback-decision":
			return validateRollbackDecision(value);
	}
}

export function digestEvolutionDocument(kind: EvolutionObjectKind, value: EvolutionDocumentV1): string {
	validateEvolutionDocument(kind, value);
	return digest(value);
}

function assertOntologyOwner(binding: AgentOntologyBindingV1, owner: string): void {
	const refs: MeaningfulObjectRefV1[] = [
		binding.objects.agent,
		binding.objects.geist,
		binding.objects.prompt,
		...binding.objects.skills,
		binding.objects.harness,
		binding.objects.toolManifest,
		binding.objects.toolGrant,
		binding.objects.runtimeProfile,
	];
	for (const item of refs) assertRefOwner(item, owner, `ontology ${item.kind}`);
}

function ownedRef(
	value: unknown,
	kind: MeaningfulObjectKind | undefined,
	owner: string,
	label: string,
): MeaningfulObjectRefV1 {
	ref(value, kind, label);
	assertRefOwner(value as MeaningfulObjectRefV1, owner, label);
	return value as MeaningfulObjectRefV1;
}

function optionalOwnedRef(value: unknown, kind: MeaningfulObjectKind | undefined, owner: string, label: string): void {
	if (value !== undefined) ownedRef(value, kind, owner, label);
}

function ownedRefArray(
	value: unknown,
	kind: MeaningfulObjectKind | undefined,
	owner: string,
	label: string,
	nonEmpty: boolean,
): readonly MeaningfulObjectRefV1[] {
	if (!Array.isArray(value) || (nonEmpty && value.length === 0))
		fault(`${label} must be ${nonEmpty ? "a non-empty" : "an"} array`);
	const refs = value as unknown[];
	const keys = new Set<string>();
	for (const item of refs) {
		const valid = ownedRef(item, kind, owner, `${label} item`);
		const key = referenceKey(valid);
		if (keys.has(key)) fault(`${label} contains a duplicate ref`);
		keys.add(key);
	}
	return refs as MeaningfulObjectRefV1[];
}

function ref(value: unknown, kind: MeaningfulObjectKind | undefined, label: string): void {
	try {
		validateMeaningfulObjectRef(value, kind);
	} catch (error) {
		fault(`${label} is not a valid Meaningful Object ref`, {
			reason: error instanceof Error ? error.message : String(error),
		});
	}
}

function assertRefOwner(value: MeaningfulObjectRefV1, owner: string, label: string): void {
	if (value.ownerPrincipal !== owner) fault(`${label} owner differs from evolution owner`);
}

function referenceKey(value: MeaningfulObjectRefV1): string {
	return [value.kind, value.ownerPrincipal, value.graphId, value.objectId, value.version, value.digest].join("\u0000");
}

function assertDigestEquals(value: unknown, expected: string, label: string): void {
	digestString(value, label);
	if (value !== expected) fault(`${label} does not match host-recomputed content`, { expected, actual: value });
}

function digestString(value: unknown, label: string): string {
	const parsed = string(value, label);
	if (!/^sha256:[0-9a-f]{64}$/.test(parsed)) fault(`${label} must be a lowercase sha256 digest`);
	return parsed;
}

function userPrincipal(value: unknown, label: string): string {
	const principal = nonEmptyString(value, label);
	if (!/^user:[^\s:][^\s]*$/.test(principal)) fault(`${label} must be an exact user: principal`);
	return principal;
}

function agentIdentity(value: unknown, label: string): string {
	const agentId = string(value, label);
	if (!CANONICAL_AGENT_ID.test(agentId)) fault(`${label} must be a canonical Agent identity`);
	return agentId;
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) fault(`${label} must be an array`);
	return value.map((item, index) => nonEmptyString(item, `${label}[${index}]`));
}

function oneOf<const Value extends string>(value: unknown, allowed: readonly Value[], label: string): Value {
	const parsed = string(value, label);
	if (!(allowed as readonly string[]).includes(parsed)) fault(`${label} is unsupported`, { value });
	return parsed as Value;
}

function boolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") fault(`${label} must be boolean`);
	return value as boolean;
}

function number(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) fault(`${label} must be a finite number`);
	return value as number;
}

function integer(value: unknown, label: string): number {
	const parsed = number(value, label);
	if (!Number.isSafeInteger(parsed) || parsed < 0) fault(`${label} must be a non-negative safe integer`);
	return parsed;
}

function positiveInteger(value: unknown, label: string): number {
	const parsed = integer(value, label);
	if (parsed < 1) fault(`${label} must be positive`);
	return parsed;
}

function optionalNonNegativeInteger(value: unknown, label: string): void {
	if (value !== undefined) integer(value, label);
}

function epoch(value: unknown, label: string): number {
	return integer(value, label);
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string") fault(`${label} must be a string`);
	return value as string;
}

function nonEmptyString(value: unknown, label: string): string {
	const parsed = string(value, label);
	if (parsed.trim().length === 0) fault(`${label} is required`);
	return parsed;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fault(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
	const keys = new Set(allowed);
	const unknown = Object.keys(value).filter((key) => !keys.has(key));
	if (unknown.length > 0) fault("object contains unknown fields", { unknown });
}

function digest(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	fault("canonical JSON cannot contain undefined, bigint, symbol, or function values");
}

function fault(message: string, details?: unknown): never {
	throw new AgentEvolutionFault(message, details);
}
