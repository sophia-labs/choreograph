import { createHash } from "node:crypto";
import { type MeaningfulObjectRefV1, validateMeaningfulObjectRef } from "../agent-runtime/meaningful-object.js";
import { isCanonicalGraphOwnerPrincipal } from "../graph-owner-principal.js";
import {
	type AgentToolGrantV1,
	assertGrantActive,
	effectApprovalPolicyFor,
	findGrantedCapability,
	type GrantedCapabilityV1,
} from "./agent-tool-grant.js";
import { stableJson } from "./agent-tool-manifest.js";
import { type ChoreographReleaseArtifactV1, validChoreographReleaseArtifact } from "./choreograph-release-artifact.js";
import {
	type DomainSourceTurnV1,
	domainSourceTurnDigest,
	domainTriggerDigest,
	parseDomainSourceTurn,
} from "./domain-source-turn.js";
import { executeDomainVerdictEffect, isDomainVerdictEffect } from "./domain-verdict-effect.js";
import type { GraphWriter } from "./graph-writer.js";
import { EffectHandoffConflictError, type EffectHandoffRecord, type WorkflowRuntimeStore } from "./runtime-store.js";

export const PROPOSED_EFFECT_SCHEMA = "sophia.proposed-effect.v1" as const;
export const EFFECT_RECEIPT_SCHEMA = "sophia.effect-receipt.v1" as const;

export interface ProposedEffectV1 {
	readonly schema: typeof PROPOSED_EFFECT_SCHEMA;
	readonly effectId: string;
	readonly idempotencyKey: string;
	readonly capability: string;
	readonly operation: string;
	readonly arguments: Readonly<Record<string, unknown>>;
	readonly reason: string;
	readonly evidenceRefs: readonly string[];
	readonly estimatedCostMicrousd?: number;
}

export interface EffectApprovalV1 {
	readonly effectId: string;
	readonly grantId: string;
	readonly proposalDigest: string;
	readonly approvedBy: string;
	readonly approvedAt: number;
}

export type EffectReceiptOutcome = "executed" | "handed-off" | "denied" | "pending-approval" | "duplicate" | "error";

export interface EffectReceiptV1 {
	readonly schema: typeof EFFECT_RECEIPT_SCHEMA;
	readonly receiptId: string;
	readonly proposalDigest: string;
	readonly executionDigest: string;
	readonly effectId: string;
	readonly proposedIdempotencyKey: string;
	/** Host-derived authority key; the sandbox proposal cannot select it. */
	readonly idempotencyKey: string;
	readonly capability: string;
	readonly operation: string;
	readonly grantId: string;
	readonly runId: string;
	readonly sourceTurnId: string;
	readonly outcome: EffectReceiptOutcome;
	readonly decisionCode: string;
	readonly decidedAt: number;
	readonly approvedBy?: string;
	readonly notificationRequired?: boolean;
	readonly resultDigest?: string;
	readonly error?: string;
}

export interface EffectExecutionContext {
	readonly runId: string;
	readonly graphId: string;
	readonly agentId: string;
	readonly actorRef: string;
	readonly sourceTurn: DomainSourceTurnV1;
	readonly grant: AgentToolGrantV1;
	readonly grantDocumentId?: string;
	readonly grantAuthorityOwnerPrincipal?: string;
	readonly definitionDigest?: string;
	readonly trigger?: Readonly<Record<string, unknown>>;
	readonly approvals?: readonly EffectApprovalV1[];
	readonly usage?: {
		readonly perDayByCapability?: ReadonlyMap<string, number>;
		readonly concurrentByCapability?: ReadonlyMap<string, number>;
		readonly costMicrousdByCapability?: ReadonlyMap<string, number>;
	};
	readonly now?: () => number;
}

export interface ProposedEffectExecutor {
	/** External credential-bearing adapters receive durable handoffs. */
	executionMode?(effect: ProposedEffectV1): "inline" | "handoff";
	execute(effect: ProposedEffectV1, context: EffectExecutionContext): Promise<unknown>;
}

export interface EffectHandoffStore {
	offer(input: {
		proposal: ProposedEffectV1;
		proposalDigest: string;
		executionDigest: string;
		idempotencyKey: string;
		effectIndex: number;
		context: EffectExecutionContext;
		approval?: EffectApprovalV1;
		now: number;
	}): Promise<{ created: boolean; record: EffectHandoffRecord }>;
}

export interface EffectIdempotencyStore {
	claim(input: {
		idempotencyKey: string;
		executionDigest: string;
		runId: string;
		now: number;
	}): Promise<{ claimed: true } | { claimed: false; receipt?: EffectReceiptV1 }>;
	complete(receipt: EffectReceiptV1): Promise<void>;
}

export class InMemoryEffectIdempotencyStore implements EffectIdempotencyStore {
	private readonly claims = new Map<string, { executionDigest: string; receipt?: EffectReceiptV1 }>();

	async claim(input: {
		idempotencyKey: string;
		executionDigest: string;
		runId: string;
		now: number;
	}): Promise<{ claimed: true } | { claimed: false; receipt?: EffectReceiptV1 }> {
		const existing = this.claims.get(input.idempotencyKey);
		if (existing) {
			if (existing.executionDigest !== input.executionDigest) {
				throw new Error(`idempotency key '${input.idempotencyKey}' was reused with different content`);
			}
			return { claimed: false, receipt: existing.receipt };
		}
		this.claims.set(input.idempotencyKey, { executionDigest: input.executionDigest });
		return { claimed: true };
	}

	async complete(receipt: EffectReceiptV1): Promise<void> {
		this.claims.set(receipt.idempotencyKey, { executionDigest: receipt.executionDigest, receipt });
	}
}

/** Durable adapter over Choreograph's serialized libSQL runtime store. */
export class RuntimeEffectIdempotencyStore implements EffectIdempotencyStore {
	constructor(private readonly runtime: WorkflowRuntimeStore) {}

	async claim(input: {
		idempotencyKey: string;
		executionDigest: string;
		runId: string;
		now: number;
	}): Promise<{ claimed: true } | { claimed: false; receipt?: EffectReceiptV1 }> {
		const result = await this.runtime.claimEffectIdempotency({
			idempotencyKey: input.idempotencyKey,
			proposalDigest: input.executionDigest,
			runId: input.runId,
			now: input.now,
		});
		if (result.claimed) return result;
		if (result.record.proposal_digest !== input.executionDigest) {
			throw new Error(`idempotency key '${input.idempotencyKey}' was reused with different content`);
		}
		return {
			claimed: false,
			receipt: isEffectReceipt(result.record.receipt) ? result.record.receipt : undefined,
		};
	}

	async complete(receipt: EffectReceiptV1): Promise<void> {
		await this.runtime.completeEffectIdempotency({
			idempotencyKey: receipt.idempotencyKey,
			proposalDigest: receipt.executionDigest,
			receipt,
			now: receipt.decidedAt,
		});
	}
}

/** Durable queue adapter for a credential-bearing host edge such as Phanes. */
export class RuntimeEffectHandoffStore implements EffectHandoffStore {
	constructor(private readonly runtime: WorkflowRuntimeStore) {}

