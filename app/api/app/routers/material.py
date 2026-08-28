from fastapi import APIRouter, Body, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from models import (
    GetListRequestBase,
    MaterialBase,
    MaterialNameBase,
    MaterialParameterBase,
    MaterialParameterQualifierBase,
    UserData,
)
from service.material import (
    delete_material_names as delete_material_name_rows,
    delete_material_parameter_qualifiers as delete_material_parameter_qualifier_rows,
    delete_material_parameters as delete_material_parameter_rows,
    delete_materials as delete_material_rows,
    list_material_names as list_material_name_rows,
    list_material_parameter_qualifiers as list_material_parameter_qualifier_rows,
    list_material_parameters as list_material_parameter_rows,
    list_materials as list_material_rows,
    upsert_material_names as upsert_material_name_rows,
    upsert_material_parameter_qualifiers as upsert_material_parameter_qualifier_rows,
    upsert_material_parameters as upsert_material_parameter_rows,
    upsert_materials as upsert_material_rows,
)
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles


router = APIRouter()


@router.post("/material/list", tags=["material"])
async def list_materials(
    request: GetListRequestBase,
    db: AsyncSession = Depends(get_db),
    user: UserData | None = Depends(require_roles(["*"])),
):
    return await list_material_rows(db, request, user=user)


@router.post(
    "/material/upsert",
    tags=["material"],
)
async def upsert_materials(
    items: list[MaterialBase],
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await upsert_material_rows(db, items, user=user)


@router.delete("/material/", status_code=200, tags=["material"])
async def delete_materials(
    ids: list[int] = Body(...),
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    await delete_material_rows(db, ids, user=user)
    return None


@router.post(
    "/material_name/list",
    tags=["material_name"],
)
async def list_material_names(
    request: GetListRequestBase,
    db: AsyncSession = Depends(get_db),
    user: UserData | None = Depends(require_roles(["*"])),
):
    return await list_material_name_rows(db, request, user=user)


@router.post(
    "/material_name/upsert",
    tags=["material_name"],
)
async def upsert_material_names(
    items: list[MaterialNameBase],
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await upsert_material_name_rows(db, items, user=user)


@router.delete("/material_name/", status_code=200, tags=["material_name"])
async def delete_material_names(
    ids: list[int] = Body(...),
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    await delete_material_name_rows(db, ids, user=user)
    return None


@router.post(
    "/material_parameter/list",
    tags=["material_parameter"],
)
async def list_material_parameters(
    request: GetListRequestBase,
    db: AsyncSession = Depends(get_db),
    user: UserData | None = Depends(require_roles(["*"])),
):
    return await list_material_parameter_rows(db, request, user=user)


@router.post(
    "/material_parameter/upsert",
    tags=["material_parameter"],
)
async def upsert_material_parameters(
    items: list[MaterialParameterBase],
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await upsert_material_parameter_rows(db, items, user=user)


@router.delete(
    "/material_parameter/",
    status_code=200,
    tags=["material_parameter"],
)
async def delete_material_parameters(
    ids: list[int] = Body(...),
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    await delete_material_parameter_rows(db, ids, user=user)
    return None


@router.post(
    "/material_parameter_qualifier/list",
    tags=["material_parameter_qualifier"],
)
async def list_material_parameter_qualifiers(
    request: GetListRequestBase,
    db: AsyncSession = Depends(get_db),
    user: UserData | None = Depends(require_roles(["*"])),
):
    return await list_material_parameter_qualifier_rows(db, request, user=user)


@router.post(
    "/material_parameter_qualifier/upsert",
    tags=["material_parameter_qualifier"],
)
async def upsert_material_parameter_qualifiers(
    items: list[MaterialParameterQualifierBase],
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await upsert_material_parameter_qualifier_rows(db, items, user=user)


@router.delete(
    "/material_parameter_qualifier/",
    status_code=200,
    tags=["material_parameter_qualifier"],
)
async def delete_material_parameter_qualifiers(
    ids: list[int] = Body(...),
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    await delete_material_parameter_qualifier_rows(db, ids, user=user)
    return None
