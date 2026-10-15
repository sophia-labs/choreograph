/**
 * Host-committed source authority for one Domain Agent turn.
 *
 * Phanes established the important ordering: observe and durably commit the
 * source event first, then launch a disposable agent embodiment.  The sandbox
 * may describe effects, but this record owns the target and replay identity.
 */

import { createHash } from "node:crypto";
import { isCanonicalGraphOwnerPrincipal } from "../graph-owner-principal.js";
import { stableJson } from "./agent-tool-manifest.js";
import type {
	DomainAgentCallerContextV1,
	DomainAgentInvocationRequestV1,
	ResolvedDomainAgentConfigV1,
} from "./domain-agent-config.js";
import type { InvocationEnvelopeV1 } from "./invocation.js";
import type { WorkflowRuntimeStore } from "./runtime-store.js";

export const DOMAIN_SOURCE_TURN_SCHEMA = "sophia.domain-source-turn.v1" as const;

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface DomainSourceTurnV1 {
	readonly schema: typeof DOMAIN_SOURCE_TURN_SCHEMA;
	readonly turnId: string;
	readonly sourceRef: string;
	readonly sourceDigest: string;
	readonly triggerDigest: string;
	readonly contextDigest: string;
	readonly target: {
		readonly ownerPrincipal: string;
		readonly graphId: string;
	};
	readonly agentId: string;
	readonly actorRef: string;
	readonly ingress: {
		readonly authMethod: "owner" | "internal-service";
		readonly adapter?: string;
	};
	readonly committedAt: number;
}

export class DomainSourceTurnError extends Error {
	readonly status: number;

	constructor(
		readonly code:
			| "source_turn_invalid"
			| "source_commit_untrusted"
			| "source_commit_mismatch"
			| "source_turn_conflict",
		message: string,
	) {
		super(message);
		this.name = "DomainSourceTurnError";
		this.status =
			this.code === "source_turn_conflict"
				? 409
				: this.code === "source_commit_untrusted" || this.code === "source_commit_mismatch"
					? 403
					: 400;
	}
}

/**
 * Commit a trusted turn before any sandbox can launch.  Replays return the
 * original committed bytes; changed evidence at the same source identity is a
 * hard conflict.
 */
export async function commitDomainSourceTurn(input: {
	runtime: WorkflowRuntimeStore;
	request: DomainAgentInvocationRequestV1;
	resolved: ResolvedDomainAgentConfigV1;
	graphOwnerPrincipal: string;
	graphId: string;
	actorRef: string;
	caller: DomainAgentCallerContextV1;
	invocation: InvocationEnvelopeV1;
	now?: number;
}): Promise<DomainSourceTurnV1> {
	const candidate = buildDomainSourceTurn(input);
	const turnDigest = domainSourceTurnDigest(candidate);
	try {
		const offered = await input.runtime.offerDomainSourceTurn({
			turnId: candidate.turnId,
			turnDigest,
			sourceRef: candidate.sourceRef,
			sourceDigest: candidate.sourceDigest,
			triggerDigest: candidate.triggerDigest,
			contextDigest: candidate.contextDigest,
			ownerPrincipal: candidate.target.ownerPrincipal,
			graphId: candidate.target.graphId,
			agentId: candidate.agentId,
			actorRef: candidate.actorRef,
			authMethod: candidate.ingress.authMethod,
			triggerAdapter: candidate.ingress.adapter,
			invocationId: input.invocation.invocationId,
			turn: candidate,
			now: candidate.committedAt,
		});
		const committed = parseDomainSourceTurn(offered.record.turn);
		if (domainSourceTurnDigest(committed) !== offered.record.turn_digest) {
			throw new DomainSourceTurnError("source_turn_conflict", "stored source turn failed its committed digest");
		}
		return committed;
	} catch (error) {
		if ((error as { name?: string }).name === "DomainSourceTurnConflictError") {
			throw new DomainSourceTurnError(
				"source_turn_conflict",
				`source turn '${candidate.turnId}' conflicts with already committed evidence`,
			);
		}
		throw error;
	}
}

