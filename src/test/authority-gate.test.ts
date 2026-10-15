/**
 * CA-1 / B-keystone — the worker-side multi-driver permission GATE, no-mock.
 *
 * This exercises the REAL {@link createAuthorityBeforeToolCall} handler closure
 * over the REAL S3 decision core — the REAL {@link AuthorityCapabilityBackend}
 * (`acp.authority`), the REAL {@link InProcessLwwPresence} driver register, the
 * REAL {@link isDestructive} classifier, and a REAL `setTimeout` timer for the
 * timeout leg. The ONLY injected seam is the gate function — and it is a real
 * closure that does EXACTLY what the spawner's `handleGateCall` does
 * (`backend.callTool(tool, args) → { result, isError:false }`), so there is no
 * mock anywhere: a real handler over a real backend over a real presence register.
 *
 * We do NOT spin a live Pi/worker/orchestrator (that is the live runbook). The
 * `BeforeToolCallContext` values are plain literal tool-call blocks — data typed
 * against the REAL pi-agent-core surface, not mocks.
 *
 * Legs (the keystone's acceptance oracle):
 *   1. DESTRUCTIVE + NEVER-ANSWERED → blocks, then the S3 timeout fires → {block:true}.
 *   2. DESTRUCTIVE + DRIVER ALLOWS → undefined (passes through).
 *   3. DESTRUCTIVE + DRIVER DENIES → {block:true} with a deny reason.
 *   4. READ tool → never gated (undefined, and NO gate round-trip happens).
 *   5. FIRST-DECISIVE-ANSWER WINS — observer 409'd, driver settles once; allow holds.
 *   6. NON-DRIVER ANSWER 409 — a non-driver answering throws NotDriverError (S3).
 *   7. GATE TRANSPORT ERROR → fail-closed {block:true}.
 *   8. camelCase(bridge AuthorityBusFrame) ⇄ snake_case(event-bus AuthorityEvent)
 *      adapter round-trips (the reconciled boundary).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { AuthorityCapabilityBackend, NotDriverError, type PermissionDecision } from "../acp/authority-backend.js";
import {
	authorityBusEventToFrame,
	authorityFrameToBusEvent,
	createAuthorityBeforeToolCall,
	DEFAULT_DENY_REASON,
	DEFAULT_GATE_ERROR_REASON,
	type GateFn,
} from "../acp/authority-gate.js";
import { InProcessLwwPresence } from "../acp/driver-presence.js";
import type { AuthorityBusFrame } from "../acp/http-bridge.js";
import type { AuthorityEvent } from "../event-bus.js";

// ─── real-gate helpers (NO mocks) ───────────────────────────────────────────

/**
 * The REAL gate closure — does EXACTLY what the spawner's `handleGateCall` does:
 * `await backend.callTool(msg.tool, msg.args)` → `{ result, isError:false }`.
 * Driving the handler through this is real wiring, not a mock. We also record
 * every gate invocation so a leg can assert a read was NEVER gated.
 */
function realGateOverBackend(backend: AuthorityCapabilityBackend, log: string[]): GateFn {
	return async (capability, tool, args) => {
		log.push(`${capability}.${tool}`);
		const result = await backend.callTool(tool, args);
		return { result, isError: false };
	};
}

/** A plain literal Pi `beforeToolCall` context for `tool` — data, not a mock. */
function ctxFor(tool: string, id: string, args: Record<string, unknown> = {}): BeforeToolCallContext {
	return {
		assistantMessage: { role: "assistant" } as BeforeToolCallContext["assistantMessage"],
		toolCall: { type: "toolCall", id, name: tool, arguments: args } as BeforeToolCallContext["toolCall"],
		args,
		context: {} as BeforeToolCallContext["context"],
	};
}

