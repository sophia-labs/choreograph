import { createHash } from "node:crypto";
import {
	AGENT_EMBODIMENT_SCHEMA,
	AGENT_RUNTIME_BINDING_V2_SCHEMA,
	type AgentEmbodimentV1,
	computeEvaluationSetDigest,
	digestAgentRuntimeBindingV2,
	EMBODIMENT_CANDIDATE_SCHEMA,
	type EmbodimentCandidateV1,
	EVOLUTION_PROPOSAL_SCHEMA,
	type EvaluationPolicyV1,
	type EvolutionProposalV1,
} from "../agent-runtime/evolution.js";
import type { AgentEvolutionStore } from "../agent-runtime/evolution-store.js";
import type { ExtensionBuildResultV1, PrimeExtensionBuilder } from "../agent-runtime/extension-builder.js";
import type {
	ExtensionEvaluationCoordinator,
	ExtensionEvaluationSuiteV1,
	ExtensionVerificationRunV1,
} from "../agent-runtime/extension-evaluation.js";
import {
	type MeaningfulObjectRefV1,
	sameMeaningfulObjectRef,
	validateMeaningfulObjectRef,
} from "../agent-runtime/meaningful-object.js";
import { digestAgentOntologyBinding } from "../agent-runtime/ontology-binding.js";
import type { CapabilityBackend, HostedMcpToolDescriptor } from "../mnemosyne.js";
import type { GitWorktreeProvider } from "../workspace/git-workspace-provider.js";
import type { MaterializedWorkspaceV1, PatchAttestationV1 } from "../workspace/provider.js";

const TOOLS = [
	{
		name: "status",
		description: "Inspect the active Agent Embodiment and this session's candidate-evolution state.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "propose",
		description: "Publish an immutable evidence-backed evolution proposal against the active embodiment.",
		inputSchema: {
			type: "object",
			properties: {
				problem_statement: { type: "string", minLength: 1 },
				rationale: { type: "string", minLength: 1 },
				desired_outcome: { type: "string", minLength: 1 },
				target_layer: { enum: ["harness", "extension", "embodiment", "constitutional-core"] },
				evidence_refs: { type: "array", items: { type: "object" } },
				non_goals: { type: "array", items: { type: "string" } },
			},
			required: ["problem_statement", "rationale", "desired_outcome", "target_layer"],
			additionalProperties: false,
		},
	},
	{
		name: "open_workspace",
		description: "Create a host-owned, generation-fenced candidate workspace for an exact proposal.",
		inputSchema: {
			type: "object",
			properties: { proposal_ref: { type: "object" } },
			required: ["proposal_ref"],
			additionalProperties: false,
		},
	},
	{
		name: "checkpoint",
		description: "Checkpoint and attest the exact patch currently mounted at /candidate.",
		inputSchema: {
			type: "object",
			properties: { summary: { type: "string", minLength: 1 } },
			required: ["summary"],
			additionalProperties: false,
		},
	},
	{
		name: "build_candidate",
		description: "Build a content-addressed extension and draft Agent Embodiment candidate from an exact checkpoint.",
		inputSchema: {
			type: "object",
			properties: { checkpoint_ref: { type: "object" } },
			required: ["checkpoint_ref"],
			additionalProperties: false,
		},
	},
	{
		name: "evaluate_candidate",
		description: "Run the independent host evaluation policy and finalize a candidate with immutable testimony refs.",
		inputSchema: {
			type: "object",
			properties: { candidate_ref: { type: "object" } },
			required: ["candidate_ref"],
			additionalProperties: false,
		},
	},
	{
		name: "submit_candidate",
		description: "Submit an evaluated candidate for owner review without promoting or activating it.",
		inputSchema: {
			type: "object",
			properties: { candidate_ref: { type: "object" }, reason: { type: "string", minLength: 1 } },
			required: ["candidate_ref", "reason"],
			additionalProperties: false,
		},
	},
	{
		name: "abandon_candidate",
		description: "Release this session's candidate workspace without changing the active embodiment.",
		inputSchema: {
			type: "object",
			properties: { candidate_ref: { type: "object" }, reason: { type: "string", minLength: 1 } },
			required: ["candidate_ref", "reason"],
			additionalProperties: false,
		},
	},
] as const satisfies readonly HostedMcpToolDescriptor[];

