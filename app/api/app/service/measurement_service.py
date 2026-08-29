from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from db import CalculationData, Experiment, ExperimentRecord, Measurement, RecordedData
from models import (
    GetListRequestBase,
    MeasurementBase,
    MeasurementCreateRequest,
    MeasurementRecordedDataResponse,
    MeasurementRecordRequest,
    UserData,
)
from utils.crud import CrudSpec, delete_items, get_list_response
from utils.crud.common import is_admin_user


MEASUREMENT_CRUD_SPEC = CrudSpec(model=Measurement, schema=MeasurementBase)


async def list_measurements(
    db: AsyncSession,
    request: GetListRequestBase,
    *,
    user: UserData | None,
) -> dict[str, Any]:
    response = await get_list_response(
        db,
        request,
        MEASUREMENT_CRUD_SPEC,
        user=user,
    )
    measurement_ids = [item.id for item in response["items"] if item.id is not None]
    if not measurement_ids:
        return response
    rows = (
        await db.execute(
            select(
                CalculationData.measurement_id,
                func.count(CalculationData.id).label("count"),
            )
            .where(CalculationData.measurement_id.in_(measurement_ids))
            .group_by(CalculationData.measurement_id)
        )
    ).all()
    counts = {row.measurement_id: row.count for row in rows}
    return {
        "total": response["total"],
        "items": [
            item.model_copy(update={"calculation_data_count": counts.get(item.id, 0)})
            for item in response["items"]
        ],
    }


async def get_recorded_data(
    db: AsyncSession,
    measurement_id: int,
    *,
    user: UserData,
) -> MeasurementRecordedDataResponse:
    measurement = await db.get(Measurement, measurement_id)
    if measurement is None or (
        not is_admin_user(user) and measurement.user_id != user.id
    ):
        raise LookupError("Measurement not found.")

    rows = (
        await db.execute(
            select(RecordedData, ExperimentRecord)
            .join(ExperimentRecord, ExperimentRecord.id == RecordedData.experiment_record_id)
            .where(RecordedData.measurement_id == measurement_id)
            .order_by(RecordedData.id)
        )
    ).all()
    tree: dict[str, object] = {}
    for row, record in rows:
        names = record.name.split(".")
        group = tree
        for name in names[:-1]:
            group = group.setdefault(name, {})  # type: ignore[assignment]
        group[names[-1]] = {
            "experiment_record_id": record.id,
            "quantity_kind": record.quantity_kind,
            "tensor_order": record.tensor_order,
            "dtype": record.dtype,
            "data_schema": record.data_schema,
            "data": row.data,
        }
    return MeasurementRecordedDataResponse.model_validate({"recorded_data": tree})


async def create_measurement(
    db: AsyncSession,
    request: MeasurementCreateRequest,
    *,
    user: UserData,
) -> dict[str, int]:
    experiment = await db.scalar(
        select(Experiment)
        .where(Experiment.id == request.experiment_id)
        .with_for_update()
    )
    if experiment is None or (
        not is_admin_user(user) and experiment.user_id not in {None, user.id}
    ):
        raise LookupError("experiment_id not found.")
    measurement = Measurement(
        user_id=user.id,
        experiment_id=experiment.id,
        vars=request.vars,
        material_parameters=request.material_parameters,
        recorded_at=None,
    )
    db.add(measurement)
    try:
        await db.flush()
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    return {"id": measurement.id}


async def record_measurement(
    db: AsyncSession,
    measurement_id: int,
    request: MeasurementRecordRequest,
    *,
    user: UserData,
) -> dict[str, int]:
    measurement = await db.scalar(
        select(Measurement)
        .where(Measurement.id == measurement_id)
        .with_for_update()
    )
    if measurement is None or (
        not is_admin_user(user) and measurement.user_id != user.id
    ):
        raise LookupError("Measurement not found.")
    record_ids = [item.experiment_record_id for item in request.recorded_data]
    if len(record_ids) != len(set(record_ids)):
        raise ValueError("recorded_data must not contain duplicate ExperimentRecord IDs.")
    valid_ids = set(
        (
            await db.scalars(
                select(ExperimentRecord.id).where(
                    ExperimentRecord.id.in_(record_ids),
                    ExperimentRecord.experiment_id == measurement.experiment_id,
                )
            )
        ).all()
    )
    if valid_ids != set(record_ids):
        raise ValueError("Every ExperimentRecord must belong to the Measurement Experiment.")
    try:
        db.add_all(
            [
                RecordedData(
                    user_id=measurement.user_id,
                    measurement_id=measurement.id,
                    experiment_record_id=item.experiment_record_id,
                    data=item.data,
                    data_url=None,
                    file_size=None,
                )
                for item in request.recorded_data
            ]
        )
        measurement.recorded_at = datetime.now(timezone.utc)
        await db.flush()
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    return {"id": measurement.id}


async def delete_measurements(
    db: AsyncSession,
    ids: list[int],
    *,
    user: UserData,
) -> None:
    await delete_items(db, MEASUREMENT_CRUD_SPEC, ids, user=user)
