import { canonicalDigest } from "../agent-subject/canonical-json.js";
import type { PrimeGoalHostResponseV1 } from "./host-protocol.js";

/**
 * H1's pure handoff from a durable goal command to the sole host-goal reducer.
 *
 * The `goal.updated` worker frame is a sequencing witness only. It is never
 * mirrored or persisted as a second goal authority: the reducer input is made
 * from the strict, command-correlated `command.result` response instead.
 */
export const PRIME_GOAL_COMMAND_HANDOFF_SCHEMA = "choreograph.prime-goal-command-handoff.v1" as const;

export type PrimeGoalCommandName = "goal.get" | "goal.create" | "goal.complete";

export interface DurablePrimeGoalCommand {
	readonly commandId: string;
	readonly idempotencyKey: string;
	readonly name: PrimeGoalCommandName;
}

export interface PrimeGoalHandoffState {
	readonly schema: typeof PRIME_GOAL_COMMAND_HANDOFF_SCHEMA;
	readonly commands: Readonly<Record<string, RegisteredPrimeGoalCommand>>;
	readonly idempotencyKeys: Readonly<Record<string, string>>;
	readonly workerReceipts: Readonly<Record<string, WorkerReceipt>>;
	readonly pendingGoalUpdate: GoalUpdateWitness | null;
	readonly terminalGoals: Readonly<Record<string, string>>;
}

interface RegisteredPrimeGoalCommand extends DurablePrimeGoalCommand {
	readonly resultDigest?: string;
}

interface WorkerReceipt {
	readonly digest: string;
}

interface GoalUpdateWitness {
	readonly sessionId: string;
	readonly generation: number;
	readonly workerSequence: number;
}

export type PrimeGoalWorkerMessage =
	| {
			readonly type: "goal.updated";
			readonly sessionId: string;
			readonly generation: number;
			readonly workerSequence: number;
	  }
	| {
			readonly type: "command.result";
			readonly sessionId: string;
			readonly generation: number;
			readonly workerSequence: number;
			readonly commandId: string;
			readonly commandName: PrimeGoalCommandName;
			readonly status: "completed" | "failed";
			readonly result?: PrimeGoalHostResponseV1;
			readonly error?: string;
	  };

/** The only goal-state input a durable adapter may pass to the host reducer. */
export interface PrimeGoalReducerInput {
	readonly schema: typeof PRIME_GOAL_COMMAND_HANDOFF_SCHEMA;
	readonly source: "prime-command-result";
	readonly commandId: string;
	readonly idempotencyKey: string;
	readonly commandName: Extract<PrimeGoalCommandName, "goal.create" | "goal.complete">;
	readonly sessionId: string;
	readonly generation: number;
	readonly goalUpdatedWorkerSequence: number;
	readonly commandResultWorkerSequence: number;
	readonly response: PrimeGoalHostResponseV1;
}

export interface PrimeGoalHandoffReduction {
	readonly state: PrimeGoalHandoffState;
	/** Undefined for goal.get, failure, and exact worker replay. */
	readonly reducerInput?: PrimeGoalReducerInput;
	readonly duplicate: boolean;
}

export class PrimeGoalHandoffConflict extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PrimeGoalHandoffConflict";
	}
}

export function emptyPrimeGoalHandoffState(): PrimeGoalHandoffState {
	return {
		schema: PRIME_GOAL_COMMAND_HANDOFF_SCHEMA,
		commands: {},
		idempotencyKeys: {},
		workerReceipts: {},
		pendingGoalUpdate: null,
		terminalGoals: {},
	};
}

