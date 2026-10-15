/**
 * ACP (Agent Client Protocol) method/notification shapes — the wire vocabulary
 * of the ACP **Agent role choreograph OWNS**.
 *
 * CA-1 / S2 — the ACP-native wire surface.
 *
 * These are the JSON-RPC method names and the `session/update` payload shapes
 * choreograph speaks as an ACP *Agent*. We model only the subset S2 needs: the
 * client→agent methods (`session/new`, `session/load`, `session/prompt`,
 * `session/cancel`, plus our `session/fork` extension) and the agent→client
 * `session/update` notification family. This is NOT the community `pi-acp`
 * adapter (which carries no MCP passthrough); it is the role we build so the
 * embedded-Pi worker + the `/g/{id}/mcp` transport ride underneath an ACP
 * envelope (see memory `choreograph-agent-spine-decisions`: "ACP-native at the
 * wire … keep embedded Pi + /g/{id}/mcp transport, richness via _ext").
 *
 * The Pi-specific richness (per-turn counters, token usage) that ACP has no
 * native slot for rides an `_ext` namespace `choreograph.pi/*`. ACP's spec
 * reserves `_meta` for exactly this; we name our slot inside it so a strict ACP
 * client can ignore it and a choreograph-aware client can read it. The plain
 * `SandboxEvent` stream (S0) carries NONE of this richness — that asymmetry is
 * the DOMINATION the S2 oracle proves.
 *
 * PURE / no-import: this module imports no Pi, no CRDT handle, no session store.
 * It only declares shapes and the `_ext` namespace constants. The translator in
 * `./agent-surface.ts` reads frozen rows / plain `SandboxEvent` values only.
 */

// ─── _ext namespace ──────────────────────────────────────────────────────
//
// Choreograph's reserved keys inside ACP's `_meta` extension slot. Every Pi
// detail ACP cannot name natively lands here, under a vendor-prefixed key so a
// strict ACP client treats it as opaque and ignores it.

/** The `_ext` envelope key (ACP's spec-reserved extension slot). */
export const ACP_EXT_KEY = "_meta" as const;

/** Vendor-prefixed keys choreograph writes into `_ext`. */
export const PI_EXT = {
	/** The 1-based turn index this update belongs to (Pi's turn counter). */
	turn: "choreograph.pi/turn",
	/** Turn-lifecycle phase marker: "start" | "end" (Pi turn_start/turn_end). */
	turnPhase: "choreograph.pi/turn_phase",
	/** Token usage rolled up at turn/run end (Pi `Usage`-shaped). */
	usage: "choreograph.pi/usage",
} as const;

/**
 * Token-usage frame mirrored from Pi's `@earendil-works/pi-ai` `Usage`
 * (input/output/cacheRead/cacheWrite/totalTokens). Carried in `_ext` because
 * ACP `session/update` has no native usage slot. Optional cost is omitted —
 * usage counts are the load-bearing telemetry; cost is derivable downstream.
 */
export interface PiUsageExt {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
}

/** The shape of choreograph's `_ext` block on a `session/update`. */
export interface AcpExt {
	[PI_EXT.turn]?: number;
	[PI_EXT.turnPhase]?: "start" | "end";
	[PI_EXT.usage]?: PiUsageExt;
}

// ─── session/update notification family (agent → client) ───────────────────
//
// ACP streams an agent run as `session/update` notifications. Each carries a
// `sessionId` and an `update` discriminated by `sessionUpdate`. We model the
// variants the SandboxEvent stream produces:
//   - agent_message_chunk   ← SandboxEvent "text"
//   - tool_call             ← SandboxEvent "tool_call"
//   - tool_call_update      ← SandboxEvent "tool_result"
//   - choreograph.turn      ← SandboxEvent "turn_start"/"turn_end" (turn markers
//                             have no native ACP slot; carried as an ext-typed
//                             update so they survive the round-trip)

/** ACP tool-call status (the subset we emit). */
export type AcpToolCallStatus = "in_progress" | "completed" | "failed";

/** `agent_message_chunk` — a streamed assistant text fragment. */
export interface AgentMessageChunkUpdate {
	sessionUpdate: "agent_message_chunk";
	content: { type: "text"; text: string };
	[ACP_EXT_KEY]?: AcpExt;
}

/** `tool_call` — the agent invoked a tool. `rawInput` carries the args. */
export interface ToolCallUpdate {
	sessionUpdate: "tool_call";
	toolCallId: string;
	title: string;
	rawInput: Record<string, unknown>;
	status: "in_progress";
	[ACP_EXT_KEY]?: AcpExt;
}

