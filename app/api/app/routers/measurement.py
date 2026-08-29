from fastapi import APIRouter, Body, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from models import (
    GetListRequestBase,
    MeasurementCreateRequest,
    MeasurementRecordedDataResponse,
    MeasurementRecordRequest,
    UserData,
)
from service.measurement_service import (
    create_measurement as create_measurement_entity,
    delete_measurements as delete_measurement_rows,
    get_recorded_data,
    list_measurements as list_measurement_rows,
    record_measurement as record_measurement_entity,
)
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles


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
):
    try:
        return await create_measurement_entity(db, request, user=user)
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


@router.post("/{measurement_id}/record")
async def record_measurement(
    measurement_id: int,
    request: MeasurementRecordRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    try:
        return await record_measurement_entity(
            db,
            measurement_id,
            request,
            user=user,
        )
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
            detail="RecordedData conflicts with the current database state.",
        ) from error


@router.get("/{measurement_id}/recorded-data", response_model=MeasurementRecordedDataResponse)
async def get_measurement_recorded_data(
    measurement_id: int,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    try:
        return await get_recorded_data(db, measurement_id, user=user)
    except LookupError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(error),
        ) from error


@router.delete("/", status_code=200)
async def delete_measurements(
    ids: list[int] = Body(...),
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    await delete_measurement_rows(db, ids, user=user)
    return None
