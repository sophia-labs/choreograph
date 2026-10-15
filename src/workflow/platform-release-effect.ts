/** Credential-owning host edge for one digest-bound cloud-2 realization. */

import { createHash } from "node:crypto";
import { type MeaningfulObjectRefV1, validateMeaningfulObjectRef } from "../agent-runtime/meaningful-object.js";
import { canonicalDigest } from "../agent-subject/canonical-json.js";
import {
	type AgentToolGrantV1,
	assertGrantActive,
	effectApprovalPolicyFor,
	findGrantedCapability,
	grantDigest,
	parseAgentToolGrant,
} from "./agent-tool-grant.js";
import { stableJson } from "./agent-tool-manifest.js";
import {
	type DomainSourceTurnV1,
	domainSourceTurnDigest,
	domainTriggerDigest,
	parseDomainSourceTurn,
} from "./domain-source-turn.js";
import { unwrapAuthoredJsonDocument } from "./graph-writer.js";
import {
	type CommittedPlatformReleaseTarget,
	type ProposedEffectV1,
	parseCommittedPlatformReleaseTarget,
	parseProposedEffect,
	proposedEffectDigest,
	proposedEffectExecutionDigest,
} from "./proposed-effect.js";
import type { EffectHandoffRecord, WorkflowRuntimeStore } from "./runtime-store.js";

export const PLATFORM_REALIZATION_SCHEMA = "sophia.platform-realization.v1" as const;
export const PLATFORM_REALIZATION_RECEIPT_SCHEMA = "sophia.platform-realization-receipt.v1" as const;
export const PLATFORM_RELEASE_COMPLETION_SCHEMA = "sophia.platform-release-effect-completion.v1" as const;

const PLATFORM_CAPABILITY = "platform.release";
const PLATFORM_OPERATION = "platform.release.apply";
const SHA256 = /^[0-9a-f]{64}$/;
const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/;
const RECEIPT_ID = /^platform-realization-receipt:[0-9a-f]{64}$/;
const REALIZATION_STATES = ["launching", "queued", "running", "succeeded", "failed"] as const;

export type PlatformRealizationState = (typeof REALIZATION_STATES)[number];

export interface PlatformRealizationRequestV1 {
	readonly schema: typeof PLATFORM_REALIZATION_SCHEMA;
	readonly effectIndex: number;
	readonly proposalDigest: string;
	readonly effectiveProposalDigest: string;
	readonly executionDigest: string;
	readonly sourceTurnDigest: string;
	readonly sourceTurn: DomainSourceTurnV1;
	readonly trigger: Readonly<Record<string, unknown>>;
	readonly proposal: ProposedEffectV1;
	readonly target: CommittedPlatformReleaseTarget;
	readonly grant: {
		readonly grantId: string;
		readonly grantDigest: string;
		readonly authorityOwnerPrincipal: string;
		readonly authorityGraphId: string;
		readonly allowedOperations: readonly ["platform.release.apply"];
		readonly approvalMode: "notify";
	};
	readonly runId: string;
}

export interface PlatformRealizationReceiptV1 {
	readonly schema: typeof PLATFORM_REALIZATION_RECEIPT_SCHEMA;
	readonly receiptId: string;
	readonly requestDigest: string;
	readonly effectIdempotencyKey: string;
	readonly sourceTurnId: string;
	readonly ownerPrincipal: string;
	readonly resource: CommittedPlatformReleaseTarget["resource"];
	readonly planDigest: string;
	readonly sourceRevision: string;
	readonly confirmation: string;
	readonly state: PlatformRealizationState;
	readonly planRef: string;
	readonly observedAtMs: number;
	readonly buildId?: string;
	readonly resultRef?: string;
	readonly applyReceiptDigest?: string;
	readonly deploymentReceiptRef?: MeaningfulObjectRefV1<"deployment-receipt">;
	readonly terraformPlanRef?: string;
	readonly terraformPlanDigest?: string;
	readonly failureCode?: string;
}

export interface PlatformRealizationResponseV1 {
	readonly created: boolean;
	readonly receipt: PlatformRealizationReceiptV1;
}

