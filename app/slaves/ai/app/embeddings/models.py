from __future__ import annotations

from pydantic import BaseModel, field_validator


EMBEDDING_TEXT_MAX_BYTES = 128 * 1024
EMBEDDING_BATCH_MAX_ITEMS = 32


class EmbeddingRequest(BaseModel):
    model: str | None = None
    text: str

    @field_validator("text")
    @classmethod
    def validate_text_size(cls, value: str) -> str:
        if len(value.encode("utf-8")) > EMBEDDING_TEXT_MAX_BYTES:
            raise ValueError(f"Embedding text exceeds {EMBEDDING_TEXT_MAX_BYTES} bytes")
        return value


class EmbeddingResponse(BaseModel):
    model: str
    embedding: list[float]
    dimensions: int


class EmbeddingBatchRequest(BaseModel):
    model: str | None = None
    texts: list[str]

    @field_validator("texts")
    @classmethod
    def validate_texts(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError("texts must contain at least one item")
        if len(value) > EMBEDDING_BATCH_MAX_ITEMS:
            raise ValueError(f"texts must contain at most {EMBEDDING_BATCH_MAX_ITEMS} items")
        if any(not text.strip() for text in value):
            raise ValueError("texts must not contain empty items")
        if sum(len(text.encode("utf-8")) for text in value) > EMBEDDING_TEXT_MAX_BYTES:
            raise ValueError(f"Embedding texts exceed {EMBEDDING_TEXT_MAX_BYTES} bytes in total")
        return value


class EmbeddingBatchResponse(BaseModel):
    model: str
    embeddings: list[list[float]]
    dimensions: int
    count: int
