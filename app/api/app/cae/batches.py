from __future__ import annotations

import hashlib
import json

from caemble_catalog import Catalog
from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from cae.db import CaeBatch, CaeUploadChunk
from cae.models import BatchCreateRequest
from db import Experiment, Measurement
from gpstation.db import Job, JobBatch
from gpstation.service.batches import (
    SERVER_ACTIVE_STATES,
    add_event,
    event_cursor,
    finish_job,
    serialize_events,
)
from gpstation.service.state import utcnow
from models import UserData
from utils.crud.common import is_admin_user


async def require_batch(
    db: AsyncSession, batch_id: str, user_id: str, *, lock: bool = False
) -> JobBatch:
    query = (
        select(JobBatch)
        .join(CaeBatch, CaeBatch.batch_id == JobBatch.id)
        .where(JobBatch.id == batch_id, JobBatch.user_id == user_id)
    )
    batch = await db.scalar(query.with_for_update(of=JobBatch) if lock else query)
    if batch is None:
        raise HTTPException(404, "Batch not found.")
    return batch


async def create_batch(
    db: AsyncSession, request: BatchCreateRequest, user: UserData, catalog: Catalog
) -> JobBatch:
    await serialize_events(db)
    request_data = request.model_dump(mode="json")
    if not request.preflight:
        for key in ("preflight", "execution_mode", "source_bundle"):
            request_data.pop(key)
    request_hash = hashlib.sha256(
        json.dumps(request_data, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()
    existing = await db.scalar(select(JobBatch).where(
        JobBatch.user_id == user.id, JobBatch.request_id == str(request.request_id)
    ))
    if existing:
        if existing.request_hash != request_hash:
            raise HTTPException(409, "This request_id was already used for a different batch.")
        await require_batch(db, existing.id, user.id)
        await db.commit()
        return existing
    if request.catalog_revision != catalog.meta()["catalogRevision"]:
        raise HTTPException(409, "Catalog revision changed. Rebuild with the server Catalog.")
    experiment = None
    if request.preflight:
        from service.experiment import _bundle_hash
        if _bundle_hash(request.source_bundle) != request.experiment_source_hash:
            raise HTTPException(422, "Preflight source bundle hash differs from its manifest.")
    else:
        experiment = await db.scalar(
            select(Experiment).where(Experiment.id == request.experiment_id).with_for_update()
        )
        if experiment is None or (
            not is_admin_user(user) and experiment.user_id not in {None, user.id}
        ):
            raise HTTPException(404, "Experiment not found.")
        if experiment.source_hash != request.experiment_source_hash:
            raise HTTPException(409, "The Experiment source changed before batch submission.")
    batch = JobBatch(
        user_id=user.id, request_id=str(request.request_id), request_hash=request_hash,
        total=len(request.items), created_count=len(request.items), uploaded_count=0,
        succeeded=0, failed=0, cancelled=0, state="uploading", generation_stopped=True,
        last_event_id=0, read_event_id=0,
    )
    db.add(batch)
    await db.flush()
    db.add(CaeBatch(batch_id=batch.id, experiment_id=request.experiment_id, spec={
        "mode": request.mode, "source_hash": request.experiment_source_hash,
        "catalog_revision": request.catalog_revision, "builder_version": request.builder_version,
        "storage_version": request.storage_version,
        "preflight": request.preflight, "execution_mode": request.execution_mode,
        **({"source_bundle": request.source_bundle} if request.preflight else {}),
    }))
    for item in request.items:
        db.add(Job(
            user_id=user.id, batch_id=batch.id, item_index=item.index,
            handler_type="cae.simulation", slave_app_id="cae", job_mode="websocket",
            state="staged", attempt_count=1, progress=[], offer={},
            artifact_metadata=item.model_dump(mode="json"),
        ))
    await add_event(db, batch, "batch.created", payload={"experiment_id": request.experiment_id})
    await db.commit()
    return batch


async def batch_snapshot(
    db: AsyncSession, batch: JobBatch, *, limit: int = 50, offset: int = 0
) -> dict:
    cae = await db.get(CaeBatch, batch.id)
    rows = (
        await db.execute(
            select(Job, Measurement.id.label("measurement_id"))
            .outerjoin(Measurement, Measurement.job_id == Job.id)
            .where(Job.batch_id == batch.id)
            .order_by(Job.item_index)
            .limit(limit)
            .offset(offset)
        )
    ).all()
    return {
        "id": batch.id,
        "request_id": batch.request_id,
        "experiment_id": cae.experiment_id,
        "mode": cae.spec["mode"],
        "preflight": cae.spec.get("preflight", False),
        "execution_mode": cae.spec.get("execution_mode", "full"),
        "total": batch.total,
        "created_count": batch.created_count,
        "uploaded_count": batch.uploaded_count,
        "succeeded": batch.succeeded,
        "failed": batch.failed,
        "cancelled": batch.cancelled,
        "state": batch.state,
        "created_at": batch.created_at,
        "updated_at": batch.updated_at,
        "finished_at": batch.finished_at,
        "last_event_id": batch.last_event_id,
        "read_event_id": batch.read_event_id,
        "jobs_total": batch.created_count,
        "jobs": [
            {
                "id": job.id,
                "index": job.item_index,
                "attempt_count": job.attempt_count,
                "state": job.state,
                "uploaded": job.input is not None,
                "input_hash": (job.artifact_metadata or {}).get("input_hash"),
                "measurement_id": measurement_id,
                "progress": (job.progress[-1].get("progress") if job.progress else None),
                "last_error": job.last_error,
                "created_at": job.created_at,
                "updated_at": job.updated_at,
            }
            for job, measurement_id in rows
        ],
    }


async def list_batches(
    db: AsyncSession, user_id: str, *, experiment_id: int | None, limit: int, offset: int
) -> dict:
    cursor = await event_cursor(db, user_id)
    query = (
        select(JobBatch)
        .join(CaeBatch, CaeBatch.batch_id == JobBatch.id)
        .where(JobBatch.user_id == user_id)
    )
    if experiment_id is not None:
        query = query.where(CaeBatch.experiment_id == experiment_id)
    total = await db.scalar(select(func.count()).select_from(query.subquery()))
    batches = (
        await db.scalars(
            query.order_by(JobBatch.created_at.desc(), JobBatch.id).limit(limit).offset(offset)
        )
    ).all()
    return {
        "cursor": cursor,
        "total": total,
        "items": [await batch_snapshot(db, batch) for batch in batches],
    }


async def cancel_batch(
    db: AsyncSession, batch_id: str, user_id: str
) -> tuple[JobBatch, list[tuple[str, str]]]:
    await serialize_events(db)
    batch = await require_batch(db, batch_id, user_id, lock=True)
    cancellations = []
    if batch.state not in {"completed", "cancelled"}:
        was_uploading = batch.state == "uploading"
        batch.state = "cancelled"
        if not batch.generation_stopped:
            batch.cancelled += batch.total - batch.created_count
        batch.generation_stopped = True
        jobs = (
            await db.scalars(
                select(Job)
                .where(Job.batch_id == batch.id, Job.state.in_(SERVER_ACTIVE_STATES))
                .order_by(Job.id)
                .with_for_update()
            )
        ).all()
        for job in jobs:
            job.cancel_requested_at = utcnow()
            if job.launcher_id and job.cleaned_at is None:
                cancellations.append((job.launcher_id, job.id))
            await finish_job(db, job, "cancelled", "Cancelled by user.")
        if was_uploading:
            await db.execute(delete(CaeUploadChunk).where(
                CaeUploadChunk.job_id.in_(select(Job.id).where(Job.batch_id == batch.id))
            ))
            for job in jobs:
                job.input = None
                job.artifact_metadata = {
                    key: value for key, value in (job.artifact_metadata or {}).items()
                    if key in {"index", "input_hash", "byte_length", "measurement_id"}
                }
        if batch.finished_at is None:
            batch.finished_at = utcnow()
            await add_event(db, batch, "batch.cancelled", payload={"cancelled": batch.cancelled})
    await db.commit()
    return batch, cancellations


async def retry_batch(
    db: AsyncSession, batch_id: str, user_id: str, job_ids: list[str] | None
) -> JobBatch:
    await serialize_events(db)
    batch = await require_batch(db, batch_id, user_id, lock=True)
    query = (
        select(Job)
        .where(Job.batch_id == batch.id, Job.state == "failed")
        .order_by(Job.item_index)
        .with_for_update()
    )
    if job_ids is not None:
        query = query.where(Job.id.in_(job_ids))
    jobs = list((await db.scalars(query)).all())
    if not jobs or (job_ids is not None and {job.id for job in jobs} != set(job_ids)):
        raise HTTPException(409, "Select failed jobs from this batch.")
    if any(job.launcher_id and job.cleaned_at is None for job in jobs):
        raise HTTPException(409, "Wait for worker cleanup before retrying.")
    cae = await db.get(CaeBatch, batch.id)
    if any(job.input is None for job in jobs):
        raise HTTPException(409, "This legacy job has no saved input. Rebuild with the current client.")
    if cae.spec.get("preflight"):
        raise HTTPException(409, "Start a new Preflight from the Experiment tab.")
    experiment = await db.scalar(
        select(Experiment).where(Experiment.id == cae.experiment_id).with_for_update()
    )
    if experiment is None or experiment.source_hash != cae.spec["source_hash"]:
        raise HTTPException(409, "The original Experiment is no longer available.")
    for job in jobs:
        if job.input is not None and not await db.scalar(
            select(Measurement.id).where(Measurement.job_id == job.id).with_for_update()
        ):
            raise HTTPException(409, "The original Measurement was deleted.")
        job.attempt_count += 1
        job.state = "queued"
        job.launcher_id = None
        job.worker_token_hash = None
        job.cleaned_at = None
        job.assigned_at = job.started_at = job.finished_at = job.cancel_requested_at = None
        job.last_error = None
        job.progress = []
        job.updated_at = utcnow()
        batch.failed -= 1
        await add_event(db, batch, "job.queued", job=job)
    batch.state = "running"
    batch.finished_at = None
    await add_event(db, batch, "batch.retried", payload={"job_ids": [job.id for job in jobs]})
    await db.commit()
    return batch


async def require_no_active_batches(db: AsyncSession, experiment_ids: list[int]) -> None:
    active = await db.scalar(
        select(CaeBatch.batch_id)
        .join(JobBatch, JobBatch.id == CaeBatch.batch_id)
        .where(
            CaeBatch.experiment_id.in_(experiment_ids), JobBatch.state.in_(("uploading", "queued", "running"))
        )
        .limit(1)
    )
    if active is not None:
        raise HTTPException(
            409, "Cancel active CAE batches before changing or deleting this Experiment."
        )


async def mark_batch_read(db: AsyncSession, batch_id: str, user_id: str, event_id: int) -> None:
    batch = await require_batch(db, batch_id, user_id, lock=True)
    batch.read_event_id = max(batch.read_event_id, min(event_id, batch.last_event_id))
    await db.commit()


async def stop_batch(db: AsyncSession, batch_id: str, user_id: str) -> JobBatch:
    from gpstation.service.job_orchestrator import job_orchestrator

    batch, assignments = await cancel_batch(db, batch_id, user_id)
    for launcher_id, job_id in assignments:
        try:
            async with job_orchestrator.launcher_send_lock(launcher_id):
                await job_orchestrator.send_launcher_message(
                    launcher_id,
                    {
                        "type": "job.cancel",
                        "job_id": job_id,
                        "reason": "batch cancelled",
                    },
                )
        except Exception:
            await job_orchestrator.disconnect_launcher(launcher_id)
            await job_orchestrator.launcher_disconnected(db, launcher_id=launcher_id)
    job_orchestrator.wake_dispatcher()
    return batch
