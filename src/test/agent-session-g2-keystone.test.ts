import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AGENT_SESSION_SCHEDULE_CONTROL_SCHEMA,
	type AgentSessionScheduleControlRequestV1,
	type AgentSessionScheduleCreationOptionsV1,
} from "../agent-runtime/agent-session-schedule-control.js";
import {
	AGENT_SESSION_SCHEDULE_GRANT_SNAPSHOT_SCHEMA,
	type AgentSessionScheduleGrantSnapshotV1,
	agentSessionScheduleGrantSnapshotDigest,
	bindAgentSessionScheduleGrantSnapshot,
} from "../workflow/agent-session-schedule-grant.js";
import { type AgentToolGrantV1, type GrantedToolbeltV1, grantDigest } from "../workflow/agent-tool-grant.js";

describe("Arc G2 keystone contracts", () => {
	it("freezes one future-only update/pause/resume control vocabulary", () => {
		const creation: AgentSessionScheduleCreationOptionsV1 = {
			source: "rlm_heartbeat",
			label: "queue",
			deliveryMode: "follow_up",
			grantSnapshotDigest: "a".repeat(64),
		};
		const controls: readonly AgentSessionScheduleControlRequestV1[] = [
			{
				schema: AGENT_SESSION_SCHEDULE_CONTROL_SCHEMA,
				requestId: "request-update",
				scheduleId: "heartbeat:queue",
				expectedRevision: 2,
				action: {
					kind: "update",
					input: { text: "Check the queue" },
					label: "queue",
					deliveryMode: "follow_up",
				},
			},
			{
				schema: AGENT_SESSION_SCHEDULE_CONTROL_SCHEMA,
				requestId: "request-pause",
				scheduleId: "heartbeat:queue",
				action: { kind: "pause" },
			},
			{
				schema: AGENT_SESSION_SCHEDULE_CONTROL_SCHEMA,
				requestId: "request-resume",
				scheduleId: "heartbeat:queue",
				action: { kind: "resume" },
			},
		];
		assert.deepEqual(
			controls.map((control) => control.action.kind),
			["update", "pause", "resume"],
		);
		assert.equal(creation.source, "rlm_heartbeat");
	});

	it("binds exact grant bytes and authority coordinates under one deterministic digest", () => {
		const snapshot = grantSnapshot();
		const first = bindAgentSessionScheduleGrantSnapshot(snapshot);
		const replay = bindAgentSessionScheduleGrantSnapshot(structuredClone(snapshot));
		assert.deepEqual(replay, first);
		assert.equal(first.digest, agentSessionScheduleGrantSnapshotDigest(snapshot));
		assert.match(first.digest, /^[0-9a-f]{64}$/);

		const drifted = grantSnapshot({ graphOwnerPrincipal: "organization:other" });
		assert.notEqual(agentSessionScheduleGrantSnapshotDigest(drifted), first.digest);
	});

	it("defines durable authority without credential or adapter fields", () => {
		const serialized = JSON.stringify(grantSnapshot());
		for (const forbidden of ["bearer", "apiToken", "api_key", "authContext", "adapter", "closure"]) {
			assert.equal(serialized.includes(forbidden), false, forbidden);
		}
	});
});

function grantSnapshot(
	overrides: Partial<AgentSessionScheduleGrantSnapshotV1> = {},
): AgentSessionScheduleGrantSnapshotV1 {
	const grant: AgentToolGrantV1 = {
		schema: "sophia.agent-toolbelt-grant.v1",
		grantId: "grant-1",
		subjectAgentId: "agent-1",
		issuedBy: "user:ada",
		authorityGraphId: "observatory",
		issuedAt: 100,
		status: "active",
		capabilities: [],
		sourceRefs: ["urn:grant:1"],
	};
	const toolbelt: GrantedToolbeltV1 = {
		schema: "sophia.granted-toolbelt.v1",
		grantId: "grant-1",
		grantDigest: grantDigest(grant),
		manifestId: "manifest-1",
		manifestHash: "b".repeat(64),
		agentId: "agent-1",
		tools: [],
		capabilities: [],
		suppressions: [],
		failures: [],
		resolvedAt: 100,
	};
	return {
		schema: AGENT_SESSION_SCHEDULE_GRANT_SNAPSHOT_SCHEMA,
		agentId: "agent-1",
		runtimeBindingDigest: `sha256:${"c".repeat(64)}`,
		agentOntologyDigest: `sha256:${"d".repeat(64)}`,
		ownerUserId: "ada",
		graphOwnerPrincipal: "user:ada",
		graphId: "prime-notebook-lab",
		grantAuthorityGraphId: "observatory",
		grantAuthorityOwnerPrincipal: "user:ada",
		grantDocumentId: "grant-document",
		grant,
		toolbelt,
		capturedAt: 100,
		...overrides,
	};
}
