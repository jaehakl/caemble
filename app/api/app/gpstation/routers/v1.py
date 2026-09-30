from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, status
from sqlalchemy.ext.asyncio import AsyncSession

from gpstation.models import (
    JobAnswerWaitResult,
    JobData,
    LauncherView,
    OkResponse,
)
from gpstation.service.auth_service import Principal, require_client
from gpstation.service.job_orchestrator import job_orchestrator
from gpstation.service.job_service import JobService, job_to_data
from gpstation.service.launcher_connection import run_launcher_control
from gpstation.service.worker_connection import run_worker_connection
from gpstation.service.launcher_service import LauncherService
from db import get_db

router = APIRouter(prefix="/v1")


@router.websocket("/jobs/{job_id}/stream")
async def worker_stream(websocket: WebSocket, job_id: str) -> None:
    await run_worker_connection(websocket, job_id)


@router.get("/launchers", response_model=list[LauncherView], tags=["v1-launchers"])
async def list_launchers(
    principal: Principal = Depends(require_client),
    db: AsyncSession = Depends(get_db),
) -> list[LauncherView]:
    return await LauncherService.list_launchers_for_user(db, principal.user_id)


@router.websocket("/launchers/control")
async def launcher_control(websocket: WebSocket) -> None:
    await run_launcher_control(websocket)


@router.get("/jobs/{job_id}", response_model=JobData, tags=["v1-jobs"])
async def get_job(
    job_id: str,
    principal: Principal = Depends(require_client),
    db: AsyncSession = Depends(get_db),
) -> JobData:
    job = await JobService.get_job(db, job_id=job_id, user_id=principal.user_id)
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Job not found",
        )
    return job_to_data(job)


@router.get(
    "/jobs/{job_id}/wait-answer",
    response_model=JobAnswerWaitResult,
    tags=["v1-jobs"],
)
async def wait_job_answer(
    job_id: str,
    wait_seconds: float = Query(default=30.0),
    principal: Principal = Depends(require_client),
    db: AsyncSession = Depends(get_db),
) -> JobAnswerWaitResult:
    job = await job_orchestrator.wait_for_answer(
        db,
        job_id=job_id,
        user_id=principal.user_id,
        wait_seconds=wait_seconds,
    )
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Job not found",
        )
    return JobAnswerWaitResult(
        job_id=str(job.id), launcher_id=job.launcher_id, boot_id=job.boot_id, instance_id=job.instance_id,
        attempt_id=job.attempt_id, reservation_id=job.reservation_id, attempt_count=job.attempt_count,
        state=job.state,
        answer=job.answer,
        last_error=job.last_error,
    )
