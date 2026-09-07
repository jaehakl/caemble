from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from cae.batches import (
    batch_snapshot,
    create_batch,
    list_batches,
    mark_batch_read,
    require_batch,
    retry_batch,
    stop_batch,
)
from cae.events import stream_events
from cae.models import BatchCreateRequest, BatchReadRequest, BatchRetryRequest
from cae.preparation import preparation_queue
from gpstation.service.job_orchestrator import job_orchestrator
from gpstation.utils.csrf import require_web_csrf
from models import UserData
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles

router = APIRouter(prefix="/cae", tags=["cae"], dependencies=[Depends(require_web_csrf)])
authenticated = require_roles(["admin", "user"])


@router.post("/batches")
async def submit_batch(
    body: BatchCreateRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(authenticated),
):
    batch = await create_batch(db, body, user, request.app.state.catalog)
    preparation_queue.wakeup.set()
    return await batch_snapshot(db, batch)


@router.get("/batches")
async def batches(
    experiment_id: int | None = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(authenticated),
):
    return await list_batches(db, user.id, experiment_id=experiment_id, limit=limit, offset=offset)


@router.get("/batches/{batch_id}")
async def batch_detail(
    batch_id: UUID,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(authenticated),
):
    batch = await require_batch(db, str(batch_id), user.id)
    return await batch_snapshot(db, batch, limit=limit, offset=offset)


@router.post("/batches/{batch_id}/cancel")
async def cancel(
    batch_id: UUID, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)
):
    batch = await stop_batch(db, str(batch_id), user.id)
    return await batch_snapshot(db, batch)


@router.post("/batches/{batch_id}/retry")
async def retry(
    batch_id: UUID,
    body: BatchRetryRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(authenticated),
):
    batch = await retry_batch(
        db,
        str(batch_id),
        user.id,
        [str(value) for value in body.job_ids] if body.job_ids is not None else None,
    )
    preparation_queue.wakeup.set()
    job_orchestrator.wake_dispatcher()
    return await batch_snapshot(db, batch)


@router.post("/batches/{batch_id}/read")
async def mark_read(
    batch_id: UUID,
    body: BatchReadRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(authenticated),
):
    await mark_batch_read(db, str(batch_id), user.id, body.event_id)
    return {"ok": True}


@router.get("/events")
async def events(
    request: Request, after: int = Query(0, ge=0), user: UserData = Depends(authenticated)
):
    return StreamingResponse(
        stream_events(request, user.id, after),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