	async offer(input: {
		proposal: ProposedEffectV1;
		proposalDigest: string;
		executionDigest: string;
		idempotencyKey: string;
		effectIndex: number;
		context: EffectExecutionContext;
		approval?: EffectApprovalV1;
		now: number;
	}): Promise<{ created: boolean; record: EffectHandoffRecord }> {
		if (
			!input.context.grantDocumentId ||
			!input.context.grantAuthorityOwnerPrincipal ||
			!input.context.definitionDigest
		) {
			throw new Error("external effect handoff requires a complete host grant witness");
		}
		return this.runtime.offerEffectHandoff({
			idempotencyKey: input.idempotencyKey,
			executionDigest: input.executionDigest,
			proposalDigest: input.proposalDigest,
			runId: input.context.runId,
			graphId: input.context.graphId,
			agentId: input.context.agentId,
			actorRef: input.context.actorRef,
			grantId: input.context.grant.grantId,
			grantDocumentId: input.context.grantDocumentId,
			grantAuthorityGraphId: input.context.grant.authorityGraphId,
			grantAuthorityOwnerPrincipal: input.context.grantAuthorityOwnerPrincipal,
			grantDigest: createHash("sha256").update(stableJson(input.context.grant)).digest("hex"),
			definitionDigest: input.context.definitionDigest,
			sourceTurnId: input.context.sourceTurn.turnId,
			sourceTurnDigest: domainSourceTurnDigest(input.context.sourceTurn),
			sourceOwnerPrincipal: input.context.sourceTurn.target.ownerPrincipal,
			sourceTurn: input.context.sourceTurn,
			capability: input.proposal.capability,
			operation: input.proposal.operation,
			proposal: input.proposal,
			trigger: input.context.trigger,
			approval: input.approval,
			effectIndex: input.effectIndex,
			now: input.now,
		});
	}
}

export async function executeProposedEffects(input: {
	proposals: readonly unknown[];
	context: EffectExecutionContext;
	executor: ProposedEffectExecutor;
	idempotency: EffectIdempotencyStore;
	handoff?: EffectHandoffStore;
}): Promise<EffectReceiptV1[]> {
	assertCommittedEffectContext(input.context);
	assertGrantActive(input.context.grant, input.context.agentId, input.context.now?.() ?? Date.now());
	const receipts: EffectReceiptV1[] = [];
	const waveCounts = new Map<string, number>();
	for (const [effectIndex, raw] of input.proposals.entries()) {
		const decidedAt = input.context.now?.() ?? Date.now();
		let proposal: ProposedEffectV1;
		try {
			proposal = parseProposedEffect(raw);
		} catch (error) {
			receipts.push(invalidReceipt(raw, input.context, effectIndex, decidedAt, error));
			continue;
		}
		const digest = proposedEffectDigest(proposal);
		const authoritativeKey = authoritativeEffectIdempotencyKey(input.context, effectIndex);
		const capability = findGrantedCapability(input.context.grant, proposal.capability, proposal.operation);
		const decision = capability
			? authorizeProposal(proposal, capability, input.context, waveCounts)
			: { allowed: false as const, code: "operation-not-granted" };
		if (!decision.allowed) {
			const receipt = makeReceipt(
				proposal,
				digest,
				proposedEffectExecutionDigest(proposal),
				authoritativeKey,
				input.context,
				decidedAt,
				"denied",
				decision.code,
			);
			receipts.push(receipt);
			continue;
		}
		let effectiveProposal: ProposedEffectV1;
		try {
			effectiveProposal = bindTrustedEffectAuthority(proposal, input.context, authoritativeKey);
		} catch (error) {
			receipts.push(
				makeReceipt(
					proposal,
					digest,
					proposedEffectExecutionDigest(proposal),
					authoritativeKey,
					input.context,
					decidedAt,
					"denied",
					isDevelopmentCapability(proposal.capability)
						? "trigger-development-target-invalid"
						: proposal.capability === "platform.release"
							? "trigger-platform-release-target-invalid"
							: proposal.capability === "site"
								? "trigger-site-target-invalid"
								: "trigger-target-invalid",
					{ error: errorMessage(error) },
				),
			);
			continue;
		}
		const executionDigest = proposedEffectExecutionDigest(effectiveProposal);
		if (decision.pending) {
			const receipt = makeReceipt(
				proposal,
				digest,
				executionDigest,
				authoritativeKey,
				input.context,
				decidedAt,
				"pending-approval",
				"human-approval-required",
			);
			receipts.push(receipt);
			continue;
		}
		if (input.executor.executionMode?.(effectiveProposal) === "handoff") {
			if (!input.handoff) {
				receipts.push(
					makeReceipt(
						proposal,
						digest,
						executionDigest,
						authoritativeKey,
						input.context,
						decidedAt,
						"error",
						"host-handoff-unavailable",
					),
				);
				continue;
			}
			try {
				const offered = await input.handoff.offer({
					proposal: effectiveProposal,
					proposalDigest: digest,
					executionDigest,
					idempotencyKey: authoritativeKey,
					effectIndex,
					context: input.context,
					approval: decision.approval,
					now: decidedAt,
				});
				const terminal = offered.record.state === "executed" || offered.record.state === "failed-terminal";
				const outcome: EffectReceiptOutcome =
					offered.record.state === "executed"
						? "duplicate"
						: offered.record.state === "failed-terminal"
							? "error"
							: "handed-off";
				receipts.push(
					makeReceipt(
						proposal,
						digest,
						executionDigest,
						authoritativeKey,
						input.context,
						decidedAt,
						outcome,
						offered.created
							? "host-handoff-ready"
							: terminal
								? `host-handoff-${offered.record.state}`
								: "host-handoff-replay",
						{
							approvedBy: decision.approval?.approvedBy,
							notificationRequired: effectApprovalPolicyFor(capability, proposal.operation) === "notify",
							resultDigest: digestResult(
								offered.record.completion ?? {
									idempotencyKey: offered.record.idempotency_key,
									state: offered.record.state,
								},
							),
						},
					),
				);
			} catch (error) {
				const conflict = error instanceof EffectHandoffConflictError;
				receipts.push(
					makeReceipt(
						proposal,
						digest,
						executionDigest,
						authoritativeKey,
						input.context,
						decidedAt,
						conflict ? "denied" : "error",
						conflict ? "idempotency-conflict" : "host-handoff-error",
						{ error: errorMessage(error) },
					),
				);
			}
			continue;
		}

		// Claim only an effect that is authorized to execute now. A denied or
		// pending proposal must remain replayable after its grant/approval changes.
		let claimed: Awaited<ReturnType<EffectIdempotencyStore["claim"]>>;
		try {
			claimed = await input.idempotency.claim({
				idempotencyKey: authoritativeKey,
				executionDigest,
				runId: input.context.runId,
				now: decidedAt,
			});
		} catch (error) {
			const receipt = makeReceipt(
				proposal,
				digest,
				executionDigest,
				authoritativeKey,
				input.context,
				decidedAt,
				"denied",
				"idempotency-conflict",
				{ error: errorMessage(error) },
			);
			receipts.push(receipt);
			continue;
		}
		if (!claimed.claimed) {
			const receipt = makeReceipt(
				proposal,
				digest,
				executionDigest,
				authoritativeKey,
				input.context,
				decidedAt,
				"duplicate",
				"idempotent-replay",
				{ resultDigest: claimed.receipt?.resultDigest },
			);
			receipts.push(receipt);
			continue;
		}

		try {
			const result = await input.executor.execute(effectiveProposal, input.context);
			const approvalPolicy = effectApprovalPolicyFor(capability, proposal.operation);
			const receipt = makeReceipt(
				proposal,
				digest,
				executionDigest,
				authoritativeKey,
				input.context,
				decidedAt,
				"executed",
				decision.code,
				{
					approvedBy: decision.approval?.approvedBy,
					notificationRequired: approvalPolicy === "notify",
					resultDigest: digestResult(result),
				},
			);
			await input.idempotency.complete(receipt);
			receipts.push(receipt);
		} catch (error) {
			const receipt = makeReceipt(
				proposal,
				digest,
				executionDigest,
				authoritativeKey,
				input.context,
				decidedAt,
				"error",
				"host-execution-error",
				{
					error: errorMessage(error),
				},
			);
			await input.idempotency.complete(receipt);
			receipts.push(receipt);
		}
	}
	return receipts;
}

