from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, status
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from gpstation.models import (
    JobAnswerWaitResult,
    JobCreateRequest,
    JobCreateResult,
    JobData,
    LauncherView,
    OkResponse,
)
from gpstation.service.auth_service import Principal, require_client
from gpstation.service.job_orchestrator import job_orchestrator
from gpstation.service.job_service import JobService, build_job_wait_url, job_to_data
from gpstation.service.launcher_connection import run_launcher_control
from gpstation.service.launcher_service import LauncherService
from user_auth.routes import get_db


router = APIRouter(prefix="/v1")


@router.get("/launchers", response_model=list[LauncherView], tags=["v1-launchers"])
async def list_launchers(
    principal: Principal = Depends(require_client),
    db: AsyncSession = Depends(get_db),
) -> list[LauncherView]:
    return await LauncherService.list_launchers_for_user(db, principal.user_id)


@router.websocket("/launchers/control")
async def launcher_control(websocket: WebSocket) -> None:
    await run_launcher_control(websocket)


@router.post("/jobs", response_model=JobCreateResult, tags=["v1-jobs"])
async def create_job(
    body: JobCreateRequest,
    principal: Principal = Depends(require_client),
    db: AsyncSession = Depends(get_db),
) -> JobCreateResult:
    try:
        job = await job_orchestrator.create_job(
            db,
            user_id=principal.user_id,
            handler_type=body.handler_type,
            slave_app_id=body.slave_app_id,
            offer=body.offer,
        )
    except (ValueError, ValidationError) as error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(error),
        ) from error
    return JobCreateResult(
        job=job_to_data(job),
        answer_wait_url=build_job_wait_url(str(job.id), "/v1/jobs"),
    )


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
    wait_seconds: float = Query(default=30.0, ge=0, le=60),
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
        job_id=str(job.id),
        state=job.state,
        answer=job.answer,
        last_error=job.last_error,
    )


@router.post("/jobs/{job_id}/kill", response_model=OkResponse, tags=["v1-jobs"])
async def kill_job(
    job_id: str,
    principal: Principal = Depends(require_client),
    db: AsyncSession = Depends(get_db),
) -> OkResponse:
    job = await job_orchestrator.kill_job(
        db,
        job_id=job_id,
        user_id=principal.user_id,
        reason="killed by client",
    )
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Job not found",
        )
    return OkResponse()
