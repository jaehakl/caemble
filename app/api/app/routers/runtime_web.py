from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import Text, and_, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from models import (
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
    LauncherView,
    OkResponse,
    UserData,
)
from routers.runtime_v1 import build_job_wait_url
from runtime_csrf import make_csrf_token, require_web_csrf
from runtime_state import runtime
from service.access_key_service import AccessKeyService
from service.job_orchestrator import job_orchestrator
from service.job_service import JobService, job_to_data
from service.launcher_service import LauncherService
from user_auth.db import APIKey, Job, Launcher, User
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles
from user_auth.utils.jwt import verify_token


router = APIRouter(prefix="/web", dependencies=[Depends(require_web_csrf)])


class LauncherReconcileResponse(BaseModel):
    ok: bool = True
    launchers: int


class LauncherRuntimeData(BaseModel):
    launcher_id: str
    current_job_id: str | None = None
    loaded_slave_app_id: str | None = None
    worker_status: str | None = None
    resetting: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)


ACCESS_KEY_PUBLIC_FIELDS = (
    "id",
    "user_id",
    "key_type",
    "name",
    "key_prefix",
    "scopes",
    "status",
    "rate_limit_per_minute",
    "allowed_ips",
    "allowed_origins",
    "last_used_at",
    "expires_at",
    "created_at",
    "revoked_at",
)
LAUNCHER_PUBLIC_FIELDS = (
    "id",
    "user_id",
    "launcher_name",
    "ip_address",
    "status",
    "slave_app_ids",
    "connected_at",
    "last_heartbeat_at",
    "disconnected_at",
    "created_at",
    "updated_at",
)


@router.get("/auth/csrf", tags=["web-auth"])
async def csrf_token(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    refresh_token = request.cookies.get("refresh_token")
    if not refresh_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No refresh token")
    try:
        claims = verify_token(refresh_token, "refresh")
    except Exception as error:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token") from error
    user = await db.get(User, claims["sub"])
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User inactive")
    return {"csrf_token": make_csrf_token(refresh_token)}


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
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
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
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
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
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
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
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
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
    launchers = await job_orchestrator.reconcile_disconnected_launchers(
        db,
        connected_launcher_ids=await runtime.get_launcher_ids(),
        user_id=None if is_admin(current_user) else current_user.id,
    )
    return LauncherReconcileResponse(launchers=launchers)


@router.get(
    "/launchers/runtime",
    response_model=list[LauncherRuntimeData],
    tags=["web-launchers"],
)
async def list_launcher_runtime(
    db: AsyncSession = Depends(get_db),
    current_user: UserData = Depends(require_roles(["admin", "user"])),
) -> list[LauncherRuntimeData]:
    snapshots = await runtime.launcher_snapshots()
    if not snapshots:
        return []
    stmt = select(Launcher).where(Launcher.id.in_(snapshots))
    if not is_admin(current_user):
        stmt = stmt.where(Launcher.user_id == current_user.id)
    launchers = (await db.scalars(stmt)).all()
    return [
        LauncherRuntimeData(launcher_id=str(launcher.id), **snapshots[str(launcher.id)])
        for launcher in launchers
        if str(launcher.id) in snapshots
    ]


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
    launcher = await scoped_launcher(db, launcher_id, current_user)
    snapshot = (await runtime.launcher_snapshots()).get(str(launcher.id))
    job_id = snapshot.get("current_job_id") if snapshot else None
    if job_id:
        await job_orchestrator.kill_job(
            db,
            job_id=str(job_id),
            user_id=None if is_admin(current_user) else current_user.id,
            launcher_id=str(launcher.id),
            reason="cancelled by website",
        )
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
    launcher = await scoped_launcher(db, launcher_id, current_user)
    accepted = await job_orchestrator.reset_launcher_worker(
        db,
        launcher_id=str(launcher.id),
        user_id=None if is_admin(current_user) else current_user.id,
    )
    if not accepted:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Launcher reset is already in progress or the launcher is offline",
        )
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
    return await list_crud_rows(
        db,
        APIKey,
        ACCESS_KEY_PUBLIC_FIELDS,
        ("key_type", "name", "key_prefix", "status", "scopes"),
        (
            "key_type",
            "name",
            "status",
            "last_used_at",
            "expires_at",
            "created_at",
            "revoked_at",
        ),
        body,
        current_user,
        default_sort=("created_at", "desc"),
    )


@router.get("/crud/access_keys/{row_id}", tags=["crud-access-keys"])
async def get_access_key(
    row_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: UserData = Depends(require_roles(["admin", "user"])),
) -> dict[str, Any]:
    return await get_crud_row(
        db,
        APIKey,
        ACCESS_KEY_PUBLIC_FIELDS,
        row_id,
        current_user,
    )


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
    return await list_crud_rows(
        db,
        Launcher,
        LAUNCHER_PUBLIC_FIELDS,
        ("launcher_name", "ip_address", "status", "slave_app_ids"),
        (
            "launcher_name",
            "status",
            "connected_at",
            "last_heartbeat_at",
            "disconnected_at",
            "created_at",
            "updated_at",
        ),
        body,
        current_user,
        default_sort=("last_heartbeat_at", "desc"),
    )


