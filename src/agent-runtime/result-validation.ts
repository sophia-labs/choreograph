import { createHash } from "node:crypto";
import { canonicalJson } from "@sophia-labs/canonical-json";
import Ajv from "ajv";
import type { AgentSpawnRequest, AgentSpawnResult } from "../wire-protocol.js";

export const PRIME_RUNTIME_STATE_SCHEMA = "sophia.prime-runtime-state.v2" as const;
const MAX_RESULT_ENVELOPE_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_OUTPUT_BYTES = 1024 * 1024;
const MAX_RESULT_MESSAGES_BYTES = 2 * 1024 * 1024;
const MAX_STRUCTURED_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface PrimeRuntimeStateV2 {
	readonly schema: typeof PRIME_RUNTIME_STATE_SCHEMA;
	readonly sessionId: string;
	readonly sandboxId: string;
	readonly generation: number;
	readonly runtimeBindingDigest: string;
	readonly ontologyBindingDigest: string;
	readonly sessionHeader: unknown;
	readonly embodimentDigest?: string;
	readonly runtimeOverlayDigests?: readonly string[];
	readonly entries: readonly unknown[];
	readonly goal: unknown;
	readonly autonomous: unknown;
	readonly workerSequence: number;
	readonly createdAt: string;
	readonly digest: string;
}

export class AgentResultValidationFault extends Error {
	readonly code = "agent_result_invalid";

	constructor(
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "AgentResultValidationFault";
	}
}

/**
 * Validate the untrusted sandbox result before it can become workflow/session
 * state or an agent-checkpoint Meaningful Object.
 */
export function validateCanonicalAgentSpawnResult(
	value: unknown,
	request: AgentSpawnRequest,
): asserts value is AgentSpawnResult & { prime_state?: PrimeRuntimeStateV2 } {
	if (!isRecord(value)) throw fault("agent result must be an object");
	assertByteLimit(value, MAX_RESULT_ENVELOPE_BYTES, "agent result envelope");
	if (value.spawn_id !== request.spawn_id) throw fault("agent result spawn id does not match the host request");
	if (value.session_id !== request.session_id) throw fault("agent result session id does not match the host request");
	if (value.runtime_binding_digest !== request.runtime_binding_digest) {
		throw fault("agent result runtime binding digest does not match the host request");
	}
	if (value.agent_ontology_binding_digest !== request.agent_ontology_binding_digest) {
		throw fault("agent result Agent Ontology digest does not match the host request");
	}
	validateEvolutionPins(value, request, "agent result");
	if (value.status !== "terminated" && value.status !== "truncated" && value.status !== "error") {
		throw fault("agent result status is unsupported", { status: value.status });
	}
	if (typeof value.output !== "string") throw fault("agent result output must be a string");
	if (Buffer.byteLength(value.output, "utf8") > MAX_RESULT_OUTPUT_BYTES) {
		throw fault("agent result output exceeds the host byte fence");
	}
	const turns = nonNegativeInteger(value.turns, "agent result turns");
	if (turns > request.runtime_binding.constraints.maxTurns) {
		throw fault("agent result exceeds the pinned turn budget", {
			turns,
			maximum: request.runtime_binding.constraints.maxTurns,
		});
	}
	if (value.tokens !== undefined) {
		const tokens = nonNegativeInteger(value.tokens, "agent result tokens");
		if (tokens > request.runtime_binding.constraints.maxTokens) {
			throw fault("agent result exceeds the pinned token budget", {
				tokens,
				maximum: request.runtime_binding.constraints.maxTokens,
			});
		}
	}
	if (value.tool_calls !== undefined) nonNegativeInteger(value.tool_calls, "agent result tool_calls");
	if (value.messages !== undefined && !Array.isArray(value.messages)) {
		throw fault("agent result messages must be an array");
	}
	if (value.messages !== undefined)
		assertByteLimit(value.messages, MAX_RESULT_MESSAGES_BYTES, "agent result messages");
	if (value.structured_output !== undefined) {
		assertByteLimit(
			value.structured_output,
			Math.min(MAX_STRUCTURED_OUTPUT_BYTES, request.runtime_binding.constraints.maxArtifactBytes),
			"agent structured output",
		);
	}

	if (request.output_schema && value.status !== "error") {
		if (value.structured_output === undefined) throw fault("agent result omitted required structured output");
		const validator = new Ajv({ allErrors: true, strict: false }).compile(request.output_schema);
		if (!validator(value.structured_output)) {
			throw fault("agent result structured output does not satisfy the host schema", validator.errors);
		}
	}

	if (value.status === "terminated" || value.status === "truncated") {
		validatePrimeRuntimeState(value.prime_state, request);
	} else if (value.prime_state !== undefined) {
		validatePrimeRuntimeState(value.prime_state, request);
	}
}

