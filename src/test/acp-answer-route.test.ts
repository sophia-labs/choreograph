/**
 * CA-1 / S8 — the live-mount SHELL for the multi-driver permission gate, no-mock.
 *
 * This exercises the two pieces the live orchestrator mount adds on top of the
 * (already-green) S3 decision core:
 *
 *   A. THE PERMISSION-ANSWER ROUTE — the new `session/answer` ACP method, driven
 *      through the REAL {@link handleAcpRequest} over the REAL
 *      {@link AuthorityCapabilityBackend} + REAL {@link InProcessLwwPresence}. We
 *      assert the driver's allow/deny settles the pending request, the
 *      first-decisive-answer no-op (already-settled ⇒ `settled:false`, NOT a
 *      409), the NON-driver 409 `not_driver` posture (the SAME posture as a
 *      non-driver prompt), and the no-authority 409.
 *
 *   B. THE FAN-OUT HOOK ON THE GATE PATH — the backend's `onRequest` hook the
 *      live mount wires to `ctx.eventBus.emit(authority frame)`. We drive it
 *      EXACTLY as the spawner's `handleGateCall` does (`backend.callTool(
 *      "request_permission", …)`) over a REAL closure that captures the emitted
 *      frame into a real collector — proving the `category:"authority"` BusEvent
 *      is emitted ON the gate path (where the worker triggers it), once per new
 *      callId, carrying the right callId/tool/driver.
 *
 * NO MOCKS, NO live server: a real backend over a real presence, a real gate
 * closure, a real array collector. The `AcpBridgeDeps` for the answer route are
 * the REAL bridge seams a live mount supplies (here only the authority/presence
 * arms are load-bearing; the pipeline arms are unused on `session/answer`).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AuthorityCapabilityBackend, type AuthorityRequestHook } from "../acp/authority-backend.js";
import { InProcessLwwPresence } from "../acp/driver-presence.js";
import {
	type AcpBridgeDeps,
	type AnswerResponse,
	type AuthorityBusFrame,
	handleAcpRequest,
	isNotDriver,
	type NotDriverResponse,
	parseAcpRequest,
} from "../acp/http-bridge.js";

/**
 * Build the REAL bridge seams for an answer-route test. Only `presence` +
 * `authority` are load-bearing on `session/answer`; the pipeline closures throw
 * if touched (they must NOT be on this path — a guard, not a mock).
 */
function answerDeps(presence: InProcessLwwPresence, authority?: AuthorityCapabilityBackend): AcpBridgeDeps {
	const unreached = (name: string) => async () => {
		throw new Error(`session/answer must not touch ${name}`);
	};
	return {
		createSession: unreached("createSession") as AcpBridgeDeps["createSession"],
		loadHead: unreached("loadHead") as AcpBridgeDeps["loadHead"],
		enqueuePrompt: unreached("enqueuePrompt") as AcpBridgeDeps["enqueuePrompt"],
		forkAt: unreached("forkAt") as AcpBridgeDeps["forkAt"],
		abort: unreached("abort") as AcpBridgeDeps["abort"],
		presence,
		authority,
	};
}

/** Poll a predicate until true (real microtask yielding) — for the pending handshake. */
async function waitFor(pred: () => boolean, tries = 100): Promise<void> {
	for (let i = 0; i < tries; i++) {
		if (pred()) return;
		await new Promise((r) => setTimeout(r, 1));
	}
	throw new Error("waitFor: predicate never became true");
}

