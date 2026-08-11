from fastapi import APIRouter, Body, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from db import Measurement
from models import (
    GetListRequestBase,
    GetListResponseBase,
    MeasurementBase,
    MeasurementContextListRequest,
    MeasurementPairListRequest,
    MeasurementPairListResponse,
    MeasurementSaveRequest,
    MeasurementSaveResponse,
    UpsertResponseBase,
    UserData,
)
from service.measurement_service import (
    MeasurementOverwriteRequiredError,
    MeasurementService,
)
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles
from utils.crud import CrudSpec, delete_items, get_list_response, upsert_items


router = APIRouter(prefix="/measurement", tags=["measurement"])
CRUD_SPEC = CrudSpec(model=Measurement, schema=MeasurementBase)


@router.post("/list", response_model=GetListResponseBase)
async def list_measurements(
    request: GetListRequestBase,
    db: AsyncSession = Depends(get_db),
    user: UserData | None = Depends(require_roles(["*"])),
):
    return await get_list_response(db, request, CRUD_SPEC, user=user)


@router.post("/context-list", response_model=GetListResponseBase)
async def list_context_measurements(
    request: MeasurementContextListRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await MeasurementService.get_context_measurements(request, db, user)


@router.post("/pair-list", response_model=MeasurementPairListResponse)
async def list_measurement_pairs(
    request: MeasurementPairListRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await MeasurementService.get_measurement_pairs(request, db, user)


@router.post("/save", response_model=MeasurementSaveResponse)
async def save_measurement(
    request: MeasurementSaveRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    try:
        return await MeasurementService.save_measurement(request, db, user)
    except LookupError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(error),
        ) from error
    except MeasurementOverwriteRequiredError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(error),
        ) from error
    except IntegrityError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Measurement result conflicts with the current database state.",
        ) from error


@router.post("/upsert", response_model=list[UpsertResponseBase])
async def upsert_measurements(
    items: list[MeasurementBase],
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    return await upsert_items(db, items, CRUD_SPEC, user=user)


@router.delete("/", status_code=200)
async def delete_measurements(
    ids: list[int] = Body(...),
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    await delete_items(db, CRUD_SPEC, ids, user=user)
    return None
