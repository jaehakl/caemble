from __future__ import annotations

import hashlib

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from db import Calculation, CalculationData, Experiment, Measurement
from models import (
    CalculationDataMissingRequest,
    CalculationDataMissingResponse,
    CalculationDataSaveRequest,
    CalculationDataSaveResponse,
    CalculationDataScalar,
    CalculationDataScalarListRequest,
    CalculationDataScalarListResponse,
    CalculationDataTarget,
    UserData,
)
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles
from utils.crud.common import is_admin_user


router = APIRouter(prefix="/calculation_data", tags=["calculation_data"])


def _can_access(owner_id: str, user: UserData) -> bool:
    return is_admin_user(user) or owner_id == user.id


async def _require_experiment(
    db: AsyncSession,
    experiment_id: int,
    user: UserData,
) -> Experiment:
    experiment = await db.get(Experiment, experiment_id)
    if experiment is None or not _can_access(experiment.user_id, user):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Experiment not found.")
    return experiment


@router.post("/missing", response_model=CalculationDataMissingResponse)
async def missing_calculation_data(
    request: CalculationDataMissingRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    await _require_experiment(db, request.experiment_id, user)
    if request.calculation_id is not None:
        calculation = await db.get(Calculation, request.calculation_id)
        if calculation is None or calculation.experiment_id != request.experiment_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Calculation not found.")
    if request.measurement_id is not None:
        measurement = await db.get(Measurement, request.measurement_id)
        if (
            measurement is None
            or measurement.experiment_id != request.experiment_id
            or not _can_access(measurement.user_id, user)
        ):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Measurement not found.")

    existing = select(CalculationData.id).where(
        CalculationData.calculation_id == Calculation.id,
        CalculationData.measurement_id == Measurement.id,
    )
    stmt = (
        select(
            Calculation.id.label("calculation_id"),
            Measurement.id.label("measurement_id"),
        )
        .select_from(Calculation)
        .join(Measurement, Measurement.experiment_id == Calculation.experiment_id)
        .where(
            Calculation.experiment_id == request.experiment_id,
            Measurement.recorded_at.is_not(None),
            ~existing.exists(),
        )
        .order_by(Measurement.id, Calculation.id)
    )
    if not is_admin_user(user):
        stmt = stmt.where(Measurement.user_id == user.id)
    if request.calculation_id is not None:
        stmt = stmt.where(Calculation.id == request.calculation_id)
    if request.measurement_id is not None:
        stmt = stmt.where(Measurement.id == request.measurement_id)

    rows = (await db.execute(stmt)).all()
    items = [
        CalculationDataTarget(
            calculation_id=row.calculation_id,
            measurement_id=row.measurement_id,
        )
        for row in rows
    ]
    return CalculationDataMissingResponse(total=len(items), items=items)


@router.post("/save", response_model=CalculationDataSaveResponse)
async def save_calculation_data(
    request: CalculationDataSaveRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    calculation = await db.scalar(
        select(Calculation)
        .where(Calculation.id == request.calculation_id)
        .with_for_update()
    )
    if calculation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Calculation not found.")
    await _require_experiment(db, calculation.experiment_id, user)
    current_hash = hashlib.sha256(calculation.source_code.encode("utf-8")).hexdigest()
    if current_hash != request.source_hash:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Calculation source changed while CalculationData was running.",
        )

    measurement = await db.scalar(
        select(Measurement)
        .where(Measurement.id == request.measurement_id)
        .with_for_update()
    )
    if (
        measurement is None
        or measurement.experiment_id != calculation.experiment_id
        or measurement.recorded_at is None
        or not _can_access(measurement.user_id, user)
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recorded Measurement not found.")

    existing = await db.scalar(
        select(CalculationData).where(
            CalculationData.calculation_id == calculation.id,
            CalculationData.measurement_id == measurement.id,
        )
    )
    if existing is not None:
        await db.commit()
        return CalculationDataSaveResponse(id=existing.id, created=False)

    row = CalculationData(
        calculation_id=calculation.id,
        measurement_id=measurement.id,
        data=request.data.model_dump(mode="json"),
    )
    db.add(row)
    try:
        await db.flush()
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    return CalculationDataSaveResponse(id=row.id, created=True)


@router.post("/scalars", response_model=CalculationDataScalarListResponse)
async def list_calculation_data_scalars(
    request: CalculationDataScalarListRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    calculation = await db.get(Calculation, request.calculation_id)
    if calculation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Calculation not found.")
    await _require_experiment(db, calculation.experiment_id, user)

    stmt = (
        select(
            CalculationData.measurement_id,
            CalculationData.data["data"].label("value"),
        )
        .join(Measurement, Measurement.id == CalculationData.measurement_id)
        .where(
            CalculationData.calculation_id == calculation.id,
            func.jsonb_array_length(CalculationData.data["shape"]) == 0,
        )
        .order_by(CalculationData.measurement_id)
    )
    if not is_admin_user(user):
        stmt = stmt.where(Measurement.user_id == user.id)
    if request.exclude_measurement_id is not None:
        stmt = stmt.where(CalculationData.measurement_id != request.exclude_measurement_id)

    rows = (await db.execute(stmt)).all()
    items = [
        CalculationDataScalar(measurement_id=row.measurement_id, value=float(row.value))
        for row in rows
    ]
    return CalculationDataScalarListResponse(total=len(items), items=items)
