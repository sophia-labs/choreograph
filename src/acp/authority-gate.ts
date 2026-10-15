/**
 * Authority gate — the worker-side `beforeToolCall` handler that BLOCKS a
 * destructive tool call until the session's driver approves it.
 *
 * CA-1 / B-keystone (the multi-driver permission gate, live-wiring half).
 *
 * This is the seam that lifts the S3 authority CORE (`../acp/authority-backend.ts`,
 * `../acp/driver-presence.ts`, `../acp/destructive.ts`) into the running Pi agent.
 * Pi's `Agent` accepts a `beforeToolCall(context) → BeforeToolCallResult | undefined`
 * hook (pi-agent-core `AgentOptions`): returning `{ block:true, reason }` prevents
 * the tool from executing (the loop emits an error tool-result with `reason`);
 * returning `undefined` lets the call proceed. {@link createAuthorityBeforeToolCall}
 * builds exactly that hook over the EXISTING gate channel
 * (`OrchestratorChannel.callGate`), so the worker change is one ctor argument.
 *
 * Flow for ONE tool call:
 *   1. Classify the tool with the S3 {@link isDestructive} (FAIL-CLOSED — an
 *      unknown / write-shaped name is destructive).
 *   2. A NON-destructive (read-shaped) tool passes through immediately —
 *      `undefined`, NEVER gated, NEVER a gate round-trip.
 *   3. A destructive tool calls `gate("acp.authority", "request_permission",
 *      { tool, args, callId })` and BLOCKS (await) until the gate resolves. On the
 *      live path the spawner routes that to the per-session
 *      {@link AuthorityCapabilityBackend}, whose `requestPermission` returns a
 *      PENDING promise that settles when the current driver answers (or auto-denies
 *      on the S3 timeout). The worker is agnostic to all of that — it awaits one
 *      gate result.
 *   4. ALLOW (`decision.allowed === true`) → `undefined` (proceed). DENY (allowed
 *      false, incl. the auto-deny timeout) → `{ block:true, reason }`. A gate
 *      transport error / malformed result → FAIL-CLOSED `{ block:true }` (the same
 *      conservative posture as the classifier): a control-plane failure must never
 *      silently wave a destructive write through.
 *
 * Substrate-blind + pure-over-the-gate: this module imports NO worker channel, NO
 * Pi runtime, NO orchestrator. The `gate` is an injected function with the EXACT
 * `OrchestratorChannel.callGate` signature, so the unit test drives the REAL S3
 * backend through a real gate closure (no mock) and the worker passes
 * `channel.callGate.bind(channel)`.
 */

import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { AuthorityEvent } from "../event-bus.js";
import type { PermissionDecision } from "./authority-backend.js";
import { isDestructive } from "./destructive.js";
import type { AuthorityBusFrame } from "./http-bridge.js";

/** The capability name + tool the authority gate calls through the worker channel. */
export const AUTHORITY_CAPABILITY = "acp.authority";
export const REQUEST_PERMISSION_TOOL = "request_permission";

/**
 * The `OrchestratorChannel.callGate` shape this gate depends on, narrowed to what
 * it needs. The worker passes `channel.callGate.bind(channel)`; the test passes a
 * real closure over the REAL {@link AuthorityCapabilityBackend}. Both are real
 * code — the gate is an injected seam, not a mock.
 */
export type GateFn = (
	capability: string,
	tool: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
) => Promise<{ result: unknown; isError: boolean }>;

/** Default message surfaced to the model when a driver denies a destructive call. */
export const DEFAULT_DENY_REASON = "Denied by the session driver.";
/** Default message when the authority control-plane itself failed (fail-closed). */
export const DEFAULT_GATE_ERROR_REASON =
	"Permission could not be obtained (authority gate error); blocked to fail closed.";

/**
 * Narrow an unknown gate result into a {@link PermissionDecision}. The gate's
 * `result` is whatever the `acp.authority` backend returned — on the live path a
 * `PermissionDecision`. We read `allowed` defensively: a missing / non-boolean
 * `allowed` is treated as NOT allowed (fail-closed). PURE.
 */
function asDecision(result: unknown): PermissionDecision | undefined {
	if (!result || typeof result !== "object") return undefined;
	const r = result as Record<string, unknown>;
	if (typeof r.allowed !== "boolean") return undefined;
	return r as unknown as PermissionDecision;
}

/**
 * Read the tool name off a Pi `beforeToolCall` context. The `toolCall` content
 * block carries `name` (the requested tool); we also accept a top-level `name`
 * for forward-compatibility. PURE, total — returns "" when absent (which the
 * fail-closed classifier then treats as destructive).
 */
export function toolNameOf(context: Pick<BeforeToolCallContext, "toolCall">): string {
	const tc = context.toolCall as unknown as { name?: unknown };
	return typeof tc?.name === "string" ? tc.name : "";
}

