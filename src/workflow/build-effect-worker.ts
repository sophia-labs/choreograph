/** Credential-owning Phanes edge for Development Domain native builds. */

import { canonicalDigest } from "../agent-subject/canonical-json.js";
import { type ChoreographReleaseArtifactV1, validChoreographReleaseArtifact } from "./choreograph-release-artifact.js";
import {
	DevelopmentEffectError,
	type DevelopmentGrantHost,
	developmentTerminal,
	type ValidatedDevelopmentHandoff,
	validateDevelopmentHandoff,
	verifyCurrentDevelopmentGrant,
} from "./development-effect.js";
import type { DomainSourceTurnV1 } from "./domain-source-turn.js";
import { type CommittedDevelopmentTarget, type ProposedEffectV1, proposedEffectDigest } from "./proposed-effect.js";
import type { EffectHandoffRecord, WorkflowRuntimeStore } from "./runtime-store.js";

export const BUILD_MATERIALIZATION_SCHEMA = "sophia.build-materialization.v1" as const;
export const BUILD_EFFECT_COMPLETION_SCHEMA = "sophia.build-effect-completion.v1" as const;
export const BUILD_RECEIPT_SCHEMA = "sophia.build-receipt.v1" as const;

const BUILD_OPERATIONS = new Set(["build.plan", "build.start"]);
const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const BUILD_REF = /^build:[0-9a-f]{64}$/;
const BUILD_RECEIPT_ID = /^build-receipt:[0-9a-f]{64}$/;

export type BuildOperation = "build.plan" | "build.start";
export type BuildState = "planned" | "cache-hit" | "queued" | "building" | "succeeded" | "failed" | "refused";
export type BuildArtifactClass = "oci-image" | "choreograph-release";

export type { ChoreographReleaseArtifactV1 } from "./choreograph-release-artifact.js";

export interface ConcreteBuildTarget extends CommittedDevelopmentTarget {
	readonly builderRecipeId: string;
	readonly builderRecipeDigest: string;
}

export interface BuildMaterializationRequestV1 {
	readonly schema: typeof BUILD_MATERIALIZATION_SCHEMA;
	readonly operation: BuildOperation;
	readonly effectIndex: number;
	/** Digest of the original sandbox proposal, retained as proposal testimony. */
	readonly proposalDigest: string;
	/** Digest of the host-bound proposal bytes carried in this request. */
	readonly effectiveProposalDigest: string;
	readonly executionDigest: string;
	readonly sourceTurnDigest: string;
	readonly sourceTurn: DomainSourceTurnV1;
	readonly trigger: Readonly<Record<string, unknown>>;
	readonly proposal: ProposedEffectV1;
	readonly target: ConcreteBuildTarget;
	readonly grant: {
		readonly grantId: string;
		readonly grantDigest: string;
		readonly authorityOwnerPrincipal: string;
		readonly authorityGraphId: string;
		readonly maxConcurrent: number;
		readonly maxCostMicrousd: number;
	};
	readonly estimatedCostMicrousd: number;
	readonly runId: string;
}

export interface BuildReceiptV1 {
	readonly schema: typeof BUILD_RECEIPT_SCHEMA;
	readonly receiptId: string;
	readonly requestDigest: string;
	readonly effectIdempotencyKey: string;
	readonly sourceTurnId: string;
	readonly operation: BuildOperation;
	readonly ownerPrincipal: string;
	readonly repository: string;
	readonly sourceRevision: string;
	readonly builderRecipeId: string;
	readonly builderRecipeDigest: string;
	readonly planDigest: string;
	readonly contextDigest: string;
	readonly contextBytes: number;
	readonly contentKey: string;
	readonly buildRef: string;
	readonly state: BuildState;
	readonly cacheHit: boolean;
	readonly estimatedCostMicrousd: number;
	readonly artifactClass: BuildArtifactClass;
	readonly imageRepository?: string;
	readonly imageDigest?: string;
	readonly artifact?: ChoreographReleaseArtifactV1;
	readonly resultRef?: string;
	readonly observedAtMs: number;
}

