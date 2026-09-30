from __future__ import annotations

from datetime import datetime, timedelta, timezone
import uuid
from typing import Any
from urllib.parse import urlparse, urlunparse

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer, load_only
from sqlalchemy.sql.elements import ColumnElement

from gpstation.db import Job, JobBatch, Launcher
from gpstation.models import JobData, JobSummary
from settings import settings
from gpstation.service.batches import finish_job, job_event, serialize_events
from gpstation.service.execution import resource_fits, sync_attempt

JOB_TERMINAL_STATES = {"succeeded", "failed", "cancelled", "killed"}
JOB_ACTIVE_STATES = {"assigned", "answer_ready", "running", "finalizing"}
JOB_IDLE_TIMEOUT = timedelta(hours=2)
JOB_MAX_LIFETIME = timedelta(hours=24)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def job_to_data(job: Job) -> JobData:
    return JobData(
        id=str(job.id),
        user_id=str(job.user_id),
        handler_type=job.handler_type,
        slave_app_id=job.slave_app_id,
        offer=job.offer,
        answer=job.answer,
        progress=list(job.progress or []),
        state=job.state,
        launcher_id=str(job.launcher_id) if job.launcher_id else None,
        assigned_at=job.assigned_at,
        answer_ready_at=job.answer_ready_at,
        started_at=job.started_at,
        finished_at=job.finished_at,
        cancel_requested_at=job.cancel_requested_at,
        last_error=job.last_error,
        attempt_count=job.attempt_count,
        attempt_id=job.attempt_id, instance_id=job.instance_id, resources=job.resources or {},
        allocation=job.allocation, cleanup_state=job.cleanup_state, waiting_reason=job.waiting_reason,
        created_at=job.created_at,
        updated_at=job.updated_at,
    )


def build_job_wait_url(job_id: str, prefix: str) -> str:
    parsed = urlparse(settings.public_api_base_url)
    base_path = parsed.path.rstrip("/")
    path = f"{base_path}{prefix}/{job_id}/wait-answer"
    return urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))