export interface AgentEvolutionServiceOptions {
	readonly store: AgentEvolutionStore;
	readonly workspaceProvider: GitWorktreeProvider;
	readonly builder: PrimeExtensionBuilder;
	readonly evaluator: ExtensionEvaluationCoordinator;
	readonly ownerPrincipal: string;
	readonly agentId: string;
	readonly sessionId: string;
	readonly graphId: string;
	readonly repository: {
		readonly repositoryId: string;
		readonly repositoryPath: string;
		readonly baseRevision: string;
		readonly allowedPaths: readonly string[];
		readonly maximumWorkspaceBytes: number;
		readonly extensionRoot: string;
	};
	readonly sourceCompositionRef: MeaningfulObjectRefV1<"source-composition">;
	readonly evaluationPolicy: EvaluationPolicyV1;
	readonly evaluationPolicyRef: MeaningfulObjectRefV1<"evaluation-policy">;
	readonly evaluationSuites: readonly {
		readonly suite: ExtensionEvaluationSuiteV1;
		readonly suiteRef: MeaningfulObjectRefV1<"evaluation-suite">;
	}[];
	readonly allowedExtensionCapabilities: ReadonlySet<string>;
	readonly candidateWorkspace?: MaterializedWorkspaceV1;
	readonly now?: () => number;
}

interface BuiltCandidateState {
	readonly draft: EmbodimentCandidateV1;
	readonly draftRef: MeaningfulObjectRefV1<"embodiment-candidate">;
	readonly nextEmbodiment: AgentEmbodimentV1;
	readonly nextEmbodimentRef: MeaningfulObjectRefV1<"embodiment">;
	readonly build: ExtensionBuildResultV1;
	readonly attestation: PatchAttestationV1;
	final?: {
		readonly candidate: EmbodimentCandidateV1;
		readonly candidateRef: MeaningfulObjectRefV1<"embodiment-candidate">;
		readonly runs: readonly { ref: MeaningfulObjectRefV1<"verification-run">; run: ExtensionVerificationRunV1 }[];
		readonly state: "eligible" | "ineligible";
	};
}

/** One owner/Agent/session-bound source-evolution workflow. */
export class AgentEvolutionService {
	private workspace?: MaterializedWorkspaceV1;
	private proposal?: { document: EvolutionProposalV1; ref: MeaningfulObjectRefV1<"evolution-proposal"> };
	private checkpoint?: Awaited<ReturnType<GitWorktreeProvider["checkpoint"]>>;
	private attestation?: PatchAttestationV1;
	private built?: BuiltCandidateState;
	private readonly now: () => number;
	private workspaceMounted: boolean;

	constructor(readonly options: AgentEvolutionServiceOptions) {
		if (!/^user:[^\s]+$/.test(options.ownerPrincipal) || !options.agentId.trim() || !options.sessionId.trim()) {
			throw new Error("evolution service requires an exact user, Agent, and session binding");
		}
		if (
			options.sourceCompositionRef.ownerPrincipal !== options.ownerPrincipal ||
			options.evaluationPolicyRef.ownerPrincipal !== options.ownerPrincipal
		) {
			throw new Error("evolution service refs must have the exact owner");
		}
		this.workspace = options.candidateWorkspace;
		this.workspaceMounted = options.candidateWorkspace !== undefined;
		this.now = options.now ?? (() => Date.now());
	}

	get candidateWorkspaceMounted(): boolean {
		return this.workspaceMounted;
	}

	candidateWorkspaceForRebinding(): MaterializedWorkspaceV1 | undefined {
		return this.workspace;
	}

	markCandidateWorkspaceMounted(): void {
		if (!this.workspace) throw new Error("candidate workspace has not been opened");
		this.workspaceMounted = true;
	}

