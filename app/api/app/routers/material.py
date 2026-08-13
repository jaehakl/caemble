from fastapi import APIRouter, Body, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from models import GetListRequestBase, GetListResponseBase, MaterialBase, UpsertResponseBase, UserData
from service.material import (
    delete_materials as delete_material_rows,
    list_materials as list_material_rows,
    upsert_materials as upsert_material_rows,
)
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles


router = APIRouter(prefix="/material", tags=["material"])


@router.post("/list", response_model=GetListResponseBase)
async def list_materials(
    request: GetListRequestBase,
    db: AsyncSession = Depends(get_db),
    user: UserData | None = Depends(require_roles(["*"])),
):
    return await list_material_rows(db, request, user=user)


@router.post("/upsert", response_model=list[UpsertResponseBase])
async def upsert_materials(
    items: list[MaterialBase],
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await upsert_material_rows(db, items, user=user)


@router.delete("/", status_code=200)
async def delete_materials(
    ids: list[int] = Body(...),
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    await delete_material_rows(db, ids, user=user)
    return None
