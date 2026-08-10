from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from gpstation.models import (
    AccessKeyCreate,
    AccessKeyCreateResult,
    CrudDeleteRequest,
    CrudDeleteResponse,
    CrudListRequest,
    CrudListResponse,
    JobAnswerWaitResult,
    JobCreateRequest,
    JobCreateResult,
    JobData,
    JobSummary,
    LauncherReconcileResponse,
    LauncherRuntimeData,
    LauncherView,
    OkResponse,
)
from gpstation.service.access_key_service import AccessKeyService
from gpstation.service.job_orchestrator import job_orchestrator
from gpstation.service.job_service import JobService, build_job_wait_url, job_to_data
from gpstation.service.launcher_service import LauncherService
from gpstation.service.web_service import (
    cancel_launcher_current_job as cancel_launcher_job,
)
from gpstation.service.web_service import (
    create_access_token,
    get_access_key as get_access_key_row,
    get_launcher as get_launcher_crud_row,
    is_admin,
    issue_csrf_token,
    list_access_keys as list_access_key_rows,
    list_launcher_runtime as get_launcher_runtime,
    list_launchers as list_launcher_crud_rows,
    reconcile_disconnected_launchers as reconcile_launchers,
    reset_launcher_worker as reset_worker,
)
from gpstation.utils.csrf import require_web_csrf
from models import UserData
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles


router = APIRouter(prefix="/web", dependencies=[Depends(require_web_csrf)])


@router.get("/auth/csrf", tags=["web-auth"])
async def csrf_token(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    return await issue_csrf_token(request, db)


@router.get("/jobs", response_model=list[JobSummary], tags=["web-jobs"])
async def list_jobs(
    active_only: bool = Query(default=False),
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: UserData = Depends(require_roles(["admin", "user"])),
) -> list[JobSummary]:
    return await JobService.list_job_summaries(
        db,
        user_id=None if is_admin(current_user) else current_user.id,
        active_only=active_only,
        limit=limit,
    )


@router.post("/jobs", response_model=JobCreateResult, tags=["web-jobs"])
async def create_job(
    body: JobCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: UserData = Depends(require_roles(["admin", "user"])),
) -> JobCreateResult:
    try:
        job = await job_orchestrator.create_job(
            db,
            user_id=current_user.id,
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
        answer_wait_url=build_job_wait_url(str(job.id), "/web/jobs"),
    )


@router.get("/jobs/{job_id}", response_model=JobData, tags=["web-jobs"])
async def get_job(
    job_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: UserData = Depends(require_roles(["admin", "user"])),
) -> JobData:
    job = await JobService.get_job(
        db,
        job_id=job_id,
        user_id=None if is_admin(current_user) else current_user.id,
    )
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Job not found",
        )
    return job_to_data(job)


