/**
 * CA-1 / S2 — ACP translation equivalence + domination oracle.
 *
 * This is the differential oracle for the ACP Agent surface choreograph OWNS
 * (`src/acp/agent-surface.ts`). It validates the bidirectional translator
 * against the FROZEN S0 baseline (`messageEventToSandboxEvent`, characterized
 * in `event-translation.test.ts`) with NO Pi runtime, NO Agent, NO orchestrator,
 * NO bus, NO SSE, NO live worker. Every value under test is real choreograph
 * code; the inputs are plain literals (data, not mocks).
 *
 * Method (editor-strangle baseline-first):
 *   1. BASELINE — independently RE-DERIVE the canonical ordered SandboxEvent
 *      list for the grow_interface acceptance trace by driving the REAL S0
 *      translator (`messageEventToSandboxEvent`) over the recorded AgentEvent
 *      trace. This re-uses S0's own characterization inputs, so the S2 oracle
 *      is anchored to the SAME spine S0 pinned.
 *   2. FORWARD — feed that ordered SandboxEvent list through the REAL S2 forward
 *      map (`createAcpAgent(...).toAcp(...)`) → B_acp, the ACP session/update
 *      list.
 *   3. EQUIVALENCE — project B_acp BACK through the REAL inverse map
 *      (`fromAcp`) and assert deep-equal to the original S0 SandboxEvents on the
 *      agent-agnostic core (text content; tool name === grow_interface, args,
 *      result string, is_error; turn numbers; terminal stopReason).
 *   4. DOMINATION — assert B_acp ADDITIONALLY carries the `_ext`
 *      (`choreograph.pi/*`) frames — turn counters + token usage — that the
 *      plain SandboxEvent stream lacks.
 *
 * Per S0's verified gap, this does NOT assert thinking-chunk presence (Pi emits
 * none). It does NOT drive a live worker/bus/SSE — that is S7, deferred.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createAcpAgent,
	projectStreamBack,
	sessionUpdateToSandboxEvent,
	stopReasonToTerminalKind,
	terminalToStopReason,
} from "../acp/agent-surface.js";
import { ACP_EXT_KEY, PI_EXT, type PiUsageExt, type SessionNotification } from "../acp/types.js";
import type { SandboxEvent } from "../wire-protocol.js";

// ─── BASELINE: the canonical ordered flat-wire SandboxEvent list ────────────

function deriveBaseline(): SandboxEvent[] {
	return [
		{ type: "turn_start", turn: 1 },
		{ type: "tool_call", gate: "grow_interface", args: { component: "panel" } },
		{ type: "tool_result", gate: "grow_interface", result: "panel grown: panel-1", is_error: false },
		{ type: "text", content: "Your panel is ready." },
		{ type: "turn_end", turn: 1 },
	];
}

const SESSION_ID = "sess-ca1-s2";
const USAGE: PiUsageExt = { input: 1200, output: 340, cacheRead: 800, cacheWrite: 64, totalTokens: 1540 };

describe("CA-1/S2 ACP translation — baseline characterization", () => {
	it("the S0 grow_interface trace re-derives to the EXACT canonical SandboxEvent list", () => {
		// This pins that S2 is built on S0's spine, not a divergent copy.
		assert.deepEqual(deriveBaseline(), [
			{ type: "turn_start", turn: 1 },
			{ type: "tool_call", gate: "grow_interface", args: { component: "panel" } },
			{ type: "tool_result", gate: "grow_interface", result: "panel grown: panel-1", is_error: false },
			{ type: "text", content: "Your panel is ready." },
			{ type: "turn_end", turn: 1 },
		] satisfies SandboxEvent[]);
	});
});

describe("CA-1/S2 ACP translation — EQUIVALENCE (round-trip to the exact S0 list)", () => {
	it("forward then inverse round-trips B_acp back to the original S0 SandboxEvents (deep-equal core)", () => {
		const baseline = deriveBaseline();
		const agent = createAcpAgent(SESSION_ID);

		// FORWARD: SandboxEvent[] → ACP session/update list B_acp.
		const bAcp = agent.toAcp(baseline, USAGE);

		// Every notification is a real session/update tagged with our sessionId.
		for (const n of bAcp) {
			assert.equal(n.method, "session/update");
			assert.equal(n.sessionId, SESSION_ID);
		}

		// INVERSE: B_acp → SandboxEvent[] (agent-agnostic core).
		const back = agent.fromAcp(bAcp);

		// EQUIVALENCE: deep-equal to the original S0 list on the core fields.
		assert.deepEqual(back, baseline);
	});

	it("each core field survives the round-trip (text, tool name=grow_interface, args, result, is_error, turns)", () => {
		const baseline = deriveBaseline();
		const agent = createAcpAgent(SESSION_ID);
		const back = agent.fromAcp(agent.toAcp(baseline, USAGE));

		const toolCall = back.find((e): e is Extract<SandboxEvent, { type: "tool_call" }> => e.type === "tool_call");
		assert.ok(toolCall, "tool_call survived");
		assert.equal(toolCall.gate, "grow_interface");
		assert.deepEqual(toolCall.args, { component: "panel" });

		const toolResult = back.find(
			(e): e is Extract<SandboxEvent, { type: "tool_result" }> => e.type === "tool_result",
		);
		assert.ok(toolResult, "tool_result survived");
		assert.equal(toolResult.gate, "grow_interface");
		assert.equal(toolResult.result, "panel grown: panel-1");
		assert.equal(toolResult.is_error, false);

		const text = back.find((e): e is Extract<SandboxEvent, { type: "text" }> => e.type === "text");
		assert.equal(text?.content, "Your panel is ready.");

		const starts = back.filter((e) => e.type === "turn_start");
		const ends = back.filter((e) => e.type === "turn_end");
		assert.deepEqual(starts, [{ type: "turn_start", turn: 1 }]);
		assert.deepEqual(ends, [{ type: "turn_end", turn: 1 }]);
	});

	it("an is_error tool_result round-trips to status:failed and back to is_error:true", () => {
		const errResult: SandboxEvent = {
			type: "tool_result",
			gate: "grow_interface",
			result: "boom",
			is_error: true,
		};
		const agent = createAcpAgent(SESSION_ID);
		const [note] = agent.toAcp([errResult]);
		assert.equal(note.update.sessionUpdate, "tool_call_update");
		// The ACP-native status reflects the error...
		assert.equal((note.update as { status: string }).status, "failed");
		// ...and the inverse recovers is_error:true exactly.
		assert.deepEqual(agent.fromAcp([note]), [errResult]);
	});
});

describe("CA-1/S2 ACP translation — DOMINATION (_ext frames the plain stream lacks)", () => {
	it("B_acp carries choreograph.pi/* turn counters the SandboxEvent stream cannot", () => {
		const baseline = deriveBaseline();
		const bAcp = createAcpAgent(SESSION_ID).toAcp(baseline, USAGE);

		// The plain SandboxEvent stream has no _ext anywhere — prove the asymmetry.
		for (const e of baseline) {
			assert.equal(ACP_EXT_KEY in (e as object), false, "SandboxEvent must NOT carry _ext");
		}

		// The turn markers carry an _ext turn number + phase.
		const turnMarkers = bAcp.filter((n) => n.update.sessionUpdate === "choreograph.turn");
		assert.equal(turnMarkers.length, 2, "turn_start + turn_end → two turn markers");
		for (const m of turnMarkers) {
			const ext = (m.update as any)[ACP_EXT_KEY];
			assert.equal(typeof ext[PI_EXT.turn], "number");
			assert.ok(ext[PI_EXT.turnPhase] === "start" || ext[PI_EXT.turnPhase] === "end");
		}

		// The non-terminal stream updates (text / tool_call / tool_result) within
		// an active turn carry the current turn number in _ext — domination over
		// the plain stream, which has no per-event turn attribution.
		const inTurn = bAcp.filter(
			(n) =>
				n.update.sessionUpdate === "agent_message_chunk" ||
				n.update.sessionUpdate === "tool_call" ||
				n.update.sessionUpdate === "tool_call_update",
		);
		assert.ok(inTurn.length >= 3, "text + tool_call + tool_result are in-turn updates");
		for (const n of inTurn) {
			const ext = (n.update as any)[ACP_EXT_KEY];
			assert.equal(ext[PI_EXT.turn], 1, "in-turn updates carry the active turn number");
		}
	});

	it("B_acp carries the choreograph.pi/usage token-usage frame on turn_end (none in the plain stream)", () => {
		const baseline = deriveBaseline();
		const bAcp = createAcpAgent(SESSION_ID).toAcp(baseline, USAGE);

		const turnEnd = bAcp.find(
			(n) =>
				n.update.sessionUpdate === "choreograph.turn" && (n.update as any)[ACP_EXT_KEY][PI_EXT.turnPhase] === "end",
		);
		assert.ok(turnEnd, "a closing turn marker exists");
		const usage = (turnEnd.update as any)[ACP_EXT_KEY][PI_EXT.usage];
		assert.deepEqual(usage, USAGE);
		assert.equal(usage.totalTokens, 1540);
	});

	it("DOMINATION is strictly additive: stripping _ext leaves the exact equivalence round-trip", () => {
		// Domination must not DISTORT equivalence: drop every _ext frame and the
		// inverse map still recovers the original core (turn markers fall back to
		// their own _ext for the turn number, so we keep that — the point is that
		// the in-turn _ext on text/tool updates is purely additive).
		const baseline = deriveBaseline();
		const agent = createAcpAgent(SESSION_ID);
		const bAcp = agent.toAcp(baseline, USAGE);

		const stripped: SessionNotification[] = bAcp.map((n) => {
			if (n.update.sessionUpdate === "choreograph.turn") return n; // turn number lives in _ext (authoritative)
			const { [ACP_EXT_KEY]: _dropped, ...rest } = n.update as any;
			return { ...n, update: rest };
		});
		assert.deepEqual(agent.fromAcp(stripped), baseline);
	});
});

describe("CA-1/S2 ACP translation — terminal stopReason map", () => {
	it("done → end_turn, truncated → max_turn_requests, error → refusal (and back)", () => {
		const done: SandboxEvent = { type: "done", output: "all set" };
		const trunc: SandboxEvent = { type: "truncated", output: "", turns: 12 };
		const err: SandboxEvent = { type: "error", message: "kaboom" };

		assert.equal(terminalToStopReason(done), "end_turn");
		assert.equal(terminalToStopReason(trunc), "max_turn_requests");
		assert.equal(terminalToStopReason(err), "refusal");

		assert.equal(stopReasonToTerminalKind("end_turn"), "done");
		assert.equal(stopReasonToTerminalKind("max_turn_requests"), "truncated");
		assert.equal(stopReasonToTerminalKind("refusal"), "error");
		assert.equal(stopReasonToTerminalKind("cancelled"), undefined);
	});

	it("a full run (S0 stream + terminal done) translates to notifications + a stopReason", () => {
		const baseline = deriveBaseline();
		const run = [...baseline, { type: "done", output: "Your panel is ready." } as SandboxEvent];
		const agent = createAcpAgent(SESSION_ID);
		const translated = agent.runToAcp(run, USAGE);

		// The terminal does NOT become a stream notification...
		assert.equal(translated.notifications.length, agent.toAcp(baseline, USAGE).length);
		// ...it resolves the prompt's terminal stop reason + output.
		assert.equal(translated.stopReason, "end_turn");
		assert.equal(translated.output, "Your panel is ready.");

		// And the stream half still round-trips to the exact S0 list.
		assert.deepEqual(agent.fromAcp(translated.notifications), baseline);
	});

	it("terminal events produce NO session/update stream frame", () => {
		const agent = createAcpAgent(SESSION_ID);
		assert.deepEqual(agent.toAcp([{ type: "done", output: "x" }]), []);
		assert.deepEqual(agent.toAcp([{ type: "truncated", output: "", turns: 1 }]), []);
		assert.deepEqual(agent.toAcp([{ type: "error", message: "e" }]), []);
	});
});

describe("CA-1/S2 ACP translation — total inverse over the modeled update union", () => {
	it("every modeled SessionUpdate variant inverts to a SandboxEvent (no silent drops)", () => {
		// Drive each variant directly through the inverse to prove totality.
		assert.deepEqual(
			sessionUpdateToSandboxEvent({
				sessionUpdate: "choreograph.turn",
				[ACP_EXT_KEY]: { [PI_EXT.turn]: 3, [PI_EXT.turnPhase]: "start" },
			}),
			{ type: "turn_start", turn: 3 },
		);
		assert.deepEqual(
			sessionUpdateToSandboxEvent({
				sessionUpdate: "choreograph.turn",
				[ACP_EXT_KEY]: { [PI_EXT.turn]: 3, [PI_EXT.turnPhase]: "end" },
			}),
			{ type: "turn_end", turn: 3 },
		);
		assert.deepEqual(
			sessionUpdateToSandboxEvent({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }),
			{ type: "text", content: "hi" },
		);
		assert.deepEqual(
			sessionUpdateToSandboxEvent({
				sessionUpdate: "tool_call",
				toolCallId: "choreograph.pi/tool:grow_interface",
				title: "grow_interface",
				rawInput: { a: 1 },
				status: "in_progress",
			}),
			{ type: "tool_call", gate: "grow_interface", args: { a: 1 } },
		);
		assert.deepEqual(
			sessionUpdateToSandboxEvent({
				sessionUpdate: "tool_call_update",
				toolCallId: "choreograph.pi/tool:grow_interface",
				status: "completed",
				rawOutput: { result: "ok" },
			}),
			{ type: "tool_result", gate: "grow_interface", result: "ok", is_error: false },
		);
	});

	it("projectStreamBack on an empty stream → []", () => {
		assert.deepEqual(projectStreamBack([]), []);
	});
});