describe("CA-1/S8 — session/answer permission-answer route (no-mock)", () => {
	it("parses session/answer and rejects malformed", () => {
		const r = parseAcpRequest({ method: "session/answer", sessionId: "s1", callId: "c1", allowed: true });
		assert.equal(r.method, "session/answer");
		assert.throws(() => parseAcpRequest({ method: "session/answer", sessionId: "s1", callId: "c1" }), /allowed/);
		assert.throws(() => parseAcpRequest({ method: "session/answer", sessionId: "s1", allowed: true }), /callId/);
		// allowed must be a real boolean, not truthy
		assert.throws(
			() => parseAcpRequest({ method: "session/answer", sessionId: "s1", callId: "c1", allowed: "yes" }),
			/allowed/,
		);
	});

	it("the DRIVER's allow settles a pending request → { settled:true }; the gated call proceeds", async () => {
		const presence = new InProcessLwwPresence();
		presence.claim("driver-A", 1000);
		const backend = new AuthorityCapabilityBackend(presence, 50_000);
		try {
			// A destructive tool opens a pending permission (the gate path).
			const pending = backend.requestPermission("call-1", "delete_document");
			await waitFor(() => backend.isPending("call-1"));

			const resp = await handleAcpRequest(
				{
					request: parseAcpRequest({ method: "session/answer", sessionId: "s1", callId: "call-1", allowed: true }),
					ownerUserId: "user-A",
					clientId: "driver-A",
				},
				answerDeps(presence, backend),
			);

			assert.equal(isNotDriver(resp), false);
			assert.deepEqual(resp, { sessionId: "s1", callId: "call-1", allowed: true, settled: true });
			// The pending gate decision resolves ALLOW with the deciding driver.
			assert.deepEqual(await pending, { allowed: true, decidedBy: "driver-A" });
		} finally {
			await backend.close();
		}
	});

	it("the DRIVER's deny settles a pending request → { settled:true, allowed:false }", async () => {
		const presence = new InProcessLwwPresence();
		presence.claim("driver-A", 1000);
		const backend = new AuthorityCapabilityBackend(presence, 50_000);
		try {
			const pending = backend.requestPermission("call-deny", "write_document");
			await waitFor(() => backend.isPending("call-deny"));

			const resp = (await handleAcpRequest(
				{
					request: parseAcpRequest({
						method: "session/answer",
						sessionId: "s1",
						callId: "call-deny",
						allowed: false,
					}),
					ownerUserId: "user-A",
					clientId: "driver-A",
				},
				answerDeps(presence, backend),
			)) as AnswerResponse;

			assert.deepEqual(resp, { sessionId: "s1", callId: "call-deny", allowed: false, settled: true });
			assert.deepEqual(await pending, { allowed: false, decidedBy: "driver-A" });
		} finally {
			await backend.close();
		}
	});

	it("a NON-driver answer is REJECTED with the SAME 409 not_driver posture as a non-driver prompt", async () => {
		const presence = new InProcessLwwPresence();
		presence.claim("driver-A", 1000); // A is seated; B is an observer
		const backend = new AuthorityCapabilityBackend(presence, 50_000);
		try {
			const pending = backend.requestPermission("call-x", "sparql_update");
			await waitFor(() => backend.isPending("call-x"));

			const resp = await handleAcpRequest(
				{
					request: parseAcpRequest({ method: "session/answer", sessionId: "s1", callId: "call-x", allowed: true }),
					ownerUserId: "user-A",
					clientId: "observer-B", // NOT the driver
				},
				answerDeps(presence, backend),
			);

			assert.equal(isNotDriver(resp), true);
			assert.deepEqual(resp, { status: 409, error: "not_driver", driver: "driver-A" } satisfies NotDriverResponse);
			// The rejected answer did NOT settle the gate — still pending.
			assert.equal(backend.isPending("call-x"), true);

			// The seated driver then settles it (so the awaiter never hangs).
			assert.equal(backend.answerPermission("call-x", false, "driver-A"), true);
			assert.deepEqual(await pending, { allowed: false, decidedBy: "driver-A" });
		} finally {
			await backend.close();
		}
	});

	it("first-decisive-answer wins: a SECOND driver answer for a settled callId is a no-op → { settled:false } (NOT a 409)", async () => {
		const presence = new InProcessLwwPresence();
		presence.claim("driver-A", 1000);
		const backend = new AuthorityCapabilityBackend(presence, 50_000);
		try {
			const pending = backend.requestPermission("call-once", "delete_document");
			await waitFor(() => backend.isPending("call-once"));

			// First decisive answer settles it.
			const first = (await handleAcpRequest(
				{
					request: parseAcpRequest({
						method: "session/answer",
						sessionId: "s1",
						callId: "call-once",
						allowed: true,
					}),
					ownerUserId: "user-A",
					clientId: "driver-A",
				},
				answerDeps(presence, backend),
			)) as AnswerResponse;
			assert.equal(first.settled, true);
			await pending;

			// A SECOND answer (same driver, same callId) is a well-formed no-op, 200,
			// settled:false — the request is gone. It is NOT a 409 (the driver IS the
			// driver; there is simply nothing left to settle).
			const second = await handleAcpRequest(
				{
					request: parseAcpRequest({
						method: "session/answer",
						sessionId: "s1",
						callId: "call-once",
						allowed: false,
					}),
					ownerUserId: "user-A",
					clientId: "driver-A",
				},
				answerDeps(presence, backend),
			);
			assert.equal(isNotDriver(second), false);
			assert.deepEqual(second, { sessionId: "s1", callId: "call-once", allowed: false, settled: false });
		} finally {
			await backend.close();
		}
	});

	it("an answer with NO authority backend wired returns the 409 not_driver posture (no gate to settle)", async () => {
		const presence = new InProcessLwwPresence();
		// Unclaimed seat → driver is null; the 409 reports the (absent) driver.
		const resp = await handleAcpRequest(
			{
				request: parseAcpRequest({ method: "session/answer", sessionId: "s1", callId: "c", allowed: true }),
				ownerUserId: "user-A",
				clientId: "user-A",
			},
			answerDeps(presence, undefined),
		);
		assert.equal(isNotDriver(resp), true);
		assert.deepEqual(resp, { status: 409, error: "not_driver", driver: null } satisfies NotDriverResponse);
	});
});

