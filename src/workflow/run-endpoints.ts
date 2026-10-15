/**
 * Workflow run READ endpoints + per-run SSE fan-out — the choreograph side of
 * the execution vertical's "graph-as-progress-feed" surface.
 *
 * These are thin, journal-backed wrappers (the JournalStore is the SOURCE OF
 * TRUTH — see journal-store.ts) exposed by `orchestrator.ts`:
 *
 *   GET /api/workflows/runs                 — run-list (since/limit/status)
 *   GET /api/workflows/runs/{runId}         — run-detail (header + events)
 *   GET /api/workflows/runs/{runId}/events  — per-run SSE, resumable by ?since=N
 *                                             / Last-Event-ID, multiplexing the
 *                                             K+1 sandbox streams of the run.
 *
 * ── Gateway contract (CRITIC-CORRECTED — read before editing) ────────────────
 * The platform gateway is NOT a verbatim passthrough. Today it special-cases
 * EXACTLY two GET paths (gateway/src/routes.rs, branch feat/gw-choreo-telemetry-
 * route): `/g/{graph}/workflows/runs/{run_id}` and `.../events`, rewriting them
 * to `/api/workflows/runs/{run_id}[/events]` (the graph segment is dropped; runs
 * are keyed by run_id). So run-DETAIL and per-run SSE here line up with the
 * existing gateway entry. The run-LIST path (`/api/workflows/runs`) has NO
 * gateway entry yet — it is reachable directly (canary curl / internal), but a
 * bespoke `proxy_entry_choreograph`-style route must be added gateway-side
 * before the SPA can call it through the gateway. That edit is OUTSIDE this
 * file-set (it lives in the gateway worktree) — see the build report's skipped[].
 *
 * ── Why the journal, not K live bus subscriptions, drives SSE ────────────────
 * A run is K+1 sandboxes; the SandboxEventBus is per-sandbox and its replay
 * buffer is bounded + GC'd ~30s after terminal (event-bus.ts). Late joiners and
 * resume-after-disconnect therefore cannot rely on the bus. The journal's
 * `run_events` table is append-only with a per-run monotonic `seq` — exactly the
 * cursor an SSE client needs for `Last-Event-ID`. We tail it by polling
 * `listEvents` past the cursor. This is resumable, run-scoped, and survives the
 * bus GC. (A future optimization could splice in the live per-sandbox buses for
 * lower latency between polls; the journal poll is the correctness floor.)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { JournalStore, RunEvent, RunHeader, RunStatus } from "./journal-store.js";

// ─── Tunables ────────────────────────────────────────────────────────────────

/** SSE journal-tail poll cadence. Coarse: runs are seconds-to-minutes long. */
const SSE_POLL_INTERVAL_MS = 500;
/** SSE keepalive to defeat ALB/proxy idle timeouts (mirrors sse-transport.ts). */
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
/** Run-list default + cap. */
const RUN_LIST_DEFAULT_LIMIT = 50;
const RUN_LIST_MAX_LIMIT = 200;

// ─── Projections (wire shapes) ───────────────────────────────────────────────

/** The run-list row — a header projection (no events, for a cheap index). */
export interface RunListItem {
	runId: string;
	workflowName: string;
	graphId: string;
	status: RunStatus;
	startedAt: number;
	endedAt: number | null;
	durationMs: number | null;
	agentCount: number | null;
	totalTokens: number | null;
	synthesisDocId: string | null;
}

function projectHeader(h: RunHeader): RunListItem {
	return {
		runId: h.run_id,
		workflowName: h.workflow_name,
		graphId: h.graph_id,
		status: h.status,
		startedAt: h.started_at,
		endedAt: h.ended_at,
		durationMs: h.duration_ms,
		agentCount: h.agent_count,
		totalTokens: h.total_tokens,
		synthesisDocId: h.synthesis_doc_id,
	};
}

/** Project a journal event row to its SSE/JSON wire shape (seq is the cursor). */
function projectEvent(e: RunEvent): {
	seq: number;
	ts: number;
	type: string;
	sandboxId: string | null;
	label: string | null;
	phaseIndex: number | null;
	payload: unknown;
} {
	return {
		seq: e.seq,
		ts: e.ts,
		type: e.type,
		sandboxId: e.sandbox_id,
		label: e.label,
		phaseIndex: e.phase_index,
		payload: e.payload,
	};
}

// ─── Run-list ────────────────────────────────────────────────────────────────

/**
 * Read the run-list. Backed by `JournalStore.listRuns` (added alongside this).
 * Filters: `status` (header status), `since` (started_at >= ms), `limit` (cap).
 * Ownership is enforced by the caller (orchestrator scopes to ownerUserId).
 *
 * SPEC (not built — needs a journal index decision): cursor pagination beyond a
 * single `limit` page. The journal has no compound (owner, started_at) index
 * today; for the canary's run volumes a single capped page suffices.
 */
export async function listRunsProjected(
	journal: JournalStore,
	ownerUserId: string,
	opts: { graphId?: string; since?: number; limit?: number; status?: RunStatus },
): Promise<RunListItem[]> {
	const limit = Math.max(1, Math.min(opts.limit ?? RUN_LIST_DEFAULT_LIMIT, RUN_LIST_MAX_LIMIT));
	const headers = await journal.listRuns({
		ownerUserId,
		graphId: opts.graphId,
		since: opts.since,
		status: opts.status,
		limit,
	});
	return headers.map(projectHeader);
}

// ─── Run-detail ──────────────────────────────────────────────────────────────

/**
 * Read one run (header + events). Returns `null` when the run does not exist OR
 * is not owned by `ownerUserId` (the orchestrator collapses both to a 404 so we
 * never leak run existence across owners).
 */
