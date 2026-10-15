import {
	MEANINGFUL_OBJECT_REF_SCHEMA,
	type MeaningfulObjectKind,
	type MeaningfulObjectRefV1,
} from "../agent-runtime/meaningful-object.js";
import {
	AGENT_ONTOLOGY_BINDING_SCHEMA,
	type AgentOntologyBindingV1,
	digestAgentOntologyBinding,
} from "../agent-runtime/ontology-binding.js";
import {
	AGENT_RUNTIME_BINDING_SCHEMA,
	type AgentRuntimeBindingV2,
	type AgentRuntimeKind,
	digestAgentRuntimeBinding,
	PRIME_AGENT_RUNTIME_BASELINE,
	SIMPLE_AGENT_RUNTIME_BASELINE,
} from "../agent-runtime/profile.js";
import {
	mintAgentUri,
	mintStandaloneAgentId,
	STANDALONE_AGENT_IDENTITY_ALGORITHM,
} from "../agent-subject/agent-ontology.js";

export function makeTestAgentSemanticBinding(
	input: { graphId?: string; kind?: AgentRuntimeKind; registeredName?: string; bundleDigest?: string } = {},
): {
	agentId: string;
	runtime: AgentRuntimeBindingV2;
	runtimeBindingDigest: string;
	ontology: AgentOntologyBindingV1;
	ontologyBindingDigest: string;
} {
	const graphId = input.graphId ?? "g1";
	const kind = input.kind ?? "simple";
	const registeredName = input.registeredName ?? "test-agent";
	const agentId = mintStandaloneAgentId({ name: registeredName });
	const ref = <Kind extends MeaningfulObjectKind>(
		objectKind: Kind,
		objectId: string,
		character: string,
	): MeaningfulObjectRefV1<Kind> => ({
		schema: MEANINGFUL_OBJECT_REF_SCHEMA,
		kind: objectKind,
		ownerPrincipal: "user:test",
		graphId,
		objectId,
		version: "1",
		digest: `sha256:${character.repeat(64)}`,
	});
	const profileRef = ref("agent-runtime-profile", `${registeredName}-${kind}-profile`, kind === "simple" ? "8" : "9");
	const runtime: AgentRuntimeBindingV2 = {
		schema: AGENT_RUNTIME_BINDING_SCHEMA,
		kind,
		bundle: { id: "sophia-agent-runtime", digest: input.bundleDigest ?? `sha256:${"a".repeat(64)}` },
		profileRef,
		constraints: kind === "simple" ? SIMPLE_AGENT_RUNTIME_BASELINE : PRIME_AGENT_RUNTIME_BASELINE,
	};
	const ontology: AgentOntologyBindingV1 = {
		schema: AGENT_ONTOLOGY_BINDING_SCHEMA,
		subject: {
			agentId,
			agentUri: mintAgentUri(agentId),
			observerId: agentId,
			registeredName,
			identityAlgorithm: STANDALONE_AGENT_IDENTITY_ALGORITHM,
		},
		objects: {
			agent: ref("agent", mintAgentUri(agentId), "1"),
			geist: ref("geist", `${registeredName}-geist`, "2"),
			prompt: ref("prompt", `${registeredName}-prompt`, "3"),
			skills: [],
			harness: ref("harness", "sophia-agent-host-v1", "4"),
			toolManifest: ref("tool-manifest", `${registeredName}-tools`, "5"),
			toolGrant: ref("tool-grant", `${registeredName}-grant`, "6"),
			runtimeProfile: profileRef,
		},
		resolvedAt: 1,
	};
	return {
		agentId,
		runtime,
		runtimeBindingDigest: digestAgentRuntimeBinding(runtime),
		ontology,
		ontologyBindingDigest: digestAgentOntologyBinding(ontology),
	};
}
