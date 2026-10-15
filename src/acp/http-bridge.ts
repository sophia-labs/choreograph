/**
 * ACP HTTP/JSON-RPC bridge — the PURE adapter that maps ACP client requests
 * onto choreograph's EXISTING chat-turn pipeline.
 *
 * CA-1 / S6 — the ACP endpoint family, routing/translation half.
 *
 * This module is the value core of the ACP front door choreograph speaks as an
 * ACP **Agent** (the role we OWN — NOT the community `pi-acp` adapter; see
 * `./types.ts` and memory `choreograph-agent-spine-decisions`). It parses the
 * ACP JSON-RPC requests (`session/new`, `session/load`, `session/prompt`,
 * `session/cancel`, and our `session/fork` extension) and maps each onto a
 * pipeline SEAM:
 *
 *   - `session/new`     → create a session row (the live mount delegates to the
 *                         EXISTING `POST /api/sessions` create path).
 *   - `session/load`    → freeze the IntentLog (S1) → projected head.
 *   - `session/prompt`  → S3 `authorize` (driver gate) → enqueue onto the
 *                         EXISTING `spawner.enqueue` path (the same worker_config
 *                         the chat-turn handler builds), returning the sandbox_id
 *                         the live mount streams `session/update` over.
 *   - `session/cancel`  → abort the active sandbox (the EXISTING abort path).
 *   - `session/fork`    → S1 `fork(log, atSeq)` — a projected head of the first
 *                         `atSeq` turns, no new table, no data copy.
 *
 * It is PURE in the sense that matters for CA-1's no-mock proof: every effect is
 * an INJECTED seam (`AcpBridgeDeps`) — the REAL functions a live mount passes
 * (the real `IntentLog`, the real `AuthorityCapabilityBackend`, the real
 * `DriverPresence`, the real enqueue/abort closures over the real spawner). The
 * bridge itself owns NO HTTP server, NO socket, NO bwrap, NO Pi runtime. So it
 * can be driven end-to-end against the REAL S1/S2/S3 code with plain literals as
 * input — which is exactly what `src/test/acp-bridge.test.ts` does. The live
 * orchestrator mount (S6 step 2) is the thin shell that fills `AcpBridgeDeps`
 * with closures over `ctx.spawner` / `ctx.sessions` / `ctx.eventBus`.
 *
 * The agent→client `session/update` stream is NOT re-implemented here: it is the
 * S2 translator (`createAcpAgent(...).toAcp(...)`) applied to the bus's
 * `SandboxEvent`s. {@link busEventToSessionNotification} is the one new mapping
 * — it lifts a live `category:"agent"` BusEvent into the S2 translator so the
 * live mount's SSE fan-out can be byte-equivalent (on the agent-agnostic core)
 * to the existing `SandboxEvent` SSE stream while ADDITIONALLY carrying `_ext`.
 */

import type { SandboxEvent } from "../wire-protocol.js";
import { createAcpAgent } from "./agent-surface.js";
import { type AuthorityCapabilityBackend, NotDriverError, type PermissionDecision } from "./authority-backend.js";
import { authorize, type DriverPresence } from "./driver-presence.js";
import type { AcpClientRequest, AcpExt, AcpStopReason, SessionNotification, SessionUpdate } from "./types.js";

export interface InferenceBinding {
	readonly provider?: string;
	readonly model?: string;
}

// ─── injected pipeline seams (the REAL functions a live mount passes) ───────

/**
 * The result of enqueuing a prompt onto the spawner — the sandbox the live mount
 * streams `session/update` notifications over. Mirrors the EXISTING
 * `spawner.enqueue(...)` return (`{ sandbox_id }`); the bridge only needs the id.
 */
export interface EnqueueResult {
	readonly sandbox_id: string;
}

/**
 * The seams the bridge maps ACP requests onto. Each is the REAL pipeline
 * function the live orchestrator owns; the bridge calls them, it does not
 * reimplement them.
 */
