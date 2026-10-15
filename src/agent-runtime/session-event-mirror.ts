import type { BusEvent } from "../event-bus.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import type { AgentSessionEventTypeV1 } from "./session-contract.js";
import { toolCallTargets, toolResultTargets } from "./tool-targets.js";

export const AGENT_SESSION_SEMANTIC_EVENT_SCHEMA = "sophia.agent-session-semantic-event.v1" as const;

export interface MirroredAgentSessionEvent {
	readonly type: AgentSessionEventTypeV1;
	readonly ts: number;
	readonly payload: {
		readonly schema: typeof AGENT_SESSION_SEMANTIC_EVENT_SCHEMA;
		readonly sourceType: string;
		readonly value: unknown;
		readonly runtimeBindingDigest?: string;
		readonly ontologyBindingDigest?: string;
		readonly meaningfulObjects: Record<string, unknown>;
	};
}

type CategorizedBusEvent = Extract<BusEvent, { category: string }>;

export class AgentSessionEventMirrorFault extends Error {
	readonly code = "agent_session_semantic_event_invalid";

	constructor(message: string) {
		super(message);
		this.name = "AgentSessionEventMirrorFault";
	}
}

const PRIME_EVENT_TYPES: Readonly<Record<string, AgentSessionEventTypeV1>> = {
	goal_update: "goal.updated",
	compaction_start: "compaction.started",
	compaction_end: "compaction.completed",
	recap_update: "recap.updated",
	refine_complete: "refine.completed",
	refine_failed: "refine.failed",
	capability_result: "artifact.published",
	budget_update: "budget.updated",
};

/**
 * The events that mark a turn. Each names the voice that spoke it (the Session's pinned model and provider), so a
 * conversation that reads its own events can show which model answered without asking the catalogue.
 */
const VOICE_EVENT_TYPES: ReadonlySet<AgentSessionEventTypeV1> = new Set([
	"turn.started",
	"turn.completed",
	"message.completed",
]);

export function mirrorAgentSessionEvent(event: BusEvent, spec: AgentNodeSpec): MirroredAgentSessionEvent | undefined {
	if (!("category" in event)) return undefined;
	const mapping = eventMapping(event);
	if (!mapping) return undefined;
	const value =
		VOICE_EVENT_TYPES.has(mapping.type) && isRecord(mapping.value)
			? { ...mapping.value, model: spec.model, ...(spec.provider ? { provider: spec.provider } : {}) }
			: mapping.value;
	return {
		type: mapping.type,
		ts: timestamp(event.ts),
		payload: {
			schema: AGENT_SESSION_SEMANTIC_EVENT_SCHEMA,
			sourceType: mapping.sourceType,
			value,
			...(spec.runtimeBindingDigest ? { runtimeBindingDigest: spec.runtimeBindingDigest } : {}),
			...(spec.ontologyBindingDigest ? { ontologyBindingDigest: spec.ontologyBindingDigest } : {}),
			meaningfulObjects: semanticObjects(spec),
		},
	};
}

function eventMapping(
	event: CategorizedBusEvent,
): { type: AgentSessionEventTypeV1; sourceType: string; value: unknown } | undefined {
	if (event.category === "execution" && event.type === "compute.cell") {
		return { type: "compute.cell", sourceType: "execution.compute.cell", value: event.cell };
	}
	if (event.category === "capability" && event.type === "call") {
		const workflowAmendment = event.capability === "workflow" && event.operation === "propose_amendment";
		return {
			type: workflowAmendment
				? event.decision === "accepted"
					? "workflow.accepted"
					: event.decision === "rejected"
						? "workflow.rejected"
						: "workflow.proposed"
				: "capability.called",
			sourceType: "capability.call",
			value: {
				callId: event.call_id,
				capability: event.capability,
				operation: event.operation,
				outcome: event.outcome,
				durationMs: event.duration_ms,
				...(event.result_digest ? { resultDigest: event.result_digest } : {}),
				...(event.object_refs ? { objectRefs: event.object_refs } : {}),
				...(event.decision ? { decision: event.decision } : {}),
				...(event.revision === undefined ? {} : { revision: event.revision }),
				...(event.reason ? { reason: event.reason } : {}),
			},
		};
	}
	if (event.category !== "agent") return undefined;
	const source = event.event;
	switch (source.type) {
		case "prompt":
			return {
				type: "input.prompt",
				sourceType: source.type,
				value: { text: source.text, commandId: source.command_id },
			};
		case "follow_up":
			return {
				type: "input.follow_up",
				sourceType: source.type,
				value: { text: source.text, commandId: source.command_id },
			};
		case "turn_start":
			return { type: "turn.started", sourceType: source.type, value: { turn: source.turn } };
		case "turn_end":
			return { type: "turn.completed", sourceType: source.type, value: { turn: source.turn } };
		case "text":
			return { type: "message.delta", sourceType: source.type, value: { delta: source.content } };
		case "thinking":
			return { type: "reasoning.delta", sourceType: source.type, value: { delta: source.content } };
		case "tool_call": {
			// What a write touched, as targets only (`tool-targets.ts`): never the arguments themselves.
			const targets = toolCallTargets(source.gate, source.args);
			return {
				type: "tool.started",
				sourceType: source.type,
				value: { tool: source.gate, ...(targets.length > 0 ? { targets } : {}) },
			};
		}
		case "tool_result": {
			const targets = source.is_error ? [] : toolResultTargets(source.gate, source.result);
			return {
				type: source.is_error ? "tool.failed" : "tool.completed",
				sourceType: source.type,
				value: {
					tool: source.gate,
					isError: source.is_error,
					...(source.cell_ref ? { cellRef: source.cell_ref } : {}),
					...(targets.length > 0 ? { targets } : {}),
				},
			};
		}
		case "steer":
			return {
				type: "input.steer",
				sourceType: source.type,
				value: {
					text: source.text,
					...(source.command_id ? { commandId: source.command_id } : {}),
					...(source.client_id ? { clientId: source.client_id } : {}),
				},
			};
		case "done":
			return { type: "message.completed", sourceType: source.type, value: { output: source.output } };
		case "truncated":
			return {
				type: "budget.exhausted",
				sourceType: source.type,
				value: { output: source.output, turns: source.turns },
			};
		case "error":
			return { type: "turn.failed", sourceType: source.type, value: { message: source.message } };
		case "prime_event": {
			if (source.name === "rlm_child_update") {
				throw new AgentSessionEventMirrorFault(
					"opaque Prime rlm_child_update cannot testify a hosted Agent Session child fact",
				);
			}
			const type = PRIME_EVENT_TYPES[source.name];
			if (!type) return undefined;
			return { type, sourceType: `prime.${source.name}`, value: source.payload };
		}
	}
}

function semanticObjects(spec: AgentNodeSpec): Record<string, unknown> {
	if (!spec.ontology) return {};
	return {
		agent: spec.ontology.objects.agent,
		geist: spec.ontology.objects.geist,
		runtimeProfile: spec.ontology.objects.runtimeProfile,
		toolGrant: spec.ontology.objects.toolGrant,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(value: string): number {
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? Date.now() : parsed;
}
