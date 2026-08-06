from fastapi import APIRouter, Body, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from db import RecordedData
from models import GetListRequestBase, GetListResponseBase, RecordedDataBase, UpsertResponseBase, UserData
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles
from utils.crud import CrudSpec, delete_items, get_list_response, upsert_items


router = APIRouter(prefix="/recorded_data", tags=["recorded_data"])
CRUD_SPEC = CrudSpec(model=RecordedData, schema=RecordedDataBase)


@router.post("/list", response_model=GetListResponseBase)
async def list_recorded_data(
    request: GetListRequestBase,
    db: AsyncSession = Depends(get_db),
    user: UserData | None = Depends(require_roles(["*"])),
):
    return await get_list_response(db, request, CRUD_SPEC, user=user)


@router.post("/upsert", response_model=list[UpsertResponseBase])
async def upsert_recorded_data(
    items: list[RecordedDataBase],
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await upsert_items(db, items, CRUD_SPEC, user=user)


@router.delete("/", status_code=200)
async def delete_recorded_data(
    ids: list[int] = Body(...),
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    await delete_items(db, CRUD_SPEC, ids, user=user)
    return None