export interface AcpBridgeDeps {
	/**
	 * Create a fresh session and return its id — the live mount delegates to the
	 * EXISTING `POST /api/sessions` create path (`ctx.sessions.createSession`).
	 * `opts.provider` is ADDITIVE — the session-create path persists it alongside
	 * `model` so it becomes the `session` precedence layer for later prompts.
	 */
	createSession(ownerUserId: string, opts?: { model?: string; provider?: string; graphId?: string }): Promise<string>;

	/**
	 * Freeze the session's IntentLog (S1) and project its head. The live mount
	 * builds a `SessionStoreIntentLog` + `HeadProjection`; `session/load` reads it.
	 */
	loadHead(sessionId: string): Promise<{ messages: unknown[]; digest: string; headSeq: number }>;

	/**
	 * Enqueue a prompt onto the EXISTING chat-turn spawn path: persist the user
	 * message, rebuild history, `spawner.enqueue(workerConfig)`. The live mount's
	 * closure IS the body of `POST /api/sessions/:id/message` (steps 1-5). Returns
	 * the sandbox id to stream over.
	 */
	enqueuePrompt(input: {
		sessionId: string;
		ownerUserId: string;
		text: string;
		/**
		 * The per-TURN inference override (CA-1 shared substrate). The live mount
		 * folds this OVER the session record's binding (and env-default) via
		 * `resolveInferenceBinding`, writing the result into `worker_config.{model,
		 * provider}`. Absent ⇒ the session/env-default binding is used unchanged
		 * (byte-identical to the pre-substrate enqueue).
		 */
		promptBinding?: InferenceBinding;
	}): Promise<EnqueueResult>;

	/**
	 * Fork the session at `atSeq` turns — S1 `fork(log, atSeq)`. Returns the
	 * projected head of the first-N turns (no new table, no data movement).
	 */
	forkAt(sessionId: string, atSeq: number): Promise<{ messages: unknown[]; digest: string; headSeq: number }>;

	/**
	 * Abort the active sandbox for a session — the EXISTING abort path
	 * (`spawner.kill(...)`). Returns true iff a sandbox was aborted.
	 */
	abort(sessionId: string): Promise<boolean>;

	/**
	 * The S3 multi-driver authority register for this session. `session/prompt`
	 * is gated through `authorize(presence, "session/prompt", clientId)` (N=1
	 * solo auto-claim preserved). Shared with the `acp.authority` capability so a
	 * non-driver prompt and a non-driver permission answer reject identically.
	 */
	readonly presence: DriverPresence;

	/**
	 * The S3 `acp.authority` capability backend — drives `request_permission`
	 * fan-out and `steer`. Optional: a session with no destructive ops never
	 * needs it. When present, a permission request fans out as the NEW
	 * `category:"authority"` BusEvent via {@link AcpBridgeDeps.emitAuthority}.
	 */
	readonly authority?: AuthorityCapabilityBackend;

	/**
	 * Emit a session-scoped authority event onto the bus (the NEW
	 * `category:"authority"` BusEvent variant the live mount adds, fanned out to
	 * the session's SSE subscribers). The live mount's closure calls
	 * `ctx.eventBus.emit({ category:"authority", ... })`.
	 */
	emitAuthority?(event: AuthorityBusFrame): void;
}

/**
 * The shape of the NEW `category:"authority"` BusEvent the bridge asks the live
 * mount to fan out. The live orchestrator wraps this with `sandbox_id` + `ts`
 * (the `BusEventBase` fields) and inserts the union arm; the bridge only owns
 * the authority-specific payload (so this module imports no `event-bus.ts`).
 */
export interface AuthorityBusFrame {
	readonly category: "authority";
	readonly type: "permission";
	/** The pending permission request id (correlates the eventual answer). */
	readonly callId: string;
	/** The tool the agent wants to call (for the driver's decision UI). */
	readonly tool?: string;
	/** The current driver the request is addressed to (null if unclaimed). */
	readonly driverId: string | null;
}

