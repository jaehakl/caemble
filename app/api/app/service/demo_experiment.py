from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from db import Calculation, CalculationData, Experiment, ExperimentDemo, Measurement
from models import DemoExperimentUpdateRequest, UserData
from user_auth.db import Role, UserRole


async def _prediction_counts(db: AsyncSession, experiment_ids: Iterable[int]) -> dict[int, dict[str, int]]:
    ids = list(dict.fromkeys(experiment_ids))
    counts = {
        experiment_id: {"recordedMeasurements": 0, "readyCalculations": 0, "calculationData": 0}
        for experiment_id in ids
    }
    if not ids:
        return counts

    recorded = await db.execute(
        select(Measurement.experiment_id, func.count(Measurement.id))
        .where(Measurement.experiment_id.in_(ids), Measurement.recorded_at.is_not(None))
        .group_by(Measurement.experiment_id)
    )
    for experiment_id, count in recorded.all():
        counts[experiment_id]["recordedMeasurements"] = count

    ready = await db.execute(
        select(
            Calculation.experiment_id,
            func.count(func.distinct(Calculation.id)),
            func.count(CalculationData.id),
        )
        .join(CalculationData, CalculationData.calculation_id == Calculation.id)
        .join(Measurement, Measurement.id == CalculationData.measurement_id)
        .where(
            Calculation.experiment_id.in_(ids),
            Calculation.contract_status == "ready",
            Measurement.experiment_id == Calculation.experiment_id,
            Measurement.recorded_at.is_not(None),
        )
        .group_by(Calculation.experiment_id)
    )
    for experiment_id, calculation_count, data_count in ready.all():
        counts[experiment_id]["readyCalculations"] = calculation_count
        counts[experiment_id]["calculationData"] = data_count
    return counts


def _summary(
    experiment: Experiment,
    counts: dict[str, int],
    *,
    demo: ExperimentDemo | None,
) -> dict[str, Any]:
    version = f"{experiment.version_major}.{experiment.version_minor}.{experiment.version_patch}"
    prediction_ready = all(counts[field] > 0 for field in counts)
    return {
        "id": experiment.id,
        "user_id": experiment.user_id,
        "created_at": experiment.created_at,
        "updated_at": experiment.updated_at,
        "namespace": experiment.namespace,
        "repository_slug": experiment.repository_slug,
        "experiment_key": experiment.experiment_key,
        "version_major": experiment.version_major,
        "version_minor": experiment.version_minor,
        "version_patch": experiment.version_patch,
        "name": experiment.name,
        "description": experiment.description,
        "source_bundle": experiment.source_bundle,
        "source_hash": experiment.source_hash,
        "repository": experiment.repository_slug,
        "key": experiment.experiment_key,
        "version": version,
        "coordinate": (
            f"caemble:experiment/{experiment.namespace}/{experiment.repository_slug}/"
            f"{experiment.experiment_key}@{version}"
        ),
        "bundleHash": experiment.source_hash,
        "predictionReady": prediction_ready,
        "predictionCounts": counts,
        "isDemo": demo is not None,
        "demoOrder": demo.display_order if demo is not None else None,
        "demoDefault": demo.is_default if demo is not None else False,
    }


async def available_experiments(db: AsyncSession, *, user: UserData | None) -> dict[str, Any]:
    demo_rows = list(
        (
            await db.execute(
                select(ExperimentDemo, Experiment)
                .join(Experiment, Experiment.id == ExperimentDemo.experiment_id)
                .order_by(ExperimentDemo.display_order, Experiment.id)
            )
        ).all()
    )
    demo_ids = [demo.experiment_id for demo, _ in demo_rows]
    demos_by_id = {demo.experiment_id: demo for demo, _ in demo_rows}
    mine_rows: list[Experiment] = []
    if user is not None:
        mine_rows = list(
            (
                await db.scalars(
                    select(Experiment)
                    .where(Experiment.user_id == user.id)
                    .order_by(Experiment.updated_at.desc(), Experiment.id.desc())
                )
            ).all()
        )
    counts = await _prediction_counts(db, [*demo_ids, *(row.id for row in mine_rows)])
    return {
        "mine": [_summary(row, counts[row.id], demo=demos_by_id.get(row.id)) for row in mine_rows],
        "demos": [_summary(row, counts[row.id], demo=demo) for demo, row in demo_rows],
    }


async def demo_experiment_candidates(db: AsyncSession) -> dict[str, Any]:
    admin_owner_ids = select(UserRole.user_id).join(Role, Role.id == UserRole.role_id).where(Role.name == "admin")
    rows = list(
        (
            await db.execute(
                select(Experiment, ExperimentDemo)
                .outerjoin(ExperimentDemo, ExperimentDemo.experiment_id == Experiment.id)
                .where(Experiment.user_id.in_(admin_owner_ids))
                .order_by(Experiment.updated_at.desc(), Experiment.id.desc())
            )
        ).all()
    )
    counts = await _prediction_counts(db, (experiment.id for experiment, _ in rows))
    return {"items": [_summary(experiment, counts[experiment.id], demo=demo) for experiment, demo in rows]}


async def replace_demo_experiments(
    db: AsyncSession,
    request: DemoExperimentUpdateRequest,
    *,
    user: UserData,
) -> dict[str, Any]:
    ids = request.experiment_ids
    experiments = list(
        (
            await db.scalars(
                select(Experiment)
                .where(Experiment.id.in_(ids))
                .order_by(Experiment.id)
                .with_for_update()
            )
        ).all()
    )
    if {row.id for row in experiments} != set(ids):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Experiment not found.")

    admin_owner_ids = set(
        (
            await db.scalars(
                select(UserRole.user_id).join(Role, Role.id == UserRole.role_id).where(Role.name == "admin")
            )
        ).all()
    )
    invalid_owner_ids = [row.id for row in experiments if row.user_id not in admin_owner_ids]
    if invalid_owner_ids:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "demo_owner_required",
                "message": "Demo Experiments must be owned by an administrator.",
                "experimentIds": invalid_owner_ids,
            },
        )

    counts = await _prediction_counts(db, ids)
    unavailable_ids = [
        experiment_id
        for experiment_id in ids
        if not all(counts[experiment_id][key] > 0 for key in counts[experiment_id])
    ]
    if unavailable_ids:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "demo_prediction_data_required",
                "message": "Demo Experiments require recorded Measurements and ready CalculationData.",
                "experimentIds": unavailable_ids,
            },
        )

    await db.execute(delete(ExperimentDemo))
    await db.flush()
    db.add_all(
        [
            ExperimentDemo(
                experiment_id=experiment_id,
                display_order=index,
                is_default=experiment_id == request.default_experiment_id,
            )
            for index, experiment_id in enumerate(ids)
        ]
    )
    await db.commit()
    return await available_experiments(db, user=user)
