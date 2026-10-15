import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	parseRlmHeartbeatListResult,
	parseRlmHeartbeatMutationResult,
	parseRlmHeartbeatRequest,
	RlmHeartbeatContractFault,
} from "../agent-runtime/rlm-heartbeat-contract.js";

describe("RLM heartbeat contract", () => {
	it("accepts the exact Prime skill request vocabulary", () => {
		assert.deepEqual(parseRlmHeartbeatRequest({ type: "rlm_heartbeat.list", include_inactive: false }), {
			type: "rlm_heartbeat.list",
			include_inactive: false,
		});
		assert.deepEqual(
			parseRlmHeartbeatRequest({
				type: "rlm_heartbeat.create",
				instruction: "  Check the queue  ",
				interval: "every 5m",
				label: "  queue  ",
				delivery_mode: "follow_up",
			}),
			{
				type: "rlm_heartbeat.create",
				instruction: "Check the queue",
				interval: "every 5m",
				label: "queue",
				delivery_mode: "follow_up",
			},
		);
		assert.deepEqual(
			parseRlmHeartbeatRequest({
				type: "rlm_heartbeat.update",
				id: "heartbeat:queue",
				instruction: "Check twice",
				interval: "*/10 * * * *",
				label: "",
				status: "pause",
				delivery_mode: "steer",
			}),
			{
				type: "rlm_heartbeat.update",
				id: "heartbeat:queue",
				instruction: "Check twice",
				interval: "*/10 * * * *",
				label: "",
				status: "pause",
				delivery_mode: "steer",
			},
		);
		assert.deepEqual(parseRlmHeartbeatRequest({ type: "rlm_heartbeat.delete", id: "heartbeat:queue" }), {
			type: "rlm_heartbeat.delete",
			id: "heartbeat:queue",
		});
	});

	it("keeps Unicode instructions while enforcing the UTF-8 byte limit", () => {
		const request = parseRlmHeartbeatRequest({
			type: "rlm_heartbeat.create",
			instruction: "Revisa la síntesis y continúa ☀️",
		});
		assert.equal(request.type, "rlm_heartbeat.create");
		assert.equal(request.instruction, "Revisa la síntesis y continúa ☀️");
		assert.throws(
			() =>
				parseRlmHeartbeatRequest({
					type: "rlm_heartbeat.create",
					instruction: "☀".repeat(22_000),
				}),
			RlmHeartbeatContractFault,
		);
	});

	it("rejects aliases, unknown fields, empty mutations, and invalid modes", () => {
		for (const value of [
			{ type: "rlm_heartbeat.list", includeInactive: true },
			{ type: "rlm_heartbeat.create", instruction: "x", deliveryMode: "steer" },
			{ type: "rlm_heartbeat.create", instruction: "x", delivery_mode: "interrupt" },
			{ type: "rlm_heartbeat.update", id: "heartbeat:x" },
			{ type: "rlm_heartbeat.update", id: "heartbeat:x", status: "active" },
			{ type: "rlm_heartbeat.delete", id: "heartbeat:x", session_id: "ags_deadbeef" },
		]) {
			assert.throws(() => parseRlmHeartbeatRequest(value), RlmHeartbeatContractFault);
		}
	});

	it("parses the exact model projection and rejects internal or legacy coordinates", () => {
		const heartbeat = heartbeatRecord();
		assert.deepEqual(parseRlmHeartbeatListResult({ heartbeats: [heartbeat] }), { heartbeats: [heartbeat] });
		assert.deepEqual(parseRlmHeartbeatMutationResult({ heartbeat }), { heartbeat });
		assert.deepEqual(parseRlmHeartbeatMutationResult({ heartbeat: null }), { heartbeat: null });

		for (const poison of [
			{ ...heartbeat, claim_token: "secret" },
			{ ...heartbeat, consumer: "scheduler-a" },
			{ ...heartbeat, sandbox_id: "sandbox-1" },
			{ ...heartbeat, authority_owner: "user:ada" },
			{ ...heartbeat, deliveryMode: "steer" },
		]) {
			assert.throws(() => parseRlmHeartbeatMutationResult({ heartbeat: poison }), RlmHeartbeatContractFault);
		}
	});

	it("rejects noncanonical result state, timestamps, and counters", () => {
		for (const heartbeat of [
			heartbeatRecord({ status: "enabled" }),
			heartbeatRecord({ status: "completed" }),
			heartbeatRecord({ status: "active", next_run_at: null }),
			heartbeatRecord({ status: "paused", next_run_at: "2026-08-08T12:10:00.000Z" }),
			heartbeatRecord({ label: "" }),
			heartbeatRecord({ revision: -1 }),
			heartbeatRecord({ run_count: 1.5 }),
			heartbeatRecord({ created_at: "today" }),
			heartbeatRecord({ next_run_at: undefined }),
			heartbeatRecord({ id: "../escape" }),
		]) {
			assert.throws(() => parseRlmHeartbeatMutationResult({ heartbeat }), RlmHeartbeatContractFault);
		}
	});
});

function heartbeatRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "heartbeat:queue",
		revision: 2,
		status: "paused",
		label: "queue",
		delivery_mode: "follow_up",
		instruction: "Check the queue",
		schedule: "every 5m",
		created_at: "2026-08-08T12:00:00.000Z",
		updated_at: "2026-08-08T12:05:00.000Z",
		next_run_at: null,
		last_run_at: "2026-08-08T12:04:00.000Z",
		last_error: null,
		run_count: 1,
		...overrides,
	};
}