// ─── ACP response shapes the bridge returns ─────────────────────────────────

/** `session/new` → the minted session id. */
export interface NewSessionResponse {
	readonly sessionId: string;
}

/** `session/load` / `session/fork` → the projected head (S1). */
export interface LoadedHeadResponse {
	readonly sessionId: string;
	readonly messages: unknown[];
	readonly digest: string;
	readonly headSeq: number;
}

/** `session/prompt` accepted → the sandbox the live mount streams over. */
export interface PromptAcceptedResponse {
	readonly sessionId: string;
	readonly sandboxId: string;
	/** Echoes the authorized driver (the N=1 solo claimant, or the seated driver). */
	readonly driver: string;
}

/** `session/cancel` → whether an active sandbox was aborted. */
export interface CancelResponse {
	readonly sessionId: string;
	readonly aborted: boolean;
}

/**
 * `session/answer` accepted → the driver's permission decision was applied.
 * `settled` is true iff THIS answer settled the pending request (first-decisive-
 * answer wins); false means it was already settled (a prior decisive answer or
 * the S3 auto-deny timeout) — the answer was a well-formed no-op, NOT a 409.
 */
export interface AnswerResponse {
	readonly sessionId: string;
	readonly callId: string;
	readonly allowed: boolean;
	readonly settled: boolean;
}

/**
 * A 409-shaped authority rejection — the SAME `not_driver` posture as
 * `NotDriverError` (S3). The live mount sends HTTP 409 with this body.
 */
export interface NotDriverResponse {
	readonly status: 409;
	readonly error: "not_driver";
	/** The current driver (the one who WOULD be authorized), or null if unclaimed. */
	readonly driver: string | null;
}

export type AcpBridgeResponse =
	| NewSessionResponse
	| LoadedHeadResponse
	| PromptAcceptedResponse
	| CancelResponse
	| AnswerResponse
	| NotDriverResponse;

/** Type guard: a bridge response that is the 409 not_driver rejection. */
export function isNotDriver(r: AcpBridgeResponse): r is NotDriverResponse {
	return (r as NotDriverResponse).status === 409 && (r as NotDriverResponse).error === "not_driver";
}

// ─── the request envelope the bridge accepts ────────────────────────────────

/**
 * The ACP request as it arrives at the front door: the parsed JSON-RPC method
 * params (an {@link AcpClientRequest}) PLUS the resolved actor identity. In the
 * live mount, `ownerUserId` comes from `requireAuthenticatedOwner` and
 * `clientId` from the ACP client handshake (the multi-driver client id); the
 * bridge is layered AFTER auth, so it trusts these as already-validated.
 */
export interface AcpRequestEnvelope {
	readonly request: AcpClientRequest;
	/** The authenticated owner (Cognito sub / dev X-User-ID). */
	readonly ownerUserId: string;
	/**
	 * The ACP client id competing for the driver seat. For a single-client
	 * session this defaults to `ownerUserId` (the lone client trivially drives).
	 */
	readonly clientId: string;
	/** Optional session-create hints (model / provider / graph) for `session/new`. */
	readonly newSessionOpts?: { model?: string; provider?: string; graphId?: string };
	/**
	 * The per-TURN inference override (CA-1 shared substrate). Highest-precedence
	 * layer of the binding fold, resolved in `handleAcpRequest` for
	 * `session/prompt`. Both fields optional; an absent field inherits the session
	 * (then env-default) layer. Carried as a parallel coordinate to `clientId`
	 * (the driver) on the SAME control surface.
	 */
	readonly promptBinding?: InferenceBinding;
	/** Logical timestamp for the driver claim (default: now). */
	readonly ts?: number;
}

/**
 * Parse a raw JSON-RPC body into the typed {@link AcpClientRequest}, or throw a
 * descriptive error. PURE: validates the discriminant (`method`) + required
 * fields, no side effects. The live mount calls this on the request body.
 */