export async function readRunProjected(
	journal: JournalStore,
	runId: string,
	ownerUserId: string,
): Promise<{
	run: RunListItem;
	events: ReturnType<typeof projectEvent>[];
} | null> {
	const { header, events } = await journal.readRun(runId);
	if (!header || header.owner_user_id !== ownerUserId) {
		return null;
	}
	return { run: projectHeader(header), events: events.map(projectEvent) };
}

// ─── Per-run SSE fan-out ─────────────────────────────────────────────────────

/**
 * Parse the resume cursor: `?since=N` wins, else `Last-Event-ID` (which we set
 * to the last delivered seq). A run's first seq is 0, so the cursor is the seq
 * of the LAST event already seen; we emit everything with `seq > cursor`. An
 * absent/garbage cursor means "from the beginning" (-1).
 */
export function resolveSinceCursor(sinceParam: string | null, lastEventId: string | undefined): number {
	const fromQuery = sinceParam != null ? Number.parseInt(sinceParam, 10) : Number.NaN;
	if (Number.isFinite(fromQuery)) {
		return fromQuery;
	}
	const fromHeader = lastEventId != null ? Number.parseInt(lastEventId, 10) : Number.NaN;
	if (Number.isFinite(fromHeader)) {
		return fromHeader;
	}
	return -1;
}

/** True once the header reaches a terminal (non-`running`) status. */
function isTerminalStatus(status: RunStatus | undefined): boolean {
	return status === "completed" || status === "failed" || status === "stopped" || status === "paused";
}

/**
 * Start a per-run SSE stream. Tails the journal from `since` (exclusive),
 * emitting each `run_events` row as an SSE message whose `id:` is the row's seq
 * (so a reconnecting client's `Last-Event-ID` resumes exactly where it left
 * off). Closes once the run header is terminal AND all journaled events up to
 * that point have been flushed.
 *
 * Multiplexing: the journal already interleaves the K+1 sandbox streams into one
 * seq-ordered log (withJournal's single serial writer), so tailing it IS the
 * fan-out — no per-sandbox bus juggling here. Resumable by construction.
 *
 * The poll loop is `setTimeout`-chained (not `setInterval`) so a slow journal
 * read can never overlap itself. Backpressure: if the socket buffer is full we
 * skip a tick rather than unbounded-buffer (the next tick re-reads from the same
 * cursor — nothing is lost).
 */
export function startRunSseStream(
	request: IncomingMessage,
	response: ServerResponse,
	journal: JournalStore,
	runId: string,
	since: number,
): void {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	// Preamble — flush headers through proxies (mirrors sse-transport.ts).
	response.write(":ok\n\n");

	let closed = false;
	let cursor = since;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let draining = false; // a poll is in flight

	const heartbeat = setInterval(() => {
		if (!closed) {
			response.write(":keepalive\n\n");
		}
	}, SSE_HEARTBEAT_INTERVAL_MS);

	function cleanup(): void {
		if (closed) return;
		closed = true;
		clearInterval(heartbeat);
		if (pollTimer) clearTimeout(pollTimer);
	}

	function scheduleNext(): void {
		if (closed) return;
		pollTimer = setTimeout(() => {
			void tick();
		}, SSE_POLL_INTERVAL_MS);
	}

	async function tick(): Promise<void> {
		if (closed || draining) return;
		draining = true;
		try {
			// Backpressure: if the client can't keep up, skip this tick. The cursor
			// is unchanged, so the next tick re-reads the same rows — no loss.
			if (response.writableNeedDrain) {
				return;
			}

			const events = await journal.listEventsAfter(runId, cursor);
			for (const e of events) {
				if (closed) return;
				writeRunSseEvent(response, e);
				cursor = e.seq;
			}

			// Terminal close: only after we've flushed every event up to the
			// terminal header. We read the header AFTER draining events so a
			// just-appended run_done is not missed (its row may outrace the header
			// flip, or vice-versa — either order is covered by re-checking next tick).
			const header = await journal.readHeader(runId);
			if (isTerminalStatus(header?.status)) {
				// One more drain to catch any rows appended between the listEvents
				// above and the header read.
				const tail = await journal.listEventsAfter(runId, cursor);
				for (const e of tail) {
					if (closed) return;
					writeRunSseEvent(response, e);
					cursor = e.seq;
				}
				response.write(`event: run:closed\ndata: ${JSON.stringify({ runId, status: header?.status })}\n\n`);
				response.end();
				cleanup();
				return;
			}
		} catch (err) {
			// A transient journal read error must not kill the stream — log via an
			// SSE comment and keep polling (the cursor is unchanged).
			if (!closed) {
				response.write(`:error ${escapeSseComment(err instanceof Error ? err.message : String(err))}\n\n`);
			}
		} finally {
			draining = false;
			scheduleNext();
		}
	}

	request.on("close", cleanup);

	// Kick off immediately so a finished run delivers its full log without waiting
	// a poll interval.
	void tick();
}

/**
 * Write one journal event as an SSE message. `event:` is `wf:{type}` (the
 * Contract-A taxonomy lifts directly from the frozen run-event enum), `id:` is
 * the seq (the resume cursor), `data:` is the projected event JSON.
 */
function writeRunSseEvent(response: ServerResponse, e: RunEvent): void {
	const data = JSON.stringify(projectEvent(e));
	response.write(`event: wf:${e.type}\nid: ${e.seq}\ndata: ${data}\n\n`);
}

/** SSE comments cannot contain CR/LF; collapse them. */
function escapeSseComment(text: string): string {
	return text.replace(/[\r\n]+/g, " ");
}
