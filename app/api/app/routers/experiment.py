from fastapi import APIRouter, Body, Depends, HTTPException, Response
from gpstation.utils.csrf import require_web_csrf
from sqlalchemy.ext.asyncio import AsyncSession

from models import (
    GetListRequestBase,
    SaveExperimentRequest,
    UserData,
)
from service.experiment import (
    delete_experiment_versions,
    experiment_usage,
    experiment_versions,
    list_experiments as list_experiment_rows,
    save_experiment as save_experiment_entity,
)
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles


router = APIRouter(prefix="/experiment", tags=["experiment"])


@router.get("/{experiment_id}/thumbnail")
async def read_thumbnail(experiment_id: int, db: AsyncSession = Depends(get_db),
                         user: UserData | None = Depends(require_roles(["*"]))):
    from db import ExperimentThumbnail
    from service.experiment_access import require_experiment_read
    await require_experiment_read(db, experiment_id, user)
    thumbnail = await db.get(ExperimentThumbnail, experiment_id)
    if thumbnail is None:
        raise HTTPException(404, "Thumbnail not found.")
    return Response(content=thumbnail.data, media_type="image/webp", headers={"Cache-Control": "private, no-cache"})


@router.post(
    "/save",
    dependencies=[Depends(require_web_csrf)],
)
async def save_experiment(
    request: SaveExperimentRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await save_experiment_entity(db, request, user=user)


@router.post("/list")
async def list_experiments(
    request: GetListRequestBase,
    db: AsyncSession = Depends(get_db),
    user: UserData | None = Depends(require_roles(["*"])),
):
    return await list_experiment_rows(db, request, user=user)


@router.post("/usage")
async def get_experiment_usage(
    experimentIds: list[int] = Body(embed=True),
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await experiment_usage(db, experimentIds, user=user)


@router.get("/{experiment_id}/versions")
async def list_experiment_versions(
    experiment_id: int,
    db: AsyncSession = Depends(get_db),
    user: UserData | None = Depends(require_roles(["*"])),
):
    return await experiment_versions(db, experiment_id, user=user)


@router.delete("/", status_code=200, dependencies=[Depends(require_web_csrf)])
async def delete_experiments(
    ids: list[int] = Body(...),
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    await delete_experiment_versions(db, ids, user=user)
    return None
