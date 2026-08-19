from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal, Protocol

from ai.models import ReasoningEffort


DeltaCallback = Callable[[str], Awaitable[None]]


class ProviderError(RuntimeError):
    """A provider failure whose text is safe to return to the browser."""

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        retryable: bool = False,
        request_id: str | None = None,
        status_code: int | None = None,
        upstream_code: str | None = None,
        parameter: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.request_id = request_id
        self.status_code = status_code
        self.upstream_code = upstream_code
        self.parameter = parameter

    def public_data(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "code": self.code or "provider_request_failed",
            "message": str(self),
            "retryable": self.retryable,
        }
        if self.request_id is not None:
            result["providerRequestId"] = self.request_id
        return result


@dataclass(frozen=True)
class ProviderCapabilities:
    provider: str
    model: str
    server_storage: bool
    token_counting: bool
    reasoning_replay: bool
    reasoning_continuity: bool
    native_compaction: bool
    standalone_compaction: bool
    prompt_caching: bool
    streaming: bool
    supported_state_modes: tuple[str, ...]
    selected_state_mode: str


@dataclass(frozen=True)
class ProviderToolCall:
    call_id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class ProviderUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    cached_tokens: int = 0
    cache_write_tokens: int = 0
    reasoning_tokens: int = 0


@dataclass(frozen=True)
class ProviderStep:
    text: str
    output_items: list[dict[str, Any]]
    tool_calls: list[ProviderToolCall]
    usage: ProviderUsage = field(default_factory=ProviderUsage)
    compacted: bool = False


class ProviderAdapter(Protocol):
    capabilities: ProviderCapabilities

    async def generate(
        self,
        *,
        instructions: str,
        input_items: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        reasoning_effort: ReasoningEffort,
        reasoning_context: Literal["current_turn", "all_turns"],
        prompt_cache_key: str,
        on_delta: DeltaCallback,
        cancel_event: asyncio.Event,
    ) -> ProviderStep: ...

    async def compact(
        self,
        *,
        instructions: str,
        input_items: list[dict[str, Any]],
        prompt_cache_key: str,
        cancel_event: asyncio.Event,
    ) -> list[dict[str, Any]]: ...

    async def close(self) -> None: ...


