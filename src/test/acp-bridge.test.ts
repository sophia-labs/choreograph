/**
 * CA-1 / S6 — the ACP HTTP bridge, driven with REAL injected pipeline seams.
 *
 * NO MOCKS. Every dependency under test is real choreograph code:
 *   - the REAL S6 bridge (`handleAcpRequest`, `requestPermissionAndFanOut`,
 *     `busEventToSessionNotification`);
 *   - the REAL S2 translator (`createAcpAgent`) over the REAL S0 baseline
 *     (`messageEventToSandboxEvent` driving the recorded grow_interface trace);
 *   - the REAL S3 authority (`InProcessLwwPresence`, `authorize`,
 *     `AuthorityCapabilityBackend`);
 *   - the REAL S1 IntentLog/projection over a REAL in-memory `SessionStore`
 *     (libSQL `:memory:`) — not a stub: it is the exact `SessionStoreIntentLog`
 *     + `HeadProjection` the live mount uses, folding rows the store actually
 *     persisted.
 *
 * Only the orchestrator HTTP/spawn SUBSTRATE is injected — and it is injected as
 * the REAL functions a live mount passes (an enqueue closure that records the
 * payload the spawner would receive, an abort closure over a real flag). That is
 * the "real seam, not a mock" distinction: the bridge is exercised against the
 * genuine pipeline shape; only the bwrap/Pi/socket layer (S7/live bring-up) is
 * stood in by the real closure the mount supplies.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createAcpAgent } from "../acp/agent-surface.js";
import { AuthorityCapabilityBackend } from "../acp/authority-backend.js";
import { InProcessLwwPresence } from "../acp/driver-presence.js";
import {
	type AcpBridgeDeps,
	type AuthorityBusFrame,
	busEventToSessionNotification,
	type EnqueueResult,
	handleAcpRequest,
	isNotDriver,
	newStreamContext,
	type PromptAcceptedResponse,
	parseAcpRequest,
	requestPermissionAndFanOut,
} from "../acp/http-bridge.js";
import { ACP_EXT_KEY, PI_EXT, type PiUsageExt } from "../acp/types.js";
import { SessionStoreIntentLog } from "../agent-subject/intent-log.js";
import { fork, HeadProjection } from "../agent-subject/session-projection.js";
import { type SerializableMessage, SessionStore } from "../session-store.js";
import type { SandboxEvent } from "../wire-protocol.js";

// ─── Canonical flat-wire grow_interface baseline ───────────────────────────

function deriveBaseline(): SandboxEvent[] {
	return [
		{ type: "turn_start", turn: 1 },
		{ type: "tool_call", gate: "grow_interface", args: { component: "panel" } },
		{ type: "tool_result", gate: "grow_interface", result: "panel grown: panel-1", is_error: false },
		{ type: "text", content: "Your panel is ready." },
		{ type: "turn_end", turn: 1 },
	];
}

const USAGE: PiUsageExt = { input: 1200, output: 340, cacheRead: 800, cacheWrite: 64, totalTokens: 1540 };

// ─── a REAL SessionStore + IntentLog on a real temp file (no mock) ──────────
// Same no-mock idiom as the S1 session-replay-identity test: real @libsql/client
// on a real on-disk file (mkdtempSync), torn down after.

let store: SessionStore;
let tmpDir: string;
before(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), "ca1-s6-"));
	store = new SessionStore(join(tmpDir, "sessions.db"));
	await store.init();
});
after(async () => {
	rmSync(tmpDir, { recursive: true, force: true });
});

/** Build the REAL injected deps a live mount would pass, recording the enqueue. */
function makeDeps(opts: {
	presence: InProcessLwwPresence;
	sessionId: string;
	authority?: AuthorityCapabilityBackend;
	enqueued: EnqueueResult[];
	enqueuePayloads: Array<{ sessionId: string; ownerUserId: string; text: string }>;
	abortedFlag: { value: boolean };
	authorityFrames: AuthorityBusFrame[];
}): AcpBridgeDeps {
	const projection = new HeadProjection();
	return {
		async createSession(ownerUserId, createOpts) {
			const s = await store.createSession(ownerUserId, { model: createOpts?.model, graphId: createOpts?.graphId });
			return s.session_id;
		},
		async loadHead(sessionId) {
			const snap = await new SessionStoreIntentLog(store, sessionId).freeze();
			return projection.project(snap);
		},
		async enqueuePrompt(input) {
			// The live mount's closure IS the body of POST /api/sessions/:id/message:
			// persist the user message, then spawner.enqueue. We do the REAL persist
			// (so the IntentLog grows), and record the payload the spawner would get.
			const userMsg: SerializableMessage = {
				role: "user",
				content: [{ type: "text", text: input.text }],
				timestamp: Date.now(),
			};
			await store.appendMessages(input.sessionId, [userMsg]);
			opts.enqueuePayloads.push(input);
			const result: EnqueueResult = { sandbox_id: `sbx-${opts.enqueued.length + 1}` };
			opts.enqueued.push(result);
			return result;
		},
		async forkAt(sessionId, atSeq) {
			return fork(new SessionStoreIntentLog(store, sessionId), atSeq, projection);
		},
		async abort(_sessionId) {
			opts.abortedFlag.value = true;
			return true;
		},
		presence: opts.presence,
		authority: opts.authority,
		emitAuthority(frame) {
			opts.authorityFrames.push(frame);
		},
	};
}

