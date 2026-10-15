import { createHash } from "node:crypto";
import {
	AGENT_TOOL_MANIFEST_SCHEMA,
	type AgentToolManifestV0,
	type EffectiveToolbeltV0,
	resolveEffectiveToolbelt,
	stableJson,
} from "./agent-tool-manifest.js";

export const AGENT_TOOL_GRANT_SCHEMA = "sophia.agent-toolbelt-grant.v1" as const;
export const GRANTED_TOOLBELT_SCHEMA = "sophia.granted-toolbelt.v1" as const;

export type EffectApprovalPolicy = "ordinary" | "notify" | "human-always";

export interface GrantFenceV1 {
	readonly graphIds?: readonly string[];
	readonly graphIdPrefixes?: readonly string[];
	readonly originPrefixes?: readonly string[];
	readonly branchPrefixes?: readonly string[];
	readonly resourcePrefixes?: readonly string[];
	readonly pathPrefixes?: readonly string[];
	/** Exact content digests of host-configured builder recipes this grant may select. */
	readonly builderRecipeDigests?: readonly string[];
	readonly maxPayloadBytes?: number;
	/** Maximum host-materialized lifetime for an ephemeral scratch cell. */
	readonly maxTtlHours?: number;
	readonly requiredScopeSchema?: string;
	readonly requiredDatasetObjectKind?: string;
}

export interface GrantQuotaV1 {
	readonly maxPerWave?: number;
	readonly maxPerDay?: number;
	readonly maxConcurrent?: number;
	readonly maxCostMicrousd?: number;
}

export interface GrantedCapabilityV1 {
	readonly capability: string;
	readonly operations: readonly string[];
	readonly access: "read" | "write";
	/** Default for operations without a narrower override. */
	readonly approvalPolicy: EffectApprovalPolicy;
	/** Exact per-operation consent boundary (for example publish/merge). */
	readonly operationPolicies?: Readonly<Record<string, EffectApprovalPolicy>>;
	readonly fence: GrantFenceV1;
	readonly quota: GrantQuotaV1;
}

export interface AgentToolGrantV1 {
	readonly schema: typeof AGENT_TOOL_GRANT_SCHEMA;
	readonly grantId: string;
	readonly subjectAgentId: string;
	readonly issuedBy: string;
	readonly authorityGraphId: string;
	readonly issuedAt: number;
	readonly notBefore?: number;
	readonly expiresAt?: number;
	readonly status: "active" | "suspended" | "revoked" | "expired";
	readonly capabilities: readonly GrantedCapabilityV1[];
	readonly sourceRefs: readonly string[];
}

export interface GrantedToolbeltV1 {
	readonly schema: typeof GRANTED_TOOLBELT_SCHEMA;
	readonly grantId: string;
	readonly grantDigest: string;
	readonly manifestId: string;
	readonly manifestHash: string;
	readonly agentId: string;
	readonly tools: EffectiveToolbeltV0["tools"];
	readonly capabilities: readonly GrantedCapabilityV1[];
	readonly suppressions: EffectiveToolbeltV0["suppressions"];
	readonly failures: EffectiveToolbeltV0["failures"];
	readonly resolvedAt: number;
}

export class GrantValidationError extends Error {
	constructor(
		readonly code:
			| "grant_invalid"
			| "grant_inactive"
			| "grant_not_yet_valid"
			| "grant_expired"
			| "grant_subject_mismatch"
			| "toolbelt_denied",
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "GrantValidationError";
	}
}

export function parseAgentToolManifest(value: unknown): AgentToolManifestV0 {
	const record = requireRecord(value, "tool manifest");
	if (record.schema !== AGENT_TOOL_MANIFEST_SCHEMA) {
		throw invalid(`expected tool manifest schema '${AGENT_TOOL_MANIFEST_SCHEMA}'`);
	}
	const manifest = value as AgentToolManifestV0;
	if (!text(manifest.manifestId) || !text(manifest.manifestUri) || !text(manifest.agentId)) {
		throw invalid("manifestId, manifestUri, and agentId are required");
	}
	if (!Number.isSafeInteger(manifest.version) || manifest.version < 1)
		throw invalid("manifest version must be positive");
	if (manifest.status !== "active") throw invalid("tool manifest is not active");
	if (!isRecord(manifest.policy) || !Array.isArray(manifest.capabilities) || !Array.isArray(manifest.tools)) {
		throw invalid("tool manifest policy, capabilities, and tools are required");
	}
	const names = new Set<string>();
	for (const tool of manifest.tools) {
		if (!isRecord(tool) || !text(tool.name) || !text(tool.capability))
			throw invalid("every tool needs a name and capability");
		if (typeof tool.destructive !== "boolean") throw invalid(`tool '${tool.name}' needs a destructive boolean`);
		if (names.has(tool.name)) throw invalid(`duplicate tool declaration '${tool.name}'`);
		names.add(tool.name);
	}
	return manifest;
}

