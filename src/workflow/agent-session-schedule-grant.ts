import { createHash } from "node:crypto";
import { canonicalJson } from "../agent-subject/canonical-json.js";
import { requireCanonicalGraphOwnerPrincipal } from "../graph-owner-principal.js";
import {
	type AgentToolGrantV1,
	assertGrantActive,
	assertGrantedToolbelt,
	type GrantedCapabilityV1,
	type GrantedToolbeltV1,
	grantDigest,
	parseAgentToolGrant,
} from "./agent-tool-grant.js";
import type {
	ApprovalPolicy,
	MountedTool,
	ProvenanceRequirement,
	ToolMountFailure,
	ToolSuppression,
} from "./agent-tool-manifest.js";

export const AGENT_SESSION_SCHEDULE_GRANT_SNAPSHOT_SCHEMA =
	"choreograph.agent-session-schedule-grant-snapshot.v1" as const;
export const AGENT_SESSION_SCHEDULE_GRANT_BINDING_SCHEMA =
	"choreograph.agent-session-schedule-grant-binding.v1" as const;

/**
 * Exact Session-bound authority from which a later host may mint fresh
 * service-auth adapters. Credentials and adapter closures are never durable.
 */
export interface AgentSessionScheduleGrantSnapshotV1 {
	readonly schema: typeof AGENT_SESSION_SCHEDULE_GRANT_SNAPSHOT_SCHEMA;
	readonly agentId: string;
	readonly runtimeBindingDigest: string;
	readonly agentOntologyDigest: string;
	readonly ownerUserId: string;
	readonly graphOwnerPrincipal: string;
	readonly graphId: string;
	/** The grant's authority graph; deliberately distinct from the execution graph. */
	readonly grantAuthorityGraphId: string;
	readonly grantAuthorityOwnerPrincipal: string;
	readonly grantDocumentId: string;
	readonly grant: AgentToolGrantV1;
	readonly toolbelt: GrantedToolbeltV1;
	readonly capturedAt: number;
}

/** Stored on the Session; schedules pin the digest, never ambient closures. */
export interface AgentSessionScheduleGrantBindingV1 {
	readonly schema: typeof AGENT_SESSION_SCHEDULE_GRANT_BINDING_SCHEMA;
	readonly digest: string;
	readonly snapshot: AgentSessionScheduleGrantSnapshotV1;
}

export interface AgentSessionScheduleGrantSessionIdentityV1 {
	readonly agentId: string;
	readonly runtimeBindingDigest: string;
	readonly agentOntologyDigest: string;
	readonly ownerUserId: string;
	readonly graphOwnerPrincipal: string;
	readonly graphId: string;
	readonly now: number;
}

export class AgentSessionScheduleGrantValidationError extends Error {
	readonly code = "agent_session_schedule_grant_invalid" as const;

	constructor(
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "AgentSessionScheduleGrantValidationError";
	}
}

