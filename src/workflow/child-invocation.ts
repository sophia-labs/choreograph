import { canonicalDigest, canonicalJson } from "../agent-subject/canonical-json.js";
import { effectApprovalPolicyFor, type GrantedCapabilityV1, type GrantedToolbeltV1 } from "./agent-tool-grant.js";
import type { DomainAgentProgramBindingV1 } from "./domain-agent-config.js";
import {
	assertJsonSchema,
	type ChildInvocationRequestV1,
	type ChildInvocationResultV1,
	INVOCATION_ENVELOPE_SCHEMA,
	INVOCATION_RECEIPT_SCHEMA,
	type InvocationEnvelopeV1,
	InvocationFault,
} from "./invocation.js";

export type ChildInvocationDispatch = (envelope: InvocationEnvelopeV1) => Promise<ChildInvocationResultV1>;

export interface BoundedChildInvocationOptions {
	readonly parentRunId: string;
	readonly parentInvocationId: string;
	readonly actorRef: string;
	readonly graphId: string;
	readonly graphOwnerPrincipal?: string;
	readonly programs: readonly DomainAgentProgramBindingV1[];
	readonly toolbelt: GrantedToolbeltV1;
	readonly maxChildInvocations: number;
	readonly parentDeadlineMs?: number;
	readonly dispatch: ChildInvocationDispatch;
	readonly now?: () => number;
}

/**
 * Host-side policy mediator for deterministic instruments selected by a Domain
 * Agent pilot. Workflow code can supply only an exact bound target plus JSON
 * input. The mediator re-resolves the graph-pinned tuple, enforces the child
 * budget and input contract, derives identity, and attenuates descendants to
 * zero child invocations before dispatch.
 */
export class BoundedChildInvocationMediator {
	private issued = 0;
	private readonly witnessedInvocationIds: string[] = [];
	private readonly issuedByCapability = new Map<string, number>();

	constructor(private readonly options: BoundedChildInvocationOptions) {
		if (!Number.isSafeInteger(options.maxChildInvocations) || options.maxChildInvocations < 0) {
			throw new InvocationFault("child_budget_invalid", "maxChildInvocations must be a non-negative integer", 500);
		}
	}

	readonly invoke = async (request: ChildInvocationRequestV1): Promise<ChildInvocationResultV1> => {
		const binding = this.resolveBinding(request);
		if (this.issued >= this.options.maxChildInvocations) {
			throw new InvocationFault("child_budget_exhausted", "domain-agent child invocation budget is exhausted", 409, {
				maxChildInvocations: this.options.maxChildInvocations,
			});
		}
		assertJsonSchema(request.input, binding.inputSchema, "input");
		const targetGraphId = resolveTargetGraph(binding, request.input, this.options.graphId);
		const capability = this.resolveAuthority(binding, targetGraphId, request.input);
		const capabilityCount = this.issuedByCapability.get(capability.capability) ?? 0;
		if (capability.quota.maxPerWave !== undefined && capabilityCount >= capability.quota.maxPerWave) {
			throw new InvocationFault(
				"child_quota_exhausted",
				"domain-program per-wave capability quota is exhausted",
				409,
				{
					capability: capability.capability,
					maxPerWave: capability.quota.maxPerWave,
				},
			);
		}
		const now = (this.options.now ?? Date.now)();
		const deadlineMs = boundedDeadline(request.deadlineMs, this.options.parentDeadlineMs, now);
		const ordinal = ++this.issued;
		const identityDigest = canonicalDigest({
			parentInvocationId: this.options.parentInvocationId,
			ordinal,
			workflowName: binding.workflowName,
			workflowUri: binding.workflowUri,
			definitionDigest: binding.definitionDigest,
			graphId: targetGraphId,
			input: request.input,
		});
		const invocationId = `inv-child-${identityDigest.slice(0, 32)}`;
		const envelope: InvocationEnvelopeV1 = {
			schema: INVOCATION_ENVELOPE_SCHEMA,
			invocationId,
			target: {
				workflowName: binding.workflowName,
				workflowUri: binding.workflowUri,
				definitionDigest: binding.definitionDigest,
			},
			input: request.input,
			actorRef: this.options.actorRef,
			graph: {
				graphId: targetGraphId,
				...(this.options.graphOwnerPrincipal ? { ownerPrincipal: this.options.graphOwnerPrincipal } : {}),
			},
			cause: {
				kind: "invocation",
				ref: this.options.parentRunId,
				parentInvocationId: this.options.parentInvocationId,
			},
			idempotencyKey: `child:${identityDigest}`,
			...(deadlineMs === undefined ? {} : { deadlineMs }),
			budget: { maxChildInvocations: 0 },
		};
		this.issuedByCapability.set(capability.capability, capabilityCount + 1);
		const result = await this.options.dispatch(envelope);
		assertWitnessedResult(result, envelope);
		this.witnessedInvocationIds.push(invocationId);
		return result;
	};

	get invocationIds(): readonly string[] {
		return [...this.witnessedInvocationIds];
	}