export function parseProposedEffect(value: unknown): ProposedEffectV1 {
	if (!isRecord(value) || value.schema !== PROPOSED_EFFECT_SCHEMA)
		throw new Error(`expected '${PROPOSED_EFFECT_SCHEMA}'`);
	for (const field of ["effectId", "idempotencyKey", "capability", "operation", "reason"] as const) {
		if (!text(value[field])) throw new Error(`${field} must be a non-empty string`);
	}
	if (!isRecord(value.arguments)) throw new Error("arguments must be an object");
	if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.some((ref) => !text(ref))) {
		throw new Error("evidenceRefs must be strings");
	}
	if (
		value.estimatedCostMicrousd !== undefined &&
		(!Number.isSafeInteger(value.estimatedCostMicrousd) || value.estimatedCostMicrousd < 0)
	) {
		throw new Error("estimatedCostMicrousd must be a non-negative integer");
	}
	return value as unknown as ProposedEffectV1;
}

export function proposedEffectDigest(effect: ProposedEffectV1): string {
	return createHash("sha256").update(stableJson(effect)).digest("hex");
}

export function proposedEffectExecutionDigest(effect: ProposedEffectV1): string {
	return createHash("sha256")
		.update(
			stableJson({
				schema: effect.schema,
				capability: effect.capability,
				operation: effect.operation,
				arguments: effect.arguments,
			}),
		)
		.digest("hex");
}

export function authoritativeEffectIdempotencyKey(context: EffectExecutionContext, effectIndex: number): string {
	if (
		context.sourceTurn.target.graphId !== context.graphId ||
		context.sourceTurn.agentId !== context.agentId ||
		context.sourceTurn.actorRef !== context.actorRef
	) {
		throw new Error("effect context differs from its committed source turn");
	}
	const seed = {
		sourceTurnId: context.sourceTurn.turnId,
		effectIndex,
	};
	return `effect:${createHash("sha256").update(stableJson(seed)).digest("hex")}`;
}

export class GraphProposedEffectExecutor implements ProposedEffectExecutor {
	constructor(private readonly graph: GraphWriter) {}

	executionMode(effect: ProposedEffectV1): "inline" | "handoff" {
		return effect.capability === "mnemosyne" || effect.capability === "garden-mcp" || isDomainVerdictEffect(effect)
			? "inline"
			: "handoff";
	}

	async execute(effect: ProposedEffectV1, context: EffectExecutionContext): Promise<unknown> {
		if (isDomainVerdictEffect(effect)) return executeDomainVerdictEffect(effect, context, this.graph);
		const graphId = argumentText(effect.arguments, ["graphId", "graph_id"]) ?? context.graphId;
		if (effect.capability !== "mnemosyne" && effect.capability !== "garden-mcp") {
			throw new Error(`unsupported graph effect capability '${effect.capability}'`);
		}
		if (effect.operation === "sparql_update" || effect.operation === "sparql.update") {
			const update = argumentText(effect.arguments, ["update", "sparql"]);
			if (!update) throw new Error("sparql update effect requires arguments.update");
			await this.graph.sparqlUpdate(graphId, update);
			return { graphId, operation: "sparql_update" };
		}
		if (effect.operation === "write_document" || effect.operation === "document.write") {
			const documentId = argumentText(effect.arguments, ["documentId", "document_id"]);
			const content = argumentText(effect.arguments, ["content"]);
			if (!documentId || content === undefined) throw new Error("document write requires documentId and content");
			// A proposal may say how its content reads (plain text stays plain); otherwise the cell detects it.
			const format = argumentText(effect.arguments, ["format"]);
			return this.graph.writeDocument(
				graphId,
				documentId,
				content,
				format === "markdown" || format === "plain" ? { format } : undefined,
			);
		}
		throw new Error(`unsupported graph effect operation '${effect.operation}'`);
	}
}

function authorizeProposal(
	proposal: ProposedEffectV1,
	capability: GrantedCapabilityV1,
	context: EffectExecutionContext,
	waveCounts: Map<string, number>,
): { allowed: boolean; code: string; pending?: boolean; approval?: EffectApprovalV1 } {
	const fenceFailure = checkFence(proposal, capability, context);
	if (fenceFailure) return { allowed: false, code: fenceFailure };
	const nextCount = (waveCounts.get(capability.capability) ?? 0) + 1;
	if (capability.quota.maxPerWave !== undefined && nextCount > capability.quota.maxPerWave) {
		return { allowed: false, code: "wave-quota-exceeded" };
	}
	const dayCount = context.usage?.perDayByCapability?.get(capability.capability) ?? 0;
	if (capability.quota.maxPerDay !== undefined && dayCount + nextCount > capability.quota.maxPerDay) {
		return { allowed: false, code: "daily-quota-exceeded" };
	}
	const concurrent = context.usage?.concurrentByCapability?.get(capability.capability) ?? 0;
	if (capability.quota.maxConcurrent !== undefined && concurrent >= capability.quota.maxConcurrent) {
		return { allowed: false, code: "concurrency-quota-exceeded" };
	}
	if (capability.quota.maxCostMicrousd !== undefined) {
		if (proposal.estimatedCostMicrousd === undefined) return { allowed: false, code: "cost-estimate-required" };
		const priorCost = context.usage?.costMicrousdByCapability?.get(capability.capability) ?? 0;
		if (priorCost + proposal.estimatedCostMicrousd > capability.quota.maxCostMicrousd) {
			return { allowed: false, code: "cost-quota-exceeded" };
		}
	}
	waveCounts.set(capability.capability, nextCount);
	const approvalPolicy = effectApprovalPolicyFor(capability, proposal.operation);
	if (approvalPolicy !== "human-always") return { allowed: true, code: "authorized" };
	const approval = context.approvals?.find(
		(candidate) =>
			candidate.effectId === proposal.effectId &&
			candidate.grantId === context.grant.grantId &&
			candidate.proposalDigest === proposedEffectDigest(proposal),
	);
	return approval
		? { allowed: true, code: "human-approved", approval }
		: { allowed: true, code: "human-approval-required", pending: true };
}

