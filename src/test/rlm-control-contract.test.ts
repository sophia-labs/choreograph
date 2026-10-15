import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	parseRlmControlRequest,
	parseRlmDeleteSubagentResult,
	parseRlmHostError,
	parseRlmListSubagentsResult,
	parseRlmSpawnHandle,
	RLM_CHILD_RUN_ID_PATTERN,
	RLM_CHILD_SESSION_ID_PATTERN,
	RLM_CONTROL_LIMITS,
	RLM_HOST_ERROR_CLASSES,
} from "../agent-runtime/rlm-control-contract.js";

const golden = JSON.parse(
	readFileSync(
		new URL("../../packages/sophia-kernel-runtime/contract/rlm-control-contract.json", import.meta.url),
		"utf8",
	),
);

const handle = {
	child_session_id: "ags_abcdef0123456789abcdef01",
	child_run_id: "acr_0123456789abcdef01234567",
	name: "researcher",
	model: "openrouter/model",
};

describe("hosted RLM control contract", () => {
	it("shares one golden vocabulary and limit set with the Python edge", () => {
		assert.deepEqual(RLM_CONTROL_LIMITS, {
			promptUtf8Bytes: golden.limits.prompt_utf8_bytes,
			nameChars: golden.limits.name_chars,
			modelChars: golden.limits.model_chars,
			targetChars: golden.limits.target_chars,
			idChars: golden.limits.id_chars,
			errorCodeChars: golden.limits.error_code_chars,
			errorMessageChars: golden.limits.error_message_chars,
		});
		assert.deepEqual(RLM_HOST_ERROR_CLASSES, golden.host_error_classes);
		assert.equal(RLM_CHILD_SESSION_ID_PATTERN, golden.child_session_id_pattern);
		assert.equal(RLM_CHILD_RUN_ID_PATTERN, golden.child_run_id_pattern);
	});

	it("accepts only the exact four-field admission handle", () => {
		assert.deepEqual(parseRlmSpawnHandle(handle), handle);
		assert.throws(() => parseRlmSpawnHandle({ ...handle, status: "running" }), /non-canonical/);
		for (const invalid of ["ags_child", "ags_ABCDEF0123456789abcdef01", "acr_0123456789abcdef01234567"]) {
			assert.throws(() => parseRlmSpawnHandle({ ...handle, child_session_id: invalid }), /non-canonical/);
		}
		for (const invalid of ["", "acr_short", "acr_0123456789ABCDEF01234567", handle.child_session_id]) {
			assert.throws(
				() => parseRlmSpawnHandle({ ...handle, child_run_id: invalid }),
				/printable ASCII|non-canonical/,
			);
		}
	});

	it("parses exact run, list, and delete requests", () => {
		assert.deepEqual(parseRlmControlRequest({ type: "rlm.run", prompt: "inspect", kwargs: { name: "researcher" } }), {
			type: "rlm.run",
			prompt: "inspect",
			kwargs: { name: "researcher" },
		});
		assert.deepEqual(parseRlmControlRequest({ type: "rlm.list_subagents" }), { type: "rlm.list_subagents" });
		assert.deepEqual(parseRlmControlRequest({ type: "rlm.delete_subagent", target: handle.child_run_id }), {
			type: "rlm.delete_subagent",
			target: handle.child_run_id,
		});
		assert.throws(
			() => parseRlmControlRequest({ type: "rlm.run", prompt: "inspect", kwargs: { authority: "admin" } }),
			/non-canonical/,
		);
		assert.throws(
			() => parseRlmControlRequest({ type: "rlm.run", prompt: "é".repeat(32_769), kwargs: {} }),
			/exceeds 65536/,
		);
		assert.throws(
			() => parseRlmControlRequest({ type: "rlm.run", prompt: "inspect", kwargs: { name: "has space" } }),
			/must match/,
		);
		assert.throws(() => parseRlmControlRequest({ type: "rlm.delete_subagent", target: "x".repeat(257) }), /1\.\.256/);
		for (const target of ["researcher", handle.child_session_id, "ags_child", "acr_short"]) {
			assert.throws(() => parseRlmControlRequest({ type: "rlm.delete_subagent", target }), /immutable child run id/);
		}
	});

	it("keeps claimed and cancelling distinct and rejects legacy statuses", () => {
		const states = ["queued", "claimed", "cancelling", "completed", "failed", "cancelled"] as const;
		const result = parseRlmListSubagentsResult({
			subagents: states.map((run_state, index) => ({
				...handle,
				child_session_id: `ags_${index.toString(16).padStart(24, "0")}`,
				run_state,
				session_state: run_state === "cancelling" ? "closing" : run_state === "failed" ? "faulted" : "open",
			})),
		});
		assert.deepEqual(
			result.subagents.map((entry) => entry.run_state),
			states,
		);
		assert.throws(
			() => parseRlmListSubagentsResult({ subagents: [{ ...handle, status: "completed" }] }),
			/legacy status|non-canonical/,
		);
		assert.throws(
			() => parseRlmListSubagentsResult({ subagents: [{ ...handle, run_state: "running", session_state: "open" }] }),
			/run_state is invalid/,
		);
		assert.throws(
			() => parseRlmListSubagentsResult({ subagents: [{ ...handle, run_state: "claimed", close_state: "open" }] }),
			/legacy close_state/,
		);
		for (const invalidHandle of [
			{ ...handle, child_session_id: "ags_child", run_state: "claimed", session_state: "open" },
			{ ...handle, child_run_id: "acr_short", run_state: "claimed", session_state: "open" },
		]) {
			assert.throws(() => parseRlmListSubagentsResult({ subagents: [invalidHandle] }), /non-canonical/);
		}
	});

	it("accepts only exact cancellation chronology and canonical closure ids", () => {
		for (const prior_run_state of ["queued", "claimed", "cancelling"] as const) {
			const closure = {
				...handle,
				prior_run_state,
				final_run_state: "cancelled",
				session_state: "closed",
				cancellation: "observed",
			};
			assert.deepEqual(parseRlmDeleteSubagentResult({ closure }), { closure });
		}
		for (const prior_run_state of ["completed", "failed", "cancelled"] as const) {
			const closure = {
				...handle,
				prior_run_state,
				final_run_state: prior_run_state,
				session_state: "closed",
				cancellation: "not_required",
			};
			assert.deepEqual(parseRlmDeleteSubagentResult({ closure }), { closure });
		}
		const base = {
			...handle,
			prior_run_state: "claimed",
			final_run_state: "cancelled",
			session_state: "closed",
			cancellation: "observed",
		};
		for (const closure of [
			{ ...base, final_run_state: "claimed" },
			{ ...base, prior_run_state: "completed" },
			{ ...base, cancellation: "not_required", final_run_state: "claimed" },
			{ ...base, prior_run_state: "completed", final_run_state: "failed", cancellation: "not_required" },
			{ ...base, child_session_id: "ags_child" },
			{ ...base, child_run_id: "acr_short" },
		]) {
			assert.throws(() => parseRlmDeleteSubagentResult({ closure }), /chronology|non-canonical/);
		}
		assert.throws(() => parseRlmDeleteSubagentResult({ subagent: { ...handle, status: "error" } }), /non-canonical/);
	});

	it("accepts only structured exact host errors", () => {
		const error = { code: "child_budget_exhausted", class: "denied", message: "No budget", retryable: false };
		assert.deepEqual(parseRlmHostError(error), error);
		assert.throws(() => parseRlmHostError("No budget"), /must be an object/);
		assert.throws(() => parseRlmHostError({ ...error, retryable: "false" }), /must be boolean/);
		assert.throws(() => parseRlmHostError({ ...error, detail: "legacy" }), /non-canonical/);
		assert.throws(() => parseRlmHostError({ ...error, class: "fatal" }), /class is invalid/);
		assert.throws(() => parseRlmHostError({ ...error, code: "bad code" }), /invalid characters/);
		assert.throws(() => parseRlmHostError({ ...error, message: "bad\nmessage" }), /printable ASCII/);
	});
});
