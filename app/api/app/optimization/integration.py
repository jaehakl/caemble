"""Optimization callbacks attached to execution handlers at application startup."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from gpstation.db import Job
from optimization.controller import on_job_finished


async def event_context(db: AsyncSession, job: Job) -> dict:
    keys = ("study_id", "trial_id", "stage")
    if "artifact_metadata" in job.__dict__:
        metadata = job.artifact_metadata or {}
        return {key: metadata[key] for key in keys if key in metadata}
    # Claims defer large artifacts. Read attribution without loading geometry.
    row = (await db.execute(select(
        *(Job.artifact_metadata[key].astext for key in keys)
    ).where(Job.id == job.id))).one()
    return {key: value for key, value in zip(keys, row) if value is not None}


async def on_finished(db: AsyncSession, job: Job, result: dict | None) -> None:
    if not (await event_context(db, job)).get("study_id"):
        return
    if "artifact_metadata" not in job.__dict__:
        await db.refresh(job, ["artifact_metadata"])
    await on_job_finished(db, job, result)
