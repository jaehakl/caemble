from typing import Annotated

from fastapi import APIRouter, Body, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from models import (
    CalculationDataListRequest,
    CalculationDataListResponse,
    CalculationDataOutput,
    UserData,
)
from service.calculation_data import (
    analyze_calculation_data as analyze_calculation_data_rows,
    calculation_data_analysis_status as get_calculation_data_analysis_status,
    list_calculation_data as list_calculation_data_rows,
    list_calculation_data_scalars as list_calculation_data_scalar_rows,
    missing_calculation_data as list_missing_calculation_data,
    save_calculation_data as save_calculation_data_row,
)
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles


router = APIRouter(prefix="/calculation_data", tags=["calculation_data"])


@router.post("/list", response_model=CalculationDataListResponse)
async def list_calculation_data(
    request: CalculationDataListRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await list_calculation_data_rows(db, request, user=user)


@router.post("/analysis")
async def analyze_calculation_data(
    experiment_id: Annotated[int, Body(embed=True)],
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await analyze_calculation_data_rows(db, experiment_id, user=user)


@router.post("/analysis/status")
async def calculation_data_analysis_status(
    experiment_id: Annotated[int, Body(embed=True)],
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await get_calculation_data_analysis_status(db, experiment_id, user=user)


@router.post("/missing")
async def missing_calculation_data(
    experiment_id: Annotated[int, Body()],
    calculation_id: Annotated[int | None, Body()] = None,
    measurement_id: Annotated[int | None, Body()] = None,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await list_missing_calculation_data(
        db,
        experiment_id,
        calculation_id,
        measurement_id,
        user=user,
    )


@router.post("/save")
async def save_calculation_data(
    calculation_id: Annotated[int, Body()],
    measurement_id: Annotated[int, Body()],
    source_hash: Annotated[str, Body(pattern=r"^[0-9a-f]{64}$")],
    data: Annotated[CalculationDataOutput, Body()],
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await save_calculation_data_row(
        db,
        calculation_id,
        measurement_id,
        source_hash,
        data,
        user=user,
    )


@router.post("/scalars")
async def list_calculation_data_scalars(
    calculation_id: Annotated[int, Body()],
    exclude_measurement_id: Annotated[int | None, Body()] = None,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await list_calculation_data_scalar_rows(
        db,
        calculation_id,
        exclude_measurement_id,
        user=user,
    )
