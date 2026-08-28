from __future__ import annotations

import hashlib
import json
import math
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from db import Calculation, CalculationData, Experiment, Measurement
from model_validators import validate_calculation_data_selectors
from models import CalculationDataOutput, UserData
from utils.crud.common import is_admin_user


def _can_access(owner_id: str, user: UserData) -> bool:
    return is_admin_user(user) or owner_id == user.id


async def _require_experiment(
    db: AsyncSession,
    experiment_id: int,
    user: UserData,
) -> Experiment:
    experiment = await db.get(Experiment, experiment_id)
    if experiment is None or not _can_access(experiment.user_id, user):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Experiment not found.",
        )
    return experiment


async def _analysis_rows(
    db: AsyncSession,
    experiment_id: int,
    user: UserData,
    *,
    include_data: bool,
):
    columns = [
        CalculationData.id.label("calculation_data_id"),
        CalculationData.calculation_id,
        CalculationData.measurement_id,
        CalculationData.updated_at.label("calculation_data_updated_at"),
        Calculation.name.label("calculation_name"),
        Calculation.updated_at.label("calculation_updated_at"),
        Measurement.updated_at.label("measurement_updated_at"),
    ]
    if include_data:
        columns.append(CalculationData.data)
    statement = (
        select(*columns)
        .select_from(CalculationData)
        .join(Calculation, Calculation.id == CalculationData.calculation_id)
        .join(Measurement, Measurement.id == CalculationData.measurement_id)
        .where(
            Calculation.experiment_id == experiment_id,
            Measurement.experiment_id == experiment_id,
            Measurement.recorded_at.is_not(None),
        )
        .order_by(CalculationData.measurement_id, CalculationData.calculation_id)
    )
    if not is_admin_user(user):
        statement = statement.where(Measurement.user_id == user.id)
    return (await db.execute(statement)).all()


def _analysis_fingerprint(rows) -> str:
    payload = [
        [
            row.calculation_data_id,
            row.calculation_id,
            row.calculation_name,
            row.measurement_id,
            row.calculation_data_updated_at.isoformat(),
            row.calculation_updated_at.isoformat(),
            row.measurement_updated_at.isoformat(),
        ]
        for row in rows
    ]
    serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _tensor_summary(output: CalculationDataOutput) -> dict[str, Any]:
    values = [float(value) for value in output.data]
    count = len(values)
    if count == 0:
        return {
            "kind": "tensor",
            "rank": len(output.shape),
            "count": 0,
            "mean": None,
            "std": None,
        }
    scale = max(abs(value) for value in values)
    if scale == 0:
        mean = 0.0
        std = 0.0
    else:
        scaled_mean = math.fsum(value / scale for value in values) / count
        mean = scale * scaled_mean
        scaled_variance = (
            0.0
            if count == 1
            else math.fsum((value / scale - scaled_mean) ** 2 for value in values)
            / (count - 1)
        )
        std = scale * math.sqrt(scaled_variance)
    return {
        "kind": "tensor",
        "rank": len(output.shape),
        "count": count,
        "mean": mean if math.isfinite(mean) else None,
        "std": std if math.isfinite(std) else None,
    }


async def analyze_calculation_data(
    db: AsyncSession,
    experiment_id: int,
    *,
    user: UserData,
) -> dict[str, Any]:
    await _require_experiment(db, experiment_id, user)
    rows = await _analysis_rows(db, experiment_id, user, include_data=True)
    items = []
    for row in rows:
        output = CalculationDataOutput.model_validate(row.data)
        summary = (
            {"kind": "scalar", "value": float(output.data)}
            if not output.shape
            else _tensor_summary(output)
        )
        items.append(
            {
                "calculation_id": row.calculation_id,
                "calculation_name": row.calculation_name,
                "measurement_id": row.measurement_id,
                "dtype": output.dtype,
                "summary": summary,
            }
        )
    return {
        "fingerprint": _analysis_fingerprint(rows),
        "total": len(items),
        "measurement_count": len({row.measurement_id for row in rows}),
        "items": items,
    }


async def calculation_data_analysis_status(
    db: AsyncSession,
    experiment_id: int,
    *,
    user: UserData,
) -> dict[str, Any]:
    await _require_experiment(db, experiment_id, user)
    rows = await _analysis_rows(db, experiment_id, user, include_data=False)
    return {
        "fingerprint": _analysis_fingerprint(rows),
        "total": len(rows),
        "measurement_count": len({row.measurement_id for row in rows}),
    }


