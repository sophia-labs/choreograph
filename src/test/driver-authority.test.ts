/**
 * CA-1 / S3 — multi-driver authority CORE, exercised with NO mocks.
 *
 * Every leg drives the REAL pure trait implementation
 * ({@link InProcessLwwPresence}), the REAL {@link authorize} route-helper, the
 * REAL {@link AuthorityCapabilityBackend} (the `acp.authority` CapabilityBackend
 * implementing choreograph's existing {@link CapabilityBackend} interface), the
 * REAL {@link isDestructive} classifier, and a REAL `setTimeout` timer for the
 * permission-timeout leg. No HTTP, no worker, no orchestrator — this is the pure
 * decision core, runnable in isolation on macOS.
 *
 * The only literal values are clientIds, timestamps, and a permission-decision
 * value typed against the REAL `AgentToolResult` from `@earendil-works/pi-agent-core`
 * — that is data, not a mock.
 *
 * Six legs (the slice's acceptance oracle):
 *   1. PRESENCE LWW — larger ts wins; re-claim flips; equal-ts tie → smaller clientId.
 *   2. PROMPT ARBITRATION — only the driver's session/prompt authorizes; exactly one ok.
 *   3. PERMISSION RACE — request_permission pends; driver+observer both answer →
 *      resolves EXACTLY ONCE with the driver's answer, observer 409'd; handoff → other wins.
 *   4. TIMEOUT — a never-answered request auto-denies {allowed:false} after the timeout.
 *   5. N=1 SOLO — a lone client with no explicit claim auto-claims on first authorize;
 *      prompt + permission both succeed, identical to baseline-without-authority.
 *   6. CLASSIFICATION — an unknown tool name → isDestructive === true (default-gate).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { AuthorityCapabilityBackend, NotDriverError, type PermissionDecision } from "../acp/authority-backend.js";
import { isDestructive, NON_DESTRUCTIVE_TOOLS } from "../acp/destructive.js";
import { authorize, InProcessLwwPresence } from "../acp/driver-presence.js";
import type { CapabilityBackend } from "../mnemosyne.js";

describe("CA-1 / S3 — multi-driver authority core (no-mock)", () => {
	// ── (1) PRESENCE LWW ─────────────────────────────────────────────────────
	it("(1) PRESENCE LWW: larger ts wins; re-claim flips; equal-ts tie → smaller clientId", () => {
		const p = new InProcessLwwPresence();
		const tA = 1_700_000_000_000;
		const tB = tA + 1000;

		// A claims at tA, then B claims at tB > tA → B is driver (larger ts wins).
		assert.equal(p.claim("A", tA), true, "A wins the empty seat");
		assert.equal(p.currentDriver(), "A");
		assert.equal(p.claim("B", tB), true, "B (larger ts) supersedes A");
		assert.equal(p.currentDriver(), "B", "currentDriver === B after B's larger-ts claim");

		// A re-claims at tA' > tB → A wins back the seat.
		const tAprime = tB + 1000;
		assert.equal(p.claim("A", tAprime), true, "A re-claims at a later ts");
		assert.equal(p.currentDriver(), "A", "currentDriver === A after A's re-claim at a larger ts");

		// A stale claim (older ts) is a no-op — the incumbent stays.
		assert.equal(p.claim("B", tA), false, "B's stale (older ts) claim loses");
		assert.equal(p.currentDriver(), "A", "stale claim does not flip the driver");

		// Equal-ts tie → lexicographically-smaller clientId wins, regardless of order.
		const p2 = new InProcessLwwPresence();
		const tie = 1_700_000_500_000;
		p2.claim("zeta", tie);
		assert.equal(p2.claim("alpha", tie), true, "alpha (lexicographically smaller) wins the tie");
		assert.equal(p2.currentDriver(), "alpha");

		// Order-insensitive: applying the tie claims in the reverse order converges identically.
		const p3 = new InProcessLwwPresence();
		p3.claim("alpha", tie);
		assert.equal(p3.claim("zeta", tie), false, "zeta cannot displace alpha on a tie");
		assert.equal(p3.currentDriver(), "alpha", "tie converges on the smaller clientId regardless of order");

		// snapshot() is a deep-frozen firewall value: mutating it does not touch the register.
		const snap = p3.snapshot();
		assert.equal(Object.isFrozen(snap), true, "snapshot is frozen");
		assert.equal(snap.claim !== null && Object.isFrozen(snap.claim), true, "snapshot.claim is frozen");
		assert.equal(snap.currentDriver, "alpha");
		assert.throws(
			() => {
				(snap as { currentDriver: string | null }).currentDriver = "tampered";
			},
			TypeError,
			"writing a frozen snapshot field throws (strict mode)",
		);
		assert.equal(p3.currentDriver(), "alpha", "the live register is unaffected by snapshot mutation attempts");
	});

	// ── (2) PROMPT ARBITRATION ────────────────────────────────────────────────
	it("(2) PROMPT ARBITRATION: only the driver's session/prompt authorizes; exactly one ok", () => {
		const p = new InProcessLwwPresence();
		// Driver = A (explicit claim).
		p.claim("A", 1_700_000_000_000);

		const okA = authorize(p, "session/prompt", "A");
		const denyB = authorize(p, "session/prompt", "B");

		assert.deepEqual(okA, { ok: true, op: "session/prompt", driver: "A" }, "driver A's prompt is authorized");
		assert.deepEqual(
			denyB,
			{ ok: false, op: "session/prompt", error: "not_driver", driver: "A" },
			"non-driver B's prompt is denied",
		);

		// Exactly one of the two attempts was ok.
		const oks = [okA, denyB].filter((r) => r.ok);
		assert.equal(oks.length, 1, "exactly one prompt authorization succeeded");
	});

	// ── (3) PERMISSION RACE ───────────────────────────────────────────────────
	it("(3) PERMISSION RACE: pending promise resolves exactly once with the driver's answer; observer 409'd; handoff flips the winner", async () => {
		const p = new InProcessLwwPresence();
		// Driver = A; B is an attached observer.
		p.claim("A", 1_700_000_000_000);
		const backend = new AuthorityCapabilityBackend(p, 50_000);

		try {
			// request_permission returns a PENDING promise.
			const pending = backend.requestPermission("call-1", "write_document");
			assert.equal(backend.isPending("call-1"), true, "request is pending before any answer");

			// The observer B (not the driver) tries to answer → 409, promise still pending.
			assert.throws(
				() => backend.answerPermission("call-1", true, "B"),
				(err: unknown) => err instanceof NotDriverError && (err as NotDriverError).status === 409,
				"non-driver B's answer is rejected with a 409 NotDriverError",
			);
			assert.equal(backend.isPending("call-1"), true, "the observer's rejected answer did not settle the request");

			// The driver A answers (allow) → settles. A second A answer is ignored.
			const settledByA = backend.answerPermission("call-1", true, "A");
			assert.equal(settledByA, true, "A's answer settled the request");
			const lateA = backend.answerPermission("call-1", false, "A");
			assert.equal(lateA, false, "a second answer for the same callId is ignored (first-decisive-answer wins)");

			const decision: PermissionDecision = await pending;
			assert.equal(decision.allowed, true, "the promise resolved with A's allow decision");
			assert.equal(decision.decidedBy, "A", "the decision is attributed to driver A");
			assert.notEqual(decision.timedOut, true, "this was a real answer, not a timeout");
			assert.equal(backend.isPending("call-1"), false, "the request is no longer pending after resolution");

			// HANDOFF: release(A) + claim(B) → B is now the driver, and now B's answer wins.
			assert.equal(p.release("A"), true, "A releases the seat");
			assert.equal(p.claim("B", 1_700_000_900_000), true, "B claims the (now empty) seat");
			assert.equal(p.currentDriver(), "B", "B is the driver after the handoff");

			const pending2 = backend.requestPermission("call-2", "delete_document");
			// Now the FORMER driver A is the non-driver → 409.
			assert.throws(
				() => backend.answerPermission("call-2", true, "A"),
				(err: unknown) => err instanceof NotDriverError,
				"after handoff, former driver A can no longer answer",
			);
			const settledByB = backend.answerPermission("call-2", true, "B");
			assert.equal(settledByB, true, "B (the new driver) now wins the permission");
			const decision2 = await pending2;
			assert.equal(decision2.allowed, true);
			assert.equal(decision2.decidedBy, "B", "the second decision is attributed to the new driver B");
		} finally {
			await backend.close();
		}
	});

	// ── (4) TIMEOUT ───────────────────────────────────────────────────────────
	it("(4) TIMEOUT: a never-answered request auto-denies {allowed:false} after the timeout", async () => {
		const p = new InProcessLwwPresence();
		p.claim("A", 1_700_000_000_000);
		// A small REAL timeout + a real timer.
		const backend = new AuthorityCapabilityBackend(p, 40);

		try {
			const started = Date.now();
			const pending = backend.requestPermission("call-stall", "write_document");
			assert.equal(backend.isPending("call-stall"), true, "the un-answered request starts pending");

			// No one answers — await the auto-deny.
			const decision = await pending;
			const elapsed = Date.now() - started;

			assert.equal(decision.allowed, false, "the timed-out request auto-DENIES");
			assert.equal(decision.timedOut, true, "the decision is flagged as a timeout");
			assert.equal(decision.decidedBy, undefined, "an auto-deny has no deciding driver");
			assert.ok(elapsed >= 35, `the deny waited for the real timer (elapsed=${elapsed}ms, timeout=40ms)`);
			assert.equal(backend.isPending("call-stall"), false, "the request is cleared after the timeout fires");
		} finally {
			await backend.close();
		}
	});

	// ── (5) N=1 SOLO ────────────────────────────────────────────────────────
	it("(5) N=1 SOLO: a lone client with no explicit claim auto-claims; prompt + permission succeed, identical to baseline", async () => {
		const p = new InProcessLwwPresence();
		assert.equal(p.currentDriver(), null, "no client has claimed yet");

		// First authorize with NO prior claim → auto-claims the seat for the lone client.
		const okSolo = authorize(p, "session/prompt", "solo");
		assert.deepEqual(
			okSolo,
			{ ok: true, op: "session/prompt", driver: "solo" },
			"the lone client's first prompt auto-claims and authorizes",
		);
		assert.equal(p.currentDriver(), "solo", "the seat is now held by the auto-claiming client");

		// Permission also succeeds for the lone client — identical to a baseline session
		// that has no explicit authority handshake at all.
		const backend = new AuthorityCapabilityBackend(p, 50_000);
		try {
			const pending = backend.requestPermission("solo-call", "write_document");
			const settled = backend.answerPermission("solo-call", true, "solo");
			assert.equal(settled, true, "the lone client answers its own permission");
			const decision = await pending;
			assert.equal(decision.allowed, true, "the solo permission is granted");
			assert.equal(decision.decidedBy, "solo");

			// Baseline equivalence: a SECOND lone session with a manual single claim
			// reaches the identical authorization, proving auto-claim adds no divergence.
			const baseline = new InProcessLwwPresence();
			baseline.claim("solo", Date.now());
			const okBaseline = authorize(baseline, "session/prompt", "solo");
			assert.deepEqual(okBaseline, okSolo, "auto-claim is value-identical to an explicit single claim");

			// op IS load-bearing: a permission on an UNCLAIMED seat does NOT auto-claim
			// (you cannot answer a permission you were never seated to author).
			const unclaimed = new InProcessLwwPresence();
			const permOnEmpty = authorize(unclaimed, "session/permission", "drive-by");
			assert.equal(permOnEmpty.ok, false, "a permission on an unclaimed seat is denied (no auto-claim)");
			assert.equal(
				unclaimed.currentDriver(),
				null,
				"the seat stays empty — session/permission never elects a driver",
			);
		} finally {
			await backend.close();
		}
	});

	// ── (6) CLASSIFICATION ────────────────────────────────────────────────────
	it("(6) CLASSIFICATION: an unknown tool → isDestructive === true (default-gate)", () => {
		// Unknown / write-shaped tools are gated (fail-closed).
		assert.equal(isDestructive("totally_unknown_tool_42"), true, "an unknown tool name is treated as destructive");
		assert.equal(isDestructive("write_document"), true, "a write-shaped tool is destructive");
		assert.equal(isDestructive("delete_document"), true, "a delete-shaped tool is destructive");
		assert.equal(isDestructive("create_wires"), true, "a create-shaped tool is destructive");
		assert.equal(isDestructive("sparql_update"), true, "an update tool is destructive (not on the read allowlist)");

		// Known read-shaped tools are NOT destructive.
		assert.equal(isDestructive("read_document"), false, "an allowlisted read is not destructive");
		assert.equal(isDestructive("get_workspace"), false, "an allowlisted get is not destructive");
		// Prefix rule: a never-seen read-shaped name is also waved through.
		assert.equal(
			isDestructive("get_brand_new_thing"),
			false,
			"a get_-prefixed tool is non-destructive by convention",
		);
		assert.equal(isDestructive("list_anything"), false, "a list_-prefixed tool is non-destructive by convention");

		// The allowlist is non-empty and contains the canonical reads.
		assert.ok(NON_DESTRUCTIVE_TOOLS.has("read_document"), "read_document is on the allowlist");
		assert.ok(NON_DESTRUCTIVE_TOOLS.size > 5, "the read allowlist is populated");
	});

	// ── (interface) the backend really IS a choreograph CapabilityBackend ─────
	it("(interface) AuthorityCapabilityBackend satisfies the CapabilityBackend contract and lists acp tools", async () => {
		const p = new InProcessLwwPresence();
		// Assigning to the existing interface type is the compile-time contract check;
		// this also exercises listTools/accessLevel/capabilityName at runtime.
		const backend: CapabilityBackend = new AuthorityCapabilityBackend(p);
		try {
			assert.equal(backend.capabilityName, "acp.authority", "registered under the acp.authority name");
			assert.equal(backend.accessLevel, "rw", "authority decisions are a control-state write (rw)");

			const tools = await backend.listTools();
			const names = tools.map((t) => t.name);
			assert.deepEqual([...names].sort(), ["request_permission", "steer"], "exposes request_permission + steer");

			// steer is driver-gated: a non-driver steer is a not_driver error.
			const auth = backend as unknown as AuthorityCapabilityBackend;
			p.claim("A", 1_700_000_000_000);
			const steerA = auth.steer("A", "focus on the panel");
			assert.equal(steerA.ok, true, "the driver may steer");
			const steerB = auth.steer("B", "no, do this instead");
			assert.deepEqual(
				steerB,
				{ ok: false, op: "session/steer", error: "not_driver", driver: "A" },
				"a non-driver steer is rejected",
			);

			// callTool dispatch reaches request_permission via the real CapabilityBackend surface.
			const pendingViaCallTool = auth.callTool("request_permission", { callId: "ct-1", tool: "write_document" });
			assert.equal(auth.isPending("ct-1"), true, "callTool('request_permission') created a pending request");
			auth.answerPermission("ct-1", true, "A");
			const decision = (await pendingViaCallTool) as PermissionDecision;
			assert.equal(decision.allowed, true, "the callTool-routed request resolved via the driver's answer");

			// A real Pi AgentToolResult value can carry the decision back to the model —
			// this exercises the REAL pi-agent-core type (data, not a mock).
			const piResult: AgentToolResult<PermissionDecision> = {
				content: [{ type: "text", text: decision.allowed ? "permission granted" : "permission denied" }],
				details: decision,
			};
			assert.equal(piResult.details.allowed, true, "the decision rides back inside a real AgentToolResult");
			assert.equal(piResult.content[0].type, "text");
		} finally {
			await backend.close();
		}
	});
});
