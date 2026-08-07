from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator


class VoicevoxAudioQueryRequest(BaseModel):
    text: str = Field(min_length=1)
    speaker: int = Field(ge=0, le=4_294_967_295)

    @field_validator("text")
    @classmethod
    def reject_surrogates(cls, value: str) -> str:
        if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
            raise ValueError("VOICEVOX text contains invalid Unicode surrogate characters")
        return value


class VoicevoxSynthesisRequest(BaseModel):
    audio_query: dict[str, Any]
    speaker: int = Field(ge=0, le=4_294_967_295)
    enable_interrogative_upspeak: bool | None = None
