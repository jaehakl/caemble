"""Caemble policies on the public GPStation HTTP endpoints."""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from db import get_db
from gpstation.models import JobCreateRequest, JobCreateResult, JobSummary, OkResponse
from gpstation.service.auth_service import Principal, require_client
from gpstation.service.job_orchestrator import job_orchestrator
from gpstation.service.job_service import JobService, build_job_wait_url, job_to_data
from gpstation.service.web_service import is_admin
from gpstation.utils.csrf import require_web_csrf
from optimization.guards import require_unmanaged_execution, unmanaged_execution_clause
from prediction.training import require_unmanaged_job
from user_auth.schemas import UserData
from user_auth.utils.auth_wrapper import require_roles

web_router = APIRouter(prefix="/web", dependencies=[Depends(require_web_csrf)])
v1_router = APIRouter(prefix="/v1")


@web_router.get("/jobs", response_model=list[JobSummary], tags=["web-jobs"], name="list_jobs")
async def web_list_jobs(
    active_only: bool = Query(default=False),
    exclude_optimizations: bool = Query(default=False),
    limit: int = Query(default=100),
    db: AsyncSession = Depends(get_db),
    current_user: UserData = Depends(require_roles(["admin", "user"])),
) -> list[JobSummary]:
    return await JobService.list_job_summaries(
        db,
        user_id=None if is_admin(current_user) else current_user.id,
        active_only=active_only,
        limit=limit,
        predicate=unmanaged_execution_clause() if exclude_optimizations else None,
    )


@web_router.post("/jobs", response_model=JobCreateResult, tags=["web-jobs"], name="create_job")
async def web_create_job(
    body: JobCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: UserData = Depends(require_roles(["admin", "user"])),
) -> JobCreateResult:
    if body.slave_app_id == "predictor-training" or body.handler_type == "prediction.train":
        raise HTTPException(422, "Training jobs must be submitted through Prediction operations.")
    if body.slave_app_id in {"cae", "evaluation"} or body.handler_type.startswith("cae."):
        raise HTTPException(422, "CAE jobs must be submitted through CAE Batch or Optimization endpoints.")
    job = await job_orchestrator.create_job(
        db,
        user_id=current_user.id,
        handler_type=body.handler_type,
        slave_app_id=body.slave_app_id,
        offer=body.offer,
        resources=body.resources.model_dump(exclude_none=True) if body.resources else {},
        target_launcher_id=str(body.target_launcher_id) if body.target_launcher_id else None,
    )
    return JobCreateResult(
        job=job_to_data(job),
        answer_wait_url=build_job_wait_url(str(job.id), "/web/jobs"),
    )


@web_router.post("/jobs/{job_id}/kill", response_model=OkResponse, tags=["web-jobs"], name="kill_job")
async def web_kill_job(
    job_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: UserData = Depends(require_roles(["admin", "user"])),
) -> OkResponse:
    await require_unmanaged_execution(db, job_id=job_id, user_id=None if is_admin(current_user) else current_user.id)
    await require_unmanaged_job(db, job_id, None if is_admin(current_user) else current_user.id)
    job = await job_orchestrator.kill_job(
        db,
        job_id=job_id,
        user_id=None if is_admin(current_user) else current_user.id,
        reason="killed by website",
    )
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Job not found",
        )
    return OkResponse()


@v1_router.post("/jobs", response_model=JobCreateResult, tags=["v1-jobs"], name="create_job")
async def v1_create_job(
    body: JobCreateRequest,
    principal: Principal = Depends(require_client),
    db: AsyncSession = Depends(get_db),
) -> JobCreateResult:
    if body.slave_app_id == "predictor-training" or body.handler_type == "prediction.train":
        raise HTTPException(422, "Training jobs must be submitted through Prediction operations.")
    if body.slave_app_id in {"cae", "evaluation"} or body.handler_type.startswith("cae."):
        raise HTTPException(422, "CAE jobs must be submitted through CAE Batch or Optimization endpoints.")
    job = await job_orchestrator.create_job(
        db,
        user_id=principal.user_id,
        handler_type=body.handler_type,
        slave_app_id=body.slave_app_id,
        offer=body.offer,
        resources=body.resources.model_dump(exclude_none=True) if body.resources else {},
        target_launcher_id=str(body.target_launcher_id) if body.target_launcher_id else None,
    )
    return JobCreateResult(
        job=job_to_data(job),
        answer_wait_url=build_job_wait_url(str(job.id), "/v1/jobs"),
    )


@v1_router.post("/jobs/{job_id}/kill", response_model=OkResponse, tags=["v1-jobs"], name="kill_job")
async def v1_kill_job(
    job_id: str,
    principal: Principal = Depends(require_client),
    db: AsyncSession = Depends(get_db),
) -> OkResponse:
    await require_unmanaged_execution(db, job_id=job_id, user_id=principal.user_id)
    await require_unmanaged_job(db, job_id, principal.user_id)
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