/** Register the durable command before it is delivered to the resident worker. */
export function registerPrimeGoalCommand(
	state: PrimeGoalHandoffState,
	command: DurablePrimeGoalCommand,
): PrimeGoalHandoffReduction {
	assertCommand(command);
	const existing = state.commands[command.commandId];
	if (existing) {
		if (sameCommand(existing, command)) return { state, duplicate: true };
		throw new PrimeGoalHandoffConflict(`command '${command.commandId}' names different durable work`);
	}
	const existingCommandId = state.idempotencyKeys[command.idempotencyKey];
	if (existingCommandId) {
		throw new PrimeGoalHandoffConflict(
			`idempotency key '${command.idempotencyKey}' already belongs to command '${existingCommandId}'`,
		);
	}
	return {
		state: {
			...state,
			commands: { ...state.commands, [command.commandId]: command },
			idempotencyKeys: { ...state.idempotencyKeys, [command.idempotencyKey]: command.commandId },
		},
		duplicate: false,
	};
}

/**
 * Consume one worker frame under the materialization's serialized command
 * tail. The caller must atomically persist the returned state and, when
 * present, invoke the sole goal reducer with `reducerInput`.
 */
export function reducePrimeGoalWorkerMessage(
	state: PrimeGoalHandoffState,
	message: PrimeGoalWorkerMessage,
): PrimeGoalHandoffReduction {
	assertWorkerMessage(message);
	const receiptKey = workerReceiptKey(message);
	const digest = `sha256:${canonicalDigest(message)}`;
	const priorReceipt = state.workerReceipts[receiptKey];
	if (priorReceipt) {
		if (priorReceipt.digest !== digest) {
			throw new PrimeGoalHandoffConflict(`worker sequence '${receiptKey}' carries divergent testimony`);
		}
		return { state, duplicate: true };
	}
	const workerReceipts = { ...state.workerReceipts, [receiptKey]: { digest } };
	if (message.type === "goal.updated") {
		if (state.pendingGoalUpdate) {
			throw new PrimeGoalHandoffConflict("unconsumed goal.updated witness blocks another goal update");
		}
		return {
			state: {
				...state,
				workerReceipts,
				pendingGoalUpdate: witnessFor(message),
			},
			duplicate: false,
		};
	}

	const command = state.commands[message.commandId];
	if (!command) throw new PrimeGoalHandoffConflict(`result names unknown durable command '${message.commandId}'`);
	if (command.name !== message.commandName) {
		throw new PrimeGoalHandoffConflict(`result command name does not match durable command '${message.commandId}'`);
	}
	validateResultShape(message);
	const resultDigest = `sha256:${canonicalDigest(commandResultIdentity(message))}`;
	if (command.resultDigest) {
		if (command.resultDigest === resultDigest) {
			return { state: { ...state, workerReceipts }, duplicate: true };
		}
		throw new PrimeGoalHandoffConflict(`command '${message.commandId}' already has first-wins result testimony`);
	}

	if (message.status === "failed" || message.commandName === "goal.get") {
		if (state.pendingGoalUpdate) {
			throw new PrimeGoalHandoffConflict("goal.updated witness cannot be correlated to this command result");
		}
		return settleWithoutReducer(state, command, resultDigest, workerReceipts);
	}

	const witness = state.pendingGoalUpdate;
	if (!witness || !isImmediateWitness(witness, message)) {
		throw new PrimeGoalHandoffConflict(
			"mutating goal command requires the immediately preceding goal.updated witness",
		);
	}
	const terminalGoals = terminalGoalOwnership(state.terminalGoals, message);
	return {
		state: {
			...state,
			commands: { ...state.commands, [command.commandId]: { ...command, resultDigest } },
			workerReceipts,
			pendingGoalUpdate: null,
			terminalGoals,
		},
		reducerInput: {
			schema: PRIME_GOAL_COMMAND_HANDOFF_SCHEMA,
			source: "prime-command-result",
			commandId: command.commandId,
			idempotencyKey: command.idempotencyKey,
			commandName: message.commandName,
			sessionId: message.sessionId,
			generation: message.generation,
			goalUpdatedWorkerSequence: witness.workerSequence,
			commandResultWorkerSequence: message.workerSequence,
			response: message.result!,
		},
		duplicate: false,
	};
}

function settleWithoutReducer(
	state: PrimeGoalHandoffState,
	command: RegisteredPrimeGoalCommand,
	resultDigest: string,
	workerReceipts: Readonly<Record<string, WorkerReceipt>>,
): PrimeGoalHandoffReduction {
	return {
		state: {
			...state,
			commands: { ...state.commands, [command.commandId]: { ...command, resultDigest } },
			workerReceipts,
		},
		duplicate: false,
	};
}