export interface PlatformReleaseCompletionV1 {
	readonly schema: typeof PLATFORM_RELEASE_COMPLETION_SCHEMA;
	readonly idempotencyKey: string;
	readonly ownerPrincipal: string;
	readonly resource: CommittedPlatformReleaseTarget["resource"];
	readonly planDigest: string;
	readonly sourceRevision: string;
	readonly created: boolean;
	readonly receipt: PlatformRealizationReceiptV1;
}

export interface PlatformReleaseEffectHost {
	readGrant(record: EffectHandoffRecord): Promise<string>;
	materialize(request: PlatformRealizationRequestV1): Promise<PlatformRealizationResponseV1>;
	close?(): Promise<void>;
}

export interface ValidatedPlatformReleaseHandoff {
	readonly record: EffectHandoffRecord;
	readonly sourceTurn: DomainSourceTurnV1;
	readonly trigger: Readonly<Record<string, unknown>>;
	readonly proposal: ProposedEffectV1;
	readonly target: CommittedPlatformReleaseTarget;
}

export interface VerifiedPlatformReleaseGrant {
	readonly grant: AgentToolGrantV1;
	readonly digest: string;
}

export class PlatformReleaseEffectError extends Error {
	constructor(
		readonly code: string,
		readonly retryable: boolean,
		message = code,
	) {
		super(message);
		this.name = "PlatformReleaseEffectError";
	}
}

/** Recompute every durable authority witness before the gateway is reachable. */
export function validatePlatformReleaseHandoff(record: EffectHandoffRecord): ValidatedPlatformReleaseHandoff {
	if (
		!record.source_turn_id ||
		!record.source_turn_digest ||
		!record.source_owner_principal ||
		!record.definition_digest ||
		!SHA256.test(record.source_turn_digest) ||
		!SHA256.test(record.definition_digest) ||
		!SHA256.test(record.grant_digest)
	) {
		throw terminal("platform-release-witness-missing");
	}
	let sourceTurn: DomainSourceTurnV1;
	try {
		sourceTurn = parseDomainSourceTurn(record.source_turn);
	} catch (error) {
		throw terminal("platform-release-source-turn-invalid", error);
	}
	if (
		sourceTurn.turnId !== record.source_turn_id ||
		domainSourceTurnDigest(sourceTurn) !== record.source_turn_digest ||
		sourceTurn.target.graphId !== record.graph_id ||
		sourceTurn.target.ownerPrincipal !== record.source_owner_principal ||
		sourceTurn.agentId !== record.agent_id ||
		sourceTurn.actorRef !== record.actor_ref
	) {
		throw terminal("platform-release-source-turn-authority-mismatch");
	}
	if (!isRecord(record.trigger) || domainTriggerDigest(record.trigger) !== sourceTurn.triggerDigest) {
		throw terminal("platform-release-trigger-witness-mismatch");
	}
	if (record.capability !== PLATFORM_CAPABILITY || record.operation !== PLATFORM_OPERATION) {
		throw terminal("platform-release-operation-invalid");
	}
	let proposal: ProposedEffectV1;
	try {
		proposal = parseProposedEffect(record.proposal);
	} catch (error) {
		throw terminal("platform-release-proposal-invalid", error);
	}
	if (
		proposal.capability !== PLATFORM_CAPABILITY ||
		proposal.operation !== PLATFORM_OPERATION ||
		proposedEffectExecutionDigest(proposal) !== record.execution_digest ||
		proposal.estimatedCostMicrousd !== undefined
	) {
		throw terminal("platform-release-proposal-witness-mismatch");
	}
	const expectedKey = `effect:${sha256({ sourceTurnId: sourceTurn.turnId, effectIndex: record.effect_index })}`;
	if (record.idempotency_key !== expectedKey || proposal.idempotencyKey !== expectedKey) {
		throw terminal("platform-release-effect-identity-mismatch");
	}
	let target: CommittedPlatformReleaseTarget;
	try {
		target = parseCommittedPlatformReleaseTarget(record.trigger);
	} catch (error) {
		throw terminal("platform-release-target-invalid", error);
	}
	if (
		target.ownerPrincipal !== sourceTurn.target.ownerPrincipal ||
		record.grant_authority_owner_principal !== target.ownerPrincipal
	) {
		throw terminal("platform-release-owner-mismatch");
	}
	const expectedArguments = {
		resource: target.resource,
		planDigest: target.planDigest,
		sourceRevision: target.sourceRevision,
		confirmation: target.confirmation,
	};
	if (stableJson(proposal.arguments) !== stableJson(expectedArguments)) {
		throw terminal("platform-release-target-witness-mismatch");
	}
	return { record, sourceTurn, trigger: record.trigger, proposal, target };
}

