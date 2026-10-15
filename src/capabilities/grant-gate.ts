import {
	AgentModeApprovalRequiredError,
	AgentModeDeniedError,
	type AgentModeFenceV1,
	graphIdFromScopeIri,
	modeAdmitsGraph,
	type ToolEffectClass,
	toolEffectClass,
} from "../agent-runtime/agent-mode.js";
import type { CapabilityBackend, HostedMcpToolDescriptor } from "../mnemosyne.js";
import type { GrantedCapabilityV1 } from "../workflow/agent-tool-grant.js";
import { checkHostArgumentPolicy } from "./argument-policy.js";

export interface HostCapabilityGrantPolicyV1 {
	/**
	 * Exact operation names remaining after manifest, steward grant, and profile
	 * attenuation. Non-domain runs without resolved grant bytes receive an empty
	 * map and therefore no ordinary host tools; worker-side tool curation is not
	 * authority and must never be promoted into this policy.
	 */
	readonly exactTools: Readonly<Record<string, readonly string[]>>;
	/** Manifest-authored destructiveness keyed by capability and exact tool name. */
	readonly toolDestructiveness?: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
	/** Signed grant snapshots resolved by the trusted host edge. */
	readonly capabilities?: readonly GrantedCapabilityV1[];
	/**
	 * Choreograph modes v1: the session's resolved mode, enforced on the graph
	 * MCP capability together with the exact grant. Attenuation only — the mode
	 * fence can never admit a tool the grant denied.
	 */
	readonly mode?: AgentModeFenceV1;
}

/**
 * The capabilities a mode governs: every host binding of the graph MCP surface.
 * `mnemosyne` is the session graph proxy, `mcp` the invocation graph binding,
 * and `sparql` its narrowed query face (whose `query` tool IS `sparql_query`).
 */
export const MODE_GOVERNED_CAPABILITIES: Readonly<Record<string, ModeToolAliases>> = {
	mnemosyne: {},
	mcp: {},
	sparql: { query: { tool: "sparql_query", effect: "read" } },
};

/** Capability-local tool name → the graph MCP tool name (and known effect) it stands for. */
export type ModeToolAliases = Readonly<Record<string, { readonly tool: string; readonly effect: ToolEffectClass }>>;

/**
 * Enforce the final, exact tool grant at the host gate. Sandboxed code can call
 * gate_call directly, so worker-side discovery filters are never authority.
 */
export function gateCapabilityBackend(
	backend: CapabilityBackend,
	allowedToolNames: readonly string[],
	grant?: GrantedCapabilityV1,
	toolDestructiveness?: Readonly<Record<string, boolean>>,
): CapabilityBackend {
	const allowed = new Set(allowedToolNames);
	if (allowed.has("*")) throw new Error(`${backend.capabilityName}: exact host tool grants cannot contain '*'`);
	if (grant && grant.capability !== backend.capabilityName) {
		throw new Error(`Capability grant '${grant.capability}' cannot bind backend '${backend.capabilityName}'`);
	}
	if (grant) {
		for (const tool of allowed) {
			if (!grant.operations.includes("*") && !grant.operations.includes(tool)) {
				throw new Error(`${backend.capabilityName}.${tool} is absent from the steward grant snapshot`);
			}
		}
	}

	let calls = 0;
	let concurrent = 0;
	const quota = grant?.quota ?? {};
	return {
		capabilityName: backend.capabilityName,
		accessLevel: backend.accessLevel,
		async callTool(tool, args, signal) {
			if (!allowed.has(tool)) {
				throw new Error(`Capability ${backend.capabilityName}: tool '${tool}' is outside the exact host grant`);
			}
			const perWaveLimit = minimumDefined(quota.maxPerWave, quota.maxPerDay);
			if (perWaveLimit !== undefined && calls >= perWaveLimit) {
				throw new Error(`Capability ${backend.capabilityName}: grant call quota is exhausted`);
			}
			if (quota.maxConcurrent !== undefined && concurrent >= quota.maxConcurrent) {
				throw new Error(`Capability ${backend.capabilityName}: grant concurrency quota is exhausted`);
			}
			if (quota.maxCostMicrousd === 0) {
				throw new Error(`Capability ${backend.capabilityName}: grant cost quota is exhausted`);
			}
			calls += 1;
			concurrent += 1;
			try {
				return await backend.callTool(tool, args, signal);
			} finally {
				concurrent -= 1;
			}
		},
		async listTools(): Promise<readonly HostedMcpToolDescriptor[]> {
			const tools = await backend.listTools();
			// requiredScopes is host-side classification input for the mode fence;
			// the worker-facing descriptor keeps its established shape.
			return tools
				.filter((tool) => allowed.has(tool.name))
				.map(({ requiredScopes: _requiredScopes, ...tool }) => ({
					...tool,
					destructive: toolDestructiveness?.[tool.name] ?? tool.destructive,
				}));
		},
		close: () => backend.close(),
	};
}

