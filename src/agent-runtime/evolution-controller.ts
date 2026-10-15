import { createHash } from "node:crypto";
import type { CapabilityBindingContext } from "../capabilities/catalog.js";
import { AgentEvolutionCapabilityBackend, AgentEvolutionService } from "../capabilities/evolution.js";
import type { AgentWorkerConfig } from "../wire-protocol.js";
import { HARNESS_MATERIALIZATION_SCHEMA } from "../wire-protocol.js";
import type { GitWorktreeProvider } from "../workspace/git-workspace-provider.js";
import {
	AGENT_EMBODIMENT_SCHEMA,
	AGENT_RUNTIME_BINDING_V2_SCHEMA,
	type AgentEmbodimentV1,
	computeEvaluationSetDigest,
	digestAgentEmbodiment,
	digestAgentRuntimeBindingV2,
	EMBODIMENT_CANDIDATE_SCHEMA,
	type EmbodimentActivationV1,
	type EmbodimentCandidateV1,
	EVOLUTION_PROPOSAL_SCHEMA,
	type EvaluationPolicyV1,
	type EvolutionProposalV1,
	PROMOTION_DECISION_SCHEMA,
	type PromotionDecisionV1,
} from "./evolution.js";
import { type EvolutionSparqlWriter, GardenEvolutionProjectionSink } from "./evolution-rdf.js";
import type { AgentEvolutionStore, EvolutionObjectRecord } from "./evolution-store.js";
import { PRIME_EXTENSION_ABI } from "./extension.js";
import type { PrimeExtensionBuilder } from "./extension-builder.js";
import {
	EXTENSION_EVALUATION_SUITE_SCHEMA,
	EXTENSION_VERIFICATION_RUN_SCHEMA,
	type ExtensionEvaluationCoordinator,
	type ExtensionEvaluationSuiteV1,
	type ExtensionVerificationRunV1,
} from "./extension-evaluation.js";
import { createMeaningfulObjectRef, type MeaningfulObjectRefV1, sameMeaningfulObjectRef } from "./meaningful-object.js";
import {
	type AgentOntologyBindingV1,
	digestAgentOntologyBinding,
	validateAgentOntologyBinding,
} from "./ontology-binding.js";
import { AGENT_RUNTIME_BINDING_SCHEMA, digestAgentRuntimeBinding } from "./profile.js";

export interface PersonalEvolutionRepositoryV1 {
	readonly repositoryId: string;
	readonly repositoryPath: string;
	readonly baseRevision: string;
	readonly allowedPaths: readonly string[];
	readonly maximumWorkspaceBytes: number;
	readonly extensionRoot: string;
}

export interface PersonalEvolutionEvaluationTemplateV1 {
	readonly skillName: string;
	readonly fixtures: ExtensionEvaluationSuiteV1["fixtures"];
	readonly timeoutMs?: number;
	readonly maximumOutputBytes?: number;
}

export interface PersonalEvolutionControllerOptions {
	readonly store: AgentEvolutionStore;
	readonly workspaceProvider: GitWorktreeProvider;
	readonly builder: PrimeExtensionBuilder;
	readonly evaluator: ExtensionEvaluationCoordinator;
	readonly repository: PersonalEvolutionRepositoryV1;
	readonly evaluation: PersonalEvolutionEvaluationTemplateV1;
	readonly allowedExtensionCapabilities?: ReadonlySet<string>;
	readonly now?: () => number;
}

export interface OwnerPromotionInput {
	readonly ownerPrincipal: string;
	readonly agentId: string;
	readonly candidateRef: MeaningfulObjectRefV1<"embodiment-candidate">;
	readonly verdict: "approved" | "rejected";
	readonly reason?: string;
	readonly idempotencyKey: string;
	readonly expiresInMs?: number;
}

/**
 * Trusted owner-plane coordinator for the first personal evolution slice.
 *
 * It performs three jobs that must never be delegated to Prime:
 *   1. bootstrap/resolve the active Embodiment for each new sandbox;
 *   2. mint an exact owner/session-bound authoring capability;
 *   3. commit owner promotion, canary, activation, and rollback decisions.
 */
export class PersonalEvolutionController {
	private readonly services = new Map<string, AgentEvolutionService>();
	private readonly now: () => number;

	constructor(readonly options: PersonalEvolutionControllerOptions) {
		this.now = options.now ?? (() => Date.now());
	}

	async resolveWorkerConfig(
		config: AgentWorkerConfig,
		input: { readonly ownerUserId: string; readonly graphId: string; readonly canaryActivationId?: string },
	): Promise<AgentWorkerConfig> {
		const ownerPrincipal = `user:${required(input.ownerUserId, "ownerUserId")}`;
		const agentId = required(config.agent_id ?? config.agent_ontology?.subject.agentId, "agentId");
		const ontology = config.agent_ontology;
		if (!ontology) throw new Error("personal evolution requires an Agent Ontology binding");
		validateAgentOntologyBinding(ontology);
		if (
			ontologyRefs(ontology).some((ref) => ref.ownerPrincipal !== ownerPrincipal || ref.graphId !== input.graphId)
		) {
			throw new Error("active Embodiment ontology differs from the authenticated owner or graph");
		}
		await this.ensureInitialEmbodiment(config, ownerPrincipal, agentId, input.graphId);
		const head = await this.options.store.resolveEmbodiment({
			ownerPrincipal,
			agentId,
			...(input.canaryActivationId ? { canaryActivationId: input.canaryActivationId } : {}),
		});
		if (!head) throw new Error("Agent has no active Embodiment");
		const record = await this.options.store.getEvolutionObject(head.embodimentRef);
		if (!record || record.document.schema !== AGENT_EMBODIMENT_SCHEMA) {
			throw new Error("active Agent Embodiment object is absent");
		}
		const embodiment = record.document;
		if (embodiment.ownerPrincipal !== ownerPrincipal || embodiment.agentId !== agentId) {
			throw new Error("resolved Agent Embodiment crossed its owner or Agent boundary");
		}
		const sessionId = required(config.session_id, "sessionId");
		const service =
			this.services.get(serviceKey(ownerPrincipal, agentId, sessionId)) ??
			this.findReusableService(ownerPrincipal, agentId);
		let candidateWorkspace: AgentWorkerConfig["candidate_workspace"];
		if (service) {
			try {
				candidateWorkspace = await service.workspaceLeaseConfig();
				service.markCandidateWorkspaceMounted();
			} catch (error) {
				if (!/has not been opened/.test(error instanceof Error ? error.message : String(error))) throw error;
			}
		}
		const harnessEvidence = await this.options.store.getEvidenceObject(embodiment.ontologyBinding.objects.harness);
		let harnessMaterialization: AgentWorkerConfig["harness_materialization"];
		if (harnessEvidence) {
			if (
				harnessEvidence.agentId !== agentId ||
				!isRecord(harnessEvidence.document) ||
				harnessEvidence.document.schema !== 1
			) {
				throw new Error("active harness Meaningful Object has invalid owner, Agent, or schema testimony");
			}
			harnessMaterialization = {
				schema: HARNESS_MATERIALIZATION_SCHEMA,
				harnessRef: embodiment.ontologyBinding.objects.harness,
				snapshot: harnessEvidence.document as Readonly<Record<string, unknown>> & { readonly schema: 1 },
			};
		}
		return {
			...config,
			agent_ontology: embodiment.ontologyBinding,
			agent_ontology_binding_digest: embodiment.ontologyBindingDigest,
			embodiment_ref: head.embodimentRef,
			embodiment_binding: embodiment,
			embodiment_binding_digest: digestAgentEmbodiment(embodiment),
			...(candidateWorkspace ? { candidate_workspace: candidateWorkspace } : {}),
			...(harnessMaterialization ? { harness_materialization: harnessMaterialization } : {}),
		};
	}

