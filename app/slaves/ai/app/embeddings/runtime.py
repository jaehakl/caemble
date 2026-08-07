from __future__ import annotations

import asyncio
from typing import Any

from app.logging import log


_embedding_lock = asyncio.Lock()
_embedding_model_key: tuple[str, str | None, bool] | None = None
_embedding_model: Any | None = None


async def encode_cut_text(
    model_name: str,
    text: str,
    revision: str | None = None,
    local_files_only: bool = True,
) -> list[float]:
    async with _embedding_lock:
        return await asyncio.to_thread(_encode_cut_text_locked, model_name, text, revision, local_files_only)


async def encode_cut_texts(
    model_name: str,
    texts: list[str],
    revision: str | None = None,
    local_files_only: bool = True,
) -> list[list[float]]:
    async with _embedding_lock:
        return await asyncio.to_thread(_encode_cut_texts_locked, model_name, texts, revision, local_files_only)


def _encode_cut_text_locked(
    model_name: str,
    text: str,
    revision: str | None = None,
    local_files_only: bool = True,
) -> list[float]:
    log(f"embedding encode start model={model_name} text_chars={len(text)}")
    model = _get_embedding_model_locked(model_name, revision, local_files_only)
    raw_embedding = model.encode(text)
    if hasattr(raw_embedding, "tolist"):
        raw_embedding = raw_embedding.tolist()
    embedding = [float(value) for value in raw_embedding]
    log(f"embedding encode complete model={model_name} dimensions={len(embedding)}")
    return embedding


def _encode_cut_texts_locked(
    model_name: str,
    texts: list[str],
    revision: str | None = None,
    local_files_only: bool = True,
) -> list[list[float]]:
    log(f"embedding batch encode start model={model_name} count={len(texts)}")
    model = _get_embedding_model_locked(model_name, revision, local_files_only)
    raw_embeddings = model.encode(texts)
    if hasattr(raw_embeddings, "tolist"):
        raw_embeddings = raw_embeddings.tolist()
    embeddings = [[float(value) for value in raw_embedding] for raw_embedding in raw_embeddings]
    log(
        "embedding batch encode complete "
        f"model={model_name} count={len(embeddings)} "
        f"dimensions={len(embeddings[0]) if embeddings else 0}"
    )
    return embeddings


def _get_embedding_model_locked(model_name: str, revision: str | None, local_files_only: bool) -> Any:
    global _embedding_model_key, _embedding_model

    model_key = (model_name, revision, local_files_only)
    if _embedding_model is None or _embedding_model_key != model_key:
        SentenceTransformer = _load_sentence_transformer_cls(model_name)

        log(f"loading embedding model model={model_name}")
        _embedding_model = _load_sentence_transformer(
            SentenceTransformer,
            model_name,
            revision,
            local_files_only,
        )
        _embedding_model_key = model_key
        log(f"embedding model loaded model={model_name}")
    return _embedding_model


def warmup_embedding_import(model_name: str) -> None:
    _load_sentence_transformer_cls(model_name)


def _load_sentence_transformer_cls(model_name: str) -> Any:
    log(f"importing sentence_transformers model={model_name}")
    from sentence_transformers import SentenceTransformer
    log(f"sentence_transformers imported model={model_name}")
    return SentenceTransformer


def _load_sentence_transformer(
    sentence_transformer_cls: Any,
    model_name: str,
    revision: str | None,
    local_files_only: bool,
) -> Any:
    return sentence_transformer_cls(
        model_name,
        device="cpu",
        revision=revision,
        local_files_only=local_files_only,
        model_kwargs={"low_cpu_mem_usage": False},
    )
