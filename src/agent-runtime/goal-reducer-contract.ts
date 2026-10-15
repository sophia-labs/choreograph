import { canonicalDigest } from "../agent-subject/canonical-json.js";

/**
 * Arc H1's pure host-goal contract.  This deliberately owns neither storage
 * nor bridge routing: its caller must atomically persist `state` and append
 * the returned `goal.updated` emission in the Agent Session transaction.
 */
export const AGENT_SESSION_GOAL_SCHEMA = "choreograph.agent-session-goal.v1" as const;

export type HostGoalStatus = "active" | "paused" | "budget_limited" | "complete" | "error";

export interface HostGoalRecord {
	readonly goalId: string;
	readonly objective: string;
	readonly tokenBudget: number | null;
	readonly tokensUsed: number;
	readonly timeUsedSeconds: number;
	readonly continuationsUsed: number;
	readonly status: HostGoalStatus;
	readonly revision: number;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly terminalCommandId?: string;
	readonly lastReason?: string;
}

export interface GoalReducerReceipt {
	readonly idempotencyKey: string;
	readonly operationDigest: string;
	readonly goalId: string;
	readonly revision: number;
	readonly eventSequence: number | null;
}

/** State that H1 must persist with its command receipts; this is not a second store. */
export interface GoalReducerState {
	readonly schema: typeof AGENT_SESSION_GOAL_SCHEMA;
	readonly goals: Readonly<Record<string, HostGoalRecord>>;
	readonly currentGoalId: string | null;
	readonly receipts: Readonly<Record<string, GoalReducerReceipt>>;
	readonly hostBudgetExhausted: boolean;
}

export type GoalReducerOperation =
	| {
			readonly kind: "goal.create";
			readonly idempotencyKey: string;
			readonly commandId: string;
			readonly goalId: string;
			readonly objective: string;
			readonly tokenBudget?: number;
			readonly at: number;
	  }
	| {
			readonly kind: "goal.complete" | "goal.pause" | "goal.resume" | "goal.fail";
			readonly idempotencyKey: string;
			readonly commandId: string;
			readonly goalId: string;
			readonly reason?: string;
			readonly at: number;
	  }
	| {
			/** One settled host-ledger fact, never a worker-reported token total. */
			readonly kind: "goal.usage.settled";
			readonly idempotencyKey: string;
			readonly ledgerEntryId: string;
			readonly goalId: string;
			readonly tokensDelta: number;
			readonly timeDeltaSeconds: number;
			readonly continuationDelta?: number;
			readonly at: number;
	  }
	| {
			/** The session account is exhausted; H1 emits no budget.ledger_updated fact. */
			readonly kind: "goal.host_budget_exhausted";
			readonly idempotencyKey: string;
			readonly ledgerEntryId: string;
			readonly goalId: string;
			readonly at: number;
	  };

export interface GoalUpdatedEmission {
	readonly type: "goal.updated";
	readonly commandId?: string;
	readonly causationId: string;
	readonly payload: {
		readonly schema: typeof AGENT_SESSION_GOAL_SCHEMA;
		readonly source: "host-reducer";
		readonly goal: HostGoalRecord;
	};
}

export interface GoalReduction {
	readonly state: GoalReducerState;
	/** Undefined for exact replay: the durable event was already appended. */
	readonly emission?: GoalUpdatedEmission;
	readonly duplicate: boolean;
}

export class GoalReducerConflict extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GoalReducerConflict";
	}
}

export function emptyGoalReducerState(): GoalReducerState {
	return {
		schema: AGENT_SESSION_GOAL_SCHEMA,
		goals: {},
		currentGoalId: null,
		receipts: {},
		hostBudgetExhausted: false,
	};
}

/**
 * Applies one authoritative host operation.  An adapter must use the same
 * transaction for this result, its receipt, and its returned emission.
 */
