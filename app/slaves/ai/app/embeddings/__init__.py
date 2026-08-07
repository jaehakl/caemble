from __future__ import annotations

import time

from sdk.slave import SlaveContext

from app.embeddings.handlers import register_handlers
from app.embeddings.runtime import warmup_embedding_import
from app.logging import log


async def initialize(context: SlaveContext) -> None:
    stage_started_at = time.perf_counter()
    log(f"ai initialize embedding import warmup start session={context.session_id}")
    warmup_embedding_import("startup")
    duration_ms = int((time.perf_counter() - stage_started_at) * 1000)
    log(
        "ai initialize embedding import warmup complete "
        f"session={context.session_id} duration_ms={duration_ms}"
    )


__all__ = ["initialize", "register_handlers"]
