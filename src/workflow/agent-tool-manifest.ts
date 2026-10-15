import { createHash } from "node:crypto";
import { mintAgentUri, mintToolUri, slug } from "../agent-subject/agent-ontology.js";
import { canonicalJson } from "../agent-subject/canonical-json.js";

export const AGENT_TOOL_MANIFEST_SCHEMA = "sophia.agent-tool-manifest.v0";
export const EFFECTIVE_TOOLBELT_SCHEMA = "sophia.effective-toolbelt.v0";
export const AGENT_WORLD_TOOLBELT_SCHEMA = "sophia.agent-world-toolbelt.v1";

export type ToolMode = "dynamic" | "curated" | "none";
export type McpProfile = "chat" | "familiar" | "full";
export type ToolAccess = "read" | "write";
export type ToolRisk = "low" | "medium" | "high";
export type ToolState = "declared" | "hidden" | "denied" | "retired";
export type CapabilityKind = "mnemosyne" | "discord" | "web" | "vehicle" | "workflow" | "kg" | "runtime";

export interface SourceRef {
	sourceKind: string;
	sourceLabel: string;
	externalId: string;
}

export interface ApprovalPolicy {
	mode: "never" | "on-risk" | "always";
	driverRequired?: boolean;
	reason?: string;
}

export interface ProvenanceRequirement {
	required: boolean;
	acceptedSourceKinds: string[];
	notes?: string;
}

export interface SchemaRef {
	schemaUri?: string;
	schemaHash?: string;
	inlineSchema?: unknown;
}

export interface AgentToolPolicy {
	toolMode: ToolMode;
	mcpProfile?: McpProfile;
	defaultAccess: ToolAccess;
	defaultRisk: ToolRisk;
	includeTools?: string[];
	excludeTools?: string[];
	requireApprovalFor?: Array<"write" | "dangerous" | "external-side-effect">;
	allowUndeclaredDiscoveredTools: boolean;
}

export interface CapabilityDeclaration {
	capabilityId: string;
	capabilityUri: string;
	name: string;
	kind: CapabilityKind;
	backend?: string;
	scope?: {
		graphId?: string;
		origin?: string;
		runId?: string;
		workspaceId?: string;
	};
	access: ToolAccess;
	risk: ToolRisk;
	approvalPolicy: ApprovalPolicy;
	sourceRefs: SourceRef[];
}

export interface ToolDeclaration {
	toolId: string;
	toolUri: string;
	name: string;
	title?: string;
	description?: string;
	capability: string;
	server?: string;
	access: ToolAccess;
	destructive: boolean;
	risk: ToolRisk;
	state: ToolState;
	required: boolean;
	approvalPolicy: ApprovalPolicy;
	requiresProvenance?: ProvenanceRequirement;
	inputSchemaRef?: SchemaRef;
	outputSchemaRef?: SchemaRef;
	aliases?: string[];
	sourceRefs: SourceRef[];
}

export interface AgentToolManifestV0 {
	schema: typeof AGENT_TOOL_MANIFEST_SCHEMA;
	manifestId: string;
	manifestUri: string;
	agentId: string;
	agentUri: string;
	version: number;
	status: "draft" | "active" | "superseded" | "retired";
	sourceRefs: SourceRef[];
	createdAt: number;
	updatedAt: number;
	declaredBy: {
		actorId: string;
		actorKind: "human" | "codex" | "service" | "agent";
	};
	policy: AgentToolPolicy;
	capabilities: CapabilityDeclaration[];
	tools: ToolDeclaration[];
	notes?: string;
}

export interface RuntimeToolDescriptor {
	name: string;
	description?: string;
	inputSchema?: unknown;
	outputSchema?: unknown;
	server?: string;
	destructive: boolean;
}

export interface MountedTool {
	toolId: string;
	toolUri: string;
	name: string;
	title?: string;
	description?: string;
	capability: string;
	server?: string;
	access: ToolAccess;
	destructive: boolean;
	risk: ToolRisk;
	required: boolean;
	approvalPolicy: ApprovalPolicy;
	requiresProvenance?: ProvenanceRequirement;
	inputSchema?: unknown;
	outputSchema?: unknown;
	runtimeState: "mounted" | "declared" | "missing" | "used";
	available: boolean;
}

export interface ToolSuppression {
	name: string;
	reason: "excluded" | "undeclared" | "retired" | "denied" | "hidden" | "not-discovered" | "tool-mode-none";
	toolUri?: string;
	source: "manifest" | "policy" | "runtime";
}

