/**
 * AuthorityCapabilityBackend — the `acp.authority` CapabilityBackend.
 *
 * CA-1 / S3 — the multi-driver authority gate as a first-class capability.
 *
 * This implements the EXISTING choreograph {@link CapabilityBackend} interface
 * (../mnemosyne.ts ~:23 — `capabilityName` / `accessLevel` / `callTool` /
 * `listTools` / `close`) exactly the way {@link wrapMnemosyneProxy} (~:43) and
 * {@link BrowserCapabilityBackend} (../browser-capability.ts ~:168) do. It is
 * registered under the name `acp.authority` the same way the spawner binds
 * per-node capabilities (../spawner.ts ~:545,569). No special-casing: the gate
 * looks up `acp.authority` in the registry and dispatches `callTool`.
 *
 * It exposes three tools:
 *
 *  • `request_permission(callId, tool?, …)` — returns a PENDING Promise. The
 *    promise resolves to a {@link PermissionDecision} when, and only when, the
 *    current DRIVER answers it via {@link answerPermission}. FIRST-DECISIVE-ANSWER
 *    wins: the first valid driver answer settles the promise; any later answer
 *    (or a concurrent non-driver answer) is ignored. A non-driver's answer is
 *    REJECTED with a 409-shaped error and never settles the promise.
 *
 *  • `steer(text)` — a driver-only side-channel nudge to the running agent. Like
 *    prompt, it is gated through {@link DriverPresence}: a non-driver `steer` is
 *    a `not_driver` error.
 *
 *  • PERMISSION TIMEOUT — a request that is never answered auto-DENIES after
 *    {@link DEFAULT_PERMISSION_TIMEOUT_MS}, resolving `{ allowed:false }`. This
 *    closes the "a driver walks away mid-request and the agent stalls forever"
 *    failure (an explicit must-fix from the verification pass). The timer is a
 *    real, referenced `setTimeout`: an awaited auto-deny remains a completion
 *    guarantee even when no unrelated event-loop handles exist. `close()` and
 *    every real answer clear it immediately during normal shutdown/settlement.
 *
 * Substrate-blind: imports NO CRDT (yrs / Loro / yjs). Authority lives entirely
 * in the in-process {@link DriverPresence} register + a Map of pending requests.
 * Wiring the live `beforeToolCall → callGate → block` path through a REAL worker
 * is S8 (deferred to the VM) — this backend is the pure decision core only.
 */

import type { CapabilityBackend, HostedMcpToolDescriptor } from "../mnemosyne.js";
import { isDestructive } from "./destructive.js";
import { type AuthorizedOp, authorize, type DriverPresence } from "./driver-presence.js";

/** Default auto-deny timeout for an un-answered permission request (ms). */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 30_000;

/** A driver's decision on a permission request. */
export interface PermissionDecision {
	readonly allowed: boolean;
	/** clientId of the driver who decided, or undefined when auto-denied on timeout. */
	readonly decidedBy?: string;
	/** True iff this decision was produced by the timeout (auto-deny). */
	readonly timedOut?: boolean;
}

/**
 * A side-effect hook fired the instant a NEW permission request opens (S8 live
 * fan-out). The live mount wires this to `ctx.eventBus.emit(authority frame)` so
 * every session subscriber (the OTHER drivers + observers) sees the pending ask
 * and can answer it. It receives the request's `callId` + the requested `tool`
 * and the driver the ask is addressed to (the current driver, or null if
 * unclaimed). It is fired ONLY on the FIRST open of a `callId` (a duplicate /
 * idempotent re-request does not re-fan-out), and a throwing hook is swallowed
 * (the fan-out is observational — it must never break the gate decision path).
 * Absent ⇒ the backend behaves exactly as before (the pure decision core).
 */
export type AuthorityRequestHook = (req: { callId: string; tool?: string; driverId: string | null }) => void;