@router.get("/crud/launchers/{row_id}", tags=["crud-launchers"])
async def get_launcher_row(
    row_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: UserData = Depends(require_roles(["admin", "user"])),
) -> dict[str, Any]:
    return await get_crud_row(
        db,
        Launcher,
        LAUNCHER_PUBLIC_FIELDS,
        row_id,
        current_user,
    )


async def create_access_token(
    db: AsyncSession,
    user_id: str,
    payload: AccessKeyCreate,
) -> AccessKeyCreateResult:
    try:
        return await AccessKeyService.create_user_access_key(db, user_id, payload)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error


async def scoped_launcher(
    db: AsyncSession,
    launcher_id: str,
    current_user: UserData,
) -> Launcher:
    stmt = select(Launcher).where(Launcher.id == launcher_id)
    if not is_admin(current_user):
        stmt = stmt.where(Launcher.user_id == current_user.id)
    launcher = await db.scalar(stmt)
    if launcher is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Launcher not found")
    return launcher


async def list_crud_rows(
    db: AsyncSession,
    model: type[Any],
    public_fields: tuple[str, ...],
    searchable_fields: tuple[str, ...],
    sortable_fields: tuple[str, ...],
    body: CrudListRequest,
    current_user: UserData,
    *,
    default_sort: tuple[str, str],
) -> CrudListResponse:
    clauses: list[Any] = []
    if not is_admin(current_user):
        clauses.append(model.user_id == current_user.id)
    if body.selected_ids:
        clauses.append(model.id.in_(list(dict.fromkeys(body.selected_ids))))
    search_text = (body.search_text or "").strip()
    if search_text:
        clauses.append(
            or_(
                *[
                    cast(getattr(model, field_name), Text).ilike(f"%{search_text}%")
                    for field_name in searchable_fields
                ]
            )
        )
    for field_name, values in body.text_filter.items():
        if field_name not in public_fields or not values:
            continue
        column = getattr(model, field_name, None)
        if column is not None:
            conditions = [
                cast(column, Text).ilike(f"%{value.strip()}%")
                for value in values
                if isinstance(value, str) and value.strip()
            ]
            if conditions:
                clauses.append(or_(*conditions))
    for field_name, bounds in body.filter.items():
        if field_name not in public_fields or not bounds:
            continue
        column = getattr(model, field_name, None)
        if column is None:
            continue
        try:
            python_type = column.type.python_type
        except (AttributeError, NotImplementedError):
            continue
        range_conditions = []
        for index, comparison in ((0, "minimum"), (1, "maximum")):
            if len(bounds) <= index or bounds[index] is None:
                continue
            try:
                if python_type is datetime:
                    value = (
                        bounds[index]
                        if isinstance(bounds[index], datetime)
                        else datetime.fromisoformat(str(bounds[index]).replace("Z", "+00:00"))
                    )
                elif python_type is int:
                    value = int(bounds[index])
                elif python_type is float:
                    value = float(bounds[index])
                else:
                    continue
            except (TypeError, ValueError):
                continue
            range_conditions.append(column >= value if comparison == "minimum" else column <= value)
        if range_conditions:
            clauses.append(and_(*range_conditions))

    field_name, direction = default_sort
    if body.sort and body.sort[0] in {*sortable_fields, "id"}:
        field_name = body.sort[0]
        direction = body.sort[1].lower() if len(body.sort) > 1 else "asc"
    sort_column = getattr(model, field_name)
    order_by = sort_column.desc() if direction == "desc" else sort_column.asc()
    where_clause = and_(*clauses) if clauses else None

    count_stmt = select(func.count()).select_from(model)
    stmt = select(model).order_by(order_by)
    if where_clause is not None:
        count_stmt = count_stmt.where(where_clause)
        stmt = stmt.where(where_clause)
    if body.offset:
        stmt = stmt.offset(body.offset)
    if body.limit is not None:
        stmt = stmt.limit(body.limit)
    total = int(await db.scalar(count_stmt) or 0)
    rows = (await db.scalars(stmt)).all()
    return CrudListResponse(
        total=total,
        items=[serialize_row(row, public_fields) for row in rows],
    )


async def get_crud_row(
    db: AsyncSession,
    model: type[Any],
    public_fields: tuple[str, ...],
    row_id: str,
    current_user: UserData,
) -> dict[str, Any]:
    clauses = [model.id == row_id]
    if not is_admin(current_user):
        clauses.append(model.user_id == current_user.id)
    row = await db.scalar(select(model).where(*clauses))
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="CRUD row not found")
    return serialize_row(row, public_fields)


def serialize_row(row: Any, fields: tuple[str, ...]) -> dict[str, Any]:
    return {field_name: serialize_value(getattr(row, field_name, None)) for field_name in fields}


def serialize_value(value: Any) -> Any:
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, list):
        return [serialize_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): serialize_value(item) for key, item in value.items()}
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def is_admin(user: UserData) -> bool:
    return "admin" in user.roles