export interface ToolMountFailure {
	name: string;
	reason: string;
	toolUri?: string;
	required?: boolean;
}

export interface EffectiveToolbeltV0 {
	schema: typeof EFFECTIVE_TOOLBELT_SCHEMA;
	manifestId: string;
	manifestHash: string;
	manifestUri: string;
	agentId: string;
	agentUri: string;
	toolMode: ToolMode;
	mcpProfile?: McpProfile;
	capabilities: CapabilityDeclaration[];
	tools: MountedTool[];
	suppressions: ToolSuppression[];
	failures: ToolMountFailure[];
	includeTools: string[];
	excludeTools: string[];
	declaredToolCount: number;
	discoveredToolCount?: number;
	mountedToolCount: number;
	resolvedAt: number;
}

export interface CapabilityView {
	capabilityId: string;
	capabilityUri: string;
	name: string;
	kind: CapabilityKind;
	backend?: string;
	scope?: CapabilityDeclaration["scope"];
	access: ToolAccess;
	risk: ToolRisk;
	approvalPolicy: ApprovalPolicy;
}

export interface ToolDescriptorViewV1 {
	toolId: string;
	toolUri: string;
	name: string;
	title?: string;
	description?: string;
	capability: string;
	server?: string;
	access: ToolAccess;
	destructive: boolean;
	risk: ToolRisk;
	state: "declared" | "mounted" | "missing" | "hidden" | "denied" | "retired" | "used";
	required: boolean;
	available: boolean;
	approvalPolicy: ApprovalPolicy;
	requiresProvenance?: ProvenanceRequirement;
	inputSchema?: unknown;
	outputSchema?: unknown;
	recentUses?: number;
	lastUsedAt?: number;
}

export interface ToolbeltRegionV1 {
	schema: typeof AGENT_WORLD_TOOLBELT_SCHEMA;
	manifestId: string;
	manifestHash: string;
	manifestUri: string;
	toolMode: ToolMode;
	mcpProfile?: McpProfile;
	capabilities: CapabilityView[];
	tools: ToolDescriptorViewV1[];
	suppressions: ToolSuppression[];
	failures: ToolMountFailure[];
	counts: {
		declared: number;
		mounted: number;
		available: number;
		hidden: number;
		denied: number;
		failed: number;
		used: number;
	};
	lastRefreshedAt: number;
}

export interface ToolUseFacts {
	usedNames?: Iterable<string>;
	useCounts?: ReadonlyMap<string, number>;
	lastUsedAt?: ReadonlyMap<string, number>;
}

const NEVER_APPROVAL: ApprovalPolicy = { mode: "never" };
const PLATFORM_EVENT_PROVENANCE: ProvenanceRequirement = {
	required: true,
	acceptedSourceKinds: ["PlatformEvent"],
	notes: "Memory writes must cite a PlatformEvent source ref until richer tool-event subjects are filed.",
};

export function mintToolManifestUri(agentId: string, version = 1): string {
	return `${mintAgentUri(agentId)}:tool-manifest:${version}`;
}

export function mintCapabilityUriForName(agentId: string, name: string): string {
	return `${mintAgentUri(agentId)}:cap:${slug(name)}`;
}

export function manifestIdFromAgent(agentId: string, version = 1): string {
	return `atm_${createHash("sha256").update(`${agentId}:${version}`).digest("hex").slice(0, 16)}`;
}

export function hashManifest(manifest: Omit<AgentToolManifestV0, "manifestId"> | AgentToolManifestV0): string {
	const record = { ...(manifest as Record<string, unknown>) };
	delete record.manifestId;
	return createHash("sha256").update(stableJson(record)).digest("hex");
}

export function stableJson(value: unknown): string {
	return canonicalJson(value);
}

