from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from db import Material, MaterialName, MaterialParameter, MaterialParameterQualifier
from models import (
    GetListRequestBase,
    MaterialBase,
    MaterialNameBase,
    MaterialParameterBase,
    MaterialParameterQualifierBase,
)
from utils.crud import CrudSpec, delete_items, get_list_response, upsert_items


MATERIAL_CRUD_SPEC = CrudSpec(model=Material, schema=MaterialBase)
MATERIAL_NAME_CRUD_SPEC = CrudSpec(model=MaterialName, schema=MaterialNameBase)
MATERIAL_PARAMETER_CRUD_SPEC = CrudSpec(model=MaterialParameter, schema=MaterialParameterBase)
MATERIAL_PARAMETER_QUALIFIER_CRUD_SPEC = CrudSpec(
    model=MaterialParameterQualifier,
    schema=MaterialParameterQualifierBase,
    scope_path=("material_parameter",),
)


async def list_materials(
    db: AsyncSession,
    request: GetListRequestBase,
    *,
    user: Any,
):
    return await get_list_response(db, request, MATERIAL_CRUD_SPEC, user=user)


async def upsert_materials(
    db: AsyncSession,
    items: list[MaterialBase],
    *,
    user: Any,
):
    for item in items:
        if item.color is not None:
            item.color = item.color.lower()
    return await upsert_items(db, items, MATERIAL_CRUD_SPEC, user=user)


async def delete_materials(
    db: AsyncSession,
    ids: list[int],
    *,
    user: Any,
) -> None:
    await delete_items(db, MATERIAL_CRUD_SPEC, ids, user=user)


async def list_material_names(
    db: AsyncSession,
    request: GetListRequestBase,
    *,
    user: Any,
):
    return await get_list_response(db, request, MATERIAL_NAME_CRUD_SPEC, user=user)


async def upsert_material_names(
    db: AsyncSession,
    items: list[MaterialNameBase],
    *,
    user: Any,
):
    return await upsert_items(db, items, MATERIAL_NAME_CRUD_SPEC, user=user)


async def delete_material_names(
    db: AsyncSession,
    ids: list[int],
    *,
    user: Any,
) -> None:
    await delete_items(db, MATERIAL_NAME_CRUD_SPEC, ids, user=user)


async def list_material_parameters(
    db: AsyncSession,
    request: GetListRequestBase,
    *,
    user: Any,
):
    return await get_list_response(db, request, MATERIAL_PARAMETER_CRUD_SPEC, user=user)


async def upsert_material_parameters(
    db: AsyncSession,
    items: list[MaterialParameterBase],
    *,
    user: Any,
):
    return await upsert_items(db, items, MATERIAL_PARAMETER_CRUD_SPEC, user=user)


async def delete_material_parameters(
    db: AsyncSession,
    ids: list[int],
    *,
    user: Any,
) -> None:
    await delete_items(db, MATERIAL_PARAMETER_CRUD_SPEC, ids, user=user)


async def list_material_parameter_qualifiers(
    db: AsyncSession,
    request: GetListRequestBase,
    *,
    user: Any,
):
    return await get_list_response(
        db,
        request,
        MATERIAL_PARAMETER_QUALIFIER_CRUD_SPEC,
        user=user,
    )


async def upsert_material_parameter_qualifiers(
    db: AsyncSession,
    items: list[MaterialParameterQualifierBase],
    *,
    user: Any,
):
    return await upsert_items(
        db,
        items,
        MATERIAL_PARAMETER_QUALIFIER_CRUD_SPEC,
        user=user,
    )


async def delete_material_parameter_qualifiers(
    db: AsyncSession,
    ids: list[int],
    *,
    user: Any,
) -> None:
    await delete_items(
        db,
        MATERIAL_PARAMETER_QUALIFIER_CRUD_SPEC,
        ids,
        user=user,
    )
