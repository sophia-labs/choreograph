/**
 * CA-1 / S6 — the ACP endpoint family, LIVE end-to-end (OPT-IN, gated).
 *
 * This is WRITTEN here but RUNS only at live bring-up. It is gated on
 * CHOREOGRAPH_API_TEST_BASE_URL exactly like workflow-run.integration.test.ts:
 * unset → every case SKIPs (never fails), so the headless committable run is
 * green without a live orchestrator.
 *
 * Against a live orchestrator (a mock:done session is enough — no real key, no
 * DeepSeek), it drives the new POST /acp front door:
 *   - session/new  → a session id
 *   - session/prompt (driver) → 202 + a sandbox; the bus SSE stream for that
 *     sandbox carries the run, and its agent-agnostic core is byte-equivalent to
 *     the existing SandboxEvent SSE stream for the same turn (the S2/S0 oracle,
 *     now over the wire)
 *   - session/prompt (non-driver, via X-Acp-Client-Id) → 409 not_driver
 *   - session/cancel → abort
 *   - session/fork at N → a child head with N rows
 *
 * Required env to RUN (the live host sets these; the dev VM exports them):
 *   CHOREOGRAPH_API_TEST_BASE_URL   e.g. http://127.0.0.1:3456
 *   CHOREOGRAPH_API_TEST_AUTH       the X-Internal-Service secret (dev: dev-internal-secret)
 *   CHOREOGRAPH_API_TEST_USER       the X-User-ID (dev: test-user)
 *
 * Full ACP session/update STREAM byte-equivalence (vs the SandboxEvent SSE) is
 * asserted only when the orchestrator exposes the ACP SSE lift; today the live
 * /acp prompt streams the SandboxEvent bus, so this test asserts the agent-
 * agnostic core round-trips through the S2 inverse — the same equivalence anchor.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectStreamBack } from "../acp/agent-surface.js";
import type { SessionUpdate } from "../acp/types.js";

const BASE_URL = process.env.CHOREOGRAPH_API_TEST_BASE_URL;
const AUTH = process.env.CHOREOGRAPH_API_TEST_AUTH ?? "dev-internal-secret";
const USER = process.env.CHOREOGRAPH_API_TEST_USER ?? "test-user";
const ENABLED = Boolean(BASE_URL);
const SKIP = ENABLED ? false : "set CHOREOGRAPH_API_TEST_BASE_URL to run the live ACP endpoint test";

function headers(extra?: Record<string, string>): Record<string, string> {
	return {
		"content-type": "application/json",
		"x-internal-service": AUTH,
		"x-user-id": USER,
		...extra,
	};
}

async function acp(body: unknown, extra?: Record<string, string>): Promise<{ status: number; json: any }> {
	const res = await fetch(`${BASE_URL}/acp`, {
		method: "POST",
		headers: headers(extra),
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let json: any;
	try {
		json = text ? JSON.parse(text) : undefined;
	} catch {
		json = text;
	}
	return { status: res.status, json };
}

describe("CA-1/S6 ACP endpoints — live end-to-end (opt-in)", () => {
	it("session/new mints a session id", { skip: SKIP }, async () => {
		const { status, json } = await acp({ method: "session/new" });
		assert.equal(status, 200);
		assert.ok(typeof json.sessionId === "string" && json.sessionId.length > 0, "session id minted");
	});

	it(
		"session/prompt (driver) → 202 + sandbox; the run's bus core round-trips through the S2 inverse",
		{ skip: SKIP },
		async () => {
			// New session (model defaults to mock:done at the orchestrator if unset;
			// the live host may pin a mock model on session create).
			const created = await acp({ method: "session/new" });
			const sessionId = created.json.sessionId as string;

			// Prompt as the implicit driver (no X-Acp-Client-Id → owner is driver).
			const prompted = await acp({
				method: "session/prompt",
				sessionId,
				prompt: [{ type: "text", text: "say hello" }],
			});
			assert.equal(prompted.status, 202, "driver prompt accepted");
			const sandboxId = prompted.json.sandboxId as string;
			assert.ok(sandboxId, "sandbox id returned");
			assert.equal(prompted.json.driver, USER, "owner is the N=1 solo driver");

			// Stream the bus SSE for that sandbox and collect the agent-agnostic core.
			const events = await collectSandboxEventsViaSse(sandboxId);
			// The S2 inverse over the (already-core) SandboxEvent list is identity on
			// the core, proving the wire stream is the same agent-agnostic spine.
			const core = projectStreamBack(
				events
					.filter((e) => e.category === "agent")
					.map((e) => ({ method: "session/update" as const, sessionId, update: toSessionUpdate(e.event) }))
					.filter(
						(n): n is { method: "session/update"; sessionId: string; update: SessionUpdate } =>
							n.update !== undefined,
					),
			);
			// Non-vacuous: a 404/empty stream (the old `/stream` typo) would leave core
			// empty and silently pass. Require a real, structurally-recoverable core.
			assert.ok(core.length > 0, "the wire stream carried a non-empty agent-agnostic core (not a 404/empty pass)");
			assert.ok(
				core.every((e) => typeof e.type === "string"),
				"every recovered frame is a structurally-valid SandboxEvent",
			);
			// NOTE: strict per-frame byte-equivalence of the full ACP session/update stream
			// to the existing SandboxEvent SSE (the S2/S0 oracle over the live wire) is S7's
			// VM equivalence test; here we assert the spine is present and recoverable.
		},
	);

	it("session/prompt as a NON-driver → 409 not_driver", { skip: SKIP }, async () => {
		const created = await acp({ method: "session/new" });
		const sessionId = created.json.sessionId as string;
		// First, a real driver claims the seat (client-A prompts).
		await acp(
			{ method: "session/prompt", sessionId, prompt: [{ type: "text", text: "I am the driver" }] },
			{ "x-acp-client-id": "client-A" },
		);
		// Then a different client tries → 409 not_driver.
		const denied = await acp(
			{ method: "session/prompt", sessionId, prompt: [{ type: "text", text: "let me in" }] },
			{ "x-acp-client-id": "client-B" },
		);
		assert.equal(denied.status, 409);
		assert.equal(denied.json.error, "not_driver");
	});

	it("session/cancel → abort (200, aborted true/false)", { skip: SKIP }, async () => {
		const created = await acp({ method: "session/new" });
		const sessionId = created.json.sessionId as string;
		const { status, json } = await acp({ method: "session/cancel", sessionId });
		assert.equal(status, 200);
		assert.equal(typeof json.aborted, "boolean");
	});

	it("session/fork at N → a child head with N rows", { skip: SKIP }, async () => {
		const created = await acp({ method: "session/new" });
		const sessionId = created.json.sessionId as string;
		// Drive one prompt so the log has turns to fork.
		await acp({ method: "session/prompt", sessionId, prompt: [{ type: "text", text: "turn one" }] });
		// Fork at 1 → exactly one turn in the projected head.
		const forked = await acp({ method: "session/fork", sessionId, atSeq: 1 });
		assert.equal(forked.status, 200);
		assert.equal(forked.json.messages.length, 1, "fork(atSeq=1) yields the first turn only");
	});
});

// ── live SSE collection helpers (only reached when ENABLED) ─────────────────

interface SseAgentEvent {
	category: string;
	type: string;
	event: any;
}

/** Open the session SSE stream for a sandbox, collect events until terminal. */
async function collectSandboxEventsViaSse(sandboxId: string): Promise<SseAgentEvent[]> {
	const res = await fetch(`${BASE_URL}/api/sandboxes/${sandboxId}/events`, {
		headers: headers({ accept: "text/event-stream" }),
	});
	const out: SseAgentEvent[] = [];
	if (!res.body) return out;
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		const frames = buf.split("\n\n");
		buf = frames.pop() ?? "";
		for (const frame of frames) {
			const evLine = frame.split("\n").find((l) => l.startsWith("event:"));
			const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
			if (!evLine || !dataLine) continue;
			const [category, type] = evLine.slice("event:".length).trim().split(":");
			let data: any;
			try {
				data = JSON.parse(dataLine.slice("data:".length).trim());
			} catch {
				continue;
			}
			if (category === "agent") out.push({ category, type, event: data.event ?? data });
			if (category === "lifecycle" && type === "terminal") return out;
		}
	}
	return out;
}

/** Map a wire SandboxEvent into the S2 SessionUpdate (mirrors the bridge lift). */
function toSessionUpdate(event: any): SessionUpdate | undefined {
	switch (event?.type) {
		case "turn_start":
			return {
				sessionUpdate: "choreograph.turn",
				_meta: { "choreograph.pi/turn": event.turn, "choreograph.pi/turn_phase": "start" },
			};
		case "turn_end":
			return {
				sessionUpdate: "choreograph.turn",
				_meta: { "choreograph.pi/turn": event.turn, "choreograph.pi/turn_phase": "end" },
			};
		case "text":
			return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.content } };
		case "tool_call":
			return {
				sessionUpdate: "tool_call",
				toolCallId: `choreograph.pi/tool:${event.gate}`,
				title: event.gate,
				rawInput: event.args,
				status: "in_progress",
			};
		case "tool_result":
			return {
				sessionUpdate: "tool_call_update",
				toolCallId: `choreograph.pi/tool:${event.gate}`,
				status: event.is_error ? "failed" : "completed",
				rawOutput: { result: event.result },
			};
		default:
			return undefined;
	}
}