export function buildLearner1ToolManifest(input: {
	agentId: string;
	graphId: string;
	ownerUserId: string;
	now?: number;
	version?: number;
}): AgentToolManifestV0 {
	const now = input.now ?? Date.now();
	const version = input.version ?? 1;
	const agentUri = mintAgentUri(input.agentId);
	const sourceRefs = [
		sourceRef("Plan", "Agent tool manifest/toolbelt spec", "plans/agent-tool-manifest-toolbelt-spec-20260627.md"),
		sourceRef("PlatformEvent", "learner-1 profile materialization", `learner-1:${input.agentId}`),
	];
	const capability: CapabilityDeclaration = {
		capabilityId: "cap_mnemosyne_graph_memory",
		capabilityUri: mintCapabilityUriForName(input.agentId, "mnemosyne"),
		name: "mnemosyne",
		kind: "mnemosyne",
		backend: "garden-mcp",
		scope: { graphId: input.graphId },
		access: "write",
		risk: "medium",
		approvalPolicy: NEVER_APPROVAL,
		sourceRefs,
	};
	const policy: AgentToolPolicy = {
		toolMode: "dynamic",
		mcpProfile: "chat",
		defaultAccess: "read",
		defaultRisk: "low",
		includeTools: ["recall", "search_documents", "remember"],
		excludeTools: [],
		requireApprovalFor: [],
		allowUndeclaredDiscoveredTools: false,
	};
	const manifestSeed: AgentToolManifestV0 = {
		schema: AGENT_TOOL_MANIFEST_SCHEMA,
		manifestId: manifestIdFromAgent(input.agentId, version),
		manifestUri: mintToolManifestUri(input.agentId, version),
		agentId: input.agentId,
		agentUri,
		version,
		status: "active",
		sourceRefs,
		createdAt: now,
		updatedAt: now,
		declaredBy: { actorId: input.ownerUserId, actorKind: "human" },
		policy,
		capabilities: [capability],
		tools: [
			learnerTool(input.agentId, {
				name: "recall",
				title: "Recall",
				description: "Read recent Geist memory queue context for this agent witness.",
				access: "read",
				risk: "low",
				required: true,
				inputSchema: { type: "object", properties: { query: { type: "string" } } },
				sourceRefs,
			}),
			learnerTool(input.agentId, {
				name: "search_documents",
				title: "Search Documents",
				description: "Search graph documents by title/path before reading or remembering.",
				access: "read",
				risk: "low",
				required: true,
				inputSchema: {
					type: "object",
					properties: { query: { type: "string" }, limit: { type: "integer" } },
					required: ["query"],
				},
				sourceRefs,
			}),
			learnerTool(input.agentId, {
				name: "remember",
				title: "Remember",
				description: "Write durable memory with source_refs provenance.",
				access: "write",
				risk: "medium",
				required: true,
				requiresProvenance: PLATFORM_EVENT_PROVENANCE,
				inputSchema: {
					type: "object",
					properties: {
						content: { type: "string" },
						source_refs: { type: "array", items: { type: "object" } },
					},
					required: ["content", "source_refs"],
				},
				sourceRefs,
			}),
		],
		notes: "learner-1 starts allowlist-first: recall, search_documents, remember.",
	};
	return { ...manifestSeed, manifestId: manifestIdFromAgent(input.agentId, version) };
}

