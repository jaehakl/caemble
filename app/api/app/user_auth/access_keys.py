"""Caemble access keys authorize owner-scoped authoring and execution APIs."""

import re

from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from gpstation.models import AccessKeyCreateResult
from gpstation.service.access_key_service import AccessKeyService
from gpstation.service.auth_service import authenticate_db_authorization
from user_auth.key_policy import active_access_key_users
from user_auth.schemas import AccessKeyCreate, RoleEnum, UserData
from user_auth.db import User, UserRole
from user_auth.session import user_data

CAEMBLE_RESOURCES = {
    "client", "cae", "catalog", "experiment", "experiment_record", "measurement",
    "recorded_data", "calculation", "calculation_data", "data",
}

ALLOWED_ACCESS_KEY_SCOPES = {"client", "launcher", "caemble"}


async def create_user_access_key(
    db: AsyncSession, user_id: str, payload: AccessKeyCreate,
) -> AccessKeyCreateResult:
    user = await db.get(User, user_id)
    if user is None:
        raise ValueError("User not found")
    if await db.scalar(active_access_key_users(user_id)) is None:
        raise ValueError("Access Tokens require an active admin or user account")
    name = payload.name.strip()
    if not name:
        raise ValueError("Access Token name is required")
    scopes = list(dict.fromkeys(payload.scopes or []))
    if not scopes or any(scope not in ALLOWED_ACCESS_KEY_SCOPES for scope in scopes):
        raise ValueError("Invalid Access Token scope")
    return await AccessKeyService.create_access_key(
        db, user_id, name=name, scopes=scopes, expires_at=payload.expires_at,
    )


async def create_access_token(
    db: AsyncSession, user_id: str, payload: AccessKeyCreate,
) -> AccessKeyCreateResult:
    try:
        return await create_user_access_key(db, user_id, payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


async def authenticate_caemble(request: Request, db: AsyncSession, authorization: str) -> UserData:
    principal = await authenticate_db_authorization(
        db, authorization, client_ip=request.client.host if request.client else None,
        origin=request.headers.get("origin"),
    )
    principal.require_scope("caemble")
    path = request.url.path.rstrip("/")
    first = path.lstrip("/").split("/", 1)[0]
    # The storage router still enforces object ownership and Experiment visibility.
    object_download = request.scope.get("method") == "GET" and re.fullmatch(r"/storage/objects/[^/]+", path) is not None
    if first not in CAEMBLE_RESOURCES and not object_download and path != "/auth/me" and not path.startswith(("/web/jobs", "/web/launchers")):
        raise HTTPException(403, "Caemble keys cannot access account, key-management, or administration APIs.")
    user = await db.scalar(select(User).options(
        selectinload(User.user_roles).selectinload(UserRole.role),
        selectinload(User.experiment_namespaces),
    ).where(User.id == principal.user_id))
    data = user_data(user)
    # Administrative account privileges never travel with an authoring key.
    return data.model_copy(update={"roles": [RoleEnum.user]})