/** A non-driver answer attempt — rejected, 409-shaped, never settles the promise. */
export class NotDriverError extends Error {
	readonly status = 409;
	readonly code = "not_driver";
	constructor(public readonly clientId: string) {
		super(`acp.authority: client "${clientId}" is not the driver; permission answer rejected`);
		this.name = "NotDriverError";
	}
}

interface PendingRequest {
	readonly callId: string;
	readonly tool?: string;
	resolve: (decision: PermissionDecision) => void;
	settled: boolean;
	timer: ReturnType<typeof setTimeout>;
}

const ACP_TOOLS: readonly HostedMcpToolDescriptor[] = [
	{
		name: "request_permission",
		destructive: true,
		description:
			"Request a driver's permission for a (potentially destructive) tool call. Returns a pending promise that resolves once the current driver answers, or auto-denies after the permission timeout.",
		inputSchema: {
			type: "object",
			properties: {
				callId: { type: "string", description: "Unique id for this permission request." },
				tool: {
					type: "string",
					description: "The tool the agent wants to call (used for destructive-classification).",
				},
			},
			required: ["callId"],
		},
	},
	{
		name: "steer",
		destructive: true,
		description: "Driver-only side-channel nudge to the running agent. Rejected if the requester is not the driver.",
		inputSchema: {
			type: "object",
			properties: {
				clientId: { type: "string", description: "The requesting client's id (must be the current driver)." },
				text: { type: "string", description: "The steering text." },
			},
			required: ["clientId", "text"],
		},
	},
];

/**
 * The `acp.authority` CapabilityBackend.
 *
 * Owns the in-process {@link DriverPresence} register and the map of pending
 * permission requests. Construct it with a presence register (shared with the
 * session's prompt-arbitration route) and an optional timeout override.
 */
export class AuthorityCapabilityBackend implements CapabilityBackend {
	readonly capabilityName = "acp.authority";
	// Authority decisions are a write to session control-state — "rw".
	readonly accessLevel: "ro" | "rw" = "rw";

	private readonly presence: DriverPresence;
	private readonly timeoutMs: number;
	private readonly pending = new Map<string, PendingRequest>();
	private closed = false;
	/** Live fan-out hook (S8) — fired once per new request open; see {@link AuthorityRequestHook}. */
	private onRequest?: AuthorityRequestHook;

	constructor(presence: DriverPresence, timeoutMs: number = DEFAULT_PERMISSION_TIMEOUT_MS) {
		this.presence = presence;
		this.timeoutMs = timeoutMs;
	}

	/**
	 * Install (or replace) the live fan-out hook fired when a NEW permission
	 * request opens — the S8 seam the live mount uses to emit the
	 * `category:"authority"` BusEvent. Returns `this` for fluent construction.
	 * The pure decision core (tests, the bridge unit) leaves this unset.
	 */
	setOnRequest(hook: AuthorityRequestHook | undefined): this {
		this.onRequest = hook;
		return this;
	}

	// ── CapabilityBackend surface ──────────────────────────────────────────

	async callTool(tool: string, args: Record<string, unknown>, _signal?: AbortSignal): Promise<unknown> {
		switch (tool) {
			case "request_permission": {
				const callId = String(args.callId ?? "");
				if (!callId) throw new Error("acp.authority.request_permission: callId is required");
				const toolName = typeof args.tool === "string" ? args.tool : undefined;
				return this.requestPermission(callId, toolName);
			}
			case "steer": {
				const clientId = String(args.clientId ?? "");
				const text = typeof args.text === "string" ? args.text : "";
				return this.steer(clientId, text);
			}
			default:
				throw new Error(`acp.authority: unknown tool "${tool}"`);
		}
	}

	async listTools(): Promise<readonly HostedMcpToolDescriptor[]> {
		return ACP_TOOLS;
	}

	async close(): Promise<void> {
		this.closed = true;
		// Settle every still-pending request as an auto-deny so no awaiter hangs,
		// and clear every timer so nothing keeps the process alive.
		for (const req of this.pending.values()) {
			clearTimeout(req.timer);
			if (!req.settled) {
				req.settled = true;
				req.resolve({ allowed: false, timedOut: false });
			}
		}
		this.pending.clear();
	}

