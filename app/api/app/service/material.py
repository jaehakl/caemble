from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from db import Material
from models import GetListRequestBase, MaterialBase
from utils.crud import CrudSpec, delete_items, get_list_response, upsert_items


MATERIAL_CRUD_SPEC = CrudSpec(model=Material, schema=MaterialBase)


async def list_materials(
    db: AsyncSession,
    request: GetListRequestBase,
    *,
    user: Any,
):
    return await get_list_response(
        db,
        request,
        MATERIAL_CRUD_SPEC,
        user=user,
    )


async def upsert_materials(
    db: AsyncSession,
    items: list[MaterialBase],
    *,
    user: Any,
):
    for item in items:
        if item.color is not None:
            item.color = item.color.lower()
    return await upsert_items(
        db,
        items,
        MATERIAL_CRUD_SPEC,
        user=user,
    )


async def delete_materials(
    db: AsyncSession,
    ids: list[int],
    *,
    user: Any,
) -> None:
    await delete_items(
        db,
        MATERIAL_CRUD_SPEC,
        ids,
        user=user,
    )