class OpenAIResponsesAdapter:
    capabilities = ProviderCapabilities(
        provider="openai",
        model="gpt-5.6-luna",
        server_storage=False,
        token_counting=False,
        reasoning_replay=True,
        reasoning_continuity=True,
        native_compaction=True,
        standalone_compaction=True,
        prompt_caching=True,
        streaming=True,
        supported_state_modes=("replay",),
        selected_state_mode="replay",
    )

    def __init__(self, api_key: str, *, client: Any | None = None):
        if client is None:
            try:
                from openai import AsyncOpenAI
            except ImportError as error:  # pragma: no cover - deployment dependency
                raise ProviderError("OpenAI provider support is unavailable") from error
            client = AsyncOpenAI(api_key=api_key, timeout=120.0, max_retries=2)
        self._client = client

    async def generate(
        self,
        *,
        instructions: str,
        input_items: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        reasoning_effort: ReasoningEffort,
        reasoning_context: Literal["current_turn", "all_turns"],
        prompt_cache_key: str,
        on_delta: DeltaCallback,
        cancel_event: asyncio.Event,
    ) -> ProviderStep:
        _validate_strict_tools(tools)
        request: dict[str, Any] = {
            "model": self.capabilities.model,
            "instructions": instructions,
            "input": input_items,
            "store": False,
            "stream": True,
            "max_output_tokens": 16_000,
            "reasoning": {"effort": reasoning_effort, "context": reasoning_context},
            "include": ["reasoning.encrypted_content"],
            "context_management": [
                {"type": "compaction", "compact_threshold": 160_000}
            ],
            "prompt_cache_key": prompt_cache_key,
            "prompt_cache_options": {"mode": "implicit", "ttl": "30m"},
            "safety_identifier": hashlib.sha256(prompt_cache_key.encode("utf-8")).hexdigest(),
        }
        if tools:
            request.update(
                tools=tools,
                tool_choice="auto",
                parallel_tool_calls=False,
                max_tool_calls=64,
            )
        stream: Any = None
        completed_response: Any = None
        try:
            stream = await self._client.responses.create(**request)
            async for event in stream:
                if cancel_event.is_set():
                    raise asyncio.CancelledError
                event_type = _read(event, "type")
                if event_type == "response.output_text.delta":
                    delta = _read(event, "delta")
                    if isinstance(delta, str) and delta:
                        await on_delta(delta)
                elif event_type == "response.completed":
                    completed_response = _read(event, "response")
                elif event_type in {"response.failed", "response.incomplete"}:
                    response = _read(event, "response")
                    detail = _read(response, "error")
                    raise ProviderError(
                        "OpenAI could not complete this Agent step.",
                        code="provider_request_failed",
                        upstream_code=_safe_field(_read(detail, "code")),
                        parameter=_safe_field(_read(detail, "param")),
                    )
            if completed_response is None:
                completed_response = await _final_response(stream)
        except asyncio.CancelledError:
            raise
        except ProviderError:
            raise
        except Exception as error:
            raise _openai_provider_error(error) from error
        finally:
            if stream is not None:
                await _close_stream(stream)

        if completed_response is None:
            raise ProviderError("The model returned no completed response")
        output_items = [
            _as_json(item) for item in (_read(completed_response, "output") or [])
        ]
        tool_calls = [_tool_call(item) for item in output_items if item.get("type") == "function_call"]
        return ProviderStep(
            text=_response_text(completed_response, output_items),
            output_items=output_items,
            tool_calls=tool_calls,
            usage=_usage(_read(completed_response, "usage")),
            compacted=any(item.get("type") == "compaction" for item in output_items),
        )

    async def compact(
        self,
        *,
        instructions: str,
        input_items: list[dict[str, Any]],
        prompt_cache_key: str,
        cancel_event: asyncio.Event,
    ) -> list[dict[str, Any]]:
        if cancel_event.is_set():
            raise asyncio.CancelledError
        try:
            response = await self._client.responses.compact(
                model=self.capabilities.model,
                instructions=instructions,
                input=input_items,
                prompt_cache_key=prompt_cache_key,
                prompt_cache_options={"mode": "implicit", "ttl": "30m"},
            )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            raise _openai_provider_error(error) from error
        if cancel_event.is_set():
            raise asyncio.CancelledError
        output_items = [_as_json(item) for item in (_read(response, "output") or [])]
        if not output_items or not any(item.get("type") == "compaction" for item in output_items):
            raise ProviderError("The OpenAI context compaction response is invalid")
        return output_items

    async def close(self) -> None:
        close = getattr(self._client, "close", None)
        if close is not None:
            result = close()
            if inspect.isawaitable(result):
                await result


def create_provider_adapter(provider: str, model: str, api_key: str) -> ProviderAdapter:
    factory = _PROVIDER_ADAPTERS.get((provider, model))
    if factory is None:
        raise ProviderError("The selected AI provider or model is not supported")
    if factory.capabilities.server_storage:
        raise ProviderError("The selected provider cannot guarantee stateless Agent execution")
    return factory(api_key)


_PROVIDER_ADAPTERS = {
    ("openai", "gpt-5.6-luna"): OpenAIResponsesAdapter,
}


def _openai_provider_error(error: Exception) -> ProviderError:
    status_code = getattr(error, "status_code", None)
    status_code = status_code if isinstance(status_code, int) else None
    request_id = _safe_field(getattr(error, "request_id", None))
    body = getattr(error, "body", None)
    detail = body.get("error", body) if isinstance(body, dict) else None
    upstream_code = _safe_field(_read(detail, "code"))
    upstream_type = _safe_field(_read(detail, "type"))
    parameter = _safe_field(_read(detail, "param"))
    error_name = type(error).__name__

    if error_name == "APITimeoutError" or isinstance(error, TimeoutError):
        return ProviderError(
            "The OpenAI request timed out.",
            code="provider_timeout",
            retryable=True,
            request_id=request_id,
            status_code=status_code,
            upstream_code=upstream_code,
            parameter=parameter,
        )
    if error_name == "APIConnectionError":
        return ProviderError(
            "Caemble could not connect to OpenAI.",
            code="provider_unavailable",
            retryable=True,
            request_id=request_id,
            status_code=status_code,
            upstream_code=upstream_code,
            parameter=parameter,
        )
    if status_code == 401:
        code = "provider_authentication_failed"
        message = "The configured OpenAI API key was rejected."
        retryable = False
    elif status_code in {403, 404}:
        code = "provider_access_denied"
        message = "The OpenAI project cannot access the selected model."
        retryable = False
    elif status_code == 429 and {upstream_code, upstream_type}.intersection(
        {
            "billing_hard_limit_reached",
            "insufficient_quota",
            "usage_limit_reached",
        }
    ):
        code = "provider_quota_exceeded"
        message = "The OpenAI project has no available API quota."
        retryable = False
    elif status_code == 429:
        code = "provider_rate_limited"
        message = "The OpenAI rate limit was reached."
        retryable = True
    elif status_code in {400, 409, 422}:
        code = "provider_invalid_request"
        message = "OpenAI rejected the request parameters."
        retryable = False
    elif status_code is not None and status_code >= 500:
        code = "provider_unavailable"
        message = "OpenAI is temporarily unavailable."
        retryable = True
    else:
        code = "provider_request_failed"
        message = "The OpenAI request failed."
        retryable = False
    return ProviderError(
        message,
        code=code,
        retryable=retryable,
        request_id=request_id,
        status_code=status_code,
        upstream_code=upstream_code,
        parameter=parameter,
    )