export function buildDomainSourceTurn(input: {
	request: DomainAgentInvocationRequestV1;
	resolved: ResolvedDomainAgentConfigV1;
	graphOwnerPrincipal: string;
	graphId: string;
	actorRef: string;
	caller: DomainAgentCallerContextV1;
	invocation: InvocationEnvelopeV1;
	now?: number;
}): DomainSourceTurnV1 {
	if (!isCanonicalGraphOwnerPrincipal(input.graphOwnerPrincipal)) {
		throw new DomainSourceTurnError("source_turn_invalid", "source turn requires an exact typed graph owner");
	}
	if (input.resolved.definition.homeGraphId !== input.graphId) {
		throw new DomainSourceTurnError("source_turn_invalid", "source turn target differs from the agent home graph");
	}
	if (input.invocation.graph?.graphId !== input.graphId) {
		throw new DomainSourceTurnError("source_turn_invalid", "source turn requires the canonical invocation graph");
	}
	if (
		input.invocation.graph.ownerPrincipal !== undefined &&
		input.invocation.graph.ownerPrincipal !== input.graphOwnerPrincipal
	) {
		throw new DomainSourceTurnError("source_turn_invalid", "source turn owner differs from the canonical invocation");
	}
	if (input.invocation.actorRef !== input.actorRef) {
		throw new DomainSourceTurnError("source_turn_invalid", "source turn actor differs from authenticated invocation");
	}

	const triggerDigest = digest(input.request.trigger);
	const contextDigest = digest([...input.request.contextRefs]);
	let sourceRef: string;
	let sourceDigest: string;
	if (input.request.sourceCommit) {
		if (input.caller.authMethod !== "internal-service" || !input.caller.triggerAdapter) {
			throw new DomainSourceTurnError(
				"source_commit_untrusted",
				"only an authenticated internal trigger adapter may attest an external source commit",
			);
		}
		if (
			input.resolved.triggerBinding.ingress !== "internal-service" ||
			input.resolved.triggerBinding.adapter !== input.caller.triggerAdapter
		) {
			throw new DomainSourceTurnError(
				"source_commit_untrusted",
				"source commit adapter differs from the resolved trigger binding",
			);
		}
		const triggerEventId = textAt(input.request.trigger, ["eventId", "event_id"]);
		if (triggerEventId !== input.request.sourceCommit.eventId) {
			throw new DomainSourceTurnError("source_commit_mismatch", "source commit event differs from the trigger");
		}
		if (!input.request.contextRefs.includes(input.request.sourceCommit.sourceRef)) {
			throw new DomainSourceTurnError("source_commit_mismatch", "source commit is absent from contextRefs");
		}
		if (
			input.invocation.cause?.kind !== "trigger" ||
			input.invocation.cause.ref !== input.request.sourceCommit.sourceRef
		) {
			throw new DomainSourceTurnError(
				"source_commit_mismatch",
				"canonical invocation cause differs from the external source commit",
			);
		}
		sourceRef = input.request.sourceCommit.sourceRef;
		sourceDigest = input.request.sourceCommit.digest;
	} else {
		if (input.caller.authMethod === "internal-service") {
			throw new DomainSourceTurnError(
				"source_commit_untrusted",
				"internal-service Domain Agent triggers require an external source commit",
			);
		}
		sourceRef =
			input.invocation.cause?.ref ?? `urn:sophia:invocation:${encodeURIComponent(input.invocation.invocationId)}`;
		sourceDigest = digest({
			trigger: input.request.trigger,
			contextRefs: input.request.contextRefs,
			cause: input.invocation.cause ?? null,
		});
	}
	assertSourceRef(sourceRef);
	if (!SHA256.test(sourceDigest)) {
		throw new DomainSourceTurnError("source_turn_invalid", "source digest must be lowercase SHA-256");
	}

	const identity = {
		ownerPrincipal: input.graphOwnerPrincipal,
		graphId: input.graphId,
		agentId: input.resolved.definition.agentId,
		sourceRef,
	};
	return {
		schema: DOMAIN_SOURCE_TURN_SCHEMA,
		turnId: `turn:${digest(identity)}`,
		sourceRef,
		sourceDigest,
		triggerDigest,
		contextDigest,
		target: { ownerPrincipal: input.graphOwnerPrincipal, graphId: input.graphId },
		agentId: input.resolved.definition.agentId,
		actorRef: input.actorRef,
		ingress: {
			authMethod: input.caller.authMethod,
			...(input.caller.triggerAdapter ? { adapter: input.caller.triggerAdapter } : {}),
		},
		committedAt: input.now ?? Date.now(),
	};
}

/** Digest the immutable source witness; commit time is testimony, not identity. */
export function domainSourceTurnDigest(turn: DomainSourceTurnV1): string {
	return digest({
		schema: turn.schema,
		turnId: turn.turnId,
		sourceRef: turn.sourceRef,
		sourceDigest: turn.sourceDigest,
		triggerDigest: turn.triggerDigest,
		contextDigest: turn.contextDigest,
		target: turn.target,
		agentId: turn.agentId,
		actorRef: turn.actorRef,
		ingress: turn.ingress,
	});
}

