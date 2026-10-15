/** Shared Phanes-standard validation for Development Domain host adapters. */

import { createHash } from "node:crypto";
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
	type CommittedDevelopmentTarget,
	type EffectApprovalV1,
	type ProposedEffectV1,
	parseCommittedDevelopmentTarget,
	parseProposedEffect,
	proposedEffectExecutionDigest,
} from "./proposed-effect.js";
import type { EffectHandoffRecord } from "./runtime-store.js";

const SHA256 = /^[0-9a-f]{64}$/;
const USER_PRINCIPAL = /^user:[A-Za-z0-9_.@:-]{1,192}$/;

export interface DevelopmentGrantHost {
	readGrant(record: EffectHandoffRecord): Promise<string>;
}

export interface ValidatedDevelopmentHandoff {
	readonly record: EffectHandoffRecord;
	readonly sourceTurn: DomainSourceTurnV1;
	readonly trigger: Readonly<Record<string, unknown>>;
	readonly proposal: ProposedEffectV1;
	readonly target: CommittedDevelopmentTarget;
	readonly approval?: EffectApprovalV1;
}

export interface VerifiedDevelopmentGrant {
	readonly grant: AgentToolGrantV1;
	readonly digest: string;
	readonly capability: NonNullable<ReturnType<typeof findGrantedCapability>>;
}

export class DevelopmentEffectError extends Error {
	constructor(
		readonly code: string,
		readonly retryable: boolean,
		message = code,
	) {
		super(message);
		this.name = "DevelopmentEffectError";
	}
}

/** Recompute the durable turn, trigger, effect key, target, and proposal before credentials are reachable. */
export function validateDevelopmentHandoff(
	record: EffectHandoffRecord,
	input: { readonly capability: "build" | "cell.scratch" | "github"; readonly operations: ReadonlySet<string> },
): ValidatedDevelopmentHandoff {
	if (
		!record.source_turn_id ||
		!record.source_turn_digest ||
		!record.source_owner_principal ||
		!SHA256.test(record.source_turn_digest)
	) {
		throw terminal("source-turn-witness-missing");
	}
	let sourceTurn: DomainSourceTurnV1;
	try {
		sourceTurn = parseDomainSourceTurn(record.source_turn);
	} catch (error) {
		throw terminal("source-turn-invalid", error);
	}
	if (
		sourceTurn.turnId !== record.source_turn_id ||
		domainSourceTurnDigest(sourceTurn) !== record.source_turn_digest ||
		sourceTurn.target.graphId !== record.graph_id ||
		sourceTurn.target.ownerPrincipal !== record.source_owner_principal ||
		sourceTurn.agentId !== record.agent_id ||
		sourceTurn.actorRef !== record.actor_ref
	) {
		throw terminal("source-turn-authority-mismatch");
	}
	if (!isRecord(record.trigger) || domainTriggerDigest(record.trigger) !== sourceTurn.triggerDigest) {
		throw terminal("trigger-witness-mismatch");
	}
	if (record.capability !== input.capability || !input.operations.has(record.operation)) {
		throw terminal(`${input.capability}-operation-invalid`);
	}
	let proposal: ProposedEffectV1;
	try {
		proposal = parseProposedEffect(record.proposal);
	} catch (error) {
		throw terminal(`${input.capability}-proposal-invalid`, error);
	}
	if (
		proposal.capability !== input.capability ||
		proposal.operation !== record.operation ||
		proposedEffectExecutionDigest(proposal) !== record.execution_digest
	) {
		throw terminal(`${input.capability}-proposal-witness-mismatch`);
	}
	const expectedKey = `effect:${sha256({ sourceTurnId: sourceTurn.turnId, effectIndex: record.effect_index })}`;
	if (record.idempotency_key !== expectedKey || proposal.idempotencyKey !== expectedKey) {
		throw terminal(`${input.capability}-effect-identity-mismatch`);
	}
	let target: CommittedDevelopmentTarget;
	try {
		target = parseCommittedDevelopmentTarget(record.trigger);
	} catch (error) {
		throw terminal("development-target-invalid", error);
	}
	if (target.ownerPrincipal !== sourceTurn.target.ownerPrincipal) {
		throw terminal("development-target-owner-mismatch");
	}
	for (const [field, expected] of Object.entries(target)) {
		if (proposal.arguments[field] !== expected) throw terminal(`development-target-${field}-mismatch`);
	}
	if (proposal.arguments.repository !== target.repository || proposal.arguments.resource !== target.repository) {
		throw terminal("development-target-repository-mismatch");
	}
	if (input.capability === "cell.scratch" && proposal.arguments.graphId !== target.scratchGraphId) {
		throw terminal("development-target-graph-mismatch");
	}
	if (input.capability === "github") {
		if (proposal.arguments.branch !== target.branchName) throw terminal("development-target-branch-mismatch");
		if (record.operation === "branch.push" && proposal.arguments.baseSha !== target.sourceRevision) {
			throw terminal("development-target-source-revision-mismatch");
		}
		if (
			record.operation === "pr.open" &&
			(proposal.arguments.head !== target.branchName || proposal.arguments.base !== target.baseBranch)
		) {
			throw terminal("development-target-pr-route-mismatch");
		}
		if (
			(record.operation === "pr.comment" || record.operation === "pr.merge") &&
			proposal.arguments.pullNumber !== target.pullNumber
		) {
			throw terminal("development-target-pr-mismatch");
		}
		if (record.operation === "pr.merge" && proposal.arguments.expectedHeadSha !== target.expectedHeadSha) {
			throw terminal("development-target-head-mismatch");
		}
	}
	const approval = parseApproval(record.approval, proposal, record);
	if (input.capability === "github" && record.operation === "pr.merge" && !approval) {
		throw terminal("github-human-approval-required");
	}
	return {
		record,
		sourceTurn,
		trigger: record.trigger,
		proposal,
		target,
		...(approval ? { approval } : {}),
	};
}