def _safe_field(value: Any) -> str | None:
    if not isinstance(value, str) or not value or len(value) > 128:
        return None
    if not all(character.isalnum() or character in "._-[]" for character in value):
        return None
    return value


def _validate_strict_tools(tools: list[dict[str, Any]]) -> None:
    for tool in tools:
        parameters = tool.get("parameters")
        if (
            tool.get("type") != "function"
            or tool.get("strict") is not True
            or not isinstance(parameters, dict)
            or parameters.get("additionalProperties") is not False
        ):
            raise ProviderError("Agent tool definitions must use strict schemas")


def _tool_call(item: dict[str, Any]) -> ProviderToolCall:
    call_id = item.get("call_id")
    name = item.get("name")
    raw_arguments = item.get("arguments")
    if not isinstance(call_id, str) or not call_id or not isinstance(name, str) or not name:
        raise ProviderError("The model returned an invalid tool call")
    try:
        arguments = json.loads(raw_arguments) if isinstance(raw_arguments, str) else raw_arguments
    except json.JSONDecodeError as error:
        raise ProviderError("The model returned invalid tool arguments") from error
    if not isinstance(arguments, dict):
        raise ProviderError("The model returned invalid tool arguments")
    return ProviderToolCall(call_id=call_id, name=name, arguments=arguments)


def _response_text(response: Any, output_items: list[dict[str, Any]]) -> str:
    direct = _read(response, "output_text")
    if isinstance(direct, str):
        return direct
    chunks: list[str] = []
    for item in output_items:
        if item.get("type") != "message":
            continue
        for content in item.get("content", []):
            if isinstance(content, dict) and content.get("type") == "output_text":
                text = content.get("text")
                if isinstance(text, str):
                    chunks.append(text)
    return "".join(chunks)


def _usage(value: Any) -> ProviderUsage:
    input_details = _read(value, "input_tokens_details")
    output_details = _read(value, "output_tokens_details")
    return ProviderUsage(
        input_tokens=_integer(_read(value, "input_tokens")),
        output_tokens=_integer(_read(value, "output_tokens")),
        cached_tokens=_integer(_read(input_details, "cached_tokens")),
        cache_write_tokens=_integer(_read(input_details, "cache_write_tokens")),
        reasoning_tokens=_integer(_read(output_details, "reasoning_tokens")),
    )


def _integer(value: Any) -> int:
    return value if isinstance(value, int) and value >= 0 else 0


def _read(value: Any, name: str) -> Any:
    if isinstance(value, dict):
        return value.get(name)
    return getattr(value, name, None)


def _as_json(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    dump = getattr(value, "model_dump", None)
    if dump is None:
        raise ProviderError("The model returned an unsupported response item")
    result = dump(mode="json", exclude_none=True)
    if not isinstance(result, dict):
        raise ProviderError("The model returned an unsupported response item")
    return result


async def _final_response(stream: Any) -> Any:
    getter = getattr(stream, "get_final_response", None)
    if getter is None:
        return None
    result = getter()
    return await result if inspect.isawaitable(result) else result


async def _close_stream(stream: Any) -> None:
    close = getattr(stream, "close", None) or getattr(stream, "aclose", None)
    if close is None:
        return
    result = close()
    if inspect.isawaitable(result):
        await result