export interface BuildMaterializationResponseV1 {
	readonly created: boolean;
	readonly receipt: BuildReceiptV1;
}

export interface BuildEffectCompletionV1 {
	readonly schema: typeof BUILD_EFFECT_COMPLETION_SCHEMA;
	readonly idempotencyKey: string;
	readonly operation: BuildOperation;
	readonly ownerPrincipal: string;
	readonly repository: string;
	readonly sourceRevision: string;
	readonly builderRecipeId: string;
	readonly builderRecipeDigest: string;
	readonly created: boolean;
	readonly receipt: BuildReceiptV1;
}

export interface BuildEffectHost extends DevelopmentGrantHost {
	materialize(request: BuildMaterializationRequestV1): Promise<BuildMaterializationResponseV1>;
	close?(): Promise<void>;
}

export function validateBuildHandoff(record: EffectHandoffRecord): ValidatedDevelopmentHandoff {
	return validateDevelopmentHandoff(record, { capability: "build", operations: BUILD_OPERATIONS });
}

export class BuildEffectExecutor {
	constructor(private readonly host: BuildEffectHost) {}

	async execute(
		handoff: ValidatedDevelopmentHandoff,
		grant: Awaited<ReturnType<typeof verifyCurrentDevelopmentGrant>>,
	): Promise<BuildEffectCompletionV1> {
		const target = concreteTarget(handoff.target, handoff.record.operation as BuildOperation);
		const maxConcurrent = requiredPositiveQuota(grant.capability.quota.maxConcurrent, "build maxConcurrent");
		const maxCostMicrousd = requiredPositiveQuota(grant.capability.quota.maxCostMicrousd, "build maxCostMicrousd");
		const estimatedCostMicrousd = requiredEstimatedCost(handoff.proposal.estimatedCostMicrousd, maxCostMicrousd);
		const request: BuildMaterializationRequestV1 = {
			schema: BUILD_MATERIALIZATION_SCHEMA,
			operation: handoff.record.operation as BuildOperation,
			effectIndex: handoff.record.effect_index,
			proposalDigest: handoff.record.proposal_digest,
			effectiveProposalDigest: proposedEffectDigest(handoff.proposal),
			executionDigest: handoff.record.execution_digest,
			sourceTurnDigest: requiredText(handoff.record.source_turn_digest, "source turn digest"),
			sourceTurn: handoff.sourceTurn,
			trigger: handoff.trigger,
			proposal: handoff.proposal,
			target,
			grant: {
				grantId: handoff.record.grant_id,
				grantDigest: handoff.record.grant_digest,
				authorityOwnerPrincipal: handoff.record.grant_authority_owner_principal,
				authorityGraphId: handoff.record.grant_authority_graph_id,
				maxConcurrent,
				maxCostMicrousd,
			},
			estimatedCostMicrousd,
			runId: handoff.record.run_id,
		};
		const result = await this.host.materialize(request);
		validateMaterializationResponse(result, request, handoff.record.idempotency_key);
		return {
			schema: BUILD_EFFECT_COMPLETION_SCHEMA,
			idempotencyKey: handoff.record.idempotency_key,
			operation: request.operation,
			ownerPrincipal: target.ownerPrincipal,
			repository: target.repository,
			sourceRevision: target.sourceRevision,
			builderRecipeId: target.builderRecipeId,
			builderRecipeDigest: target.builderRecipeDigest,
			created: result.created,
			receipt: result.receipt,
		};
	}
}

export class BuildEffectWorker {
	private timer: ReturnType<typeof setInterval> | undefined;
	private active: Promise<boolean> | undefined;
	private closed = false;

	constructor(
		private readonly runtime: WorkflowRuntimeStore,
		private readonly host: BuildEffectHost,
		private readonly executor = new BuildEffectExecutor(host),
		private readonly options: {
			readonly consumer?: string;
			readonly pollMs?: number;
			readonly leaseMs?: number;
			readonly now?: () => number;
			readonly log?: (message: string, error?: unknown) => void;
		} = {},
	) {}

