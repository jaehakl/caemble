from __future__ import annotations

import time
from typing import Any

from sdk.slave import DataChannelMessage, SlaveApp, SlaveContext

from app.logging import log, log_exception
from app.message import reject_request_attachments
from app.vision.models import ClipTextRequest, VisionImageRequest
from app.vision.service import analyze_clip_text, analyze_image


def register_handlers(app: SlaveApp) -> None:
    app.handler("ai.clip.image")(ai_clip_image)
    app.handler("ai.clip.text")(ai_clip_text)
    app.handler("ai.wd14.tags")(ai_wd14_tags)


async def ai_clip_image(
    message: DataChannelMessage,
    memory: dict[str, Any] | None,
    context: SlaveContext,
) -> DataChannelMessage:
    started_at = time.perf_counter()
    try:
        VisionImageRequest.model_validate(message.payload)
        log(f"ai.clip.image start session={context.session_id} attachments={len(message.attachments)}")
        response = await analyze_image("clip", message.attachments)
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        log(
            "ai.clip.image complete "
            f"session={context.session_id} duration_ms={duration_ms} dimensions={response.dimensions}"
        )
        return DataChannelMessage(
            id=message.id,
            type="ai.clip.image.result",
            payload=response.model_dump(),
        )
    except Exception as exc:
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        log_exception(f"ai.clip.image failed session={context.session_id} duration_ms={duration_ms}", exc)
        raise


async def ai_clip_text(
    message: DataChannelMessage,
    memory: dict[str, Any] | None,
    context: SlaveContext,
) -> DataChannelMessage:
    started_at = time.perf_counter()
    try:
        reject_request_attachments(message)
        request = ClipTextRequest.model_validate(message.payload)
        log(f"ai.clip.text start session={context.session_id} text_chars={len(request.text)}")
        response = await analyze_clip_text(request)
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        log(
            "ai.clip.text complete "
            f"session={context.session_id} duration_ms={duration_ms} dimensions={response.dimensions}"
        )
        return DataChannelMessage(
            id=message.id,
            type="ai.clip.text.result",
            payload=response.model_dump(),
        )
    except Exception as exc:
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        log_exception(f"ai.clip.text failed session={context.session_id} duration_ms={duration_ms}", exc)
        raise


async def ai_wd14_tags(
    message: DataChannelMessage,
    memory: dict[str, Any] | None,
    context: SlaveContext,
) -> DataChannelMessage:
    started_at = time.perf_counter()
    try:
        VisionImageRequest.model_validate(message.payload)
        log(f"ai.wd14.tags start session={context.session_id} attachments={len(message.attachments)}")
        response = await analyze_image("wd14", message.attachments)
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        log(
            "ai.wd14.tags complete "
            f"session={context.session_id} duration_ms={duration_ms} keywords={len(response.keywords)}"
        )
        return DataChannelMessage(
            id=message.id,
            type="ai.wd14.tags.result",
            payload=response.model_dump(),
        )
    except Exception as exc:
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        log_exception(f"ai.wd14.tags failed session={context.session_id} duration_ms={duration_ms}", exc)
        raise