function terminalGoalOwnership(
	terminalGoals: Readonly<Record<string, string>>,
	message: Extract<PrimeGoalWorkerMessage, { type: "command.result" }>,
): Readonly<Record<string, string>> {
	if (message.commandName !== "goal.complete") return terminalGoals;
	const goal = message.result?.goal;
	if (!goal?.goal_id || goal.status !== "complete") return terminalGoals;
	const winner = terminalGoals[goal.goal_id];
	if (winner && winner !== message.commandId) {
		throw new PrimeGoalHandoffConflict(`goal '${goal.goal_id}' already has terminal command '${winner}'`);
	}
	return winner ? terminalGoals : { ...terminalGoals, [goal.goal_id]: message.commandId };
}

function isImmediateWitness(
	witness: GoalUpdateWitness,
	message: Extract<PrimeGoalWorkerMessage, { type: "command.result" }>,
): boolean {
	return (
		witness.sessionId === message.sessionId &&
		witness.generation === message.generation &&
		witness.workerSequence + 1 === message.workerSequence
	);
}

function witnessFor(message: Extract<PrimeGoalWorkerMessage, { type: "goal.updated" }>): GoalUpdateWitness {
	return {
		sessionId: message.sessionId,
		generation: message.generation,
		workerSequence: message.workerSequence,
	};
}

function validateResultShape(message: Extract<PrimeGoalWorkerMessage, { type: "command.result" }>): void {
	if (message.status === "failed") {
		if (message.result !== undefined || !message.error) {
			throw new PrimeGoalHandoffConflict("failed goal command requires an error and cannot carry a result");
		}
		return;
	}
	if (message.error !== undefined) {
		throw new PrimeGoalHandoffConflict("completed goal command cannot carry an error");
	}
	if (!message.result) throw new PrimeGoalHandoffConflict("completed goal command requires a goal response");
}

function commandResultIdentity(message: Extract<PrimeGoalWorkerMessage, { type: "command.result" }>): unknown {
	return {
		commandId: message.commandId,
		commandName: message.commandName,
		status: message.status,
		result: message.result,
		error: message.error,
	};
}

function workerReceiptKey(message: PrimeGoalWorkerMessage): string {
	return [message.sessionId, String(message.generation), String(message.workerSequence)].join(":");
}

function sameCommand(left: DurablePrimeGoalCommand, right: DurablePrimeGoalCommand): boolean {
	return left.idempotencyKey === right.idempotencyKey && left.name === right.name;
}

function assertCommand(command: DurablePrimeGoalCommand): void {
	assertIdentifier(command.commandId, "commandId");
	assertIdentifier(command.idempotencyKey, "idempotencyKey");
	if (!isGoalCommandName(command.name)) throw new PrimeGoalHandoffConflict("durable command name is unsupported");
}

function assertWorkerMessage(message: PrimeGoalWorkerMessage): void {
	assertIdentifier(message.sessionId, "sessionId");
	if (!Number.isSafeInteger(message.generation) || message.generation < 0) {
		throw new PrimeGoalHandoffConflict("generation must be a non-negative safe integer");
	}
	if (!Number.isSafeInteger(message.workerSequence) || message.workerSequence < 0) {
		throw new PrimeGoalHandoffConflict("workerSequence must be a non-negative safe integer");
	}
	if (message.type === "command.result") {
		assertIdentifier(message.commandId, "commandId");
		if (!isGoalCommandName(message.commandName))
			throw new PrimeGoalHandoffConflict("result command name is unsupported");
	}
}

function assertIdentifier(value: string, label: string): void {
	if (!value.trim() || value.includes("\0"))
		throw new PrimeGoalHandoffConflict(`${label} must be nonempty and NUL-free`);
}

function isGoalCommandName(value: string): value is PrimeGoalCommandName {
	return value === "goal.get" || value === "goal.create" || value === "goal.complete";
}
