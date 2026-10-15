/**
 * ACP Agent surface — the bidirectional translator between choreograph's
 * internal `SandboxEvent` vocabulary (S0) and the ACP `session/update`
 * notification stream choreograph emits as an ACP **Agent**.
 *
 * CA-1 / S2 — the ACP translation layer (the Agent role we own).
 *
 * This is a PURE value translator. It contains:
 *
 *   - {@link sandboxEventToSessionUpdate}: forward map, one internal
 *     `SandboxEvent` → at most one ACP `session/update` payload, carrying the
 *     Pi richness (turn counter, token usage) in the `_ext` namespace
 *     (`choreograph.pi/*`) that plain `SandboxEvent` lacks.
 *   - {@link sessionUpdateToSandboxEvent}: the INVERSE map, recovering the
 *     agent-agnostic *core* of each `SandboxEvent` from the ACP update.
 *   - {@link translateStream} / {@link projectStreamBack}: the ordered-stream
 *     forms that thread turn/usage context across a run.
 *   - {@link terminalToStopReason} / {@link stopReasonToTerminalKind}: the terminal
 *     `done`/`truncated`/`error` ⟷ ACP `stopReason` map.
 *   - {@link createAcpAgent}: the factory that assembles these into the ACP
 *     Agent role's translation half (no live worker/bus/SSE — that is S7).
 *
 * The load-bearing property (the S2 oracle): the forward map then the inverse
 * map round-trips back to the EXACT S0 `SandboxEvent` list on the
 * agent-agnostic core (text, tool name/args/result/is_error, turn numbers,
 * terminal stop), AND the ACP stream ADDITIONALLY carries `_ext` frames the
 * plain stream cannot — equivalence + domination.
 *
 * NO Pi import. NO CRDT handle. Reads only plain `SandboxEvent` values and
 * frozen rows. Runnable in isolation on macOS — it touches no orchestrator,
 * no gateway, no bwrap. (The live `SandboxSpawner → bus → SSE` pipeline that
 * would FEED real `SandboxEvent`s through this translator is S7/VM and is NOT
 * exercised here.)
 */

import type { SandboxEvent } from "../wire-protocol.js";
import {
	ACP_EXT_KEY,
	type AcpExt,
	type AcpStopReason,
	PI_EXT,
	type PiUsageExt,
	type SessionNotification,
	type SessionUpdate,
} from "./types.js";

// ─── per-run context the translator threads ────────────────────────────────

/**
 * Context the forward translator carries across a stream: the session id every
 * notification is tagged with, the current 1-based turn number (set by
 * `turn_start`, echoed by `turn_end` and attached to the updates in between),
 * and the latest rolled-up token usage (attached at `turn_end`).
 *
 * This is the ACP-side analogue of the worker's loop locals — but it is held
 * here as a plain value the translator MUTATES as it folds the stream, never a
 * Pi handle. A fresh context per run; nothing leaks across sessions.
 */
export interface AcpTranslateContext {
	readonly sessionId: string;
	/** 1-based current turn; 0 before the first turn_start. */
	turn: number;
	/** Latest token usage to stamp onto the next turn_end marker, if any. */
	usage?: PiUsageExt;
}

/** Build a fresh forward-translation context for a session. */
export function newContext(sessionId: string, usage?: PiUsageExt): AcpTranslateContext {
	return { sessionId, turn: 0, usage };
}

// ─── forward: SandboxEvent → SessionUpdate ──────────────────────────────────

/**
 * Translate one `SandboxEvent` into its ACP `session/update` payload (or
 * `undefined` for terminal/control events that are NOT stream updates — `done`,
 * `truncated`, `error` resolve the `session/prompt` *response*, not the
 * notification stream; see {@link terminalToStopReason}).
 *
 * MUTATES `ctx.turn` on turn markers so subsequent updates in the turn carry
 * the right turn number — mirroring how the worker's turn counter advances.
 */
