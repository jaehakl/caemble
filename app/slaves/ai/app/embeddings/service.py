from __future__ import annotations

from app.embeddings.models import (
    EmbeddingBatchRequest,
    EmbeddingBatchResponse,
    EmbeddingRequest,
    EmbeddingResponse,
)
from app.embeddings.runtime import encode_cut_text, encode_cut_texts
from app.model_catalog import resolve_embedding_model


async def generate_embedding(request: EmbeddingRequest) -> EmbeddingResponse:
    text = request.text.strip()
    model, model_source, revision = resolve_embedding_model(request.model)

    try:
        embedding = await encode_cut_text(
            model_source,
            text,
            revision=revision,
            local_files_only=model.local_files_only,
        )
    except Exception as exc:
        raise RuntimeError(f"Embedding generation failed: {exc}") from exc

    return EmbeddingResponse(model=model.name, embedding=embedding, dimensions=len(embedding))


async def generate_embeddings(request: EmbeddingBatchRequest) -> EmbeddingBatchResponse:
    texts = [text.strip() for text in request.texts]
    model, model_source, revision = resolve_embedding_model(request.model)

    try:
        embeddings = await encode_cut_texts(
            model_source,
            texts,
            revision=revision,
            local_files_only=model.local_files_only,
        )
    except Exception as exc:
        raise RuntimeError(f"Embedding batch generation failed: {exc}") from exc

    dimensions = len(embeddings[0]) if embeddings else 0
    return EmbeddingBatchResponse(
        model=model.name,
        embeddings=embeddings,
        dimensions=dimensions,
        count=len(embeddings),
    )
