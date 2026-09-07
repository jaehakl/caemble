"""Caemble access keys authorize owner-scoped authoring and execution APIs."""

from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from gpstation.service.auth_service import authenticate_db_authorization
from models import RoleEnum, UserData
from user_auth.db import User, UserRole
from user_auth.routes import user_data

CAEMBLE_RESOURCES = {
    "client", "cae", "catalog", "material", "material_name", "material_parameter",
    "material_parameter_qualifier", "experiment", "experiment_record", "measurement",
    "recorded_data", "calculation", "calculation_data", "data",
}


async def authenticate_caemble(request: Request, db: AsyncSession, authorization: str) -> UserData:
    principal = await authenticate_db_authorization(
        db, authorization, client_ip=request.client.host if request.client else None,
        origin=request.headers.get("origin"),
    )
    principal.require_scope("caemble")
    path = request.url.path.rstrip("/")
    first = path.lstrip("/").split("/", 1)[0]
    if first not in CAEMBLE_RESOURCES and path != "/auth/me" and not path.startswith(("/web/jobs", "/web/launchers")):
        raise HTTPException(403, "Caemble keys cannot access account, key-management, or administration APIs.")
    user = await db.scalar(select(User).options(
        selectinload(User.user_roles).selectinload(UserRole.role),
        selectinload(User.experiment_namespaces),
    ).where(User.id == principal.user_id))
    data = user_data(user)
    # Administrative account privileges never travel with an authoring key.
    return data.model_copy(update={"roles": [RoleEnum.user]})
