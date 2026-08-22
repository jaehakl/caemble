from fastapi import APIRouter, Body, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db import Experiment, PredictorModel
from models import GetListRequestBase, GetListResponseBase, PredictorModelBase, UpsertResponseBase, UserData
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles
from utils.crud import CrudSpec, delete_items, get_list_response, upsert_items


router = APIRouter(prefix="/predictor_model", tags=["predictor_model"])
CRUD_SPEC = CrudSpec(
    model=PredictorModel,
    schema=PredictorModelBase,
    immutable_update_fields=("experiment_id",),
)


@router.post("/list", response_model=GetListResponseBase)
async def list_predictor_models(
    request: GetListRequestBase,
    db: AsyncSession = Depends(get_db),
    user: UserData | None = Depends(require_roles(["*"])),
):
    return await get_list_response(db, request, CRUD_SPEC, user=user)


@router.post("/upsert", response_model=list[UpsertResponseBase])
async def upsert_predictor_models(
    items: list[PredictorModelBase],
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    experiment_ids = {item.experiment_id for item in items}
    if experiment_ids:
        await db.execute(
            select(Experiment.id)
            .where(Experiment.id.in_(experiment_ids))
            .order_by(Experiment.id)
            .with_for_update()
        )
    return await upsert_items(db, items, CRUD_SPEC, user=user)


@router.delete("/", status_code=200)
async def delete_predictor_models(
    ids: list[int] = Body(...),
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    await delete_items(db, CRUD_SPEC, ids, user=user)
    return None