	async bindCapability(context: CapabilityBindingContext): Promise<AgentEvolutionCapabilityBackend> {
		if (!context.agentSession) throw new Error("evolution requires an Agent Session binding");
		const ownerPrincipal = context.graphOwner ?? `user:${context.ownerUserId}`;
		if (ownerPrincipal !== `user:${context.ownerUserId}`) {
			throw new Error("personal evolution is restricted to the authenticated user's own graph");
		}
		const { agentId, sessionId } = context.agentSession;
		const head = await this.options.store.getActiveEmbodiment(ownerPrincipal, agentId);
		if (!head) throw new Error("evolution capability requires an initialized active Embodiment");
		const key = serviceKey(ownerPrincipal, agentId, sessionId);
		let service = this.services.get(key);
		if (!service) {
			const bindings = this.ownerBindings(ownerPrincipal, context.graphId);
			await this.options.store.publishEvidenceObject({
				ref: bindings.sourceCompositionRef,
				agentId,
				document: bindings.sourceCompositionDocument,
				createdAt: this.now(),
			});
			const candidateWorkspace = this.findReusableService(ownerPrincipal, agentId)?.candidateWorkspaceForRebinding();
			service = new AgentEvolutionService({
				store: this.options.store,
				workspaceProvider: this.options.workspaceProvider,
				builder: this.options.builder,
				evaluator: this.options.evaluator,
				ownerPrincipal,
				agentId,
				sessionId,
				graphId: context.graphId,
				repository: this.options.repository,
				sourceCompositionRef: bindings.sourceCompositionRef,
				evaluationPolicy: bindings.policy,
				evaluationPolicyRef: bindings.policyRef,
				evaluationSuites: [{ suite: bindings.suite, suiteRef: bindings.suiteRef }],
				allowedExtensionCapabilities: this.options.allowedExtensionCapabilities ?? new Set(),
				...(candidateWorkspace ? { candidateWorkspace } : {}),
				now: this.now,
			});
			this.services.set(key, service);
		}
		return new AgentEvolutionCapabilityBackend(service);
	}

