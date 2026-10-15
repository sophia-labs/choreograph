"""Sophia's canonical kernel-side RLM control and harness surface."""

from __future__ import annotations

import asyncio
import re
import sys
import types
from dataclasses import dataclass
from typing import Any, Literal

from .harness import HarnessEntry, HarnessScope, HarnessState, RefinementEvent, get_harness_state

try:
    from ipykernel.comm import Comm
except Exception:  # pragma: no cover - depends on ipykernel version
    Comm = None  # type: ignore[assignment]

try:
    from IPython import get_ipython
except Exception:  # pragma: no cover - only available in kernels
    get_ipython = None  # type: ignore[assignment]

HOST_COMM_TARGET = "host.request"
_host_replay_fixtures: list[dict[str, Any]] | None = None
_host_replay_cursor = 0


@dataclass(frozen=True)
class RLMSpawnHandle:
    child_session_id: str
    child_run_id: str
    name: str
    model: str


@dataclass(frozen=True)
class RLMModel:
    provider: str
    id: str
    name: str
    selector: str


@dataclass(frozen=True)
class RLMSubagent:
    child_session_id: str
    child_run_id: str
    name: str
    model: str
    run_state: Literal["queued", "claimed", "cancelling", "completed", "failed", "cancelled"]
    session_state: Literal["open", "closing", "faulted"]


@dataclass(frozen=True)
class RLMSubagentClosure:
    child_session_id: str
    child_run_id: str
    name: str
    model: str
    prior_run_state: Literal["queued", "claimed", "cancelling", "completed", "failed", "cancelled"]
    final_run_state: Literal["queued", "claimed", "cancelling", "completed", "failed", "cancelled"]
    session_state: Literal["closed"]
    cancellation: Literal["observed", "not_required"]