export function parseAgentToolGrant(value: unknown): AgentToolGrantV1 {
	const record = requireRecord(value, "toolbelt grant");
	if (record.schema !== AGENT_TOOL_GRANT_SCHEMA) {
		throw invalid(`expected grant schema '${AGENT_TOOL_GRANT_SCHEMA}'`);
	}
	const grant = value as unknown as AgentToolGrantV1;
	for (const [label, field] of [
		["grantId", grant.grantId],
		["subjectAgentId", grant.subjectAgentId],
		["issuedBy", grant.issuedBy],
		["authorityGraphId", grant.authorityGraphId],
	] as const) {
		if (!text(field)) throw invalid(`${label} is required`);
	}
	if (!Number.isFinite(grant.issuedAt)) throw invalid("issuedAt must be a finite epoch millisecond value");
	if (grant.notBefore !== undefined && !Number.isFinite(grant.notBefore)) throw invalid("notBefore must be finite");
	if (grant.expiresAt !== undefined && !Number.isFinite(grant.expiresAt)) throw invalid("expiresAt must be finite");
	if (!(["active", "suspended", "revoked", "expired"] as const).includes(grant.status)) {
		throw invalid("grant status is unsupported");
	}
	if (!Array.isArray(grant.capabilities) || grant.capabilities.length === 0) {
		throw invalid("grant capabilities must be non-empty");
	}
	const seen = new Set<string>();
	for (const capability of grant.capabilities) {
		if (!isRecord(capability) || !text(capability.capability)) throw invalid("capability name is required");
		if (seen.has(capability.capability)) throw invalid(`duplicate capability grant '${capability.capability}'`);
		seen.add(capability.capability);
		if (!Array.isArray(capability.operations) || capability.operations.some((operation) => !text(operation))) {
			throw invalid(`capability '${capability.capability}' operations must be strings`);
		}
		if (capability.access !== "read" && capability.access !== "write")
			throw invalid("capability access is unsupported");
		if (!(<readonly unknown[]>["ordinary", "notify", "human-always"]).includes(capability.approvalPolicy)) {
			throw invalid("capability approvalPolicy is unsupported");
		}
		if (capability.operationPolicies !== undefined) {
			if (!isRecord(capability.operationPolicies)) throw invalid("operationPolicies must be an object");
			for (const [operation, policy] of Object.entries(capability.operationPolicies)) {
				if (
					!text(operation) ||
					(!capability.operations.includes(operation) && !capability.operations.includes("*"))
				) {
					throw invalid(`operation policy '${operation}' is not present in the capability operations`);
				}
				if (!(<readonly unknown[]>["ordinary", "notify", "human-always"]).includes(policy)) {
					throw invalid(`operation policy '${operation}' is unsupported`);
				}
			}
		}
		validateFence(capability.fence, capability.capability);
		validateQuota(capability.quota, capability.capability);
	}
	if (!Array.isArray(grant.sourceRefs) || grant.sourceRefs.some((ref) => !text(ref))) {
		throw invalid("sourceRefs must be strings");
	}
	return grant;
}

export function grantDigest(grant: AgentToolGrantV1): string {
	return createHash("sha256").update(stableJson(grant)).digest("hex");
}

export function assertGrantActive(grant: AgentToolGrantV1, agentId: string, now = Date.now()): void {
	if (grant.subjectAgentId !== agentId) {
		throw new GrantValidationError("grant_subject_mismatch", "grant subject does not match the registered agent", {
			expected: agentId,
			actual: grant.subjectAgentId,
		});
	}
	if (grant.status !== "active") throw new GrantValidationError("grant_inactive", `grant is ${grant.status}`);
	if (grant.notBefore !== undefined && now < grant.notBefore) {
		throw new GrantValidationError("grant_not_yet_valid", "grant is not valid yet", { notBefore: grant.notBefore });
	}
	if (grant.expiresAt !== undefined && now >= grant.expiresAt) {
		throw new GrantValidationError("grant_expired", "grant has expired", { expiresAt: grant.expiresAt });
	}
}

/**
 * Intersect an agent-authored declaration with a steward-issued grant. Missing,
 * narrower, or expired authority can only remove tools; it can never add one.
 */
