from __future__ import annotations

import time

from sdk.slave import SlaveContext

from app.logging import log
from app.vision.handlers import register_handlers
from app.vision.runtime import warmup_vision_imports


async def initialize(context: SlaveContext) -> None:
    stage_started_at = time.perf_counter()
    log(f"ai initialize vision import warmup start session={context.session_id}")
    warmup_vision_imports()
    duration_ms = int((time.perf_counter() - stage_started_at) * 1000)
    log(
        "ai initialize vision import warmup complete "
        f"session={context.session_id} duration_ms={duration_ms}"
    )


__all__ = ["initialize", "register_handlers"]
