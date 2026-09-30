"""Simulation upload expiry, independent of the execution dispatcher."""
from __future__ import annotations

import asyncio
import logging
from contextlib import suppress

from db import SessionLocal
from simulation.services.uploads import expire_uploads

logger = logging.getLogger(__name__)
_task: asyncio.Task | None = None


async def expire_once() -> int:
    async with SessionLocal() as db:
        return await expire_uploads(db)


async def _run() -> None:
    while True:
        await asyncio.sleep(1)
        try:
            await expire_once()
        except Exception:
            logger.exception("Simulation upload expiry failed")


async def start() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_run(), name="simulation-upload-expiry")


async def stop() -> None:
    global _task
    task = _task
    if task is None:
        return
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task
    if _task is task:
        _task = None
