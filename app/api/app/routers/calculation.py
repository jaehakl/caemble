from fastapi import APIRouter, Body, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from models import CalculationBase, CalculationListRequest, UserData
from service.calculation import (
    delete_calculations as delete_calculation_rows,
    list_calculations as list_calculation_rows,
    upsert_calculations as upsert_calculation_rows,
)
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles


router = APIRouter(prefix="/calculation", tags=["calculation"])


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


@router.delete("/", status_code=200)
async def delete_calculations(
    ids: list[int] = Body(...),
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    await delete_calculation_rows(db, ids, user=user)
    return None