export function reconcileToolbeltWithGrant(input: {
	manifest: AgentToolManifestV0;
	grant: AgentToolGrantV1;
	now?: number;
}): GrantedToolbeltV1 {
	const now = input.now ?? Date.now();
	assertGrantActive(input.grant, input.manifest.agentId, now);
	const declared = resolveEffectiveToolbelt(input.manifest, { now });
	const byCapability = new Map(input.grant.capabilities.map((capability) => [capability.capability, capability]));
	const suppressions = [...declared.suppressions];
	const failures = [...declared.failures];
	const tools = declared.tools.filter((tool) => {
		const authorized = byCapability.get(tool.capability);
		const operationAllowed =
			authorized && (authorized.operations.includes(tool.name) || authorized.operations.includes("*"));
		const accessAllowed = authorized && (authorized.access === "write" || tool.access === "read");
		if (operationAllowed && accessAllowed) return true;
		suppressions.push({ name: tool.name, reason: "denied", toolUri: tool.toolUri, source: "policy" });
		if (tool.required) {
			failures.push({
				name: tool.name,
				toolUri: tool.toolUri,
				required: true,
				reason: !authorized
					? "capability is absent from grant"
					: !operationAllowed
						? "tool operation is absent from grant"
						: "grant access is narrower than the required tool",
			});
		}
		return false;
	});
	return {
		schema: GRANTED_TOOLBELT_SCHEMA,
		grantId: input.grant.grantId,
		grantDigest: grantDigest(input.grant),
		manifestId: declared.manifestId,
		manifestHash: declared.manifestHash,
		agentId: declared.agentId,
		tools,
		capabilities: input.grant.capabilities,
		suppressions,
		failures,
		resolvedAt: now,
	};
}

export function assertGrantedToolbelt(toolbelt: GrantedToolbeltV1): void {
	if (toolbelt.failures.length > 0) {
		throw new GrantValidationError("toolbelt_denied", "required declared tools are not authorized", {
			failures: toolbelt.failures,
		});
	}
}

export function findGrantedCapability(
	grant: AgentToolGrantV1,
	capability: string,
	operation: string,
): GrantedCapabilityV1 | undefined {
	return grant.capabilities.find(
		(candidate) =>
			candidate.capability === capability &&
			(candidate.operations.includes(operation) || candidate.operations.includes("*")),
	);
}

export function effectApprovalPolicyFor(capability: GrantedCapabilityV1, operation: string): EffectApprovalPolicy {
	return capability.operationPolicies?.[operation] ?? capability.approvalPolicy;
}

function validateFence(value: unknown, capability: string): void {
	if (!isRecord(value)) throw invalid(`capability '${capability}' fence must be an object`);
	const allowed = new Set([
		"graphIds",
		"graphIdPrefixes",
		"originPrefixes",
		"branchPrefixes",
		"resourcePrefixes",
		"pathPrefixes",
		"builderRecipeDigests",
		"maxPayloadBytes",
		"maxTtlHours",
		"requiredScopeSchema",
		"requiredDatasetObjectKind",
	]);
	for (const field of Object.keys(value))
		if (!allowed.has(field)) throw invalid(`capability '${capability}' fence contains unknown field '${field}'`);
	for (const field of [
		"graphIds",
		"graphIdPrefixes",
		"originPrefixes",
		"branchPrefixes",
		"resourcePrefixes",
		"pathPrefixes",
	]) {
		const entries = value[field];
		if (entries !== undefined && (!Array.isArray(entries) || entries.some((entry) => !text(entry)))) {
			throw invalid(`capability '${capability}' fence.${field} must be strings`);
		}
	}
	if (
		value.builderRecipeDigests !== undefined &&
		(!Array.isArray(value.builderRecipeDigests) ||
			value.builderRecipeDigests.length === 0 ||
			value.builderRecipeDigests.some((digest) => typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)))
	) {
		throw invalid(`capability '${capability}' fence.builderRecipeDigests must be lowercase SHA-256 digests`);
	}
	if (
		value.maxPayloadBytes !== undefined &&
		(!Number.isSafeInteger(value.maxPayloadBytes) || value.maxPayloadBytes < 0)
	) {
		throw invalid(`capability '${capability}' fence.maxPayloadBytes must be non-negative`);
	}
	if (value.maxTtlHours !== undefined && (!Number.isSafeInteger(value.maxTtlHours) || value.maxTtlHours < 1)) {
		throw invalid(`capability '${capability}' fence.maxTtlHours must be positive`);
	}
	for (const field of ["requiredScopeSchema", "requiredDatasetObjectKind"]) {
		const textValue = value[field];
		if (textValue !== undefined && (typeof textValue !== "string" || !textValue.trim() || textValue.length > 256))
			throw invalid(`capability '${capability}' fence.${field} must be a bounded non-empty string`);
	}
}

function validateQuota(value: unknown, capability: string): void {
	if (!isRecord(value)) throw invalid(`capability '${capability}' quota must be an object`);
	for (const field of ["maxPerWave", "maxPerDay", "maxConcurrent", "maxCostMicrousd"]) {
		const quota = value[field];
		if (quota !== undefined && (!Number.isSafeInteger(quota) || quota < 0)) {
			throw invalid(`capability '${capability}' quota.${field} must be non-negative`);
		}
	}
}

function invalid(message: string): GrantValidationError {
	return new GrantValidationError("grant_invalid", message);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw invalid(`${label} must be an object`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): value is string {
	return typeof value === "string" && Boolean(value.trim());
}
