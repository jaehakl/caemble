from __future__ import annotations

import asyncio
import hashlib
import secrets
from contextlib import suppress
from urllib.parse import urlparse, urlunparse

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy import select

from db import SessionLocal
from gpstation.db import Job, Launcher
from gpstation.service.batches import (
    SERVER_ASSIGNED_STATES,
    TERMINAL_STATES,
    finish_job,
    job_event,
    serialize_events,
)
from gpstation.service.state import runtime, utcnow
from gpstation.service.server_handlers import server_handlers
from sdk.protocol.packets import receive_packet, send_packet
from settings import settings

WORKER_IDLE_TIMEOUT_SECONDS = 180


async def worker_assignment(db, job: Job) -> dict:
    token = secrets.token_urlsafe(32)
    job.worker_token_hash = hashlib.sha256(token.encode()).hexdigest()
    await db.commit()
    parsed = urlparse(settings.public_api_base_url)
    url = urlunparse(
        (
            "wss" if parsed.scheme == "https" else "ws",
            parsed.netloc,
            f"{parsed.path.rstrip('/')}/v1/jobs/{job.id}/stream",
            "",
            "",
            "",
        )
    )
    return {
        "type": "job.start",
        "job_id": job.id,
        "handler_type": job.handler_type,
        "slave_app_id": job.slave_app_id,
        "job_mode": "websocket",
        "websocket_url": url,
        "token": token,
        "attempt_count": job.attempt_count,
    }


async def worker_cleaned(
    db, *, job_id: str, attempt_count: int, launcher_id: str, user_id: str
) -> bool:
    await serialize_events(db)
    job = await db.scalar(
        select(Job)
        .where(
            Job.id == job_id,
            Job.attempt_count == attempt_count,
            Job.launcher_id == launcher_id,
            Job.user_id == user_id,
            Job.job_mode == "websocket",
        )
        .with_for_update()
    )
    if job is None:
        return False
    if job.cleaned_at is not None:
        await db.commit()
        return True
    if not await runtime.launcher_matches_job(launcher_id, job_id):
        await db.rollback()
        return False
    if job.state not in TERMINAL_STATES:
        await finish_job(
            db,
            job,
            "cancelled" if job.cancel_requested_at else "failed",
            "Worker stopped before completion.",
        )
    job.cleaned_at = utcnow()
    launcher = await db.get(Launcher, launcher_id)
    if launcher is not None and launcher.disconnected_at is None:
        launcher.status = "ready"
    await db.commit()
    await runtime.mark_launcher_job(launcher_id, None, worker_status="idle")
    return True