/** Reread the current graph-authored grant and require one exact release lane. */
export async function verifyCurrentPlatformReleaseGrant(
	host: PlatformReleaseEffectHost,
	handoff: ValidatedPlatformReleaseHandoff,
	now = Date.now(),
): Promise<VerifiedPlatformReleaseGrant> {
	let raw: string;
	try {
		raw = await host.readGrant(handoff.record);
	} catch (error) {
		throw retryable("platform-release-grant-unavailable", error);
	}
	let grant: AgentToolGrantV1;
	try {
		grant = parseAgentToolGrant(JSON.parse(unwrapAuthoredJsonDocument(raw)) as unknown);
	} catch (error) {
		throw terminal("platform-release-grant-malformed", error);
	}
	const digest = grantDigest(grant);
	if (digest !== handoff.record.grant_digest) throw terminal("platform-release-grant-digest-changed");
	if (
		grant.grantId !== handoff.record.grant_id ||
		grant.authorityGraphId !== handoff.record.grant_authority_graph_id
	) {
		throw terminal("platform-release-grant-witness-mismatch");
	}
	try {
		assertGrantActive(grant, handoff.record.agent_id, now);
	} catch (error) {
		throw terminal("platform-release-grant-inactive", error);
	}
	const capability = findGrantedCapability(grant, PLATFORM_CAPABILITY, PLATFORM_OPERATION);
	if (
		!capability ||
		capability.access !== "write" ||
		capability.operations.length !== 1 ||
		capability.operations[0] !== PLATFORM_OPERATION ||
		effectApprovalPolicyFor(capability, PLATFORM_OPERATION) !== "notify"
	) {
		throw terminal("platform-release-grant-operation-denied");
	}
	if (
		capability.fence.resourcePrefixes?.length !== 1 ||
		capability.fence.resourcePrefixes[0] !== handoff.target.resource
	) {
		throw terminal("platform-release-grant-resource-unfenced");
	}
	if (
		capability.fence.maxPayloadBytes !== undefined &&
		Buffer.byteLength(stableJson(handoff.proposal.arguments)) > capability.fence.maxPayloadBytes
	) {
		throw terminal("platform-release-grant-payload-denied");
	}
	if (capability.quota.maxConcurrent !== 1) {
		throw terminal("platform-release-grant-concurrency-unfenced");
	}
	if (handoff.record.approval !== undefined && handoff.record.approval !== null) {
		throw terminal("platform-release-approval-mode-invalid");
	}
	return { grant, digest };
}

export class PlatformReleaseEffectExecutor {
	constructor(private readonly host: PlatformReleaseEffectHost) {}

