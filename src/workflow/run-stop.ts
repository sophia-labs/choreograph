/**
 * Stopping a workflow run (2026-10-21: a run whose clerk went silent sat in `running` for an hour, and nothing could
 * end it; `pause` waits for a safe point that a hung sitting never reaches, and leaves the run resumable).
 *
 * A stop, in order:
 * 1. records the request on the run (`requestStop`: `stopping`, when and by whom), which refuses every new sitting at its
 *    safe point (`assertWorkflowCanSchedule`) and every queued one at its pre-spawn gate;
 * 2. writes a `log` event to the run's journal: who stopped it, when, and why if they said;
 * 3. ends every live sitting of the run through the spawner's kill, each recording "Stopped by <owner>." as its
 *    outcome (the node's output, the journal's error, a graph plan's `wf:Unfit`);
 * 4. waits for the run's driver to finish it as `stopped` (the harness catches the refusal), or, for a run no driver
 *    in this host holds (the host restarted, or the run was paused), finishes it itself.
 *
 * A run that already ended is left as it is; asking again is harmless.
 */

import type { JournalStore } from "./journal-store.js";
import { stoppedSittingWords } from "./runtime-control.js";
import { WORKFLOW_ENDED, type WorkflowInstanceRecord, type WorkflowRuntimeStore } from "./runtime-store.js";

export interface WorkflowRunStopDeps {
	readonly runtime: WorkflowRuntimeStore;
	readonly journal: JournalStore;
	readonly spawner: { stopSittings(sessionIds: ReadonlySet<string>, detail: string): Promise<string[]> };
	/** The run's live driver in this host, if any: it records the run's end once its sittings have ended. */
	readonly liveTail?: Promise<void>;
	/** How long to wait for the driver before answering `stopping` (default 15 s). */
	readonly waitMs?: number;
	readonly now?: () => number;
}

export interface WorkflowRunStopResult {
	readonly instance: WorkflowInstanceRecord;
	/** The run had ended before this request (completed, failed, or stopped); nothing was changed. */
	readonly alreadyEnded: boolean;
	/** Sandboxes whose sittings this request ended. */
	readonly stoppedSandboxes: readonly string[];
}

export async function stopWorkflowRun(
	deps: WorkflowRunStopDeps,
	input: { readonly runId: string; readonly by: string; readonly reason?: string },
): Promise<WorkflowRunStopResult> {
	const now = deps.now ?? (() => Date.now());
	const current = await deps.runtime.getWorkflowInstance(input.runId);
	if (!current) throw new Error(`Run not found: ${input.runId}`);
	if (WORKFLOW_ENDED.has(current.status)) return { instance: current, alreadyEnded: true, stoppedSandboxes: [] };

	const at = now();
	const { instance: requested, first } = await deps.runtime.requestStop(input.runId, {
		by: input.by,
		...(input.reason ? { reason: input.reason } : {}),
		now: at,
	});
	if (!requested) throw new Error(`Run not found: ${input.runId}`);
	if (WORKFLOW_ENDED.has(requested.status)) return { instance: requested, alreadyEnded: true, stoppedSandboxes: [] };
	const stop = stopTestimony(requested);
	if (first) {
		await deps.journal
			.appendEvent(input.runId, { type: "log", ts: at, payload: { msg: stopMessage(stop), stop } })
			.catch((error) => console.error(`[workflow] stop event failed for ${input.runId}: ${String(error)}`));
	}

	const words = stoppedSittingWords(stop.by);
	const endLiveSittings = async (): Promise<string[]> => {
		const sessions = await deps.runtime.listAgentSessionsForRun(input.runId);
		const live = new Set(
			sessions.filter((s) => s.status === "running" || s.status === "queued").map((s) => s.session_id),
		);
		return live.size === 0 ? [] : deps.spawner.stopSittings(live, words);
	};
	const stoppedSandboxes = await endLiveSittings();

	if (deps.liveTail) {
		const waitMs = deps.waitMs ?? 15_000;
		if (!(await settlesWithin(deps.liveTail, waitMs))) {
			// A sitting whose body was spawning as the stop landed slipped past both the gate and the first pass.
			stoppedSandboxes.push(...(await endLiveSittings()));
			await settlesWithin(deps.liveTail, waitMs);
		}
	} else {
		await finishStoppedRun(deps, requested, now());
	}
	const after = (await deps.runtime.getWorkflowInstance(input.runId)) ?? requested;
	return { instance: after, alreadyEnded: false, stoppedSandboxes };
}

/** The stop as the run records it: on the `log` event, on `run_done`, and on the run's projection. */
export function stopTestimony(instance: WorkflowInstanceRecord): {
	by: string | null;
	at: number | null;
	reason: string | null;
} {
	return { by: instance.stop_requested_by, at: instance.stop_requested_at, reason: instance.stop_reason };
}

function stopMessage(stop: { by: string | null; reason: string | null }): string {
	const who = stop.by ? `Stopped by ${stop.by}` : "Stopped";
	return stop.reason ? `${who}: ${stop.reason}` : `${who}.`;
}

/** A run no driver holds: record its end here, as the driver would have. */
async function finishStoppedRun(deps: WorkflowRunStopDeps, instance: WorkflowInstanceRecord, endedAt: number) {
	const { header } = await deps.journal.readRun(instance.run_id);
	const sessions = await deps.runtime.listAgentSessionsForRun(instance.run_id);
	if (header && header.status !== "stopped") {
		await deps.journal.appendEvent(instance.run_id, {
			type: "run_done",
			ts: endedAt,
			payload: { status: "stopped", stop: stopTestimony(instance) },
		});
		await deps.journal.finishRun(instance.run_id, {
			status: "stopped",
			ended_at: endedAt,
			duration_ms: Math.max(0, endedAt - header.started_at),
			agent_count: sessions.length,
			total_tokens: header.total_tokens ?? 0,
			synthesis_doc_id: header.synthesis_doc_id,
		});
	}
	await deps.runtime.markWorkflowFinished(instance.run_id, {
		status: "stopped",
		endedAt,
		frontier: { kind: "run-finished", ts: endedAt },
	});
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(
				() => true,
				() => true,
			),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