	start(): void {
		if (this.timer || this.closed) return;
		const pollMs = positiveInteger(this.options.pollMs ?? 1_000, "build effect poll interval");
		this.timer = setInterval(() => this.schedule(), pollMs);
		this.timer.unref?.();
		this.schedule();
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.active?.catch(() => {});
		await this.host.close?.();
	}

	async runOnce(): Promise<boolean> {
		const now = this.options.now?.() ?? Date.now();
		const consumer = this.options.consumer ?? "choreograph-build-edge";
		const record = await this.runtime.claimEffectHandoff({
			consumer,
			capabilities: ["build"],
			leaseMs: positiveInteger(this.options.leaseMs ?? 60_000, "build effect lease"),
			now,
		});
		if (!record) return false;
		try {
			const handoff = validateBuildHandoff(record);
			const grant = await verifyCurrentDevelopmentGrant(this.host, handoff, this.options.now?.() ?? Date.now());
			const completion = await this.executor.execute(handoff, grant);
			await this.runtime.completeEffectHandoff({
				idempotencyKey: record.idempotency_key,
				consumer,
				claimToken: requiredClaimToken(record),
				outcome: "executed",
				completion,
				now: this.options.now?.() ?? Date.now(),
			});
		} catch (error) {
			const failure =
				error instanceof DevelopmentEffectError ? error : new DevelopmentEffectError("build-host-failure", true);
			try {
				await this.runtime.completeEffectHandoff({
					idempotencyKey: record.idempotency_key,
					consumer,
					claimToken: requiredClaimToken(record),
					outcome: failure.retryable ? "failed-retryable" : "failed-terminal",
					completion: { schema: BUILD_EFFECT_COMPLETION_SCHEMA, code: failure.code },
					...(failure.retryable ? { retryAfterMs: retryDelay(record.attempt) } : {}),
					now: this.options.now?.() ?? Date.now(),
				});
			} catch (completionError) {
				this.options.log?.("build effect completion could not be persisted", completionError);
			}
		}
		return true;
	}

	private schedule(): void {
		if (this.closed || this.active) return;
		this.active = this.runOnce()
			.catch((error) => {
				this.options.log?.("build effect poll failed", error);
				return false;
			})
			.finally(() => {
				this.active = undefined;
			});
	}
}

function concreteTarget(target: CommittedDevelopmentTarget, operation: BuildOperation): ConcreteBuildTarget {
	if (!target.builderRecipeId || !target.builderRecipeDigest || !SHA256.test(target.builderRecipeDigest)) {
		throw developmentTerminal("build-recipe-required");
	}
	if (operation === "build.start") {
		if (!target.buildPlanDigest || !SHA256.test(target.buildPlanDigest)) {
			throw developmentTerminal("build-plan-digest-required");
		}
		if (!target.buildContextDigest || !SHA256.test(target.buildContextDigest)) {
			throw developmentTerminal("build-context-digest-required");
		}
		if (!Number.isSafeInteger(target.buildContextBytes) || Number(target.buildContextBytes) < 1) {
			throw developmentTerminal("build-context-bytes-required");
		}
	} else if (
		target.buildPlanDigest !== undefined ||
		target.buildContextDigest !== undefined ||
		target.buildContextBytes !== undefined
	) {
		throw developmentTerminal("build-plan-witness-unexpected");
	}
	return target as ConcreteBuildTarget;
}

