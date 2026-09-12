from fastapi import APIRouter, Body, Depends, HTTPException, status
from caemble_catalog import Catalog
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from models import (
    GetListRequestBase,
    MeasurementCreateRequest,
    MeasurementRecordedDataResponse,
    MeasurementVisualizationsResponse,
    UserData,
)
from service.measurement_service import (
    create_measurement as create_measurement_entity,
    delete_measurements as delete_measurement_rows,
    get_recorded_data,
    get_visualizations,
    list_measurements as list_measurement_rows,
)
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles
from routers.catalog import get_catalog


router = APIRouter(prefix="/measurement", tags=["measurement"])


@router.post("/list")
async def list_measurements(
    request: GetListRequestBase,
    db: AsyncSession = Depends(get_db),
    user: UserData | None = Depends(require_roles(["*"])),
):
    return await list_measurement_rows(db, request, user=user)


@router.post("/create")
async def create_measurement(
    request: MeasurementCreateRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
    catalog: Catalog = Depends(get_catalog),
):
    try:
        return await create_measurement_entity(db, request, user=user, catalog=catalog)
    except LookupError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(error),
        ) from error
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(error),
        ) from error
    except IntegrityError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Measurement conflicts with the current database state.",
        ) from error


@router.get("/{measurement_id}/recorded-data", response_model=MeasurementRecordedDataResponse)
async def get_measurement_recorded_data(
    measurement_id: int,
    db: AsyncSession = Depends(get_db),
    user: UserData | None = Depends(require_roles(["*"])),
):
    try:
        return await get_recorded_data(db, measurement_id, user=user)
    except LookupError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(error),
        ) from error


@router.get("/{measurement_id}/visualizations", response_model=MeasurementVisualizationsResponse)
async def get_measurement_visualizations(
    measurement_id: int,
    db: AsyncSession = Depends(get_db),
    user: UserData | None = Depends(require_roles(["*"])),
):
    try:
        return await get_visualizations(db, measurement_id, user=user)
    except LookupError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error


@router.delete("/", status_code=200)
async def delete_measurements(
    ids: list[int] = Body(...),
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    await delete_measurement_rows(db, ids, user=user)
    return None
