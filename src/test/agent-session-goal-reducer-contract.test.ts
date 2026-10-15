import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	emptyGoalReducerState,
	GoalReducerConflict,
	type GoalReducerState,
	reduceGoalOperation,
} from "../agent-runtime/goal-reducer-contract.js";

function create(state: GoalReducerState, key = "create-1") {
	return reduceGoalOperation(state, {
		kind: "goal.create",
		idempotencyKey: key,
		commandId: "cmd-create",
		goalId: "goal-1",
		objective: "freeze H1",
		tokenBudget: 10,
		at: 1,
	});
}

describe("Agent Session H1 goal reducer contract", () => {
	it("derives creation and completion through one host-owned goal.updated shape", () => {
		const created = create(emptyGoalReducerState());
		assert.equal(created.emission?.type, "goal.updated");
		assert.equal(created.emission?.payload.source, "host-reducer");
		assert.equal(created.emission?.payload.goal.status, "active");
		assert.equal(created.emission?.payload.goal.goalId, "goal-1");
		assert.equal(created.emission?.type, "goal.updated", "never goal.created");

		const completed = reduceGoalOperation(created.state, {
			kind: "goal.complete",
			idempotencyKey: "complete-1",
			commandId: "cmd-complete",
			goalId: "goal-1",
			at: 2,
		});
		assert.equal(completed.emission?.type, "goal.updated", "never goal.completed");
		assert.equal(completed.emission?.payload.goal.status, "complete");
		assert.equal(completed.emission?.payload.goal.terminalCommandId, "cmd-complete");
	});

	it("is idempotent by operation identity and rejects key reuse with changed work", () => {
		const created = create(emptyGoalReducerState());
		const replay = create(created.state);
		assert.equal(replay.duplicate, true);
		assert.equal(replay.emission, undefined);
		assert.throws(
			() =>
				reduceGoalOperation(created.state, {
					kind: "goal.create",
					idempotencyKey: "create-1",
					commandId: "cmd-create",
					goalId: "goal-2",
					objective: "different",
					at: 2,
				}),
			GoalReducerConflict,
		);
	});

	it("uses canonical SHA-256 operation identity rather than caller key order", () => {
		const ordered = {
			kind: "goal.create" as const,
			idempotencyKey: "canonical-create",
			commandId: "cmd-create",
			goalId: "goal-canonical",
			objective: "same semantic object",
			tokenBudget: 10,
			at: 1,
		};
		const reordered = {
			at: 1,
			tokenBudget: 10,
			objective: "same semantic object",
			goalId: "goal-canonical",
			commandId: "cmd-create",
			idempotencyKey: "canonical-create",
			kind: "goal.create" as const,
		};
		const created = reduceGoalOperation(emptyGoalReducerState(), ordered);
		const replay = reduceGoalOperation(created.state, reordered);
		assert.match(created.state.receipts["canonical-create"]!.operationDigest, /^sha256:[a-f0-9]{64}$/);
		assert.equal(replay.duplicate, true);
		assert.equal(replay.emission, undefined);
	});

	it("uses settled host-ledger facts, lets completion beat a coincident budget limit, and never regrows terminal work", () => {
		const created = create(emptyGoalReducerState());
		const limited = reduceGoalOperation(created.state, {
			kind: "goal.usage.settled",
			idempotencyKey: "ledger-1",
			ledgerEntryId: "ble-1",
			goalId: "goal-1",
			tokensDelta: 10,
			timeDeltaSeconds: 4,
			continuationDelta: 1,
			at: 2,
		});
		assert.equal(limited.emission?.payload.goal.status, "budget_limited");
		const completed = reduceGoalOperation(limited.state, {
			kind: "goal.complete",
			idempotencyKey: "complete-1",
			commandId: "cmd-complete",
			goalId: "goal-1",
			at: 3,
		});
		assert.equal(completed.emission?.payload.goal.status, "complete");
		const lateUsage = reduceGoalOperation(completed.state, {
			kind: "goal.usage.settled",
			idempotencyKey: "ledger-late",
			ledgerEntryId: "ble-late",
			goalId: "goal-1",
			tokensDelta: 1,
			timeDeltaSeconds: 1,
			at: 4,
		});
		assert.equal(lateUsage.emission, undefined);
		assert.equal(lateUsage.state.goals["goal-1"]?.status, "complete");
		assert.equal(lateUsage.state.goals["goal-1"]?.tokensUsed, 10);
		assert.throws(
			() =>
				reduceGoalOperation(completed.state, {
					kind: "goal.complete",
					idempotencyKey: "competing-complete",
					commandId: "cmd-competing-complete",
					goalId: "goal-1",
					at: 5,
				}),
			GoalReducerConflict,
		);
	});

	it("keeps the terminal receipt and state needed for composted H2 continuation without reissuing work", () => {
		const completed = reduceGoalOperation(create(emptyGoalReducerState()).state, {
			kind: "goal.complete",
			idempotencyKey: "complete-1",
			commandId: "cmd-complete",
			goalId: "goal-1",
			at: 2,
		});
		const restored = structuredClone(completed.state);
		const replay = reduceGoalOperation(restored, {
			kind: "goal.complete",
			idempotencyKey: "complete-1",
			commandId: "cmd-complete",
			goalId: "goal-1",
			at: 2,
		});
		assert.equal(replay.duplicate, true);
		assert.equal(replay.emission, undefined);
		assert.equal(restored.goals["goal-1"]?.terminalCommandId, "cmd-complete");
	});

	it("rejects invalid or backdated timestamps and unsafe integer arithmetic", () => {
		assert.throws(
			() =>
				reduceGoalOperation(emptyGoalReducerState(), {
					kind: "goal.create",
					idempotencyKey: "bad-create-at",
					commandId: "cmd-bad-create-at",
					goalId: "goal-bad-create-at",
					objective: "invalid timestamp",
					at: -1,
				}),
			GoalReducerConflict,
		);
		assert.throws(
			() =>
				reduceGoalOperation(emptyGoalReducerState(), {
					kind: "goal.create",
					idempotencyKey: "bad-budget",
					commandId: "cmd-bad-budget",
					goalId: "goal-bad-budget",
					objective: "unsafe budget",
					tokenBudget: Number.MAX_SAFE_INTEGER + 1,
					at: 1,
				}),
			GoalReducerConflict,
		);

		const created = create(emptyGoalReducerState());
		assert.throws(
			() =>
				reduceGoalOperation(created.state, {
					kind: "goal.pause",
					idempotencyKey: "backdated",
					commandId: "cmd-backdated",
					goalId: "goal-1",
					at: 0,
				}),
			GoalReducerConflict,
		);
		assert.throws(
			() =>
				reduceGoalOperation(created.state, {
					kind: "goal.usage.settled",
					idempotencyKey: "unsafe-counter",
					ledgerEntryId: "ble-unsafe-counter",
					goalId: "goal-1",
					tokensDelta: Number.MAX_SAFE_INTEGER + 1,
					timeDeltaSeconds: 0,
					at: 2,
				}),
			GoalReducerConflict,
		);
		const atLimit = reduceGoalOperation(created.state, {
			kind: "goal.usage.settled",
			idempotencyKey: "counter-at-limit",
			ledgerEntryId: "ble-counter-at-limit",
			goalId: "goal-1",
			tokensDelta: Number.MAX_SAFE_INTEGER,
			timeDeltaSeconds: 0,
			at: 2,
		});
		assert.throws(
			() =>
				reduceGoalOperation(atLimit.state, {
					kind: "goal.usage.settled",
					idempotencyKey: "counter-overflow",
					ledgerEntryId: "ble-counter-overflow",
					goalId: "goal-1",
					tokensDelta: 1,
					timeDeltaSeconds: 0,
					at: 3,
				}),
			GoalReducerConflict,
		);
		const revisionAtLimit: GoalReducerState = {
			...created.state,
			goals: {
				"goal-1": { ...created.state.goals["goal-1"]!, revision: Number.MAX_SAFE_INTEGER },
			},
		};
		assert.throws(
			() =>
				reduceGoalOperation(revisionAtLimit, {
					kind: "goal.pause",
					idempotencyKey: "revision-overflow",
					commandId: "cmd-revision-overflow",
					goalId: "goal-1",
					at: 2,
				}),
			GoalReducerConflict,
		);
	});
});