export function agentSessionScheduleGrantSnapshotDigest(snapshot: AgentSessionScheduleGrantSnapshotV1): string {
	return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

export function bindAgentSessionScheduleGrantSnapshot(
	snapshot: AgentSessionScheduleGrantSnapshotV1,
): AgentSessionScheduleGrantBindingV1 {
	return {
		schema: AGENT_SESSION_SCHEDULE_GRANT_BINDING_SCHEMA,
		digest: agentSessionScheduleGrantSnapshotDigest(snapshot),
		snapshot,
	};
}

/**
 * Parse the durable binding at the trust boundary. This deliberately accepts
 * unknown rather than a TypeScript-shaped value: JSON persisted by an older or
 * compromised host must not acquire authority by being cast.
 */
export function parseAgentSessionScheduleGrantBinding(value: unknown): AgentSessionScheduleGrantBindingV1 {
	const binding = record(value, "grant binding");
	exactKeys(binding, ["schema", "digest", "snapshot"], "grant binding");
	if (binding.schema !== AGENT_SESSION_SCHEDULE_GRANT_BINDING_SCHEMA) {
		invalid("grant binding schema is unsupported");
	}
	const digest = digest64(binding.digest, "grant binding digest");
	const snapshot = parseSnapshot(binding.snapshot);
	const expectedDigest = agentSessionScheduleGrantSnapshotDigest(snapshot);
	if (digest !== expectedDigest) {
		invalid("grant binding digest does not match the canonical snapshot", {
			expected: expectedDigest,
			actual: digest,
		});
	}
	return { schema: AGENT_SESSION_SCHEDULE_GRANT_BINDING_SCHEMA, digest, snapshot };
}

/**
 * Verify that a parsed binding is still for the exact Session authority that
 * admitted it. No graph lookup or adapter minting occurs here; those belong to
 * the host activation edge after this pure check succeeds.
 */
export function verifyAgentSessionScheduleGrantBinding(
	value: unknown,
	expected: AgentSessionScheduleGrantSessionIdentityV1,
): AgentSessionScheduleGrantSnapshotV1 {
	const binding = parseAgentSessionScheduleGrantBinding(value);
	if (!Number.isFinite(expected.now)) invalid("expected Session time must be finite");
	if (binding.snapshot.capturedAt > expected.now) {
		invalid("grant snapshot was captured in the future", {
			capturedAt: binding.snapshot.capturedAt,
			now: expected.now,
		});
	}
	const identity: ReadonlyArray<readonly [string, string, string]> = [
		["agentId", binding.snapshot.agentId, expected.agentId],
		["runtimeBindingDigest", binding.snapshot.runtimeBindingDigest, expected.runtimeBindingDigest],
		["agentOntologyDigest", binding.snapshot.agentOntologyDigest, expected.agentOntologyDigest],
		["ownerUserId", binding.snapshot.ownerUserId, expected.ownerUserId],
		["graphOwnerPrincipal", binding.snapshot.graphOwnerPrincipal, expected.graphOwnerPrincipal],
		["graphId", binding.snapshot.graphId, expected.graphId],
	];
	for (const [field, actual, wanted] of identity) {
		if (actual !== wanted)
			invalid(`grant snapshot ${field} does not match the Session`, { expected: wanted, actual });
	}
	assertGrantActive(binding.snapshot.grant, binding.snapshot.agentId, expected.now);
	assertGrantedToolbelt(binding.snapshot.toolbelt);
	return binding.snapshot;
}

function parseSnapshot(value: unknown): AgentSessionScheduleGrantSnapshotV1 {
	const snapshot = record(value, "grant snapshot");
	exactKeys(
		snapshot,
		[
			"schema",
			"agentId",
			"runtimeBindingDigest",
			"agentOntologyDigest",
			"ownerUserId",
			"graphOwnerPrincipal",
			"graphId",
			"grantAuthorityGraphId",
			"grantAuthorityOwnerPrincipal",
			"grantDocumentId",
			"grant",
			"toolbelt",
			"capturedAt",
		],
		"grant snapshot",
	);
	if (snapshot.schema !== AGENT_SESSION_SCHEDULE_GRANT_SNAPSHOT_SCHEMA)
		invalid("grant snapshot schema is unsupported");
	const agentId = text(snapshot.agentId, "snapshot agentId");
	// Session runtime and ontology bindings use the production `sha256:<hex>`
	// representation.  Grant/toolbelt content digests deliberately remain bare
	// hex, so their parser stays separate below.
	const runtimeBindingDigest = sha256Digest(snapshot.runtimeBindingDigest, "runtime binding digest");
	const agentOntologyDigest = sha256Digest(snapshot.agentOntologyDigest, "agent ontology digest");
	const ownerUserId = text(snapshot.ownerUserId, "snapshot ownerUserId");
	const graphOwnerPrincipal = graphOwner(snapshot.graphOwnerPrincipal, "snapshot graph owner principal");
	const graphId = text(snapshot.graphId, "snapshot graphId");
	const grantAuthorityGraphId = text(snapshot.grantAuthorityGraphId, "grant authority graph ID");
	const grantAuthorityOwnerPrincipal = graphOwner(
		snapshot.grantAuthorityOwnerPrincipal,
		"grant authority owner principal",
	);
	const grantDocumentId = text(snapshot.grantDocumentId, "grant document ID");
	if (!Number.isFinite(snapshot.capturedAt) || snapshot.capturedAt < 0)
		invalid("snapshot capturedAt must be a non-negative epoch");

	const grant = parseGrant(snapshot.grant);
	const toolbelt = parseToolbelt(snapshot.toolbelt);
	if (grant.subjectAgentId !== agentId) invalid("grant subject does not match snapshot agentId");
	if (grant.authorityGraphId !== grantAuthorityGraphId)
		invalid("grant authority graph does not match snapshot grantAuthorityGraphId");
	if (grant.issuedBy !== grantAuthorityOwnerPrincipal) invalid("grant issuer does not match grant authority owner");
	if (toolbelt.agentId !== agentId) invalid("toolbelt agent does not match snapshot agentId");
	if (toolbelt.grantId !== grant.grantId) invalid("toolbelt grantId does not match grant");
	if (toolbelt.grantDigest !== grantDigest(grant)) invalid("toolbelt grantDigest does not match grant");
	if (canonicalJson(toolbelt.capabilities) !== canonicalJson(grant.capabilities)) {
		invalid("toolbelt capabilities do not exactly match grant capabilities");
	}
	validateToolProjection(toolbelt.tools, grant.capabilities);
	assertGrantedToolbelt(toolbelt);
	return {
		schema: AGENT_SESSION_SCHEDULE_GRANT_SNAPSHOT_SCHEMA,
		agentId,
		runtimeBindingDigest,
		agentOntologyDigest,
		ownerUserId,
		graphOwnerPrincipal,
		graphId,
		grantAuthorityGraphId,
		grantAuthorityOwnerPrincipal,
		grantDocumentId,
		grant,
		toolbelt,
		capturedAt: snapshot.capturedAt,
	};
}

function parseGrant(value: unknown): AgentToolGrantV1 {
	const grant = record(value, "grant");
	exactKeys(
		grant,
		[
			"schema",
			"grantId",
			"subjectAgentId",
			"issuedBy",
			"authorityGraphId",
			"issuedAt",
			"notBefore",
			"expiresAt",
			"status",
			"capabilities",
			"sourceRefs",
		],
		"grant",
		["notBefore", "expiresAt"],
	);
	validateGrantCapabilities(grant.capabilities);
	const parsed = parseAgentToolGrant(grant);
	return parsed;
}

function parseToolbelt(value: unknown): GrantedToolbeltV1 {
	const toolbelt = record(value, "toolbelt");
	exactKeys(
		toolbelt,
		[
			"schema",
			"grantId",
			"grantDigest",
			"manifestId",
			"manifestHash",
			"agentId",
			"tools",
			"capabilities",
			"suppressions",
			"failures",
			"resolvedAt",
		],
		"toolbelt",
	);
	if (toolbelt.schema !== "sophia.granted-toolbelt.v1") invalid("toolbelt schema is unsupported");
	const grantIdValue = text(toolbelt.grantId, "toolbelt grantId");
	const grantDigestValue = digest64(toolbelt.grantDigest, "toolbelt grantDigest");
	const manifestId = text(toolbelt.manifestId, "toolbelt manifestId");
	const manifestHash = digest64(toolbelt.manifestHash, "toolbelt manifestHash");
	const agentId = text(toolbelt.agentId, "toolbelt agentId");
	if (!Array.isArray(toolbelt.tools)) invalid("toolbelt tools must be an array");
	const tools = toolbelt.tools.map((tool, index) => parseTool(tool, index));
	if (!Array.isArray(toolbelt.capabilities)) invalid("toolbelt capabilities must be an array");
	validateGrantCapabilities(toolbelt.capabilities);
	const capabilities = toolbelt.capabilities as readonly GrantedCapabilityV1[];
	if (!Array.isArray(toolbelt.suppressions)) invalid("toolbelt suppressions must be an array");
	const suppressions = toolbelt.suppressions.map((entry, index) => parseSuppression(entry, index));
	if (!Array.isArray(toolbelt.failures)) invalid("toolbelt failures must be an array");
	const failures = toolbelt.failures.map((entry, index) => parseFailure(entry, index));
	if (!Number.isFinite(toolbelt.resolvedAt) || toolbelt.resolvedAt < 0)
		invalid("toolbelt resolvedAt must be a non-negative epoch");
	const names = new Set<string>();
	for (const tool of tools) {
		if (names.has(tool.name)) invalid(`toolbelt contains duplicate tool '${tool.name}'`);
		names.add(tool.name);
	}
	return {
		schema: "sophia.granted-toolbelt.v1",
		grantId: grantIdValue,
		grantDigest: grantDigestValue,
		manifestId,
		manifestHash,
		agentId,
		tools,
		capabilities,
		suppressions,
		failures,
		resolvedAt: toolbelt.resolvedAt,
	};
}

function validateGrantCapabilities(value: unknown): void {
	if (!Array.isArray(value) || value.length === 0) invalid("grant capabilities must be a non-empty array");
	for (const [index, valueAtIndex] of value.entries()) {
		const capability = record(valueAtIndex, `capability ${index}`);
		exactKeys(
			capability,
			["capability", "operations", "access", "approvalPolicy", "operationPolicies", "fence", "quota"],
			`capability ${index}`,
			["operationPolicies"],
		);
		text(capability.capability, `capability ${index} name`);
		if (!Array.isArray(capability.operations) || capability.operations.length === 0) {
			invalid(`capability ${index} operations must be non-empty`);
		}
		for (const operation of capability.operations) text(operation, `capability ${index} operation`);
		if (capability.access !== "read" && capability.access !== "write")
			invalid(`capability ${index} access is unsupported`);
		approvalPolicy(capability.approvalPolicy, `capability ${index} approvalPolicy`);
		if (capability.operationPolicies !== undefined) {
			const policies = record(capability.operationPolicies, `capability ${index} operationPolicies`);
			for (const [operation, policy] of Object.entries(policies)) {
				text(operation, `capability ${index} operation policy name`);
				if (!capability.operations.includes(operation) && !capability.operations.includes("*")) {
					invalid(`capability ${index} operation policy is not granted`);
				}
				approvalPolicy(policy, `capability ${index} operation policy`);
			}
		}
		parseFence(capability.fence, index);
		parseQuota(capability.quota, index);
	}
}

function parseFence(value: unknown, index: number): void {
	const fence = record(value, `capability ${index} fence`);
	exactKeys(
		fence,
		[
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
		],
		`capability ${index} fence`,
		[
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
		],
	);
	for (const field of [
		"graphIds",
		"graphIdPrefixes",
		"originPrefixes",
		"branchPrefixes",
		"resourcePrefixes",
		"pathPrefixes",
	]) {
		const entries = fence[field];
		if (entries !== undefined) {
			if (!Array.isArray(entries)) invalid(`capability ${index} fence.${field} must be an array`);
			for (const entry of entries) text(entry, `capability ${index} fence.${field} entry`);
		}
	}
	if (fence.builderRecipeDigests !== undefined) {
		if (!Array.isArray(fence.builderRecipeDigests) || fence.builderRecipeDigests.length === 0) {
			invalid(`capability ${index} fence.builderRecipeDigests must be non-empty`);
		}
		for (const digest of fence.builderRecipeDigests) digest64(digest, `capability ${index} builder recipe digest`);
	}
	for (const field of ["maxPayloadBytes", "maxTtlHours"]) {
		const number = fence[field];
		if (number !== undefined && (!Number.isSafeInteger(number) || number < 0))
			invalid(`capability ${index} fence.${field} is invalid`);
	}
	for (const field of ["requiredScopeSchema", "requiredDatasetObjectKind"]) {
		const textValue = fence[field];
		if (textValue !== undefined && (typeof textValue !== "string" || !textValue.trim() || textValue.length > 256))
			invalid(`capability ${index} fence.${field} must be a bounded non-empty string`);
	}
}

function parseQuota(value: unknown, index: number): void {
	const quota = record(value, `capability ${index} quota`);
	exactKeys(quota, ["maxPerWave", "maxPerDay", "maxConcurrent", "maxCostMicrousd"], `capability ${index} quota`, [
		"maxPerWave",
		"maxPerDay",
		"maxConcurrent",
		"maxCostMicrousd",
	]);
	for (const field of ["maxPerWave", "maxPerDay", "maxConcurrent", "maxCostMicrousd"]) {
		const number = quota[field];
		if (number !== undefined && (!Number.isSafeInteger(number) || number < 0))
			invalid(`capability ${index} quota.${field} is invalid`);
	}
}

function parseTool(value: unknown, index: number): MountedTool {
	const tool = record(value, `tool ${index}`);
	exactKeys(
		tool,
		[
			"toolId",
			"toolUri",
			"name",
			"title",
			"description",
			"capability",
			"server",
			"access",
			"destructive",
			"risk",
			"required",
			"approvalPolicy",
			"requiresProvenance",
			"inputSchema",
			"outputSchema",
			"runtimeState",
			"available",
		],
		`tool ${index}`,
		["title", "description", "server", "requiresProvenance", "inputSchema", "outputSchema"],
	);
	const parsed = {
		toolId: text(tool.toolId, `tool ${index} toolId`),
		toolUri: text(tool.toolUri, `tool ${index} toolUri`),
		name: text(tool.name, `tool ${index} name`),
		...(tool.title === undefined ? {} : { title: text(tool.title, `tool ${index} title`) }),
		...(tool.description === undefined ? {} : { description: text(tool.description, `tool ${index} description`) }),
		capability: text(tool.capability, `tool ${index} capability`),
		...(tool.server === undefined ? {} : { server: text(tool.server, `tool ${index} server`) }),
		access: tool.access,
		destructive: tool.destructive,
		risk: tool.risk,
		required: tool.required,
		approvalPolicy: parseApprovalPolicy(tool.approvalPolicy, `tool ${index} approvalPolicy`),
		...(tool.requiresProvenance === undefined
			? {}
			: { requiresProvenance: parseProvenance(tool.requiresProvenance, `tool ${index} requiresProvenance`) }),
		...(tool.inputSchema === undefined
			? {}
			: { inputSchema: jsonValue(tool.inputSchema, `tool ${index} inputSchema`) }),
		...(tool.outputSchema === undefined
			? {}
			: { outputSchema: jsonValue(tool.outputSchema, `tool ${index} outputSchema`) }),
		runtimeState: tool.runtimeState,
		available: tool.available,
	};
	if (parsed.access !== "read" && parsed.access !== "write") invalid(`tool ${index} access is unsupported`);
	if (!(parsed.risk === "low" || parsed.risk === "medium" || parsed.risk === "high"))
		invalid(`tool ${index} risk is unsupported`);
	if (
		!(
			parsed.runtimeState === "mounted" ||
			parsed.runtimeState === "declared" ||
			parsed.runtimeState === "missing" ||
			parsed.runtimeState === "used"
		)
	) {
		invalid(`tool ${index} runtimeState is unsupported`);
	}
	if (typeof parsed.destructive !== "boolean") invalid(`tool ${index} destructive must be boolean`);
	if (parsed.destructive !== (parsed.access === "write")) invalid(`tool ${index} destructive projection drift`);
	if (typeof parsed.required !== "boolean" || typeof parsed.available !== "boolean")
		invalid(`tool ${index} boolean fields are invalid`);
	return parsed as MountedTool;
}

function parseSuppression(value: unknown, index: number): ToolSuppression {
	const suppression = record(value, `toolbelt suppression ${index}`);
	exactKeys(suppression, ["name", "reason", "toolUri", "source"], `toolbelt suppression ${index}`, ["toolUri"]);
	if (
		!(
			suppression.reason === "excluded" ||
			suppression.reason === "undeclared" ||
			suppression.reason === "retired" ||
			suppression.reason === "denied" ||
			suppression.reason === "hidden" ||
			suppression.reason === "not-discovered" ||
			suppression.reason === "tool-mode-none"
		)
	)
		invalid(`suppression ${index} reason is unsupported`);
	if (suppression.source !== "manifest" && suppression.source !== "policy" && suppression.source !== "runtime")
		invalid(`suppression ${index} source is unsupported`);
	return {
		name: text(suppression.name, `suppression ${index} name`),
		reason: suppression.reason as ToolSuppression["reason"],
		...(suppression.toolUri === undefined
			? {}
			: { toolUri: text(suppression.toolUri, `suppression ${index} toolUri`) }),
		source: suppression.source as ToolSuppression["source"],
	};
}

function parseFailure(value: unknown, index: number): ToolMountFailure {
	const failure = record(value, `toolbelt failure ${index}`);
	exactKeys(failure, ["name", "reason", "toolUri", "required"], `toolbelt failure ${index}`, ["toolUri", "required"]);
	if (failure.required !== undefined && typeof failure.required !== "boolean")
		invalid(`failure ${index} required must be boolean`);
	return {
		name: text(failure.name, `failure ${index} name`),
		reason: text(failure.reason, `failure ${index} reason`),
		...(failure.toolUri === undefined ? {} : { toolUri: text(failure.toolUri, `failure ${index} toolUri`) }),
		...(failure.required === undefined ? {} : { required: failure.required }),
	};
}

function validateToolProjection(tools: readonly MountedTool[], capabilities: readonly GrantedCapabilityV1[]): void {
	for (const tool of tools) {
		const capability = capabilities.find((candidate) => candidate.capability === tool.capability);
		if (!capability) invalid(`tool '${tool.name}' is not covered by a granted capability`);
		if (!capability.operations.includes("*") && !capability.operations.includes(tool.name)) {
			invalid(`tool '${tool.name}' is not covered by its granted capability`);
		}
		if (capability.access === "read" && tool.access !== "read")
			invalid(`tool '${tool.name}' widens read grant access`);
	}
}

function approvalPolicy(value: unknown, label: string): void {
	if (value !== "ordinary" && value !== "notify" && value !== "human-always") invalid(`${label} is unsupported`);
}

function parseApprovalPolicy(value: unknown, label: string): ApprovalPolicy {
	const policy = record(value, label);
	exactKeys(policy, ["mode", "driverRequired", "reason"], label, ["driverRequired", "reason"]);
	if (policy.mode !== "never" && policy.mode !== "on-risk" && policy.mode !== "always")
		invalid(`${label}.mode is unsupported`);
	if (policy.driverRequired !== undefined && typeof policy.driverRequired !== "boolean")
		invalid(`${label}.driverRequired must be boolean`);
	const mode = policy.mode;
	if (mode !== "never" && mode !== "on-risk" && mode !== "always") invalid(`${label}.mode is unsupported`);
	return {
		mode,
		...(policy.driverRequired === undefined ? {} : { driverRequired: policy.driverRequired }),
		...(policy.reason === undefined ? {} : { reason: text(policy.reason, `${label}.reason`) }),
	};
}

function parseProvenance(value: unknown, label: string): ProvenanceRequirement {
	const requirement = record(value, label);
	exactKeys(requirement, ["required", "acceptedSourceKinds", "notes"], label, ["notes"]);
	if (typeof requirement.required !== "boolean" || !Array.isArray(requirement.acceptedSourceKinds))
		invalid(`${label} is invalid`);
	const acceptedSourceKinds = requirement.acceptedSourceKinds.map((kind, index) =>
		text(kind, `${label}.acceptedSourceKinds[${index}]`),
	);
	return {
		required: requirement.required,
		acceptedSourceKinds,
		...(requirement.notes === undefined ? {} : { notes: text(requirement.notes, `${label}.notes`) }),
	};
}

function jsonValue(value: unknown, label: string): unknown {
	rejectNulDeep(value, label);
	return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
	const result = value as Record<string, unknown>;
	for (const key of Object.keys(result)) {
		if (key.includes("\0") || credentialLike(key)) invalid(`${label} contains a forbidden field name`, { key });
	}
	return result;
}

function exactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
	label: string,
	optional: readonly string[] = [],
): void {
	const allowed = new Set(keys);
	const optionalSet = new Set(optional);
	for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`${label} contains unknown field '${key}'`);
	for (const key of keys)
		if (!optionalSet.has(key) && !Object.hasOwn(value, key)) invalid(`${label} is missing '${key}'`);
}