/** Reread the exact current steward grant and independently reapply every static fence. */
export async function verifyCurrentDevelopmentGrant(
	host: DevelopmentGrantHost,
	handoff: ValidatedDevelopmentHandoff,
	now = Date.now(),
): Promise<VerifiedDevelopmentGrant> {
	let raw: string;
	try {
		raw = await host.readGrant(handoff.record);
	} catch (error) {
		throw retryable("grant-unavailable", error);
	}
	let grant: AgentToolGrantV1;
	try {
		grant = parseAgentToolGrant(JSON.parse(unwrapAuthoredJsonDocument(raw)) as unknown);
	} catch (error) {
		throw terminal("grant-malformed", error);
	}
	const digest = grantDigest(grant);
	if (digest !== handoff.record.grant_digest) throw terminal("grant-digest-changed");
	if (
		grant.grantId !== handoff.record.grant_id ||
		grant.authorityGraphId !== handoff.record.grant_authority_graph_id
	) {
		throw terminal("grant-witness-mismatch");
	}
	try {
		assertGrantActive(grant, handoff.record.agent_id, now);
	} catch (error) {
		throw terminal("grant-inactive", error);
	}
	const capability = findGrantedCapability(grant, handoff.record.capability, handoff.record.operation);
	if (!capability || capability.access !== "write") throw terminal("grant-operation-denied");
	const fence = capability.fence;
	if (handoff.record.capability === "build") {
		if (!handoff.target.builderRecipeId || !handoff.target.builderRecipeDigest) {
			throw terminal("build-recipe-target-missing");
		}
		if (
			fence.builderRecipeDigests?.length &&
			!fence.builderRecipeDigests.includes(handoff.target.builderRecipeDigest)
		) {
			throw terminal("grant-build-recipe-denied");
		}
		if (!fence.builderRecipeDigests?.length) throw terminal("grant-build-recipe-unfenced");
	}
	if (
		fence.graphIds?.length &&
		!fence.graphIds.includes(handoff.target.scratchGraphId) &&
		!fence.graphIdPrefixes?.some((prefix) => handoff.target.scratchGraphId.startsWith(prefix))
	) {
		throw terminal("grant-graph-denied");
	}
	if (
		fence.graphIdPrefixes?.length &&
		!fence.graphIds?.includes(handoff.target.scratchGraphId) &&
		!fence.graphIdPrefixes.some((prefix) => handoff.target.scratchGraphId.startsWith(prefix))
	) {
		throw terminal("grant-graph-denied");
	}
	if (
		fence.resourcePrefixes?.length &&
		!fence.resourcePrefixes.some((prefix) =>
			prefix.endsWith("/") ? handoff.target.repository.startsWith(prefix) : handoff.target.repository === prefix,
		)
	) {
		throw terminal("grant-resource-denied");
	}
	if (
		fence.branchPrefixes?.length &&
		!fence.branchPrefixes.some((prefix) => handoff.target.branchName.startsWith(prefix))
	) {
		throw terminal("grant-branch-denied");
	}
	if (handoff.record.capability === "github" && handoff.record.operation === "branch.push") {
		const paths = changePaths(handoff.proposal.arguments.changes);
		if (
			fence.pathPrefixes?.length &&
			(!paths.length || paths.some((path) => !fence.pathPrefixes!.some((prefix) => path.startsWith(prefix))))
		) {
			throw terminal("grant-path-denied");
		}
	}
	if (handoff.record.capability === "cell.scratch" && handoff.record.operation === "cell.launch") {
		if (
			handoff.target.ttlHours === undefined ||
			fence.maxTtlHours === undefined ||
			handoff.target.ttlHours > fence.maxTtlHours
		) {
			throw terminal("grant-ttl-denied");
		}
	}
	if (
		fence.maxPayloadBytes !== undefined &&
		Buffer.byteLength(stableJson(handoff.proposal.arguments)) > fence.maxPayloadBytes
	) {
		throw terminal("grant-payload-denied");
	}
	const policy = effectApprovalPolicyFor(capability, handoff.record.operation);
	if (
		(policy === "human-always" ||
			(handoff.record.capability === "github" && handoff.record.operation === "pr.merge")) &&
		!handoff.approval
	) {
		throw terminal("human-approval-required");
	}
	if (handoff.approval && handoff.approval.approvedAt > now) throw terminal("approval-from-future");
	return { grant, digest, capability };
}

