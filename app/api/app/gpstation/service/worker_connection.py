from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import secrets
from contextlib import suppress
from urllib.parse import urlparse, urlunparse

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy import select

from db import SessionLocal
from gpstation.db import Job, Launcher, ExecutionAttempt
from gpstation.service.batches import (
    SERVER_ASSIGNED_STATES,
    TERMINAL_STATES,
    finish_job,
    job_event,
    serialize_events,
)
from gpstation.service.state import runtime, utcnow
from gpstation.service.execution import execution_identity, locked_execution, sync_attempt, IDENTITY_FIELDS
from gpstation.service.server_handlers import server_handlers
from sdk.protocol.packets import receive_packet, send_packet
from settings import settings

WORKER_IDLE_TIMEOUT_SECONDS = 180
_WORKER_TOKEN_SECRET = (settings.JWT_SECRET or secrets.token_urlsafe(48)).encode()


async def worker_assignment(db, job: Job) -> dict:
    token = hmac.new(_WORKER_TOKEN_SECRET, json.dumps(execution_identity(job), sort_keys=True).encode(), hashlib.sha256).hexdigest()
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
        **execution_identity(job),
        "handler_type": job.handler_type,
        "slave_app_id": job.slave_app_id,
        "job_mode": "websocket",
        "websocket_url": url,
        "token": token,
        "allocation": job.allocation,
    }


async def worker_cleaned(db, *, identity: dict, user_id: str) -> bool:
    await serialize_events(db)
    job = await locked_execution(db, identity, user_id=user_id)
    if job is None:
        # A duplicate receipt for a completed older attempt is acknowledged, but
        # cannot release any current instance or change the logical Job.
        attempt = await db.get(ExecutionAttempt, identity.get("attempt_id"))
        if attempt is None or attempt.cleaned_at is None:
            await db.commit()
            return False
        old = {key: attempt.job_id if key == "job_id" else attempt.id if key == "attempt_id" else getattr(attempt, key)
               for key in IDENTITY_FIELDS}
        owner = await db.get(Job, attempt.job_id)
        matched = old == {key: identity.get(key) for key in IDENTITY_FIELDS} and owner is not None and owner.user_id == user_id
        await db.commit()
        return matched
    if job.cleaned_at is None:
        if job.state not in TERMINAL_STATES:
            await finish_job(db, job, "cancelled" if job.cancel_requested_at else "failed", "Worker stopped before completion.")
        job.cleaned_at = utcnow()
        job.cleanup_state = "cleaned"
        await sync_attempt(db, job)
        await job_event(db, job, "job.cleaned", {"cleanup_state": "cleaned"})
    await db.commit()
    await runtime.remove_instance(job.launcher_id, job.instance_id, job.reservation_id)
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
    identity = None
    failure_detail = "Worker connection interrupted."

    async def receive():
        # A large packet may take minutes while its bounded chunks keep arriving.
        message = await asyncio.wait_for(websocket.receive(), timeout=WORKER_IDLE_TIMEOUT_SECONDS)
        if message["type"] == "websocket.disconnect":
            raise WebSocketDisconnect(message.get("code", 1000))
        return message.get("bytes") if message.get("bytes") is not None else message.get("text")

    async def send(payload):
        await send_packet(websocket.send_text, websocket.send_bytes, {**payload, **(identity or {})})

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
            identity = execution_identity(job)
            handler = server_handlers[job.handler_type]
        await websocket.accept()
        accepted = True
        ready, attachments = await asyncio.wait_for(receive_packet(receive), timeout=30)
        if (
            ready.get("type") != "job.ready"
            or any(ready.get(key) != value for key, value in identity.items())
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
                    Job.reservation_id == identity["reservation_id"],
                    Job.attempt_id == identity["attempt_id"],
                    Job.execution_phase == "start_authorized",
                    Job.cancel_requested_at.is_(None),
                )
                .with_for_update()
            )
            if job is None or not await runtime.launcher_matches_job(launcher_id, job_id, identity["reservation_id"]):
                raise ValueError("The assignment is no longer active.")
            job.state = job.execution_phase = "running"
            job.started_at = utcnow()
            await sync_attempt(db, job)
            await job_event(db, job, "job.running")
            payload = {"type": "job.input", **job.input}
            await db.commit()
            owns_attempt = True
        await send(payload)
        while True:
            packet, attachments = await receive_packet(receive)
            kind = packet.get("type")
            if any(packet.get(key) != value for key, value in identity.items()):
                # Discard the entire stale frame (including attachments) without
                # terminating the currently authenticated execution.
                continue
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
                        Job.attempt_id == identity["attempt_id"],
                        Job.reservation_id == identity["reservation_id"],
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
                            Job.attempt_id == identity["attempt_id"],
                            Job.reservation_id == identity["reservation_id"],
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
                    .where(Job.id == job_id, Job.attempt_count == attempt,
                           Job.attempt_id == identity["attempt_id"], Job.reservation_id == identity["reservation_id"])
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
                                **identity,
                                "reason": "worker connection ended",
                            },
                        )
        if accepted:
            with suppress(Exception):
                await websocket.close()