export function parseAcpRequest(body: unknown): AcpClientRequest {
	if (!body || typeof body !== "object") throw new Error("acp: request body must be an object");
	const o = body as Record<string, unknown>;
	const method = o.method;
	switch (method) {
		case "session/new":
			return {
				method,
				cwd: typeof o.cwd === "string" ? o.cwd : undefined,
				mcpServers: Array.isArray(o.mcpServers) ? o.mcpServers : undefined,
				model: optionalString(o, "model"),
				provider: optionalString(o, "provider"),
			};
		case "session/load":
			return { method, sessionId: requireString(o, "sessionId") };
		case "session/prompt":
			return {
				method,
				sessionId: requireString(o, "sessionId"),
				prompt: requirePrompt(o),
				model: optionalString(o, "model"),
				provider: optionalString(o, "provider"),
			};
		case "session/cancel":
			return { method, sessionId: requireString(o, "sessionId") };
		case "session/fork":
			return { method, sessionId: requireString(o, "sessionId"), atSeq: requireNonNegInt(o, "atSeq") };
		case "session/answer":
			return {
				method,
				sessionId: requireString(o, "sessionId"),
				callId: requireString(o, "callId"),
				allowed: requireBool(o, "allowed"),
			};
		default:
			throw new Error(`acp: unknown method "${String(method)}"`);
	}
}

function requireString(o: Record<string, unknown>, key: string): string {
	const v = o[key];
	if (typeof v !== "string" || v.length === 0)
		throw new Error(`acp: "${key}" is required and must be a non-empty string`);
	return v;
}
/** A non-empty string field if present and valid, else undefined (additive binding fields). */
function optionalString(o: Record<string, unknown>, key: string): string | undefined {
	const v = o[key];
	return typeof v === "string" && v.length > 0 ? v : undefined;
}
function requireNonNegInt(o: Record<string, unknown>, key: string): number {
	const v = o[key];
	if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
		throw new Error(`acp: "${key}" is required and must be a non-negative integer`);
	}
	return v;
}
function requireBool(o: Record<string, unknown>, key: string): boolean {
	const v = o[key];
	if (typeof v !== "boolean") throw new Error(`acp: "${key}" is required and must be a boolean`);
	return v;
}
function requirePrompt(o: Record<string, unknown>): Array<{ type: "text"; text: string }> {
	const p = o.prompt;
	if (!Array.isArray(p) || p.length === 0) throw new Error('acp: "prompt" is required and must be a non-empty array');
	return p.map((part) => {
		const part_ = part as Record<string, unknown>;
		if (part_?.type !== "text" || typeof part_.text !== "string") {
			throw new Error('acp: each prompt part must be { type:"text", text:string }');
		}
		return { type: "text" as const, text: part_.text };
	});
}

/** Concatenate the ACP prompt parts into the single message text the pipeline takes. */
export function promptText(prompt: Array<{ type: "text"; text: string }>): string {
	return prompt.map((p) => p.text).join("");
}

/**
 * The per-TURN inference override for a `session/prompt`. The request's own
 * `model`/`provider` (parsed from the ACP body) take precedence over the
 * envelope's `promptBinding` (the non-ACP-native fallback channel). Returns
 * `undefined` when NEITHER contributes anything — so the enqueue path is
 * byte-identical to the pre-substrate turn when no override is present. PURE.
 */
export function perTurnBinding(
	request: { model?: string; provider?: string },
	envelopeBinding?: InferenceBinding,
): InferenceBinding | undefined {
	const provider = request.provider ?? envelopeBinding?.provider;
	const model = request.model ?? envelopeBinding?.model;
	if (provider === undefined && model === undefined) return undefined;
	return {
		...(provider !== undefined ? { provider } : {}),
		...(model !== undefined ? { model } : {}),
	};
}

// ─── the dispatcher ─────────────────────────────────────────────────────────