function checkFence(
	proposal: ProposedEffectV1,
	capability: GrantedCapabilityV1,
	context: EffectExecutionContext,
): string | undefined {
	const fence = capability.fence;
	let siteTarget: CommittedSiteTarget | undefined;
	let developmentTarget: CommittedDevelopmentTarget | undefined;
	let platformReleaseTarget: CommittedPlatformReleaseTarget | undefined;
	if (proposal.capability === "site") {
		try {
			siteTarget = requireCommittedSiteTarget(context);
		} catch {
			return "trigger-site-target-invalid";
		}
	}
	if (isDevelopmentCapability(proposal.capability)) {
		try {
			developmentTarget = requireCommittedDevelopmentTarget(context);
		} catch {
			return "trigger-development-target-invalid";
		}
	}
	if (proposal.capability === "platform.release") {
		try {
			platformReleaseTarget = requireCommittedPlatformReleaseTarget(context);
		} catch {
			return "trigger-platform-release-target-invalid";
		}
	}
	const graphId =
		siteTarget?.graphId ??
		(proposal.capability === "cell.scratch" ? developmentTarget?.scratchGraphId : undefined) ??
		argumentText(proposal.arguments, ["graphId", "graph_id"]) ??
		context.graphId;
	if (
		fence.graphIds?.length &&
		!fence.graphIds.includes(graphId) &&
		!fence.graphIdPrefixes?.some((prefix) => graphId.startsWith(prefix))
	) {
		return "graph-fence-denied";
	}
	if (fence.graphIdPrefixes?.length && !fence.graphIds?.includes(graphId)) {
		if (!fence.graphIdPrefixes.some((prefix) => graphId.startsWith(prefix))) return "graph-fence-denied";
	}
	let developmentPathsChecked = false;
	let developmentResourceChecked = false;
	if (developmentTarget && fence.resourcePrefixes?.length) {
		if (!fence.resourcePrefixes.some((prefix) => repositoryFenceAllows(prefix, developmentTarget.repository))) {
			return "resource-fence-denied";
		}
		developmentResourceChecked = true;
	}
	if (
		developmentTarget &&
		fence.pathPrefixes?.length &&
		proposal.capability === "github" &&
		proposal.operation === "branch.push"
	) {
		const paths = proposedChangePaths(proposal.arguments);
		if (!paths?.length || paths.some((path) => !fence.pathPrefixes!.some((prefix) => path.startsWith(prefix)))) {
			return "path-fence-denied";
		}
		developmentPathsChecked = true;
	}
	for (const [fields, prefixes, code] of [
		[["url", "origin"], fence.originPrefixes, "origin-fence-denied"],
		[["branch", "branchName"], fence.branchPrefixes, "branch-fence-denied"],
		[["resourceId", "resource", "name"], fence.resourcePrefixes, "resource-fence-denied"],
		[["path"], fence.pathPrefixes, "path-fence-denied"],
	] as const) {
		if (!prefixes?.length) continue;
		if (code === "path-fence-denied" && developmentPathsChecked) continue;
		if (code === "path-fence-denied" && developmentTarget && proposal.capability === "github") continue;
		if (code === "resource-fence-denied" && developmentResourceChecked) continue;
		const value = siteTarget
			? code === "resource-fence-denied"
				? siteTarget.publicName
				: code === "path-fence-denied"
					? siteTarget.pathPrefix
					: argumentText(proposal.arguments, fields)
			: platformReleaseTarget && code === "resource-fence-denied"
				? platformReleaseTarget.resource
				: developmentTarget && code === "resource-fence-denied"
					? developmentTarget.repository
					: developmentTarget && code === "branch-fence-denied"
						? developmentTarget.branchName
						: code === "resource-fence-denied" &&
								(proposal.capability === "discord" || proposal.capability === "audio")
							? argumentText(context.trigger ?? {}, ["resource"])
							: argumentText(proposal.arguments, fields);
		if (!value || !prefixes.some((prefix) => value.startsWith(prefix))) return code;
	}
	const triggerTargetFailure = checkTriggerTarget(proposal, context.trigger);
	if (triggerTargetFailure) return triggerTargetFailure;
	if (
		fence.maxPayloadBytes !== undefined &&
		Buffer.byteLength(stableJson(proposal.arguments)) > fence.maxPayloadBytes
	) {
		return "payload-fence-denied";
	}
	if (proposal.capability === "cell.scratch" && proposal.operation === "cell.launch") {
		if (
			developmentTarget?.ttlHours === undefined ||
			fence.maxTtlHours === undefined ||
			developmentTarget.ttlHours > fence.maxTtlHours
		) {
			return "ttl-fence-denied";
		}
	}
	return undefined;
}

function makeReceipt(
	proposal: ProposedEffectV1,
	proposalDigest: string,
	executionDigest: string,
	authoritativeIdempotencyKey: string,
	context: EffectExecutionContext,
	decidedAt: number,
	outcome: EffectReceiptOutcome,
	decisionCode: string,
	extra: Pick<EffectReceiptV1, "approvedBy" | "notificationRequired" | "resultDigest" | "error"> = {},
): EffectReceiptV1 {
	const seed = { proposalDigest, runId: context.runId, outcome, decisionCode, grantId: context.grant.grantId };
	return {
		schema: EFFECT_RECEIPT_SCHEMA,
		receiptId: `efr_${createHash("sha256").update(stableJson(seed)).digest("hex").slice(0, 24)}`,
		proposalDigest,
		executionDigest,
		effectId: proposal.effectId,
		proposedIdempotencyKey: proposal.idempotencyKey,
		idempotencyKey: authoritativeIdempotencyKey,
		capability: proposal.capability,
		operation: proposal.operation,
		grantId: context.grant.grantId,
		runId: context.runId,
		sourceTurnId: context.sourceTurn.turnId,
		outcome,
		decisionCode,
		decidedAt,
		...extra,
	};
}

function invalidReceipt(
	value: unknown,
	context: EffectExecutionContext,
	effectIndex: number,
	decidedAt: number,
	error: unknown,
): EffectReceiptV1 {
	const candidate = isRecord(value) ? value : {};
	const proposal: ProposedEffectV1 = {
		schema: PROPOSED_EFFECT_SCHEMA,
		effectId: text(candidate.effectId) ? candidate.effectId : "invalid-effect",
		idempotencyKey: text(candidate.idempotencyKey) ? candidate.idempotencyKey : `invalid:${context.runId}`,
		capability: text(candidate.capability) ? candidate.capability : "invalid",
		operation: text(candidate.operation) ? candidate.operation : "invalid",
		arguments: {},
		reason: "invalid proposal",
		evidenceRefs: [],
	};
	const proposalDigest = proposedEffectDigest(proposal);
	const executionDigest = proposedEffectExecutionDigest(proposal);
	return makeReceipt(
		proposal,
		proposalDigest,
		executionDigest,
		authoritativeEffectIdempotencyKey(context, effectIndex),
		context,
		decidedAt,
		"denied",
		"proposal-invalid",
		{ error: errorMessage(error) },
	);
}

/**
 * Replace sandbox-selected transport coordinates with the trusted source turn.
 * Validation still rejects an explicitly conflicting proposal so the receipt
 * records an attempted escape instead of silently rewriting it.
 */