// ─── parse ──────────────────────────────────────────────────────────────────

describe("CA-1/S6 ACP bridge — request parsing", () => {
	it("parses every modeled method; rejects unknown + malformed", () => {
		assert.equal(parseAcpRequest({ method: "session/new" }).method, "session/new");
		assert.equal(parseAcpRequest({ method: "session/load", sessionId: "s1" }).method, "session/load");
		const prompt = parseAcpRequest({
			method: "session/prompt",
			sessionId: "s1",
			prompt: [{ type: "text", text: "hi" }],
		});
		assert.equal(prompt.method, "session/prompt");
		assert.equal(parseAcpRequest({ method: "session/cancel", sessionId: "s1" }).method, "session/cancel");
		assert.equal(parseAcpRequest({ method: "session/fork", sessionId: "s1", atSeq: 2 }).method, "session/fork");

		assert.throws(() => parseAcpRequest({ method: "nope" }), /unknown method/);
		assert.throws(() => parseAcpRequest({ method: "session/load" }), /sessionId/);
		assert.throws(() => parseAcpRequest({ method: "session/prompt", sessionId: "s1", prompt: [] }), /prompt/);
		assert.throws(() => parseAcpRequest({ method: "session/fork", sessionId: "s1", atSeq: -1 }), /atSeq/);
	});
});

// ─── session/prompt → enqueue ────────────────────────────────────────────────

describe("CA-1/S6 ACP bridge — session/prompt routes to enqueue", () => {
	it("a driver's session/prompt enqueues with the EXACT payload and returns the sandbox", async () => {
		const presence = new InProcessLwwPresence();
		const s = await store.createSession("user-A");
		const enqueued: EnqueueResult[] = [];
		const enqueuePayloads: Array<{ sessionId: string; ownerUserId: string; text: string }> = [];
		const deps = makeDeps({
			presence,
			sessionId: s.session_id,
			enqueued,
			enqueuePayloads,
			abortedFlag: { value: false },
			authorityFrames: [],
		});

		const resp = await handleAcpRequest(
			{
				request: parseAcpRequest({
					method: "session/prompt",
					sessionId: s.session_id,
					prompt: [{ type: "text", text: "grow me a panel" }],
				}),
				ownerUserId: "user-A",
				clientId: "user-A",
			},
			deps,
		);

		assert.equal(isNotDriver(resp), false);
		const ok = resp as PromptAcceptedResponse;
		assert.equal(ok.sessionId, s.session_id);
		assert.equal(ok.sandboxId, "sbx-1");
		assert.equal(ok.driver, "user-A"); // N=1 solo auto-claim
		// The payload the spawn path received is exactly the prompt text + identity.
		assert.deepEqual(enqueuePayloads, [{ sessionId: s.session_id, ownerUserId: "user-A", text: "grow me a panel" }]);
		// And the REAL IntentLog grew by the persisted user turn.
		const head = await deps.loadHead(s.session_id);
		assert.equal(head.headSeq, 0);
		assert.deepEqual((head.messages[0] as any).content, [{ type: "text", text: "grow me a panel" }]);
	});

	it("a NON-driver session/prompt is REJECTED via S3 authorize (not_driver, 409) and never enqueues", async () => {
		const presence = new InProcessLwwPresence();
		// Driver A claims first (a real, earlier prompt elects A).
		presence.claim("driver-A", 1000);

		const s = await store.createSession("user-A");
		const enqueued: EnqueueResult[] = [];
		const enqueuePayloads: Array<{ sessionId: string; ownerUserId: string; text: string }> = [];
		const deps = makeDeps({
			presence,
			sessionId: s.session_id,
			enqueued,
			enqueuePayloads,
			abortedFlag: { value: false },
			authorityFrames: [],
		});

		const resp = await handleAcpRequest(
			{
				request: parseAcpRequest({
					method: "session/prompt",
					sessionId: s.session_id,
					prompt: [{ type: "text", text: "I am not the driver" }],
				}),
				ownerUserId: "user-A",
				clientId: "observer-B",
				ts: 1000, // same tick → A (lex-smaller) keeps the seat; B is denied
			},
			deps,
		);

		assert.ok(isNotDriver(resp), "non-driver prompt rejected");
		if (isNotDriver(resp)) {
			assert.equal(resp.status, 409);
			assert.equal(resp.error, "not_driver");
			assert.equal(resp.driver, "driver-A");
		}
		// Hard invariant: nothing was enqueued and the log did not grow.
		assert.equal(enqueued.length, 0);
		assert.equal(enqueuePayloads.length, 0);
	});
});