	private resolveBinding(request: ChildInvocationRequestV1): DomainAgentProgramBindingV1 {
		const binding = this.options.programs.find(
			(candidate) =>
				candidate.workflowName === request.workflowName &&
				candidate.workflowUri === request.workflowUri &&
				candidate.definitionDigest === request.definitionDigest,
		);
		if (!binding) {
			throw new InvocationFault(
				"child_target_denied",
				"child invocation target is not an exact graph-bound domain program",
				403,
				{ workflowName: request.workflowName },
			);
		}
		return binding;
	}

	private resolveAuthority(
		binding: DomainAgentProgramBindingV1,
		graphId: string,
		input: unknown,
	): GrantedCapabilityV1 {
		const capability = this.options.toolbelt.capabilities.find(
			(candidate) =>
				candidate.capability === binding.authority.capability &&
				(candidate.operations.includes(binding.authority.operation) || candidate.operations.includes("*")),
		);
		if (!capability || (binding.authority.access === "write" && capability.access !== "write")) {
			throw denied(binding, "the steward-issued grant does not authorize this program operation");
		}
		if (effectApprovalPolicyFor(capability, binding.authority.operation) === "human-always") {
			throw new InvocationFault(
				"child_approval_required",
				"this deterministic program requires an explicit host approval before invocation",
				409,
				{ programId: binding.programId },
			);
		}
		if (!matchesFence(graphId, capability.fence.graphIds, capability.fence.graphIdPrefixes)) {
			throw denied(binding, "the target graph is outside the steward-issued grant fence", { graphId });
		}
		if (
			capability.fence.resourcePrefixes?.length &&
			!capability.fence.resourcePrefixes.some((prefix) => binding.authority.resourceRef.startsWith(prefix))
		) {
			throw denied(binding, "the program resource is outside the steward-issued grant fence");
		}
		if (
			capability.fence.maxPayloadBytes !== undefined &&
			Buffer.byteLength(canonicalJson(input)) > capability.fence.maxPayloadBytes
		) {
			throw new InvocationFault(
				"child_payload_denied",
				"domain-program input exceeds its grant payload fence",
				413,
				{
					programId: binding.programId,
					maxPayloadBytes: capability.fence.maxPayloadBytes,
				},
			);
		}
		if (capability.quota.maxConcurrent === 0 || capability.quota.maxPerDay === 0) {
			throw new InvocationFault(
				"child_quota_exhausted",
				"domain-program capability quota denies this invocation",
				409,
				{
					capability: capability.capability,
				},
			);
		}
		return capability;
	}
}

function resolveTargetGraph(binding: DomainAgentProgramBindingV1, input: unknown, homeGraphId: string): string {
	if (binding.graph.mode === "home") return homeGraphId;
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new InvocationFault("child_graph_invalid", "domain-program input cannot supply its bound graph field", 400);
	}
	const graphId = (input as Record<string, unknown>)[binding.graph.inputField];
	if (typeof graphId !== "string" || !graphId.trim()) {
		throw new InvocationFault("child_graph_invalid", "domain-program input is missing its bound graph field", 400, {
			inputField: binding.graph.inputField,
		});
	}
	return graphId;
}

function matchesFence(graphId: string, exact: readonly string[] | undefined, prefixes: readonly string[] | undefined) {
	if (!exact?.length && !prefixes?.length) return true;
	return Boolean(exact?.includes(graphId) || prefixes?.some((prefix) => graphId.startsWith(prefix)));
}

function denied(
	binding: DomainAgentProgramBindingV1,
	message: string,
	details: Readonly<Record<string, unknown>> = {},
): InvocationFault {
	return new InvocationFault("child_authority_denied", message, 403, { programId: binding.programId, ...details });
}

function boundedDeadline(requested: number | undefined, parent: number | undefined, now: number): number | undefined {
	const candidates = [requested, parent].filter((value): value is number => value !== undefined);
	if (candidates.length === 0) return undefined;
	const deadline = Math.min(...candidates);
	if (!Number.isFinite(deadline) || deadline <= now) {
		throw new InvocationFault("deadline_exceeded", "child invocation deadline has already elapsed", 408);
	}
	return Math.floor(deadline);
}

function assertWitnessedResult(result: ChildInvocationResultV1, envelope: InvocationEnvelopeV1): void {
	if (result.invocationId !== envelope.invocationId) {
		throw new InvocationFault(
			"child_receipt_invalid",
			"child result invocation identity does not match dispatch",
			502,
		);
	}
	const receipt = result.receipt;
	if (
		!receipt ||
		receipt.schema !== INVOCATION_RECEIPT_SCHEMA ||
		receipt.invocationId !== envelope.invocationId ||
		receipt.target.workflowName !== envelope.target.workflowName ||
		receipt.target.workflowUri !== envelope.target.workflowUri ||
		receipt.target.definitionDigest !== envelope.target.definitionDigest ||
		receipt.status !== result.status
	) {
		throw new InvocationFault(
			"child_receipt_invalid",
			"child invocation did not return an exact witnessed receipt",
			502,
		);
	}
}