function validateMaterializationResponse(
	result: BuildMaterializationResponseV1,
	request: BuildMaterializationRequestV1,
	idempotencyKey: string,
): void {
	if (!result || typeof result.created !== "boolean" || !result.receipt) {
		throw developmentTerminal("build-materialization-response-invalid");
	}
	const receipt = result.receipt;
	if (
		receipt.schema !== BUILD_RECEIPT_SCHEMA ||
		!BUILD_RECEIPT_ID.test(receipt.receiptId) ||
		receipt.effectIdempotencyKey !== idempotencyKey ||
		receipt.sourceTurnId !== request.sourceTurn.turnId ||
		receipt.operation !== request.operation ||
		receipt.ownerPrincipal !== request.target.ownerPrincipal ||
		receipt.repository !== request.target.repository ||
		receipt.sourceRevision !== request.target.sourceRevision ||
		receipt.builderRecipeId !== request.target.builderRecipeId ||
		receipt.builderRecipeDigest !== request.target.builderRecipeDigest ||
		receipt.requestDigest !== canonicalDigest(request) ||
		!SHA256.test(receipt.planDigest) ||
		!SHA256.test(receipt.contextDigest) ||
		!SHA256.test(receipt.contentKey) ||
		!BUILD_REF.test(receipt.buildRef) ||
		receipt.buildRef !== `build:${receipt.contentKey}` ||
		typeof receipt.cacheHit !== "boolean" ||
		!Number.isSafeInteger(receipt.contextBytes) ||
		receipt.contextBytes < 1 ||
		!Number.isSafeInteger(receipt.estimatedCostMicrousd) ||
		receipt.estimatedCostMicrousd < 1 ||
		receipt.estimatedCostMicrousd > request.estimatedCostMicrousd ||
		!Number.isSafeInteger(receipt.observedAtMs) ||
		receipt.observedAtMs < 0 ||
		!(["planned", "cache-hit", "queued", "building", "succeeded", "failed", "refused"] as const).includes(
			receipt.state,
		) ||
		(receipt.resultRef !== undefined && (typeof receipt.resultRef !== "string" || !receipt.resultRef))
	) {
		throw developmentTerminal("build-materialization-witness-mismatch");
	}
	if (receipt.artifactClass === "oci-image") {
		if (
			typeof receipt.imageRepository !== "string" ||
			!receipt.imageRepository ||
			(receipt.imageDigest !== undefined && !IMAGE_DIGEST.test(receipt.imageDigest)) ||
			receipt.artifact !== undefined ||
			((receipt.cacheHit || receipt.state === "succeeded") && receipt.imageDigest === undefined)
		) {
			throw developmentTerminal("build-materialization-witness-mismatch");
		}
	} else if (receipt.artifactClass === "choreograph-release") {
		if (
			receipt.imageRepository !== undefined ||
			receipt.imageDigest !== undefined ||
			(receipt.artifact !== undefined &&
				!validChoreographReleaseArtifact(receipt.artifact, {
					repository: receipt.repository,
					sourceRevision: receipt.sourceRevision,
					contentKey: receipt.contentKey,
				})) ||
			((receipt.cacheHit || receipt.state === "succeeded") && receipt.artifact === undefined)
		) {
			throw developmentTerminal("build-materialization-witness-mismatch");
		}
	} else {
		throw developmentTerminal("build-materialization-witness-mismatch");
	}
	if (request.operation === "build.start") {
		if (
			receipt.planDigest !== request.target.buildPlanDigest ||
			receipt.contextDigest !== request.target.buildContextDigest ||
			receipt.contextBytes !== request.target.buildContextBytes
		) {
			throw developmentTerminal("build-plan-witness-mismatch");
		}
	}
	if (receipt.cacheHit && receipt.state !== "cache-hit" && receipt.state !== "succeeded") {
		throw developmentTerminal("build-cache-witness-invalid");
	}
}

function requiredEstimatedCost(value: number | undefined, max: number): number {
	if (!Number.isSafeInteger(value) || Number(value) < 1) throw developmentTerminal("build-cost-estimate-required");
	if (Number(value) > max) throw developmentTerminal("build-cost-quota-denied");
	return Number(value);
}

function requiredPositiveQuota(value: number | undefined, label: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 1) throw developmentTerminal("build-quota-required");
	return positiveInteger(Number(value), label);
}

function requiredClaimToken(record: EffectHandoffRecord): string {
	if (!record.claim_token) throw new Error("build effect lease has no claim token");
	return record.claim_token;
}

function requiredText(value: string | undefined, label: string): string {
	if (!value) throw developmentTerminal(`${label.replaceAll(" ", "-")}-missing`);
	return value;
}

function retryDelay(attempt: number): number {
	return Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(attempt, 0), 6));
}

function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
	return value;
}
