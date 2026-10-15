import { createHash } from "node:crypto";
import { canonicalJson } from "@sophia-labs/canonical-json";
import {
	CANONICAL_AGENT_ID,
	mintAgentUri,
	STANDALONE_AGENT_IDENTITY_ALGORITHM,
} from "../agent-subject/agent-ontology.js";
import { type AgentModeRefV1, validateAgentModeRef } from "./agent-mode.js";
import type { MeaningfulObjectKind } from "./meaningful-object.js";
import {
	type MeaningfulObjectRefV1,
	sameMeaningfulObjectRef,
	validateMeaningfulObjectRef,
} from "./meaningful-object.js";
import type { AgentRuntimeProfileRefV1 } from "./profile.js";

export const AGENT_ONTOLOGY_BINDING_SCHEMA = "sophia.agent-ontology-binding.v1" as const;

export interface AgentOntologyBindingV1 {
	readonly schema: typeof AGENT_ONTOLOGY_BINDING_SCHEMA;
	readonly subject: {
		readonly agentId: string;
		readonly agentUri: string;
		readonly observerId: string;
		readonly registeredName: string;
		readonly identityAlgorithm: typeof STANDALONE_AGENT_IDENTITY_ALGORITHM;
	};
	readonly objects: {
		readonly agent: MeaningfulObjectRefV1<"agent">;
		readonly geist: MeaningfulObjectRefV1<"geist">;
		readonly prompt: MeaningfulObjectRefV1<"prompt">;
		readonly skills: readonly MeaningfulObjectRefV1<"skill">[];
		readonly harness: MeaningfulObjectRefV1<"harness">;
		readonly toolManifest: MeaningfulObjectRefV1<"tool-manifest">;
		readonly toolGrant: MeaningfulObjectRefV1<"tool-grant">;
		readonly runtimeProfile: MeaningfulObjectRefV1<"agent-runtime-profile">;
	};
	/**
	 * Choreograph modes v1: the `agt:Mode` this session was bound to at
	 * activation (iri + canonical digest). Absent ⇒ no mode (legacy behavior),
	 * and the binding digest is byte-identical to a pre-modes binding.
	 */
	readonly mode?: AgentModeRefV1;
	readonly resolvedAt: number;
}

export class AgentOntologyBindingFault extends Error {
	readonly code = "agent_ontology_binding_invalid";

	constructor(
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "AgentOntologyBindingFault";
	}
}

export function validateAgentOntologyBinding(value: unknown): asserts value is AgentOntologyBindingV1 {
	if (!isRecord(value)) throw ontologyFault("agent ontology binding must be an object");
	if (value.schema !== AGENT_ONTOLOGY_BINDING_SCHEMA) {
		throw ontologyFault("agent ontology binding schema is unsupported", { schema: value.schema });
	}
	if (!isRecord(value.subject)) throw ontologyFault("agent ontology subject must be an object");
	const subject = value.subject;
	if (typeof subject.agentId !== "string" || !CANONICAL_AGENT_ID.test(subject.agentId)) {
		throw ontologyFault("subject.agentId must be a canonical agent identity");
	}
	if (subject.agentUri !== mintAgentUri(subject.agentId)) {
		throw ontologyFault("subject.agentUri must be derived from subject.agentId", {
			expected: mintAgentUri(subject.agentId),
			actual: subject.agentUri,
		});
	}
	if (subject.observerId !== subject.agentId) {
		throw ontologyFault("the agent subject and observer witness must be the same identity", {
			agentId: subject.agentId,
			observerId: subject.observerId,
		});
	}
	if (typeof subject.registeredName !== "string" || subject.registeredName.trim().length === 0) {
		throw ontologyFault("subject.registeredName is required");
	}
	if (subject.identityAlgorithm !== STANDALONE_AGENT_IDENTITY_ALGORITHM) {
		throw ontologyFault("subject.identityAlgorithm is unsupported");
	}

	if (!isRecord(value.objects)) throw ontologyFault("agent ontology objects must be an object");
	const objects = value.objects;
	validateObjectSlot(objects.agent, "agent");
	validateObjectSlot(objects.geist, "geist");
	validateObjectSlot(objects.prompt, "prompt");
	validateObjectSlot(objects.harness, "harness");
	validateObjectSlot(objects.toolManifest, "tool-manifest");
	validateObjectSlot(objects.toolGrant, "tool-grant");
	validateObjectSlot(objects.runtimeProfile, "agent-runtime-profile");
	if (!Array.isArray(objects.skills)) throw ontologyFault("agent ontology objects.skills must be an array");
	const seenSkills = new Set<string>();
	for (const skill of objects.skills) {
		validateObjectSlot(skill, "skill");
		const key = [skill.graphId, skill.objectId, skill.version, skill.digest].join(":");
		if (seenSkills.has(key)) throw ontologyFault("agent ontology binding contains a duplicate skill ref", { key });
		seenSkills.add(key);
	}
	if (value.mode !== undefined) {
		try {
			validateAgentModeRef(value.mode);
		} catch (error) {
			throw ontologyFault("agent ontology mode ref is invalid", {
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (typeof value.resolvedAt !== "number" || !Number.isSafeInteger(value.resolvedAt) || value.resolvedAt < 0) {
		throw ontologyFault("agent ontology binding resolvedAt must be a non-negative epoch millisecond");
	}
}

function validateObjectSlot(value: unknown, kind: MeaningfulObjectKind): asserts value is MeaningfulObjectRefV1 {
	try {
		validateMeaningfulObjectRef(value, kind);
	} catch (error) {
		throw ontologyFault("agent ontology Meaningful Object slot is invalid", {
			kind,
			reason: error instanceof Error ? error.message : String(error),
		});
	}
}

export function assertAgentOntologyRuntimeMatch(
	binding: AgentOntologyBindingV1,
	input: {
		readonly agentId?: string;
		readonly runtimeProfileRef?: AgentRuntimeProfileRefV1;
	},
): void {
	validateAgentOntologyBinding(binding);
	if (input.agentId !== undefined && binding.subject.agentId !== input.agentId) {
		throw ontologyFault("node agent identity does not match its Agent Meaningful Object binding", {
			nodeAgentId: input.agentId,
			boundAgentId: binding.subject.agentId,
		});
	}
	if (!sameMeaningfulObjectRef(binding.objects.runtimeProfile, input.runtimeProfileRef)) {
		throw ontologyFault("runtime profile does not match the agent ontology binding", {
			nodeRuntimeProfile: input.runtimeProfileRef,
			boundRuntimeProfile: binding.objects.runtimeProfile,
		});
	}
}

export function digestAgentOntologyBinding(binding: AgentOntologyBindingV1): string {
	validateAgentOntologyBinding(binding);
	return `sha256:${createHash("sha256").update(canonicalJson(binding)).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ontologyFault(message: string, details?: unknown): AgentOntologyBindingFault {
	return new AgentOntologyBindingFault(message, details);
}
