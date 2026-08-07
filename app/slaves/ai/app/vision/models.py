from __future__ import annotations

from pydantic import BaseModel, field_validator


CLIP_MODEL_NAME = "OpenAI CLIP ViT-L/14"
WD14_MODEL_REPO = "SmilingWolf/wd-eva02-large-tagger-v3"
VISION_IMAGE_MAX_BYTES = 20 * 1024 * 1024
CLIP_TEXT_MAX_BYTES = 128 * 1024


class VisionImageRequest(BaseModel):
    pass


class ClipTextRequest(BaseModel):
    text: str

    @field_validator("text")
    @classmethod
    def validate_text_size(cls, value: str) -> str:
        if len(value.encode("utf-8")) > CLIP_TEXT_MAX_BYTES:
            raise ValueError(f"CLIP text exceeds {CLIP_TEXT_MAX_BYTES} bytes")
        return value


class ClipEmbeddingResponse(BaseModel):
    model: str
    embedding: list[float]
    dimensions: int


class Wd14TagsResponse(BaseModel):
    model: str
    prompt: str
    keywords: list[str]