describe("CA-1 / B-keystone — worker destructive-tool permission gate (no-mock)", () => {
	// ── (1) DESTRUCTIVE + NEVER ANSWERED → block on real S3 timeout ───────────
	it("(1) a destructive tool with a never-answering driver blocks until the real timeout → {block:true}", async () => {
		const presence = new InProcessLwwPresence();
		presence.claim("driverA", 1_700_000_000_000);
		const backend = new AuthorityCapabilityBackend(presence, 40); // real 40ms timer
		const log: string[] = [];
		const before = createAuthorityBeforeToolCall(realGateOverBackend(backend, log));

		try {
			const started = Date.now();
			// No one answers — the handler awaits the gate, which awaits the S3 auto-deny.
			const result = await before(ctxFor("write_document", "call-1"));
			const elapsed = Date.now() - started;

			assert.deepEqual(result, {
				block: true,
				reason: "Permission request timed out without a driver decision; blocked.",
			});
			assert.ok(elapsed >= 35, `the block waited for the real S3 timer (elapsed=${elapsed}ms)`);
			assert.deepEqual(
				log,
				["acp.authority.request_permission"],
				"the destructive tool went through the gate exactly once",
			);
		} finally {
			await backend.close();
		}
	});

	// ── (2) DESTRUCTIVE + DRIVER ALLOWS → undefined (proceed) ─────────────────
	it("(2) a destructive tool the driver ALLOWS passes through → undefined", async () => {
		const presence = new InProcessLwwPresence();
		presence.claim("driverA", 1_700_000_000_000);
		const backend = new AuthorityCapabilityBackend(presence, 50_000);
		const log: string[] = [];
		const before = createAuthorityBeforeToolCall(realGateOverBackend(backend, log));

		try {
			// Start the gated call; once it is pending, the driver allows it.
			const pending = before(ctxFor("delete_document", "call-allow", { id: "doc-9" }));
			// Let the gate register the pending request, then answer as the driver.
			await waitFor(() => backend.isPending("call-allow"));
			const settled = backend.answerPermission("call-allow", true, "driverA");
			assert.equal(settled, true, "the driver's allow settled the request");

			const result = await pending;
			assert.equal(result, undefined, "an allowed destructive call proceeds (no block)");
			assert.deepEqual(log, ["acp.authority.request_permission"]);
		} finally {
			await backend.close();
		}
	});

	// ── (3) DESTRUCTIVE + DRIVER DENIES → {block:true} ────────────────────────
	it("(3) a destructive tool the driver DENIES is blocked → {block:true, reason}", async () => {
		const presence = new InProcessLwwPresence();
		presence.claim("driverA", 1_700_000_000_000);
		const backend = new AuthorityCapabilityBackend(presence, 50_000);
		const before = createAuthorityBeforeToolCall(realGateOverBackend(backend, []));

		try {
			const pending = before(ctxFor("sparql_update", "call-deny"));
			await waitFor(() => backend.isPending("call-deny"));
			backend.answerPermission("call-deny", false, "driverA");

			const result = await pending;
			assert.deepEqual(result, { block: true, reason: DEFAULT_DENY_REASON });
		} finally {
			await backend.close();
		}
	});

	// ── (4) READ tool → never gated ───────────────────────────────────────────
	it("(4) a read-shaped tool is NEVER gated → undefined, with no gate round-trip", async () => {
		const presence = new InProcessLwwPresence();
		presence.claim("driverA", 1_700_000_000_000);
		const backend = new AuthorityCapabilityBackend(presence, 50_000);
		const log: string[] = [];
		const before = createAuthorityBeforeToolCall(realGateOverBackend(backend, log));

		try {
			const readAllow = await before(ctxFor("read_document", "r-1"));
			const getAllow = await before(ctxFor("get_workspace", "r-2"));
			const prefixAllow = await before(ctxFor("list_anything_new", "r-3"));

			assert.equal(readAllow, undefined, "read_document is not gated");
			assert.equal(getAllow, undefined, "get_workspace is not gated");
			assert.equal(prefixAllow, undefined, "a list_-prefixed read is not gated");
			assert.deepEqual(log, [], "NO read went through the authority gate (zero round-trips)");
		} finally {
			await backend.close();
		}
	});

	// ── (5) FIRST-DECISIVE-ANSWER WINS (race) ─────────────────────────────────
	it("(5) first-decisive-answer wins: observer 409'd, driver settles once, allow holds → undefined", async () => {
		const presence = new InProcessLwwPresence();
		presence.claim("driverA", 1_700_000_000_000); // driverA seated; observerB attached
		const backend = new AuthorityCapabilityBackend(presence, 50_000);
		const before = createAuthorityBeforeToolCall(realGateOverBackend(backend, []));

		try {
			const pending = before(ctxFor("create_wires", "race-1"));
			await waitFor(() => backend.isPending("race-1"));

			// Observer (non-driver) tries to answer first → 409, does NOT settle.
			assert.throws(
				() => backend.answerPermission("race-1", false, "observerB"),
				(e: unknown) => e instanceof NotDriverError && (e as NotDriverError).status === 409,
				"the observer's answer is rejected 409 and never settles the gate",
			);
			assert.equal(backend.isPending("race-1"), true, "still pending after the observer's rejected answer");

			// Driver answers allow → settles. A later answer is ignored (first wins).
			assert.equal(backend.answerPermission("race-1", true, "driverA"), true);
			assert.equal(backend.answerPermission("race-1", false, "driverA"), false, "second answer ignored");

			const result = await pending;
			assert.equal(result, undefined, "the driver's decisive ALLOW wins → the call proceeds");
		} finally {
			await backend.close();
		}
	});

	// ── (6) NON-DRIVER ANSWER 409 (handoff) ───────────────────────────────────
	it("(6) after a driver handoff, the former driver answering is 409'd; the new driver's deny wins → {block:true}", async () => {
		const presence = new InProcessLwwPresence();
		presence.claim("driverA", 1_700_000_000_000);
		const backend = new AuthorityCapabilityBackend(presence, 50_000);
		const before = createAuthorityBeforeToolCall(realGateOverBackend(backend, []));

		try {
			// Handoff: A releases, B claims → B is the driver.
			assert.equal(presence.release("driverA"), true);
			assert.equal(presence.claim("driverB", 1_700_000_900_000), true);
			assert.equal(presence.currentDriver(), "driverB");

			const pending = before(ctxFor("delete_document", "handoff-1"));
			await waitFor(() => backend.isPending("handoff-1"));

			// The FORMER driver A is now a non-driver → 409.
			assert.throws(
				() => backend.answerPermission("handoff-1", true, "driverA"),
				(e: unknown) => e instanceof NotDriverError,
				"after handoff the former driver can no longer answer",
			);
			// The NEW driver B denies → blocks.
			backend.answerPermission("handoff-1", false, "driverB");
			const result = await pending;
			assert.deepEqual(result, { block: true, reason: DEFAULT_DENY_REASON });
		} finally {
			await backend.close();
		}
	});

	// ── (7) GATE TRANSPORT ERROR → fail-closed ────────────────────────────────
	it("(7) a gate transport error fails CLOSED → {block:true} (a control-plane failure never waves a write through)", async () => {
		// A real gate function that REJECTS — the worker channel could not reach the
		// authority backend. Fail-closed is the must-have safety property.
		const throwingGate: GateFn = async () => {
			throw new Error("gate channel closed");
		};
		const before = createAuthorityBeforeToolCall(throwingGate);
		const result = await before(ctxFor("write_document", "err-1"));
		assert.deepEqual(result, { block: true, reason: DEFAULT_GATE_ERROR_REASON });

		// And an isError:true gate RESULT (e.g. "no backend registered") also blocks.
		const isErrorGate: GateFn = async () => ({ result: "No capability backend registered.", isError: true });
		const before2 = createAuthorityBeforeToolCall(isErrorGate);
		const result2 = await before2(ctxFor("write_document", "err-2"));
		assert.deepEqual(result2, { block: true, reason: DEFAULT_GATE_ERROR_REASON });

		// A malformed decision (no boolean `allowed`) also fails closed.
		const malformedGate: GateFn = async () => ({ result: { whatever: 1 }, isError: false });
		const before3 = createAuthorityBeforeToolCall(malformedGate);
		const result3 = await before3(ctxFor("write_document", "err-3"));
		assert.deepEqual(result3, { block: true, reason: DEFAULT_GATE_ERROR_REASON });
	});

	// ── (8) camelCase ⇄ snake_case adapter round-trip ─────────────────────────
	it("(8) the AuthorityBusFrame(camelCase) ⇄ AuthorityEvent(snake_case) adapter round-trips", () => {
		const frame: AuthorityBusFrame = {
			category: "authority",
			type: "permission",
			callId: "perm-42",
			tool: "write_document",
			driverId: "driverA",
		};
		const envelope = { sandbox_id: "sbx-abc", ts: "2026-06-22T00:00:00.000Z" };

		const event: AuthorityEvent = authorityFrameToBusEvent(frame, envelope);
		// snake_case + envelope on the bus side
		assert.deepEqual(event, {
			sandbox_id: "sbx-abc",
			ts: "2026-06-22T00:00:00.000Z",
			category: "authority",
			type: "permission",
			call_id: "perm-42",
			tool: "write_document",
			driver_id: "driverA",
		});

		// project back to the bridge camelCase frame (envelope dropped — bus-only)
		const back = authorityBusEventToFrame(event);
		assert.deepEqual(back, frame, "frame → bus event → frame is the identity on authority fields");

		// the unclaimed (null driver, no tool) shape round-trips too
		const bare: AuthorityBusFrame = { category: "authority", type: "permission", callId: "p2", driverId: null };
		const bareEvent = authorityFrameToBusEvent(bare, envelope);
		assert.equal(bareEvent.driver_id, null);
		assert.equal("tool" in bareEvent, false, "an absent tool is not added as undefined");
		assert.deepEqual(authorityBusEventToFrame(bareEvent), bare);
	});
});

/** Poll a predicate until true (real microtask yielding) — for the pending-request handshake. */
async function waitFor(pred: () => boolean, tries = 100): Promise<void> {
	for (let i = 0; i < tries; i++) {
		if (pred()) return;
		await new Promise((r) => setTimeout(r, 1));
	}
	throw new Error("waitFor: predicate never became true");
}

// Touch the type so an unused-import lint never strips the PermissionDecision import,
// which documents the gate's result contract.
const _decisionContract: PermissionDecision = { allowed: true };
void _decisionContract;
