from fastapi import APIRouter, Body, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from db import Structure
from models import (
    GetListRequestBase,
    GetListResponseBase,
    SaveCodeEntityRequest,
    SaveCodeEntityResponse,
    StructureBase,
    UpsertResponseBase,
    UserData,
)
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles
from utils.crud import CrudSpec, delete_items, get_list_response, upsert_items
from utils.code_entity import save_code_entity


router = APIRouter(prefix="/structure", tags=["structure"])
CRUD_SPEC = CrudSpec(
    model=Structure,
    schema=StructureBase,
    tree_parent_field="parent_id",
    immutable_update_fields=("code",),
)


@router.post("/save", response_model=SaveCodeEntityResponse)
async def save_structure(
    request: SaveCodeEntityRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await save_code_entity(db, Structure, request, user=user)


@router.post("/list", response_model=GetListResponseBase)
async def list_structures(
    request: GetListRequestBase,
    db: AsyncSession = Depends(get_db),
    user: UserData | None = Depends(require_roles(["*"])),
):
    return await get_list_response(db, request, CRUD_SPEC, user=user)


@router.post("/upsert", response_model=list[UpsertResponseBase])
async def upsert_structures(
    items: list[StructureBase],
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await upsert_items(db, items, CRUD_SPEC, user=user)


@router.delete("/", status_code=200)
async def delete_structures(
    ids: list[int] = Body(...),
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    await delete_items(db, CRUD_SPEC, ids, user=user)
    return None
