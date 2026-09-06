import hashlib
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from db import (
    Calculation,
    CalculationData,
    CalculationExperimentRecord,
    Experiment,
    ExperimentRecord,
    Measurement,
    RecordedData,
)
from models import CalculationBase, CalculationListRequest, CalculationOutputLayout, UserData
from utils.crud import CrudSpec, delete_items, get_list_response
from utils.crud.common import is_admin_user


CALCULATION_CRUD_SPEC = CrudSpec(
    model=Calculation,
    schema=CalculationBase,
    scope_path=("experiment",),
    relation_aliases={"experiment_record_ids": "experiment_records"},
)


def _layout_payload(layout: CalculationOutputLayout | dict[str, Any]) -> dict[str, Any]:
    return (
        layout.model_dump(mode="json")
        if isinstance(layout, CalculationOutputLayout)
        else CalculationOutputLayout.model_validate(layout).model_dump(mode="json")
    )


def calculation_output_contract(data: dict[str, Any]) -> dict[str, Any]:
    """Compare output structure while preserving per-Measurement coordinates in storage."""
    layout = _layout_payload(
        {
            "dtype": data.get("dtype"),
            "shape": data.get("shape"),
            "axes": data.get("axes"),
        }
    )
    for axis in layout["axes"]:
        del axis["ticks"]
    return layout


async def list_calculations(
    db: AsyncSession,
    request: CalculationListRequest,
    *,
    user: UserData | None,
) -> dict[str, Any]:
    experiment_id = request.experiment_id
    if experiment_id is None:
        bounds = (request.filter or {}).get("experiment_id", [])
        if (
            len(bounds) >= 2
            and isinstance(bounds[0], int)
            and not isinstance(bounds[0], bool)
            and bounds[0] == bounds[1]
        ):
            experiment_id = bounds[0]
    if experiment_id is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Calculation list requires one Experiment.",
        )

    request.sort = ["updated_at", "desc"]
    request.random = False
    return await get_list_response(
        db,
        request,
        CALCULATION_CRUD_SPEC,
        Calculation.experiment_id == experiment_id,
        user=user,
    )