	async status(args: Record<string, unknown>): Promise<Record<string, unknown>> {
		await this.assertAuthority(args);
		const head = await this.requiredHead();
		return {
			active_embodiment_ref: head.embodimentRef,
			revision: head.revision,
			proposal_ref: this.proposal?.ref ?? null,
			workspace: this.workspace ? publicWorkspace(this.workspace, this.workspaceMounted) : null,
			checkpoint_ref: this.checkpoint?.checkpointRef ?? null,
			draft_candidate_ref: this.built?.draftRef ?? null,
			final_candidate_ref: this.built?.final?.candidateRef ?? null,
			evaluation_state: this.built?.final?.state ?? null,
			owner_action_required: this.built?.final?.state === "eligible",
		};
	}

	async propose(args: Record<string, unknown>): Promise<Record<string, unknown>> {
		const head = await this.assertAuthority(args);
		for (const { suite, suiteRef } of this.options.evaluationSuites) {
			await this.options.store.publishEvidenceObject({
				ref: suiteRef,
				agentId: this.options.agentId,
				document: suite,
				createdAt: suite.createdAt,
			});
		}
		const policyRef = await this.options.store.publishEvolutionObject({
			kind: "evaluation-policy",
			graphId: this.options.graphId,
			version: this.options.evaluationPolicy.policyVersion,
			document: this.options.evaluationPolicy,
			createdAt: this.now(),
		});
		if (!sameMeaningfulObjectRef(policyRef, this.options.evaluationPolicyRef)) {
			throw new Error("configured evaluation policy ref does not bind its exact policy document");
		}
		const targetLayer = enumValue(args.target_layer, [
			"harness",
			"extension",
			"embodiment",
			"constitutional-core",
		] as const);
		const now = this.now();
		const proposal: EvolutionProposalV1 = {
			schema: EVOLUTION_PROPOSAL_SCHEMA,
			proposalId: `proposal-${stableDigest(`${this.options.sessionId}\0${String(now)}\0${text(args.problem_statement, "problem_statement")}`).slice(0, 32)}`,
			ownerPrincipal: this.options.ownerPrincipal,
			agentId: this.options.agentId,
			scope: { kind: "agent", agentId: this.options.agentId },
			proposedBy: this.options.agentId,
			targetLayer,
			expectedEmbodimentRef: head.embodimentRef,
			expectedEmbodimentDigest: head.embodimentRef.digest,
			problemStatement: text(args.problem_statement, "problem_statement"),
			rationale: text(args.rationale, "rationale"),
			evidenceRefs: refArray(args.evidence_refs, this.options.ownerPrincipal),
			desiredOutcome: text(args.desired_outcome, "desired_outcome"),
			nonGoals: stringArray(args.non_goals, "non_goals"),
			requestedSourceComposition: this.options.sourceCompositionRef,
			requestedEvaluationPolicy: this.options.evaluationPolicyRef,
			requestedAt: now,
		};
		const proposalRef = await this.options.store.publishEvolutionObject({
			kind: "evolution-proposal",
			graphId: this.options.graphId,
			version: "1",
			document: proposal,
			createdAt: now,
		});
		this.proposal = { document: proposal, ref: proposalRef };
		return { proposal_ref: proposalRef, expected_embodiment_digest: head.embodimentRef.digest };
	}