	async execute(
		handoff: ValidatedPlatformReleaseHandoff,
		grant: VerifiedPlatformReleaseGrant,
	): Promise<PlatformReleaseCompletionV1> {
		const request: PlatformRealizationRequestV1 = {
			schema: PLATFORM_REALIZATION_SCHEMA,
			effectIndex: handoff.record.effect_index,
			proposalDigest: handoff.record.proposal_digest,
			effectiveProposalDigest: proposedEffectDigest(handoff.proposal),
			executionDigest: handoff.record.execution_digest,
			sourceTurnDigest: handoff.record.source_turn_digest!,
			sourceTurn: handoff.sourceTurn,
			trigger: handoff.trigger,
			proposal: handoff.proposal,
			target: handoff.target,
			grant: {
				grantId: handoff.record.grant_id,
				grantDigest: grant.digest,
				authorityOwnerPrincipal: handoff.record.grant_authority_owner_principal,
				authorityGraphId: handoff.record.grant_authority_graph_id,
				allowedOperations: [PLATFORM_OPERATION],
				approvalMode: "notify",
			},
			runId: handoff.record.run_id,
		};
		const result = await this.host.materialize(request);
		validateMaterializationResponse(result, request, handoff.record.idempotency_key);
		return {
			schema: PLATFORM_RELEASE_COMPLETION_SCHEMA,
			idempotencyKey: handoff.record.idempotency_key,
			ownerPrincipal: handoff.target.ownerPrincipal,
			resource: handoff.target.resource,
			planDigest: handoff.target.planDigest,
			sourceRevision: handoff.target.sourceRevision,
			created: result.created,
			receipt: result.receipt,
		};
	}
}

export class PlatformReleaseEffectWorker {
	private timer: ReturnType<typeof setInterval> | undefined;
	private active: Promise<boolean> | undefined;
	private closed = false;

	constructor(
		private readonly runtime: WorkflowRuntimeStore,
		private readonly host: PlatformReleaseEffectHost,
		private readonly executor = new PlatformReleaseEffectExecutor(host),
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
		this.timer = setInterval(
			() => this.schedule(),
			positiveInteger(this.options.pollMs ?? 1_000, "platform release effect poll interval"),
		);
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
		const consumer = this.options.consumer ?? "choreograph-platform-release-edge";
		const record = await this.runtime.claimEffectHandoff({
			consumer,
			capabilities: [PLATFORM_CAPABILITY],
			leaseMs: positiveInteger(this.options.leaseMs ?? 600_000, "platform release effect lease"),
			now,
		});
		if (!record) return false;
		try {
			const handoff = validatePlatformReleaseHandoff(record);
			const grant = await verifyCurrentPlatformReleaseGrant(this.host, handoff, this.options.now?.() ?? Date.now());
			const completion = await this.executor.execute(handoff, grant);
			if (["launching", "queued", "running"].includes(completion.receipt.state)) {
				throw retryable(`platform-realization-${completion.receipt.state}`);
			}
			if (completion.receipt.state === "failed") {
				throw terminal(completion.receipt.failureCode || "platform-realization-failed");
			}
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
				error instanceof PlatformReleaseEffectError ? error : retryable("platform-release-host-failure", error);
			try {
				await this.runtime.completeEffectHandoff({
					idempotencyKey: record.idempotency_key,
					consumer,
					claimToken: requiredClaimToken(record),
					outcome: failure.retryable ? "failed-retryable" : "failed-terminal",
					completion: { schema: PLATFORM_RELEASE_COMPLETION_SCHEMA, code: failure.code },
					...(failure.retryable ? { retryAfterMs: retryDelay(record.attempt) } : {}),
					now: this.options.now?.() ?? Date.now(),
				});
			} catch (completionError) {
				this.options.log?.("platform release effect completion could not be persisted", completionError);
			}
		}
		return true;
	}

	private schedule(): void {
		if (this.closed || this.active) return;
		this.active = this.runOnce()
			.catch((error) => {
				this.options.log?.("platform release effect poll failed", error);
				return false;
			})
			.finally(() => {
				this.active = undefined;
			});
	}
}