export function resolveEffectiveToolbelt(
	manifest: AgentToolManifestV0,
	options?: {
		discoveredTools?: readonly RuntimeToolDescriptor[];
		mountedNames?: Iterable<string>;
		now?: number;
	},
): EffectiveToolbeltV0 {
	const now = options?.now ?? Date.now();
	const manifestHash = hashManifest(manifest);
	const declaredByName = new Map(manifest.tools.map((tool) => [tool.name, tool]));
	const discoveredByName = options?.discoveredTools
		? new Map(options.discoveredTools.map((tool) => [tool.name, tool]))
		: undefined;
	const mountedNames = options?.mountedNames ? new Set(options.mountedNames) : undefined;
	const includeSet = manifest.policy.includeTools ? new Set(manifest.policy.includeTools) : undefined;
	const excludeSet = new Set(manifest.policy.excludeTools ?? []);
	const suppressions: ToolSuppression[] = [];
	const failures: ToolMountFailure[] = [];

	if (manifest.policy.toolMode === "none") {
		for (const tool of manifest.tools) {
			suppressions.push({ name: tool.name, reason: "tool-mode-none", toolUri: tool.toolUri, source: "policy" });
		}
		return emptyEffective(manifest, manifestHash, suppressions, failures, now);
	}

	const allowedNames = new Set<string>();
	for (const tool of manifest.tools) {
		if (tool.state === "retired" || tool.state === "hidden" || tool.state === "denied") {
			suppressions.push({ name: tool.name, reason: tool.state, toolUri: tool.toolUri, source: "manifest" });
			continue;
		}
		if (includeSet && !includeSet.has(tool.name)) {
			suppressions.push({ name: tool.name, reason: "not-discovered", toolUri: tool.toolUri, source: "policy" });
			continue;
		}
		if (excludeSet.has(tool.name)) {
			suppressions.push({ name: tool.name, reason: "excluded", toolUri: tool.toolUri, source: "policy" });
			continue;
		}
		allowedNames.add(tool.name);
	}

	if (includeSet) {
		for (const name of includeSet) {
			const declared = declaredByName.get(name);
			if (!declared && !manifest.policy.allowUndeclaredDiscoveredTools) {
				suppressions.push({ name, reason: "undeclared", source: "policy" });
				continue;
			}
			if (!excludeSet.has(name)) allowedNames.add(name);
		}
	}

	if (manifest.policy.allowUndeclaredDiscoveredTools && discoveredByName) {
		for (const [name] of discoveredByName) {
			if (!excludeSet.has(name) && (!includeSet || includeSet.has(name))) allowedNames.add(name);
		}
	}

	const tools: MountedTool[] = [];
	for (const name of [...allowedNames].sort()) {
		const discovered = discoveredByName?.get(name);
		const declaration = declaredByName.get(name) ?? inferredDeclaration(manifest, name, discovered);
		const discoveredMissing = discoveredByName !== undefined && !discovered;
		const mounted = mountedNames ? mountedNames.has(name) : !discoveredMissing;
		const runtimeState: MountedTool["runtimeState"] = mounted
			? "mounted"
			: discoveredMissing
				? "missing"
				: "declared";

		if (discoveredMissing) {
			const failure = {
				name,
				reason: "declared tool was not discovered by the MCP runtime",
				toolUri: declaration.toolUri,
				required: declaration.required,
			};
			if (declaration.required) failures.push(failure);
			suppressions.push({ name, reason: "not-discovered", toolUri: declaration.toolUri, source: "runtime" });
		}

		tools.push({
			toolId: declaration.toolId,
			toolUri: declaration.toolUri,
			name,
			title: declaration.title,
			description: discovered?.description ?? declaration.description,
			capability: declaration.capability,
			server: discovered?.server ?? declaration.server,
			access: declaration.access,
			destructive: declaration.destructive,
			risk: declaration.risk,
			required: declaration.required,
			approvalPolicy: declaration.approvalPolicy,
			requiresProvenance: declaration.requiresProvenance,
			inputSchema: discovered?.inputSchema ?? declaration.inputSchemaRef?.inlineSchema,
			outputSchema: discovered?.outputSchema ?? declaration.outputSchemaRef?.inlineSchema,
			runtimeState,
			available: mounted,
		});
	}

	if (discoveredByName) {
		for (const [name] of discoveredByName) {
			if (allowedNames.has(name) || excludeSet.has(name)) continue;
			suppressions.push({ name, reason: "undeclared", source: "runtime" });
		}
		for (const name of excludeSet) {
			if (discoveredByName.has(name)) {
				suppressions.push({
					name,
					reason: "excluded",
					toolUri: declaredByName.get(name)?.toolUri,
					source: "policy",
				});
			}
		}
	}

	return {
		schema: EFFECTIVE_TOOLBELT_SCHEMA,
		manifestId: manifest.manifestId,
		manifestHash,
		manifestUri: manifest.manifestUri,
		agentId: manifest.agentId,
		agentUri: manifest.agentUri,
		toolMode: manifest.policy.toolMode,
		mcpProfile: manifest.policy.mcpProfile,
		capabilities: manifest.capabilities,
		tools,
		suppressions: dedupeSuppressions(suppressions),
		failures,
		includeTools: manifest.policy.includeTools ?? [],
		excludeTools: manifest.policy.excludeTools ?? [],
		declaredToolCount: manifest.tools.filter((tool) => tool.state === "declared").length,
		discoveredToolCount: discoveredByName?.size,
		mountedToolCount: tools.filter((tool) => tool.available).length,
		resolvedAt: now,
	};
}