@router.get(
    "/jobs/{job_id}/wait-answer",
    response_model=JobAnswerWaitResult,
    tags=["web-jobs"],
)
async def wait_job_answer(
    job_id: str,
    wait_seconds: float = Query(default=30.0, ge=0, le=60),
    db: AsyncSession = Depends(get_db),
    current_user: UserData = Depends(require_roles(["admin", "user"])),
) -> JobAnswerWaitResult:
    job = await job_orchestrator.wait_for_answer(
        db,
        job_id=job_id,
        user_id=None if is_admin(current_user) else current_user.id,
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


@router.post("/jobs/{job_id}/kill", response_model=OkResponse, tags=["web-jobs"])
async def kill_job(
    job_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: UserData = Depends(require_roles(["admin", "user"])),
) -> OkResponse:
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


@router.get("/launchers", response_model=list[LauncherView], tags=["web-launchers"])
async def list_launchers(
    db: AsyncSession = Depends(get_db),
    current_user: UserData = Depends(require_roles(["admin", "user"])),
) -> list[LauncherView]:
    return await LauncherService.list_launchers_for_user(
        db,
        None if is_admin(current_user) else current_user.id,
    )


@router.post(
    "/launchers/reconcile-disconnected",
    response_model=LauncherReconcileResponse,
    tags=["web-launchers"],
)
async def reconcile_disconnected_launchers(
    db: AsyncSession = Depends(get_db),
    current_user: UserData = Depends(require_roles(["admin", "user"])),
) -> LauncherReconcileResponse:
    return LauncherReconcileResponse(
        launchers=await reconcile_launchers(db, current_user)
    )


@router.get(
    "/launchers/runtime",
    response_model=list[LauncherRuntimeData],
    tags=["web-launchers"],
)
async def list_launcher_runtime(
    db: AsyncSession = Depends(get_db),
    current_user: UserData = Depends(require_roles(["admin", "user"])),
) -> list[LauncherRuntimeData]:
    return await get_launcher_runtime(db, current_user)


@router.post(
    "/launchers/{launcher_id}/cancel-current-job",
    response_model=OkResponse,
    tags=["web-launchers"],
)
async def cancel_launcher_current_job(
    launcher_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: UserData = Depends(require_roles(["admin", "user"])),
) -> OkResponse:
    await cancel_launcher_job(db, launcher_id, current_user)
    return OkResponse()


@router.post(
    "/launchers/{launcher_id}/reset-worker",
    response_model=OkResponse,
    tags=["web-launchers"],
)
async def reset_launcher_worker(
    launcher_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: UserData = Depends(require_roles(["admin", "user"])),
) -> OkResponse:
    await reset_worker(db, launcher_id, current_user)
    return OkResponse()


@router.post(
    "/users/me/access-tokens",
    response_model=AccessKeyCreateResult,
    tags=["web-users"],
)
async def create_my_access_token(
    payload: AccessKeyCreate,
    db: AsyncSession = Depends(get_db),
    current_user: UserData = Depends(require_roles(["admin", "user"])),
) -> AccessKeyCreateResult:
    return await create_access_token(db, current_user.id, payload)


@router.post(
    "/users/{user_id}/access-tokens",
    response_model=AccessKeyCreateResult,
    tags=["web-users"],
)
async def create_user_access_token(
    user_id: str,
    payload: AccessKeyCreate,
    db: AsyncSession = Depends(get_db),
    _current_user: UserData = Depends(require_roles(["admin"])),
) -> AccessKeyCreateResult:
    return await create_access_token(db, user_id, payload)


@router.post(
    "/crud/access_keys/list",
    response_model=CrudListResponse,
    tags=["crud-access-keys"],
)
async def list_access_keys(
    body: CrudListRequest,
    db: AsyncSession = Depends(get_db),
    current_user: UserData = Depends(require_roles(["admin", "user"])),
) -> CrudListResponse:
    return await list_access_key_rows(db, body, current_user)


@router.get("/crud/access_keys/{row_id}", tags=["crud-access-keys"])
async def get_access_key(
    row_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: UserData = Depends(require_roles(["admin", "user"])),
) -> dict[str, Any]:
    return await get_access_key_row(db, row_id, current_user)


@router.post(
    "/crud/access_keys/delete",
    response_model=CrudDeleteResponse,
    tags=["crud-access-keys"],
)
async def delete_access_keys(
    body: CrudDeleteRequest,
    db: AsyncSession = Depends(get_db),
    current_user: UserData = Depends(require_roles(["admin", "user"])),
) -> CrudDeleteResponse:
    deleted = await AccessKeyService.revoke_access_keys(
        db,
        body.ids,
        user_id=None if is_admin(current_user) else current_user.id,
    )
    return CrudDeleteResponse(deleted=deleted)


@router.post(
    "/crud/launchers/list",
    response_model=CrudListResponse,
    tags=["crud-launchers"],
)
async def list_launcher_rows(
    body: CrudListRequest,
    db: AsyncSession = Depends(get_db),
    current_user: UserData = Depends(require_roles(["admin", "user"])),
) -> CrudListResponse:
    return await list_launcher_crud_rows(db, body, current_user)


@router.get("/crud/launchers/{row_id}", tags=["crud-launchers"])
async def get_launcher_row(
    row_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: UserData = Depends(require_roles(["admin", "user"])),
) -> dict[str, Any]:
    return await get_launcher_crud_row(db, row_id, current_user)
