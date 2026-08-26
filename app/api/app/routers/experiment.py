from fastapi import APIRouter, Body, Depends
from gpstation.utils.csrf import require_web_csrf
from sqlalchemy.ext.asyncio import AsyncSession

from db import Experiment
from models import (
    ExperimentBase,
    ExperimentUsageRequest,
    GetListRequestBase,
    GetListResponseBase,
    SaveExperimentRequest,
    SaveExperimentResponse,
    UserData,
)
from service.experiment import (
    delete_experiment_versions,
    enrich_experiment_list,
    experiment_usage,
    experiment_versions,
    save_experiment as save_experiment_entity,
)
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles
from utils.crud import CrudSpec, get_list_response


router = APIRouter(prefix="/experiment", tags=["experiment"])
CRUD_SPEC = CrudSpec(
    model=Experiment,
    schema=ExperimentBase,
    search_aliases={
        "workbench": (
            "name",
            "description",
            "namespace",
            "repository_slug",
            "experiment_key",
            "source_bundle",
        ),
        "repository": ("repository_slug",),
        "key": ("experiment_key",),
    },
)


@router.post(
    "/save",
    response_model=SaveExperimentResponse,
    dependencies=[Depends(require_web_csrf)],
)
async def save_experiment(
    request: SaveExperimentRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await save_experiment_entity(db, request, user=user)


@router.post("/list", response_model=GetListResponseBase)
async def list_experiments(
    request: GetListRequestBase,
    db: AsyncSession = Depends(get_db),
    user: UserData | None = Depends(require_roles(["*"])),
):
    response = await get_list_response(db, request, CRUD_SPEC, user=user)
    return await enrich_experiment_list(db, response)


@router.post("/usage")
async def get_experiment_usage(
    request: ExperimentUsageRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await experiment_usage(db, request.experimentIds, user=user)


@router.get("/{experiment_id}/versions")
async def list_experiment_versions(
    experiment_id: int,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
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