export function toolbeltRegionFromEffective(effective: EffectiveToolbeltV0, uses?: ToolUseFacts): ToolbeltRegionV1 {
	const usedNames = new Set(uses?.usedNames ?? []);
	const tools = effective.tools.map((tool): ToolDescriptorViewV1 => {
		const useCount = uses?.useCounts?.get(tool.name) ?? (usedNames.has(tool.name) ? 1 : 0);
		return {
			toolId: tool.toolId,
			toolUri: tool.toolUri,
			name: tool.name,
			title: tool.title,
			description: tool.description,
			capability: tool.capability,
			server: tool.server,
			access: tool.access,
			destructive: tool.destructive,
			risk: tool.risk,
			state: useCount > 0 ? "used" : tool.runtimeState,
			required: tool.required,
			available: tool.available,
			approvalPolicy: tool.approvalPolicy,
			requiresProvenance: tool.requiresProvenance,
			inputSchema: tool.inputSchema,
			outputSchema: tool.outputSchema,
			recentUses: useCount,
			lastUsedAt: uses?.lastUsedAt?.get(tool.name),
		};
	});
	const hidden = effective.suppressions.filter((entry) => entry.reason === "hidden").length;
	const denied = effective.suppressions.filter(
		(entry) => entry.reason === "denied" || entry.reason === "excluded",
	).length;
	return {
		schema: AGENT_WORLD_TOOLBELT_SCHEMA,
		manifestId: effective.manifestId,
		manifestHash: effective.manifestHash,
		manifestUri: effective.manifestUri,
		toolMode: effective.toolMode,
		mcpProfile: effective.mcpProfile,
		capabilities: effective.capabilities.map((capability) => ({
			capabilityId: capability.capabilityId,
			capabilityUri: capability.capabilityUri,
			name: capability.name,
			kind: capability.kind,
			backend: capability.backend,
			scope: capability.scope,
			access: capability.access,
			risk: capability.risk,
			approvalPolicy: capability.approvalPolicy,
		})),
		tools,
		suppressions: effective.suppressions,
		failures: effective.failures,
		counts: {
			declared: effective.declaredToolCount,
			mounted: effective.mountedToolCount,
			available: tools.filter((tool) => tool.available).length,
			hidden,
			denied,
			failed: effective.failures.length,
			used: tools.filter((tool) => (tool.recentUses ?? 0) > 0).length,
		},
		lastRefreshedAt: effective.resolvedAt,
	};
}

function learnerTool(
	agentId: string,
	input: {
		name: string;
		title: string;
		description: string;
		access: ToolAccess;
		risk: ToolRisk;
		required: boolean;
		inputSchema: unknown;
		requiresProvenance?: ProvenanceRequirement;
		sourceRefs: SourceRef[];
	},
): ToolDeclaration {
	const toolUri = mintToolUri(agentId, input.name);
	return {
		toolId: `tool_${slug(input.name)}`,
		toolUri,
		name: input.name,
		title: input.title,
		description: input.description,
		capability: "mnemosyne",
		server: "mnemosyne",
		access: input.access,
		destructive: input.access === "write",
		risk: input.risk,
		state: "declared",
		required: input.required,
		approvalPolicy: NEVER_APPROVAL,
		requiresProvenance: input.requiresProvenance,
		inputSchemaRef: {
			schemaHash: createHash("sha256").update(stableJson(input.inputSchema)).digest("hex"),
			inlineSchema: input.inputSchema,
		},
		sourceRefs: input.sourceRefs,
	};
}

function inferredDeclaration(
	manifest: AgentToolManifestV0,
	name: string,
	discovered: RuntimeToolDescriptor | undefined,
): ToolDeclaration {
	return {
		toolId: `tool_${slug(name)}`,
		toolUri: mintToolUri(manifest.agentId, name),
		name,
		capability: "mnemosyne",
		server: "mnemosyne",
		access: manifest.policy.defaultAccess,
		destructive: discovered?.destructive ?? manifest.policy.defaultAccess === "write",
		risk: manifest.policy.defaultRisk,
		state: "declared",
		required: false,
		approvalPolicy: NEVER_APPROVAL,
		sourceRefs: manifest.sourceRefs,
	};
}

function emptyEffective(
	manifest: AgentToolManifestV0,
	manifestHash: string,
	suppressions: ToolSuppression[],
	failures: ToolMountFailure[],
	now: number,
): EffectiveToolbeltV0 {
	return {
		schema: EFFECTIVE_TOOLBELT_SCHEMA,
		manifestId: manifest.manifestId,
		manifestHash,
		manifestUri: manifest.manifestUri,
		agentId: manifest.agentId,
		agentUri: manifest.agentUri,
		toolMode: manifest.policy.toolMode,
		mcpProfile: manifest.policy.mcpProfile,
		capabilities: manifest.capabilities,
		tools: [],
		suppressions,
		failures,
		includeTools: manifest.policy.includeTools ?? [],
		excludeTools: manifest.policy.excludeTools ?? [],
		declaredToolCount: manifest.tools.filter((tool) => tool.state === "declared").length,
		mountedToolCount: 0,
		resolvedAt: now,
	};
}

function sourceRef(sourceKind: string, sourceLabel: string, externalId: string): SourceRef {
	return { sourceKind, sourceLabel, externalId };
}

function dedupeSuppressions(entries: ToolSuppression[]): ToolSuppression[] {
	const seen = new Set<string>();
	const out: ToolSuppression[] = [];
	for (const entry of entries) {
		const key = `${entry.name}:${entry.reason}:${entry.source}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(entry);
	}
	return out;
}
