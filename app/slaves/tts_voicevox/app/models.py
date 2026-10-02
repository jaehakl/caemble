from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class VoicevoxAudioQueryRequest(BaseModel):
    text: str
    speaker: int


class VoicevoxSynthesisRequest(BaseModel):
    audio_query: dict[str, Any]
    speaker: int
    enable_interrogative_upspeak: bool | None = None