function text(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0"))
		invalid(`${label} must be non-empty text`);
	return value;
}

function digest64(value: unknown, label: string): string {
	const parsed = text(value, label);
	if (!/^[0-9a-f]{64}$/.test(parsed)) invalid(`${label} must be a lowercase 64-hex SHA-256 digest`);
	return parsed;
}

function sha256Digest(value: unknown, label: string): string {
	const parsed = text(value, label);
	if (!/^sha256:[0-9a-f]{64}$/.test(parsed)) {
		invalid(`${label} must be a lowercase sha256:<64-hex> digest`);
	}
	return parsed;
}

function graphOwner(value: unknown, label: string): string {
	try {
		return requireCanonicalGraphOwnerPrincipal(value, label);
	} catch (error) {
		invalid(error instanceof Error ? error.message : `${label} is invalid`);
	}
}

function rejectNulDeep(value: unknown, label: string): void {
	if (typeof value === "string") {
		if (value.includes("\0")) invalid(`${label} contains NUL`);
		return;
	}
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) rejectNulDeep(item, `${label}[${index}]`);
		return;
	}
	if (value !== null && typeof value === "object") {
		for (const [key, item] of Object.entries(value)) rejectNulDeep(item, `${label}.${key}`);
	}
}

function credentialLike(key: string): boolean {
	return /(?:token|secret|password|credential|api[_-]?key|authentication|authorization|bearer|adapter|closure|private[_-]?key)/i.test(
		key,
	);
}

function invalid(message: string, details?: unknown): never {
	throw new AgentSessionScheduleGrantValidationError(message, details);
}
