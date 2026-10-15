import { createMeaningfulObjectRef } from "../agent-runtime/meaningful-object.js";
import { AGENT_ONTOLOGY_BINDING_SCHEMA, type AgentOntologyBindingV1 } from "../agent-runtime/ontology-binding.js";
import {
	AGENT_RUNTIME_BINDING_SCHEMA,
	type AgentRuntimeBindingV2,
	type AgentRuntimeConstraintsV2,
	PRIME_AGENT_RUNTIME_BASELINE,
	validateResolvedAgentRuntimeBinding,
} from "../agent-runtime/profile.js";
import {
	mintAgentUri,
	mintStandaloneAgentId,
	STANDALONE_AGENT_IDENTITY_ALGORITHM,
} from "../agent-subject/agent-ontology.js";
import { resolveRuntimeBundleDescriptor, SOPHIA_AGENT_RUNTIME_BUNDLE_ID } from "../runtime-bundles.js";

/**
 * A local Choreograph (one person, their own gardend) lets a workflow's `agent()` steps name only what they ask —
 * a prompt, a model, a label — and supplies the rest: the installed agent body as the runtime, and a standalone agent
 * identity named after the workflow. Hosted Choreograph never does this (each node there is bound to an agent the
 * graph defines), so it is off unless `CHOREOGRAPH_LOCAL_AGENT_DEFAULTS=1`, which gardend's package sets.
 *
 * The profile is the baseline with no children, no kernel, no schedules and no proposals: what the local body runs.
 */
export const LOCAL_AGENT_CONSTRAINTS: AgentRuntimeConstraintsV2 = Object.freeze({
	...PRIME_AGENT_RUNTIME_BASELINE,
	maxChildren: 0,
	maxChildDepth: 0,
	maxConcurrentChildren: 0,
	allowPersistentKernel: false,
	allowAutonomousContinuation: false,
	allowSchedules: false,
	allowWorkflowProposals: false,
});

export function localAgentDefaultsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.CHOREOGRAPH_LOCAL_AGENT_DEFAULTS?.trim() === "1";
}

export function localAgentDefaults(input: {
	workflowName: string;
	graphId: string;
	ownerPrincipal: string;
	now?: number;
}): { runtime: AgentRuntimeBindingV2; ontology: AgentOntologyBindingV1 } {
	const bundle = resolveRuntimeBundleDescriptor(SOPHIA_AGENT_RUNTIME_BUNDLE_ID);
	const registeredName = `workflow-${input.workflowName}`;
	const agentId = mintStandaloneAgentId({ name: registeredName });
	const agentUri = mintAgentUri(agentId);
	const ref = <Kind extends Parameters<typeof createMeaningfulObjectRef>[0]["kind"]>(
		kind: Kind,
		objectId: string,
		value: unknown,
	) =>
		createMeaningfulObjectRef({
			kind,
			ownerPrincipal: input.ownerPrincipal,
			graphId: input.graphId,
			objectId,
			version: "1",
			value,
		});
	const profileRef = ref("agent-runtime-profile", `${registeredName}-profile`, {
		kind: "prime",
		constraints: LOCAL_AGENT_CONSTRAINTS,
	});
	const runtime: AgentRuntimeBindingV2 = {
		schema: AGENT_RUNTIME_BINDING_SCHEMA,
		kind: "prime",
		bundle: { id: bundle.id, digest: `sha256:${bundle.digest}` },
		profileRef,
		constraints: { ...LOCAL_AGENT_CONSTRAINTS },
	};
	validateResolvedAgentRuntimeBinding(runtime);
	const ontology: AgentOntologyBindingV1 = {
		schema: AGENT_ONTOLOGY_BINDING_SCHEMA,
		subject: {
			agentId,
			agentUri,
			observerId: agentId,
			registeredName,
			identityAlgorithm: STANDALONE_AGENT_IDENTITY_ALGORITHM,
		},
		objects: {
			agent: ref("agent", agentUri, { registeredName }),
			geist: ref("geist", `${registeredName}-geist`, { registeredName }),
			prompt: ref("prompt", `${registeredName}-prompt`, { workflow: input.workflowName }),
			skills: [],
			harness: ref("harness", "choreograph-agent-body-v1", { protocol: "prime-host-bridge.v1" }),
			toolManifest: ref("tool-manifest", `${registeredName}-tools`, { source: "the workflow's agent() options" }),
			toolGrant: ref("tool-grant", `${registeredName}-grant`, { issuer: "choreograph-host", scope: "local" }),
			runtimeProfile: profileRef,
		},
		resolvedAt: input.now ?? Date.now(),
	};
	return { runtime, ontology };
}
