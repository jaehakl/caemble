from __future__ import annotations

import time

from sdk.slave import SlaveContext

from app.llm.handlers import register_handlers
from app.llm.runtime import warmup_llm_import
from app.logging import log


async def initialize(context: SlaveContext) -> None:
    stage_started_at = time.perf_counter()
    log(f"ai initialize LLM import warmup start session={context.session_id}")
    warmup_llm_import()
    duration_ms = int((time.perf_counter() - stage_started_at) * 1000)
    log(f"ai initialize LLM import warmup complete session={context.session_id} duration_ms={duration_ms}")


__all__ = ["initialize", "register_handlers"]
