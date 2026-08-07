from __future__ import annotations

import time

from sdk.slave import SlaveContext

from app.logging import log
from app.sdxl.handlers import register_handlers
from app.sdxl.runtime import warmup_sdxl_imports


async def initialize(context: SlaveContext) -> None:
    stage_started_at = time.perf_counter()
    log(f"ai initialize SDXL import warmup start session={context.session_id}")
    warmup_sdxl_imports()
    duration_ms = int((time.perf_counter() - stage_started_at) * 1000)
    log(f"ai initialize SDXL import warmup complete session={context.session_id} duration_ms={duration_ms}")


__all__ = ["initialize", "register_handlers"]
