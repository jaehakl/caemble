from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from db import Measurement, RecordedData, Sample, Setup
from models import (
    MeasurementContextListRequest,
    MeasurementSaveRequest,
    MeasurementSaveResponse,
    UserData,
)
from utils.crud.common import is_admin_user


class MeasurementService:
    @staticmethod
    async def get_context_measurements(
        request: MeasurementContextListRequest,
        db: AsyncSession,
        user: UserData,
    ) -> dict:
        stmt = (
            select(Measurement)
            .join(Measurement.sample)
            .join(Measurement.setup)
            .where(
                Sample.structure_id == request.structure_id,
                Setup.experiment_id == request.experiment_id,
            )
            .order_by(Measurement.updated_at.desc(), Measurement.id.desc())
        )
        if not is_admin_user(user):
            stmt = stmt.where(Measurement.user_id == user.id)

        rows = list((await db.scalars(stmt)).all())
        return {
            "total": len(rows),
            "items": [
                {
                    "id": row.id,
                    "created_at": row.created_at,
                    "updated_at": row.updated_at,
                    "user_id": row.user_id,
                    "sample_id": row.sample_id,
                    "setup_id": row.setup_id,
                }
                for row in rows
            ],
        }

    @staticmethod
    async def save_measurement(
        request: MeasurementSaveRequest,
        db: AsyncSession,
        user: UserData,
    ) -> MeasurementSaveResponse:
        sample = await db.scalar(select(Sample).where(Sample.id == request.sample_id))
        setup = await db.scalar(select(Setup).where(Setup.id == request.setup_id))
        if sample is None or (not is_admin_user(user) and sample.user_id != user.id):
            raise LookupError("sample_id not found.")
        if setup is None or (not is_admin_user(user) and setup.user_id != user.id):
            raise LookupError("setup_id not found.")

        try:
            measurement_id = await db.scalar(
                insert(Measurement)
                .values(
                    user_id=user.id,
                    sample_id=sample.id,
                    setup_id=setup.id,
                )
                .on_conflict_do_update(
                    constraint="uq_measurements_sample_id_setup_id",
                    set_={"updated_at": func.now()},
                )
                .returning(Measurement.id)
            )
            if measurement_id is None:
                raise RuntimeError("Measurement ID를 저장하지 못했습니다.")

            await db.execute(
                delete(RecordedData).where(
                    RecordedData.measurement_id == measurement_id
                )
            )
            db.add_all(
                [
                    RecordedData(
                        user_id=user.id,
                        measurement_id=measurement_id,
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
            await db.commit()
        except IntegrityError:
            await db.rollback()
            raise
        except Exception:
            await db.rollback()
            raise

        return MeasurementSaveResponse(id=measurement_id)