export function developmentTerminal(code: string, cause?: unknown): DevelopmentEffectError {
	return terminal(code, cause);
}

export function developmentRetryable(code: string, cause?: unknown): DevelopmentEffectError {
	return retryable(code, cause);
}

function parseApproval(
	value: unknown,
	proposal: ProposedEffectV1,
	record: EffectHandoffRecord,
): EffectApprovalV1 | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) throw terminal("approval-invalid");
	const approval = value as unknown as EffectApprovalV1;
	if (
		approval.effectId !== proposal.effectId ||
		approval.grantId !== record.grant_id ||
		approval.proposalDigest !== record.proposal_digest ||
		!USER_PRINCIPAL.test(approval.approvedBy) ||
		!Number.isSafeInteger(approval.approvedAt) ||
		approval.approvedAt < 0
	) {
		throw terminal("approval-invalid");
	}
	return approval;
}

function changePaths(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => (isRecord(entry) && typeof entry.path === "string" ? [entry.path] : []));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

function terminal(code: string, cause?: unknown): DevelopmentEffectError {
	return new DevelopmentEffectError(code, false, cause instanceof Error ? `${code}: ${cause.message}` : code);
}

function retryable(code: string, cause?: unknown): DevelopmentEffectError {
	return new DevelopmentEffectError(code, true, cause instanceof Error ? `${code}: ${cause.message}` : code);
}