async def run_worker_connection(websocket: WebSocket, job_id: str) -> None:
    authorization = websocket.headers.get("authorization", "")
    token = authorization.removeprefix("Bearer ") if authorization.startswith("Bearer ") else ""
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    attempt = None
    launcher_id = None
    complete = False
    owns_attempt = False
    accepted = False
    failure_detail = "Worker connection interrupted."

    async def receive():
        # A large packet may take minutes while its bounded chunks keep arriving.
        message = await asyncio.wait_for(websocket.receive(), timeout=WORKER_IDLE_TIMEOUT_SECONDS)
        if message["type"] == "websocket.disconnect":
            raise WebSocketDisconnect(message.get("code", 1000))
        return message.get("bytes") if message.get("bytes") is not None else message.get("text")

    async def send(payload):
        await send_packet(websocket.send_text, websocket.send_bytes, payload)

    try:
        async with SessionLocal() as db:
            job = await db.get(Job, job_id)
            if (
                not token
                or job is None
                or job.job_mode != "websocket"
                or job.state != "assigned"
                or not secrets.compare_digest(job.worker_token_hash or "", token_hash)
            ):
                await websocket.close(code=1008)
                return
            attempt, launcher_id = job.attempt_count, job.launcher_id
            handler = server_handlers[job.handler_type]
        await websocket.accept()
        accepted = True
        ready, attachments = await asyncio.wait_for(receive_packet(receive), timeout=30)
        if (
            ready.get("type") != "job.ready"
            or ready.get("job_id") != job_id
            or ready.get("attempt_count") != attempt
            or attachments
        ):
            raise ValueError("Invalid worker handshake.")
        async with SessionLocal() as db:
            await serialize_events(db)
            job = await db.scalar(
                select(Job)
                .where(
                    Job.id == job_id,
                    Job.attempt_count == attempt,
                    Job.state == "assigned",
                    Job.worker_token_hash == token_hash,
                    Job.cancel_requested_at.is_(None),
                )
                .with_for_update()
            )
            if job is None or not await runtime.launcher_matches_job(launcher_id, job_id):
                raise ValueError("The assignment is no longer active.")
            job.state = "running"
            job.started_at = utcnow()
            await job_event(db, job, "job.running")
            payload = {"type": "job.input", **job.input}
            await db.commit()
            owns_attempt = True
        await send(payload)
        while True:
            packet, attachments = await receive_packet(receive)
            kind = packet.get("type")
            async with SessionLocal() as db:
                # Storage HEAD/signing does not emit events. Keep its network
                # latency out of the global event lock while fencing this job.
                if not isinstance(kind, str) or not kind.startswith("job.storage."):
                    await serialize_events(db)
                job = await db.scalar(
                    select(Job)
                    .where(
                        Job.id == job_id,
                        Job.attempt_count == attempt,
                        Job.launcher_id == launcher_id,
                        Job.state.in_(SERVER_ASSIGNED_STATES),
                        Job.cancel_requested_at.is_(None),
                    )
                    .with_for_update()
                )
                if job is None:
                    raise ValueError("The attempt is no longer active.")
                job.updated_at = utcnow()
                if kind == "job.progress":
                    progress = packet.get("progress")
                    if not isinstance(progress, dict) or progress.get("kind") != "heartbeat":
                        job.progress = [{"time": utcnow().isoformat(), "progress": progress}]
                        await job_event(db, job, "job.progress", {"progress": progress})
                elif kind == "job.record":
                    await handler.stage_record(db, job, packet, attachments)
                elif kind == "job.visualization" and hasattr(handler, "stage_visualization"):
                    await handler.stage_visualization(db, job, packet, attachments)
                elif kind.startswith("job.storage.") and hasattr(handler, "storage_packet"):
                    if attachments:
                        raise ValueError("Storage requests must not carry binary bodies.")
                    storage_reply = await handler.storage_packet(db, job, packet)
                elif kind == "job.complete":
                    job.state = "finalizing"
                    await job_event(db, job, "job.finalizing")
                elif kind in {"job.failed", "job.cancelled"}:
                    await finish_job(
                        db,
                        job,
                        "failed" if kind == "job.failed" else "cancelled",
                        packet.get("detail") or packet.get("message") or "Worker stopped.",
                    )
                else:
                    raise ValueError(f"Unknown worker message: {kind}")
                await db.commit()
                complete = kind in {"job.failed", "job.cancelled"}
            if kind in {"job.record", "job.visualization"}:
                await send({"type": f"{kind}.ack", "sequence": packet["sequence"]})
            elif kind.startswith("job.storage."):
                await send(storage_reply)
            elif kind == "job.complete":
                async with SessionLocal() as db:
                    await serialize_events(db)
                    job = await db.scalar(
                        select(Job)
                        .where(
                            Job.id == job_id,
                            Job.attempt_count == attempt,
                            Job.launcher_id == launcher_id,
                            Job.state == "finalizing",
                            Job.cancel_requested_at.is_(None),
                        )
                        .with_for_update()
                    )
                    if job is None:
                        raise ValueError("The attempt is no longer active.")
                    result = await handler.complete_job(db, job, packet)
                    await finish_job(db, job, "succeeded", result=result)
                    await db.commit()
                    complete = True
            if complete:
                await send({"type": "job.complete.ack"})
                return
    except asyncio.CancelledError:
        raise
    except Exception as error:
        failure_detail = str(error) or type(error).__name__
        if accepted:
            with suppress(Exception):
                await send({"type": "job.cancel", "reason": str(error)})
    finally:
        if owns_attempt and attempt is not None and not complete:
            async with SessionLocal() as db:
                await serialize_events(db)
                job = await db.scalar(
                    select(Job)
                    .where(Job.id == job_id, Job.attempt_count == attempt)
                    .with_for_update()
                )
                if job is not None:
                    await finish_job(
                        db,
                        job,
                        "cancelled" if job.cancel_requested_at else "failed",
                        failure_detail,
                    )
                await db.commit()
            if launcher_id:
                from gpstation.service.job_orchestrator import job_orchestrator

                with suppress(Exception):
                    async with job_orchestrator.launcher_send_lock(launcher_id):
                        await job_orchestrator.send_launcher_message(
                            launcher_id,
                            {
                                "type": "job.cancel",
                                "job_id": job_id,
                                "reason": "worker connection ended",
                            },
                        )
        if accepted:
            with suppress(Exception):
                await websocket.close()