/**
 * Build the `beforeToolCall` hook that gates destructive tool calls behind the
 * session driver's permission, over the injected {@link GateFn}.
 *
 * Returns a handler with Pi's exact `beforeToolCall` signature:
 * `(context, signal?) => Promise<BeforeToolCallResult | undefined>`.
 *  - read-shaped tool → `undefined` (pass through, no gate round-trip)
 *  - destructive tool, ALLOWED → `undefined`
 *  - destructive tool, DENIED / timed-out → `{ block:true, reason }`
 *  - gate transport error / malformed decision → `{ block:true }` (fail-closed)
 *
 * `callId` is derived from the Pi tool-call id when present (so a driver's UI can
 * correlate the ask to the exact call), else a monotonic fallback.
 */
export function createAuthorityBeforeToolCall(
	gate: GateFn,
): (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined> {
	let seq = 0;
	return async (context, signal) => {
		const tool = toolNameOf(context);

		// (2) Read-shaped tools are never gated — no round-trip.
		if (!isDestructive(tool)) return undefined;

		// (3) Destructive: ask the driver via the gate and BLOCK on the answer.
		const tc = context.toolCall as unknown as { id?: unknown };
		const callId = typeof tc?.id === "string" && tc.id.length > 0 ? tc.id : `perm-${seq++}`;
		const args = (context.args ?? {}) as Record<string, unknown>;

		let outcome: { result: unknown; isError: boolean };
		try {
			outcome = await gate(AUTHORITY_CAPABILITY, REQUEST_PERMISSION_TOOL, { tool, args, callId }, signal);
		} catch {
			// Control-plane transport failure → fail closed.
			return { block: true, reason: DEFAULT_GATE_ERROR_REASON };
		}

		if (outcome.isError) {
			return { block: true, reason: DEFAULT_GATE_ERROR_REASON };
		}

		const decision = asDecision(outcome.result);
		if (!decision) {
			// Malformed / missing decision → fail closed.
			return { block: true, reason: DEFAULT_GATE_ERROR_REASON };
		}

		// (4) Allow → proceed; deny (incl. auto-deny timeout) → block.
		if (decision.allowed) return undefined;
		return { block: true, reason: denyReason(decision) };
	};
}

/** The reason text for a denied decision — distinguishes a timeout from an explicit deny. */
function denyReason(decision: PermissionDecision): string {
	if (decision.timedOut) {
		return "Permission request timed out without a driver decision; blocked.";
	}
	return DEFAULT_DENY_REASON;
}

// ─── camelCase (bridge frame) ⇄ snake_case (event-bus) adapter ──────────────
//
// The ACP bridge owns {@link AuthorityBusFrame} (camelCase: `callId` / `driverId`)
// — the payload it hands the live mount to fan out. The transport-agnostic event
// bus owns {@link AuthorityEvent} (snake_case: `call_id` / `driver_id` + the
// `BusEventBase` `sandbox_id` / `ts` envelope). RECONCILED here at the ONE
// boundary they meet: the bridge stays camelCase (TS-idiomatic, matches
// `clientId`/`model.provider`), the bus stays snake_case (matches every other
// `BusEvent` + the SSE wire), and these two total functions bridge them. The
// live mount calls {@link authorityFrameToBusEvent} when fanning a bridge frame
// onto the bus; an SSE/observer reader calls {@link authorityBusEventToFrame} to
// recover the bridge shape.

/**
 * Lift a bridge {@link AuthorityBusFrame} (camelCase) into the bus
 * {@link AuthorityEvent} (snake_case + envelope). The `sandbox_id` / `ts`
 * envelope is supplied by the caller (the live mount, which owns the run's
 * sandbox id + clock) — the bridge frame carries only the authority payload.
 * PURE, total.
 */
export function authorityFrameToBusEvent(
	frame: AuthorityBusFrame,
	envelope: { sandbox_id: string; ts: string },
): AuthorityEvent {
	return {
		sandbox_id: envelope.sandbox_id,
		ts: envelope.ts,
		category: "authority",
		type: "permission",
		call_id: frame.callId,
		...(frame.tool !== undefined ? { tool: frame.tool } : {}),
		driver_id: frame.driverId,
	};
}

/**
 * Project a bus {@link AuthorityEvent} (snake_case) back down to the bridge
 * {@link AuthorityBusFrame} (camelCase, no envelope). Inverse of
 * {@link authorityFrameToBusEvent} on the authority-specific fields (the
 * `sandbox_id` / `ts` envelope is dropped — it is bus-only). PURE, total.
 */
export function authorityBusEventToFrame(event: AuthorityEvent): AuthorityBusFrame {
	return {
		category: "authority",
		type: "permission",
		callId: event.call_id,
		...(event.tool !== undefined ? { tool: event.tool } : {}),
		driverId: event.driver_id,
	};
}
