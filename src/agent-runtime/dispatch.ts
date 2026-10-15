import type { AgentNodeResult, AgentNodeSpec, NodeRunner } from "../workflow/types.js";
import { assertAgentOntologyRuntimeMatch, digestAgentOntologyBinding } from "./ontology-binding.js";
import {
	AgentRuntimeBindingFault,
	type AgentRuntimeBindingV2,
	type AgentRuntimeBundleRefV1,
	type AgentRuntimeKind,
	digestAgentRuntimeBinding,
	resolveAgentRuntimeBinding,
	validateResolvedAgentRuntimeBinding,
} from "./profile.js";

export type AgentNodeRuntimeResolver = (spec: AgentNodeSpec) => AgentRuntimeBindingV2 | Promise<AgentRuntimeBindingV2>;

export interface AgentRuntimeDispatcherDeps {
	readonly resolve: AgentNodeRuntimeResolver;
	/** Both simple and Prime bindings execute through the Sophia semantic core. */
	readonly run: NodeRunner;
}

export class AgentOntologyBindingRequiredFault extends Error {
	readonly code = "agent_ontology_binding_required";

	constructor(readonly kind: AgentRuntimeKind) {
		super("requested agent runtime has no pinned Agent Ontology / Meaningful Objects binding");
		this.name = "AgentOntologyBindingRequiredFault";
	}
}

/**
 * One fail-closed dispatcher for both workflow agent profiles.
 *
 * Resolution happens before either runner sees the node. The resolved immutable
 * binding and digest travel with the spec and result, so storage and telemetry
 * never have to infer which runtime actually executed.
 */
export function makeAgentRuntimeDispatcher(deps: AgentRuntimeDispatcherDeps): NodeRunner {
	return async (spec: AgentNodeSpec): Promise<AgentNodeResult> => {
		const binding = await deps.resolve(spec);
		const bindingDigest = digestAgentRuntimeBinding(binding);
		const ontology = spec.ontology;
		if (!ontology) {
			throw new AgentOntologyBindingRequiredFault(binding.kind);
		}
		const ontologyBindingDigest = digestAgentOntologyBinding(ontology);
		assertAgentOntologyRuntimeMatch(ontology, {
			agentId: spec.agentId,
			runtimeProfileRef: binding.profileRef,
		});
		const resolvedSpec: AgentNodeSpec = {
			...spec,
			runtime: binding,
			runtimeBindingDigest: bindingDigest,
			ontologyBindingDigest,
			maxTurns: binding.constraints.maxTurns,
		};
		const result = await deps.run(resolvedSpec);
		return {
			...result,
			runtime: {
				kind: binding.kind,
				bindingDigest,
				bundle: binding.bundle,
			},
			ontology: {
				bindingDigest: ontologyBindingDigest,
				agentId: ontology.subject.agentId,
				observerId: ontology.subject.observerId,
			},
		};
	};
}

export interface StaticAgentRuntimeResolverOptions {
	readonly bundles: Readonly<Record<AgentRuntimeKind, AgentRuntimeBundleRefV1>>;
	readonly profilesByDigest: ReadonlyMap<string, AgentRuntimeBindingV2>;
}

/**
 * Local/embedded resolver. Production may replace this with a Garden profile
 * resolver, but it must return the same pinned AgentRuntimeBindingV2.
 */
export function makeStaticAgentRuntimeResolver(options: StaticAgentRuntimeResolverOptions): AgentNodeRuntimeResolver {
	return (spec) => {
		if (!spec.runtime) {
			throw new AgentRuntimeBindingFault("agent node has no explicit runtime profile Meaningful Object");
		}
		const profileDigest = spec.runtime.profileRef.digest;
		const requestedKind = spec.runtime.kind;
		const profile = options.profilesByDigest.get(profileDigest);
		if (!profile) {
			throw new AgentRuntimeBindingFault("runtime profile Meaningful Object is not installed", {
				requestedKind,
				profileDigest,
			});
		}
		return resolveAgentRuntimeBinding(spec.runtime, {
			bundles: options.bundles,
			profile,
			...(spec.maxTurns === undefined ? {} : { nodeMaxTurns: spec.maxTurns }),
		});
	};
}

/**
 * Resolver for execution plans that already carry a complete, host-resolved
 * runtime-profile snapshot. This is the production cutover seam: absence or an
 * authoring-only partial selection is an error; neither kind is defaulted.
 */
export const resolvePinnedAgentRuntime: AgentNodeRuntimeResolver = (spec) => {
	if (!spec.runtime) {
		throw new AgentRuntimeBindingFault("agent node has no pinned runtime profile Meaningful Object");
	}
	validateResolvedAgentRuntimeBinding(spec.runtime);
	return resolveAgentRuntimeBinding(
		{
			kind: spec.runtime.kind,
			bundle: spec.runtime.bundle,
			profileRef: spec.runtime.profileRef,
		},
		{
			bundles: { simple: spec.runtime.bundle, prime: spec.runtime.bundle },
			profile: spec.runtime,
			...(spec.maxTurns === undefined ? {} : { nodeMaxTurns: spec.maxTurns }),
		},
	);
};
