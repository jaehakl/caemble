"""Replay owner-scoped, durable job events for browser observers."""

import asyncio
import json
import time

from fastapi import Request
from sqlalchemy import select

from db import SessionLocal
from gpstation.db import JobEvent


async def stream_events(request: Request, user_id: str, after: int):
    try:
        cursor = max(after, int(request.headers.get("last-event-id", "0")))
    except ValueError:
        cursor = after
    started = time.monotonic()
    heartbeat = started
    # Reconnect periodically to authenticate with the browser's current cookies.
    while time.monotonic() - started < 600 and not await request.is_disconnected():
        async with SessionLocal() as db:
            rows = (
                await db.scalars(
                    select(JobEvent)
                    .where(
                        JobEvent.user_id == user_id,
                        JobEvent.id > cursor,
                    )
                    .order_by(JobEvent.id)
                    .limit(200)
                )
            ).all()
        for event in rows:
            payload = {
                "id": event.id,
                "type": event.type,
                "batch_id": event.batch_id,
                "job_id": event.job_id,
                "attempt_count": event.attempt_count,
                "measurement_id": event.payload.get("measurement_id"),
                "payload": event.payload,
                "created_at": event.created_at.isoformat(),
            }
            yield f"id: {event.id}\ndata: {json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}\n\n"
            cursor = event.id
        if not rows:
            if time.monotonic() - heartbeat > 15:
                yield ": heartbeat\n\n"
                heartbeat = time.monotonic()
            await asyncio.sleep(1)
