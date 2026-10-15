import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { DomainAgentInvocationRequestV1, ResolvedDomainAgentConfigV1 } from "../workflow/domain-agent-config.js";
import { commitDomainSourceTurn, DomainSourceTurnError } from "../workflow/domain-source-turn.js";
import { INVOCATION_ENVELOPE_SCHEMA, type InvocationEnvelopeV1 } from "../workflow/invocation.js";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";

const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EVENT_REF = `urn:phanes:discord:source-event:${EVENT_ID}`;
const AGENT_ID = "agent-7068616e65730001";

function request(overrides: Partial<DomainAgentInvocationRequestV1> = {}): DomainAgentInvocationRequestV1 {
	return {
		definitionDocumentId: "phanes-domain-agent",
		trigger: {
			kind: "discord.message.mention",
			eventId: EVENT_ID,
			resource: "discord:guild:1:channel:2:message:3",
		},
		contextRefs: [EVENT_REF],
		sourceCommit: { eventId: EVENT_ID, sourceRef: EVENT_REF, digest: "a".repeat(64) },
		...overrides,
	};
}

function resolved(): ResolvedDomainAgentConfigV1 {
	return {
		definition: { agentId: AGENT_ID, homeGraphId: "phanes" },
		triggerBinding: {
			kind: "discord.message.mention",
			enabled: true,
			ingress: "internal-service",
			adapter: "discord",
		},
	} as ResolvedDomainAgentConfigV1;
}

function invocation(invocationId = "inv-phanes-first"): InvocationEnvelopeV1 {
	return {
		schema: INVOCATION_ENVELOPE_SCHEMA,
		invocationId,
		target: {
			workflowName: "domain-agent-activity-loop-v1",
			definitionDigest: "b".repeat(64),
		},
		input: {},
		actorRef: "user:ada",
		graph: { ownerPrincipal: "user:ada", graphId: "phanes" },
		cause: { kind: "trigger", ref: EVENT_REF },
		idempotencyKey: `phanes:${EVENT_ID}`,
	};
}

describe("Phanes-strength generic Domain Agent source turns", () => {
	it("commits before launch and returns the original turn across disposable embodiments", async () => {
		const root = mkdtempSync(join(tmpdir(), "domain-source-turn-"));
		const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
		try {
			await runtime.init();
			const first = await commitDomainSourceTurn({
				runtime,
				request: request(),
				resolved: resolved(),
				graphOwnerPrincipal: "user:ada",
				graphId: "phanes",
				actorRef: "user:ada",
				caller: { authMethod: "internal-service", triggerAdapter: "discord" },
				invocation: invocation(),
				now: 100,
			});
			const replay = await commitDomainSourceTurn({
				runtime,
				request: request(),
				resolved: resolved(),
				graphOwnerPrincipal: "user:ada",
				graphId: "phanes",
				actorRef: "user:ada",
				caller: { authMethod: "internal-service", triggerAdapter: "discord" },
				invocation: invocation("inv-phanes-retry-new-sandbox"),
				now: 200,
			});

			assert.equal(replay.turnId, first.turnId);
			assert.equal(replay.committedAt, 100);
			const stored = await runtime.getDomainSourceTurn(first.turnId);
			assert.equal(stored?.first_invocation_id, "inv-phanes-first");
			assert.equal(stored?.source_ref, EVENT_REF);
		} finally {
			runtime.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects changed evidence at the same source identity", async () => {
		const root = mkdtempSync(join(tmpdir(), "domain-source-conflict-"));
		const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
		try {
			await runtime.init();
			const common = {
				runtime,
				resolved: resolved(),
				graphOwnerPrincipal: "user:ada",
				graphId: "phanes",
				actorRef: "user:ada",
				caller: { authMethod: "internal-service" as const, triggerAdapter: "discord" },
				invocation: invocation(),
			};
			await commitDomainSourceTurn({ ...common, request: request(), now: 100 });
			await assert.rejects(
				commitDomainSourceTurn({
					...common,
					request: request({
						trigger: {
							kind: "discord.message.mention",
							eventId: EVENT_ID,
							resource: "discord:guild:1:channel:999:message:3",
						},
					}),
					now: 200,
				}),
				(error: unknown) => error instanceof DomainSourceTurnError && error.code === "source_turn_conflict",
			);
		} finally {
			runtime.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not let owner ingress self-attest an external source commit", async () => {
		const root = mkdtempSync(join(tmpdir(), "domain-source-untrusted-"));
		const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
		try {
			await runtime.init();
			await assert.rejects(
				commitDomainSourceTurn({
					runtime,
					request: request(),
					resolved: {
						...resolved(),
						triggerBinding: { kind: "manual", enabled: true, ingress: "owner" },
					},
					graphOwnerPrincipal: "user:ada",
					graphId: "phanes",
					actorRef: "user:ada",
					caller: { authMethod: "owner" },
					invocation: invocation(),
				}),
				(error: unknown) => error instanceof DomainSourceTurnError && error.code === "source_commit_untrusted",
			);
		} finally {
			runtime.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
