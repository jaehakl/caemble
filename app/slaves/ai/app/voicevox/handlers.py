from __future__ import annotations

import asyncio
import time
from typing import Any

from sdk.slave import DataChannelAttachment, DataChannelMessage, SlaveApp, SlaveContext

from app.logging import log, log_exception
from app.message import reject_request_attachments
from app.voicevox.models import VoicevoxAudioQueryRequest, VoicevoxSynthesisRequest
from app.voicevox.runtime import get_voicevox_runtime


def register_handlers(app: SlaveApp) -> None:
    app.handler("ai.voicevox.speakers")(ai_voicevox_speakers)
    app.handler("ai.voicevox.audio_query")(ai_voicevox_audio_query)
    app.handler("ai.voicevox.synthesis")(ai_voicevox_synthesis)


async def ai_voicevox_speakers(
    message: DataChannelMessage,
    memory: dict[str, Any] | None,
    context: SlaveContext,
) -> DataChannelMessage:
    started_at = time.perf_counter()
    try:
        reject_request_attachments(message)
        speakers = await asyncio.to_thread(get_voicevox_runtime().speakers)
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        log(
            "ai.voicevox.speakers complete "
            f"session={context.session_id} duration_ms={duration_ms} speakers={len(speakers)}"
        )
        return DataChannelMessage(
            id=message.id,
            type="ai.voicevox.speakers.result",
            payload={"speakers": speakers},
        )
    except Exception as exc:
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        log_exception(f"ai.voicevox.speakers failed session={context.session_id} duration_ms={duration_ms}", exc)
        raise


async def ai_voicevox_audio_query(
    message: DataChannelMessage,
    memory: dict[str, Any] | None,
    context: SlaveContext,
) -> DataChannelMessage:
    started_at = time.perf_counter()
    try:
        reject_request_attachments(message)
        request = VoicevoxAudioQueryRequest.model_validate(message.payload)
        log(
            "ai.voicevox.audio_query start "
            f"session={context.session_id} text_chars={len(request.text)} speaker={request.speaker}"
        )
        audio_query = await asyncio.to_thread(
            get_voicevox_runtime().create_audio_query,
            request.text,
            request.speaker,
        )
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        log(f"ai.voicevox.audio_query complete session={context.session_id} duration_ms={duration_ms}")
        return DataChannelMessage(
            id=message.id,
            type="ai.voicevox.audio_query.result",
            payload={"audio_query": audio_query},
        )
    except Exception as exc:
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        log_exception(f"ai.voicevox.audio_query failed session={context.session_id} duration_ms={duration_ms}", exc)
        raise


async def ai_voicevox_synthesis(
    message: DataChannelMessage,
    memory: dict[str, Any] | None,
    context: SlaveContext,
) -> DataChannelMessage:
    started_at = time.perf_counter()
    try:
        reject_request_attachments(message)
        request = VoicevoxSynthesisRequest.model_validate(message.payload)
        log(f"ai.voicevox.synthesis start session={context.session_id} speaker={request.speaker}")
        wav = await asyncio.to_thread(
            get_voicevox_runtime().synthesis,
            request.audio_query,
            request.speaker,
            request.enable_interrogative_upspeak,
        )
        attachment_id = "audio-1"
        attachment = DataChannelAttachment(
            id=attachment_id,
            name="voicevox.wav",
            mimeType="audio/wav",
            size=len(wav),
            data=wav,
        )
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        log(
            "ai.voicevox.synthesis complete "
            f"session={context.session_id} duration_ms={duration_ms} bytes={len(wav)}"
        )
        return DataChannelMessage(
            id=message.id,
            type="ai.voicevox.synthesis.result",
            payload={
                "attachment_id": attachment_id,
                "mime_type": "audio/wav",
                "size": len(wav),
            },
            attachments=[attachment],
        )
    except Exception as exc:
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        log_exception(f"ai.voicevox.synthesis failed session={context.session_id} duration_ms={duration_ms}", exc)
        raise
