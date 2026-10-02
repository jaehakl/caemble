from __future__ import annotations

import asyncio
from typing import Any

from sdk.slave import DataChannelAttachment, DataChannelMessage, SlaveApp, SlaveContext

from app.models import SynthesisRequest
from app.runtime import get_runtime


async def synthesis(message: DataChannelMessage, memory: Any, context: SlaveContext) -> DataChannelMessage:
    request = SynthesisRequest.model_validate(message.payload)
    wav, metadata = await asyncio.to_thread(
        get_runtime().synthesize, request.text, request.voice, request.speed,
    )
    attachment = DataChannelAttachment(id="audio-1", name="kokoro.wav",
        mimeType="audio/wav", size=len(wav), data=wav)
    return DataChannelMessage(id=message.id, type="ai.kokoro.synthesis.result",
        payload={"attachment_id": attachment.id, "mime_type": "audio/wav", "size": len(wav),
                 **metadata}, attachments=[attachment])


def create_app() -> SlaveApp:
    app = SlaveApp(memory={})
    app.handler("ai.kokoro.synthesis")(synthesis)

    @app.initialize
    async def initialize(memory: Any, context: SlaveContext) -> None:
        await asyncio.to_thread(get_runtime)

    return app
