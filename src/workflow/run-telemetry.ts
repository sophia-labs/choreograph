/**
 * Contract A — Run Telemetry (PRODUCER SIDE)
 *
 * Defines the canonical telemetry event taxonomy and the per-process
 * `RunTelemetryEmitter` that is the single live-tail fan-out point.
 *
 * ── ONE stream, three projections ────────────────────────────────────────────
 * The journal's `appendEvent` is the write-path; after each atomic INSERT the
 * store calls `RunTelemetryEmitter.notify`. SSE consumers subscribe here and
 * replay from the journal for catch-up. The wf: RDF fold is unchanged (reads
 * the same journal rows). There is NO second code path.
 *
 * ── Event taxonomy (Contract A, v1.1) ────────────────────────────────────────
 * run.started / run.finished{status}
 * phase.entered / phase.exited
 * node.queued / node.started / node.output(deferred) / node.finished{status} / node.failed
 * log
 *
 * The journal `RunEventType` enum maps 1:1 onto these (see `toTelemetryEventType`).
 * `phase.entered`, `phase.exited`, and `log` require the v1.1 journal extensions
 * (`phase_entered`, `phase_exited`, `log`).
 *
 * ── Identity fields on every event ───────────────────────────────────────────
 * runId (raw operational run id — matches journal/URL/FE; NOT the provenance
 * URN), workflowName, phaseIndex, phaseTitle, nodeId.
 *
 * ── Transport ─────────────────────────────────────────────────────────────────
 * SSE primary (GET /api/workflows/runs/:runId/events?since=N) +
 * poll-since-seq JSON fallback. NOT WebSockets. Consumers dedupe on (runId, seq),
 * join late via ?since=N. At-least-once delivery.
 */

import { EventEmitter } from "node:events";
import type { RunEvent, RunEventType } from "./journal-store.js";

// ─── Contract A taxonomy ─────────────────────────────────────────────────────

/**
 * The Contract A telemetry event type surface (SSE `event:` field).
 * These are the PROJECTED names — the journal uses snake_case internally;
 * the wire protocol uses dot-notation for readability.
 */
export type TelemetryEventType =
	| "run.started"
	| "run.finished"
	| "phase.entered"
	| "phase.exited"
	| "node.queued"
	| "node.started"
	| "node.finished"
	| "node.failed"
	| "log";

/**
 * Project a journal `RunEventType` onto the Contract A `TelemetryEventType`.
 * `token_usage` and `tool_call` are execution-level facts folded INTO the
 * `node.finished` payload — they don't surface as separate telemetry events on
 * the wire (defer `node.output` per spec).
 */
export function toTelemetryEventType(type: RunEventType): TelemetryEventType | null {
	switch (type) {
		case "run_started":
			return "run.started";
		case "run_done":
			return "run.finished";
		case "phase_entered":
			return "phase.entered";
		case "phase_exited":
			return "phase.exited";
		case "node_queued":
			return "node.queued";
		case "node_started":
			return "node.started";
		case "node_done":
			return "node.finished";
		case "error":
			return "node.failed";
		case "log":
			return "log";
		// Fold into node.finished payload — not a top-level telemetry event.
		case "tool_call":
		case "tool_result":
		case "token_usage":
			return null;
	}
}

// ─── Wire shape ───────────────────────────────────────────────────────────────

/**
 * A Contract A telemetry event as it appears on the SSE wire and in poll
 * responses.
 *
 * ALL fields except `status` and `resultRef` are REQUIRED on every event — the
 * FE consumer (`RunTelemetryClient`) reads them unconditionally.  Fields that
 * have no natural value for a given event type use sentinels: phaseIndex=0,
 * phaseTitle="", nodeId="".
 *
 * Run completion preserves the journal's exact terminal state
 * (`completed|failed|stopped|paused`); node completion uses
 * `finished|failed`. Legacy producers may still emit `finished` for a run.
 *
 * Poll transport: the endpoint returns a BARE JSON ARRAY of `TelemetryEvent`
 * objects.  The pagination cursor (`nextSince`) travels in the response header
 * `X-Next-Since` — NOT in the body.
 *
 * SSE transport: named events (`event: <type>\nid: <seq>\ndata: <json>\n\n`)
 * where the `data` JSON is a single `TelemetryEvent`.
 */
export interface TelemetryEvent {
	/** Contract A type (dot-notation). */
	type: TelemetryEventType;
	/**
	 * Raw operational run id (e.g. `wfr-…`). Matches the journal run_id, the
	 * `GET /…/runs/:runId` URL param, and the FE's run identity. The
	 * `urn:sophia:wf-run:{id}` URN is the provenance subject (wf: fold), NOT this.
	 */
	runId: string;
	/** Human-readable workflow name. */
	workflowName: string;
	/** Per-run monotonic sequence number (from the journal). */
	seq: number;
	/** Epoch ms at emission. */
	ts: number;
	/**
	 * Phase index (1-based).  Always present; use 0 for run-level events
	 * (run.started, run.finished) that precede the first declared phase.
	 */
	phaseIndex: number;
	/**
	 * Phase title.  Always present; empty string for run-level events or when
	 * no phase has been declared yet.
	 */
	phaseTitle: string;
	/**
	 * Node label (= wf:label).  Always present; empty string for run-level and
	 * phase-level events that are not associated with a specific node.
	 */
	nodeId: string;
	/**
	 * Terminal status. Present ONLY on run.finished, node.finished, and
	 * node.failed. Run events preserve their exact terminal state.
	 */
	status?: "completed" | "finished" | "failed" | "stopped" | "paused";
	/** Thin ref: the raw run_id for journal re-join (not the full URN). */
	resultRef?: string;
	/** Event-specific payload (thin — no bulk inline). */
	payload?: unknown;
}

