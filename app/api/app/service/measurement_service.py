from datetime import datetime, timezone
import re

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db import Experiment, Measurement, RecordedData
from models import (
    MeasurementCreateRequest,
    MeasurementRecordRequest,
    MeasurementSaveResponse,
    UserData,
)
from utils.crud.common import is_admin_user


class MeasurementAlreadyRecordedError(Exception):
    pass


TASK_PATH = re.compile(r"^tasks/([A-Za-z][A-Za-z0-9_-]*)\.tsx$")


class MeasurementService:
    @staticmethod
    async def create_measurement(
        request: MeasurementCreateRequest,
        db: AsyncSession,
        user: UserData,
    ) -> MeasurementSaveResponse:
        material_parameters = request.material_parameters
        if set(material_parameters) != {"schemaVersion", "experiment", "tasks"}:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    "material_parameters must contain exactly schemaVersion, "
                    "experiment, and tasks."
                ),
            )
        if material_parameters["schemaVersion"] != 2:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="material_parameters.schemaVersion must be 2.",
            )
        task_snapshots = material_parameters["tasks"]
        if not isinstance(task_snapshots, dict) or any(
            not isinstance(task_name, str)
            or not task_name.strip()
            or not isinstance(snapshot, dict)
            for task_name, snapshot in task_snapshots.items()
        ):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="material_parameters.tasks must map Task names to objects.",
            )
        snapshots = [
            ("material_parameters.experiment", material_parameters["experiment"]),
            *(
                (f"material_parameters.tasks.{task_name}", snapshot)
                for task_name, snapshot in task_snapshots.items()
            ),
        ]
        for path, snapshot in snapshots:
            if not isinstance(snapshot, dict) or set(snapshot) not in (
                {"schemaVersion", "materials"},
                {"schemaVersion", "materials", "materialColors"},
            ):
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"{path} must be a frozen Material snapshot.",
                )
            if snapshot["schemaVersion"] != 1 or not isinstance(snapshot["materials"], dict):
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"{path} must use frozen Material schemaVersion 1.",
                )
            if "materialColors" in snapshot and not isinstance(snapshot["materialColors"], dict):
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"{path}.materialColors must be an object.",
                )

        experiment = await db.scalar(
            select(Experiment)
            .where(Experiment.id == request.experiment_id)
            .with_for_update()
        )
        if experiment is None or (
            not is_admin_user(user)
            and experiment.user_id not in {None, user.id}
        ):
            raise LookupError("experiment_id not found.")
        if experiment.source_hash != request.experiment_source_hash:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Experiment source changed before Measurement creation.",
            )
        files = experiment.source_bundle.get("files", {})
        task_names = {
            match.group(1)
            for path in files
            if (match := TASK_PATH.fullmatch(path)) is not None
        }
        if not task_names:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Experiment requires at least one Task before Measurement creation.",
            )
        if set(task_snapshots) != task_names:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Measurement Material Task snapshots must exactly match the Experiment bundle.",
            )

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
        return MeasurementSaveResponse(id=measurement.id)

    @staticmethod
    async def record_measurement(
        measurement_id: int,
        request: MeasurementRecordRequest,
        db: AsyncSession,
        user: UserData,
    ) -> MeasurementSaveResponse:
        names = [item.name for item in request.recorded_data]
        if len(names) != len(set(names)):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="RecordedData names must be unique within a Measurement.",
            )

        measurement = await db.scalar(
            select(Measurement)
            .where(Measurement.id == measurement_id)
            .with_for_update()
        )
        if measurement is None or (
            not is_admin_user(user) and measurement.user_id != user.id
        ):
            raise LookupError("Measurement not found.")
        if measurement.recorded_at is not None:
            raise MeasurementAlreadyRecordedError(
                "Measurement already has RecordedData. Create a new Measurement to run it again."
            )

        try:
            db.add_all(
                [
                    RecordedData(
                        user_id=measurement.user_id,
                        measurement_id=measurement.id,
                        name=item.name,
                        quantity_kind=item.quantity_kind,
                        tensor_order=item.tensor_order,
                        dtype=item.dtype,
                        data_schema=item.data_schema,
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
        return MeasurementSaveResponse(id=measurement.id)
