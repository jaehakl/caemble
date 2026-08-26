from __future__ import annotations

import time
from typing import Any

from sdk.slave import DataChannelMessage, SlaveApp, SlaveContext

from app.llm.chat import prepare_chat_messages
from app.llm.models import ChatRequest, LlmRequest
from app.llm.service import generate_chat_answer, generate_llm_answer
from app.logging import log, log_exception
from app.model_catalog import get_model_list_payload


def register_handlers(app: SlaveApp) -> None:
    app.handler("ai.llm")(ai_llm)
    app.handler("ai.chat")(ai_chat)
    app.handler("ai.llm.models")(ai_llm_models)


async def ai_llm_models(
    message: DataChannelMessage,
    memory: dict[str, Any] | None,
    context: SlaveContext,
) -> DataChannelMessage:
    return DataChannelMessage(
        id=message.id,
        type="ai.llm.models.result",
        payload=get_model_list_payload("llm"),
    )


async def ai_llm(
    message: DataChannelMessage,
    memory: dict[str, Any] | None,
    context: SlaveContext,
) -> DataChannelMessage:
    started_at = time.perf_counter()
    try:
        request = LlmRequest.model_validate(message.payload)
        log(
            "ai.llm start "
            f"session={context.session_id} "
            f"system_chars={len(request.system_prompt)} "
            f"prompt_chars={len(request.prompt)} "
            f"max_tokens={request.max_tokens} "
            f"temperature={request.temperature} "
            f"think={request.think} "
            f"thinking_effort={request.thinking_effort} "
            f"response_format={request.response_format}"
        )
        response = await generate_llm_answer(request)
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        log(f"ai.llm complete session={context.session_id} duration_ms={duration_ms} answer_chars={len(response.answer)}")
        return DataChannelMessage(
            id=message.id,
            type="ai.llm.result",
            payload=response.model_dump(),
        )
    except Exception as exc:
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        log_exception(f"ai.llm failed session={context.session_id} duration_ms={duration_ms}", exc)
        raise


async def ai_chat(
    message: DataChannelMessage,
    memory: dict[str, Any] | None,
    context: SlaveContext,
) -> DataChannelMessage:
    started_at = time.perf_counter()
    try:
        request = ChatRequest.model_validate(message.payload)
        state, messages = prepare_chat_messages(memory, context.session_id, request)
        model_name = str(state["model"])
        request.model = model_name
        log(
            "ai.chat start "
            f"session={context.session_id} "
            f"history_messages={len(messages)} "
            f"prompt_chars={len(request.prompt)} "
            f"reference_bytes={len(request.reference_context.encode('utf-8')) if request.reference_context else 0} "
            f"max_tokens={request.max_tokens} "
            f"temperature={request.temperature} "
            f"think={request.think} "
            f"thinking_effort={request.thinking_effort} "
            f"response_format={request.response_format}"
        )

        async def emit_delta(delta: str) -> None:
            await context.emit_event("ai.chat.delta", {"delta": delta})

        response = await generate_chat_answer(request, messages, emit_delta)
        state["messages"] = messages + [{"role": "assistant", "content": response.answer}]
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        log(f"ai.chat complete session={context.session_id} duration_ms={duration_ms} answer_chars={len(response.answer)}")
        return DataChannelMessage(
            id=message.id,
            type="ai.chat.result",
            payload=response.model_dump(),
        )
    except Exception as exc:
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        log_exception(f"ai.chat failed session={context.session_id} duration_ms={duration_ms}", exc)
        raise
