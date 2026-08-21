from fastapi import APIRouter, Body, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from gpstation.utils.csrf import require_web_csrf

from models import (
    GeometryPublishPlanRequest,
    GeometryPublishRequest,
    GeometryRepositoryCreateRequest,
    GetListRequestBase,
    GetListResponseBase,
    UserData,
)
from service.geometry import (
    GeometryVersionConflict,
    archive_repository,
    archive_version,
    create_repository,
    delete_geometry_packages,
    delete_geometry_repository,
    delete_geometry_versions,
    geometry_version_usage,
    list_geometry_packages,
    list_geometry_repositories,
    list_geometry_version_dependents,
    list_geometry_version_experiments,
    list_geometry_versions,
    plan_publish,
    publish,
    resolve_version,
    restore_repository,
    update_repository_description,
)
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles


router = APIRouter(prefix="/geometry", tags=["geometry"], dependencies=[Depends(require_web_csrf)])


@router.post("/repositories/list", response_model=GetListResponseBase)
async def geometry_repositories_list(
    request: GetListRequestBase,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await list_geometry_repositories(db, request, user=user)


@router.post("/repositories")
async def create_geometry_repository(
    request: GeometryRepositoryCreateRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await create_repository(db, request, user=user)


@router.post("/repositories/{repository_id}/archive")
async def archive_geometry_repository(
    repository_id: int,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await archive_repository(db, repository_id, user=user)


@router.post("/repositories/{repository_id}/restore")
async def restore_geometry_repository(
    repository_id: int,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await restore_repository(db, repository_id, user=user)


@router.delete("/repositories/{repository_id}")
async def delete_geometry_repository_row(
    repository_id: int,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    await delete_geometry_repository(db, repository_id, user=user)
    return None


@router.put("/repositories/{repository_id}")
async def update_geometry_repository(
    repository_id: int,
    description: str | None = Body(default=None, embed=True),
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await update_repository_description(db, repository_id, description, user=user)


@router.post("/packages/list", response_model=GetListResponseBase)
async def geometry_packages_list(
    request: GetListRequestBase,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await list_geometry_packages(db, request, user=user)


@router.post("/versions/list", response_model=GetListResponseBase)
async def geometry_versions_list(
    request: GetListRequestBase,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await list_geometry_versions(db, request, user=user)


@router.post("/versions/{version_id}/dependents/list", response_model=GetListResponseBase)
async def geometry_version_dependents(
    version_id: int,
    request: GetListRequestBase,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await list_geometry_version_dependents(
        db,
        version_id,
        request,
        user=user,
    )


@router.post("/versions/{version_id}/experiments/list", response_model=GetListResponseBase)
async def geometry_version_experiments(
    version_id: int,
    request: GetListRequestBase,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await list_geometry_version_experiments(
        db,
        version_id,
        request,
        user=user,
    )


@router.post("/versions/usage")
async def geometry_versions_usage(
    version_ids: list[object] = Body(..., embed=True, alias="versionIds"),
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await geometry_version_usage(db, version_ids, user=user)


@router.delete("/versions/")
async def delete_geometry_version_rows(
    ids: list[int] = Body(...),
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    await delete_geometry_versions(db, ids, user=user)
    return None


@router.delete("/packages/")
async def delete_geometry_package_rows(
    ids: list[int] = Body(...),
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    await delete_geometry_packages(db, ids, user=user)
    return None


@router.get("/versions/{version_id}/resolve")
async def resolve_geometry_version(
    version_id: int,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await resolve_version(db, version_id, user=user)


@router.post("/versions/{version_id}/archive")
async def archive_geometry_version(
    version_id: int,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await archive_version(db, version_id, user=user)


@router.post("/publish/plan")
async def geometry_publish_plan(
    request: GeometryPublishPlanRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    try:
        return await plan_publish(db, request, user=user)
    except GeometryVersionConflict as error:
        return JSONResponse(status_code=409, content=error.payload)


@router.post("/publish")
async def publish_geometry_versions(
    request: GeometryPublishRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    try:
        return await publish(db, request, user=user)
    except GeometryVersionConflict as error:
        return JSONResponse(status_code=409, content=error.payload)
