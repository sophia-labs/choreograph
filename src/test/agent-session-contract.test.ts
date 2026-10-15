import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AGENT_SESSION_COMMAND_SCHEMA,
	AGENT_SESSION_EVENT_SCHEMA,
	AGENT_SESSION_EVENT_TYPES,
	AGENT_SESSION_SCHEDULE_CANCELLED_PAYLOAD_SCHEMA,
	AGENT_SESSION_SCHEDULE_CREATED_PAYLOAD_SCHEMA,
	AGENT_SESSION_SCHEDULE_FIRED_PAYLOAD_SCHEMA,
	AGENT_SESSION_SCHEDULE_UPDATED_PAYLOAD_SCHEMA,
	AgentSessionContractFault,
	agentSessionWorkerDedupeKey,
	DRAFT_AGENT_SESSION_EVENT_TYPES,
	validateAgentSessionCommand,
	validateAgentSessionEventEnvelope,
} from "../agent-runtime/session-contract.js";

describe("canonical agent session contracts", () => {
	it("validates a generation-bound committed event", () => {
		const event = {
			schema: AGENT_SESSION_EVENT_SCHEMA,
			eventId: "evt-1",
			sessionId: "ags-1",
			sequence: 9,
			sandbox: { id: "sbx-1", generation: 3, workerSequence: 4 },
			type: "tool.completed",
			payloadVersion: 1,
			occurredAt: "2026-08-05T20:00:00.000Z",
			committedAt: "2026-08-05T20:00:00.100Z",
			actor: { principalId: "user:ada", agentId: "agent-a", observerId: "agent-a" },
			correlationId: "corr-1",
			commandId: "cmd-1",
			visibility: "public",
			payload: { tool: "search_documents" },
		};
		validateAgentSessionEventEnvelope(event);
		assert.equal(agentSessionWorkerDedupeKey(event), "ags-1:sbx-1:3:4");
	});

	it("validates one typed idempotent command surface", () => {
		const command = {
			schema: AGENT_SESSION_COMMAND_SCHEMA,
			commandId: "cmd-1",
			idempotencyKey: "idem-1",
			sessionId: "ags-1",
			expectedRevision: 8,
			expectedGeneration: 3,
			actor: { principalId: "user:ada" },
			driverLeaseId: "lease-1",
			submittedAt: "2026-08-05T20:00:00.000Z",
			deadlineMs: 30_000,
			name: "permission.resolve",
			payload: { permissionRequestId: "perm-1", decision: "allow_once" },
		};
		validateAgentSessionCommand(command);
	});

	it("ratifies only event types with production testimony", () => {
		assert.equal(AGENT_SESSION_EVENT_TYPES.length, 46);
		assert.equal(DRAFT_AGENT_SESSION_EVENT_TYPES.length, 19);
		assert.equal(
			new Set([...AGENT_SESSION_EVENT_TYPES, ...DRAFT_AGENT_SESSION_EVENT_TYPES]).size,
			AGENT_SESSION_EVENT_TYPES.length + DRAFT_AGENT_SESSION_EVENT_TYPES.length,
			"the ratified vocabulary and draft annex must remain disjoint",
		);

		for (const type of AGENT_SESSION_EVENT_TYPES) {
			validateAgentSessionEventEnvelope(eventEnvelope(type));
		}
		for (const type of DRAFT_AGENT_SESSION_EVENT_TYPES) {
			assert.throws(() => validateAgentSessionEventEnvelope(eventEnvelope(type)), AgentSessionContractFault);
		}
		validateAgentSessionEventEnvelope(eventEnvelope("budget.ledger_updated"));
		validateAgentSessionEventEnvelope(eventEnvelope("child.run.failed"));
		validateAgentSessionEventEnvelope(eventEnvelope("child.run.cancelled"));
		assert.throws(
			() => validateAgentSessionEventEnvelope(eventEnvelope("budget.updated")),
			AgentSessionContractFault,
			"the pre-ratification budget name must not remain as an alias",
		);
	});

	it("requires complete schedule testimony with stable request, command, and fire causation", () => {
		for (const type of ["schedule.created", "schedule.fired", "schedule.cancelled", "schedule.updated"] as const) {
			validateAgentSessionEventEnvelope(eventEnvelope(type));
		}

		const fired = eventEnvelope("schedule.fired");
		assert.throws(
			() => validateAgentSessionEventEnvelope({ ...fired, causationId: "fire-other" }),
			AgentSessionContractFault,
		);
		const created = eventEnvelope("schedule.created");
		assert.throws(
			() => validateAgentSessionEventEnvelope({ ...created, causationId: "req-other" }),
			AgentSessionContractFault,
		);
		assert.throws(
			() => validateAgentSessionEventEnvelope({ ...created, commandId: "cmd-should-not-exist" }),
			AgentSessionContractFault,
		);
		assert.throws(
			() =>
				validateAgentSessionEventEnvelope({
					...fired,
					payload: { ...(fired.payload as Record<string, unknown>), commandId: "cmd-other" },
				}),
			AgentSessionContractFault,
		);
		assert.throws(
			() =>
				validateAgentSessionEventEnvelope({
					...eventEnvelope("schedule.created"),
					payload: {
						...(eventEnvelope("schedule.created").payload as Record<string, unknown>),
						localTimerHandle: 17,
					},
				}),
			AgentSessionContractFault,
		);
		const updated = eventEnvelope("schedule.updated");
		for (const poison of [
			{ ...updated, causationId: "request-other" },
			{ ...updated, commandId: "cmd-not-an-activation" },
			{
				...updated,
				payload: { ...(updated.payload as Record<string, unknown>), resultingRevision: 2 },
			},
			{
				...updated,
				payload: { ...(updated.payload as Record<string, unknown>), schema: "schedule.updated.unratified" },
			},
			{
				...updated,
				payload: { ...(updated.payload as Record<string, unknown>), priorState: "completed" },
			},
			{
				...updated,
				payload: { ...(updated.payload as Record<string, unknown>), action: { kind: "pause", reason: "hidden" } },
			},
			{
				...updated,
				payload: { ...(updated.payload as Record<string, unknown>), nextFireAt: "not-a-time" },
			},
			{
				...updated,
				payload: { ...(updated.payload as Record<string, unknown>), rawGrantDigest: "secret" },
			},
		]) {
			assert.throws(() => validateAgentSessionEventEnvelope(poison), AgentSessionContractFault);
		}
	});

	it("accepts only the hard-cut UTC schedule creation command", () => {
		const command = {
			schema: AGENT_SESSION_COMMAND_SCHEMA,
			commandId: "cmd-schedule-create",
			idempotencyKey: "idem-schedule-create",
			sessionId: "ags-1",
			actor: { principalId: "user:ada" },
			submittedAt: "2026-08-07T20:00:00.000Z",
			name: "schedule.create",
			payload: {
				scheduleId: "sch-1",
				schedule: { kind: "interval", expression: "every 5m", timeZone: "UTC", intervalMs: 300_000 },
				input: { text: "continue", attachmentRefs: ["artifact:brief"] },
				nextFireAt: "2026-08-07T20:05:00.000Z",
			},
		};
		validateAgentSessionCommand(command);

		assert.throws(
			() =>
				validateAgentSessionCommand({
					...command,
					payload: { scheduleId: "sch-1", dueAt: "2026-08-07T20:05:00.000Z", payload: "continue" },
				}),
			AgentSessionContractFault,
		);
		assert.throws(
			() =>
				validateAgentSessionCommand({
					...command,
					payload: {
						...command.payload,
						schedule: { ...command.payload.schedule, timeZone: "America/Montevideo" },
					},
				}),
			AgentSessionContractFault,
		);
	});

	it("admits only strict durable host goal commands", () => {
		const base = {
			schema: AGENT_SESSION_COMMAND_SCHEMA,
			commandId: "cmd-goal",
			idempotencyKey: "idem-goal",
			sessionId: "ags-1",
			actor: { principalId: "host:goal" },
			submittedAt: "2026-08-09T12:00:00.000Z",
		};
		for (const command of [
			{ ...base, name: "goal.get", payload: {} },
			{
				...base,
				commandId: "cmd-goal-create",
				name: "goal.create",
				payload: { objective: "Finish H2", tokenBudget: 12 },
			},
			{ ...base, commandId: "cmd-goal-complete", name: "goal.complete", payload: {} },
		]) {
			validateAgentSessionCommand(command);
		}
		assert.throws(
			() => validateAgentSessionCommand({ ...base, name: "goal.get", payload: { injected: true } }),
			AgentSessionContractFault,
		);
		assert.throws(
			() => validateAgentSessionCommand({ ...base, name: "goal.complete", payload: { goalId: "forged" } }),
			AgentSessionContractFault,
		);
		assert.throws(
			() =>
				validateAgentSessionCommand({ ...base, name: "goal.create", payload: { objective: "", tokenBudget: 0 } }),
			AgentSessionContractFault,
		);
	});

	it("rejects client events with unknown types and malformed commands", () => {
		assert.throws(
			() =>
				validateAgentSessionEventEnvelope({
					schema: AGENT_SESSION_EVENT_SCHEMA,
					eventId: "evt",
					sessionId: "ags",
					sequence: 0,
					type: "model.says_it_finished",
					payloadVersion: 1,
					occurredAt: "2026-08-05T20:00:00.000Z",
					committedAt: "2026-08-05T20:00:00.000Z",
					actor: { principalId: "user:ada" },
					correlationId: "corr",
					visibility: "public",
					payload: {},
				}),
			AgentSessionContractFault,
		);
		assert.throws(
			() =>
				validateAgentSessionCommand({
					schema: AGENT_SESSION_COMMAND_SCHEMA,
					commandId: "cmd",
					idempotencyKey: "idem",
					sessionId: "ags",
					actor: { principalId: "user:ada" },
					submittedAt: "not-a-time",
					name: "prompt",
					payload: { text: "hi" },
				}),
			AgentSessionContractFault,
		);
	});
});