function bindTrustedEffectAuthority(
	proposal: ProposedEffectV1,
	context: EffectExecutionContext,
	authoritativeIdempotencyKey: string,
): ProposedEffectV1 {
	if (proposal.capability === "site") {
		const target = requireCommittedSiteTarget(context);
		return {
			...proposal,
			idempotencyKey: authoritativeIdempotencyKey,
			arguments: {
				...proposal.arguments,
				ownerPrincipal: target.ownerPrincipal,
				graphId: target.graphId,
				publicName: target.publicName,
				pathPrefix: target.pathPrefix,
			},
		};
	}
	if (isDevelopmentCapability(proposal.capability)) {
		const target = requireCommittedDevelopmentTarget(context);
		const arguments_: Record<string, unknown> = {
			...proposal.arguments,
			ownerPrincipal: target.ownerPrincipal,
			repository: target.repository,
			sourceRevision: target.sourceRevision,
			baseBranch: target.baseBranch,
			branchName: target.branchName,
			scratchGraphId: target.scratchGraphId,
			scenarioDigest: target.scenarioDigest,
			resource: target.repository,
		};
		if (target.imageDigest) arguments_.imageDigest = target.imageDigest;
		if (target.seedDigest) arguments_.seedDigest = target.seedDigest;
		if (target.ttlHours !== undefined) arguments_.ttlHours = target.ttlHours;
		if (target.builderRecipeId) arguments_.builderRecipeId = target.builderRecipeId;
		if (target.builderRecipeDigest) arguments_.builderRecipeDigest = target.builderRecipeDigest;
		if (target.buildPlanDigest) arguments_.buildPlanDigest = target.buildPlanDigest;
		if (target.buildContextDigest) arguments_.buildContextDigest = target.buildContextDigest;
		if (target.buildContextBytes !== undefined) arguments_.buildContextBytes = target.buildContextBytes;
		if (target.pullNumber !== undefined) arguments_.pullNumber = target.pullNumber;
		if (target.expectedHeadSha) arguments_.expectedHeadSha = target.expectedHeadSha;
		if (proposal.capability === "cell.scratch") {
			arguments_.graphId = target.scratchGraphId;
		}
		if (proposal.capability === "github") {
			arguments_.branch = target.branchName;
			if (proposal.operation === "branch.push") arguments_.baseSha = target.sourceRevision;
			if (proposal.operation === "pr.open") {
				arguments_.head = target.branchName;
				arguments_.base = target.baseBranch;
			}
		}
		return { ...proposal, idempotencyKey: authoritativeIdempotencyKey, arguments: arguments_ };
	}
	if (proposal.capability === "platform.release") {
		const target = requireCommittedPlatformReleaseTarget(context);
		return {
			...proposal,
			idempotencyKey: authoritativeIdempotencyKey,
			arguments: {
				resource: target.resource,
				planDigest: target.planDigest,
				sourceRevision: target.sourceRevision,
				confirmation: target.confirmation,
			},
		};
	}
	if (proposal.capability === "audio") {
		const trigger = context.trigger ?? {};
		const resource = argumentText(trigger, ["resource"]);
		const channelId = argumentText(trigger, ["channelId", "channel_id"]);
		return {
			...proposal,
			idempotencyKey: authoritativeIdempotencyKey,
			arguments: {
				...proposal.arguments,
				...(resource ? { resource } : {}),
				...(channelId ? { channelId } : {}),
			},
		};
	}
	if (proposal.capability !== "discord") {
		return { ...proposal, idempotencyKey: authoritativeIdempotencyKey };
	}
	const trigger = context.trigger ?? {};
	const resource = argumentText(trigger, ["resource"]);
	const contextHandle = argumentText(trigger, ["privacyContextHandle", "privacy_context_handle"]);
	const channelHandle = argumentText(trigger, ["channelHandle", "channel_handle"]);
	const messageHandle = argumentText(trigger, ["messageHandle", "message_handle"]);
	const responseHandle = argumentText(trigger, ["responseHandle", "response_handle"]);
	const arguments_: Record<string, unknown> = { ...proposal.arguments };
	if (resource) arguments_.resource = resource;
	if (contextHandle) arguments_.contextHandle = contextHandle;
	if (channelHandle) arguments_.channelHandle = channelHandle;
	if (proposal.capability === "discord" && proposal.operation === "message.reply" && messageHandle) {
		arguments_.replyToMessageHandle = messageHandle;
		if (responseHandle) arguments_.responseHandle = responseHandle;
	}
	if (proposal.capability === "discord" && proposal.operation === "message.react" && messageHandle) {
		arguments_.messageHandle = messageHandle;
	}
	if (proposal.capability === "discord" && proposal.operation === "message.edit" && responseHandle) {
		arguments_.responseHandle = responseHandle;
	}
	return { ...proposal, idempotencyKey: authoritativeIdempotencyKey, arguments: arguments_ };
}

function checkTriggerTarget(
	proposal: ProposedEffectV1,
	trigger: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
	if (proposal.capability === "site") {
		if (!trigger) return "trigger-context-required";
		let target: CommittedSiteTarget;
		try {
			target = parseCommittedSiteTarget(trigger);
		} catch {
			return "trigger-site-target-invalid";
		}
		for (const [names, expected, code] of [
			[["ownerPrincipal", "owner_principal"], target.ownerPrincipal, "trigger-owner-mismatch"],
			[["graphId", "graph_id"], target.graphId, "trigger-graph-mismatch"],
			[["publicName", "public_name", "name"], target.publicName, "trigger-public-name-mismatch"],
			[["pathPrefix", "path_prefix"], target.pathPrefix, "trigger-path-mismatch"],
		] as const) {
			if (argumentConflicts(proposal.arguments, names, expected)) return code;
		}
		return undefined;
	}
	if (isDevelopmentCapability(proposal.capability)) {
		if (!trigger) return "trigger-context-required";
		let target: CommittedDevelopmentTarget;
		try {
			target = parseCommittedDevelopmentTarget(trigger);
		} catch {
			return "trigger-development-target-invalid";
		}
		for (const [names, expected, code] of [
			[["ownerPrincipal", "owner_principal"], target.ownerPrincipal, "trigger-owner-mismatch"],
			[["repository", "resource", "resourceId"], target.repository, "trigger-repository-mismatch"],
			[["sourceRevision", "source_revision", "baseSha"], target.sourceRevision, "trigger-source-revision-mismatch"],
			[["baseBranch", "base_branch", "base"], target.baseBranch, "trigger-base-branch-mismatch"],
			[["branchName", "branch_name", "branch", "head"], target.branchName, "trigger-branch-mismatch"],
			[
				["scratchGraphId", "scratch_graph_id", "graphId", "graph_id"],
				target.scratchGraphId,
				"trigger-graph-mismatch",
			],
			[["scenarioDigest", "scenario_digest"], target.scenarioDigest, "trigger-scenario-mismatch"],
		] as const) {
			if (argumentConflicts(proposal.arguments, names, expected)) return code;
		}
		for (const [names, expected, code] of [
			[
				["builderRecipeId", "builder_recipe_id", "recipeId", "recipe_id"],
				target.builderRecipeId,
				"trigger-build-recipe-id-mismatch",
			],
			[
				["builderRecipeDigest", "builder_recipe_digest", "recipeDigest", "recipe_digest"],
				target.builderRecipeDigest,
				"trigger-build-recipe-mismatch",
			],
			[["buildPlanDigest", "build_plan_digest"], target.buildPlanDigest, "trigger-build-plan-mismatch"],
			[["buildContextDigest", "build_context_digest"], target.buildContextDigest, "trigger-build-context-mismatch"],
			[
				["buildContextBytes", "build_context_bytes"],
				target.buildContextBytes,
				"trigger-build-context-bytes-mismatch",
			],
			[["imageDigest", "image_digest"], target.imageDigest, "trigger-image-mismatch"],
			[["seedDigest", "seed_digest"], target.seedDigest, "trigger-seed-mismatch"],
			[["ttlHours", "ttl_hours"], target.ttlHours, "trigger-ttl-mismatch"],
			[["expectedHeadSha", "expected_head_sha"], target.expectedHeadSha, "trigger-head-mismatch"],
		] as const) {
			if (argumentConflicts(proposal.arguments, names, expected)) return code;
		}
		if (argumentConflicts(proposal.arguments, ["pullNumber", "pull_number"], target.pullNumber)) {
			return "trigger-pr-mismatch";
		}
		if (proposal.capability === "cell.scratch" && proposal.operation === "cell.launch") {
			if (!target.imageDigest || !target.seedDigest) return "trigger-scratch-artifact-missing";
			if (target.ttlHours === undefined) return "trigger-scratch-ttl-missing";
		}
		if (proposal.capability === "build" && proposal.operation === "build.plan") {
			if (!target.builderRecipeId || !target.builderRecipeDigest) return "trigger-build-recipe-missing";
		}
		if (proposal.capability === "build" && proposal.operation === "build.start") {
			if (!target.builderRecipeId || !target.builderRecipeDigest) return "trigger-build-recipe-missing";
			if (!target.buildPlanDigest || !target.buildContextDigest || target.buildContextBytes === undefined) {
				return "trigger-build-plan-missing";
			}
		}
		if (
			proposal.capability === "github" &&
			(proposal.operation === "pr.comment" || proposal.operation === "pr.merge")
		) {
			if (target.pullNumber === undefined) return "trigger-pr-target-missing";
		}
		if (proposal.capability === "github" && proposal.operation === "pr.merge" && !target.expectedHeadSha) {
			return "trigger-head-target-missing";
		}
		return undefined;
	}
	if (proposal.capability === "platform.release") {
		if (!trigger) return "trigger-context-required";
		let target: CommittedPlatformReleaseTarget;
		try {
			target = parseCommittedPlatformReleaseTarget(trigger);
		} catch {
			return "trigger-platform-release-target-invalid";
		}
		for (const [names, expected, code] of [
			[["resource", "resourceId"], target.resource, "trigger-resource-mismatch"],
			[["planDigest", "plan_digest"], target.planDigest, "trigger-plan-digest-mismatch"],
			[["sourceRevision", "source_revision"], target.sourceRevision, "trigger-source-revision-mismatch"],
			[["confirmation"], target.confirmation, "trigger-confirmation-mismatch"],
		] as const) {
			if (argumentConflicts(proposal.arguments, names, expected)) return code;
		}
		if (Object.hasOwn(proposal.arguments, "plan")) return "trigger-plan-smuggling-denied";
		return undefined;
	}
	if (proposal.capability === "audio") {
		if (!trigger) return "trigger-context-required";
		const triggerResource = argumentText(trigger, ["resource"]);
		const proposedResource = argumentText(proposal.arguments, ["resource", "resourceId"]);
		if (proposedResource && proposedResource !== triggerResource) return "trigger-resource-mismatch";
		const triggerChannel = argumentText(trigger, ["channelId", "channel_id"]);
		const proposedChannel = argumentText(proposal.arguments, ["channelId", "channel_id"]);
		if (proposedChannel && proposedChannel !== triggerChannel) return "trigger-channel-mismatch";
		return undefined;
	}
	if (proposal.capability !== "discord") return undefined;
	if (!trigger) return "trigger-context-required";
	const triggerResource = argumentText(trigger, ["resource"]);
	const proposedResource = argumentText(proposal.arguments, ["resource", "resourceId"]);
	if (proposedResource && proposedResource !== triggerResource) return "trigger-resource-mismatch";
	const triggerContext = argumentText(trigger, ["privacyContextHandle", "privacy_context_handle"]);
	const proposedContext = argumentText(proposal.arguments, ["contextHandle", "context_handle"]);
	if (proposedContext && proposedContext !== triggerContext) return "trigger-context-mismatch";
	const triggerChannel = argumentText(trigger, ["channelHandle", "channel_handle"]);
	const proposedChannel = argumentText(proposal.arguments, ["channelHandle", "channel_handle"]);
	if (proposedChannel && proposedChannel !== triggerChannel) return "trigger-channel-mismatch";
	const triggerMessage = argumentText(trigger, ["messageHandle", "message_handle"]);
	const responseMessage = argumentText(trigger, ["responseHandle", "response_handle"]);
	if (proposal.operation === "message.reply") {
		const replyTarget = argumentText(proposal.arguments, ["replyToMessageHandle", "reply_to_message_handle"]);
		const proposedResponse = argumentText(proposal.arguments, ["responseHandle", "response_handle"]);
		if (
			!triggerMessage ||
			!responseMessage ||
			(replyTarget && replyTarget !== triggerMessage) ||
			(proposedResponse && proposedResponse !== responseMessage)
		) {
			return "trigger-message-mismatch";
		}
	}
	if (proposal.operation === "message.react") {
		const reactionTarget = argumentText(proposal.arguments, ["messageHandle", "message_handle"]);
		if (!triggerMessage || (reactionTarget && reactionTarget !== triggerMessage)) return "trigger-message-mismatch";
	}
	if (proposal.operation === "message.edit") {
		const editTarget = argumentText(proposal.arguments, ["responseHandle", "response_handle"]);
		if (!responseMessage || (editTarget && editTarget !== responseMessage)) return "trigger-message-mismatch";
	}
	return undefined;
}

