import type { ProxyAssistantMessageEvent } from "./wire-protocol.js";
import { ZERO_USAGE } from "./wire-protocol.js";

export interface MockLlmState {
	requestCount: number;
}

export async function* proxyMockModel(
	modelName: string,
	state: MockLlmState,
	signal?: AbortSignal,
): AsyncGenerator<ProxyAssistantMessageEvent> {
	switch (modelName) {
		case "mock:done":
			if (state.requestCount === 0) {
				yield { type: "start" };
				yield {
					type: "toolcall_start",
					contentIndex: 0,
					id: "mock-done-call",
					toolName: "done",
				};
				yield {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: JSON.stringify({ summary: "Mock sandbox validation completed." }),
				};
				yield { type: "toolcall_end", contentIndex: 0 };
				yield { type: "done", reason: "toolUse", usage: ZERO_USAGE };
			} else {
				yield* emitTextSequence("Mock sandbox validation completed.");
			}
			state.requestCount++;
			return;

		case "mock:text":
			state.requestCount++;
			yield* emitTextSequence("Mock sandbox text response.");
			return;

		case "mock:mnemosyne_search":
			if (state.requestCount === 0) {
				yield { type: "start" };
				yield {
					type: "toolcall_start",
					contentIndex: 0,
					id: "mock-search-call",
					toolName: "search_documents",
				};
				yield {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: JSON.stringify({ query: "choreograph", limit: 3 }),
				};
				yield { type: "toolcall_end", contentIndex: 0 };
				yield { type: "done", reason: "toolUse", usage: ZERO_USAGE };
			} else {
				yield { type: "start" };
				yield {
					type: "toolcall_start",
					contentIndex: 0,
					id: "mock-done-after-search",
					toolName: "done",
				};
				yield {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: JSON.stringify({ summary: "Mock Mnemosyne search completed." }),
				};
				yield { type: "toolcall_end", contentIndex: 0 };
				yield { type: "done", reason: "toolUse", usage: ZERO_USAGE };
			}
			state.requestCount++;
			return;

		case "mock:ipython": {
			const cells = [
				{
					id: "mock-ipython-state",
					code: 'import os\nassert not os.environ.get("OPENROUTER_API_KEY")\nx = 40\nprint("prime kernel online")\nx + 2',
				},
				{ id: "mock-ipython-persist", code: 'print("state persisted", x + 2)\nx + 3' },
			];
			const cell = cells[state.requestCount];
			if (cell) {
				yield { type: "start" };
				yield { type: "toolcall_start", contentIndex: 0, id: cell.id, toolName: "ipython" };
				yield { type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify({ code: cell.code }) };
				yield { type: "toolcall_end", contentIndex: 0 };
				yield { type: "done", reason: "toolUse", usage: ZERO_USAGE };
			} else if (state.requestCount === cells.length) {
				yield { type: "start" };
				yield { type: "toolcall_start", contentIndex: 0, id: "mock-done-after-ipython", toolName: "done" };
				yield {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: JSON.stringify({ summary: "Prime kernel execution completed with persistent state." }),
				};
				yield { type: "toolcall_end", contentIndex: 0 };
				yield { type: "done", reason: "toolUse", usage: ZERO_USAGE };
			} else {
				yield* emitTextSequence("Prime kernel execution completed with persistent state.");
			}
			state.requestCount++;
			return;
		}

		case "mock:resident_ipython": {
			if (state.requestCount % 2 === 0) {
				const commandIndex = Math.floor(state.requestCount / 2) + 1;
				yield { type: "start" };
				yield {
					type: "toolcall_start",
					contentIndex: 0,
					id: `mock-resident-ipython-${commandIndex}`,
					toolName: "ipython",
				};
				yield {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: JSON.stringify({
						code: [
							'resident_value = globals().get("resident_value", 0) + 1',
							'print("resident value", resident_value)',
							"resident_value",
						].join("\n"),
					}),
				};
				yield { type: "toolcall_end", contentIndex: 0 };
				yield { type: "done", reason: "toolUse", usage: ZERO_USAGE };
			} else {
				yield { type: "start" };
				yield {
					type: "toolcall_start",
					contentIndex: 0,
					id: `mock-resident-done-${Math.ceil(state.requestCount / 2)}`,
					toolName: "done",
				};
				yield {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: JSON.stringify({ summary: "Resident Prime command completed." }),
				};
				yield { type: "toolcall_end", contentIndex: 0 };
				yield { type: "done", reason: "toolUse", usage: ZERO_USAGE };
			}
			state.requestCount++;
			return;
		}

		case "mock:rlm": {
			const cells = [
				{
					id: "mock-rlm-spawn",
					code: [
						"import rlm",
						"child_handle = await rlm.run(",
						'    "Inspect the bounded local Arc F evidence and finish.",',
						'    name="researcher",',
						'    model="mock:done",',
						")",
						'assert child_handle.child_session_id.startswith("ags_")',
						'assert child_handle.child_run_id.startswith("acr_")',
						'print("child admitted", child_handle.child_session_id, child_handle.child_run_id)',
						"child_handle.child_run_id",
					].join("\n"),
				},
				{
					id: "mock-rlm-parent-continues",
					code: [
						'assert child_handle.name == "researcher"',
						'assert child_handle.model == "mock:done"',
						'parent_after_child = globals().get("parent_after_child", 0) + 1',
						'print("parent continued", parent_after_child)',
						"parent_after_child",
					].join("\n"),
				},
			];
			const cell = cells[state.requestCount];
			if (cell) {
				yield { type: "start" };
				yield { type: "toolcall_start", contentIndex: 0, id: cell.id, toolName: "ipython" };
				yield { type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify({ code: cell.code }) };
				yield { type: "toolcall_end", contentIndex: 0 };
				yield { type: "done", reason: "toolUse", usage: ZERO_USAGE };
			} else if (state.requestCount === cells.length) {
				yield { type: "start" };
				yield { type: "toolcall_start", contentIndex: 0, id: "mock-done-after-rlm", toolName: "done" };
				yield {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: JSON.stringify({ summary: "Hosted child completed while the parent kernel remained usable." }),
				};
				yield { type: "toolcall_end", contentIndex: 0 };
				yield { type: "done", reason: "toolUse", usage: ZERO_USAGE };
			} else {
				yield* emitTextSequence("Hosted child completed while the parent kernel remained usable.");
			}
			state.requestCount++;
			return;
		}

		case "mock:rlm_prime": {
			const cells = [
				{
					id: "mock-rlm-prime-spawn",
					code: [
						"import rlm",
						"child_handle = await rlm.run(",
						'    "Materialize a resident Prime worker and kernel, then finish the initial task.",',
						'    name="prime-researcher",',
						'    model="mock:resident_ipython",',
						")",
						'assert child_handle.child_session_id.startswith("ags_")',
						'assert child_handle.child_run_id.startswith("acr_")',
						'print("prime child admitted", child_handle.child_session_id, child_handle.child_run_id)',
						"child_handle.child_run_id",
					].join("\n"),
				},
				{
					id: "mock-rlm-prime-parent-continues",
					code: [
						'assert child_handle.name == "prime-researcher"',
						'assert child_handle.model == "mock:resident_ipython"',
						'parent_after_prime_child = globals().get("parent_after_prime_child", 0) + 1',
						'print("parent continued after prime child", parent_after_prime_child)',
						"parent_after_prime_child",
					].join("\n"),
				},
			];
			const cell = cells[state.requestCount];
			if (cell) {
				yield { type: "start" };
				yield { type: "toolcall_start", contentIndex: 0, id: cell.id, toolName: "ipython" };
				yield { type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify({ code: cell.code }) };
				yield { type: "toolcall_end", contentIndex: 0 };
				yield { type: "done", reason: "toolUse", usage: ZERO_USAGE };
			} else if (state.requestCount === cells.length) {
				yield { type: "start" };
				yield { type: "toolcall_start", contentIndex: 0, id: "mock-done-after-prime-rlm", toolName: "done" };
				yield {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: JSON.stringify({ summary: "Resident Prime child materialized independently." }),
				};
				yield { type: "toolcall_end", contentIndex: 0 };
				yield { type: "done", reason: "toolUse", usage: ZERO_USAGE };
			} else {
				yield* emitTextSequence("Resident Prime child materialized independently.");
			}
			state.requestCount++;
			return;
		}

		case "mock:rlm_f4": {
			const steps = [
				{
					id: "mock-rlm-f4-first-child",
					code: [
						"import rlm",
						"first_child_handle = await rlm.run(",
						'    "Materialize the first resident Arc F4 child.",',
						'    name="prime-child-one",',
						'    model="mock:resident_ipython",',
						")",
						'print("F4 first child admitted", first_child_handle.child_session_id)',
						"first_child_handle.child_run_id",
					].join("\n"),
				},
				{
					id: "mock-rlm-f4-concurrency-denial",
					code: [
						"try:",
						"    await rlm.run(",
						'        "This child must be denied while the first resident generation occupies capacity.",',
						'        name="blocked-prime-child",',
						'        model="mock:resident_ipython",',
						"    )",
						'    raise AssertionError("concurrent child was unexpectedly admitted")',
						"except RuntimeError as error:",
						'    assert "max_concurrent_children_exhausted" in str(error)',
						'    print("F4 concurrency denial durable", error)',
						'"max_concurrent_children_exhausted"',
					].join("\n"),
				},
				{
					id: "mock-rlm-f4-second-child",
					code: [
						"second_child_handle = await rlm.run(",
						'    "Materialize the second resident Arc F4 child after capacity is released.",',
						'    name="prime-child-two",',
						'    model="mock:resident_ipython",',
						")",
						'print("F4 second child admitted", second_child_handle.child_session_id)',
						"second_child_handle.child_run_id",
					].join("\n"),
				},
				{
					id: "mock-rlm-f4-lifetime-denial",
					code: [
						"try:",
						"    await rlm.run(",
						'        "This third distinct child must be denied by the lifetime limit.",',
						'        name="prime-child-three",',
						'        model="mock:resident_ipython",',
						"    )",
						'    raise AssertionError("third lifetime child was unexpectedly admitted")',
						"except RuntimeError as error:",
						'    assert "max_children_exhausted" in str(error)',
						'    print("F4 lifetime denial durable", error)',
						'"max_children_exhausted"',
					].join("\n"),
				},
			];
			const stepIndex = Math.floor(state.requestCount / 2);
			if (state.requestCount % 2 === 0 && steps[stepIndex]) {
				const step = steps[stepIndex]!;
				yield { type: "start" };
				yield { type: "toolcall_start", contentIndex: 0, id: step.id, toolName: "ipython" };
				yield { type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify({ code: step.code }) };
				yield { type: "toolcall_end", contentIndex: 0 };
				yield { type: "done", reason: "toolUse", usage: ZERO_USAGE };
			} else if (steps[stepIndex]) {
				yield { type: "start" };
				yield {
					type: "toolcall_start",
					contentIndex: 0,
					id: `mock-rlm-f4-done-${stepIndex + 1}`,
					toolName: "done",
				};
				yield {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: JSON.stringify({ summary: `Arc F4 host step ${stepIndex + 1} completed.` }),
				};
				yield { type: "toolcall_end", contentIndex: 0 };
				yield { type: "done", reason: "toolUse", usage: ZERO_USAGE };
			} else {
				yield* emitTextSequence("Arc F4 host scenario completed.");
			}
			state.requestCount++;
			return;
		}

		case "mock:rlm_f5_simple_parent": {
			const steps = [
				{
					id: "mock-rlm-f5-simple-ready",
					code: [
						"import os",
						'assert not os.environ.get("OPENROUTER_API_KEY")',
						'print("F5 simple parent ready without credentials")',
					].join("\n"),
				},
				{
					id: "mock-rlm-f5-delete-queued",
					code: [
						"import rlm",
						"queued_children = await rlm.list_subagents()",
						"assert len(queued_children) == 1, queued_children",
						"queued_child = queued_children[0]",
						'assert queued_child.run_state == "claimed"',
						"queued_closure = await rlm.delete_subagent(queued_child)",
						'assert queued_closure.prior_run_state == "claimed"',
						'assert queued_closure.final_run_state == "cancelled"',
						'assert queued_closure.session_state == "closed"',
						'assert queued_closure.cancellation == "observed"',
						'print("F5 queued delete observed", queued_closure.child_run_id)',
						"queued_closure.child_run_id",
					].join("\n"),
				},
				{
					id: "mock-rlm-f5-failing-simple",
					code: [
						"failed_handle = await rlm.run(",
						'    "Fail inside the bounded F5 simple child without disturbing the parent.",',
						'    name="failing-simple-child",',
						'    model="mock:f5_failure",',
						")",
						'print("F5 failing child admitted", failed_handle.child_run_id)',
						"failed_handle.child_run_id",
					].join("\n"),
				},
				{
					id: "mock-rlm-f5-simple-parent-continues",
					code: [
						"terminal_closure = await rlm.delete_subagent(failed_handle)",
						'assert terminal_closure.prior_run_state == "failed"',
						'assert terminal_closure.final_run_state == "failed"',
						'assert terminal_closure.session_state == "closed"',
						'assert terminal_closure.cancellation == "not_required"',
						'parent_after_simple_fault = globals().get("parent_after_simple_fault", 0) + 1',
						'print("F5 parent continued after simple fault", parent_after_simple_fault)',
						"parent_after_simple_fault",
					].join("\n"),
				},
			];
			yield* emitAlternatingIpythonStep(modelName, state, steps);
			return;
		}

		case "mock:rlm_f5_active_parent": {
			const steps = [
				{
					id: "mock-rlm-f5-active-ready",
					code: [
						"import os",
						'assert not os.environ.get("OPENROUTER_API_KEY")',
						'print("F5 active parent ready without credentials")',
					].join("\n"),
				},
				{
					id: "mock-rlm-f5-active-spawn",
					code: [
						"import rlm",
						"active_handle = await rlm.run(",
						'    "Remain active in a private kernel until the parent cancels this F5 child.",',
						'    name="active-prime-child",',
						'    model="mock:f5_blocked_ipython",',
						")",
						'print("F5 active child admitted", active_handle.child_run_id)',
						"active_handle.child_run_id",
					].join("\n"),
				},
				{
					id: "mock-rlm-f5-active-delete",
					code: [
						"active_children = await rlm.list_subagents()",
						"assert len(active_children) == 1, active_children",
						"assert active_children[0].child_run_id == active_handle.child_run_id",
						"active_closure = await rlm.delete_subagent(active_children[0])",
						'assert active_closure.prior_run_state in ("claimed", "cancelling")',
						'assert active_closure.final_run_state == "cancelled"',
						'assert active_closure.session_state == "closed"',
						'assert active_closure.cancellation == "observed"',
						'print("F5 active delete observed", active_closure.child_run_id)',
						"active_closure.child_run_id",
					].join("\n"),
				},
				{
					id: "mock-rlm-f5-active-parent-continues",
					code: [
						"terminal_closure = await rlm.delete_subagent(active_handle)",
						'assert terminal_closure.prior_run_state == "cancelled"',
						'assert terminal_closure.final_run_state == "cancelled"',
						'assert terminal_closure.session_state == "closed"',
						'assert terminal_closure.cancellation == "not_required"',
						'parent_after_active_cancel = globals().get("parent_after_active_cancel", 0) + 1',
						'print("F5 parent continued after active cancellation", parent_after_active_cancel)',
						"parent_after_active_cancel",
					].join("\n"),
				},
			];
			yield* emitAlternatingIpythonStep(modelName, state, steps);
			return;
		}

		case "mock:rlm_f5_crash_parent": {
			const steps = [
				{
					id: "mock-rlm-f5-crash-ready",
					code: [
						"import os",
						'assert not os.environ.get("OPENROUTER_API_KEY")',
						'print("F5 crash parent ready without credentials")',
					].join("\n"),
				},
				{
					id: "mock-rlm-f5-crash-spawn",
					code: [
						"import rlm",
						"worker_crash_handle = await rlm.run(",
						'    "Remain active until the F5 worker crash stimulus.",',
						'    name="worker-crash-child",',
						'    model="mock:f5_blocked_ipython",',
						")",
						"kernel_crash_handle = await rlm.run(",
						'    "Remain active until the F5 kernel crash stimulus.",',
						'    name="kernel-crash-child",',
						'    model="mock:f5_blocked_ipython",',
						")",
						'print("F5 crash children admitted", worker_crash_handle.child_run_id, kernel_crash_handle.child_run_id)',
						"(worker_crash_handle.child_run_id, kernel_crash_handle.child_run_id)",
					].join("\n"),
				},
			];
			yield* emitAlternatingIpythonStep(modelName, state, steps);
			return;
		}

		case "mock:f5_blocked_ipython":
			if (state.requestCount === 0) {
				yield { type: "start" };
				yield {
					type: "toolcall_start",
					contentIndex: 0,
					id: "mock-f5-blocked-ipython",
					toolName: "ipython",
				};
				yield {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: JSON.stringify({
						code: [
							"import asyncio, os",
							'assert not os.environ.get("OPENROUTER_API_KEY")',
							'print("F5 child kernel blocking without credentials")',
							"await asyncio.sleep(60)",
						].join("\n"),
					}),
				};
				yield { type: "toolcall_end", contentIndex: 0 };
				yield { type: "done", reason: "toolUse", usage: ZERO_USAGE };
			} else {
				yield* emitTextSequence("F5 blocked child unexpectedly resumed.");
			}
			state.requestCount++;
			return;

		case "mock:repeat_tool": {
			// What a clerk did on 2026-10-21: the same read, again and again, its arguments in a new order each time.
			const turn = state.requestCount++;
			const args: [string, unknown][] = [
				["documentId", "doc-sleepers"],
				["blockId", "block-c31fee14"],
				["limit", 1],
				["format", "text"],
			];
			const shift = turn % args.length;
			yield* emitToolCall(
				`mock-repeat-${String(turn)}`,
				"read_blocks",
				Object.fromEntries([...args.slice(shift), ...args.slice(0, shift)]),
			);
			return;
		}

		case "mock:wander": {
			// Reads a new block every turn and never answers: no call repeats, so only the turn cap ends it.
			const turn = state.requestCount++;
			yield* emitToolCall(`mock-wander-${String(turn)}`, "read_blocks", {
				documentId: "doc-sleepers",
				blockId: `block-${String(turn)}`,
			});
			return;
		}

		case "mock:stall": {
			// Starts an answer and never finishes it, as a provider that stops answering does: only an abort ends it.
			state.requestCount++;
			yield { type: "start" };
			let timer: ReturnType<typeof setTimeout> | undefined;
			const aborted = await new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), 120_000);
				if (signal?.aborted) resolve(true);
				signal?.addEventListener("abort", () => resolve(true), { once: true });
			});
			clearTimeout(timer);
			if (aborted) {
				yield { type: "error", reason: "aborted", errorMessage: "The call was aborted.", usage: ZERO_USAGE };
				return;
			}
			yield* emitTextSequence("The stalled answer arrived after all.");
			return;
		}

		case "mock:f5_failure":
			state.requestCount++;
			yield { type: "start" };
			yield {
				type: "error",
				reason: "error",
				errorMessage: "Deliberate Arc F5 child inference failure.",
				usage: ZERO_USAGE,
			};
			return;

		case "mock:rlm_f6_parent": {
			const cells = [
				{
					id: "mock-rlm-f6-spawn",
					code: [
						"import os, rlm",
						'assert not os.environ.get("OPENROUTER_API_KEY")',
						'assert not os.environ.get("PHANES_TRANSCRIBE_TOKEN")',
						"f6_child = await rlm.run(",
						'    "Inspect one bounded local F6 question without receiving parent credentials or authority.",',
						'    name="phanes-researcher",',
						'    model="mock:rlm_f6_blocked_child",',
						")",
						'print("F6 sole child admitted", f6_child.child_run_id)',
						"f6_child.child_run_id",
					].join("\n"),
				},
				{
					id: "mock-rlm-f6-observe-delete",
					code: [
						"f6_children = await rlm.list_subagents()",
						"assert len(f6_children) == 1, f6_children",
						"assert f6_children[0].child_run_id == f6_child.child_run_id",
						"f6_closure = await rlm.delete_subagent(f6_children[0])",
						'assert f6_closure.final_run_state == "cancelled"',
						'assert f6_closure.session_state == "closed"',
						'assert f6_closure.cancellation == "observed"',
						'print("F6 exact child deletion observed", f6_closure.child_run_id)',
						"f6_closure.child_run_id",
					].join("\n"),
				},
				{
					id: "mock-rlm-f6-parent-continuity",
					code: [
						'f6_parent_continuity = globals().get("f6_parent_continuity", 0) + 1',
						"assert f6_parent_continuity == 1",
						'print("F6 parent continued after bounded child cancellation", f6_parent_continuity)',
						"f6_parent_continuity",
					].join("\n"),
				},
			];
			const cell = cells[state.requestCount];
			if (cell) {
				yield { type: "start" };
				yield { type: "toolcall_start", contentIndex: 0, id: cell.id, toolName: "ipython" };
				yield { type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify({ code: cell.code }) };
				yield { type: "toolcall_end", contentIndex: 0 };
				yield { type: "done", reason: "toolUse", usage: ZERO_USAGE };
			} else if (state.requestCount === cells.length) {
				yield { type: "start" };
				yield { type: "toolcall_start", contentIndex: 0, id: "mock-rlm-f6-submit", toolName: "submit" };
				yield {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: JSON.stringify({
						response: { content: "Arc F6 completed one bounded investigation and preserved the parent." },
						proposedEffects: [],
					}),
				};
				yield { type: "toolcall_end", contentIndex: 0 };
				yield { type: "done", reason: "toolUse", usage: ZERO_USAGE };
			} else {
				yield* emitTextSequence("Arc F6 response was already submitted.");
			}
			state.requestCount++;
			return;
		}

		case "mock:rlm_f6_blocked_child":
			state.requestCount++;
			yield { type: "start" };
			await new Promise((resolve) => setTimeout(resolve, 60_000));
			yield* emitTextSequence("Arc F6 child unexpectedly survived cancellation.");
			return;

		case "mock:rlm_g2_heartbeat": {
			if (state.requestCount === 0) {
				yield { type: "start" };
				yield { type: "toolcall_start", contentIndex: 0, id: "mock-g2-heartbeat-create", toolName: "ipython" };
				yield {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: JSON.stringify({
						code: [
							"import asyncio, rlm_heartbeat",
							'if "g2_heartbeat_id" not in globals():',
							'    g2_heartbeat = await rlm_heartbeat.create("deliver one G2 live steer", interval="10s", label="arc-g2", delivery_mode="steer")',
							'    g2_heartbeat_id = g2_heartbeat["heartbeat"]["id"]',
							'    g2_heartbeat = await rlm_heartbeat.update(g2_heartbeat_id, instruction="deliver one G2 live follow up", delivery_mode="follow_up")',
							'    assert g2_heartbeat["heartbeat"]["delivery_mode"] == "follow_up"',
							'    print("G2 real heartbeat created", g2_heartbeat_id)',
							"else:",
							'    print("G2 existing heartbeat resumed", g2_heartbeat_id)',
							"    await rlm_heartbeat.delete(g2_heartbeat_id)",
							'    print("G2 existing heartbeat cancelled", g2_heartbeat_id)',
						].join("\n"),
					}),
				};
				yield { type: "toolcall_end", contentIndex: 0 };
				yield { type: "done", reason: "toolUse", usage: ZERO_USAGE };
			} else if (state.requestCount === 1) {
				yield { type: "start" };
				yield { type: "toolcall_start", contentIndex: 0, id: "mock-g2-heartbeat-submit", toolName: "submit" };
				yield {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: JSON.stringify({
						response: { content: "Arc G2 admitted one real heartbeat." },
						proposedEffects: [],
					}),
				};
				yield { type: "toolcall_end", contentIndex: 0 };
				yield { type: "done", reason: "toolUse", usage: ZERO_USAGE };
			} else {
				yield { type: "start" };
				yield { type: "toolcall_start", contentIndex: 0, id: "mock-g2-heartbeat-repeat", toolName: "submit" };
				yield {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: JSON.stringify({
						response: { content: "Arc G2 heartbeat was already admitted." },
						proposedEffects: [],
					}),
				};
				yield { type: "toolcall_end", contentIndex: 0 };
				yield { type: "done", reason: "toolUse", usage: ZERO_USAGE };
			}
			state.requestCount++;
			return;
		}

		case "mock:ipython_capability": {
			if (state.requestCount === 0) {
				yield { type: "start" };
				yield { type: "toolcall_start", contentIndex: 0, id: "mock-ipython-capability", toolName: "ipython" };
				yield {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: JSON.stringify({
						code: [
							"from rlm import host_request",
							'response = await host_request("capability.call", {',
							'    "capability": "mnemosyne",',
							'    "tool": "search_documents",',
							'    "args": {"query": "kernel capability lane"},',
							"})",
							'print("kernel capability result", response["result"]["documents"][0])',
							"try:",
							'    await host_request("capability.call", {',
							'        "capability": "mnemosyne",',
							'        "tool": "remember",',
							'        "args": {"content": "must not cross the gate"},',
							"    })",
							'    raise AssertionError("ungranted capability call unexpectedly succeeded")',
							"except RuntimeError as error:",
							'    assert "capability_denied" in str(error)',
							'    print("kernel capability denial capability_denied")',
							'response["result"]["documents"][0]',
						].join("\n"),
					}),
				};
				yield { type: "toolcall_end", contentIndex: 0 };
				yield { type: "done", reason: "toolUse", usage: ZERO_USAGE };
			} else if (state.requestCount === 1) {
				yield { type: "start" };
				yield { type: "toolcall_start", contentIndex: 0, id: "mock-done-after-capability", toolName: "done" };
				yield {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: JSON.stringify({ summary: "Kernel capability lane completed." }),
				};
				yield { type: "toolcall_end", contentIndex: 0 };
				yield { type: "done", reason: "toolUse", usage: ZERO_USAGE };
			} else {
				yield* emitTextSequence("Kernel capability lane completed.");
			}
			state.requestCount++;
			return;
		}

		default:
			throw new Error(`Unsupported mock model: ${modelName}`);
	}
}