function validateMaterializationResponse(
	result: PlatformRealizationResponseV1,
	request: PlatformRealizationRequestV1,
	idempotencyKey: string,
): void {
	if (!result || typeof result.created !== "boolean" || !result.receipt) {
		throw terminal("platform-realization-response-invalid");
	}
	const receipt = result.receipt;
	if (
		receipt.schema !== PLATFORM_REALIZATION_RECEIPT_SCHEMA ||
		!RECEIPT_ID.test(receipt.receiptId) ||
		receipt.requestDigest !== canonicalDigest(request) ||
		receipt.effectIdempotencyKey !== idempotencyKey ||
		receipt.sourceTurnId !== request.sourceTurn.turnId ||
		receipt.ownerPrincipal !== request.target.ownerPrincipal ||
		receipt.resource !== request.target.resource ||
		receipt.planDigest !== request.target.planDigest ||
		receipt.sourceRevision !== request.target.sourceRevision ||
		receipt.confirmation !== request.target.confirmation ||
		!(REALIZATION_STATES as readonly string[]).includes(receipt.state) ||
		typeof receipt.planRef !== "string" ||
		!receipt.planRef.startsWith("s3://") ||
		!Number.isSafeInteger(receipt.observedAtMs) ||
		receipt.observedAtMs < 0 ||
		(receipt.buildId !== undefined && (typeof receipt.buildId !== "string" || !receipt.buildId)) ||
		(receipt.resultRef !== undefined && (typeof receipt.resultRef !== "string" || !receipt.resultRef)) ||
		(receipt.applyReceiptDigest !== undefined && !PREFIXED_SHA256.test(receipt.applyReceiptDigest)) ||
		(receipt.terraformPlanRef !== undefined && !receipt.terraformPlanRef.startsWith("s3://")) ||
		(receipt.terraformPlanDigest !== undefined && !PREFIXED_SHA256.test(receipt.terraformPlanDigest)) ||
		(receipt.failureCode !== undefined && (typeof receipt.failureCode !== "string" || !receipt.failureCode))
	) {
		throw terminal("platform-realization-witness-mismatch");
	}
	if (receipt.state === "succeeded" && (!receipt.resultRef || !receipt.applyReceiptDigest)) {
		throw terminal("platform-realization-success-proof-missing");
	}
	if (receipt.deploymentReceiptRef !== undefined) {
		try {
			validateMeaningfulObjectRef(receipt.deploymentReceiptRef, "deployment-receipt");
		} catch (error) {
			throw terminal("platform-realization-deployment-receipt-ref-invalid", error);
		}
		if (
			receipt.deploymentReceiptRef.ownerPrincipal !== request.target.ownerPrincipal ||
			receipt.deploymentReceiptRef.graphId !== request.sourceTurn.target.graphId ||
			receipt.deploymentReceiptRef.digest !== receipt.applyReceiptDigest
		) {
			throw terminal("platform-realization-deployment-receipt-ref-invalid");
		}
	}
	if (receipt.state === "succeeded" && !receipt.deploymentReceiptRef) {
		throw terminal("platform-realization-deployment-receipt-ref-missing");
	}
	if (receipt.state !== "succeeded" && receipt.deploymentReceiptRef !== undefined) {
		throw terminal("platform-realization-deployment-receipt-ref-unexpected");
	}
	if (
		receipt.state === "succeeded" &&
		request.target.resource === "canary/choreograph" &&
		(!receipt.terraformPlanRef || !receipt.terraformPlanDigest)
	) {
		throw terminal("platform-realization-terraform-proof-missing");
	}
	if (
		request.target.resource !== "canary/choreograph" &&
		(receipt.terraformPlanRef !== undefined || receipt.terraformPlanDigest !== undefined)
	) {
		throw terminal("platform-realization-terraform-proof-unexpected");
	}
	if (receipt.state === "failed" && !receipt.failureCode) {
		throw terminal("platform-realization-failure-proof-missing");
	}
}

function requiredClaimToken(record: EffectHandoffRecord): string {
	if (!record.claim_token) throw new Error("platform release effect lease has no claim token");
	return record.claim_token;
}

function retryDelay(attempt: number): number {
	return Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(attempt, 0), 6));
}

function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
	return value;
}

function terminal(code: string, cause?: unknown): PlatformReleaseEffectError {
	return new PlatformReleaseEffectError(code, false, cause instanceof Error ? `${code}: ${cause.message}` : code);
}

function retryable(code: string, cause?: unknown): PlatformReleaseEffectError {
	return new PlatformReleaseEffectError(code, true, cause instanceof Error ? `${code}: ${cause.message}` : code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

export { retryable as platformReleaseRetryable, terminal as platformReleaseTerminal };