export interface CommittedSiteTarget {
	readonly ownerPrincipal: string;
	readonly graphId: string;
	readonly publicName: string;
	readonly pathPrefix: string;
}

/**
 * Host-committed coordinates for Development Domain instruments. The pilot may
 * decide what work to attempt; it cannot retarget the repository, branch,
 * scratch graph, scenario, or reviewed artifact after the turn is committed.
 */
export interface CommittedDevelopmentTarget {
	readonly ownerPrincipal: string;
	readonly repository: string;
	readonly sourceRevision: string;
	readonly baseBranch: string;
	readonly branchName: string;
	readonly scratchGraphId: string;
	readonly scenarioDigest: string;
	readonly builderRecipeId?: string;
	readonly builderRecipeDigest?: string;
	readonly buildPlanDigest?: string;
	readonly buildContextDigest?: string;
	readonly buildContextBytes?: number;
	readonly imageDigest?: string;
	readonly seedDigest?: string;
	readonly ttlHours?: number;
	readonly pullNumber?: number;
	readonly expectedHeadSha?: string;
}

/**
 * Host-committed coordinates for the sole cloud-2 platform realization lane.
 * The complete plan is durable trigger testimony; the sandbox receives no
 * authority to edit it or choose a different environment.
 */
export interface CommittedPlatformReleaseTarget {
	readonly ownerPrincipal: string;
	readonly resource: "canary/cloud2-platform" | "canary/choreograph";
	readonly plan: Readonly<Record<string, unknown>>;
	readonly planDigest: `sha256:${string}`;
	readonly planRef?: MeaningfulObjectRefV1<"deployment-plan">;
	readonly confirmation: string;
	readonly sourceRevision: string;
}

const SITE_GRAPH_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SITE_PUBLIC_NAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const BUILD_RECIPE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/;
const PLATFORM_SOURCE_REVISION = /^[0-9a-f]{40}$/;
const PLATFORM_RESOURCES = new Set(["canary/cloud2-platform", "canary/choreograph"]);
const CHOREOGRAPH_TERRAFORM_TARGETS = [
	"aws_launch_template.choreograph[0]",
	"aws_autoscaling_group.choreograph[0]",
] as const;
const MAX_PLATFORM_PLAN_BYTES = 1_048_576;

export function parseCommittedSiteTarget(trigger: Readonly<Record<string, unknown>>): CommittedSiteTarget {
	const raw = trigger.siteTarget ?? trigger.site_target;
	if (!isRecord(raw)) throw new Error("committed trigger has no siteTarget");
	const ownerPrincipal = argumentText(raw, ["ownerPrincipal", "owner_principal"]);
	const graphId = argumentText(raw, ["graphId", "graph_id"]);
	const publicName = argumentText(raw, ["publicName", "public_name", "name"]);
	const pathPrefix = argumentText(raw, ["pathPrefix", "path_prefix"]);
	if (!isCanonicalGraphOwnerPrincipal(ownerPrincipal)) throw new Error("site target owner is invalid");
	if (!graphId || !SITE_GRAPH_ID.test(graphId)) throw new Error("site target graph is invalid");
	if (!publicName || !SITE_PUBLIC_NAME.test(publicName)) throw new Error("site target public name is invalid");
	if (!pathPrefix || !pathPrefix.startsWith("/") || /\s|\.\./.test(pathPrefix)) {
		throw new Error("site target path prefix is invalid");
	}
	return { ownerPrincipal, graphId, publicName, pathPrefix };
}

