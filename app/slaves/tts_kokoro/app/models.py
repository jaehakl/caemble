from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class SynthesisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=2000)
    voice: Literal["af_heart"] = "af_heart"
    speed: float = Field(default=1.0, ge=0.5, le=2.0, allow_inf_nan=False)

    @field_validator("text")
    @classmethod
    def require_speech(cls, text: str) -> str:
        if not text.strip() or not any(character.isalnum() for character in text):
            raise ValueError("Text must contain speech")
        return text
