from __future__ import annotations

import time
from typing import Any

from sdk.slave import DataChannelMessage, SlaveApp, SlaveContext

from app.embeddings.models import EmbeddingBatchRequest, EmbeddingRequest
from app.embeddings.service import generate_embedding, generate_embeddings
from app.logging import log, log_exception
from app.model_catalog import get_model_list_payload


def register_handlers(app: SlaveApp) -> None:
    app.handler("ai.embeddings")(ai_embeddings)
    app.handler("ai.embeddings.batch")(ai_embeddings_batch)
    app.handler("ai.embeddings.models")(ai_embedding_models)


async def ai_embedding_models(
    message: DataChannelMessage,
    memory: dict[str, Any] | None,
    context: SlaveContext,
) -> DataChannelMessage:
    return DataChannelMessage(
        id=message.id,
        type="ai.embeddings.models.result",
        payload=get_model_list_payload("embeddings"),
    )


async def ai_embeddings(
    message: DataChannelMessage,
    memory: dict[str, Any] | None,
    context: SlaveContext,
) -> DataChannelMessage:
    started_at = time.perf_counter()
    try:
        request = EmbeddingRequest.model_validate(message.payload)
        log(f"ai.embeddings start session={context.session_id} text_chars={len(request.text)}")
        response = await generate_embedding(request)
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        log(
            "ai.embeddings complete "
            f"session={context.session_id} "
            f"duration_ms={duration_ms} "
            f"dimensions={response.dimensions}"
        )
        return DataChannelMessage(
            id=message.id,
            type="ai.embeddings.result",
            payload=response.model_dump(),
        )
    except Exception as exc:
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        log_exception(f"ai.embeddings failed session={context.session_id} duration_ms={duration_ms}", exc)
        raise


async def ai_embeddings_batch(
    message: DataChannelMessage,
    memory: dict[str, Any] | None,
    context: SlaveContext,
) -> DataChannelMessage:
    started_at = time.perf_counter()
    try:
        request = EmbeddingBatchRequest.model_validate(message.payload)
        log(f"ai.embeddings.batch start session={context.session_id} count={len(request.texts)}")
        response = await generate_embeddings(request)
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        log(
            "ai.embeddings.batch complete "
            f"session={context.session_id} duration_ms={duration_ms} "
            f"count={response.count} dimensions={response.dimensions}"
        )
        return DataChannelMessage(
            id=message.id,
            type="ai.embeddings.batch.result",
            payload=response.model_dump(),
        )
    except Exception as exc:
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        log_exception(f"ai.embeddings.batch failed session={context.session_id} duration_ms={duration_ms}", exc)
        raise