	/**
	 * Converts Prime's local Layer-H refinement receipt into a graph-addressed,
	 * independently evaluated Embodiment candidate. This method deliberately
	 * stops before owner promotion: `/refine` can author, but cannot activate.
	 */
	async ingestHarnessRefinement(input: {
		readonly ownerUserId: string;
		readonly graphId: string;
		readonly agentId: string;
		readonly sessionId: string;
		readonly event: {
			readonly name: string;
			readonly payload: unknown;
			readonly session_id: string;
			readonly runtime_binding_digest: string;
			readonly agent_ontology_binding_digest: string;
			readonly embodiment_digest?: string;
		};
		readonly occurredAt: number;
	}): Promise<
		| {
				readonly candidateRef: MeaningfulObjectRefV1<"embodiment-candidate">;
				readonly embodimentRef: MeaningfulObjectRefV1<"embodiment">;
				readonly harnessRef: MeaningfulObjectRefV1<"harness">;
				readonly state: "eligible" | "ineligible";
		  }
		| undefined
	> {
		if (input.event.name !== "refine_complete") return undefined;
		const ownerPrincipal = `user:${required(input.ownerUserId, "ownerUserId")}`;
		const agentId = required(input.agentId, "agentId");
		const sessionId = required(input.sessionId, "sessionId");
		if (input.event.session_id !== sessionId) throw new Error("refinement event crossed its trusted session binding");
		if (!Number.isSafeInteger(input.occurredAt) || input.occurredAt < 0) {
			throw new Error("refinement event timestamp is invalid");
		}
		const parsed = parseHarnessRefinement(input.event.payload);
		const head = await this.options.store.getActiveEmbodiment(ownerPrincipal, agentId);
		if (!head) throw new Error("harness refinement requires an active Agent Embodiment");
		if (head.embodimentRef.graphId !== input.graphId) {
			throw new Error("harness refinement crossed its trusted graph binding");
		}
		const incumbentRecord = await this.options.store.getEvolutionObject(head.embodimentRef);
		if (!incumbentRecord || incumbentRecord.document.schema !== AGENT_EMBODIMENT_SCHEMA) {
			throw new Error("harness refinement incumbent Embodiment is absent");
		}
		const incumbent = incumbentRecord.document;
		const incumbentBaseRuntimeDigest = digestAgentRuntimeBinding({
			schema: AGENT_RUNTIME_BINDING_SCHEMA,
			kind: incumbent.runtimeBinding.kind,
			bundle: incumbent.runtimeBinding.baseBundle,
			profileRef: incumbent.runtimeBinding.profileRef,
			constraints: incumbent.runtimeBinding.constraints,
		});
		if (
			input.event.embodiment_digest !== head.embodimentRef.digest ||
			input.event.runtime_binding_digest !== incumbentBaseRuntimeDigest ||
			input.event.agent_ontology_binding_digest !== incumbent.ontologyBindingDigest
		) {
			throw new Error("harness refinement event is stale or differs from its active Embodiment");
		}
		const refinementKey = stableHash(`${ownerPrincipal}\0${agentId}\0${parsed.result.id}`).slice(0, 32);
		const candidateId = `candidate-harness-${refinementKey}`;
		const harnessRef = createMeaningfulObjectRef({
			kind: "harness",
			ownerPrincipal,
			graphId: input.graphId,
			objectId: incumbent.ontologyBinding.objects.harness.objectId,
			version: `refinement-${refinementKey}`,
			value: parsed.snapshot,
		});
		const existing = await this.options.store.getEvolutionObjectById({
			ownerPrincipal,
			kind: "embodiment-candidate",
			objectId: candidateId,
		});
		if (existing) {
			if (
				existing.document.schema !== EMBODIMENT_CANDIDATE_SCHEMA ||
				existing.document.agentId !== agentId ||
				!sameMeaningfulObjectRef(existing.document.ontologyBinding.objects.harness, harnessRef)
			) {
				throw new Error("refinement id was already used for different harness evidence");
			}
			return {
				candidateRef: existing.ref,
				embodimentRef: existing.document.embodimentRef,
				harnessRef,
				state: existing.document.status === "eligible" ? "eligible" : "ineligible",
			};
		}

		const now = input.occurredAt;
		const suiteDocument = {
			schema: "sophia.harness-evaluation-suite.v1",
			suiteId: `harness-integrity-${refinementKey}`,
			ownerPrincipal,
			checks: ["schema-v1", "content-addressed", "incumbent-bound", "applied-edit-testimony"],
			createdAt: now,
		};
		const suiteRef = createMeaningfulObjectRef({
			kind: "evaluation-suite",
			ownerPrincipal,
			graphId: input.graphId,
			objectId: suiteDocument.suiteId,
			version: "1",
			value: suiteDocument,
		});
		const policy: EvaluationPolicyV1 = {
			schema: "sophia.agent-evaluation-policy.v1",
			policyId: `personal-harness-${refinementKey}`,
			policyVersion: "1",
			ownerPrincipal,
			evolutionClass: "harness",
			requiredSuites: [{ suiteRef, required: true, maximumAgeMs: 60 * 60 * 1_000 }],
			thresholds: { requiredPassRate: 1, maximumNewSecurityFailures: 0 },
			approverPolicy: "owner",
			watchPolicy: {
				sessions: 3,
				automaticRollbackOn: ["host-protocol-violation", "harness-materialization-failure"],
			},
		};
		const policyRef = await this.options.store.publishEvolutionObject({
			kind: "evaluation-policy",
			graphId: input.graphId,
			version: policy.policyVersion,
			document: policy,
			createdAt: now,
		});
		const evidence = async (ref: MeaningfulObjectRefV1, document: unknown): Promise<void> => {
			await this.options.store.publishEvidenceObject({ ref, agentId, document, createdAt: now });
		};
		await evidence(suiteRef, suiteDocument);
		await evidence(harnessRef, parsed.snapshot);

		const sourceCompositionDocument = {
			schema: "sophia.harness-source-composition.v1",
			compositionId: `harness-${refinementKey}`,
			incumbentHarnessRef: incumbent.ontologyBinding.objects.harness,
			candidateHarnessRef: harnessRef,
			refinementId: parsed.result.id,
		};
		const sourceCompositionRef = createMeaningfulObjectRef({
			kind: "source-composition",
			ownerPrincipal,
			graphId: input.graphId,
			objectId: sourceCompositionDocument.compositionId,
			version: "1",
			value: sourceCompositionDocument,
		});
		await evidence(sourceCompositionRef, sourceCompositionDocument);

		const editTestimony = summarizeAppliedEdits(parsed.result.appliedEdits);
		const patchBody = Buffer.from(
			[
				`Harness refinement: ${parsed.result.id}`,
				`Before: ${incumbent.ontologyBinding.objects.harness.digest}`,
				`After: ${harnessRef.digest}`,
				...editTestimony.map(
					(item) => `${item.applied ? "+" : "!"} ${item.id} ${item.type}${item.path ? ` ${item.path}` : ""}`,
				),
				"",
			].join("\n"),
			"utf8",
		);
		const patchDigest = `sha256:${createHash("sha256").update(patchBody).digest("hex")}`;
		const patchDocument = {
			schema: "sophia.harness-patch-set.v1",
			patchSetId: `harness-patch-${refinementKey}`,
			beforeRef: incumbent.ontologyBinding.objects.harness,
			afterRef: harnessRef,
			appliedEdits: editTestimony,
			patchDigest,
			patchBytes: patchBody.byteLength,
		};
		const patchSetRef = createMeaningfulObjectRef({
			kind: "patch-set",
			ownerPrincipal,
			graphId: input.graphId,
			objectId: patchDocument.patchSetId,
			version: "1",
			value: patchDocument,
		});
		await evidence(patchSetRef, patchDocument);
		const patchArtifactDescriptor = {
			mediaType: "text/x-diff",
			digest: patchDigest,
			byteLength: patchBody.byteLength,
		};
		const patchArtifactRef = createMeaningfulObjectRef({
			kind: "artifact",
			ownerPrincipal,
			graphId: input.graphId,
			objectId: patchDocument.patchSetId,
			version: "1",
			value: patchArtifactDescriptor,
		});
		await evidence(patchArtifactRef, patchArtifactDescriptor);
		await this.options.store.putEvidenceBlob({
			ref: patchArtifactRef,
			mediaType: patchArtifactDescriptor.mediaType,
			contentDigest: patchDigest,
			body: patchBody,
			createdAt: now,
		});
		const changeSetDocument = {
			schema: "sophia.harness-change-set.v1",
			changeSetId: `harness-change-${refinementKey}`,
			patchSetRef,
			refinementId: parsed.result.id,
			summary: parsed.result.summary,
			rationale: parsed.result.rationale,
		};
		const changeSetRef = createMeaningfulObjectRef({
			kind: "change-set",
			ownerPrincipal,
			graphId: input.graphId,
			objectId: changeSetDocument.changeSetId,
			version: "1",
			value: changeSetDocument,
		});
		await evidence(changeSetRef, changeSetDocument);

		const artifactDocument = {
			schema: "sophia.harness-release-artifact.v1",
			artifactId: `harness-artifact-${refinementKey}`,
			harnessRef,
			format: "application/vnd.sophia.harness+json;version=1",
		};
		const artifactRef = createMeaningfulObjectRef({
			kind: "release-artifact",
			ownerPrincipal,
			graphId: input.graphId,
			objectId: artifactDocument.artifactId,
			version: "1",
			value: artifactDocument,
		});
		await evidence(artifactRef, artifactDocument);
		const buildReceiptDocument = {
			schema: "sophia.harness-build-receipt.v1",
			buildId: `harness-build-${refinementKey}`,
			inputRef: sourceCompositionRef,
			artifactRef,
			builder: "service:choreograph-harness-materializer",
			network: "denied",
			completedAt: now,
		};
		const buildReceiptRef = createMeaningfulObjectRef({
			kind: "build-receipt",
			ownerPrincipal,
			graphId: input.graphId,
			objectId: buildReceiptDocument.buildId,
			version: "1",
			value: buildReceiptDocument,
		});
		await evidence(buildReceiptRef, buildReceiptDocument);

		const proposal: EvolutionProposalV1 = {
			schema: EVOLUTION_PROPOSAL_SCHEMA,
			proposalId: `proposal-harness-${refinementKey}`,
			ownerPrincipal,
			agentId,
			scope: { kind: "agent", agentId },
			proposedBy: agentId,
			targetLayer: "harness",
			expectedEmbodimentRef: head.embodimentRef,
			expectedEmbodimentDigest: head.embodimentRef.digest,
			problemStatement: parsed.result.summary,
			rationale: parsed.result.rationale,
			evidenceRefs: [harnessRef, changeSetRef],
			desiredOutcome: parsed.result.expectedOutcome,
			nonGoals: ["runtime source changes", "constitutional-core changes", "automatic activation"],
			requestedSourceComposition: sourceCompositionRef,
			requestedEvaluationPolicy: policyRef,
			requestedAt: now,
		};
		const proposalRef = await this.options.store.publishEvolutionObject({
			kind: "evolution-proposal",
			graphId: input.graphId,
			version: "1",
			document: proposal,
			createdAt: now,
		});
		const ontologyBinding = {
			...incumbent.ontologyBinding,
			objects: { ...incumbent.ontologyBinding.objects, harness: harnessRef },
			resolvedAt: now,
		};
		const nextEmbodiment: AgentEmbodimentV1 = {
			schema: AGENT_EMBODIMENT_SCHEMA,
			embodimentId: `embodiment-harness-${refinementKey}`,
			ownerPrincipal,
			agentId,
			runtimeBinding: incumbent.runtimeBinding,
			runtimeBindingDigest: incumbent.runtimeBindingDigest,
			ontologyBinding,
			ontologyBindingDigest: digestAgentOntologyBinding(ontologyBinding),
			predecessorRef: head.embodimentRef,
			rollbackTargetRef: head.embodimentRef,
			createdAt: now,
		};
		const nextEmbodimentRef = await this.options.store.publishEvolutionObject({
			kind: "embodiment",
			graphId: input.graphId,
			version: "1",
			document: nextEmbodiment,
			createdAt: now,
		});

		const allEditsApplied = parsed.result.appliedEdits.length > 0 && editTestimony.every((item) => item.applied);
		const run: ExtensionVerificationRunV1 = {
			schema: EXTENSION_VERIFICATION_RUN_SCHEMA,
			runId: `verification-harness-${refinementKey}`,
			ownerPrincipal,
			agentId,
			candidateId,
			candidateRuntimeBindingDigest: incumbent.runtimeBindingDigest,
			artifactRef,
			artifactDigest: artifactRef.digest,
			policyRef,
			suiteRef,
			suiteDigest: suiteRef.digest,
			securityIssues: [],
			cases: [
				{
					caseId: "content-addressed-harness-receipt",
					passed: allEditsApplied,
					deterministic: true,
					inputSchemaValid: true,
					outputSchemaValid: true,
					durationMs: 0,
					outputDigest: harnessRef.digest,
					...(!allEditsApplied ? { failure: "refinement contains no wholly applied edit testimony" } : {}),
				},
			],
			passed: allEditsApplied,
			passRate: allEditsApplied ? 1 : 0,
			newSecurityFailures: 0,
			modelCalls: 0,
			tokens: 0,
			costUsdMicros: 0,
			startedAt: now,
			completedAt: now,
		};
		const runRef = createMeaningfulObjectRef({
			kind: "verification-run",
			ownerPrincipal,
			graphId: input.graphId,
			objectId: run.runId,
			version: "1",
			value: run,
		});
		await evidence(runRef, run);
		const evaluationSetDigest = computeEvaluationSetDigest([runRef]);
		const state = allEditsApplied ? "eligible" : "ineligible";
		const candidate: EmbodimentCandidateV1 = {
			schema: EMBODIMENT_CANDIDATE_SCHEMA,
			candidateId,
			ownerPrincipal,
			agentId,
			targetLayer: "harness",
			proposalRef,
			embodimentRef: nextEmbodimentRef,
			expectedIncumbent: head.embodimentRef,
			expectedIncumbentDigest: head.embodimentRef.digest,
			sourceCompositionRef,
			changeSetRef,
			patchSetRefs: [patchSetRef],
			buildReceiptRef,
			artifactRefs: [artifactRef],
			runtimeBinding: incumbent.runtimeBinding,
			runtimeBindingDigest: incumbent.runtimeBindingDigest,
			ontologyBinding,
			ontologyBindingDigest: nextEmbodiment.ontologyBindingDigest,
			evaluationPolicyRef: policyRef,
			verificationRunRefs: [runRef],
			evaluationSetDigest,
			stateCompatibility: {
				readableCheckpointVersions: ["sophia.prime-checkpoint.v1"],
				writableCheckpointVersion: "sophia.prime-checkpoint.v1",
				reversible: true,
				coldStartAllowed: true,
			},
			createdAt: now,
			expiresAt: now + 7 * 24 * 60 * 60 * 1_000,
			status: state,
		};
		const candidateRef = await this.options.store.publishEvolutionObject({
			kind: "embodiment-candidate",
			graphId: input.graphId,
			version: "1",
			document: candidate,
			createdAt: now,
		});
		await this.options.store.recordCandidateEvaluation({
			candidateRef,
			verificationRuns: [{ ref: runRef, run }],
			evaluatedBy: "service:choreograph-harness-evaluator",
			evaluatedAt: now,
		});
		return { candidateRef, embodimentRef: nextEmbodimentRef, harnessRef, state };
	}