export function parseCommittedDevelopmentTarget(
	trigger: Readonly<Record<string, unknown>>,
): CommittedDevelopmentTarget {
	const raw = trigger.developmentTarget ?? trigger.development_target;
	if (!isRecord(raw)) throw new Error("committed trigger has no developmentTarget");
	const ownerPrincipal = argumentText(raw, ["ownerPrincipal", "owner_principal"]);
	const repository = argumentText(raw, ["repository"]);
	const sourceRevision = argumentText(raw, ["sourceRevision", "source_revision"]);
	const baseBranch = argumentText(raw, ["baseBranch", "base_branch"]);
	const branchName = argumentText(raw, ["branchName", "branch_name"]);
	const scratchGraphId = argumentText(raw, ["scratchGraphId", "scratch_graph_id"]);
	const scenarioDigest = argumentText(raw, ["scenarioDigest", "scenario_digest"]);
	const builderRecipeId = argumentText(raw, ["builderRecipeId", "builder_recipe_id", "recipeId", "recipe_id"]);
	const builderRecipeDigest = argumentText(raw, [
		"builderRecipeDigest",
		"builder_recipe_digest",
		"recipeDigest",
		"recipe_digest",
	]);
	const buildPlanDigest = argumentText(raw, ["buildPlanDigest", "build_plan_digest"]);
	const buildContextDigest = argumentText(raw, ["buildContextDigest", "build_context_digest"]);
	const buildContextBytes = argumentPositiveInteger(raw, ["buildContextBytes", "build_context_bytes"]);
	const imageDigest = argumentText(raw, ["imageDigest", "image_digest"]);
	const seedDigest = argumentText(raw, ["seedDigest", "seed_digest"]);
	const ttlHours = argumentPositiveInteger(raw, ["ttlHours", "ttl_hours"]);
	const pullNumber = argumentPositiveInteger(raw, ["pullNumber", "pull_number"]);
	const expectedHeadSha = argumentText(raw, ["expectedHeadSha", "expected_head_sha"]);
	if (!isCanonicalGraphOwnerPrincipal(ownerPrincipal)) throw new Error("development target owner is invalid");
	if (!repository || !REPOSITORY.test(repository) || repository.includes("..")) {
		throw new Error("development target repository is invalid");
	}
	if (!sourceRevision || !GIT_OBJECT_ID.test(sourceRevision)) {
		throw new Error("development target source revision is invalid");
	}
	if (!baseBranch || !safeGitBranch(baseBranch)) throw new Error("development target base branch is invalid");
	if (!branchName || !safeGitBranch(branchName)) throw new Error("development target branch is invalid");
	if (!scratchGraphId || !SITE_GRAPH_ID.test(scratchGraphId) || !scratchGraphId.startsWith("dev-")) {
		throw new Error("development target scratch graph is invalid");
	}
	if (!scenarioDigest || !SHA256.test(scenarioDigest))
		throw new Error("development target scenario digest is invalid");
	if (builderRecipeId !== undefined && !BUILD_RECIPE_ID.test(builderRecipeId)) {
		throw new Error("development target builder recipe id is invalid");
	}
	if (builderRecipeDigest !== undefined && !SHA256.test(builderRecipeDigest)) {
		throw new Error("development target builder recipe digest is invalid");
	}
	if (buildPlanDigest !== undefined && !SHA256.test(buildPlanDigest)) {
		throw new Error("development target build plan digest is invalid");
	}
	if (buildContextDigest !== undefined && !SHA256.test(buildContextDigest)) {
		throw new Error("development target build context digest is invalid");
	}
	if (
		(Object.hasOwn(raw, "buildContextBytes") || Object.hasOwn(raw, "build_context_bytes")) &&
		buildContextBytes === undefined
	) {
		throw new Error("development target build context bytes are invalid");
	}
	if (imageDigest !== undefined && !IMAGE_DIGEST.test(imageDigest)) {
		throw new Error("development target image digest is invalid");
	}
	if (seedDigest !== undefined && !SHA256.test(seedDigest))
		throw new Error("development target seed digest is invalid");
	if ((Object.hasOwn(raw, "ttlHours") || Object.hasOwn(raw, "ttl_hours")) && ttlHours === undefined) {
		throw new Error("development target TTL is invalid");
	}
	if (expectedHeadSha !== undefined && !GIT_OBJECT_ID.test(expectedHeadSha)) {
		throw new Error("development target expected head is invalid");
	}
	return {
		ownerPrincipal,
		repository,
		sourceRevision,
		baseBranch,
		branchName,
		scratchGraphId,
		scenarioDigest,
		...(builderRecipeId ? { builderRecipeId } : {}),
		...(builderRecipeDigest ? { builderRecipeDigest } : {}),
		...(buildPlanDigest ? { buildPlanDigest } : {}),
		...(buildContextDigest ? { buildContextDigest } : {}),
		...(buildContextBytes !== undefined ? { buildContextBytes } : {}),
		...(imageDigest ? { imageDigest } : {}),
		...(seedDigest ? { seedDigest } : {}),
		...(ttlHours !== undefined ? { ttlHours } : {}),
		...(pullNumber !== undefined ? { pullNumber } : {}),
		...(expectedHeadSha ? { expectedHeadSha } : {}),
	};
}

export function parseCommittedPlatformReleaseTarget(
	trigger: Readonly<Record<string, unknown>>,
): CommittedPlatformReleaseTarget {
	const raw = trigger.platformReleaseTarget ?? trigger.platform_release_target;
	if (!isRecord(raw)) throw new Error("committed trigger has no platformReleaseTarget");
	const ownerPrincipal = argumentText(raw, ["ownerPrincipal", "owner_principal"]);
	const resource = argumentText(raw, ["resource"]);
	const planDigest = argumentText(raw, ["planDigest", "plan_digest"]);
	const planRef = raw.planRef ?? raw.plan_ref;
	const confirmation = argumentText(raw, ["confirmation"]);
	const sourceRevision = argumentText(raw, ["sourceRevision", "source_revision"]);
	const plan = raw.plan;
	if (!isCanonicalGraphOwnerPrincipal(ownerPrincipal)) throw new Error("platform release owner is invalid");
	if (!resource || !PLATFORM_RESOURCES.has(resource)) throw new Error("platform release resource is invalid");
	if (!planDigest || !PREFIXED_SHA256.test(planDigest)) throw new Error("platform release plan digest is invalid");
	if (!sourceRevision || !PLATFORM_SOURCE_REVISION.test(sourceRevision)) {
		throw new Error("platform release source revision is invalid");
	}
	const systemName = resource === "canary/choreograph" ? "choreograph" : "cloud2-platform";
	if (!confirmation || confirmation !== `apply:canary:${systemName}:${planDigest.slice(7, 15)}`) {
		throw new Error("platform release confirmation is invalid");
	}
	if (!isRecord(plan) || Buffer.byteLength(stableJson(plan)) > MAX_PLATFORM_PLAN_BYTES) {
		throw new Error("platform release plan is invalid");
	}
	const body = plan.body;
	if (
		plan.apiVersion !== "sophia.cloud/v1" ||
		plan.kind !== "RealizationPlan" ||
		plan.applicable !== true ||
		plan.digest !== planDigest ||
		!isRecord(body) ||
		`sha256:${createHash("sha256").update(stableJson(body)).digest("hex")}` !== planDigest
	) {
		throw new Error("platform release plan envelope is invalid");
	}
	const environment = isRecord(body.environment) ? body.environment : {};
	const system = isRecord(body.system) ? body.system : {};
	const source = isRecord(body.source) ? body.source : {};
	if (
		environment.name !== "canary" ||
		system.name !== systemName ||
		source.repository !== "sophia-labs/cloud" ||
		source.revision !== sourceRevision
	) {
		throw new Error("platform release plan source or target is invalid");
	}
	if (!Array.isArray(body.actions) || body.actions.length !== 1 || !isRecord(body.actions[0])) {
		throw new Error("platform release plan action is invalid");
	}
	if (resource === "canary/cloud2-platform") {
		if (planRef !== undefined && planRef !== null) {
			throw new Error("cloud-2 platform release must not carry a Choreograph deployment plan ref");
		}
		if (body.actions[0].actionId !== "rollout.platform-release" || body.actions[0].driver !== "legacy-script") {
			throw new Error("platform release plan action is invalid");
		}
	} else {
		const { artifact, artifactRef } = validateChoreographDeploymentPlan(body.actions[0]);
		validateMeaningfulObjectRef(planRef, "deployment-plan");
		if (
			planRef.ownerPrincipal !== ownerPrincipal ||
			artifactRef.ownerPrincipal !== ownerPrincipal ||
			artifactRef.graphId !== planRef.graphId ||
			planRef.digest !== `sha256:${createHash("sha256").update(stableJson(plan)).digest("hex")}`
		) {
			throw new Error("Choreograph deployment plan Meaningful Object digest is invalid");
		}
		const release = isRecord(body.release) ? body.release : {};
		if (release.name !== `choreograph-${artifact.version}` || release.digest !== artifactRef.digest) {
			throw new Error("Choreograph release Meaningful Object differs from the deployment plan");
		}
	}
	return {
		ownerPrincipal,
		resource: resource as CommittedPlatformReleaseTarget["resource"],
		plan,
		planDigest: planDigest as `sha256:${string}`,
		...(planRef ? { planRef: planRef as MeaningfulObjectRefV1<"deployment-plan"> } : {}),
		confirmation,
		sourceRevision,
	};
}

