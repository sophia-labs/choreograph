from __future__ import annotations

import asyncio
import importlib
import json
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

rlm_module = importlib.import_module("rlm")
CHILD_SESSION_ID = "ags_abcdef0123456789abcdef01"
CHILD_RUN_ID = "acr_0123456789abcdef01234567"


def handle_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "child_session_id": CHILD_SESSION_ID,
        "child_run_id": CHILD_RUN_ID,
        "name": "researcher",
        "model": "openrouter/model",
    }
    payload.update(overrides)
    return payload


def subagent_payload(**overrides: object) -> dict[str, object]:
    payload = handle_payload(run_state="claimed", session_state="open")
    payload.update(overrides)
    return payload


def closure_payload(**overrides: object) -> dict[str, object]:
    payload = handle_payload(
        prior_run_state="claimed",
        final_run_state="cancelled",
        session_state="closed",
        cancellation="observed",
    )
    payload.update(overrides)
    return payload


class RlmControlContractTest(unittest.TestCase):
    def test_golden_vocabulary_and_limits_match_python_validators(self) -> None:
        contract = json.loads(
            (Path(__file__).parents[1] / "contract" / "rlm-control-contract.json").read_text(encoding="utf-8")
        )
        self.assertEqual(set(contract["run_states"]), rlm_module._RUN_STATES)
        self.assertEqual(set(contract["open_session_states"]), rlm_module._OPEN_SESSION_STATES)
        self.assertEqual(set(contract["host_error_classes"]), rlm_module._HOST_ERROR_CLASSES)
        self.assertEqual(contract["child_session_id_pattern"], rlm_module._CHILD_SESSION_ID_PATTERN.pattern)
        self.assertEqual(contract["child_run_id_pattern"], rlm_module._CHILD_RUN_ID_PATTERN.pattern)
        self.assertEqual(contract["limits"]["prompt_utf8_bytes"], rlm_module._MAX_PROMPT_BYTES)
        self.assertEqual(contract["limits"]["name_chars"], rlm_module._MAX_NAME_CHARS)
        self.assertEqual(contract["limits"]["model_chars"], rlm_module._MAX_MODEL_CHARS)
        self.assertEqual(contract["limits"]["target_chars"], rlm_module._MAX_TARGET_CHARS)
        self.assertEqual(contract["limits"]["id_chars"], rlm_module._MAX_ID_CHARS)
        self.assertEqual(contract["limits"]["error_code_chars"], rlm_module._MAX_ERROR_CODE_CHARS)
        self.assertEqual(contract["limits"]["error_message_chars"], rlm_module._MAX_ERROR_MESSAGE_CHARS)

    def test_run_returns_only_the_opaque_admission_handle(self) -> None:
        host_request = AsyncMock(return_value=handle_payload())
        with patch.object(rlm_module, "host_request", host_request):
            handle = asyncio.run(rlm_module.run("inspect", name="researcher", model="openrouter/model"))

        self.assertEqual(handle.child_session_id, CHILD_SESSION_ID)
        self.assertEqual(handle.child_run_id, CHILD_RUN_ID)
        self.assertEqual(handle.name, "researcher")
        self.assertEqual(handle.model, "openrouter/model")
        host_request.assert_awaited_once_with(
            "rlm.run",
            {"prompt": "inspect", "kwargs": {"name": "researcher", "model": "openrouter/model"}},
        )

    def test_run_rejects_noncanonical_handle_fields(self) -> None:
        host_request = AsyncMock(return_value=handle_payload(status="running"))
        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "non-canonical spawn handle"):
                asyncio.run(rlm_module.run("inspect"))

    def test_run_enforces_bounded_inputs_and_handle_fields(self) -> None:
        invalid_calls = [
            {"prompt": ""},
            {"prompt": "é" * 32_769},
            {"prompt": "inspect", "name": "has space"},
            {"prompt": "inspect", "name": "a" * 65},
            {"prompt": "inspect", "model": "bad\nmodel"},
            {"prompt": "inspect", "model": "m" * 257},
        ]
        for call in invalid_calls:
            with self.assertRaises((ValueError, RuntimeError)):
                asyncio.run(rlm_module.run(**call))

        for override in [
            {"child_session_id": "bad\nid"},
            {"child_session_id": "ags_child"},
            {"child_session_id": "ags_ABCDEF0123456789abcdef01"},
            {"child_run_id": "acr_short"},
            {"child_run_id": "acr_0123456789ABCDEF01234567"},
        ]:
            host_request = AsyncMock(return_value=handle_payload(**override))
            with patch.object(rlm_module, "host_request", host_request):
                with self.assertRaisesRegex(RuntimeError, "printable|non-canonical"):
                    asyncio.run(rlm_module.run("inspect"))

    def test_list_accepts_every_durable_run_and_open_session_state(self) -> None:
        entries = [
            subagent_payload(run_state=run_state, session_state=session_state, child_session_id=f"ags_{index:024x}")
            for index, (run_state, session_state) in enumerate(
                [
                    ("queued", "open"),
                    ("claimed", "open"),
                    ("cancelling", "closing"),
                    ("completed", "open"),
                    ("failed", "faulted"),
                    ("cancelled", "closing"),
                ]
            )
        ]
        host_request = AsyncMock(return_value={"subagents": entries})
        with patch.object(rlm_module, "host_request", host_request):
            listed = asyncio.run(rlm_module.list_subagents())

        self.assertEqual(
            [entry.run_state for entry in listed],
            ["queued", "claimed", "cancelling", "completed", "failed", "cancelled"],
        )
        self.assertEqual(listed[2].session_state, "closing")
        self.assertEqual(listed[4].session_state, "faulted")

    def test_list_rejects_noncanonical_handle_ids(self) -> None:
        for override in [
            {"child_session_id": "ags_child"},
            {"child_run_id": "acr_short"},
        ]:
            host_request = AsyncMock(return_value={"subagents": [subagent_payload(**override)]})
            with patch.object(rlm_module, "host_request", host_request):
                with self.assertRaisesRegex(RuntimeError, "non-canonical"):
                    asyncio.run(rlm_module.list_subagents())

    def test_list_rejects_legacy_status_and_error_shapes(self) -> None:
        for legacy in [
            handle_payload(status="completed"),
            handle_payload(status="error"),
        ]:
            host_request = AsyncMock(return_value={"subagents": [legacy]})
            with patch.object(rlm_module, "host_request", host_request):
                with self.assertRaisesRegex(RuntimeError, "legacy status"):
                    asyncio.run(rlm_module.list_subagents())

    def test_list_rejects_unknown_fields_and_noncanonical_envelope(self) -> None:
        host_request = AsyncMock(return_value={"subagents": [subagent_payload(extra=True)]})
        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "non-canonical fields"):
                asyncio.run(rlm_module.list_subagents())

        host_request = AsyncMock(return_value={"subagents": [], "cursor": None})
        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "non-canonical registry"):
                asyncio.run(rlm_module.list_subagents())

    def test_delete_by_handle_returns_a_distinct_terminal_closure(self) -> None:
        handle = rlm_module.RLMSpawnHandle(CHILD_SESSION_ID, CHILD_RUN_ID, "researcher", "openrouter/model")
        host_request = AsyncMock(return_value={"closure": closure_payload()})
        with patch.object(rlm_module, "host_request", host_request):
            closure = asyncio.run(rlm_module.delete_subagent(handle))

        self.assertIsInstance(closure, rlm_module.RLMSubagentClosure)
        self.assertEqual(closure.prior_run_state, "claimed")
        self.assertEqual(closure.final_run_state, "cancelled")
        self.assertEqual(closure.session_state, "closed")
        self.assertEqual(closure.cancellation, "observed")
        host_request.assert_awaited_once_with("rlm.delete_subagent", {"target": CHILD_RUN_ID})

    def test_delete_accepts_only_exact_cancellation_chronology(self) -> None:
        for prior_run_state in ("queued", "claimed", "cancelling"):
            payload = closure_payload(prior_run_state=prior_run_state)
            host_request = AsyncMock(return_value={"closure": payload})
            with patch.object(rlm_module, "host_request", host_request):
                closure = asyncio.run(rlm_module.delete_subagent(CHILD_RUN_ID))
            self.assertEqual(closure.final_run_state, "cancelled")
            self.assertEqual(closure.cancellation, "observed")

        for terminal_run_state in ("completed", "failed", "cancelled"):
            payload = closure_payload(
                prior_run_state=terminal_run_state,
                final_run_state=terminal_run_state,
                cancellation="not_required",
            )
            host_request = AsyncMock(return_value={"closure": payload})
            with patch.object(rlm_module, "host_request", host_request):
                closure = asyncio.run(rlm_module.delete_subagent(CHILD_RUN_ID))
            self.assertEqual(closure.final_run_state, terminal_run_state)
            self.assertEqual(closure.cancellation, "not_required")

    def test_delete_rejects_false_cancellation_and_legacy_receipts(self) -> None:
        invalid = [
            closure_payload(final_run_state="claimed"),
            closure_payload(prior_run_state="completed"),
            closure_payload(prior_run_state="claimed", cancellation="not_required"),
            closure_payload(prior_run_state="completed", final_run_state="failed", cancellation="not_required"),
            closure_payload(child_session_id="ags_child"),
            closure_payload(child_run_id="acr_short"),
            handle_payload(status="running"),
            handle_payload(error="failure"),
            closure_payload(close_state="closed"),
        ]
        for receipt in invalid:
            host_request = AsyncMock(return_value={"closure": receipt})
            with patch.object(rlm_module, "host_request", host_request):
                with self.assertRaises(RuntimeError):
                    asyncio.run(rlm_module.delete_subagent(CHILD_RUN_ID))

    def test_delete_rejects_names_and_session_ids_as_ambiguous_selectors(self) -> None:
        for target in ["researcher", CHILD_SESSION_ID, "ags_child", "acr_short"]:
            with self.assertRaisesRegex(ValueError, "immutable child run id"):
                asyncio.run(rlm_module.delete_subagent(target))

    def test_structured_host_error_survives_replay_without_stringification(self) -> None:
        rlm_module.begin_host_replay(
            [
                {
                    "payload": {"type": "rlm.run", "prompt": "denied", "kwargs": {}},
                    "ok": False,
                    "error": {
                        "code": "child_budget_exhausted",
                        "class": "denied",
                        "message": "No remaining child budget",
                        "retryable": False,
                    },
                }
            ]
        )
        try:
            with self.assertRaises(rlm_module.RLMHostError) as raised:
                asyncio.run(rlm_module.run("denied"))
            self.assertEqual(raised.exception.code, "child_budget_exhausted")
            self.assertEqual(raised.exception.error_class, "denied")
            self.assertFalse(raised.exception.retryable)
            self.assertEqual(str(raised.exception), "No remaining child budget")
        finally:
            self.assertEqual(rlm_module.end_host_replay(), {"consumed": 1, "remaining": 0})

    def test_malformed_structured_host_error_fails_closed(self) -> None:
        rlm_module.begin_host_replay(
            [
                {
                    "payload": {"type": "rlm.run", "prompt": "denied", "kwargs": {}},
                    "ok": False,
                    "error": {"code": "denied", "message": "missing class", "retryable": False},
                }
            ]
        )
        try:
            with self.assertRaisesRegex(RuntimeError, "non-canonical structured error testimony"):
                asyncio.run(rlm_module.run("denied"))
        finally:
            self.assertEqual(rlm_module.end_host_replay(), {"consumed": 1, "remaining": 0})

    def test_structured_host_error_rejects_unknown_class_and_bounds(self) -> None:
        base = {
            "code": "child_budget_exhausted",
            "class": "denied",
            "message": "No remaining child budget",
            "retryable": False,
        }
        for invalid in [
            {**base, "class": "fatal"},
            {**base, "code": "bad code"},
            {**base, "message": "bad\nmessage"},
            {**base, "legacy": True},
        ]:
            with self.assertRaises(RuntimeError):
                rlm_module._host_error(invalid, "rlm.run")

    def test_unstructured_host_error_is_rejected(self) -> None:
        rlm_module.begin_host_replay(
            [
                {
                    "payload": {"type": "rlm.run", "prompt": "denied", "kwargs": {}},
                    "ok": False,
                    "error": "legacy string error",
                }
            ]
        )
        try:
            with self.assertRaisesRegex(RuntimeError, "invalid unstructured error testimony"):
                asyncio.run(rlm_module.run("denied"))
        finally:
            self.assertEqual(rlm_module.end_host_replay(), {"consumed": 1, "remaining": 0})


if __name__ == "__main__":
    unittest.main()