class JobService:
    @staticmethod
    async def create_job(
        db: AsyncSession,
        *,
        user_id: str,
        handler_type: str,
        slave_app_id: str,
        offer: dict[str, Any],
        resources: dict | None = None,
    ) -> Job:
        job = Job(
            user_id=user_id,
            handler_type=handler_type,
            slave_app_id=slave_app_id,
            offer=offer,
            state="queued",
            progress=[], resources=resources or {}, attempt_count=1, attempt_id=str(uuid.uuid4()),
        )
        db.add(job)
        await db.commit()
        await db.refresh(job)
        return job

    @staticmethod
    async def get_job(
        db: AsyncSession,
        *,
        job_id: str,
        user_id: str | None = None,
    ) -> Job | None:
        stmt = select(Job).where(Job.id == job_id)
        if user_id is not None:
            stmt = stmt.where(Job.user_id == user_id)
        return await db.scalar(stmt)

    @staticmethod
    async def get_job_wait_state(
        db: AsyncSession,
        *,
        job_id: str,
        user_id: str | None = None,
    ) -> Job | None:
        stmt = (
            select(Job)
            .options(load_only(Job.id, Job.answer, Job.state, Job.last_error, Job.launcher_id, Job.boot_id, Job.instance_id, Job.attempt_id, Job.reservation_id, Job.attempt_count))
            .where(Job.id == job_id)
        )
        if user_id is not None:
            stmt = stmt.where(Job.user_id == user_id)
        return await db.scalar(stmt)

    @staticmethod
    async def list_job_summaries(
        db: AsyncSession,
        *,
        user_id: str | None,
        active_only: bool,
        limit: int,
        predicate: ColumnElement[bool] | None = None,
    ) -> list[JobSummary]:
        stmt = (
            select(
                Job.id,
                Job.user_id,
                Job.handler_type,
                Job.slave_app_id,
                Job.state,
                Job.launcher_id,
                Job.assigned_at,
                Job.answer_ready_at,
                Job.started_at,
                Job.finished_at,
                Job.cancel_requested_at,
                Job.last_error,
                Job.attempt_count,
                Job.attempt_id, Job.instance_id, Job.resources, Job.allocation, Job.cleanup_state, Job.waiting_reason,
                Job.progress.op("->")(-1).label("latest_progress"),
                Job.created_at,
                Job.updated_at,
            )
            .order_by(Job.created_at.desc(), Job.id.asc())
            .limit(limit)
        )
        if user_id is not None:
            stmt = stmt.where(Job.user_id == user_id)
        if predicate is not None:
            stmt = stmt.where(predicate)
        if active_only:
            stmt = stmt.where(
                Job.state.in_(
                    ("staged", "queued", "assigned", "answer_ready", "running", "finalizing")
                )
            )
        rows = (await db.execute(stmt)).all()
        return [
            JobSummary(
                id=str(row.id),
                user_id=str(row.user_id),
                handler_type=row.handler_type,
                slave_app_id=row.slave_app_id,
                state=row.state,
                launcher_id=str(row.launcher_id) if row.launcher_id else None,
                assigned_at=row.assigned_at,
                answer_ready_at=row.answer_ready_at,
                started_at=row.started_at,
                finished_at=row.finished_at,
                cancel_requested_at=row.cancel_requested_at,
                last_error=row.last_error,
                attempt_count=row.attempt_count,
                attempt_id=row.attempt_id, instance_id=row.instance_id, resources=row.resources or {},
                allocation=row.allocation, cleanup_state=row.cleanup_state, waiting_reason=row.waiting_reason,
                latest_progress=row.latest_progress,
                created_at=row.created_at,
                updated_at=row.updated_at,
            )
            for row in rows
        ]

    @staticmethod
    async def claim_next_compatible_job(db: AsyncSession, *, available_launchers: dict[str, dict]) -> tuple[Job, str] | None:
        if not available_launchers:
            return None
        await serialize_events(db)
        candidates = (await db.execute(
            select(Job, Launcher).options(defer(Job.input), defer(Job.artifact_metadata),
                defer(Job.progress), defer(Job.answer), defer(Job.offer))
            .outerjoin(JobBatch, JobBatch.id == Job.batch_id)
            .join(Launcher, and_(Launcher.user_id == Job.user_id,
                Launcher.slave_app_ids.op("?")(Job.slave_app_id),
                func.coalesce(Launcher.job_modes.op("->>")(Job.slave_app_id), "webrtc") == Job.job_mode,
                or_(func.coalesce(Job.input["storage_version"].astext, "0") != "1",
                    Launcher.storage_versions.op("->>")(Job.slave_app_id) == "1")))
            .where(Job.state == "queued", or_(Job.job_mode == "webrtc", Job.input.is_not(None)),
                Launcher.id.in_(available_launchers), Launcher.disconnected_at.is_(None),
                Launcher.status.in_(("ready", "busy")))
            .order_by(func.coalesce(JobBatch.last_dispatched_at, JobBatch.created_at, Job.created_at).asc(),
                Job.created_at.asc(), Job.item_index.asc().nulls_last(), Job.id.asc(),
                Launcher.last_heartbeat_at.desc(), Launcher.connected_at.asc(), Launcher.id.asc())
            .with_for_update(of=Job, skip_locked=True)
        )).all()
        for job, launcher in candidates:
            snapshot = available_launchers[str(launcher.id)]
            report = snapshot["resources"]
            if snapshot.get("rejected", {}).get(job.id, -1) >= report.get("revision", 0):
                continue
            if not resource_fits(job.resources or {}, report, job.slave_app_id, job.handler_type):
                job.waiting_reason = "resources_unavailable"
                continue
            now = utcnow()
            job.launcher_id = str(launcher.id)
            job.boot_id = snapshot["boot_id"]
            job.instance_id, job.reservation_id = str(uuid.uuid4()), str(uuid.uuid4())
            job.attempt_id = job.attempt_id or str(uuid.uuid4())
            job.attempt_count = max(1, job.attempt_count or 0)
            job.state, job.execution_phase, job.cleanup_state = "assigned", "reserving", "reserved"
            job.assigned_at = job.updated_at = now
            job.cleaned_at = None
            job.waiting_reason = None
            await sync_attempt(db, job)
            if job.batch_id is not None:
                batch = await db.get(JobBatch, job.batch_id)
                # Rotation compares against DB-generated created_at. Use the
                # same clock when API and PostgreSQL run on different hosts.
                batch.last_dispatched_at = func.clock_timestamp()
                batch.state = "running"
            await job_event(db, job, "job.assigned")
            await db.commit()
            return job, str(launcher.id)
        await db.commit()
        return None

    @staticmethod
    async def request_kill(
        db: AsyncSession,
        *,
        job_id: str,
        user_id: str | None = None,
        launcher_id: str | None = None,
    ) -> Job | None:
        await serialize_events(db)
        stmt = select(Job).where(Job.id == job_id).execution_options(populate_existing=True)
        if user_id is not None:
            stmt = stmt.where(Job.user_id == user_id)
        if launcher_id is not None:
            stmt = stmt.where(Job.launcher_id == launcher_id)
        job = await db.scalar(stmt.with_for_update())
        if job is None:
            await db.rollback()
            return None
        if job.state in JOB_TERMINAL_STATES:
            await db.commit()
            return job

        now = utcnow()
        job.cancel_requested_at = now
        job.updated_at = now
        if job.job_mode == "websocket":
            await finish_job(db, job, "cancelled", "Cancelled by user.")
        elif job.state == "queued":
            await finish_job(db, job, "killed", "Cancelled by user.")
        await db.commit()
        return job

    @staticmethod
    async def disconnect_launchers_and_fail_jobs(db: AsyncSession, *, launcher_ids: set[str] | list[str], detail: str) -> list[Job]:
        if not launcher_ids:
            await db.commit()
            return []
        await serialize_events(db)
        now = utcnow()
        await db.execute(update(Launcher).where(Launcher.id.in_(launcher_ids)).values(
            status="disconnected", disconnected_at=now, updated_at=now))
        jobs = list((await db.scalars(select(Job).where(Job.launcher_id.in_(launcher_ids),
            Job.state.in_(JOB_ACTIVE_STATES)).with_for_update())).all())
        for job in jobs:
            await finish_job(db, job, "cancelled" if job.cancel_requested_at else "failed", detail)
        await db.commit()
        return jobs

    @staticmethod
    async def recover_after_server_restart(db: AsyncSession) -> list[Job]:
        await serialize_events(db)
        now = utcnow()
        await db.execute(update(Launcher).where(Launcher.disconnected_at.is_(None)).values(
            status="recovering", reconnect_deadline=now + timedelta(seconds=30), updated_at=now))
        jobs = list((await db.scalars(select(Job).where(Job.state.in_(JOB_ACTIVE_STATES),
            Job.reservation_id.is_not(None)).with_for_update())).all())
        for job in jobs:
            if job.waiting_reason != "recovering":
                job.waiting_reason = "recovering"
                await job_event(db, job, "job.recovering", {"waiting_reason": "recovering"})
        await db.commit()
        return jobs

    @staticmethod
    async def expire_stale_jobs(db: AsyncSession) -> list[Job]:
        await serialize_events(db)
        now = utcnow()
        jobs = list(
            (
                await db.scalars(
                    select(Job)
                    .where(
                        or_(
                            and_(
                                Job.job_mode == "webrtc",
                                Job.state == "queued",
                                Job.created_at < now - JOB_MAX_LIFETIME,
                            ),
                            and_(
                                Job.job_mode == "webrtc",
                                Job.state.in_(JOB_ACTIVE_STATES),
                                or_(
                                    Job.created_at < now - JOB_MAX_LIFETIME,
                                    Job.updated_at < now - JOB_IDLE_TIMEOUT,
                                ),
                            ),
                            and_(
                                Job.job_mode == "websocket",
                                Job.state == "assigned",
                                Job.assigned_at < now - timedelta(minutes=2),
                            ),
                            and_(
                                Job.job_mode == "websocket",
                                Job.state.in_(("running", "finalizing")),
                                # The live worker connection checks idle frames; a
                                # progressing large upload must not expire here.
                                Job.started_at < now - timedelta(hours=2, minutes=3),
                            ),
                        )
                    )
                    .with_for_update(skip_locked=True)
                )
            ).all()
        )
        if not jobs:
            await db.rollback()
            return []

        for job in jobs:
            detail = "Worker execution or connection timed out." if job.job_mode == "websocket" else (
                "job lifetime exceeded" if job.created_at < now - JOB_MAX_LIFETIME else "job idle timeout")
            await finish_job(db, job, "cancelled" if job.cancel_requested_at else "failed", detail)
        await db.commit()
        return jobs