	async openWorkspace(args: Record<string, unknown>): Promise<MaterializedWorkspaceV1> {
		await this.assertAuthority(args);
		const proposalRef = ref(args.proposal_ref, "evolution-proposal", this.options.ownerPrincipal);
		const proposal = await this.options.store.getEvolutionObject(proposalRef);
		if (!proposal || proposal.document.schema !== EVOLUTION_PROPOSAL_SCHEMA) {
			throw new Error("evolution proposal is not stored");
		}
		if (proposal.document.agentId !== this.options.agentId || proposal.document.targetLayer !== "extension") {
			throw new Error("the v1 candidate workspace supports exact Agent extension proposals only");
		}
		this.proposal = { document: proposal.document, ref: proposalRef };
		if (this.workspace) {
			if (!sameMeaningfulObjectRef(this.workspace.workspace.proposalRef, proposalRef)) {
				throw new Error("this session is already bound to a different candidate workspace");
			}
			const priorLease = this.workspace.lease;
			this.workspace = await this.options.workspaceProvider.materialize(
				{
					ownerPrincipal: this.options.ownerPrincipal,
					agentId: this.options.agentId,
					graphId: this.options.graphId,
					repositoryId: this.options.repository.repositoryId,
					repositoryPath: this.options.repository.repositoryPath,
					baseRevision: this.options.repository.baseRevision,
					allowedPaths: this.options.repository.allowedPaths,
					maxBytes: this.options.repository.maximumWorkspaceBytes,
					proposalRef,
				},
				this.now(),
			);
			if (
				this.workspace.lease.generation !== priorLease.generation ||
				this.workspace.lease.token !== priorLease.token
			) {
				this.workspaceMounted = false;
			}
			await this.persistWorkspaceEvidence(this.workspace);
			return this.workspace;
		}
		this.workspace = await this.options.workspaceProvider.materialize(
			{
				ownerPrincipal: this.options.ownerPrincipal,
				agentId: this.options.agentId,
				graphId: this.options.graphId,
				repositoryId: this.options.repository.repositoryId,
				repositoryPath: this.options.repository.repositoryPath,
				baseRevision: this.options.repository.baseRevision,
				allowedPaths: this.options.repository.allowedPaths,
				maxBytes: this.options.repository.maximumWorkspaceBytes,
				proposalRef,
			},
			this.now(),
		);
		this.workspaceMounted = false;
		await this.persistWorkspaceEvidence(this.workspace);
		return this.workspace;
	}

	async checkpointWorkspace(args: Record<string, unknown>): Promise<Record<string, unknown>> {
		await this.assertAuthority(args);
		const workspace = this.requiredWorkspace(args);
		text(args.summary, "summary");
		this.checkpoint = await this.options.workspaceProvider.checkpoint(workspace.lease, this.now());
		this.attestation = await this.options.workspaceProvider.attestPatch(workspace.lease, this.now());
		const evidenceCreatedAt = this.now();
		await this.options.store.publishEvidenceObject({
			ref: this.checkpoint.checkpointRef,
			agentId: this.options.agentId,
			document: this.checkpoint.checkpoint,
			createdAt: evidenceCreatedAt,
		});
		for (const item of [
			{ ref: this.attestation.patchSetRef, document: this.attestation.patchSet },
			{ ref: this.attestation.changeSetRef, document: this.attestation.changeSet },
		] as const) {
			await this.options.store.publishEvidenceObject({
				...item,
				agentId: this.options.agentId,
				createdAt: evidenceCreatedAt,
			});
		}
		const patchDescriptor = {
			mediaType: "text/x-diff",
			digest: this.attestation.patchSet.patchDigest,
			byteLength: this.attestation.patchSet.patchBytes,
		};
		await this.options.store.publishEvidenceObject({
			ref: this.attestation.patchArtifactRef,
			agentId: this.options.agentId,
			document: patchDescriptor,
			createdAt: evidenceCreatedAt,
		});
		await this.options.store.putEvidenceBlob({
			ref: this.attestation.patchArtifactRef,
			mediaType: patchDescriptor.mediaType,
			contentDigest: patchDescriptor.digest,
			body: await this.options.workspaceProvider.readPatchArtifact(
				this.attestation.patchArtifactRef,
				workspace.lease,
				evidenceCreatedAt,
			),
			createdAt: evidenceCreatedAt,
		});
		return {
			checkpoint_ref: this.checkpoint.checkpointRef,
			patch_set_ref: this.attestation.patchSetRef,
			change_set_ref: this.attestation.changeSetRef,
			changed_paths: this.attestation.patchSet.changedPaths,
			publication_digest: this.attestation.patchSet.publicationDigest,
		};
	}

