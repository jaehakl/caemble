from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from openai import AsyncOpenAI, OpenAIError
from pydantic import SecretStr

from app.llm.chat import ChatGenerationResult, build_reference_generation_messages
from app.llm.generation import GenerationOutputParser, ResponseFormat, ThinkingEffort, resolve_thinking
from app.model_catalog import OpenAiLlmModelConfig


async def ask_openai(
    model: OpenAiLlmModelConfig,
    api_key: SecretStr,
    system_message: str,
    question: str,
    *,
    max_tokens: int | None = None,
    temperature: float | None = None,
    context_size: int | None = None,
    top_p: float | None = None,
    enable_thinking: bool | None = None,
    thinking_effort: ThinkingEffort = "default",
    response_format_json: bool = False,
) -> str:
    trimmed_system_message = system_message.strip()
    trimmed_question = question.strip()
    if not trimmed_system_message:
        raise ValueError("system_message is required")
    if not trimmed_question:
        raise ValueError("question is required")

    effective_thinking = resolve_thinking(model.enable_thinking, enable_thinking)
    request_kwargs: dict[str, Any] = {
        "model": model.model_id,
        "input": [
            {"role": "system", "content": trimmed_system_message},
            {"role": "user", "content": trimmed_question},
        ],
        "store": False,
        "max_output_tokens": model.max_tokens if max_tokens is None else max_tokens,
        "temperature": model.temperature if temperature is None else temperature,
        "top_p": model.top_p if top_p is None else top_p,
        "reasoning": {
            "effort": "none" if not effective_thinking else ("low" if thinking_effort == "low" else "medium")
        },
    }
    if response_format_json:
        request_kwargs["text"] = {"format": {"type": "json_object"}}
    try:
        async with AsyncOpenAI(api_key=api_key.get_secret_value()) as client:
            response = await client.responses.create(**request_kwargs)
    except OpenAIError as exc:
        parts = [f"OpenAI request failed ({type(exc).__name__})"]
        if isinstance(getattr(exc, "status_code", None), int):
            parts.append(f"status={exc.status_code}")
        if isinstance(getattr(exc, "request_id", None), str) and exc.request_id:
            parts.append(f"request_id={exc.request_id}")
        raise RuntimeError("; ".join(parts)) from None

    parser = GenerationOutputParser(
        expect_reasoning=False,
        response_format="json" if response_format_json else "text",
    )
    parser.feed(response.output_text if isinstance(response.output_text, str) else "")
    return parser.finish(model.name).answer


async def generate_chat_with_openai(
    model: OpenAiLlmModelConfig,
    api_key: SecretStr,
    messages: list[dict[str, str]],
    *,
    max_tokens: int | None = None,
    temperature: float | None = None,
    context_size: int | None = None,
    top_p: float | None = None,
    enable_thinking: bool | None = None,
    thinking_effort: ThinkingEffort = "default",
    response_format: ResponseFormat = "text",
    on_delta: Callable[[str], Awaitable[None]] | None = None,
    reference_context: str | None = None,
) -> ChatGenerationResult:
    effective_context_size = model.context_size if context_size is None else context_size
    effective_max_tokens = model.max_tokens if max_tokens is None else max_tokens
    effective_thinking = resolve_thinking(model.enable_thinking, enable_thinking)
    generation_messages = build_reference_generation_messages(messages, reference_context)
    request_kwargs: dict[str, Any] = {
        "model": model.model_id,
        "input": generation_messages,
        "store": False,
        "max_output_tokens": effective_max_tokens,
        "temperature": model.temperature if temperature is None else temperature,
        "top_p": model.top_p if top_p is None else top_p,
        "reasoning": {
            "effort": "none" if not effective_thinking else ("low" if thinking_effort == "low" else "medium")
        },
    }
    if response_format == "json":
        request_kwargs["text"] = {"format": {"type": "json_object"}}
    parser = GenerationOutputParser(expect_reasoning=False, response_format=response_format)
    completed_response: Any | None = None

    try:
        async with AsyncOpenAI(api_key=api_key.get_secret_value()) as client:
            stream = await client.responses.create(**request_kwargs, stream=True)
            async for event in stream:
                event_type = getattr(event, "type", "")
                if event_type == "response.output_text.delta":
                    delta = getattr(event, "delta", "")
                    if not isinstance(delta, str) or not delta:
                        continue
                    final_delta = parser.feed(delta)
                    if on_delta is not None and final_delta:
                        await on_delta(final_delta)
                elif event_type == "response.completed":
                    completed_response = getattr(event, "response", None)
                elif event_type in {"error", "response.failed"}:
                    raise RuntimeError("OpenAI response failed")
    except OpenAIError as exc:
        parts = [f"OpenAI request failed ({type(exc).__name__})"]
        if isinstance(getattr(exc, "status_code", None), int):
            parts.append(f"status={exc.status_code}")
        if isinstance(getattr(exc, "request_id", None), str) and exc.request_id:
            parts.append(f"request_id={exc.request_id}")
        raise RuntimeError("; ".join(parts)) from None

    output = parser.finish(model.name)
    if on_delta is not None and output.pending_delta:
        await on_delta(output.pending_delta)

    usage = getattr(completed_response, "usage", None)
    prompt_tokens = max(0, int(getattr(usage, "input_tokens", 0) or 0))
    output_tokens = max(0, int(getattr(usage, "output_tokens", 0) or 0))
    input_details = getattr(usage, "input_tokens_details", None)
    cached_tokens = max(0, int(getattr(input_details, "cached_tokens", 0) or 0))
    max_response_tokens = max(0, min(effective_max_tokens, effective_context_size - prompt_tokens))
    remaining_tokens = max(0, effective_context_size - prompt_tokens - output_tokens)
    return ChatGenerationResult(
        answer=output.answer,
        context_window=effective_context_size,
        prompt_tokens=prompt_tokens,
        max_response_tokens=max_response_tokens,
        remaining_tokens=remaining_tokens,
        cache_enabled=cached_tokens > 0,
    )