export function applyHostCapabilityGrantPolicy(
	registry: ReadonlyMap<string, CapabilityBackend>,
	policy: HostCapabilityGrantPolicyV1,
): Map<string, CapabilityBackend> {
	const grants = new Map((policy.capabilities ?? []).map((grant) => [grant.capability, grant]));
	return new Map(
		[...registry].map(([name, backend]) => {
			// Ratified exception: driver authority is the Layer-0 permission
			// mechanism itself. Subjecting request_permission to the grant it is
			// meant to adjudicate would deadlock the membrane.
			if (name === "acp.authority") return [name, backend];
			// The mode fence sits inside the exact grant gate: the grant still
			// denies first, and the mode can only remove what the grant admitted.
			const aliases = MODE_GOVERNED_CAPABILITIES[name];
			const moded = policy.mode && aliases ? gateModeCapabilityBackend(backend, policy.mode, aliases) : backend;
			return [
				name,
				gateCapabilityBackend(
					moded,
					policy.exactTools[name] ?? [],
					grants.get(name),
					policy.toolDestructiveness?.[name],
				),
			];
		}),
	);
}

/**
 * Enforce a session mode on the graph MCP backend (the exact grant gate wraps
 * this, so a tool must pass both).
 *
 * - tools/list: only tools the mode allows; under a read ceiling only tools
 *   whose live `requiredScopes` prove them read-only.
 * - tools/call: the same membership and ceiling (effect class from the live
 *   tools/list; unknown ⇒ write ⇒ denied), then the graph scope (the bound
 *   graph and any caller `graph_id`/`graphId` argument must be in scope), then
 *   a host built-in's argument policy (`argument-policy.ts`), then
 *   approval-required tools, which are denied with a structured
 *   `approval_required` error because v1 has no tool-call approval queue.
 */
export function gateModeCapabilityBackend(
	backend: CapabilityBackend,
	fence: AgentModeFenceV1,
	aliases: ModeToolAliases = {},
): CapabilityBackend {
	const { mode } = fence;
	const graphToolName = (tool: string): string => aliases[tool]?.tool ?? tool;
	const allowed = new Set(mode.allowsTool);
	const approval = new Set(mode.requiresApproval);
	for (const scope of mode.graphScope) {
		if (!graphIdFromScopeIri(scope)) throw new Error(`mode <${mode.iri}> carries a malformed graph scope`);
	}
	// undefined = the cell advertised no scopes for the tool: unknown, never read.
	const trustedRead = new Set(fence.trustedReadTools ?? []);
	const effectOf = (tool: HostedMcpToolDescriptor): ToolEffectClass | undefined =>
		aliases[tool.name]?.effect ??
		(tool.requiredScopes?.length
			? toolEffectClass(tool.requiredScopes)
			: trustedRead.has(graphToolName(tool.name))
				? "read"
				: undefined);
	let effectClasses: Promise<ReadonlyMap<string, ToolEffectClass | undefined>> | undefined;
	const classify = (): Promise<ReadonlyMap<string, ToolEffectClass | undefined>> => {
		effectClasses ??= backend
			.listTools()
			.then((tools) => new Map(tools.map((tool) => [tool.name, effectOf(tool)] as const)))
			.catch((error) => {
				effectClasses = undefined;
				throw error;
			});
		return effectClasses;
	};
	return {
		capabilityName: backend.capabilityName,
		accessLevel: mode.access === "read" ? "ro" : backend.accessLevel,
		async callTool(tool, args, signal) {
			if (!allowed.has(graphToolName(tool))) {
				throw new AgentModeDeniedError(tool, mode.iri, "tool_outside_mode", "the mode does not allow this tool");
			}
			if (mode.graphScope.length > 0) {
				if (fence.boundGraphId !== undefined && !modeAdmitsGraph(mode, fence.boundGraphId)) {
					throw new AgentModeDeniedError(
						tool,
						mode.iri,
						"graph_outside_scope",
						`the session graph '${fence.boundGraphId}' is outside the mode's graph scope`,
					);
				}
				for (const key of ["graph_id", "graphId"] as const) {
					if (!(key in args)) continue;
					const target = args[key];
					if (typeof target !== "string" || !modeAdmitsGraph(mode, target)) {
						throw new AgentModeDeniedError(
							tool,
							mode.iri,
							"graph_outside_scope",
							`argument ${key}=${JSON.stringify(target)} is outside the mode's graph scope`,
						);
					}
				}
			}
			if (fence.argumentPolicy) {
				const refusal = checkHostArgumentPolicy(
					fence.argumentPolicy,
					graphToolName(tool),
					args,
					fence.boundGraphId,
				);
				if (refusal) throw new AgentModeDeniedError(tool, mode.iri, "argument_outside_mode", refusal);
			}
			if (mode.access === "read") {
				let effect: ToolEffectClass | undefined;
				try {
					effect = (await classify()).get(tool);
				} catch {
					effect = undefined;
				}
				if (effect !== "read") {
					throw new AgentModeDeniedError(
						tool,
						mode.iri,
						"write_in_read_mode",
						effect === undefined
							? "the tool's effect class is unknown, so the read ceiling denies it"
							: "the mode's read ceiling denies write-class tools",
					);
				}
			}
			if (approval.has(graphToolName(tool))) throw new AgentModeApprovalRequiredError(graphToolName(tool), mode.iri);
			return backend.callTool(tool, args, signal);
		},
		async listTools(): Promise<readonly HostedMcpToolDescriptor[]> {
			const tools = await backend.listTools();
			return tools.filter(
				(tool) => allowed.has(graphToolName(tool.name)) && (mode.access === "write" || effectOf(tool) === "read"),
			);
		},
		close: () => backend.close(),
	};
}

function minimumDefined(left: number | undefined, right: number | undefined): number | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return Math.min(left, right);
}