function eventEnvelope(type: string): Record<string, unknown> {
	const envelope: Record<string, unknown> = {
		schema: AGENT_SESSION_EVENT_SCHEMA,
		eventId: `evt-${type}`,
		sessionId: "ags-1",
		sequence: 0,
		type,
		payloadVersion: 1,
		occurredAt: "2026-08-07T20:00:00.000Z",
		committedAt: "2026-08-07T20:00:00.000Z",
		actor: { principalId: "choreograph.agent-worker" },
		correlationId: "corr-1",
		visibility: "public",
		payload: {},
	};
	if (type === "schedule.created") {
		return {
			...envelope,
			causationId: "req-schedule-create",
			payload: {
				schema: AGENT_SESSION_SCHEDULE_CREATED_PAYLOAD_SCHEMA,
				scheduleId: "sch-1",
				requestId: "req-schedule-create",
				schedule: { kind: "interval", expression: "every 5m", timeZone: "UTC", intervalMs: 300_000 },
				input: { text: "continue", attachmentRefs: ["artifact:brief"] },
				nextFireAt: "2026-08-07T20:05:00.000Z",
			},
		};
	}
	if (type === "schedule.fired") {
		return {
			...envelope,
			commandId: "cmd-schedule-activation",
			causationId: "fire-1",
			payload: {
				schema: AGENT_SESSION_SCHEDULE_FIRED_PAYLOAD_SCHEMA,
				scheduleId: "sch-1",
				fireId: "fire-1",
				commandId: "cmd-schedule-activation",
				scheduledAt: "2026-08-07T20:05:00.000Z",
				claimedAt: "2026-08-07T20:05:00.010Z",
				nextFireAt: "2026-08-07T20:10:00.000Z",
			},
		};
	}
	if (type === "schedule.updated") {
		return {
			...envelope,
			causationId: "control-update",
			payload: {
				schema: AGENT_SESSION_SCHEDULE_UPDATED_PAYLOAD_SCHEMA,
				scheduleId: "sch-1",
				requestId: "control-update",
				priorRevision: 0,
				resultingRevision: 1,
				action: { kind: "pause" },
				priorState: "active",
				resultingState: "paused",
				nextFireAt: null,
			},
		};
	}
	if (type === "schedule.cancelled") {
		return {
			...envelope,
			causationId: "req-schedule-cancel",
			payload: {
				schema: AGENT_SESSION_SCHEDULE_CANCELLED_PAYLOAD_SCHEMA,
				scheduleId: "sch-1",
				requestId: "req-schedule-cancel",
				reason: "requested",
			},
		};
	}
	return envelope;
}