	async buildCandidate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
		const head = await this.assertAuthority(args);
		const workspace = this.requiredWorkspace(args);
		const checkpointRef = ref(args.checkpoint_ref, "workspace-checkpoint", this.options.ownerPrincipal);
		if (
			!this.checkpoint ||
			!sameMeaningfulObjectRef(this.checkpoint.checkpointRef, checkpointRef) ||
			!this.attestation
		) {
			throw new Error("candidate build must use this session's exact checkpoint and patch attestation");
		}
		if (!this.proposal) throw new Error("candidate build has no bound evolution proposal");
		const incumbentObject = await this.options.store.getEvolutionObject(head.embodimentRef);
		if (!incumbentObject || incumbentObject.document.schema !== AGENT_EMBODIMENT_SCHEMA) {
			throw new Error("active Agent Embodiment document is missing");
		}
		const build = await this.options.builder.build({
			lease: workspace.lease,
			attestation: this.attestation,
			ownerPrincipal: this.options.ownerPrincipal,
			agentId: this.options.agentId,
			graphId: this.options.graphId,
			allowedCapabilities: this.options.allowedExtensionCapabilities,
			extensionRoot: this.options.repository.extensionRoot,
			now: this.now(),
		});
		for (const item of [
			{ ref: build.artifactRef, document: build.artifact },
			{ ref: build.buildReceiptRef, document: build.buildReceipt },
			{ ref: build.sbomRef, document: build.sbom },
		] as const) {
			await this.options.store.publishEvidenceObject({
				...item,
				agentId: this.options.agentId,
				createdAt: this.now(),
			});
		}
		for (let index = 0; index < build.skillRefs.length; index += 1) {
			const skillRef = build.skillRefs[index];
			const skill = build.manifest.skills[index];
			if (!skillRef || !skill) throw new Error("built skill testimony differs from its manifest");
			await this.options.store.publishEvidenceObject({
				ref: skillRef,
				agentId: this.options.agentId,
				document: { ...skill, extensionArtifactDigest: build.artifact.artifactDigest, abi: build.manifest.abi },
				createdAt: this.now(),
			});
		}
		const incumbent = incumbentObject.document;
		const runtimeBinding = {
			schema: AGENT_RUNTIME_BINDING_V2_SCHEMA,
			kind: incumbent.runtimeBinding.kind,
			baseBundle: incumbent.runtimeBinding.baseBundle,
			overlays: [
				...incumbent.runtimeBinding.overlays,
				{
					role: "user-extension" as const,
					ownerPrincipal: this.options.ownerPrincipal,
					artifact: build.artifactRef,
					manifestRef: requiredFirst(build.skillRefs, "built extension skill refs"),
					order: incumbent.runtimeBinding.overlays.length,
				},
			],
			profileRef: incumbent.runtimeBinding.profileRef,
			constraints: incumbent.runtimeBinding.constraints,
			extensionAbi: incumbent.runtimeBinding.extensionAbi,
		};
		const ontologyBinding = {
			...incumbent.ontologyBinding,
			objects: {
				...incumbent.ontologyBinding.objects,
				skills: [...incumbent.ontologyBinding.objects.skills, ...build.skillRefs],
			},
			resolvedAt: this.now(),
		};
		const candidateId = `candidate-${build.artifact.artifactDigest.slice("sha256:".length, "sha256:".length + 32)}`;
		const nextEmbodiment: AgentEmbodimentV1 = {
			schema: AGENT_EMBODIMENT_SCHEMA,
			embodimentId: `embodiment-${build.artifact.artifactDigest.slice("sha256:".length, "sha256:".length + 32)}`,
			ownerPrincipal: this.options.ownerPrincipal,
			agentId: this.options.agentId,
			runtimeBinding,
			runtimeBindingDigest: digestAgentRuntimeBindingV2(runtimeBinding),
			ontologyBinding,
			ontologyBindingDigest: digestAgentOntologyBinding(ontologyBinding),
			predecessorRef: head.embodimentRef,
			rollbackTargetRef: head.embodimentRef,
			createdAt: this.now(),
		};
		const nextEmbodimentRef = await this.options.store.publishEvolutionObject({
			kind: "embodiment",
			graphId: this.options.graphId,
			version: "1",
			document: nextEmbodiment,
			createdAt: nextEmbodiment.createdAt,
		});
		const draft = this.candidateDocument({
			candidateId,
			nextEmbodiment,
			nextEmbodimentRef,
			build,
			attestation: this.attestation,
			headRef: head.embodimentRef,
			verificationRunRefs: [],
			status: "candidate",
		});
		const draftRef = await this.options.store.publishEvolutionObject({
			kind: "embodiment-candidate",
			graphId: this.options.graphId,
			version: "1",
			document: draft,
			createdAt: draft.createdAt,
		});
		this.built = { draft, draftRef, nextEmbodiment, nextEmbodimentRef, build, attestation: this.attestation };
		return {
			candidate_ref: draftRef,
			embodiment_ref: nextEmbodimentRef,
			artifact_ref: build.artifactRef,
			build_receipt_ref: build.buildReceiptRef,
		};
	}

	async evaluateCandidate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
		await this.assertAuthority(args);
		const draftRef = ref(args.candidate_ref, "embodiment-candidate", this.options.ownerPrincipal);
		const built = this.built;
		if (!built || !sameMeaningfulObjectRef(built.draftRef, draftRef)) {
			throw new Error("evaluation must use this session's exact built candidate");
		}
		const runs: { ref: MeaningfulObjectRefV1<"verification-run">; run: ExtensionVerificationRunV1 }[] = [];
		for (const required of this.options.evaluationPolicy.requiredSuites) {
			const configured = this.options.evaluationSuites.find((item) =>
				sameMeaningfulObjectRef(item.suiteRef, required.suiteRef),
			);
			if (!configured) {
				if (required.required)
					throw new Error("required evaluation suite is unavailable to the independent evaluator");
				continue;
			}
			const result = await this.options.evaluator.evaluate({
				candidate: built.draft,
				build: built.build,
				policy: this.options.evaluationPolicy,
				policyRef: this.options.evaluationPolicyRef,
				suite: configured.suite,
				suiteRef: configured.suiteRef,
				graphId: this.options.graphId,
			});
			await this.options.store.publishEvidenceObject({
				ref: result.runRef,
				agentId: this.options.agentId,
				document: result.run,
				createdAt: result.run.completedAt,
			});
			runs.push({ ref: result.runRef, run: result.run });
		}
		const allPassed = runs.length > 0 && runs.every((item) => item.run.passed);
		const finalCandidate = this.candidateDocument({
			candidateId: built.draft.candidateId,
			nextEmbodiment: built.nextEmbodiment,
			nextEmbodimentRef: built.nextEmbodimentRef,
			build: built.build,
			attestation: built.attestation,
			headRef: built.draft.expectedIncumbent,
			verificationRunRefs: runs.map((item) => item.ref),
			status: allPassed ? "eligible" : "ineligible",
		});
		const finalRef = await this.options.store.publishEvolutionObject({
			kind: "embodiment-candidate",
			graphId: this.options.graphId,
			version: "2",
			document: finalCandidate,
			createdAt: finalCandidate.createdAt,
		});
		const evaluation = await this.options.store.recordCandidateEvaluation({
			candidateRef: finalRef,
			verificationRuns: runs,
			evaluatedBy: "service:choreograph-extension-evaluator",
			evaluatedAt: this.now(),
		});
		built.final = { candidate: finalCandidate, candidateRef: finalRef, runs, state: evaluation.state };
		return {
			candidate_ref: finalRef,
			draft_candidate_ref: built.draftRef,
			verification_run_refs: runs.map((item) => item.ref),
			evaluation_set_digest: evaluation.evaluationSetDigest,
			state: evaluation.state,
		};
	}

	async submitCandidate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
		await this.assertAuthority(args);
		const candidateRef = ref(args.candidate_ref, "embodiment-candidate", this.options.ownerPrincipal);
		text(args.reason, "reason");
		if (!this.built?.final || !sameMeaningfulObjectRef(this.built.final.candidateRef, candidateRef)) {
			throw new Error("only this session's independently evaluated candidate can be submitted");
		}
		if (this.workspace) await this.options.workspaceProvider.release(this.workspace.lease, this.now());
		this.workspace = undefined;
		this.workspaceMounted = false;
		return {
			submitted: true,
			candidate_ref: candidateRef,
			state: this.built.final.state,
			owner_action_required: this.built.final.state === "eligible",
			self_activation_permitted: false,
		};
	}

	async abandonCandidate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
		await this.assertAuthority(args);
		ref(args.candidate_ref, "embodiment-candidate", this.options.ownerPrincipal);
		const reason = text(args.reason, "reason");
		if (this.workspace) await this.options.workspaceProvider.release(this.workspace.lease, this.now());
		this.workspace = undefined;
		this.workspaceMounted = false;
		return { abandoned: true, reason, active_embodiment_unchanged: true };
	}

	async workspaceLeaseConfig(): Promise<
		NonNullable<import("../wire-protocol.js").AgentWorkerConfig["candidate_workspace"]>
	> {
		const workspace = this.workspace;
		if (!workspace) throw new Error("candidate workspace has not been opened");
		const hostPath = await this.options.workspaceProvider.resolveHostPath(workspace.lease, this.now());
		return {
			schema: "sophia.candidate-workspace-lease.v1",
			ownerPrincipal: workspace.lease.ownerPrincipal,
			agentId: workspace.lease.agentId,
			workspaceId: workspace.lease.workspaceId,
			hostPath,
			mountPath: "/candidate",
			generation: workspace.lease.generation,
			leaseToken: workspace.lease.token,
			expiresAt: workspace.lease.expiresAt,
		};
	}

	private candidateDocument(input: {
		candidateId: string;
		nextEmbodiment: AgentEmbodimentV1;
		nextEmbodimentRef: MeaningfulObjectRefV1<"embodiment">;
		build: ExtensionBuildResultV1;
		attestation: PatchAttestationV1;
		headRef: MeaningfulObjectRefV1<"embodiment">;
		verificationRunRefs: readonly MeaningfulObjectRefV1<"verification-run">[];
		status: "candidate" | "eligible" | "ineligible";
	}): EmbodimentCandidateV1 {
		if (!this.proposal) throw new Error("candidate has no proposal");
		const createdAt = this.now();
		return {
			schema: EMBODIMENT_CANDIDATE_SCHEMA,
			candidateId: input.candidateId,
			ownerPrincipal: this.options.ownerPrincipal,
			agentId: this.options.agentId,
			targetLayer: "extension",
			proposalRef: this.proposal.ref,
			embodimentRef: input.nextEmbodimentRef,
			expectedIncumbent: input.headRef,
			expectedIncumbentDigest: input.headRef.digest,
			sourceCompositionRef: this.options.sourceCompositionRef,
			changeSetRef: input.attestation.changeSetRef,
			patchSetRefs: [input.attestation.patchSetRef],
			buildReceiptRef: input.build.buildReceiptRef,
			artifactRefs: [input.build.artifactRef],
			runtimeBinding: input.nextEmbodiment.runtimeBinding,
			runtimeBindingDigest: input.nextEmbodiment.runtimeBindingDigest,
			ontologyBinding: input.nextEmbodiment.ontologyBinding,
			ontologyBindingDigest: input.nextEmbodiment.ontologyBindingDigest,
			evaluationPolicyRef: this.options.evaluationPolicyRef,
			verificationRunRefs: input.verificationRunRefs,
			evaluationSetDigest: computeEvaluationSetDigest(input.verificationRunRefs),
			stateCompatibility: {
				readableCheckpointVersions: ["sophia.prime-checkpoint.v1"],
				writableCheckpointVersion: "sophia.prime-checkpoint.v1",
				reversible: true,
				coldStartAllowed: true,
			},
			createdAt,
			expiresAt: createdAt + 24 * 60 * 60 * 1_000,
			status: input.status,
		};
	}

	private async persistWorkspaceEvidence(workspace: MaterializedWorkspaceV1): Promise<void> {
		for (const item of [
			{ ref: workspace.sourceSnapshotRef, document: workspace.sourceSnapshot },
			{ ref: workspace.workspaceRef, document: workspace.workspace },
		] as const) {
			await this.options.store.publishEvidenceObject({
				...item,
				agentId: this.options.agentId,
				createdAt: this.now(),
			});
		}
	}

	private requiredWorkspace(args: Record<string, unknown>): MaterializedWorkspaceV1 {
		const workspace = this.workspace;
		if (!workspace) throw new Error("candidate workspace is not bound to this session");
		if (
			args.workspace_id !== workspace.lease.workspaceId ||
			args.lease_token !== workspace.lease.token ||
			args.generation !== workspace.lease.generation
		) {
			throw new Error("candidate workspace authority or generation fence differs");
		}
		return workspace;
	}

	private async assertAuthority(args: Record<string, unknown>) {
		if (
			args.owner_principal !== this.options.ownerPrincipal ||
			args.agent_id !== this.options.agentId ||
			args.session_id !== this.options.sessionId
		) {
			throw new Error("evolution call crossed its owner, Agent, or session boundary");
		}
		const expectedRef = ref(args.embodiment_ref, "embodiment", this.options.ownerPrincipal);
		if (args.expected_embodiment_digest !== expectedRef.digest) {
			throw new Error("evolution call expected embodiment digest differs from its ref");
		}
		const head = await this.requiredHead();
		if (!sameMeaningfulObjectRef(head.embodimentRef, expectedRef)) {
			throw new Error("active Agent Embodiment changed; start a fresh evolution proposal");
		}
		return head;
	}

	private async requiredHead() {
		const head = await this.options.store.getActiveEmbodiment(this.options.ownerPrincipal, this.options.agentId);
		if (!head) throw new Error("Agent has no active Embodiment head");
		return head;
	}
}