class RLMHostError(RuntimeError):
    """Structured, non-lossy failure returned by the Sophia host."""

    def __init__(
        self,
        *,
        code: str,
        error_class: str,
        message: str,
        retryable: bool,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.error_class = error_class
        self.retryable = retryable


_RUN_STATES = {"queued", "claimed", "cancelling", "completed", "failed", "cancelled"}
_OPEN_SESSION_STATES = {"open", "closing", "faulted"}
_HOST_ERROR_CLASSES = {"invalid", "denied", "conflict", "not_found", "unavailable", "internal"}
_MAX_PROMPT_BYTES = 65_536
_MAX_NAME_CHARS = 64
_MAX_MODEL_CHARS = 256
_MAX_TARGET_CHARS = 256
_MAX_ID_CHARS = 256
_MAX_ERROR_CODE_CHARS = 128
_MAX_ERROR_MESSAGE_CHARS = 4_096
_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
_ERROR_CODE_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+$")
_CHILD_SESSION_ID_PATTERN = re.compile(r"^ags_[0-9a-f]{24}$")
_CHILD_RUN_ID_PATTERN = re.compile(r"^acr_[0-9a-f]{24}$")
_LIVE_RUN_STATES = {"queued", "claimed", "cancelling"}
_TERMINAL_RUN_STATES = {"completed", "failed", "cancelled"}


def _bounded_printable(value: Any, *, field: str, maximum: int) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise RuntimeError(f"{field} must be a non-empty printable string of at most {maximum} characters")
    if any(ord(character) < 0x20 or ord(character) > 0x7E for character in value):
        raise RuntimeError(f"{field} must be a non-empty printable string of at most {maximum} characters")
    return value


def _bounded_name(value: Any, *, field: str) -> str:
    name = _bounded_printable(value, field=field, maximum=_MAX_NAME_CHARS)
    if _NAME_PATTERN.fullmatch(name) is None:
        raise RuntimeError(f"{field} must match [A-Za-z0-9_-]+")
    return name


def _bounded_model(value: Any, *, field: str) -> str:
    return _bounded_printable(value, field=field, maximum=_MAX_MODEL_CHARS)


def _canonical_child_session_id(value: Any, *, field: str) -> str:
    child_session_id = _bounded_printable(value, field=field, maximum=_MAX_ID_CHARS)
    if _CHILD_SESSION_ID_PATTERN.fullmatch(child_session_id) is None:
        raise RuntimeError(f"{field} is non-canonical")
    return child_session_id


def _canonical_child_run_id(value: Any, *, field: str) -> str:
    child_run_id = _bounded_printable(value, field=field, maximum=_MAX_ID_CHARS)
    if _CHILD_RUN_ID_PATTERN.fullmatch(child_run_id) is None:
        raise RuntimeError(f"{field} is non-canonical")
    return child_run_id


def _host_error(value: Any, request_type: str) -> RLMHostError:
    if not isinstance(value, dict):
        raise RuntimeError(f"host request {request_type} returned invalid unstructured error testimony")
    if set(value) != {"code", "class", "message", "retryable"}:
        raise RuntimeError(f"host request {request_type} returned non-canonical structured error testimony")
    code = _bounded_printable(
        value.get("code"),
        field=f"host request {request_type} error code",
        maximum=_MAX_ERROR_CODE_CHARS,
    )
    error_class = value.get("class")
    message = _bounded_printable(
        value.get("message"),
        field=f"host request {request_type} error message",
        maximum=_MAX_ERROR_MESSAGE_CHARS,
    )
    retryable = value.get("retryable")
    if _ERROR_CODE_PATTERN.fullmatch(code) is None:
        raise RuntimeError(f"host request {request_type} returned an invalid structured error code")
    if error_class not in _HOST_ERROR_CLASSES:
        raise RuntimeError(f"host request {request_type} returned an invalid structured error class")
    if not isinstance(retryable, bool):
        raise RuntimeError(f"host request {request_type} returned an invalid structured error retryable flag")
    return RLMHostError(
        code=code,
        error_class=error_class,
        message=message,
        retryable=retryable,
    )


def _install_control_comm_handlers() -> None:
    """Let comm replies arrive on the control channel during an execute_request."""
    if get_ipython is None:
        return
    shell = get_ipython()
    kernel = getattr(shell, "kernel", None)
    comm_manager = getattr(kernel, "comm_manager", None)
    control_handlers = getattr(kernel, "control_handlers", None)
    if comm_manager is None or not isinstance(control_handlers, dict):
        return
    control_handlers.setdefault("comm_msg", comm_manager.comm_msg)
    control_handlers.setdefault("comm_close", comm_manager.comm_close)


def _spawn_handle_from_payload(payload: Any) -> RLMSpawnHandle:
    if not isinstance(payload, dict):
        raise RuntimeError("rlm.run returned an invalid spawn handle")
    if set(payload) != {"child_session_id", "child_run_id", "name", "model"}:
        raise RuntimeError("rlm.run returned a non-canonical spawn handle")
    child_session_id = _canonical_child_session_id(payload.get("child_session_id"), field="rlm.run child_session_id")
    child_run_id = _canonical_child_run_id(payload.get("child_run_id"), field="rlm.run child_run_id")
    name = _bounded_name(payload.get("name"), field="rlm.run name")
    model = _bounded_model(payload.get("model"), field="rlm.run model")
    return RLMSpawnHandle(
        child_session_id=child_session_id,
        child_run_id=child_run_id,
        name=name,
        model=model,
    )


async def host_request(request_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Send a typed request to the Sophia host and await its reply.

    This is the kernel side of the generic host bridge: Python skills call
    ``await host_request("<type>", {...})`` and the TypeScript host dispatches
    on the type. Raises RuntimeError when the host reports an error or when no
    handler for the type is registered in this session.
    """
    if not isinstance(request_type, str) or not request_type:
        raise TypeError("request_type must be a non-empty str")
    if payload is not None and not isinstance(payload, dict):
        raise TypeError(f"payload must be a dict or None, got {type(payload).__name__}")
    replay = _consume_host_replay_fixture(request_type, payload or {})
    if replay is not None:
        if replay.get("ok") is True:
            result = replay.get("result")
            if not isinstance(result, dict):
                raise RuntimeError("Sophia replay divergence: recorded host result is not a dict")
            return result
        raise _host_error(replay.get("error"), request_type)
    if Comm is None:
        raise RuntimeError("Jupyter comm support is unavailable in this kernel")
    _install_control_comm_handlers()

    loop = asyncio.get_running_loop()
    future: asyncio.Future[dict[str, Any]] = loop.create_future()
    comm = Comm(target_name=HOST_COMM_TARGET, primary=False)

    def _on_msg(msg: dict[str, Any]) -> None:
        content = msg.get("content", {})
        reply = content.get("data", {}) if isinstance(content, dict) else {}
        if not isinstance(reply, dict):
            return

        status = reply.get("status")
        if status == "ok":

            def _resolve_result() -> None:
                if not future.done():
                    future.set_result({k: v for k, v in reply.items() if k != "status"})
                    comm.close()

            loop.call_soon_threadsafe(_resolve_result)
            return
        if status == "error":
            host_error: Exception
            try:
                host_error = _host_error(reply.get("error"), request_type)
            except Exception as error:
                host_error = error

            def _resolve_error() -> None:
                if not future.done():
                    future.set_exception(host_error)
                    comm.close()

            loop.call_soon_threadsafe(_resolve_error)
            return

        unexpected = f"host request {request_type} returned unexpected status: {status!r}"

        def _resolve_unexpected() -> None:
            if not future.done():
                future.set_exception(RuntimeError(unexpected))
                comm.close()

        loop.call_soon_threadsafe(_resolve_unexpected)

    comm.on_msg(_on_msg)
    # request_type goes last so a payload "type" key cannot reroute the request.
    comm.open(data={**(payload or {}), "type": request_type})
    return await future


def begin_host_replay(fixtures: list[dict[str, Any]]) -> None:
    """Install the exact host testimony for one replayed execution cell."""
    global _host_replay_fixtures, _host_replay_cursor
    if not isinstance(fixtures, list) or not all(isinstance(item, dict) for item in fixtures):
        raise TypeError("fixtures must be a list of dicts")
    if _host_replay_fixtures is not None:
        raise RuntimeError("Sophia replay divergence: a fixture scope is already active")
    _host_replay_fixtures = fixtures
    _host_replay_cursor = 0


def end_host_replay() -> dict[str, int]:
    """Close a replay scope, failing if testimony was not consumed exactly."""
    global _host_replay_fixtures, _host_replay_cursor
    fixtures = _host_replay_fixtures
    if fixtures is None:
        raise RuntimeError("Sophia replay divergence: no fixture scope is active")
    consumed = _host_replay_cursor
    remaining = len(fixtures) - consumed
    _host_replay_fixtures = None
    _host_replay_cursor = 0
    if remaining:
        raise RuntimeError(f"Sophia replay divergence: {remaining} recorded host request(s) were not consumed")
    return {"consumed": consumed, "remaining": 0}


def _consume_host_replay_fixture(request_type: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    global _host_replay_cursor
    fixtures = _host_replay_fixtures
    if fixtures is None:
        return None
    if _host_replay_cursor >= len(fixtures):
        raise RuntimeError("Sophia replay divergence: execution made an unrecorded host request")
    fixture = fixtures[_host_replay_cursor]
    expected = fixture.get("payload")
    actual = {**payload, "type": request_type}
    if expected != actual:
        raise RuntimeError(
            f"Sophia replay divergence: host request {_host_replay_cursor} differs "
            f"(expected {expected!r}, got {actual!r})"
        )
    _host_replay_cursor += 1
    return fixture


async def run(prompt: str, *, name: str | None = None, model: str | None = None) -> RLMSpawnHandle:
    """Spawn a recursive Sophia child and return once its task is admitted.

    ``model`` selects a child with an exact ``provider/model`` selector.
    """
    if not isinstance(prompt, str):
        raise TypeError(f"prompt must be str, got {type(prompt).__name__}")
    if not prompt.strip() or len(prompt.encode("utf-8")) > _MAX_PROMPT_BYTES:
        raise ValueError(f"prompt must be non-empty and at most {_MAX_PROMPT_BYTES} UTF-8 bytes")
    kwargs: dict[str, str] = {}
    if name is not None:
        if not isinstance(name, str):
            raise TypeError(f"name must be str or None, got {type(name).__name__}")
        try:
            kwargs["name"] = _bounded_name(name, field="name")
        except RuntimeError as error:
            raise ValueError(str(error)) from error
    if model is not None:
        if not isinstance(model, str):
            raise TypeError(f"model must be str or None, got {type(model).__name__}")
        try:
            kwargs["model"] = _bounded_model(model, field="model")
        except RuntimeError as error:
            raise ValueError(str(error)) from error
    payload = await host_request("rlm.run", {"prompt": prompt, "kwargs": kwargs})
    return _spawn_handle_from_payload(payload)


def _model_from_payload(payload: Any) -> RLMModel:
    if not isinstance(payload, dict):
        raise RuntimeError("rlm.find_models returned an invalid model entry")
    provider = payload.get("provider")
    model_id = payload.get("id")
    name = payload.get("name")
    selector = payload.get("selector")
    if not all(isinstance(value, str) and value for value in (provider, model_id, name, selector)):
        raise RuntimeError("rlm.find_models returned an invalid model entry")
    return RLMModel(provider=provider, id=model_id, name=name, selector=selector)


async def find_models(query: str = "", limit: int = 8) -> list[RLMModel]:
    """Search a bounded list of models backed by active user credentials."""
    if not isinstance(query, str):
        raise TypeError(f"query must be str, got {type(query).__name__}")
    if not isinstance(limit, int):
        raise TypeError(f"limit must be int, got {type(limit).__name__}")
    payload = await host_request("rlm.find_models", {"query": query, "limit": limit})
    models = payload.get("models")
    if not isinstance(models, list):
        raise RuntimeError("rlm.find_models returned an invalid models list")
    return [_model_from_payload(model) for model in models]


def _subagent_from_payload(payload: Any, operation: str = "rlm.list_subagents") -> RLMSubagent:
    if not isinstance(payload, dict):
        raise RuntimeError(f"{operation} returned an invalid subagent entry")
    expected_keys = {"child_session_id", "child_run_id", "name", "model", "run_state", "session_state"}
    if set(payload) != expected_keys:
        if "status" in payload:
            raise RuntimeError(f"{operation} entry uses legacy status")
        if "close_state" in payload:
            raise RuntimeError(f"{operation} entry uses legacy close_state")
        raise RuntimeError(f"{operation} entry has non-canonical fields")
    child_session_id = _canonical_child_session_id(
        payload.get("child_session_id"), field=f"{operation} child_session_id"
    )
    child_run_id = _canonical_child_run_id(payload.get("child_run_id"), field=f"{operation} child_run_id")
    name = _bounded_name(payload.get("name"), field=f"{operation} name")
    model = _bounded_model(payload.get("model"), field=f"{operation} model")
    run_state = payload.get("run_state")
    session_state = payload.get("session_state")
    if run_state not in _RUN_STATES:
        raise RuntimeError(f"{operation} entry has invalid run_state")
    if session_state not in _OPEN_SESSION_STATES:
        raise RuntimeError(f"{operation} entry has invalid session_state")
    return RLMSubagent(
        child_session_id=child_session_id,
        child_run_id=child_run_id,
        name=name,
        model=model,
        run_state=run_state,
        session_state=session_state,
    )


def _closure_from_payload(payload: Any) -> RLMSubagentClosure:
    operation = "rlm.delete_subagent"
    if not isinstance(payload, dict):
        raise RuntimeError(f"{operation} returned an invalid closure receipt")
    expected_keys = {
        "child_session_id",
        "child_run_id",
        "name",
        "model",
        "prior_run_state",
        "final_run_state",
        "session_state",
        "cancellation",
    }
    if set(payload) != expected_keys:
        if "status" in payload or "error" in payload or "close_state" in payload:
            raise RuntimeError(f"{operation} returned a legacy closure receipt")
        raise RuntimeError(f"{operation} closure has non-canonical fields")
    required_strings: dict[str, str] = {
        "child_session_id": _canonical_child_session_id(
            payload.get("child_session_id"), field=f"{operation} child_session_id"
        ),
        "child_run_id": _canonical_child_run_id(payload.get("child_run_id"), field=f"{operation} child_run_id"),
        "name": _bounded_name(payload.get("name"), field=f"{operation} name"),
        "model": _bounded_model(payload.get("model"), field=f"{operation} model"),
    }
    prior_run_state = payload.get("prior_run_state")
    final_run_state = payload.get("final_run_state")
    session_state = payload.get("session_state")
    cancellation = payload.get("cancellation")
    if prior_run_state not in _RUN_STATES:
        raise RuntimeError(f"{operation} closure has invalid prior_run_state")
    if final_run_state not in _RUN_STATES:
        raise RuntimeError(f"{operation} closure has invalid final_run_state")
    if session_state != "closed":
        raise RuntimeError(f"{operation} closure has invalid session_state")
    if cancellation not in {"observed", "not_required"}:
        raise RuntimeError(f"{operation} closure has invalid cancellation")
    if cancellation == "observed":
        if prior_run_state not in _LIVE_RUN_STATES or final_run_state != "cancelled":
            raise RuntimeError(f"{operation} observed cancellation has invalid chronology")
    elif prior_run_state not in _TERMINAL_RUN_STATES or final_run_state != prior_run_state:
        raise RuntimeError(f"{operation} not_required cancellation has invalid chronology")
    return RLMSubagentClosure(
        child_session_id=required_strings["child_session_id"],
        child_run_id=required_strings["child_run_id"],
        name=required_strings["name"],
        model=required_strings["model"],
        prior_run_state=prior_run_state,
        final_run_state=final_run_state,
        session_state="closed",
        cancellation=cancellation,
    )


async def list_subagents() -> list[RLMSubagent]:
    """List direct RLM children retained by the current parent session."""
    payload = await host_request("rlm.list_subagents")
    if set(payload) != {"subagents"}:
        raise RuntimeError("rlm.list_subagents returned a non-canonical registry")
    entries = payload.get("subagents")
    if not isinstance(entries, list):
        raise RuntimeError("rlm.list_subagents returned an invalid subagents registry")
    return [_subagent_from_payload(entry) for entry in entries]


async def delete_subagent(target: str | RLMSpawnHandle | RLMSubagent) -> RLMSubagentClosure:
    """Cancel when necessary, then durably close one direct child."""
    if isinstance(target, (RLMSpawnHandle, RLMSubagent)):
        selector = target.child_run_id
    elif isinstance(target, str):
        selector = target.strip()
        if not selector:
            raise ValueError("target must not be empty")
    else:
        raise TypeError(f"target must be str, RLMSpawnHandle, or RLMSubagent, got {type(target).__name__}")
    try:
        selector = _bounded_printable(selector, field="target", maximum=_MAX_TARGET_CHARS)
    except RuntimeError as error:
        raise ValueError(str(error)) from error
    if _CHILD_RUN_ID_PATTERN.fullmatch(selector) is None:
        raise ValueError("target must be an immutable child run id matching ^acr_[0-9a-f]{24}$")
    payload = await host_request("rlm.delete_subagent", {"target": selector})
    if set(payload) != {"closure"}:
        raise RuntimeError("rlm.delete_subagent returned a non-canonical result")
    return _closure_from_payload(payload.get("closure"))


class _HarnessProxy:
    """Resolve the harness state against the current environment on every access.

    The kernel forkserver preimports rlm in a template process before per-session
    env vars exist; a state bound at import time would freeze that (env-less)
    resolution into every forked kernel. Resolving per access picks up the env
    applied after fork. Resolution must never raise (a failure inside the kernel
    namespace would take down the kernel). When the local store is genuinely
    unconfigured (no session env, e.g. --no-session) reads see an empty view but
    local writes raise instructively instead of vanishing on kernel exit; any
    other resolution failure degrades to a shared in-memory store until local
    resolution starts succeeding.
    """

    _fallback: HarnessState | None = None
    _unpersisted: HarnessState | None = None

    def _resolve(self) -> HarnessState:
        try:
            return get_harness_state()
        except RuntimeError as exc:
            if "Local harness state requires" in str(exc):
                if _HarnessProxy._unpersisted is None:
                    _HarnessProxy._unpersisted = HarnessState(
                        in_memory=True,
                        local_write_error=(
                            f"{exc} This session has no persistent local harness store; "
                            "pass global_=True to persist across sessions."
                        ),
                    )
                return _HarnessProxy._unpersisted
            return self._degraded()
        except Exception:  # pragma: no cover - harness access must never raise
            return self._degraded()

    @staticmethod
    def _degraded() -> HarnessState:
        if _HarnessProxy._fallback is None:
            _HarnessProxy._fallback = HarnessState(in_memory=True)
        return _HarnessProxy._fallback

    def __getattr__(self, name: str) -> Any:
        return getattr(self._resolve(), name)

    def __repr__(self) -> str:
        return repr(self._resolve())


_harness_state = _HarnessProxy()


class _RLMCallable:
    harness = _harness_state
    get_harness_state = staticmethod(get_harness_state)

    async def run(self, prompt: str, *, name: str | None = None, model: str | None = None) -> RLMSpawnHandle:
        return await run(prompt, name=name, model=model)

    async def find_models(self, query: str = "", limit: int = 8) -> list[RLMModel]:
        return await find_models(query, limit)

    async def list_subagents(self) -> list[RLMSubagent]:
        return await list_subagents()

    async def delete_subagent(self, target: str | RLMSpawnHandle | RLMSubagent) -> RLMSubagentClosure:
        return await delete_subagent(target)

    async def __call__(self, prompt: str, *, name: str | None = None, model: str | None = None) -> RLMSpawnHandle:
        return await run(prompt, name=name, model=model)


rlm = _RLMCallable()
harness = _harness_state


class _CallableModule(types.ModuleType):
    async def __call__(
        self,
        prompt: str,
        *,
        name: str | None = None,
        model: str | None = None,
    ) -> RLMSpawnHandle:
        return await run(prompt, name=name, model=model)


sys.modules[__name__].__class__ = _CallableModule

__all__ = [
    "HarnessEntry",
    "HarnessScope",
    "HarnessState",
    "McpIntegration",
    "McpToolError",
    "NotEnabled",
    "RLMHostError",
    "RLMModel",
    "RLMSpawnHandle",
    "RLMSubagent",
    "RLMSubagentClosure",
    "RefinementEvent",
    "begin_host_replay",
    "delete_subagent",
    "end_host_replay",
    "find_models",
    "get_harness_state",
    "harness",
    "host_request",
    "list_subagents",
    "rlm",
    "run",
]

# Lazily re-export the MCP base class. Kept lazy so `import rlm` never requires
# the optional `mcp` SDK — only integration packages that subclass it do.
_LAZY_MCP = {"McpIntegration", "McpToolError", "NotEnabled"}


def __getattr__(name: str) -> Any:  # noqa: D401 - module-level lazy attr hook
    if name in _LAZY_MCP:
        from . import mcp_base

        return getattr(mcp_base, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