async def upsert_calculations(
    db: AsyncSession,
    items: list[CalculationBase],
    *,
    user: UserData,
) -> list[dict[str, int]]:
    normalized_items: list[CalculationBase] = []
    for item in items:
        name = item.name.strip()
        if not name:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Calculation name is required.",
            )
        source_hash = hashlib.sha256(item.source_code.encode("utf-8")).hexdigest()
        if item.contract_status != "ready":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Calculation must have a successful current preflight before saving.",
            )
        if item.source_hash != source_hash:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Calculation source changed after preflight.",
            )
        if item.output_layout is None or item.preflight_measurement_id is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Calculation output layout and preflight Measurement are required.",
            )
        if len(item.experiment_record_ids) != len(set(item.experiment_record_ids)):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Calculation ExperimentRecord IDs must not contain duplicates.",
            )
        normalized_items.append(item.model_copy(update={"name": name, "source_hash": source_hash}))

    experiment_ids = sorted({item.experiment_id for item in normalized_items})
    experiments = (
        await db.scalars(
            select(Experiment)
            .where(Experiment.id.in_(experiment_ids))
            .order_by(Experiment.id)
            .with_for_update()
        )
    ).all()
    experiments_by_id = {experiment.id: experiment for experiment in experiments}
    for experiment_id in experiment_ids:
        experiment = experiments_by_id.get(experiment_id)
        if experiment is None or (
            not is_admin_user(user) and experiment.user_id != user.id
        ):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="experiment_id not found.",
            )

    requested_record_ids = sorted(
        {record_id for item in normalized_items for record_id in item.experiment_record_ids}
    )
    experiment_records = list(
        (
            await db.scalars(
                select(ExperimentRecord)
                .where(ExperimentRecord.id.in_(requested_record_ids))
                .order_by(ExperimentRecord.id)
            )
        ).all()
    )
    records_by_id = {record.id: record for record in experiment_records}
    for item in normalized_items:
        invalid = [
            record_id
            for record_id in item.experiment_record_ids
            if record_id not in records_by_id
            or records_by_id[record_id].experiment_id != item.experiment_id
        ]
        if invalid:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"ExperimentRecord does not belong to the Calculation Experiment: {invalid}",
            )
        measurement = await db.get(Measurement, item.preflight_measurement_id)
        if (
            measurement is None
            or measurement.experiment_id != item.experiment_id
            or measurement.recorded_at is None
            or (not is_admin_user(user) and measurement.user_id != user.id)
        ):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Preflight Measurement is unavailable or belongs to another Experiment.",
            )
        available_record_ids = set(
            (
                await db.scalars(
                    select(RecordedData.experiment_record_id).where(
                        RecordedData.measurement_id == measurement.id,
                        RecordedData.experiment_record_id.in_(item.experiment_record_ids),
                    )
                )
            ).all()
        )
        if available_record_ids != set(item.experiment_record_ids):
            missing = sorted(set(item.experiment_record_ids) - available_record_ids)
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Preflight Measurement is missing required ExperimentRecords: {missing}",
            )

    supplied_ids = sorted({item.id for item in normalized_items if item.id is not None})
    existing_rows = (
        await db.scalars(
            select(Calculation)
            .where(Calculation.id.in_(supplied_ids))
            .order_by(Calculation.id)
            .with_for_update()
        )
    ).all()
    existing_by_id = {row.id: row for row in existing_rows}
    missing_ids = [item_id for item_id in supplied_ids if item_id not in existing_by_id]
    if missing_ids:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Items not found: {missing_ids}.",
        )

    pending: list[Calculation] = []
    dependencies: list[tuple[Calculation, CalculationBase]] = []
    for item in normalized_items:
        row = existing_by_id.get(item.id)
        if row is None:
            row = Calculation(experiment_id=item.experiment_id)
            db.add(row)
        else:
            existing_experiment = experiments_by_id.get(row.experiment_id)
            if existing_experiment is None:
                existing_experiment = await db.get(Experiment, row.experiment_id)
            owner_id = existing_experiment.user_id if existing_experiment is not None else None
            if not is_admin_user(user) and owner_id != user.id:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Items not found: [{row.id}].",
                )
            if row.experiment_id != item.experiment_id:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Calculation cannot be moved to another Experiment.",
                )
            source_changed = row.source_code != item.source_code
            if source_changed:
                await db.execute(
                    delete(CalculationData).where(CalculationData.calculation_id == row.id)
                )
            elif row.output_layout != _layout_payload(item.output_layout):
                existing_outputs = list(
                    (
                        await db.scalars(
                            select(CalculationData.data).where(CalculationData.calculation_id == row.id)
                        )
                    ).all()
                )
                incompatible = [
                    index
                    for index, output in enumerate(existing_outputs)
                    if calculation_output_contract(output)
                    != calculation_output_contract(_layout_payload(item.output_layout))
                ]
                if incompatible:
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail="Existing CalculationData does not match the new preflight output layout.",
                    )
        row.name = item.name
        row.description = item.description
        row.source_code = item.source_code
        row.source_hash = item.source_hash
        row.output_layout = _layout_payload(item.output_layout)
        row.preflight_measurement_id = item.preflight_measurement_id
        row.contract_status = "ready"
        pending.append(row)
        dependencies.append((row, item))

    try:
        await db.flush()
        for row, item in dependencies:
            await db.execute(
                delete(CalculationExperimentRecord).where(
                    CalculationExperimentRecord.calculation_id == row.id
                )
            )
            db.add_all(
                [
                    CalculationExperimentRecord(
                        calculation_id=row.id,
                        experiment_record_id=record_id,
                    )
                    for record_id in sorted(item.experiment_record_ids)
                ]
            )
        await db.flush()
        await db.commit()
    except IntegrityError as error:
        await db.rollback()
        constraint_name = getattr(getattr(error.orig, "diag", None), "constraint_name", "")
        detail = (
            "Calculation name already exists in this Experiment."
            if constraint_name == "uq_calculations_experiment_id_name"
            else "Database constraint violation."
        )
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail) from error
    return [{"id": row.id} for row in pending]


async def delete_calculations(
    db: AsyncSession,
    ids: list[int],
    *,
    user: UserData,
) -> None:
    experiment_ids = set(
        (
            await db.scalars(
                select(Calculation.experiment_id).where(Calculation.id.in_(ids))
            )
        ).all()
    )
    if experiment_ids:
        await db.execute(
            select(Experiment.id)
            .where(Experiment.id.in_(experiment_ids))
            .order_by(Experiment.id)
            .with_for_update()
        )
    await delete_items(db, CALCULATION_CRUD_SPEC, ids, user=user)