export function reduceGoalOperation(state: GoalReducerState, operation: GoalReducerOperation): GoalReduction {
	assertTimestamp(operation.at, "operation.at");
	const digest = operationDigest(operation);
	const existing = state.receipts[operation.idempotencyKey];
	if (existing) {
		if (existing.operationDigest !== digest) {
			throw new GoalReducerConflict(`goal idempotency key '${operation.idempotencyKey}' names different work`);
		}
		return { state, duplicate: true };
	}

	const goal = state.goals[operation.goalId];
	if (operation.kind !== "goal.create") {
		requireGoal(goal, operation.goalId);
		if (operation.at < goal.updatedAt) {
			throw new GoalReducerConflict("operation timestamp predates the current goal state");
		}
	}
	let nextGoal: HostGoalRecord;
	let currentGoalId = state.currentGoalId;
	let hostBudgetExhausted = state.hostBudgetExhausted;

	switch (operation.kind) {
		case "goal.create": {
			if (goal) throw new GoalReducerConflict(`goal '${operation.goalId}' already exists`);
			const currentGoal = state.currentGoalId ? state.goals[state.currentGoalId] : undefined;
			if (currentGoal) assertGoalRecord(currentGoal);
			if (currentGoal && !isTerminal(currentGoal.status)) {
				throw new GoalReducerConflict("an active, paused, or budget-limited goal already exists");
			}
			if (state.hostBudgetExhausted) throw new GoalReducerConflict("host budget is exhausted");
			if (!operation.objective.trim()) throw new GoalReducerConflict("goal objective is required");
			if (
				operation.tokenBudget !== undefined &&
				(!Number.isSafeInteger(operation.tokenBudget) || operation.tokenBudget <= 0)
			) {
				throw new GoalReducerConflict("goal token budget must be a positive integer");
			}
			nextGoal = {
				goalId: operation.goalId,
				objective: operation.objective.trim(),
				tokenBudget: operation.tokenBudget ?? null,
				tokensUsed: 0,
				timeUsedSeconds: 0,
				continuationsUsed: 0,
				status: "active",
				revision: 1,
				createdAt: operation.at,
				updatedAt: operation.at,
			};
			currentGoalId = operation.goalId;
			break;
		}
		case "goal.usage.settled": {
			requireGoal(goal, operation.goalId);
			assertNonNegativeSafeInteger(operation.tokensDelta, "tokensDelta");
			assertNonNegativeSafeInteger(operation.timeDeltaSeconds, "timeDeltaSeconds");
			assertNonNegativeSafeInteger(operation.continuationDelta ?? 0, "continuationDelta");
			// Terminal work is immutable: late/replayed accounting cannot regrow it.
			if (isTerminal(goal.status)) return recordNoop(state, operation, digest, goal);
			const tokensUsed = checkedAdd(goal.tokensUsed, operation.tokensDelta, "tokensUsed");
			const budgetLimited = goal.tokenBudget !== null && tokensUsed >= goal.tokenBudget;
			nextGoal = {
				...goal,
				tokensUsed,
				timeUsedSeconds: checkedAdd(goal.timeUsedSeconds, operation.timeDeltaSeconds, "timeUsedSeconds"),
				continuationsUsed: checkedAdd(
					goal.continuationsUsed,
					operation.continuationDelta ?? 0,
					"continuationsUsed",
				),
				status: budgetLimited ? "budget_limited" : goal.status,
				lastReason: budgetLimited ? `Reached ${goal.tokenBudget} token goal budget` : goal.lastReason,
				revision: nextRevision(goal),
				updatedAt: operation.at,
			};
			break;
		}
		case "goal.host_budget_exhausted": {
			requireGoal(goal, operation.goalId);
			hostBudgetExhausted = true;
			if (isTerminal(goal.status)) return recordNoop(state, operation, digest, goal, true);
			nextGoal = {
				...goal,
				status: "budget_limited",
				lastReason: "Host session budget exhausted",
				revision: nextRevision(goal),
				updatedAt: operation.at,
			};
			break;
		}
		default: {
			requireGoal(goal, operation.goalId);
			if (isTerminal(goal.status)) {
				if (
					((operation.kind === "goal.complete" && goal.status === "complete") ||
						(operation.kind === "goal.fail" && goal.status === "error")) &&
					goal.terminalCommandId === operation.commandId
				) {
					return recordNoop(state, operation, digest, goal);
				}
				throw new GoalReducerConflict(`goal terminal testimony already won as ${goal.status}`);
			}
			if (operation.kind === "goal.resume" && state.hostBudgetExhausted) {
				throw new GoalReducerConflict("host budget is exhausted");
			}
			nextGoal = reduceCommand(goal, operation);
			break;
		}
	}

	const receipt: GoalReducerReceipt = {
		idempotencyKey: operation.idempotencyKey,
		operationDigest: digest,
		goalId: nextGoal.goalId,
		revision: nextGoal.revision,
		eventSequence: null,
	};
	return {
		state: {
			...state,
			goals: { ...state.goals, [nextGoal.goalId]: nextGoal },
			currentGoalId,
			receipts: { ...state.receipts, [operation.idempotencyKey]: receipt },
			hostBudgetExhausted,
		},
		emission: emissionFor(nextGoal, operation),
		duplicate: false,
	};
}

