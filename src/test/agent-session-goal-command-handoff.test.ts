import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	emptyPrimeGoalHandoffState,
	PrimeGoalHandoffConflict,
	type PrimeGoalHandoffState,
	reducePrimeGoalWorkerMessage,
	registerPrimeGoalCommand,
} from "../agent-runtime/goal-command-handoff.js";

function command(state: PrimeGoalHandoffState, commandId: string, name: "goal.get" | "goal.create" | "goal.complete") {
	return registerPrimeGoalCommand(state, { commandId, idempotencyKey: `idem-${commandId}`, name }).state;
}

function response(status: "active" | "complete" = "active") {
	return {
		goal: {
			goal_id: "goal-1",
			objective: "freeze H1 host authority",
			status,
			token_budget: 10,
			tokens_used: 0,
			time_used_seconds: 0,
			created_at: 1,
			updated_at: 1,
		},
		remaining_tokens: 10,
		completion_budget_report: status === "complete" ? "Goal complete before its token budget." : null,
	};
}

function witness(workerSequence: number) {
	return { type: "goal.updated" as const, sessionId: "ags-1", generation: 0, workerSequence };
}

function result(
	workerSequence: number,
	commandId: string,
	commandName: "goal.get" | "goal.create" | "goal.complete",
	status: "completed" | "failed" = "completed",
) {
	return {
		type: "command.result" as const,
		sessionId: "ags-1",
		generation: 0,
		workerSequence,
		commandId,
		commandName,
		status,
		...(status === "completed"
			? { result: response(commandName === "goal.complete" ? "complete" : "active") }
			: { error: "goal request rejected" }),
	};
}

describe("Agent Session H1 goal command handoff", () => {
	it("uses the immediately preceding opaque goal_update only as a witness, then yields one reducer input", () => {
		let state = command(emptyPrimeGoalHandoffState(), "cmd-create", "goal.create");
		const observed = reducePrimeGoalWorkerMessage(state, witness(4));
		state = observed.state;
		assert.equal(observed.reducerInput, undefined, "opaque worker testimony is never a parallel durable mirror");

		const settled = reducePrimeGoalWorkerMessage(state, result(5, "cmd-create", "goal.create"));
		assert.deepEqual(settled.reducerInput, {
			schema: "choreograph.prime-goal-command-handoff.v1",
			source: "prime-command-result",
			commandId: "cmd-create",
			idempotencyKey: "idem-cmd-create",
			commandName: "goal.create",
			sessionId: "ags-1",
			generation: 0,
			goalUpdatedWorkerSequence: 4,
			commandResultWorkerSequence: 5,
			response: response(),
		});
		assert.equal(settled.state.pendingGoalUpdate, null);
	});

	it("correlates goal.get solely through its durable command result", () => {
		const state = command(emptyPrimeGoalHandoffState(), "cmd-get", "goal.get");
		const settled = reducePrimeGoalWorkerMessage(state, result(2, "cmd-get", "goal.get"));
		assert.equal(settled.reducerInput, undefined);
		assert.equal(settled.state.commands["cmd-get"]?.resultDigest?.startsWith("sha256:"), true);
	});

	it("requires adjacency and rejects an opaque witness before get or a failed command", () => {
		let state = command(emptyPrimeGoalHandoffState(), "cmd-create", "goal.create");
		state = reducePrimeGoalWorkerMessage(state, witness(3)).state;
		assert.throws(
			() => reducePrimeGoalWorkerMessage(state, result(5, "cmd-create", "goal.create")),
			PrimeGoalHandoffConflict,
		);

		state = command(emptyPrimeGoalHandoffState(), "cmd-get", "goal.get");
		state = reducePrimeGoalWorkerMessage(state, witness(3)).state;
		assert.throws(
			() => reducePrimeGoalWorkerMessage(state, result(4, "cmd-get", "goal.get")),
			PrimeGoalHandoffConflict,
		);

		state = command(emptyPrimeGoalHandoffState(), "cmd-complete", "goal.complete");
		assert.throws(
			() =>
				reducePrimeGoalWorkerMessage(state, {
					...result(1, "cmd-complete", "goal.complete", "failed"),
					result: response("complete"),
				}),
			PrimeGoalHandoffConflict,
		);
	});

	it("deduplicates exact worker sequences and durable command identity, but fails closed on divergence", () => {
		let state = command(emptyPrimeGoalHandoffState(), "cmd-create", "goal.create");
		const firstWitness = witness(7);
		state = reducePrimeGoalWorkerMessage(state, firstWitness).state;
		assert.equal(reducePrimeGoalWorkerMessage(state, firstWitness).duplicate, true);
		assert.throws(
			() => reducePrimeGoalWorkerMessage(state, { ...firstWitness, sessionId: "ags-other" }),
			PrimeGoalHandoffConflict,
		);

		const settled = reducePrimeGoalWorkerMessage(state, result(8, "cmd-create", "goal.create"));
		assert.equal(reducePrimeGoalWorkerMessage(settled.state, result(8, "cmd-create", "goal.create")).duplicate, true);
		const replayedAtNewSequence = reducePrimeGoalWorkerMessage(settled.state, result(9, "cmd-create", "goal.create"));
		assert.equal(replayedAtNewSequence.duplicate, true);
		assert.ok(replayedAtNewSequence.state.workerReceipts["ags-1:0:9"]);
		assert.throws(
			() =>
				reducePrimeGoalWorkerMessage(replayedAtNewSequence.state, {
					...result(10, "cmd-create", "goal.create"),
					result: { ...response(), goal: { ...response().goal, objective: "divergent result" } },
				}),
			PrimeGoalHandoffConflict,
		);
		assert.equal(
			registerPrimeGoalCommand(settled.state, {
				commandId: "cmd-create",
				idempotencyKey: "idem-cmd-create",
				name: "goal.create",
			}).duplicate,
			true,
		);
		assert.throws(
			() =>
				registerPrimeGoalCommand(settled.state, {
					commandId: "cmd-other",
					idempotencyKey: "idem-cmd-create",
					name: "goal.create",
				}),
			PrimeGoalHandoffConflict,
		);
	});

	it("retains first-wins terminal ownership across a restored handoff state", () => {
		let state = command(emptyPrimeGoalHandoffState(), "cmd-complete-a", "goal.complete");
		state = reducePrimeGoalWorkerMessage(state, witness(10)).state;
		const settled = reducePrimeGoalWorkerMessage(state, result(11, "cmd-complete-a", "goal.complete"));
		const restored = structuredClone(settled.state);
		assert.equal(
			reducePrimeGoalWorkerMessage(restored, result(11, "cmd-complete-a", "goal.complete")).duplicate,
			true,
		);
		state = command(restored, "cmd-complete-b", "goal.complete");
		state = reducePrimeGoalWorkerMessage(state, witness(12)).state;
		assert.throws(
			() => reducePrimeGoalWorkerMessage(state, result(13, "cmd-complete-b", "goal.complete")),
			PrimeGoalHandoffConflict,
		);
	});
});
