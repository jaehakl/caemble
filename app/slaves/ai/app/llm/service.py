from __future__ import annotations

from collections.abc import Awaitable, Callable

from app.llm.chat import generate_chat_with_llm
from app.llm.models import ChatRequest, ChatResponse, LlmRequest, LlmResponse
from app.llm.runtime import ask_llm
from app.model_catalog import get_selected_model_name


async def generate_llm_answer(request: LlmRequest) -> LlmResponse:
    model_name = get_selected_model_name("llm", request.model)
    answer = await ask_llm(
        request.system_prompt,
        request.prompt,
        model_name=model_name,
        max_tokens=request.max_tokens,
        temperature=request.temperature,
        context_size=request.context_size,
        top_p=request.top_p,
        enable_thinking=request.think,
        thinking_effort=request.thinking_effort,
        response_format_json=request.response_format == "json",
    )
    return LlmResponse(model=model_name, answer=answer)


async def generate_chat_answer(
    request: ChatRequest,
    messages: list[dict[str, str]],
    on_delta: Callable[[str], Awaitable[None]],
) -> ChatResponse:
    model_name = get_selected_model_name("llm", request.model)
    result = await generate_chat_with_llm(
        messages,
        model_name=model_name,
        max_tokens=request.max_tokens,
        temperature=request.temperature,
        context_size=request.context_size,
        top_p=request.top_p,
        enable_thinking=request.think,
        thinking_effort=request.thinking_effort,
        response_format=request.response_format,
        on_delta=on_delta,
    )
    return ChatResponse(
        model=model_name,
        answer=result.answer,
        context_window=result.context_window,
        prompt_tokens=result.prompt_tokens,
        max_response_tokens=result.max_response_tokens,
        remaining_tokens=result.remaining_tokens,
        cache_enabled=result.cache_enabled,
    )