export function sandboxEventToSessionUpdate(event: SandboxEvent, ctx: AcpTranslateContext): SessionUpdate | undefined {
	switch (event.type) {
		case "turn_start": {
			ctx.turn = event.turn;
			return {
				sessionUpdate: "choreograph.turn",
				[ACP_EXT_KEY]: { [PI_EXT.turn]: event.turn, [PI_EXT.turnPhase]: "start" },
			};
		}

		case "turn_end": {
			ctx.turn = event.turn;
			const ext: AcpExt & { [PI_EXT.turn]: number; [PI_EXT.turnPhase]: "end" } = {
				[PI_EXT.turn]: event.turn,
				[PI_EXT.turnPhase]: "end",
			};
			// Domination: roll the run's token usage onto the closing turn marker —
			// a frame the plain SandboxEvent stream has no slot for.
			if (ctx.usage) ext[PI_EXT.usage] = ctx.usage;
			return { sessionUpdate: "choreograph.turn", [ACP_EXT_KEY]: ext };
		}

		case "text":
			return {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: event.content },
				...turnExt(ctx),
			};

		case "thinking":
			// Schema-reserved in SandboxEvent but never produced (S0 proved Pi emits
			// no thinking). If one ever appears, map it to a thought chunk so the
			// round-trip is total — but the S2 oracle does NOT assert this path.
			return {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: event.content },
				...turnExt(ctx),
			};

		case "tool_call":
			return {
				sessionUpdate: "tool_call",
				toolCallId: deriveToolCallId(event.gate),
				title: event.gate,
				rawInput: event.args,
				status: "in_progress",
				...turnExt(ctx),
			};

		case "tool_result":
			return {
				sessionUpdate: "tool_call_update",
				toolCallId: deriveToolCallId(event.gate),
				status: event.is_error ? "failed" : "completed",
				rawOutput: { result: event.result },
				...turnExt(ctx),
			};

		// Terminal/control events are NOT session/update stream frames.
		case "done":
		case "truncated":
		case "error":
			return undefined;
	}
}

/** Wrap a `SandboxEvent` update payload as a full ACP `session/update` notification. */
export function sandboxEventToNotification(
	event: SandboxEvent,
	ctx: AcpTranslateContext,
): SessionNotification | undefined {
	const update = sandboxEventToSessionUpdate(event, ctx);
	if (!update) return undefined;
	return { method: "session/update", sessionId: ctx.sessionId, update };
}

/**
 * Translate an ordered `SandboxEvent` stream into the ordered ACP
 * `session/update` notifications, threading turn context across the run.
 * Terminal events (done/truncated/error) drop out of the stream (they resolve
 * the prompt response) — see {@link translateRun} for the full result shape.
 */
export function translateStream(events: readonly SandboxEvent[], ctx: AcpTranslateContext): SessionNotification[] {
	const out: SessionNotification[] = [];
	for (const ev of events) {
		const note = sandboxEventToNotification(ev, ctx);
		if (note) out.push(note);
	}
	return out;
}

// ─── inverse: SessionUpdate → SandboxEvent (agent-agnostic core) ────────────

/**
 * The INVERSE map: recover the agent-agnostic `SandboxEvent` core from an ACP
 * `session/update` payload. This is the equivalence half of the oracle — the
 * `_ext` richness is intentionally NOT consumed for the core fields (it is
 * additive), but the turn marker's `_ext` turn number IS authoritative for
 * reconstructing `turn_start`/`turn_end` (the turn number lives only there).
 */
export function sessionUpdateToSandboxEvent(update: SessionUpdate): SandboxEvent | undefined {
	switch (update.sessionUpdate) {
		case "choreograph.turn": {
			const ext = update[ACP_EXT_KEY];
			const turn = ext[PI_EXT.turn];
			const phase = ext[PI_EXT.turnPhase];
			return phase === "start" ? { type: "turn_start", turn } : { type: "turn_end", turn };
		}
		case "agent_message_chunk":
			return { type: "text", content: update.content.text };
		case "tool_call":
			return { type: "tool_call", gate: update.title, args: update.rawInput };
		case "tool_call_update":
			return {
				type: "tool_result",
				gate: toolNameFromCallId(update.toolCallId),
				result: update.rawOutput.result,
				is_error: update.status === "failed",
			};
	}
}

/** Project an ACP notification stream BACK to the agent-agnostic SandboxEvent list. */
export function projectStreamBack(notes: readonly SessionNotification[]): SandboxEvent[] {
	const out: SandboxEvent[] = [];
	for (const n of notes) {
		const ev = sessionUpdateToSandboxEvent(n.update);
		if (ev) out.push(ev);
	}
	return out;
}

// ─── terminal ⟷ stopReason ──────────────────────────────────────────────────

/**
 * Map a terminal `SandboxEvent` onto an ACP `session/prompt` `stopReason`.
 *   done      → end_turn          (natural / done-tool completion)
 *   truncated → max_turn_requests (ward turn limit hit)
 *   error     → refusal           (run failed; ACP has no generic "error" stop)
 * `cancelled` is reserved for `session/cancel` (not a SandboxEvent terminal).
 */
export function terminalToStopReason(event: SandboxEvent): AcpStopReason | undefined {
	switch (event.type) {
		case "done":
			return "end_turn";
		case "truncated":
			return "max_turn_requests";
		case "error":
			return "refusal";
		default:
			return undefined;
	}
}

