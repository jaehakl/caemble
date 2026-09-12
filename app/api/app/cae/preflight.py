"""Temporary CAE results share jobs and tensor storage, never Measurements."""
from datetime import timedelta

from fastapi import HTTPException
from sqlalchemy import delete, select, update

from cae.batches import require_batch
from cae.db import CaeBatch
from gpstation.db import Job, JobRecord, JobVisualization
from gpstation.service.state import utcnow
from storage.db import StorageObject


async def require_preflight_job(db, job_id, user_id):
    job = await db.get(Job, job_id)
    if job is None or job.user_id != user_id or not (job.input or {}).get("preflight"):
        raise HTTPException(404, "Preflight not found.")
    if job.finished_at is not None and job.finished_at + timedelta(hours=24) <= utcnow():
        raise HTTPException(410, "Preflight result has expired.")
    return job


async def preflight_result(db, batch_id, user_id):
    batch = await require_batch(db, batch_id, user_id)
    cae = await db.get(CaeBatch, batch.id)
    if not cae.spec.get("preflight"):
        raise HTTPException(404, "Preflight not found.")
    job_id = await db.scalar(select(Job.id).where(Job.batch_id == batch.id))
    job = await require_preflight_job(db, job_id, user_id)
    if job.state != "succeeded":
        raise HTTPException(409, "Preflight has not succeeded.")
    recorded = (job.artifact_metadata or {}).get("recorded_data")
    if not isinstance(recorded, dict):
        raise HTTPException(410, "이 Preflight의 결과 기록이 유실되어 조회할 수 없습니다.")
    program = job.input["measurement"]["experiment"]["simulationProgram"]
    return {
        "id": batch.id,
        "expires_at": job.finished_at + timedelta(hours=24),
        "source_hash": cae.spec["source_hash"], "source_bundle": cae.spec["source_bundle"],
        "vars_hash": job.input["measurement"]["varsHash"],
        "result_contracts": program["resultContracts"], "schemas": program["recordedData"],
        "recorded_data": recorded,
        "visualizations": (job.artifact_metadata or {}).get("visualizations", {}),
        "execution_trace": (job.artifact_metadata or {}).get("execution_trace", []),
    }


async def expire_preflights(db):
    jobs = (await db.scalars(select(Job).join(CaeBatch, CaeBatch.batch_id == Job.batch_id).where(
        CaeBatch.spec["preflight"].as_boolean() == True,
        Job.finished_at < utcnow() - timedelta(hours=24), CaeBatch.spec.has_key("source_bundle"),
    ).limit(100).with_for_update(of=Job, skip_locked=True))).all()
    for job in jobs:
        # Durable tombstones are swept by the existing bucket cleanup loop.
        await db.execute(update(StorageObject).where(StorageObject.job_id == job.id).values(
            deleting=True, bound=False, updated_at=utcnow() - timedelta(hours=25)))
        await db.execute(delete(JobRecord).where(JobRecord.job_id == job.id))
        await db.execute(delete(JobVisualization).where(JobVisualization.job_id == job.id))
        job.input = None
        job.artifact_metadata = None
        job.progress = []
        cae = await db.get(CaeBatch, job.batch_id)
        cae.spec = {key: value for key, value in cae.spec.items() if key != "source_bundle"}
    await db.commit()
