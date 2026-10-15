import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_SESSION_EVENT_TYPES } from "../agent-runtime/session-contract.js";
import { AgentSessionEventMirrorFault, mirrorAgentSessionEvent } from "../agent-runtime/session-event-mirror.js";
import type { BusEvent } from "../event-bus.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

const semantic = makeTestAgentSemanticBinding({ graphId: "g1", kind: "prime", registeredName: "phanes" });
const spec: AgentNodeSpec = {
	label: "discord-activity",
	phaseIndex: 1,
	prompt: "understand the Discord context",
	model: "mock:done",
	graphId: "g1",
	sessionId: "ags-phanes",
	...semantic,
};

describe("Agent Session semantic event mirror", () => {
	it("speaks the worker/bus subset of the ratified v1 vocabulary", () => {
		const ordinaryEvents: BusEvent[] = [
			agentEvent({ type: "prompt", text: "continue", command_id: "cmd-prompt" }),
			agentEvent({ type: "follow_up", text: "and then", command_id: "cmd-follow-up" }),
			agentEvent({ type: "turn_start", turn: 1 }),
			agentEvent({ type: "turn_end", turn: 1 }),
			agentEvent({ type: "text", content: "hello" }),
			agentEvent({ type: "thinking", content: "considering" }),
			agentEvent({ type: "tool_call", gate: "search", args: {} }),
			agentEvent({ type: "tool_result", gate: "search", result: "ok", is_error: false }),
			agentEvent({ type: "tool_result", gate: "search", result: "no", is_error: true }),
			agentEvent({ type: "steer", text: "look left" }),
			agentEvent({ type: "done", output: "finished" }),
			agentEvent({ type: "truncated", output: "partial", turns: 2 }),
			agentEvent({ type: "error", message: "failed" }),
			capabilityEvent("ordinary"),
			capabilityEvent("proposed"),
			capabilityEvent("accepted"),
			capabilityEvent("rejected"),
			{
				category: "execution",
				type: "compute.cell",
				sandbox_id: "sb-1",
				ts: new Date(1000).toISOString(),
				cell: {
					schema: "choreograph.compute-cell.v1",
					cellRef: "compute.cell:ags-phanes:0",
					sessionId: "ags-phanes",
					leaseId: "kls-1",
					kernelSandboxId: "kernel-1",
					inputId: "input-0",
					ordinal: 0,
					code: "1 + 1",
					status: "ok",
					outputs: [],
					startedAt: 1,
					completedAt: 2,
					durationMs: 1,
				},
			},
		];
		const primeEvents = [
			["goal_update", "goal.updated"],
			["compaction_start", "compaction.started"],
			["compaction_end", "compaction.completed"],
			["recap_update", "recap.updated"],
			["refine_complete", "refine.completed"],
			["refine_failed", "refine.failed"],
		] as const;
		const spoken = ordinaryEvents
			.map((event) => mirrorAgentSessionEvent(event, spec)?.type)
			.concat(
				primeEvents.map(([name, expected]) => {
					const type = mirrorAgentSessionEvent(agentEvent(primeEvent(name)), spec)?.type;
					assert.equal(type, expected);
					return type;
				}),
			)
			.filter((type): type is NonNullable<typeof type> => type !== undefined);

		const hostCommitted = new Set([
			"command.accepted",
			"command.rejected",
			"command.completed",
			"command.failed",
			"command.cancelled",
			"runtime.bound",
			"runtime.quiescing",
			"runtime.quiescent",
			"runtime.passivated",
			"runtime.resumed",
			"runtime.fault",
			"kernel.checkpointed",
			"budget.ledger_updated",
			"schedule.created",
			"schedule.fired",
			"schedule.cancelled",
			"schedule.updated",
			"child.spawn_requested",
			"child.created",
			"child.run.completed",
			"child.run.failed",
			"child.run.cancelled",
		]);
		assert.deepEqual(
			[...new Set(spoken)].sort(),
			AGENT_SESSION_EVENT_TYPES.filter((type) => !hostCommitted.has(type)).sort(),
		);
	});

	it("rejects an opaque Prime child lifecycle snapshot rather than reclassifying it", () => {
		assert.throws(
			() =>
				mirrorAgentSessionEvent(
					{
						category: "agent",
						type: "prime_event",
						sandbox_id: "sb-1",
						ts: new Date(1000).toISOString(),
						event: {
							type: "prime_event",
							name: "rlm_child_update",
							payload: { childId: "child-1", status: "complete" },
							session_id: "ags-phanes",
							runtime_binding_digest: semantic.runtimeBindingDigest,
							agent_ontology_binding_digest: semantic.ontologyBindingDigest,
						},
					} as BusEvent,
					spec,
				),
			AgentSessionEventMirrorFault,
		);
	});

	it("persists only content-free capability testimony", () => {
		const mirrored = mirrorAgentSessionEvent(
			{
				category: "capability",
				type: "call",
				sandbox_id: "sb-1",
				ts: new Date(2000).toISOString(),
				call_id: "call-1",
				capability: "discord",
				operation: "search_messages",
				outcome: "ok",
				duration_ms: 7,
			} as BusEvent,
			spec,
		);

		assert.equal(mirrored?.type, "capability.called");
		assert.deepEqual(mirrored?.payload.value, {
			callId: "call-1",
			capability: "discord",
			operation: "search_messages",
			outcome: "ok",
			durationMs: 7,
		});
	});

	it("projects a dynamic ontological amendment call as a workflow proposal", () => {
		const mirrored = mirrorAgentSessionEvent(
			{
				category: "capability",
				type: "call",
				sandbox_id: "sb-1",
				ts: new Date(3000).toISOString(),
				call_id: "call-workflow-1",
				capability: "workflow",
				operation: "propose_amendment",
				outcome: "ok",
				duration_ms: 4,
			} as BusEvent,
			spec,
		);

		assert.equal(mirrored?.type, "workflow.proposed");
		assert.equal(mirrored?.payload.sourceType, "capability.call");
		assert.deepEqual(mirrored?.payload.meaningfulObjects.toolGrant, semantic.ontology.objects.toolGrant);
	});

	it("projects a queued amendment as proposed with its Meaningful Object provenance", () => {
		const amendment = {
			schema: "sophia.meaningful-object-ref.v1" as const,
			kind: "workflow-amendment" as const,
			ownerPrincipal: "user:test",
			graphId: "g1",
			objectId: "urn:sophia:workflow:run-1:amendment:a-1",
			version: "4",
			digest: `sha256:${"a".repeat(64)}`,
		};
		const mirrored = mirrorAgentSessionEvent(
			{
				category: "capability",
				type: "call",
				sandbox_id: "sb-1",
				ts: new Date(4000).toISOString(),
				call_id: "call-workflow-2",
				capability: "workflow",
				operation: "propose_amendment",
				outcome: "ok",
				duration_ms: 5,
				result_digest: `sha256:${"b".repeat(64)}`,
				object_refs: [amendment],
				decision: "proposed",
				revision: 4,
			} as BusEvent,
			spec,
		);

		assert.equal(mirrored?.type, "workflow.proposed");
		assert.deepEqual((mirrored?.payload.value as { objectRefs: unknown }).objectRefs, [amendment]);
		assert.equal((mirrored?.payload.value as { revision: number }).revision, 4);
	});

	it("preserves bounded capability-result and split budget telemetry for Vehicle", () => {
		for (const [name, expectedType] of [
			["capability_result", "artifact.published"],
			["budget_update", "budget.updated"],
		] as const) {
			const value =
				name === "capability_result"
					? { capability: "mnemosyne", tool: "get_workspace", serialized_bytes: 866_304, inline: false }
					: {
							session_tokens_used: 100_000,
							session_tokens_limit: 500_000,
							prompt_tokens_estimated: 80_000,
							prompt_tokens_limit: 240_000,
						};
			const mirrored = mirrorAgentSessionEvent(
				{
					category: "agent",
					type: "prime_event",
					sandbox_id: "sb-1",
					ts: new Date(5000).toISOString(),
					event: {
						type: "prime_event",
						name,
						payload: value,
						session_id: "ags-phanes",
						runtime_binding_digest: semantic.runtimeBindingDigest,
						agent_ontology_binding_digest: semantic.ontologyBindingDigest,
					},
				} as BusEvent,
				spec,
			);
			assert.equal(mirrored?.type, expectedType);
			assert.equal(mirrored?.payload.sourceType, `prime.${name}`);
			assert.deepEqual(mirrored?.payload.value, value);
		}
	});
});

function agentEvent(event: Record<string, unknown>): BusEvent {
	return {
		category: "agent",
		type: String(event.type),
		sandbox_id: "sb-1",
		ts: new Date(1000).toISOString(),
		event,
	} as BusEvent;
}

function primeEvent(name: string): Record<string, unknown> {
	return {
		type: "prime_event",
		name,
		payload: {},
		session_id: "ags-phanes",
		runtime_binding_digest: semantic.runtimeBindingDigest,
		agent_ontology_binding_digest: semantic.ontologyBindingDigest,
	};
}

function capabilityEvent(decision: "ordinary" | "proposed" | "accepted" | "rejected"): BusEvent {
	return {
		category: "capability",
		type: "call",
		sandbox_id: "sb-1",
		ts: new Date(1000).toISOString(),
		call_id: `call-${decision}`,
		capability: decision === "ordinary" ? "mnemosyne" : "workflow",
		operation: decision === "ordinary" ? "search_documents" : "propose_amendment",
		outcome: "ok",
		duration_ms: 1,
		...(decision === "ordinary" ? {} : { decision }),
	} as BusEvent;
}
