from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlparse, urlunparse

from sqlalchemy import and_, cast, or_, select, update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import load_only

from gpstation.db import Job, Launcher
from gpstation.models import JobData, JobSummary
from settings import settings


JOB_TERMINAL_STATES = {"succeeded", "failed", "cancelled", "killed"}
JOB_ACTIVE_STATES = {"assigned", "answer_ready", "running"}
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
    ) -> Job:
        job = Job(
            user_id=user_id,
            handler_type=handler_type,
            slave_app_id=slave_app_id,
            offer=offer,
            state="queued",
            progress=[],
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
            .options(load_only(Job.id, Job.answer, Job.state, Job.last_error))
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
                Job.progress.op("->")(-1).label("latest_progress"),
                Job.created_at,
                Job.updated_at,
            )
            .order_by(Job.created_at.desc(), Job.id.asc())
            .limit(limit)
        )
        if user_id is not None:
            stmt = stmt.where(Job.user_id == user_id)
        if active_only:
            stmt = stmt.where(Job.state.in_(("queued", "assigned", "answer_ready", "running")))
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
                latest_progress=row.latest_progress,
                created_at=row.created_at,
                updated_at=row.updated_at,
            )
            for row in rows
        ]

    @staticmethod
    async def claim_next_compatible_job(
        db: AsyncSession,
        *,
        idle_launcher_ids: set[str],
    ) -> tuple[Job, str] | None:
        if not idle_launcher_ids:
            return None
        assignment = (
            await db.execute(
                select(Job, Launcher)
                .join(
                    Launcher,
                    and_(
                        Launcher.user_id == Job.user_id,
                        Launcher.slave_app_ids.op("?")(Job.slave_app_id),
                    ),
                )
                .where(
                    Job.state == "queued",
                    Launcher.id.in_(idle_launcher_ids),
                    Launcher.disconnected_at.is_(None),
                    Launcher.status == "ready",
                )
                .order_by(
                    Job.created_at.asc(),
                    Job.id.asc(),
                    Launcher.last_heartbeat_at.desc(),
                    Launcher.connected_at.asc(),
                    Launcher.id.asc(),
                )
                .limit(1)
                .with_for_update(of=(Job, Launcher), skip_locked=True)
            )
        ).first()
        if assignment is None:
            await db.rollback()
            return None

        job, launcher = assignment
        launcher_id = str(launcher.id)
        now = utcnow()
        launcher.status = "busy"
        launcher.updated_at = now
        job.launcher_id = launcher_id
        job.state = "assigned"
        job.assigned_at = now
        job.attempt_count = int(job.attempt_count or 0) + 1
        job.updated_at = now
        await db.commit()
        return job, launcher_id

    @staticmethod
    async def mark_launcher_answer(
        db: AsyncSession,
        *,
        job_id: str,
        launcher_id: str,
        user_id: str,
        answer: dict[str, Any],
    ) -> Job | None:
        now = utcnow()
        return await JobService._update_launcher_job(
            db,
            job_id=job_id,
            launcher_id=launcher_id,
            user_id=user_id,
            expected_states={"assigned"},
            values={
                "answer": answer,
                "answer_ready_at": now,
                "state": "answer_ready",
                "updated_at": now,
            },
        )

    @staticmethod
    async def mark_launcher_running(
        db: AsyncSession,
        *,
        job_id: str,
        launcher_id: str,
        user_id: str,
    ) -> Job | None:
        now = utcnow()
        return await JobService._update_launcher_job(
            db,
            job_id=job_id,
            launcher_id=launcher_id,
            user_id=user_id,
            expected_states={"answer_ready"},
            values={"state": "running", "started_at": now, "updated_at": now},
        )

    @staticmethod
    async def append_launcher_progress(
        db: AsyncSession,
        *,
        job_id: str,
        launcher_id: str,
        user_id: str,
        progress: Any,
    ) -> Job | None:
        now = utcnow()
        item = {"time": now.isoformat(), "progress": progress}
        return await JobService._update_launcher_job(
            db,
            job_id=job_id,
            launcher_id=launcher_id,
            user_id=user_id,
            expected_states={"running"},
            values={
                "progress": Job.progress.op("||")(cast([item], JSONB)),
                "updated_at": now,
            },
        )

    @staticmethod
    async def mark_launcher_result(
        db: AsyncSession,
        *,
        job_id: str,
        launcher_id: str,
        user_id: str,
    ) -> Job | None:
        now = utcnow()
        return await JobService._update_launcher_job(
            db,
            job_id=job_id,
            launcher_id=launcher_id,
            user_id=user_id,
            expected_states={"running"},
            values={"state": "succeeded", "finished_at": now, "updated_at": now},
            release_launcher=True,
        )

    @staticmethod
    async def mark_launcher_error(
        db: AsyncSession,
        *,
        job_id: str,
        launcher_id: str,
        user_id: str,
        detail: str,
        state: str = "failed",
    ) -> Job | None:
        now = utcnow()
        return await JobService._update_launcher_job(
            db,
            job_id=job_id,
            launcher_id=launcher_id,
            user_id=user_id,
            expected_states=JOB_ACTIVE_STATES,
            values={"state": state, "last_error": detail, "finished_at": now, "updated_at": now},
            release_launcher=True,
        )

    @staticmethod
    async def _update_launcher_job(
        db: AsyncSession,
        *,
        job_id: str,
        launcher_id: str,
        user_id: str,
        expected_states: set[str],
        values: dict[str, Any],
        extra_conditions: tuple[Any, ...] = (),
        release_launcher: bool = False,
    ) -> Job | None:
        job = await db.scalar(
            update(Job)
            .where(
                Job.id == job_id,
                Job.launcher_id == launcher_id,
                Job.user_id == user_id,
                Job.state.in_(expected_states),
                *extra_conditions,
            )
            .values(**values)
            .returning(Job)
            .execution_options(populate_existing=True)
        )
        if job is None:
            await db.rollback()
            return None
        if release_launcher:
            await db.execute(
                update(Launcher)
                .where(
                    Launcher.id == launcher_id,
                    Launcher.user_id == user_id,
                    Launcher.disconnected_at.is_(None),
                )
                .values(status="ready", updated_at=utcnow())
            )
        await db.commit()
        return job

    @staticmethod
    async def request_kill(
        db: AsyncSession,
        *,
        job_id: str,
        user_id: str | None = None,
        launcher_id: str | None = None,
    ) -> Job | None:
        stmt = (
            select(Job)
            .where(Job.id == job_id)
            .execution_options(populate_existing=True)
        )
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
        if job.state == "queued":
            job.state = "killed"
            job.finished_at = now
        await db.commit()
        return job

    @staticmethod
    async def fail_assigned_job(
        db: AsyncSession,
        *,
        job_id: str,
        launcher_id: str,
        detail: str,
        state: str = "failed",
    ) -> Job | None:
        now = utcnow()
        job = await db.scalar(
            update(Job)
            .where(
                Job.id == job_id,
                Job.launcher_id == launcher_id,
                Job.state.in_(JOB_ACTIVE_STATES),
            )
            .values(state=state, last_error=detail, finished_at=now, updated_at=now)
            .returning(Job)
        )
        if job is None:
            await db.rollback()
            return None
        await db.execute(
            update(Launcher)
            .where(Launcher.id == launcher_id, Launcher.disconnected_at.is_(None))
            .values(status="ready", updated_at=now)
        )
        await db.commit()
        return job

    @staticmethod
    async def disconnect_launchers_and_fail_jobs(
        db: AsyncSession,
        *,
        launcher_ids: set[str] | list[str],
        detail: str,
    ) -> list[Job]:
        launcher_ids = {str(launcher_id) for launcher_id in launcher_ids}
        if not launcher_ids:
            await db.rollback()
            return []
        now = utcnow()
        await db.execute(
            update(Launcher)
            .where(Launcher.id.in_(launcher_ids))
            .values(status="disconnected", disconnected_at=now, updated_at=now)
        )
        jobs = list(
            (
                await db.scalars(
                    update(Job)
                    .where(
                        Job.launcher_id.in_(launcher_ids),
                        Job.state.in_(JOB_ACTIVE_STATES),
                    )
                    .values(state="failed", last_error=detail, finished_at=now, updated_at=now)
                    .returning(Job)
                )
            ).all()
        )
        await db.commit()
        return jobs

    @staticmethod
    async def recover_after_server_restart(db: AsyncSession) -> list[Job]:
        now = utcnow()
        await db.execute(
            update(Launcher)
            .where(Launcher.disconnected_at.is_(None))
            .values(status="disconnected", disconnected_at=now, updated_at=now)
        )
        jobs = list(
            (
                await db.scalars(
                    update(Job)
                    .where(
                        Job.launcher_id.is_not(None),
                        Job.state.in_(JOB_ACTIVE_STATES),
                    )
                    .values(
                        state="failed",
                        last_error="server restarted",
                        finished_at=now,
                        updated_at=now,
                    )
                    .returning(Job)
                )
            ).all()
        )
        await db.commit()
        return jobs

    @staticmethod
    async def expire_stale_jobs(db: AsyncSession) -> list[Job]:
        now = utcnow()
        jobs = list(
            (
                await db.scalars(
                    select(Job)
                    .where(
                        or_(
                            and_(Job.state == "queued", Job.created_at < now - JOB_MAX_LIFETIME),
                            and_(
                                Job.state.in_(JOB_ACTIVE_STATES),
                                or_(
                                    Job.created_at < now - JOB_MAX_LIFETIME,
                                    Job.updated_at < now - JOB_IDLE_TIMEOUT,
                                ),
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

        launcher_ids: set[str] = set()
        for job in jobs:
            job.state = "failed"
            job.last_error = (
                "job lifetime exceeded"
                if job.created_at < now - JOB_MAX_LIFETIME
                else "job idle timeout"
            )
            job.finished_at = now
            job.updated_at = now
            if job.launcher_id:
                launcher_ids.add(str(job.launcher_id))
        if launcher_ids:
            await db.execute(
                update(Launcher)
                .where(
                    Launcher.id.in_(launcher_ids),
                    Launcher.disconnected_at.is_(None),
                )
                .values(status="ready", updated_at=now)
            )
        await db.commit()
        return jobs
