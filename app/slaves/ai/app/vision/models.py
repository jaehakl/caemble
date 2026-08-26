from __future__ import annotations

from pydantic import BaseModel


CLIP_MODEL_NAME = "OpenAI CLIP ViT-L/14"
WD14_MODEL_REPO = "SmilingWolf/wd-eva02-large-tagger-v3"


class VisionImageRequest(BaseModel):
    pass


class ClipTextRequest(BaseModel):
    text: str

class ClipEmbeddingResponse(BaseModel):
    model: str
    embedding: list[float]
    dimensions: int


class Wd14TagsResponse(BaseModel):
    model: str
    prompt: str
    keywords: list[str]