	async listAgent(
		ownerPrincipal: string,
		agentId: string,
	): Promise<{
		readonly head: Awaited<ReturnType<AgentEvolutionStore["getActiveEmbodiment"]>>;
		readonly objects: readonly EvolutionObjectRecord[];
	}> {
		return {
			head: await this.options.store.getActiveEmbodiment(ownerPrincipal, agentId),
			objects: await this.options.store.listEvolutionObjects({ ownerPrincipal, agentId, limit: 500 }),
		};
	}

	async flushRdfProjection(
		writer: EvolutionSparqlWriter,
		input: { readonly limit?: number; readonly now?: number } = {},
	): Promise<{ readonly projected: number; readonly failed: number; readonly pending: number }> {
		return this.options.store.flushProjectionOutbox(new GardenEvolutionProjectionSink(writer), input);
	}

	async listOwner(
		ownerPrincipal: string,
		agentId?: string,
	): Promise<{ readonly objects: readonly EvolutionObjectRecord[] }> {
		assertOwner(ownerPrincipal);
		return {
			objects: await this.options.store.listEvolutionObjects({
				ownerPrincipal,
				...(agentId ? { agentId } : {}),
				limit: 500,
			}),
		};
	}

	async getCandidate(ownerPrincipal: string, candidateId: string, version?: string): Promise<Record<string, unknown>> {
		const record = await this.options.store.getEvolutionObjectById({
			ownerPrincipal,
			kind: "embodiment-candidate",
			objectId: candidateId,
			...(version ? { version } : {}),
		});
		if (!record || record.document.schema !== "sophia.embodiment-candidate.v1") {
			throw new Error("Embodiment candidate was not found for this owner");
		}
		const candidate = record.document;
		const [proposal, embodiment, policy, sourceComposition, changeSet, buildReceipt] = await Promise.all([
			this.options.store.getEvolutionObject(candidate.proposalRef),
			this.options.store.getEvolutionObject(candidate.embodimentRef),
			this.options.store.getEvolutionObject(candidate.evaluationPolicyRef),
			this.options.store.getEvidenceObject(candidate.sourceCompositionRef),
			this.options.store.getEvidenceObject(candidate.changeSetRef),
			this.options.store.getEvidenceObject(candidate.buildReceiptRef),
		]);
		const [patchSets, artifacts, verificationRuns, agentObjects] = await Promise.all([
			Promise.all(candidate.patchSetRefs.map((ref) => this.options.store.getEvidenceObject(ref))),
			Promise.all(candidate.artifactRefs.map((ref) => this.options.store.getEvidenceObject(ref))),
			Promise.all(candidate.verificationRunRefs.map((ref) => this.options.store.getEvidenceObject(ref))),
			this.options.store.listEvolutionObjects({ ownerPrincipal, agentId: candidate.agentId, limit: 500 }),
		]);
		return {
			candidate: record,
			evaluation: await this.options.store.getCandidateEvaluation(record.ref),
			proposal,
			embodiment,
			policy,
			sourceComposition,
			changeSet,
			patchSets: patchSets.filter((item) => item !== null),
			buildReceipt,
			artifacts: artifacts.filter((item) => item !== null),
			verificationRuns: verificationRuns.filter((item) => item !== null),
			promotionDecisions: agentObjects.filter(
				(item) =>
					item.document.schema === "sophia.promotion-decision.v1" &&
					sameMeaningfulObjectRef(item.document.candidateRef, record.ref),
			),
			activations: agentObjects.filter(
				(item) =>
					item.document.schema === "sophia.embodiment-activation.v1" &&
					sameMeaningfulObjectRef(item.document.candidateRef, record.ref),
			),
			rollbacks: agentObjects.filter((item) => item.document.schema === "sophia.rollback-decision.v1"),
		};
	}