/** Inverse: recover the terminal SandboxEvent *kind* from an ACP stopReason. */
export function stopReasonToTerminalKind(reason: AcpStopReason): SandboxEvent["type"] | undefined {
	switch (reason) {
		case "end_turn":
			return "done";
		case "max_turn_requests":
			return "truncated";
		case "refusal":
			return "error";
		case "cancelled":
			return undefined; // not a stream terminal
	}
}

// ─── run-level translate (stream + terminal together) ───────────────────────

/** The full ACP translation of a run: the notification stream + the prompt stop. */
export interface AcpRunTranslation {
	notifications: SessionNotification[];
	/** Terminal stop reason, if the stream carried a terminal SandboxEvent. */
	stopReason?: AcpStopReason;
	/** Terminal output text (done/truncated output / error message). */
	output?: string;
}

/**
 * Translate a full ordered `SandboxEvent` run (stream frames + a terminal) into
 * the ACP run shape: the `session/update` notifications plus the `stopReason`
 * the `session/prompt` response would resolve with.
 */
export function translateRun(events: readonly SandboxEvent[], ctx: AcpTranslateContext): AcpRunTranslation {
	const notifications = translateStream(events, ctx);
	let stopReason: AcpStopReason | undefined;
	let output: string | undefined;
	for (const ev of events) {
		const r = terminalToStopReason(ev);
		if (!r) continue;
		stopReason = r;
		// Narrow on the discriminant itself: terminalToStopReason being truthy
		// does not narrow `ev`, so read the variant fields per-type.
		if (ev.type === "error") output = ev.message;
		else if (ev.type === "done" || ev.type === "truncated") output = ev.output;
	}
	return { notifications, stopReason, output };
}

// ─── the ACP Agent role (translation half) ──────────────────────────────────

/**
 * The ACP Agent surface choreograph owns: the pure translation half of the
 * Agent role. It does NOT spawn a worker, open a bus, or stream SSE (that live
 * wiring is S7/VM). It is the value layer that a live Agent will sit on top of:
 * forward (internal → ACP) and inverse (ACP → internal) maps, plus terminal
 * mapping, all bound to one `sessionId`.
 */
export interface AcpAgent {
	readonly sessionId: string;
	/** Forward-translate an ordered SandboxEvent stream to ACP notifications. */
	toAcp(events: readonly SandboxEvent[], usage?: PiUsageExt): SessionNotification[];
	/** Forward-translate a full run (stream + terminal) to the ACP run shape. */
	runToAcp(events: readonly SandboxEvent[], usage?: PiUsageExt): AcpRunTranslation;
	/** Inverse-project ACP notifications back to the agent-agnostic SandboxEvents. */
	fromAcp(notes: readonly SessionNotification[]): SandboxEvent[];
}

/**
 * Construct an ACP Agent surface for a session. Pure: it captures only the
 * `sessionId` and returns closures over the stateless translation functions
 * (each call builds a fresh context, so concurrent runs never share turn state).
 */
export function createAcpAgent(sessionId: string): AcpAgent {
	return {
		sessionId,
		toAcp(events, usage) {
			return translateStream(events, newContext(sessionId, usage));
		},
		runToAcp(events, usage) {
			return translateRun(events, newContext(sessionId, usage));
		},
		fromAcp(notes) {
			return projectStreamBack(notes);
		},
	};
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Attach the current turn number as an `_ext` frame to a stream update, when a
 * turn is active. ACP has no native turn slot, so this is the domination frame
 * for non-terminal updates: a choreograph-aware client can group updates by
 * turn; a strict ACP client ignores `_meta`.
 */
function turnExt(ctx: AcpTranslateContext): { [ACP_EXT_KEY]?: AcpExt } {
	if (ctx.turn <= 0) return {};
	return { [ACP_EXT_KEY]: { [PI_EXT.turn]: ctx.turn } };
}

/**
 * Derive a stable ACP `toolCallId` from a gate name. The SandboxEvent stream
 * does NOT carry Pi's `toolCallId` (S0 dropped it — it is not part of the
 * agent-agnostic core), so we mint a deterministic id from the gate so a
 * `tool_call` and its later `tool_call_update` correlate. The inverse map
 * recovers the gate from the id (see {@link toolNameFromCallId}).
 */
function deriveToolCallId(gate: string): string {
	return `${TOOL_CALL_ID_PREFIX}${gate}`;
}

/** Recover the gate (tool name) from a minted toolCallId. */
function toolNameFromCallId(toolCallId: string): string {
	return toolCallId.startsWith(TOOL_CALL_ID_PREFIX) ? toolCallId.slice(TOOL_CALL_ID_PREFIX.length) : toolCallId;
}

const TOOL_CALL_ID_PREFIX = "choreograph.pi/tool:";
