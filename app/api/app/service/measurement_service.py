from datetime import datetime, timezone

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


class MeasurementService:
    @staticmethod
    async def create_measurement(
        request: MeasurementCreateRequest,
        db: AsyncSession,
        user: UserData,
    ) -> MeasurementSaveResponse:
        experiment = await db.scalar(
            select(Experiment).where(Experiment.id == request.experiment_id)
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
            path.removeprefix("tasks/").removesuffix(".tsx")
            for path in files
            if path.startswith("tasks/") and path.endswith(".tsx")
        }
        if set(request.material_parameters["tasks"]) != task_names:
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