	async decidePromotion(input: OwnerPromotionInput): Promise<{
		readonly decision: PromotionDecisionV1;
		readonly decisionRef: MeaningfulObjectRefV1<"promotion-decision">;
	}> {
		assertOwner(input.ownerPrincipal);
		const candidateObject = await this.options.store.getEvolutionObject(input.candidateRef);
		if (!candidateObject || candidateObject.document.schema !== "sophia.embodiment-candidate.v1") {
			throw new Error("promotion candidate is absent");
		}
		const candidate = candidateObject.document;
		if (candidate.ownerPrincipal !== input.ownerPrincipal || candidate.agentId !== input.agentId) {
			throw new Error("promotion decision crossed its owner or Agent boundary");
		}
		if (candidate.status !== "eligible" && input.verdict === "approved") {
			throw new Error("only an eligible candidate can be approved");
		}
		const decisionId = deterministicId(
			"promotion",
			input.ownerPrincipal,
			candidate.candidateId,
			input.idempotencyKey,
		);
		const existing = await this.options.store.getEvolutionObjectById({
			ownerPrincipal: input.ownerPrincipal,
			kind: "promotion-decision",
			objectId: decisionId,
		});
		if (existing) {
			if (
				existing.document.schema !== PROMOTION_DECISION_SCHEMA ||
				existing.document.agentId !== input.agentId ||
				existing.document.verdict !== input.verdict ||
				!sameMeaningfulObjectRef(existing.document.candidateRef, input.candidateRef)
			) {
				throw new Error("promotion idempotency key was already used for a different decision");
			}
			return { decision: existing.document, decisionRef: existing.ref };
		}
		const now = this.now();
		const decision: PromotionDecisionV1 = {
			schema: PROMOTION_DECISION_SCHEMA,
			decisionId,
			ownerPrincipal: input.ownerPrincipal,
			agentId: input.agentId,
			targetLayer: candidate.targetLayer,
			candidateRef: input.candidateRef,
			candidateDigest: input.candidateRef.digest,
			expectedIncumbentDigest: candidate.expectedIncumbentDigest,
			evaluationPolicyRef: candidate.evaluationPolicyRef,
			evaluationSetDigest: candidate.evaluationSetDigest,
			verdict: input.verdict,
			decidedBy: input.ownerPrincipal,
			approvalAuthority: "owner",
			decidedAt: now,
			expiresAt: now + (input.expiresInMs ?? 24 * 60 * 60 * 1_000),
			...(input.reason ? { reason: boundedText(input.reason, "promotion reason", 4_096) } : {}),
		};
		const decisionRef = await this.options.store.publishEvolutionObject({
			kind: "promotion-decision",
			graphId: input.candidateRef.graphId,
			version: "1",
			document: decision,
			createdAt: now,
		});
		return { decision, decisionRef };
	}

