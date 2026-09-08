from typing import Any

from caemble_catalog import Catalog
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from db import CalculationData, Experiment, ExperimentRecord, Measurement, RecordedData
from models import (
    GetListRequestBase,
    MeasurementBase,
    MeasurementCreateRequest,
    MeasurementRecordedDataResponse,
    UserData,
)
from service.experiment_access import require_experiment_read
from service.material_snapshot import validate_material_snapshot
from utils.crud import CrudSpec, delete_items, get_list_response
from utils.crud.common import is_admin_user
from gpstation.db import Job
from gpstation.service.batches import SERVER_ACTIVE_STATES


MEASUREMENT_CRUD_SPEC = CrudSpec(
    model=Measurement,
    schema=MeasurementBase,
    scope_path=("experiment",),
)
MEASUREMENT_WRITE_CRUD_SPEC = CrudSpec(model=Measurement, schema=MeasurementBase)


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
    user: UserData | None,
) -> MeasurementRecordedDataResponse:
    measurement = await db.get(Measurement, measurement_id)
    if measurement is None:
        raise LookupError("Measurement not found.")
    try:
        await require_experiment_read(db, measurement.experiment_id, user)
    except HTTPException as error:
        raise LookupError("Measurement not found.") from error

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
    catalog: Catalog,
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
    if experiment.source_hash != request.experiment_source_hash:
        raise HTTPException(409, "Experiment source changed before Measurement creation.")
    validate_material_snapshot(request.material_snapshot, source_hash=experiment.source_hash, variables=request.vars, catalog=catalog)
    measurement = Measurement(
        user_id=user.id,
        experiment_id=experiment.id,
        vars=request.vars,
        material_snapshot=request.material_snapshot,
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


async def delete_measurements(
    db: AsyncSession,
    ids: list[int],
    *,
    user: UserData,
) -> None:
    rows = (await db.scalars(select(Measurement).where(Measurement.id.in_(ids)).order_by(Measurement.id).with_for_update())).all()
    job_ids = [row.job_id for row in rows if row.job_id]
    if job_ids and await db.scalar(select(Job.id).where(Job.id.in_(job_ids), Job.state.in_(SERVER_ACTIVE_STATES)).limit(1)):
        raise HTTPException(409, "Cancel active CAE jobs before deleting their Measurements.")
    await delete_items(db, MEASUREMENT_WRITE_CRUD_SPEC, ids, user=user)