function reduceCommand(
	goal: HostGoalRecord,
	operation: Exclude<
		GoalReducerOperation,
		{ kind: "goal.create" | "goal.usage.settled" | "goal.host_budget_exhausted" }
	>,
): HostGoalRecord {
	if (operation.kind === "goal.complete") {
		// Completion wins an earlier coincident budget limit, as in Prime today.
		return terminalGoal(goal, "complete", operation);
	}
	if (operation.kind === "goal.pause") return updateGoal(goal, "paused", operation);
	if (operation.kind === "goal.resume") {
		if (goal.status !== "paused" && goal.status !== "budget_limited") {
			throw new GoalReducerConflict("only a paused or budget-limited goal can resume");
		}
		const status = goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget ? "budget_limited" : "active";
		return updateGoal(
			goal,
			status,
			operation,
			status === "budget_limited" ? "Goal token budget already reached" : undefined,
		);
	}
	return terminalGoal(goal, "error", operation);
}

function updateGoal(
	goal: HostGoalRecord,
	status: HostGoalStatus,
	operation: { readonly at: number; readonly reason?: string },
	reason = operation.reason,
): HostGoalRecord {
	return { ...goal, status, lastReason: reason, revision: nextRevision(goal), updatedAt: operation.at };
}

function terminalGoal(
	goal: HostGoalRecord,
	status: Extract<HostGoalStatus, "complete" | "error">,
	operation: { readonly commandId: string; readonly at: number; readonly reason?: string },
): HostGoalRecord {
	return {
		...goal,
		status,
		terminalCommandId: operation.commandId,
		lastReason: operation.reason ?? (status === "complete" ? "Goal achieved" : "Goal failed"),
		revision: nextRevision(goal),
		updatedAt: operation.at,
	};
}

function recordNoop(
	state: GoalReducerState,
	operation: GoalReducerOperation,
	digest: string,
	goal: HostGoalRecord,
	hostBudgetExhausted = state.hostBudgetExhausted,
): GoalReduction {
	return {
		state: {
			...state,
			receipts: {
				...state.receipts,
				[operation.idempotencyKey]: {
					idempotencyKey: operation.idempotencyKey,
					operationDigest: digest,
					goalId: goal.goalId,
					revision: goal.revision,
					eventSequence: null,
				},
			},
			hostBudgetExhausted,
		},
		duplicate: false,
	};
}

function emissionFor(goal: HostGoalRecord, operation: GoalReducerOperation): GoalUpdatedEmission {
	return {
		type: "goal.updated",
		...("commandId" in operation ? { commandId: operation.commandId } : {}),
		causationId: "ledgerEntryId" in operation ? operation.ledgerEntryId : operation.commandId,
		payload: { schema: AGENT_SESSION_GOAL_SCHEMA, source: "host-reducer", goal },
	};
}

function requireGoal(goal: HostGoalRecord | undefined, goalId: string): asserts goal is HostGoalRecord {
	if (!goal) throw new GoalReducerConflict(`unknown goal '${goalId}'`);
	assertGoalRecord(goal);
}

function isTerminal(status: HostGoalStatus): boolean {
	return status === "complete" || status === "error";
}

function assertGoalRecord(goal: HostGoalRecord): void {
	assertTimestamp(goal.createdAt, "goal.createdAt");
	assertTimestamp(goal.updatedAt, "goal.updatedAt");
	if (goal.updatedAt < goal.createdAt) throw new GoalReducerConflict("goal updatedAt predates createdAt");
	assertNonNegativeSafeInteger(goal.tokensUsed, "goal.tokensUsed");
	assertNonNegativeSafeInteger(goal.timeUsedSeconds, "goal.timeUsedSeconds");
	assertNonNegativeSafeInteger(goal.continuationsUsed, "goal.continuationsUsed");
	if (!Number.isSafeInteger(goal.revision) || goal.revision < 1) {
		throw new GoalReducerConflict("goal.revision must be a positive safe integer");
	}
	if (goal.tokenBudget !== null && (!Number.isSafeInteger(goal.tokenBudget) || goal.tokenBudget <= 0)) {
		throw new GoalReducerConflict("goal.tokenBudget must be a positive safe integer or null");
	}
}

function assertTimestamp(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new GoalReducerConflict(`${label} must be a non-negative safe integer timestamp`);
	}
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new GoalReducerConflict(`${label} must be a non-negative safe integer`);
	}
}

function checkedAdd(left: number, right: number, label: string): number {
	assertNonNegativeSafeInteger(left, label);
	assertNonNegativeSafeInteger(right, `${label} delta`);
	if (left > Number.MAX_SAFE_INTEGER - right) {
		throw new GoalReducerConflict(`${label} exceeds the safe integer range`);
	}
	return left + right;
}

function nextRevision(goal: HostGoalRecord): number {
	return checkedAdd(goal.revision, 1, "goal.revision");
}

function operationDigest(operation: GoalReducerOperation): string {
	return `sha256:${canonicalDigest(operation)}`;
}