	async readPatchArtifact(
		ownerPrincipal: string,
		patchSetId: string,
	): Promise<{ readonly mediaType: string; readonly contentDigest: string; readonly body: Uint8Array }> {
		const patch = await this.options.store.getEvidenceObjectById({
			ownerPrincipal,
			kind: "patch-set",
			objectId: patchSetId,
		});
		if (!patch || !isRecord(patch.document)) throw new Error("patch set was not found for this owner");
		const patchDigest = patch.document.patchDigest;
		const patchBytes = patch.document.patchBytes;
		if (
			typeof patchDigest !== "string" ||
			!/^sha256:[0-9a-f]{64}$/.test(patchDigest) ||
			typeof patchBytes !== "number"
		) {
			throw new Error("stored patch set has invalid artifact testimony");
		}
		const descriptor = { mediaType: "text/x-diff", digest: patchDigest, byteLength: patchBytes };
		const artifactRef = createMeaningfulObjectRef({
			kind: "artifact",
			ownerPrincipal,
			graphId: patch.ref.graphId,
			objectId: patchSetId,
			version: "1",
			value: descriptor,
		});
		const blob = await this.options.store.getEvidenceBlob(ownerPrincipal, artifactRef);
		if (!blob || blob.contentDigest !== patchDigest) throw new Error("patch artifact was not found for this owner");
		return blob;
	}

	async activate(input: {
		readonly ownerPrincipal: string;
		readonly agentId: string;
		readonly candidateRef: MeaningfulObjectRefV1<"embodiment-candidate">;
		readonly promotionDecisionRef: MeaningfulObjectRefV1<"promotion-decision">;
		readonly expectedIncumbentRef: MeaningfulObjectRefV1<"embodiment">;
		readonly mode: EmbodimentActivationV1["mode"];
		readonly idempotencyKey: string;
	}): Promise<Awaited<ReturnType<AgentEvolutionStore["commitActivation"]>>> {
		assertOwner(input.ownerPrincipal);
		if (input.mode === "safe-point-resume") throw new Error("safe-point-resume activation is not supported in v1");
		const candidateObject = await this.options.store.getEvolutionObject(input.candidateRef);
		if (!candidateObject || candidateObject.document.schema !== "sophia.embodiment-candidate.v1") {
			throw new Error("activation candidate is absent");
		}
		const candidate = candidateObject.document;
		const activationId = deterministicId(
			"activation",
			input.ownerPrincipal,
			candidate.candidateId,
			input.idempotencyKey,
		);
		const existing = await this.options.store.getEvolutionObjectById({
			ownerPrincipal: input.ownerPrincipal,
			kind: "embodiment-activation",
			objectId: activationId,
		});
		if (existing) {
			if (
				existing.document.schema !== "sophia.embodiment-activation.v1" ||
				existing.document.agentId !== input.agentId ||
				existing.document.mode !== input.mode ||
				!sameMeaningfulObjectRef(existing.document.candidateRef, input.candidateRef) ||
				!sameMeaningfulObjectRef(existing.document.promotionDecisionRef, input.promotionDecisionRef) ||
				!sameMeaningfulObjectRef(existing.document.expectedIncumbentRef, input.expectedIncumbentRef)
			) {
				throw new Error("activation idempotency key was already used for a different transition");
			}
			const head = await this.options.store.getActiveEmbodiment(input.ownerPrincipal, input.agentId);
			if (!head) throw new Error("Agent has no active Embodiment");
			return { activation: existing.document, activationRef: existing.ref, head };
		}
		return this.options.store.commitActivation({
			activationId,
			graphId: input.candidateRef.graphId,
			version: "1",
			ownerPrincipal: input.ownerPrincipal,
			agentId: input.agentId,
			expectedIncumbentRef: input.expectedIncumbentRef,
			nextEmbodimentRef: candidate.embodimentRef,
			candidateRef: input.candidateRef,
			promotionDecisionRef: input.promotionDecisionRef,
			mode: input.mode,
			committedBy: input.ownerPrincipal,
			committedAt: this.now(),
		});
	}

	async rollback(input: {
		readonly ownerPrincipal: string;
		readonly agentId: string;
		readonly activationRef: MeaningfulObjectRefV1<"embodiment-activation">;
		readonly targetEmbodimentRef: MeaningfulObjectRefV1<"embodiment">;
		readonly evidenceRefs?: readonly MeaningfulObjectRefV1[];
		readonly reason: string;
		readonly quarantineCurrent: boolean;
		readonly idempotencyKey: string;
	}): Promise<Awaited<ReturnType<AgentEvolutionStore["commitRollback"]>>> {
		assertOwner(input.ownerPrincipal);
		const decisionId = deterministicId("rollback", input.ownerPrincipal, input.agentId, input.idempotencyKey);
		const existing = await this.options.store.getEvolutionObjectById({
			ownerPrincipal: input.ownerPrincipal,
			kind: "rollback-decision",
			objectId: decisionId,
		});
		if (existing) {
			if (
				existing.document.schema !== "sophia.rollback-decision.v1" ||
				existing.document.agentId !== input.agentId ||
				!sameMeaningfulObjectRef(existing.document.activationRef, input.activationRef) ||
				!sameMeaningfulObjectRef(existing.document.toEmbodimentRef, input.targetEmbodimentRef)
			) {
				throw new Error("rollback idempotency key was already used for a different transition");
			}
			const head = await this.options.store.getActiveEmbodiment(input.ownerPrincipal, input.agentId);
			if (!head) throw new Error("Agent has no active Embodiment");
			return { decision: existing.document, decisionRef: existing.ref, head };
		}
		return this.options.store.commitRollback({
			decisionId,
			graphId: input.activationRef.graphId,
			version: "1",
			ownerPrincipal: input.ownerPrincipal,
			agentId: input.agentId,
			activationRef: input.activationRef,
			targetEmbodimentRef: input.targetEmbodimentRef,
			evidenceRefs: input.evidenceRefs ?? [],
			decidedBy: input.ownerPrincipal,
			automatic: false,
			reason: boundedText(input.reason, "rollback reason", 4_096),
			decidedAt: this.now(),
			quarantineCurrent: input.quarantineCurrent,
		});
	}