export class AgentEvolutionCapabilityBackend implements CapabilityBackend {
	readonly capabilityName = "evolution";
	readonly accessLevel = "rw" as const;

	constructor(readonly service: AgentEvolutionService) {}

	async listTools(): Promise<readonly HostedMcpToolDescriptor[]> {
		return TOOLS;
	}

	async callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
		switch (tool) {
			case "status":
				return this.service.status(args);
			case "propose":
				return this.service.propose(args);
			case "open_workspace":
				return publicWorkspace(await this.service.openWorkspace(args), this.service.candidateWorkspaceMounted);
			case "checkpoint":
				return this.service.checkpointWorkspace(args);
			case "build_candidate":
				return this.service.buildCandidate(args);
			case "evaluate_candidate":
				return this.service.evaluateCandidate(args);
			case "submit_candidate":
				return this.service.submitCandidate(args);
			case "abandon_candidate":
				return this.service.abandonCandidate(args);
			default:
				throw new Error(`evolution: unknown tool ${JSON.stringify(tool)}`);
		}
	}

	async close(): Promise<void> {}
}

function publicWorkspace(workspace: MaterializedWorkspaceV1, mounted: boolean): Record<string, unknown> {
	return {
		workspace_ref: workspace.workspaceRef,
		workspace_id: workspace.workspace.workspaceId,
		mount_path: "/candidate",
		generation: workspace.lease.generation,
		lease_token: workspace.lease.token,
		expires_at: workspace.lease.expiresAt,
		requires_rematerialization: !mounted,
	};
}