async def missing_calculation_data(
    db: AsyncSession,
    experiment_id: int,
    calculation_id: int | None,
    measurement_id: int | None,
    *,
    user: UserData,
) -> dict[str, Any]:
    try:
        validate_calculation_data_selectors(calculation_id, measurement_id)
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(error),
        ) from error
    await _require_experiment(db, experiment_id, user)
    if calculation_id is not None:
        calculation = await db.get(Calculation, calculation_id)
        if calculation is None or calculation.experiment_id != experiment_id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Calculation not found.",
            )
    if measurement_id is not None:
        measurement = await db.get(Measurement, measurement_id)
        if (
            measurement is None
            or measurement.experiment_id != experiment_id
            or not _can_access(measurement.user_id, user)
        ):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Measurement not found.",
            )

    existing = select(CalculationData.id).where(
        CalculationData.calculation_id == Calculation.id,
        CalculationData.measurement_id == Measurement.id,
    )
    statement = (
        select(
            Calculation.id.label("calculation_id"),
            Measurement.id.label("measurement_id"),
        )
        .select_from(Calculation)
        .join(Measurement, Measurement.experiment_id == Calculation.experiment_id)
        .where(
            Calculation.experiment_id == experiment_id,
            Measurement.recorded_at.is_not(None),
            ~existing.exists(),
        )
        .order_by(Measurement.id, Calculation.id)
    )
    if not is_admin_user(user):
        statement = statement.where(Measurement.user_id == user.id)
    if calculation_id is not None:
        statement = statement.where(Calculation.id == calculation_id)
    if measurement_id is not None:
        statement = statement.where(Measurement.id == measurement_id)

    rows = (await db.execute(statement)).all()
    items = [
        {"calculation_id": row.calculation_id, "measurement_id": row.measurement_id}
        for row in rows
    ]
    return {"total": len(items), "items": items}


async def save_calculation_data(
    db: AsyncSession,
    calculation_id: int,
    measurement_id: int,
    source_hash: str,
    data: CalculationDataOutput,
    *,
    user: UserData,
) -> dict[str, int | bool]:
    calculation = await db.scalar(
        select(Calculation)
        .where(Calculation.id == calculation_id)
        .with_for_update()
    )
    if calculation is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Calculation not found.",
        )
    await _require_experiment(db, calculation.experiment_id, user)
    current_hash = hashlib.sha256(calculation.source_code.encode("utf-8")).hexdigest()
    if current_hash != source_hash:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Calculation source changed while CalculationData was running.",
        )

    measurement = await db.scalar(
        select(Measurement)
        .where(Measurement.id == measurement_id)
        .with_for_update()
    )
    if (
        measurement is None
        or measurement.experiment_id != calculation.experiment_id
        or measurement.recorded_at is None
        or not _can_access(measurement.user_id, user)
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Recorded Measurement not found.",
        )

    existing = await db.scalar(
        select(CalculationData).where(
            CalculationData.calculation_id == calculation.id,
            CalculationData.measurement_id == measurement.id,
        )
    )
    if existing is not None:
        await db.commit()
        return {"id": existing.id, "created": False}

    row = CalculationData(
        calculation_id=calculation.id,
        measurement_id=measurement.id,
        data=data.model_dump(mode="json"),
    )
    db.add(row)
    try:
        await db.flush()
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    return {"id": row.id, "created": True}


async def list_calculation_data_scalars(
    db: AsyncSession,
    calculation_id: int,
    exclude_measurement_id: int | None,
    *,
    user: UserData,
) -> dict[str, Any]:
    calculation = await db.get(Calculation, calculation_id)
    if calculation is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Calculation not found.",
        )
    await _require_experiment(db, calculation.experiment_id, user)

    statement = (
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
        statement = statement.where(Measurement.user_id == user.id)
    if exclude_measurement_id is not None:
        statement = statement.where(
            CalculationData.measurement_id != exclude_measurement_id
        )

    rows = (await db.execute(statement)).all()
    items = [
        {"measurement_id": row.measurement_id, "value": float(row.value)}
        for row in rows
    ]
    return {"total": len(items), "items": items}
