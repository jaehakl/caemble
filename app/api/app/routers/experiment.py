from fastapi import APIRouter, Body, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from db import Experiment
from models import (
    CodeEntityHistoryRequest,
    CodeEntityHistoryResponse,
    ExperimentBase,
    GetListRequestBase,
    GetListResponseBase,
    SaveCodeEntityResponse,
    SaveExperimentRequest,
    UpsertResponseBase,
    UserData,
)
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles
from service.experiment import get_experiment_history, save_experiment as save_experiment_entity
from utils.crud import CrudSpec, delete_items, get_list_response, upsert_items


router = APIRouter(prefix="/experiment", tags=["experiment"])
CRUD_SPEC = CrudSpec(
    model=Experiment,
    schema=ExperimentBase,
    tree_parent_field="parent_id",
    immutable_update_fields=("source_bundle",),
    search_aliases={"workbench": ("name", "description", "source_bundle")},
)


@router.post("/save", response_model=SaveCodeEntityResponse)
async def save_experiment(
    request: SaveExperimentRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await save_experiment_entity(db, request, user=user)


@router.post("/history", response_model=CodeEntityHistoryResponse)
async def experiment_history(
    request: CodeEntityHistoryRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    try:
        return await get_experiment_history(db, request.id, user=user)
    except LookupError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(error),
        ) from error


@router.post("/list", response_model=GetListResponseBase)
async def list_experiments(
    request: GetListRequestBase,
    db: AsyncSession = Depends(get_db),
    user: UserData | None = Depends(require_roles(["*"])),
):
    return await get_list_response(db, request, CRUD_SPEC, user=user)


@router.post("/upsert", response_model=list[UpsertResponseBase])
async def upsert_experiments(
    items: list[ExperimentBase],
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await upsert_items(db, items, CRUD_SPEC, user=user)


@router.delete("/", status_code=200)
async def delete_experiments(
    ids: list[int] = Body(...),
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    await delete_items(db, CRUD_SPEC, ids, user=user)
    return None