/**
 * Handle one ACP client request by mapping it onto the injected pipeline seams.
 *
 * This is the single entry point the live mount calls (after auth + ownership).
 * It is PURE-over-seams: every effect goes through {@link AcpBridgeDeps}; the
 * bridge contains the routing/translation/authority LAYERING and nothing else.
 *
 * Authority layering (S3): `session/prompt` is gated through `authorize(...)`
 * BEFORE it touches the spawn path — a non-driver prompt returns the 409-shaped
 * {@link NotDriverResponse} and never enqueues. The N=1 solo auto-claim is
 * preserved (a lone client trivially becomes the driver), so a single-client
 * session behaves byte-identically to the baseline chat turn.
 */
export async function handleAcpRequest(env: AcpRequestEnvelope, deps: AcpBridgeDeps): Promise<AcpBridgeResponse> {
	const { request } = env;
	switch (request.method) {
		case "session/new": {
			const sessionId = await deps.createSession(env.ownerUserId, env.newSessionOpts);
			return { sessionId };
		}

		case "session/load": {
			const head = await deps.loadHead(request.sessionId);
			return { sessionId: request.sessionId, ...head };
		}

		case "session/prompt": {
			// S3 driver gate FIRST — layered after auth, before the spawn path.
			const decision = authorize(deps.presence, "session/prompt", env.clientId, env.ts);
			if (!decision.ok) {
				return { status: 409, error: "not_driver", driver: decision.driver };
			}
			// Per-TURN binding (CA-1 shared substrate): the request's own
			// model/provider take precedence; the envelope's `promptBinding` is the
			// fallback channel (e.g. a non-ACP-native caller). The live mount folds
			// this OVER the session record's binding via `resolveInferenceBinding`.
			const promptBinding = perTurnBinding(request, env.promptBinding);
			const { sandbox_id } = await deps.enqueuePrompt({
				sessionId: request.sessionId,
				ownerUserId: env.ownerUserId,
				text: promptText(request.prompt),
				...(promptBinding ? { promptBinding } : {}),
			});
			return { sessionId: request.sessionId, sandboxId: sandbox_id, driver: decision.driver };
		}

		case "session/cancel": {
			const aborted = await deps.abort(request.sessionId);
			return { sessionId: request.sessionId, aborted };
		}

		case "session/fork": {
			const head = await deps.forkAt(request.sessionId, request.atSeq);
			return { sessionId: request.sessionId, ...head };
		}

		case "session/answer": {
			// A driver settles a pending destructive-tool permission. With no
			// authority backend wired (a session that never opened a permission), the
			// answer cannot apply — return the 409 not_driver posture (no driver seat
			// to author the decision against), consistent with the gate being absent.
			if (!deps.authority) {
				return { status: 409, error: "not_driver", driver: deps.presence.currentDriver() };
			}
			try {
				// S3 owns the authority check + first-decisive-answer; a NON-driver
				// answer throws NotDriverError, mapped to the SAME 409 posture as a
				// non-driver prompt. `settled=false` means already-settled (no-op), 200.
				const settled = deps.authority.answerPermission(request.callId, request.allowed, env.clientId);
				return { sessionId: request.sessionId, callId: request.callId, allowed: request.allowed, settled };
			} catch (err) {
				if (err instanceof NotDriverError) {
					return { status: 409, error: "not_driver", driver: deps.presence.currentDriver() };
				}
				throw err;
			}
		}
	}
}

// ─── permission fan-out (the NEW category:"authority" BusEvent) ─────────────

/**
 * Open a permission request through the S3 authority backend AND fan it out as
 * the NEW `category:"authority"` BusEvent so every session subscriber sees it.
 * Returns the PENDING decision promise the agent awaits (resolved when the
 * current driver answers, or auto-denied on the S3 timeout).
 *
 * This is the routing half of the multi-driver permission flow: the bridge asks
 * the authority backend for a pending decision (S3 owns first-decisive-answer +
 * timeout), and simultaneously emits the `authority:permission` frame so drivers
 * can answer. The live mount supplies `emitAuthority` (a closure over
 * `ctx.eventBus.emit`). With no authority/emit wired, it is a no-op-safe
 * auto-deny path (returns `{ allowed:false }`), never a hang.
 */