describe("CA-1/S8 — fan-out hook fires the category:authority frame ON the gate path (no-mock)", () => {
	/**
	 * The REAL fan-out wiring the live mount installs: an `onRequest` hook that
	 * lifts the request into an {@link AuthorityBusFrame} and pushes it to a real
	 * collector (the live mount pushes to `ctx.eventBus.emit(...)`). This is the
	 * exact closure shape `acpAuthorityFor` builds in the orchestrator.
	 */
	function collectingHook(frames: AuthorityBusFrame[], presence: InProcessLwwPresence): AuthorityRequestHook {
		return (req) => {
			frames.push({
				category: "authority",
				type: "permission",
				callId: req.callId,
				...(req.tool !== undefined ? { tool: req.tool } : {}),
				driverId: req.driverId ?? presence.currentDriver(),
			});
		};
	}

	it("opening a permission via the gate path (callTool) fans out exactly one frame with the right callId/tool/driver", async () => {
		const presence = new InProcessLwwPresence();
		presence.claim("driver-A", 1000);
		const frames: AuthorityBusFrame[] = [];
		const backend = new AuthorityCapabilityBackend(presence, 50_000).setOnRequest(collectingHook(frames, presence));
		try {
			// EXACTLY what spawner.handleGateCall does for acp.authority.request_permission.
			const pending = backend.callTool("request_permission", { callId: "g-1", tool: "write_document" });
			await waitFor(() => backend.isPending("g-1"));

			assert.equal(frames.length, 1, "the gate-path request fanned out exactly one authority frame");
			assert.deepEqual(frames[0], {
				category: "authority",
				type: "permission",
				callId: "g-1",
				tool: "write_document",
				driverId: "driver-A",
			});

			// settle so the awaiter doesn't hang
			backend.answerPermission("g-1", true, "driver-A");
			await pending;
		} finally {
			await backend.close();
		}
	});

	it("a duplicate (idempotent) request for the SAME callId does NOT re-fan-out", async () => {
		const presence = new InProcessLwwPresence();
		presence.claim("driver-A", 1000);
		const frames: AuthorityBusFrame[] = [];
		const backend = new AuthorityCapabilityBackend(presence, 50_000).setOnRequest(collectingHook(frames, presence));
		try {
			const p1 = backend.requestPermission("dup-1", "delete_document");
			await waitFor(() => backend.isPending("dup-1"));
			const p2 = backend.requestPermission("dup-1", "delete_document"); // joins the same promise
			assert.equal(frames.length, 1, "the duplicate request did NOT re-emit a fan-out frame");

			backend.answerPermission("dup-1", false, "driver-A");
			assert.deepEqual(await p1, { allowed: false, decidedBy: "driver-A" });
			assert.deepEqual(await p2, { allowed: false, decidedBy: "driver-A" });
		} finally {
			await backend.close();
		}
	});

	it("an unclaimed seat fans out driverId:null; a read-shaped tool never reaches the gate (no frame)", async () => {
		const presence = new InProcessLwwPresence(); // never claimed
		const frames: AuthorityBusFrame[] = [];
		const backend = new AuthorityCapabilityBackend(presence, 50_000).setOnRequest(collectingHook(frames, presence));
		try {
			const pending = backend.requestPermission("unclaimed-1", "sparql_update");
			await waitFor(() => backend.isPending("unclaimed-1"));
			assert.equal(frames[0].driverId, null, "an unclaimed seat addresses the ask to a null driver");

			backend.close(); // settles pending as auto-deny
			await pending;
		} finally {
			// already closed; safe to call again
			await backend.close();
		}
		// A read tool is gated by the WORKER's beforeToolCall (never reaches the
		// backend) — so no frame is ever produced for a read here by construction.
		assert.equal(frames.length, 1, "only the one destructive request fanned out");
	});

	it("a throwing fan-out hook is swallowed — the gate decision still settles (fan-out is observational)", async () => {
		const presence = new InProcessLwwPresence();
		presence.claim("driver-A", 1000);
		const backend = new AuthorityCapabilityBackend(presence, 50_000).setOnRequest(() => {
			throw new Error("emit blew up");
		});
		try {
			const pending = backend.requestPermission("throw-1", "write_document");
			await waitFor(() => backend.isPending("throw-1"));
			// Despite the hook throwing, the request opened and is answerable.
			assert.equal(backend.answerPermission("throw-1", true, "driver-A"), true);
			assert.deepEqual(await pending, { allowed: true, decidedBy: "driver-A" });
		} finally {
			await backend.close();
		}
	});
});