function ref<Kind extends MeaningfulObjectRefV1["kind"]>(
	value: unknown,
	kind: Kind,
	ownerPrincipal: string,
): MeaningfulObjectRefV1<Kind> {
	validateMeaningfulObjectRef(value, kind);
	const parsed = value as MeaningfulObjectRefV1<Kind>;
	if (parsed.ownerPrincipal !== ownerPrincipal) throw new Error(`${kind} ref has a different owner`);
	return parsed;
}

function refArray(value: unknown, ownerPrincipal: string): readonly MeaningfulObjectRefV1[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("evidence_refs must be an array");
	if (value.length > 64) throw new Error("evidence_refs exceeds 64 items");
	return value.map((item) => {
		validateMeaningfulObjectRef(item);
		const parsed = item as MeaningfulObjectRefV1;
		if (parsed.ownerPrincipal !== ownerPrincipal) throw new Error("evidence ref has a different owner");
		return parsed;
	});
}

function stringArray(value: unknown, label: string): readonly string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new Error(`${label} must be a string array`);
	}
	if (value.length > 64 || value.some((item) => item.length > 2_048)) {
		throw new Error(`${label} exceeds its bounded item or string limit`);
	}
	return value;
}

function text(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
	if (value.length > 16_384) throw new Error(`${label} exceeds 16384 characters`);
	return value;
}

function enumValue<const Values extends readonly string[]>(value: unknown, allowed: Values): Values[number] {
	if (typeof value !== "string" || !allowed.includes(value)) throw new Error("evolution target layer is unsupported");
	return value as Values[number];
}

function stableDigest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function requiredFirst<Value>(values: readonly Value[], label: string): Value {
	const value = values[0];
	if (value === undefined) throw new Error(`${label} is empty`);
	return value;
}
