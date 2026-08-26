from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db import Experiment, Measurement, RecordedData
from models import (
    MeasurementCreateRequest,
    MeasurementRecordRequest,
    MeasurementSaveRecordedData,
    MeasurementSaveRecordedDataGroup,
    MeasurementSaveResponse,
    UserData,
)
from utils.crud.common import is_admin_user


class MeasurementService:
    @staticmethod
    async def get_recorded_data(
        measurement_id: int,
        db: AsyncSession,
        user: UserData,
    ) -> MeasurementRecordRequest:
        measurement = await db.get(Measurement, measurement_id)
        if measurement is None or (
            not is_admin_user(user) and measurement.user_id != user.id
        ):
            raise LookupError("Measurement not found.")

        rows = (
            await db.scalars(
                select(RecordedData)
                .where(RecordedData.measurement_id == measurement_id)
                .order_by(RecordedData.id)
            )
        ).all()
        tree: dict[str, object] = {}
        for row in rows:
            names = row.name.split(".")
            group = tree
            for name in names[:-1]:
                group = group.setdefault(name, {})  # type: ignore[assignment]
            group[names[-1]] = {
                "quantity_kind": row.quantity_kind,
                "tensor_order": row.tensor_order,
                "dtype": row.dtype,
                "data_schema": row.data_schema,
                "data": row.data,
            }
        return MeasurementRecordRequest.model_validate({"recorded_data": tree})

    @staticmethod
    async def create_measurement(
        request: MeasurementCreateRequest,
        db: AsyncSession,
        user: UserData,
    ) -> MeasurementSaveResponse:
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
        leaves: list[tuple[str, MeasurementSaveRecordedData]] = []

        def flatten(prefix: str, node: MeasurementSaveRecordedData | MeasurementSaveRecordedDataGroup) -> None:
            if isinstance(node, MeasurementSaveRecordedData):
                leaves.append((prefix, node))
                return
            for name, member in node.root.items():
                flatten(f"{prefix}.{name}", member)

        for name, node in request.recorded_data.items():
            flatten(name, node)

        measurement = await db.scalar(
            select(Measurement)
            .where(Measurement.id == measurement_id)
            .with_for_update()
        )
        if measurement is None or (
            not is_admin_user(user) and measurement.user_id != user.id
        ):
            raise LookupError("Measurement not found.")
        try:
            db.add_all(
                [
                    RecordedData(
                        user_id=measurement.user_id,
                        measurement_id=measurement.id,
                        name=name,
                        quantity_kind=item.quantity_kind,
                        tensor_order=item.tensor_order,
                        dtype=item.dtype,
                        data_schema=item.data_schema,
                        data=item.data,
                        data_url=None,
                        file_size=None,
                    )
                    for name, item in leaves
                ]
            )
            measurement.recorded_at = datetime.now(timezone.utc)
            await db.flush()
            await db.commit()
        except Exception:
            await db.rollback()
            raise
        return MeasurementSaveResponse(id=measurement.id)