function validateChoreographDeploymentPlan(action: Readonly<Record<string, unknown>>): {
	readonly artifact: ChoreographReleaseArtifactV1;
	readonly artifactRef: MeaningfulObjectRefV1<"release-artifact">;
} {
	const invocation = isRecord(action.invocation) ? action.invocation : {};
	const artifact = invocation.artifact;
	const artifactRef = invocation.artifactRef;
	if (
		action.actionId !== "rollout.choreograph-release" ||
		action.driver !== "terraform-release" ||
		action.operation !== "terraform-apply" ||
		action.target !== "terraform/choreograph" ||
		action.destructive !== true ||
		!Array.isArray(action.dependsOn) ||
		action.dependsOn.length !== 0 ||
		invocation.kind !== "choreograph-release" ||
		stableJson(invocation.targets) !== stableJson(CHOREOGRAPH_TERRAFORM_TARGETS) ||
		!isRecord(artifact) ||
		!validChoreographReleaseArtifact(artifact as unknown as ChoreographReleaseArtifactV1) ||
		artifact.bucket !== "choreograph-deploy-20260402192255814600000001"
	) {
		throw new Error("Choreograph deployment plan action is invalid");
	}
	validateMeaningfulObjectRef(artifactRef, "release-artifact");
	if (artifactRef.digest !== `sha256:${createHash("sha256").update(stableJson(artifact)).digest("hex")}`) {
		throw new Error("Choreograph release artifact Meaningful Object digest is invalid");
	}
	return {
		artifact: artifact as unknown as ChoreographReleaseArtifactV1,
		artifactRef: artifactRef as MeaningfulObjectRefV1<"release-artifact">,
	};
}

function requireCommittedSiteTarget(context: EffectExecutionContext): CommittedSiteTarget {
	const target = parseCommittedSiteTarget(context.trigger ?? {});
	if (target.ownerPrincipal !== context.sourceTurn.target.ownerPrincipal) {
		throw new Error("site target owner differs from the committed source-turn owner");
	}
	return target;
}

function requireCommittedDevelopmentTarget(context: EffectExecutionContext): CommittedDevelopmentTarget {
	const target = parseCommittedDevelopmentTarget(context.trigger ?? {});
	if (target.ownerPrincipal !== context.sourceTurn.target.ownerPrincipal) {
		throw new Error("development target owner differs from the committed source-turn owner");
	}
	return target;
}

function requireCommittedPlatformReleaseTarget(context: EffectExecutionContext): CommittedPlatformReleaseTarget {
	const target = parseCommittedPlatformReleaseTarget(context.trigger ?? {});
	if (target.ownerPrincipal !== context.sourceTurn.target.ownerPrincipal) {
		throw new Error("platform release owner differs from the committed source-turn owner");
	}
	return target;
}

function isDevelopmentCapability(capability: string): boolean {
	return capability === "build" || capability === "cell.scratch" || capability === "github";
}

function proposedChangePaths(arguments_: Readonly<Record<string, unknown>>): string[] | undefined {
	if (!Array.isArray(arguments_.changes) || !arguments_.changes.length) return undefined;
	const paths: string[] = [];
	for (const change of arguments_.changes) {
		if (!isRecord(change)) return undefined;
		const path = argumentText(change, ["path"]);
		if (!path || !safeRepositoryPath(path)) return undefined;
		paths.push(path);
	}
	return paths;
}

function safeGitBranch(value: string): boolean {
	return (
		value.length <= 255 &&
		/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
		!value.includes("..") &&
		!value.includes("@{") &&
		!value.endsWith("/") &&
		!value.endsWith(".") &&
		!value.endsWith(".lock") &&
		!value.includes("//")
	);
}

function safeRepositoryPath(value: string): boolean {
	if (!value || value.length > 1_024 || value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
		return false;
	}
	const segments = value.split("/");
	return segments.every((segment) => Boolean(segment) && segment !== "." && segment !== "..");
}

function repositoryFenceAllows(prefix: string, repository: string): boolean {
	return prefix.endsWith("/") ? repository.startsWith(prefix) : repository === prefix;
}

function assertCommittedEffectContext(context: EffectExecutionContext): void {
	const turn = parseDomainSourceTurn(context.sourceTurn);
	if (
		turn.target.graphId !== context.graphId ||
		turn.agentId !== context.agentId ||
		turn.actorRef !== context.actorRef
	) {
		throw new Error("effect context differs from its committed source turn");
	}
	if (!context.trigger || domainTriggerDigest(context.trigger) !== turn.triggerDigest) {
		throw new Error("effect trigger differs from its committed source turn");
	}
}

function digestResult(result: unknown): string {
	return createHash("sha256")
		.update(stableJson(result ?? null))
		.digest("hex");
}

function argumentText(arguments_: Readonly<Record<string, unknown>>, names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = arguments_[name];
		if (typeof value === "string") return value;
	}
	return undefined;
}

function argumentPositiveInteger(
	arguments_: Readonly<Record<string, unknown>>,
	names: readonly string[],
): number | undefined {
	for (const name of names) {
		const value = arguments_[name];
		if (Number.isSafeInteger(value) && Number(value) > 0) return Number(value);
	}
	return undefined;
}

function argumentConflicts(
	arguments_: Readonly<Record<string, unknown>>,
	names: readonly string[],
	expected: unknown,
): boolean {
	return names.some((name) => Object.hasOwn(arguments_, name) && arguments_[name] !== expected);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function text(value: unknown): value is string {
	return typeof value === "string" && Boolean(value.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEffectReceipt(value: unknown): value is EffectReceiptV1 {
	return isRecord(value) && value.schema === EFFECT_RECEIPT_SCHEMA;
}
