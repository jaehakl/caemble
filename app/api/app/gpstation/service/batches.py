"""Durable batch accounting. Callers own the transaction and lock order."""

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from gpstation.db import Job, JobBatch, JobEvent, JobRecord
from gpstation.service.state import utcnow

SERVER_ACTIVE_STATES = {"preparing", "queued", "assigned", "running", "finalizing"}
SERVER_ASSIGNED_STATES = {"assigned", "running", "finalizing"}
TERMINAL_STATES = {"succeeded", "failed", "cancelled", "killed"}


async def serialize_events(db: AsyncSession) -> None:
    # Acquire before row locks. Event IDs then follow commit order, so SSE cursors
    # cannot skip a lower ID committed after an already delivered event.
    await db.execute(text("SELECT pg_advisory_xact_lock(1128351042)"))


async def add_event(
    db: AsyncSession,
    batch: JobBatch,
    kind: str,
    *,
    job: Job | None = None,
    payload: dict | None = None,
) -> JobEvent:
    event = JobEvent(
        user_id=batch.user_id,
        batch_id=batch.id,
        job_id=job.id if job else None,
        attempt_count=job.attempt_count if job else None,
        type=kind,
        payload=payload or {},
    )
    db.add(event)
    await db.flush()
    batch.last_event_id = event.id
    batch.updated_at = utcnow()
    return event


async def job_event(db: AsyncSession, job: Job, kind: str, payload: dict | None = None) -> None:
    if job.batch_id is None:
        return
    batch = await db.scalar(select(JobBatch).where(JobBatch.id == job.batch_id).with_for_update())
    if batch is not None:
        await add_event(db, batch, kind, job=job, payload=payload)


async def finish_job(
    db: AsyncSession, job: Job, state: str, detail: str | None = None, *, result: dict | None = None
) -> bool:
    if job.state in TERMINAL_STATES:
        return False
    job.state = state
    job.last_error = detail
    job.finished_at = utcnow()
    job.updated_at = job.finished_at
    job.worker_token_hash = None
    await db.execute(
        delete(JobRecord).where(
            JobRecord.job_id == job.id, JobRecord.attempt_count == job.attempt_count
        )
    )
    if job.batch_id is None:
        return True
    batch = await db.scalar(select(JobBatch).where(JobBatch.id == job.batch_id).with_for_update())
    if batch is None:
        return True
    field = "cancelled" if state == "killed" else state
    setattr(batch, field, getattr(batch, field) + 1)
    await add_event(
        db, batch, f"job.{state}", job=job, payload={"last_error": detail, **(result or {})}
    )
    if batch.succeeded + batch.failed + batch.cancelled == batch.total:
        batch.state = "cancelled" if batch.state == "cancelled" else "completed"
        batch.finished_at = utcnow()
        await add_event(
            db,
            batch,
            f"batch.{batch.state}",
            payload={
                "total": batch.total,
                "succeeded": batch.succeeded,
                "failed": batch.failed,
                "cancelled": batch.cancelled,
            },
        )
    return True


async def fail_server_jobs(
    db: AsyncSession, *, detail: str, launcher_ids: set[str] | None = None, restarting: bool = False
) -> list[Job]:
    await serialize_events(db)
    states = SERVER_ASSIGNED_STATES | ({"preparing"} if restarting else set())
    query = (
        select(Job)
        .where(Job.job_mode == "websocket", Job.state.in_(states))
        .order_by(Job.id)
        .with_for_update()
    )
    if launcher_ids is not None:
        query = query.where(Job.launcher_id.in_(launcher_ids))
    jobs = list((await db.scalars(query)).all())
    for job in jobs:
        await finish_job(db, job, "cancelled" if job.cancel_requested_at else "failed", detail)
        if restarting or launcher_ids is not None:
            job.cleaned_at = utcnow()
    cleanup = update(Job).where(
        Job.job_mode == "websocket", Job.cleaned_at.is_(None), Job.state.in_(TERMINAL_STATES)
    )
    if launcher_ids is not None:
        cleanup = cleanup.where(Job.launcher_id.in_(launcher_ids))
    if restarting or launcher_ids is not None:
        await db.execute(cleanup.values(cleaned_at=utcnow()))
    await db.commit()
    return jobs


async def event_cursor(db: AsyncSession, user_id: str) -> int:
    return int(
        await db.scalar(
            select(func.coalesce(func.max(JobEvent.id), 0)).where(JobEvent.user_id == user_id)
        )
    )