	// ── Authority surface ──────────────────────────────────────────────────

	/**
	 * Request a driver's permission for a tool call. Returns a PENDING promise
	 * that resolves when {@link answerPermission} is called by the current driver,
	 * OR auto-denies (`{ allowed:false, timedOut:true }`) after the timeout.
	 *
	 * If `tool` is given and classifies as NON-destructive, the request still goes
	 * through the gate (the classification is advisory metadata here — the gate
	 * decides whether to even ask); callers who want to skip asking for reads
	 * consult {@link isDestructive} before calling this. We surface the classified
	 * flag on the pending record for observability.
	 */
	requestPermission(callId: string, tool?: string): Promise<PermissionDecision> {
		if (this.closed) {
			return Promise.resolve({ allowed: false });
		}
		const existing = this.pending.get(callId);
		if (existing) {
			// Idempotent: a duplicate request for the same callId joins the same promise.
			return new Promise<PermissionDecision>((resolve) => {
				const prior = existing.resolve;
				existing.resolve = (d) => {
					prior(d);
					resolve(d);
				};
			});
		}

		const decision = new Promise<PermissionDecision>((resolve) => {
			const timer = setTimeout(() => {
				const req = this.pending.get(callId);
				if (req && !req.settled) {
					req.settled = true;
					this.pending.delete(callId);
					req.resolve({ allowed: false, timedOut: true });
				}
			}, this.timeoutMs);
			this.pending.set(callId, {
				callId,
				tool,
				resolve,
				settled: false,
				timer,
			});
		});

		// Live fan-out (S8): emit the pending ask to the session's subscribers AFTER
		// the pending record is registered (so a driver answering in direct response
		// to the fan-out finds a pending request). Fired only on this FIRST open of
		// the callId; observational — a throwing hook must never break the gate.
		if (this.onRequest) {
			try {
				this.onRequest({ callId, tool, driverId: this.presence.currentDriver() });
			} catch (err) {
				console.error(
					`[acp.authority] onRequest fan-out hook threw for callId "${callId}": ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		return decision;
	}

	/**
	 * Answer a pending permission request AS `clientId`.
	 *
	 * Gating: `clientId` MUST be the current driver — a non-driver answer throws
	 * {@link NotDriverError} (409) and does NOT settle the promise.
	 *
	 * First-decisive-answer wins: the first valid driver answer settles the
	 * promise and removes the pending record; a later answer for the same callId
	 * (the request is already gone) returns `false` (ignored). Returns true iff
	 * THIS call settled the request.
	 */
	answerPermission(callId: string, allowed: boolean, clientId: string): boolean {
		// Authority check: only the current driver may answer.
		if (this.presence.currentDriver() !== clientId) {
			throw new NotDriverError(clientId);
		}
		const req = this.pending.get(callId);
		if (!req || req.settled) {
			// Already settled (timeout or a prior decisive answer) → ignored.
			return false;
		}
		req.settled = true;
		clearTimeout(req.timer);
		this.pending.delete(callId);
		req.resolve({ allowed, decidedBy: clientId });
		return true;
	}

	/**
	 * Driver-only steer. Authorizes `session/steer` for `clientId` through the
	 * presence register; a non-driver gets `{ ok:false, error:"not_driver" }`.
	 */
	steer(clientId: string, text: string): ReturnType<typeof authorize> & { text?: string } {
		const result = authorize(this.presence, "session/steer" as AuthorizedOp, clientId);
		if (result.ok) {
			return { ...result, text };
		}
		return result;
	}

	/** True iff a permission request for `callId` is still pending (test/observability). */
	isPending(callId: string): boolean {
		const req = this.pending.get(callId);
		return req !== undefined && !req.settled;
	}

	/** Re-export the classifier so a gate can decide whether to ask at all. */
	classifyDestructive(tool: string): boolean {
		return isDestructive(tool);
	}
}