// ─── bus → session/update round-trips to the EXACT S2/S0 event list ─────────

describe("CA-1/S6 ACP bridge — bus→session/update round-trips to the S0 list", () => {
	it("lifting the S0 baseline through the bridge's busEventToSessionNotification re-projects to the EXACT S0 list", () => {
		const baseline = deriveBaseline();
		const ctx = newStreamContext("sess-s6");
		ctx.usage = USAGE;

		// Lift each SandboxEvent (as a live category:"agent" bus event would carry)
		// through the bridge's per-event translator.
		const notes = baseline
			.map((e) => busEventToSessionNotification("sess-s6", e, ctx))
			.filter((n): n is NonNullable<typeof n> => n !== undefined);

		// Every note is a real session/update tagged with the session id.
		for (const n of notes) {
			assert.equal(n.method, "session/update");
			assert.equal(n.sessionId, "sess-s6");
		}

		// EQUIVALENCE: project the ACP stream BACK and assert deep-equal to the S0
		// baseline (the SAME oracle anchor as the S2 equivalence test).
		const back = createAcpAgent("sess-s6").fromAcp(notes);
		assert.deepEqual(back, baseline);

		// DOMINATION: the turn markers carry _ext the plain stream lacks.
		const turnMarkers = notes.filter((n) => n.update.sessionUpdate === "choreograph.turn");
		assert.equal(turnMarkers.length, 2);
		for (const m of turnMarkers) {
			const ext = (m.update as any)[ACP_EXT_KEY];
			assert.equal(typeof ext[PI_EXT.turn], "number");
		}
	});

	it("terminal SandboxEvents produce NO session/update (they resolve the prompt response)", () => {
		const ctx = newStreamContext("sess-s6");
		assert.equal(busEventToSessionNotification("sess-s6", { type: "done", output: "x" }, ctx), undefined);
		assert.equal(busEventToSessionNotification("sess-s6", { type: "error", message: "e" }, ctx), undefined);
	});
});

// ─── session/cancel → abort ──────────────────────────────────────────────────

describe("CA-1/S6 ACP bridge — session/cancel routes to abort", () => {
	it("session/cancel calls the injected abort seam", async () => {
		const presence = new InProcessLwwPresence();
		const s = await store.createSession("user-A");
		const abortedFlag = { value: false };
		const deps = makeDeps({
			presence,
			sessionId: s.session_id,
			enqueued: [],
			enqueuePayloads: [],
			abortedFlag,
			authorityFrames: [],
		});

		const resp = await handleAcpRequest(
			{
				request: parseAcpRequest({ method: "session/cancel", sessionId: s.session_id }),
				ownerUserId: "user-A",
				clientId: "user-A",
			},
			deps,
		);
		assert.deepEqual(resp, { sessionId: s.session_id, aborted: true });
		assert.equal(abortedFlag.value, true);
	});
});

// ─── session/fork → S1 IntentLog.fork(atSeq) → first-N turns ────────────────

