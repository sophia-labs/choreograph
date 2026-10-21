/**
 * What ends a headless sitting that will not end itself (2026-10-21, "Sleepers, as Dream reports"): a clerk called
 * `read_blocks` with the same arguments two dozen times, reached its turn cap and went silent, and its run sat in
 * `running` with the Censor never started.
 *
 * The host watches every headless sitting (a workflow step, never a person's chat) as its tool calls and turns go by,
 * and ends it, in plain words, when it:
 * - calls the same tool with the same arguments more than `SITTING_MAX_IDENTICAL_CALLS` times in a row (arguments
 *   compared as canonical JSON, so a new key order is the same call);
 * - finishes a turn past the turn cap its runtime binding pins (the body should stop itself first; this is the
 *   host's backstop for a body that does not);
 * - runs past its wall clock (`maxWallTimeMs`, enforced by the spawner's timer; this module only words it).
 *
 * The words are what the run records: the node's output, the journal's error, and a graph plan's `wf:Unfit`.
 */

import { canonicalJson } from "@sophia-labs/canonical-json";

/** A sitting that calls the same tool with the same arguments more often than this in a row is stopped. */
export const SITTING_MAX_IDENTICAL_CALLS = 3;

export class SittingWatch {
	private lastCall: string | undefined;
	private repeats = 0;

	constructor(
		private readonly maxTurns: number,
		private readonly maxIdenticalCalls: number = SITTING_MAX_IDENTICAL_CALLS,
	) {}

	/** A tool call began. Returns why the sitting must stop, or undefined. */
	toolCall(tool: string, args: unknown): string | undefined {
		const call = `${tool}\u0000${canonicalArgs(args)}`;
		this.repeats = call === this.lastCall ? this.repeats + 1 : 1;
		this.lastCall = call;
		if (this.repeats <= this.maxIdenticalCalls) return undefined;
		return `Stopped after calling ${tool} ${String(this.repeats)} times in a row with the same arguments.`;
	}

	/** A turn ended (1-based). Returns why the sitting must stop, or undefined. */
	turnEnded(turn: number): string | undefined {
		if (!Number.isSafeInteger(turn) || turn <= this.maxTurns) return undefined;
		return sittingTurnCapWords(this.maxTurns);
	}
}

export function sittingTurnCapWords(turns: number): string {
	return `Stopped after ${String(turns)} turn${turns === 1 ? "" : "s"} without an answer.`;
}

export function sittingWallClockWords(ms: number): string {
	return `Stopped after ${describeDuration(ms)} without an answer.`;
}

/** "5 minutes", "90 seconds", "1 minute": whole minutes when the limit is whole minutes, else seconds. */
export function describeDuration(ms: number): string {
	const seconds = Math.max(1, Math.round(ms / 1_000));
	if (seconds % 60 === 0) {
		const minutes = seconds / 60;
		return `${String(minutes)} minute${minutes === 1 ? "" : "s"}`;
	}
	return `${String(seconds)} second${seconds === 1 ? "" : "s"}`;
}

function canonicalArgs(args: unknown): string {
	try {
		return canonicalJson(args ?? {});
	} catch {
		return String(args);
	}
}