/** `tool_call_update` — a tool finished; `rawOutput` carries the result. */
export interface ToolCallResultUpdate {
	sessionUpdate: "tool_call_update";
	toolCallId: string;
	status: Extract<AcpToolCallStatus, "completed" | "failed">;
	rawOutput: { result: string };
	[ACP_EXT_KEY]?: AcpExt;
}

/**
 * `choreograph.turn` — a turn lifecycle marker. ACP has no native turn-boundary
 * update, so we model it as a vendor-typed `sessionUpdate`. A strict ACP client
 * not recognizing the discriminant skips it; choreograph reads the `_ext` turn
 * number + phase. This is what lets the round-trip recover turn_start/turn_end.
 */
export interface TurnMarkerUpdate {
	sessionUpdate: "choreograph.turn";
	[ACP_EXT_KEY]: AcpExt & { [PI_EXT.turn]: number; [PI_EXT.turnPhase]: "start" | "end" };
}

/** The session/update payload union we produce. */
export type SessionUpdate = AgentMessageChunkUpdate | ToolCallUpdate | ToolCallResultUpdate | TurnMarkerUpdate;

/** A full `session/update` JSON-RPC notification (`{ sessionId, update }`). */
export interface SessionNotification {
	method: "session/update";
	sessionId: string;
	update: SessionUpdate;
}

// ─── session/prompt response (agent → client) ──────────────────────────────
//
// ACP `session/prompt` resolves with a `stopReason`. We map choreograph's
// terminal SandboxEvents (done / truncated / error) onto ACP's stop reasons.

/** ACP prompt stop reasons (the subset choreograph terminals map onto). */
export type AcpStopReason = "end_turn" | "max_turn_requests" | "refusal" | "cancelled";

/** `session/prompt` response — the run's terminal stop reason + final output. */
export interface PromptResponse {
	stopReason: AcpStopReason;
	/** Final summary/output text (choreograph `done`/`truncated` output). */
	output: string;
	[ACP_EXT_KEY]?: AcpExt & { "choreograph.pi/turns"?: number };
}

// ─── client → agent method shapes (modeled for completeness) ───────────────
//
// S2 only round-trips the agent→client stream + terminal. The client→agent
// request shapes are declared so the surface is a faithful ACP Agent role and
// so a later slice (S7, the live worker/bus/SSE wiring) can adopt them without
// reshaping. They are intentionally minimal.

export interface SessionNewRequest {
	method: "session/new";
	cwd?: string;
	mcpServers?: unknown[];
	/**
	 * Per-session inference binding (CA-1 shared substrate). Optional; the session
	 * record persists these, and they become the `session` precedence layer for
	 * every subsequent prompt. The agent-subject control surface: how the session
	 * thinks is DECLARED here, not read from a global server env.
	 */
	model?: string;
	provider?: string;
}
export interface SessionLoadRequest {
	method: "session/load";
	sessionId: string;
}
export interface SessionPromptRequest {
	method: "session/prompt";
	sessionId: string;
	prompt: Array<{ type: "text"; text: string }>;
	/**
	 * Per-TURN inference override (CA-1 shared substrate). Optional; highest
	 * precedence in the binding fold — a turn may override only the model
	 * (inheriting the session provider) or only the provider, or both.
	 */
	model?: string;
	provider?: string;
}
export interface SessionCancelRequest {
	method: "session/cancel";
	sessionId: string;
}
/** `session/fork` — choreograph's CRDT-fork extension (forkable session, S1). */
export interface SessionForkRequest {
	method: "session/fork";
	sessionId: string;
	/** Turn count to fork at (mirrors `fork(log, atSeq)` in S1). */
	atSeq: number;
}
/**
 * `session/answer` — a DRIVER answers a pending destructive-tool permission ask
 * (CA-1 / S8, the live-mount answer route). The agent's `beforeToolCall` gate
 * opened a `request_permission` (fanned out as a `category:"authority"` BusEvent
 * carrying `callId`); a driver settles it here. Gated through the SAME S3
 * `DriverPresence` as `session/prompt` — a NON-driver answer is the existing
 * `not_driver` 409 posture. First-decisive-answer wins (S3).
 */
export interface SessionAnswerRequest {
	method: "session/answer";
	sessionId: string;
	/** The pending permission request id (from the fanned-out authority event). */
	callId: string;
	/** The driver's decision: allow (`true`) or deny (`false`) the tool call. */
	allowed: boolean;
}

export type AcpClientRequest =
	| SessionNewRequest
	| SessionLoadRequest
	| SessionPromptRequest
	| SessionCancelRequest
	| SessionForkRequest
	| SessionAnswerRequest;