async function* emitToolCall(
	id: string,
	toolName: string,
	args: Record<string, unknown>,
): AsyncGenerator<ProxyAssistantMessageEvent> {
	yield { type: "start" };
	yield { type: "toolcall_start", contentIndex: 0, id, toolName };
	yield { type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args) };
	yield { type: "toolcall_end", contentIndex: 0 };
	yield { type: "done", reason: "toolUse", usage: ZERO_USAGE };
}

async function* emitTextSequence(text: string): AsyncGenerator<ProxyAssistantMessageEvent> {
	yield { type: "start" };
	yield { type: "text_start", contentIndex: 0 };
	yield { type: "text_delta", contentIndex: 0, delta: text };
	yield { type: "text_end", contentIndex: 0 };
	yield { type: "done", reason: "stop", usage: ZERO_USAGE };
}

async function* emitAlternatingIpythonStep(
	modelName: string,
	state: MockLlmState,
	steps: readonly { readonly id: string; readonly code: string }[],
): AsyncGenerator<ProxyAssistantMessageEvent> {
	const stepIndex = Math.floor(state.requestCount / 2);
	const step = steps[stepIndex];
	if (state.requestCount % 2 === 0 && step) {
		yield { type: "start" };
		yield { type: "toolcall_start", contentIndex: 0, id: step.id, toolName: "ipython" };
		yield { type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify({ code: step.code }) };
		yield { type: "toolcall_end", contentIndex: 0 };
		yield { type: "done", reason: "toolUse", usage: ZERO_USAGE };
	} else if (step) {
		yield { type: "start" };
		yield {
			type: "toolcall_start",
			contentIndex: 0,
			id: `${step.id}-done`,
			toolName: "done",
		};
		yield {
			type: "toolcall_delta",
			contentIndex: 0,
			delta: JSON.stringify({ summary: `${modelName} step ${String(stepIndex + 1)} completed.` }),
		};
		yield { type: "toolcall_end", contentIndex: 0 };
		yield { type: "done", reason: "toolUse", usage: ZERO_USAGE };
	} else {
		yield* emitTextSequence(`${modelName} scenario completed.`);
	}
	state.requestCount++;
}