	private async ensureInitialEmbodiment(
		config: AgentWorkerConfig,
		ownerPrincipal: string,
		agentId: string,
		graphId: string,
	): Promise<void> {
		const ontology = config.agent_ontology;
		const runtime = config.runtime_binding;
		if (!ontology || !runtime) throw new Error("initial Embodiment requires runtime and ontology bindings");
		let embodiment: AgentEmbodimentV1;
		if ("bundle" in runtime) {
			const runtimeV2 = {
				schema: AGENT_RUNTIME_BINDING_V2_SCHEMA,
				kind: runtime.kind,
				baseBundle: runtime.bundle,
				overlays: [],
				profileRef: runtime.profileRef,
				constraints: runtime.constraints,
				extensionAbi: PRIME_EXTENSION_ABI,
			} as const;
			const runtimeDigest = digestAgentRuntimeBindingV2(runtimeV2);
			const ontologyDigest = digestAgentOntologyBinding(ontology);
			embodiment = {
				schema: AGENT_EMBODIMENT_SCHEMA,
				embodimentId: `embodiment-bootstrap-${runtimeDigest.slice("sha256:".length, "sha256:".length + 24)}-${ontologyDigest.slice("sha256:".length, "sha256:".length + 8)}`,
				ownerPrincipal,
				agentId,
				runtimeBinding: runtimeV2,
				runtimeBindingDigest: runtimeDigest,
				ontologyBinding: ontology,
				ontologyBindingDigest: ontologyDigest,
				createdAt: this.now(),
			};
		} else {
			if (!config.embodiment_binding || !config.embodiment_ref) {
				throw new Error("an overlay runtime requires an exact Embodiment envelope");
			}
			embodiment = config.embodiment_binding;
		}
		const active = await this.options.store.getActiveEmbodiment(ownerPrincipal, agentId);
		if (active) {
			let activeRecord: EvolutionObjectRecord;
			try {
				activeRecord = await this.options.store.getEvolutionObject(active.embodimentRef);
			} catch (cause) {
				if (!(await this.options.store.isRebindableBootstrapEmbodiment(active))) throw cause;
				const embodimentRef = await this.options.store.publishEvolutionObject({
					kind: "embodiment",
					graphId,
					version: "1",
					document: embodiment,
					createdAt: embodiment.createdAt,
				});
				await this.options.store.rebindBootstrapEmbodiment({
					expectedHead: active,
					embodimentRef,
					embodiment,
					now: this.now(),
				});
				return;
			}
			if (!activeRecord || activeRecord.document.schema !== AGENT_EMBODIMENT_SCHEMA) {
				throw new Error("active bootstrap Embodiment object is absent");
			}
			const incumbent = activeRecord.document;
			if (
				incumbent.runtimeBindingDigest === embodiment.runtimeBindingDigest &&
				incumbent.ontologyBindingDigest === embodiment.ontologyBindingDigest
			) {
				return;
			}
			if (
				!incumbent.embodimentId.startsWith("embodiment-bootstrap-") ||
				incumbent.runtimeBinding.overlays.length !== 0
			) {
				// A fresh host binding is only a bootstrap input. Once an owner has
				// activated an evolved Embodiment, session materialization must keep
				// following that active head; it must never overwrite it implicitly.
				return;
			}
			const embodimentRef = await this.options.store.publishEvolutionObject({
				kind: "embodiment",
				graphId,
				version: "1",
				document: embodiment,
				createdAt: embodiment.createdAt,
			});
			await this.options.store.rebindBootstrapEmbodiment({
				expectedHead: active,
				embodimentRef,
				embodiment,
				now: this.now(),
			});
			return;
		}
		const embodimentRef = await this.options.store.publishEvolutionObject({
			kind: "embodiment",
			graphId,
			version: "1",
			document: embodiment,
			createdAt: embodiment.createdAt,
		});
		if (config.embodiment_ref && !sameMeaningfulObjectRef(config.embodiment_ref, embodimentRef)) {
			throw new Error("initial Embodiment ref differs from its exact document");
		}
		await this.options.store.initializeActiveEmbodiment({ embodimentRef, embodiment, now: this.now() });
	}

	private findReusableService(ownerPrincipal: string, agentId: string): AgentEvolutionService | undefined {
		const prefix = `${ownerPrincipal}\0${agentId}\0`;
		for (const [key, service] of [...this.services.entries()].reverse()) {
			if (key.startsWith(prefix) && service.candidateWorkspaceForRebinding()) return service;
		}
		return undefined;
	}