function assertByteLimit(value: unknown, maximum: number, label: string): void {
	let encoded: string;
	try {
		encoded = JSON.stringify(value);
	} catch {
		throw fault(`${label} is not JSON-serializable`);
	}
	const bytes = Buffer.byteLength(encoded, "utf8");
	if (bytes > maximum) throw fault(`${label} exceeds the host byte fence`, { bytes, maximum });
}

export function validatePrimeSemanticEventAuthority(value: unknown, request: AgentSpawnRequest): void {
	if (!isRecord(value) || value.type !== "prime_event") throw fault("Prime semantic event is invalid");
	if (value.session_id !== request.session_id) throw fault("Prime semantic event session id drifted");
	if (value.runtime_binding_digest !== request.runtime_binding_digest) {
		throw fault("Prime semantic event runtime binding digest drifted");
	}
	if (value.agent_ontology_binding_digest !== request.agent_ontology_binding_digest) {
		throw fault("Prime semantic event Agent Ontology digest drifted");
	}
	if (value.embodiment_digest !== request.embodiment_binding_digest) {
		throw fault("Prime semantic event Agent Embodiment digest drifted");
	}
}

export function validatePrimeRuntimeState(
	value: unknown,
	request: AgentSpawnRequest,
): asserts value is PrimeRuntimeStateV2 {
	if (!isRecord(value) || value.schema !== PRIME_RUNTIME_STATE_SCHEMA) {
		throw fault("agent result has no supported Prime runtime state");
	}
	if (value.sessionId !== request.session_id) throw fault("Prime runtime state session id drifted");
	if (value.sandboxId !== request.spawn_id) throw fault("Prime runtime state sandbox id drifted");
	if (value.generation !== request.generation) throw fault("Prime runtime state generation drifted");
	if (value.runtimeBindingDigest !== request.runtime_binding_digest) {
		throw fault("Prime runtime state runtime binding digest drifted");
	}
	if (value.ontologyBindingDigest !== request.agent_ontology_binding_digest) {
		throw fault("Prime runtime state Agent Ontology digest drifted");
	}
	if (!isRecord(value.sessionHeader) || value.sessionHeader.type !== "session") {
		throw fault("Prime runtime state session header is invalid");
	}
	if (value.embodimentDigest !== request.embodiment_binding_digest) {
		throw fault("Prime checkpoint Agent Embodiment digest drifted");
	}
	const expectedOverlayDigests = request.runtime_overlays?.map((overlay) => overlay.artifactDigest);
	if (expectedOverlayDigests === undefined) {
		if (value.runtimeOverlayDigests !== undefined) throw fault("Prime checkpoint invented runtime overlay pins");
	} else if (
		!Array.isArray(value.runtimeOverlayDigests) ||
		value.runtimeOverlayDigests.length !== expectedOverlayDigests.length ||
		value.runtimeOverlayDigests.some((digest, index) => digest !== expectedOverlayDigests[index])
	) {
		throw fault("Prime checkpoint runtime overlay digests drifted");
	}
	if (!Array.isArray(value.entries)) throw fault("Prime checkpoint entries must be an array");
	if (!Object.hasOwn(value, "goal") || !Object.hasOwn(value, "autonomous")) {
		throw fault("Prime runtime state goal/autonomous state is missing");
	}
	nonNegativeInteger(value.workerSequence, "Prime runtime state worker sequence");
	if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
		throw fault("Prime runtime state createdAt must be an ISO timestamp");
	}
	if (typeof value.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.digest)) {
		throw fault("Prime runtime state digest is invalid");
	}
	const { digest, ...unsigned } = value;
	const expected = digestCanonical(unsigned);
	if (digest !== expected)
		throw fault("Prime runtime state content digest does not match", { expected, actual: digest });
}

function validateEvolutionPins(value: Record<string, unknown>, request: AgentSpawnRequest, label: string): void {
	if (value.embodiment_digest !== request.embodiment_binding_digest) {
		throw fault(`${label} Agent Embodiment digest drifted`);
	}
	const expected = request.runtime_overlays?.map((overlay) => overlay.artifactDigest);
	if (expected === undefined) {
		if (value.runtime_overlay_digests !== undefined) throw fault(`${label} invented runtime overlay pins`);
		return;
	}
	if (
		!Array.isArray(value.runtime_overlay_digests) ||
		value.runtime_overlay_digests.length !== expected.length ||
		value.runtime_overlay_digests.some((digest, index) => digest !== expected[index])
	) {
		throw fault(`${label} runtime overlay digests drifted`);
	}
}

function digestCanonical(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function nonNegativeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw fault(`${label} is invalid`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fault(message: string, details?: unknown): AgentResultValidationFault {
	return new AgentResultValidationFault(message, details);
}
