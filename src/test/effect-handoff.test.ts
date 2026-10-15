import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";

function offered(now = 100) {
	return {
		idempotencyKey: "effect:trusted-turn-1:0",
		executionDigest: "a".repeat(64),
		proposalDigest: "b".repeat(64),
		runId: "wfr-disposable-1",
		graphId: "phanes",
		agentId: "agent-7068616e65730001",
		actorRef: "agent:phanes-listener",
		grantId: "grant-phanes",
		grantDocumentId: "grant-phanes",
		grantAuthorityGraphId: "observatory",
		grantAuthorityOwnerPrincipal: "user:platform-steward",
		grantDigest: "c".repeat(64),
		definitionDigest: "d".repeat(64),
		sourceTurnId: `turn:${"1".repeat(64)}`,
		sourceTurnDigest: "2".repeat(64),
		sourceOwnerPrincipal: "user:ada",
		sourceTurn: { schema: "sophia.domain-source-turn.v1", turnId: `turn:${"1".repeat(64)}` },
		capability: "discord",
		operation: "message.reply",
		proposal: {
			schema: "sophia.proposed-effect.v1",
			effectId: "reply-1",
			idempotencyKey: "effect:trusted-turn-1:0",
			capability: "discord",
			operation: "message.reply",
			arguments: {
				resource: "discord:guild:1:channel:2:message:3",
				channelId: "2",
				replyToMessageId: "3",
				text: "hello",
			},
			reason: "answer",
			evidenceRefs: ["urn:phanes:source-event:1"],
		},
		trigger: {
			kind: "discord.message.mention",
			eventId: "source-event-1",
			resource: "discord:guild:1:channel:2:message:3",
		},
		approval: {
			effectId: "reply-1",
			grantId: "grant-phanes",
			proposalDigest: "b".repeat(64),
			approvedBy: "user:ada",
			approvedAt: 99,
		},
		effectIndex: 0,
		now,
	};
}

describe("durable external-effect handoff", () => {
	it("converges offers, leases recoverably, and rejects a stale consumer", async () => {
		const root = mkdtempSync(join(tmpdir(), "effect-handoff-"));
		const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
		try {
			await runtime.init();
			const first = await runtime.offerEffectHandoff(offered());
			const replay = await runtime.offerEffectHandoff({ ...offered(), runId: "wfr-disposable-2" });
			assert.equal(first.created, true);
			assert.equal((first.record.approval as { approvedBy: string }).approvedBy, "user:ada");
			assert.equal(replay.created, false);
			assert.equal(replay.record.run_id, "wfr-disposable-1");
			await assert.rejects(
				() => runtime.offerEffectHandoff({ ...offered(), executionDigest: "e".repeat(64) }),
				/conflicts with different content/,
			);

			const firstLease = await runtime.claimEffectHandoff({
				consumer: "phanes-a",
				capabilities: ["discord"],
				leaseMs: 10,
				now: 110,
			});
			assert.equal(firstLease?.state, "claimed");
			assert.equal(firstLease?.attempt, 1);
			assert.equal(
				await runtime.claimEffectHandoff({
					consumer: "phanes-b",
					capabilities: ["discord"],
					leaseMs: 10,
					now: 115,
				}),
				null,
			);
			const recovered = await runtime.claimEffectHandoff({
				consumer: "phanes-b",
				capabilities: ["discord"],
				leaseMs: 10,
				now: 121,
			});
			assert.equal(recovered?.attempt, 2);
			assert.notEqual(recovered?.claim_token, firstLease?.claim_token);
			await assert.rejects(
				() =>
					runtime.completeEffectHandoff({
						idempotencyKey: firstLease!.idempotency_key,
						consumer: "phanes-a",
						claimToken: firstLease!.claim_token!,
						outcome: "executed",
						completion: { messageId: "4" },
						now: 122,
					}),
				/lost lease/,
			);
			const complete = await runtime.completeEffectHandoff({
				idempotencyKey: recovered!.idempotency_key,
				consumer: "phanes-b",
				claimToken: recovered!.claim_token!,
				outcome: "executed",
				completion: { messageId: "4" },
				now: 123,
			});
			assert.equal(complete.state, "executed");
			assert.deepEqual(complete.completion, { messageId: "4" });
			assert.equal(
				await runtime.claimEffectHandoff({
					consumer: "phanes-c",
					capabilities: ["discord"],
					leaseMs: 10,
					now: 200,
				}),
				null,
			);
		} finally {
			runtime.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("makes a retryable failure visible but unavailable until its backoff expires", async () => {
		const root = mkdtempSync(join(tmpdir(), "effect-retry-"));
		const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
		try {
			await runtime.init();
			await runtime.offerEffectHandoff(offered());
			const lease = await runtime.claimEffectHandoff({
				consumer: "phanes",
				capabilities: ["discord"],
				leaseMs: 100,
				now: 110,
			});
			const retried = await runtime.completeEffectHandoff({
				idempotencyKey: lease!.idempotency_key,
				consumer: "phanes",
				claimToken: lease!.claim_token!,
				outcome: "failed-retryable",
				completion: { error: "rate limited" },
				retryAfterMs: 50,
				now: 120,
			});
			assert.equal(retried.state, "ready");
			assert.deepEqual(retried.completion, { error: "rate limited" });
			assert.equal(
				await runtime.claimEffectHandoff({ consumer: "phanes", capabilities: ["discord"], leaseMs: 100, now: 169 }),
				null,
			);
			assert.equal(
				(
					await runtime.claimEffectHandoff({
						consumer: "phanes",
						capabilities: ["discord"],
						leaseMs: 100,
						now: 170,
					})
				)?.attempt,
				2,
			);
		} finally {
			runtime.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
