from __future__ import annotations

import asyncio
import hashlib
import json

import pytest
from cryptography.fernet import Fernet

from ai.context import ContextAssembler, ContextBudgetExceeded, ContextItem, ContextPriority
from ai.provider import OpenAIResponsesAdapter
from ai.session import AgentSessionState, SessionEnvelopeCodec, SessionEnvelopeError
from ai.tools import agent_tool_definitions


class FakeStream:
    def __init__(self, events):
        self.events = events
        self.closed = False

    def __aiter__(self):
        self._iterator = iter(self.events)
        return self

    async def __anext__(self):
        try:
            return next(self._iterator)
        except StopIteration:
            raise StopAsyncIteration from None

    async def close(self):
        self.closed = True


class FakeResponses:
    def __init__(self, stream):
        self.stream = stream
        self.request = None

    async def create(self, **request):
        self.request = request
        return self.stream

    async def compact(self, **request):
        self.compact_request = request
        return {"output": [{"type": "compaction", "encrypted_content": "opaque-compact"}]}


class FakeClient:
    def __init__(self, stream):
        self.responses = FakeResponses(stream)
        self.closed = False

    async def close(self):
        self.closed = True


@pytest.mark.asyncio
async def test_openai_adapter_uses_stateless_strict_replay_and_compaction():
    output = [
        {"type": "reasoning", "encrypted_content": "opaque"},
        {
            "type": "function_call",
            "call_id": "call-1",
            "name": "list_experiment_files",
            "arguments": "{}",
        },
    ]
    response = {
        "output": output,
        "usage": {
            "input_tokens": 21,
            "output_tokens": 8,
            "input_tokens_details": {"cached_tokens": 7, "cache_write_tokens": 3},
            "output_tokens_details": {"reasoning_tokens": 4},
        },
    }
    stream = FakeStream(
        [
            {"type": "response.output_text.delta", "delta": "확인 중"},
            {"type": "response.completed", "response": response},
        ]
    )
    client = FakeClient(stream)
    adapter = OpenAIResponsesAdapter("not-used", client=client)
    assert adapter.capabilities.token_counting is False
    assert adapter.capabilities.reasoning_replay is True
    assert adapter.capabilities.reasoning_continuity is True
    assert adapter.capabilities.standalone_compaction is True
    deltas: list[str] = []
    replay = [{"type": "reasoning", "encrypted_content": "previous"}]

    step = await adapter.generate(
        instructions="stable instructions",
        input_items=replay,
        tools=agent_tool_definitions(),
        reasoning_effort="high",
        reasoning_context="all_turns",
        prompt_cache_key="cache-user",
        on_delta=lambda value: _append(deltas, value),
        cancel_event=asyncio.Event(),
    )

    request = client.responses.request
    assert request["input"] is replay
    assert request["instructions"] == "stable instructions"
    assert request["store"] is False
    assert request["parallel_tool_calls"] is False
    assert request["max_tool_calls"] == 64
    assert request["reasoning"] == {"effort": "high", "context": "all_turns"}
    assert request["include"] == ["reasoning.encrypted_content"]
    assert request["context_management"] == [
        {"type": "compaction", "compact_threshold": 160_000}
    ]
    assert request["prompt_cache_key"] == "cache-user"
    assert request["prompt_cache_retention"] == "in_memory"
    assert request["safety_identifier"] == hashlib.sha256(b"cache-user").hexdigest()
    assert all(tool["strict"] is True for tool in request["tools"])
    assert all(tool["parameters"]["additionalProperties"] is False for tool in request["tools"])
    assert step.output_items == output
    assert step.tool_calls[0].arguments == {}
    assert step.usage.cached_tokens == 7
    assert step.usage.cache_write_tokens == 3
    assert deltas == ["확인 중"]
    assert stream.closed is True

    compacted = await adapter.compact(
        instructions="stable instructions",
        input_items=output,
        prompt_cache_key="cache-user",
        cancel_event=asyncio.Event(),
    )
    assert compacted == [{"type": "compaction", "encrypted_content": "opaque-compact"}]
    assert client.responses.compact_request == {
        "model": "gpt-5.6-luna",
        "instructions": "stable instructions",
        "input": output,
        "prompt_cache_key": "cache-user",
        "prompt_cache_retention": "in_memory",
    }


async def _append(target: list[str], value: str) -> None:
    target.append(value)


def test_context_p0_and_p1_use_hard_cap_while_p2_is_omitted_at_normal_budget():
    p0 = ContextItem("p0", ContextPriority.P0, "developer", "a")
    p1 = ContextItem("p1", ContextPriority.P1, "developer", "b")
    p2 = ContextItem("p2", ContextPriority.P2, "user", "c")
    normal = p0.estimated_tokens
    hard = p0.estimated_tokens + p1.estimated_tokens

    assembled = ContextAssembler(normal, hard).assemble([p2, p1, p0])

    assert assembled.included_keys == ("p0", "p1")
    assert assembled.omitted_keys == ("p2",)
    with pytest.raises(ContextBudgetExceeded):
        ContextAssembler(normal, hard - 1).assemble([p0, p1])


def _session_state(**changes):
    values = {
        "user_id": "user-1",
        "provider": "openai",
        "model": "gpt-5.6-luna",
        "credential_fingerprint": "f" * 64,
        "credential_version": 3,
        "active_experiment_id": 11,
        "workspace_session": 7,
        "workspace_hash": "a" * 64,
        "permission_fingerprint": "p" * 64,
        "prompt_tool_version": "caemble-ai-agent-v2",
        "provider_items": [{"type": "message", "role": "user", "content": "hello"}],
    }
    values.update(changes)
    return AgentSessionState(**values)


def _open(codec: SessionEnvelopeCodec, token: str, **changes):
    values = {
        "user_id": "user-1",
        "provider": "openai",
        "model": "gpt-5.6-luna",
        "credential_fingerprint": "f" * 64,
        "credential_version": 3,
        "active_experiment_id": 11,
        "workspace_session": 7,
        "workspace_hash": "a" * 64,
        "permission_fingerprint": "p" * 64,
        "prompt_tool_version": "caemble-ai-agent-v2",
    }
    values.update(changes)
    return codec.open(token, **values)


def test_session_envelope_round_trip_tamper_and_all_bindings():
    codec = SessionEnvelopeCodec([Fernet.generate_key()])
    token = codec.seal(_session_state())

    assert _open(codec, token).provider_items[0]["content"] == "hello"
    with pytest.raises(SessionEnvelopeError):
        _open(codec, token[:-1] + ("A" if token[-1] != "A" else "B"))
    for change in (
        {"user_id": "user-2"},
        {"credential_version": 4},
        {"active_experiment_id": 12},
        {"workspace_session": 8},
        {"workspace_hash": "b" * 64},
        {"permission_fingerprint": "q" * 64},
        {"prompt_tool_version": "next"},
    ):
        with pytest.raises(SessionEnvelopeError):
            _open(codec, token, **change)


def test_session_envelope_rejects_expired_and_oversized_working_memory():
    codec = SessionEnvelopeCodec([Fernet.generate_key()])
    raw = json.dumps(_session_state().as_dict(), separators=(",", ":")).encode()
    expired = codec._fernet._fernets[0].encrypt_at_time(raw, current_time=1).decode()  # noqa: SLF001

    with pytest.raises(SessionEnvelopeError):
        _open(codec, expired)
    with pytest.raises(SessionEnvelopeError):
        codec.seal(_session_state(working_memory={"blob": "x" * (2 * 1024 * 1024)}))
