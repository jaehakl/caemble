from __future__ import annotations

from pydantic import BaseModel


class EmbeddingRequest(BaseModel):
    model: str | None = None
    text: str



class EmbeddingResponse(BaseModel):
    model: str
    embedding: list[float]
    dimensions: int


class EmbeddingBatchRequest(BaseModel):
    model: str | None = None
    texts: list[str]

class EmbeddingBatchResponse(BaseModel):
    model: str
    embeddings: list[list[float]]
    dimensions: int
    count: int