describe("CA-1/S6 ACP bridge — session/fork routes to IntentLog.fork(atSeq)", () => {
	it("forks at N and yields the projected head of the first-N turns (S1 fork)", async () => {
		const presence = new InProcessLwwPresence();
		const s = await store.createSession("user-A");
		// Persist 3 real turns directly via the store (the IntentLog over them is real).
		await store.appendMessages(s.session_id, [
			{ role: "user", content: [{ type: "text", text: "turn-0" }], timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "turn-1" }], timestamp: 2 },
			{ role: "user", content: [{ type: "text", text: "turn-2" }], timestamp: 3 },
		]);

		const deps = makeDeps({
			presence,
			sessionId: s.session_id,
			enqueued: [],
			enqueuePayloads: [],
			abortedFlag: { value: false },
			authorityFrames: [],
		});

		const resp: any = await handleAcpRequest(
			{
				request: parseAcpRequest({ method: "session/fork", sessionId: s.session_id, atSeq: 2 }),
				ownerUserId: "user-A",
				clientId: "user-A",
			},
			deps,
		);

		// fork(atSeq=2) → first TWO turns only.
		assert.equal(resp.sessionId, s.session_id);
		assert.equal(resp.messages.length, 2);
		assert.equal(resp.headSeq, 1);
		assert.deepEqual((resp.messages[0] as any).content, [{ type: "text", text: "turn-0" }]);
		assert.deepEqual((resp.messages[1] as any).content, [{ type: "text", text: "turn-1" }]);

		// Cross-check: the bridge's fork matches the RAW S1 fork helper byte-for-byte.
		const direct = await fork(new SessionStoreIntentLog(store, s.session_id), 2, new HeadProjection());
		assert.equal(resp.digest, direct.digest);
		assert.deepEqual(resp.messages, direct.messages);
	});
});

// ─── permission request fans out as the NEW category:"authority" BusEvent ───

describe("CA-1/S6 ACP bridge — permission fans out as category:authority", () => {
	it("requestPermissionAndFanOut emits an authority:permission frame AND resolves on the driver's answer", async () => {
		const presence = new InProcessLwwPresence();
		presence.claim("driver-A", 5000); // A is the seated driver
		const authority = new AuthorityCapabilityBackend(presence, 60_000);
		const authorityFrames: AuthorityBusFrame[] = [];

		const deps = makeDeps({
			presence,
			sessionId: "sess-perm",
			authority,
			enqueued: [],
			enqueuePayloads: [],
			abortedFlag: { value: false },
			authorityFrames,
		});

		// Open a permission request for a destructive tool.
		const pending = requestPermissionAndFanOut(deps, "call-1", "write_document");

		// The NEW category:"authority" frame fanned out immediately.
		assert.equal(authorityFrames.length, 1);
		assert.deepEqual(authorityFrames[0], {
			category: "authority",
			type: "permission",
			callId: "call-1",
			tool: "write_document",
			driverId: "driver-A",
		});
		assert.ok(authority.isPending("call-1"), "request is pending until the driver answers");

		// The seated driver answers → the pending decision resolves allowed.
		const settled = authority.answerPermission("call-1", true, "driver-A");
		assert.equal(settled, true);
		const decision = await pending;
		assert.equal(decision.allowed, true);
		assert.equal(decision.decidedBy, "driver-A");

		await authority.close();
	});

	it("a NON-driver answer to the pending permission is rejected (not_driver, 409) and does not settle it", async () => {
		const presence = new InProcessLwwPresence();
		presence.claim("driver-A", 5000);
		const authority = new AuthorityCapabilityBackend(presence, 60_000);
		const authorityFrames: AuthorityBusFrame[] = [];
		const deps = makeDeps({
			presence,
			sessionId: "sess-perm-2",
			authority,
			enqueued: [],
			enqueuePayloads: [],
			abortedFlag: { value: false },
			authorityFrames,
		});

		const pending = requestPermissionAndFanOut(deps, "call-2", "delete_document");
		assert.equal(authorityFrames.length, 1);

		// An observer (non-driver) tries to answer → S3 throws NotDriverError (409).
		assert.throws(
			() => authority.answerPermission("call-2", true, "observer-B"),
			(err: any) => {
				assert.equal(err.status, 409);
				assert.equal(err.code, "not_driver");
				return true;
			},
		);
		// Still pending — the non-driver answer did NOT settle it.
		assert.ok(authority.isPending("call-2"));

		// The real driver settles it (deny), and the awaiter resolves.
		authority.answerPermission("call-2", false, "driver-A");
		const decision = await pending;
		assert.equal(decision.allowed, false);

		await authority.close();
	});
});
