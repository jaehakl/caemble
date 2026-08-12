from fastapi import APIRouter, Body, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from db import Measurement
from models import (
    GetListRequestBase,
    GetListResponseBase,
    MeasurementBase,
    MeasurementCreateRequest,
    MeasurementRecordRequest,
    MeasurementSaveResponse,
    UserData,
)
from service.measurement_service import (
    MeasurementAlreadyRecordedError,
    MeasurementService,
)
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles
from utils.crud import CrudSpec, delete_items, get_list_response


router = APIRouter(prefix="/measurement", tags=["measurement"])
CRUD_SPEC = CrudSpec(model=Measurement, schema=MeasurementBase)


@router.post("/list", response_model=GetListResponseBase)
async def list_measurements(
    request: GetListRequestBase,
    db: AsyncSession = Depends(get_db),
    user: UserData | None = Depends(require_roles(["*"])),
):
    return await get_list_response(db, request, CRUD_SPEC, user=user)


@router.post("/create", response_model=MeasurementSaveResponse)
async def create_measurement(
    request: MeasurementCreateRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    try:
        return await MeasurementService.create_measurement(request, db, user)
    except LookupError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(error),
        ) from error
    except IntegrityError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Measurement conflicts with the current database state.",
        ) from error


@router.post("/{measurement_id}/record", response_model=MeasurementSaveResponse)
async def record_measurement(
    measurement_id: int,
    request: MeasurementRecordRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    try:
        return await MeasurementService.record_measurement(
            measurement_id,
            request,
            db,
            user,
        )
    except LookupError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(error),
        ) from error
    except MeasurementAlreadyRecordedError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(error),
        ) from error
    except IntegrityError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="RecordedData conflicts with the current database state.",
        ) from error


@router.delete("/", status_code=200)
async def delete_measurements(
    ids: list[int] = Body(...),
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    await delete_items(db, CRUD_SPEC, ids, user=user)
    return None