	private ownerBindings(
		ownerPrincipal: string,
		graphId: string,
	): {
		readonly sourceCompositionDocument: Readonly<Record<string, unknown>>;
		readonly sourceCompositionRef: MeaningfulObjectRefV1<"source-composition">;
		readonly suite: ExtensionEvaluationSuiteV1;
		readonly suiteRef: MeaningfulObjectRefV1<"evaluation-suite">;
		readonly policy: EvaluationPolicyV1;
		readonly policyRef: MeaningfulObjectRefV1<"evaluation-policy">;
	} {
		const now = this.now();
		const sourceCompositionDocument = {
			schema: "sophia.source-composition.v1",
			repositoryId: this.options.repository.repositoryId,
			baseRevision: this.options.repository.baseRevision,
			allowedPaths: this.options.repository.allowedPaths,
			extensionRoot: this.options.repository.extensionRoot,
		};
		const sourceCompositionRef = createMeaningfulObjectRef({
			kind: "source-composition",
			ownerPrincipal,
			graphId,
			objectId: `source-${this.options.repository.repositoryId}`,
			version: this.options.repository.baseRevision,
			value: sourceCompositionDocument,
		});
		const suite: ExtensionEvaluationSuiteV1 = {
			schema: EXTENSION_EVALUATION_SUITE_SCHEMA,
			suiteId: `personal-extension-${stableHash(this.options.evaluation.skillName).slice(0, 16)}`,
			ownerPrincipal,
			skillName: this.options.evaluation.skillName,
			fixtures: this.options.evaluation.fixtures,
			timeoutMs: this.options.evaluation.timeoutMs ?? 5_000,
			maximumOutputBytes: this.options.evaluation.maximumOutputBytes ?? 1_048_576,
			createdAt: now,
		};
		const suiteRef = createMeaningfulObjectRef({
			kind: "evaluation-suite",
			ownerPrincipal,
			graphId,
			objectId: suite.suiteId,
			version: "1",
			value: suite,
		});
		const policy: EvaluationPolicyV1 = {
			schema: "sophia.agent-evaluation-policy.v1",
			policyId: "personal-prime-extension",
			policyVersion: "1",
			ownerPrincipal,
			evolutionClass: "extension",
			requiredSuites: [{ suiteRef, required: true, maximumAgeMs: 60 * 60 * 1_000 }],
			thresholds: { requiredPassRate: 1, maximumNewSecurityFailures: 0 },
			approverPolicy: "owner",
			watchPolicy: { sessions: 3, automaticRollbackOn: ["host-protocol-violation", "extension-load-failure"] },
		};
		const policyRef = createMeaningfulObjectRef({
			kind: "evaluation-policy",
			ownerPrincipal,
			graphId,
			objectId: policy.policyId,
			version: policy.policyVersion,
			value: policy,
		});
		return { sourceCompositionDocument, sourceCompositionRef, suite, suiteRef, policy, policyRef };
	}
}

function serviceKey(ownerPrincipal: string, agentId: string, sessionId: string): string {
	return `${ownerPrincipal}\0${agentId}\0${sessionId}`;
}

function ontologyRefs(binding: AgentOntologyBindingV1): readonly MeaningfulObjectRefV1[] {
	return [
		binding.objects.agent,
		binding.objects.geist,
		binding.objects.prompt,
		...binding.objects.skills,
		binding.objects.harness,
		binding.objects.toolManifest,
		binding.objects.toolGrant,
		binding.objects.runtimeProfile,
	];
}

function deterministicId(prefix: string, ...parts: readonly string[]): string {
	for (const part of parts) required(part, prefix);
	return `${prefix}-${stableHash(parts.join("\0")).slice(0, 32)}`;
}

function stableHash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function assertOwner(value: string): void {
	if (!/^user:[^\s]+$/.test(value)) throw new Error("owner principal must be an exact user principal");
}

interface ParsedHarnessRefinement {
	readonly result: {
		readonly id: string;
		readonly summary: string;
		readonly rationale: string;
		readonly expectedOutcome: string;
		readonly appliedEdits: readonly Record<string, unknown>[];
	};
	readonly snapshot: Readonly<Record<string, unknown>> & { readonly schema: 1 };
}

interface AppliedEditTestimony {
	readonly id: string;
	readonly type: string;
	readonly path?: string;
	readonly applied: boolean;
	readonly error?: string;
}

function parseHarnessRefinement(value: unknown): ParsedHarnessRefinement {
	if (!isRecord(value)) throw new Error("refinement event payload must be an object");
	if (typeof value.harness_snapshot_error === "string") {
		throw new Error(`refinement harness snapshot could not be captured: ${value.harness_snapshot_error}`);
	}
	if (!isRecord(value.result)) throw new Error("refinement event result is absent");
	if (!isRecord(value.harness_snapshot) || value.harness_snapshot.schema !== 1) {
		throw new Error("refinement event harness snapshot schema is unsupported");
	}
	const encoded = JSON.stringify(value);
	if (Buffer.byteLength(encoded) > 3 * 1024 * 1024) throw new Error("refinement event exceeds 3 MiB");
	const result = value.result;
	for (const key of ["id", "summary", "rationale", "expectedOutcome"] as const) {
		if (typeof result[key] !== "string" || !result[key].trim()) {
			throw new Error(`refinement result ${key} is required`);
		}
	}
	if ((result.id as string).length > 256) throw new Error("refinement result id exceeds 256 characters");
	for (const key of ["summary", "rationale", "expectedOutcome"] as const) {
		if ((result[key] as string).length > 8_192) {
			throw new Error(`refinement result ${key} exceeds 8192 characters`);
		}
	}
	if (!Array.isArray(result.appliedEdits)) throw new Error("refinement result appliedEdits must be an array");
	for (const [index, edit] of result.appliedEdits.entries()) {
		if (
			!isRecord(edit) ||
			typeof edit.id !== "string" ||
			!edit.id.trim() ||
			typeof edit.type !== "string" ||
			!edit.type.trim() ||
			typeof edit.applied !== "boolean"
		) {
			throw new Error(`refinement applied edit ${String(index)} has invalid testimony`);
		}
	}
	return {
		result: {
			id: result.id as string,
			summary: result.summary as string,
			rationale: result.rationale as string,
			expectedOutcome: result.expectedOutcome as string,
			appliedEdits: result.appliedEdits as Record<string, unknown>[],
		},
		snapshot: value.harness_snapshot as Readonly<Record<string, unknown>> & { readonly schema: 1 },
	};
}

function summarizeAppliedEdits(edits: readonly Record<string, unknown>[]): readonly AppliedEditTestimony[] {
	return edits.map((edit) => ({
		id: String(edit.id),
		type: String(edit.type),
		...(typeof edit.path === "string" && edit.path ? { path: edit.path } : {}),
		applied: edit.applied === true,
		...(typeof edit.error === "string" && edit.error ? { error: edit.error.slice(0, 512) } : {}),
	}));
}

function required(value: string | undefined, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
	return value;
}

function boundedText(value: string | undefined, label: string, maximumLength: number): string {
	const parsed = required(value, label);
	if (parsed.length > maximumLength) throw new Error(`${label} exceeds ${String(maximumLength)} characters`);
	return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
