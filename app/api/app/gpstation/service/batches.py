"""Durable batch accounting. Callers own the transaction and lock order."""

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from gpstation.db import Job, JobBatch, JobEvent, JobRecord, JobVisualization
from gpstation.service.state import utcnow

SERVER_ACTIVE_STATES = {"staged", "queued", "assigned", "running", "finalizing"}
SERVER_ASSIGNED_STATES = {"assigned", "running", "finalizing"}
TERMINAL_STATES = {"succeeded", "failed", "cancelled", "killed"}


async def serialize_events(db: AsyncSession) -> None:
    # Acquire before row locks. Event IDs then follow commit order, so SSE cursors
    # cannot skip a lower ID committed after an already delivered event.
    await db.execute(text("SELECT pg_advisory_xact_lock(1128351042)"))


async def study_context(db: AsyncSession, job: Job | None) -> dict:
    if job is None:
        return {}
    keys = ("study_id", "trial_id", "stage")
    if "artifact_metadata" in job.__dict__:
        metadata = job.artifact_metadata or {}
        return {key: metadata[key] for key in keys if key in metadata}
    # Claims defer potentially large artifact metadata. Read only attribution,
    # without implicit async lazy loading or hydrating geometry presentation.
    row = (await db.execute(select(*(Job.artifact_metadata[key].astext for key in keys)).where(Job.id == job.id))).one()
    return {key: value for key, value in zip(keys, row) if value is not None}


async def add_event(
    db: AsyncSession,
    batch: JobBatch,
    kind: str,
    *,
    job: Job | None = None,
    payload: dict | None = None,
) -> JobEvent:
    from gpstation.service.execution import execution_identity

    event = JobEvent(
        user_id=batch.user_id,
        batch_id=batch.id,
        job_id=job.id if job else None,
        attempt_count=job.attempt_count if job else None,
        type=kind,
        # Snapshot identity now: looking up Job while replaying would label an
        # earlier event with the current retry's instance and reservation.
        payload={**(payload or {}), **(execution_identity(job) if job is not None else {}),
                 **(await study_context(db, job))},
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
    job.waiting_reason = None
    job.execution_phase = state
    if job.reservation_id and job.cleaned_at is None:
        job.cleanup_state = "cleaning"
    from gpstation.service.execution import sync_attempt
    await sync_attempt(db, job)
    await db.execute(
        delete(JobRecord).where(
            JobRecord.job_id == job.id, JobRecord.attempt_count == job.attempt_count
        )
    )
    await db.execute(delete(JobVisualization).where(
        JobVisualization.job_id == job.id, JobVisualization.attempt_count == job.attempt_count,
    ))
    if job.batch_id is None:
        return True
    batch = await db.scalar(select(JobBatch).where(JobBatch.id == job.batch_id).with_for_update())
    if batch is None:
        return True
    field = "cancelled" if state == "killed" else state
    setattr(batch, field, getattr(batch, field) + 1)
    attribution = await study_context(db, job)
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
                **attribution,
                "total": batch.total,
                "succeeded": batch.succeeded,
                "failed": batch.failed,
                "cancelled": batch.cancelled,
            },
        )
    if attribution.get("study_id"):
        if "artifact_metadata" not in job.__dict__:
            await db.refresh(job, ["artifact_metadata"])
        from cae.studies.controller import on_job_finished
        await on_job_finished(db, job, result)
    return True


async def fail_server_jobs(
    db: AsyncSession, *, detail: str, launcher_ids: set[str] | None = None, restarting: bool = False
) -> list[Job]:
    await serialize_events(db)
    states = SERVER_ASSIGNED_STATES
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
    await db.commit()
    return jobs


async def event_cursor(db: AsyncSession, user_id: str) -> int:
    return int(
        await db.scalar(
            select(func.coalesce(func.max(JobEvent.id), 0)).where(JobEvent.user_id == user_id)
        )
    )
