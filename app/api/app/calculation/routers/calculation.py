from fastapi import APIRouter, Body, Depends, Response
from caemble_catalog import Catalog
from sqlalchemy.ext.asyncio import AsyncSession

from calculation.schemas import CalculationBase, CalculationListRequest, CalculationMetadataUpdate
from user_auth.schemas import UserData
from calculation.services.calculations import (
    delete_calculations as delete_calculation_rows,
    list_calculations as list_calculation_rows,
    upsert_calculations as upsert_calculation_rows,
    update_calculation_metadata,
)
from db import get_db
from user_auth.utils.auth_wrapper import require_roles
from calculation.library_schemas import LibraryDetail, LibraryPage, LibraryQuery, LibraryReference
from catalog.dependencies import get_catalog
from calculation.services.library import list_library, library_detail


router = APIRouter(prefix="/calculation", tags=["calculation"])


@router.post("/library/list", response_model=LibraryPage)
async def calculation_library(
    query: LibraryQuery, response: Response,
    db: AsyncSession = Depends(get_db), catalog: Catalog = Depends(get_catalog),
    user: UserData | None = Depends(require_roles(["*"])),
):
    response.headers["Cache-Control"] = "private, no-store"
    return await list_library(db, catalog, query, user)


@router.post("/library/detail", response_model=LibraryDetail)
async def calculation_library_detail(
    reference: LibraryReference, response: Response,
    db: AsyncSession = Depends(get_db), catalog: Catalog = Depends(get_catalog),
    user: UserData | None = Depends(require_roles(["*"])),
):
    response.headers["Cache-Control"] = "private, no-store"
    return await library_detail(db, catalog, reference, user)


@router.post("/list")
async def list_calculations(
    request: CalculationListRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData | None = Depends(require_roles(["*"])),
):
    return await list_calculation_rows(db, request, user=user)


@router.post("/upsert")
async def upsert_calculations(
    items: list[CalculationBase],
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await upsert_calculation_rows(db, items, user=user)


@router.patch("/{calculation_id}/metadata")
async def update_metadata(calculation_id: int, item: CalculationMetadataUpdate,
                          db: AsyncSession = Depends(get_db), user: UserData = Depends(require_roles(["admin", "user"]))):
    return await update_calculation_metadata(db, calculation_id, item, user=user)


@router.delete("/", status_code=200)
async def delete_calculations(
    ids: list[int] = Body(...),
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    await delete_calculation_rows(db, ids, user=user)
    return None