/** The exact digest committed beside a source turn's canonical trigger. */
export function domainTriggerDigest(trigger: Readonly<Record<string, unknown>>): string {
	return digest(trigger);
}

export function parseDomainSourceTurn(value: unknown): DomainSourceTurnV1 {
	if (!isRecord(value) || value.schema !== DOMAIN_SOURCE_TURN_SCHEMA) {
		throw new DomainSourceTurnError("source_turn_invalid", `expected '${DOMAIN_SOURCE_TURN_SCHEMA}'`);
	}
	const target = isRecord(value.target) ? value.target : undefined;
	const ingress = isRecord(value.ingress) ? value.ingress : undefined;
	if (
		typeof value.turnId !== "string" ||
		!/^turn:[0-9a-f]{64}$/.test(value.turnId) ||
		typeof value.sourceRef !== "string" ||
		typeof value.sourceDigest !== "string" ||
		!SHA256.test(value.sourceDigest) ||
		typeof value.triggerDigest !== "string" ||
		!SHA256.test(value.triggerDigest) ||
		typeof value.contextDigest !== "string" ||
		!SHA256.test(value.contextDigest) ||
		!target ||
		typeof target.ownerPrincipal !== "string" ||
		!isCanonicalGraphOwnerPrincipal(target.ownerPrincipal) ||
		typeof target.graphId !== "string" ||
		!target.graphId ||
		typeof value.agentId !== "string" ||
		!/^agent-[0-9a-f]+$/.test(value.agentId) ||
		typeof value.actorRef !== "string" ||
		!ingress ||
		!(ingress.authMethod === "owner" || ingress.authMethod === "internal-service") ||
		(ingress.adapter !== undefined && typeof ingress.adapter !== "string") ||
		!Number.isSafeInteger(value.committedAt)
	) {
		throw new DomainSourceTurnError("source_turn_invalid", "source turn is structurally invalid");
	}
	assertSourceRef(value.sourceRef);
	const expectedTurnId = `turn:${digest({
		ownerPrincipal: target.ownerPrincipal,
		graphId: target.graphId,
		agentId: value.agentId,
		sourceRef: value.sourceRef,
	})}`;
	if (value.turnId !== expectedTurnId) {
		throw new DomainSourceTurnError("source_turn_invalid", "source turn id differs from its authority tuple");
	}
	return value as unknown as DomainSourceTurnV1;
}

function assertSourceRef(value: string): void {
	if (!value || value.length > 1024 || /[\r\n\0]/.test(value)) {
		throw new DomainSourceTurnError("source_turn_invalid", "sourceRef is invalid");
	}
}

export function parseDomainSourceCommit(value: unknown): NonNullable<DomainAgentInvocationRequestV1["sourceCommit"]> {
	if (!isRecord(value)) throw new DomainSourceTurnError("source_turn_invalid", "sourceCommit must be an object");
	const allowed = new Set([
		"eventId",
		"event_id",
		"sourceRef",
		"source_ref",
		"eventRef",
		"event_ref",
		"digest",
		"sourceDigest",
		"source_digest",
	]);
	const unexpected = Object.keys(value).filter((field) => !allowed.has(field));
	if (unexpected.length) {
		throw new DomainSourceTurnError(
			"source_turn_invalid",
			`sourceCommit contains unsupported fields: ${unexpected.sort().join(", ")}`,
		);
	}
	const eventId = value.eventId ?? value.event_id;
	const sourceRef = value.sourceRef ?? value.source_ref ?? value.eventRef ?? value.event_ref;
	const digest_ = value.digest ?? value.sourceDigest ?? value.source_digest;
	if (typeof eventId !== "string" || !SAFE_EVENT_ID.test(eventId)) {
		throw new DomainSourceTurnError("source_turn_invalid", "sourceCommit.eventId is invalid");
	}
	if (typeof sourceRef !== "string") {
		throw new DomainSourceTurnError("source_turn_invalid", "sourceCommit.sourceRef is required");
	}
	assertSourceRef(sourceRef);
	if (typeof digest_ !== "string" || !SHA256.test(digest_)) {
		throw new DomainSourceTurnError("source_turn_invalid", "sourceCommit.digest must be lowercase SHA-256");
	}
	return { eventId, sourceRef, digest: digest_ };
}

function textAt(value: Readonly<Record<string, unknown>>, fields: readonly string[]): string | undefined {
	for (const field of fields) {
		if (typeof value[field] === "string") return value[field];
	}
	return undefined;
}

function digest(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