export async function requestPermissionAndFanOut(
	deps: AcpBridgeDeps,
	callId: string,
	tool?: string,
): Promise<PermissionDecision> {
	if (!deps.authority) return { allowed: false };
	// Fan out the authority frame so drivers see the pending ask (before awaiting).
	deps.emitAuthority?.({
		category: "authority",
		type: "permission",
		callId,
		tool,
		driverId: deps.presence.currentDriver(),
	});
	return deps.authority.requestPermission(callId, tool);
}

// ─── bus SandboxEvent → ACP session/update (the live stream lift) ───────────

/**
 * Lift one live `category:"agent"` BusEvent's `SandboxEvent` into an ACP
 * `session/update` notification via the S2 translator. The live mount's SSE
 * fan-out uses this to emit ACP `session/update`s that are byte-equivalent (on
 * the agent-agnostic core) to the existing `SandboxEvent` SSE stream while
 * ADDITIONALLY carrying the `_ext` (`choreograph.pi/*`) frames (domination).
 *
 * Returns `undefined` for terminal/control SandboxEvents (`done`/`truncated`/
 * `error`) — those resolve the `session/prompt` response, not the stream (see
 * `terminalToStopReason` in `./agent-surface.ts`). A fresh translator context is
 * carried by the caller across the stream so turn numbers thread correctly;
 * this single-event lift is the per-event step.
 */
export function busEventToSessionNotification(
	// The session id is carried by the bound S2 agent in `ctx` (so notifications
	// are already tagged); kept in the signature to mirror the live mount's
	// per-session call shape and document the binding.
	_sessionId: string,
	event: SandboxEvent,
	ctx: AcpStreamContext,
): SessionNotification | undefined {
	// Reuse the S2 translator. We translate one event at a time, threading the
	// turn context so in-turn updates carry the active turn (domination).
	const note = ctx.agent.toAcp([event], ctx.usage)[0];
	return note;
}

/**
 * Per-session live-stream context the live mount holds while fanning out a run:
 * the S2 agent (bound to the session id) and the latest rolled-up usage. A fresh
 * one per run, mirroring `newContext` in the S2 translator.
 */
export interface AcpStreamContext {
	readonly agent: ReturnType<typeof createAcpAgent>;
	usage?: import("./types.js").PiUsageExt;
}

/** Build a fresh live-stream context for a session (the live mount's per-run state). */
export function newStreamContext(sessionId: string): AcpStreamContext {
	return { agent: createAcpAgent(sessionId) };
}

// ─── SSE framing helper (the live mount's wire shape) ───────────────────────

/**
 * Frame an ACP `session/update` notification as an SSE event line, MATCHING the
 * existing `writeSseEvent` shape in `src/sse-transport.ts` (`event:`/`id:`/`data:`).
 * The event name is `session/update`; the data is the JSON-RPC notification. Pure
 * string-building — the live mount writes the returned string to the response.
 */
export function frameAcpSse(note: SessionNotification, id: number | string): string {
	return `event: session/update\nid: ${id}\ndata: ${JSON.stringify(note)}\n\n`;
}

/**
 * Frame the NEW `authority:permission` BusEvent as an SSE event, matching the
 * `event: {category}:{type}` convention the existing SSE transport uses (per
 * recon-mount: "The category string becomes the SSE event type prefix").
 */
export function frameAuthoritySse(frame: AuthorityBusFrame, id: number | string): string {
	return `event: ${frame.category}:${frame.type}\nid: ${id}\ndata: ${JSON.stringify(frame)}\n\n`;
}

// re-export the few S2/S3 symbols the live mount composes, so the mount imports
// the bridge as the single ACP front-door module.
export {
	createAcpAgent,
	stopReasonToTerminalKind,
	terminalToStopReason,
} from "./agent-surface.js";
export type { AcpStopReason, SessionUpdate, AcpExt };
