from __future__ import annotations

from typing import Annotated, Any

from pydantic import BaseModel, Field


class VoicevoxAudioQueryRequest(BaseModel):
    text: str
    speaker: int
    preload_speakers: list[Annotated[int, Field(strict=True, ge=0, le=0xffffffff)]] | None = Field(
        default=None, min_length=1,
    )


class VoicevoxSynthesisRequest(BaseModel):
    audio_query: dict[str, Any]
    speaker: int
    enable_interrogative_upspeak: bool | None = None