// ─── Run metadata cache ───────────────────────────────────────────────────────

/** Minimal per-run metadata needed to decorate every emitted event. */
export interface RunMeta {
	runId: string;
	workflowName: string;
}

// ─── Emitter ─────────────────────────────────────────────────────────────────

const EVENT_NAME = "telemetry" as const;

/**
 * Per-process telemetry fan-out point. `JournalStore.appendEvent` calls
 * `notify()` synchronously after each atomic INSERT. SSE handlers subscribe
 * here for live events and replay-from-journal for catch-up.
 *
 * This is NOT per-run — one emitter serves all runs on the process. Consumers
 * filter by `runId` inside their handler.
 */
export class RunTelemetryEmitter {
	private readonly ee = new EventEmitter();

	constructor() {
		// Unbounded listeners: one per SSE connection is fine since connections
		// are bounded by MAX_CONNECTIONS (256). Raise to suppress the Node warning.
		this.ee.setMaxListeners(512);
	}

	/**
	 * Called by `JournalStore.appendEvent` after the atomic INSERT. Converts the
	 * journal row + run metadata into a Contract A `TelemetryEvent` and fans out
	 * to all SSE subscribers. Synchronous.
	 */
	notify(meta: RunMeta, event: RunEvent): void {
		const type = toTelemetryEventType(event.type);
		if (type === null) {
			// tool_call / token_usage: not a top-level telemetry event.
			return;
		}
		this.ee.emit(EVENT_NAME, buildTelemetryEvent(type, meta, event));
	}

	/**
	 * Subscribe to live telemetry events. Returns an unsubscribe function.
	 * The handler is called synchronously on the emit path — keep it non-blocking.
	 */
	subscribe(handler: (event: TelemetryEvent) => void): () => void {
		this.ee.on(EVENT_NAME, handler);
		return () => {
			this.ee.off(EVENT_NAME, handler);
		};
	}
}

// ─── Shared projection helper ────────────────────────────────────────────────

/**
 * Build a Contract A `TelemetryEvent` from a journal row + run metadata.
 * All required fields (phaseIndex, phaseTitle, nodeId) are always present;
 * absent values default to sentinels (0 / "").
 * `status` is promoted to a top-level field for run.finished, node.finished,
 * and node.failed — extracted from the event payload where the journal stores it.
 */
function buildTelemetryEvent(type: TelemetryEventType, meta: RunMeta, event: RunEvent): TelemetryEvent {
	const p = event.payload as Record<string, unknown> | null | undefined;

	// Phase title: phase_entered/phase_exited store it in payload.phaseTitle;
	// other events don't carry a title (default to empty string).
	const phaseTitle = typeof p?.phaseTitle === "string" ? p.phaseTitle : "";

	const te: TelemetryEvent = {
		type,
		// Wire runId = the RAW operational run id — it MUST match the journal
		// run_id, the GET /…/runs/:runId URL param, and the FE's run identity
		// (RunTelemetryClient filters `ev.runId !== this._runId`). The
		// urn:sophia:wf-run URN is the *provenance* subject, minted in the wf:
		// fold — it is NOT the live-wire id. (resultRef carries the same raw id.)
		runId: meta.runId,
		workflowName: meta.workflowName,
		seq: event.seq,
		ts: event.ts,
		// Required on every event — sentinel 0 for run/phase-level events.
		phaseIndex: event.phase_index ?? 0,
		phaseTitle,
		// Required on every event — empty string for non-node events.
		nodeId: event.label ?? "",
		resultRef: meta.runId,
	};

	// status: top-level field ONLY on terminal events, extracted from payload.
	// Preserve the run journal's exact terminal state. Collapsing stopped/paused
	// into "finished" made a cancelled run indistinguishable from a success.
	if (type === "run.finished") {
		const rawStatus = p?.status;
		te.status =
			rawStatus === "completed" ||
			rawStatus === "failed" ||
			rawStatus === "stopped" ||
			rawStatus === "paused" ||
			rawStatus === "finished"
				? rawStatus
				: rawStatus === "error"
					? "failed"
					: "finished";
	} else if (type === "node.finished" || type === "node.failed") {
		const rawStatus = p?.status;
		te.status = rawStatus === "failed" || rawStatus === "error" || type === "node.failed" ? "failed" : "finished";
	}

	// Carry through event payload (thin — callers keep it small).
	if (event.payload !== undefined && event.payload !== null) {
		te.payload = event.payload;
	}

	return te;
}

// ─── Journal-row → TelemetryEvent projection (for replay) ───────────────────

/**
 * Project a journal `RunEvent` + run metadata into a Contract A
 * `TelemetryEvent`. Used for replay-from-journal (catch-up path). Returns
 * `null` for event types that don't surface on the telemetry wire.
 */
export function projectJournalEvent(meta: RunMeta, event: RunEvent): TelemetryEvent | null {
	const type = toTelemetryEventType(event.type);
	if (type === null) return null;
	return buildTelemetryEvent(type, meta, event);
}
