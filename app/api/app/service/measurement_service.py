from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from db import Experiment, Measurement, RecordedData, Sample, Setup, Structure
from models import (
    MeasurementBase,
    MeasurementContextListRequest,
    MeasurementPairListRequest,
    MeasurementPairListResponse,
    MeasurementPairSummary,
    MeasurementSaveRequest,
    MeasurementSaveResponse,
    UserData,
)
from utils.crud import CrudSpec, get_list_response
from utils.crud.common import is_admin_user


MEASUREMENT_CRUD_SPEC = CrudSpec(model=Measurement, schema=MeasurementBase)
MEASUREMENT_OVERWRITE_REQUIRED_MESSAGE = (
    "Measurement가 이미 존재합니다. RecordedData를 교체하려면 overwrite=true가 필요합니다."
)


class MeasurementOverwriteRequiredError(Exception):
    pass


class MeasurementService:
    @staticmethod
    async def get_context_measurements(
        request: MeasurementContextListRequest,
        db: AsyncSession,
        user: UserData,
    ) -> dict:
        base_clause = and_(
            Measurement.sample.has(Sample.structure_id == request.structure_id),
            Measurement.setup.has(Setup.experiment_id == request.experiment_id),
        )
        if not is_admin_user(user):
            base_clause = and_(base_clause, Measurement.user_id == user.id)
        return await get_list_response(
            db,
            request,
            MEASUREMENT_CRUD_SPEC,
            base_clause,
            user=user,
        )

    @staticmethod
    async def get_measurement_pairs(
        request: MeasurementPairListRequest,
        db: AsyncSession,
        user: UserData,
    ) -> MeasurementPairListResponse:
        clauses = []
        if not is_admin_user(user):
            clauses.append(Measurement.user_id == user.id)
        clauses.extend(MeasurementService._definition_scope_clauses(request, user))

        if request.structure_id is not None:
            clauses.append(Structure.id == request.structure_id)
        if request.experiment_id is not None:
            clauses.append(Experiment.id == request.experiment_id)
        if request.exclude_structure_id is not None:
            clauses.append(Structure.id != request.exclude_structure_id)
        if request.exclude_experiment_id is not None:
            clauses.append(Experiment.id != request.exclude_experiment_id)
        if request.measured_from is not None:
            clauses.append(Measurement.updated_at >= request.measured_from)
        if request.measured_to is not None:
            clauses.append(Measurement.updated_at <= request.measured_to)

        search_text = (request.search_text or "").strip()
        if search_text:
            pattern = f"%{search_text}%"
            clauses.append(
                or_(
                    Structure.name.ilike(pattern),
                    Structure.description.ilike(pattern),
                    Experiment.name.ilike(pattern),
                    Experiment.description.ilike(pattern),
                )
            )

        pair_partition = (Structure.id, Experiment.id)
        ranked = (
            select(
                Structure.id.label("structure_id"),
                Structure.name.label("structure_name"),
                Structure.description.label("structure_description"),
                Structure.user_id.label("structure_user_id"),
                Experiment.id.label("experiment_id"),
                Experiment.name.label("experiment_name"),
                Experiment.description.label("experiment_description"),
                Experiment.user_id.label("experiment_user_id"),
                func.count(Measurement.id)
                .over(partition_by=pair_partition)
                .label("measurement_count"),
                Measurement.id.label("latest_measurement_id"),
                Measurement.updated_at.label("latest_measurement_at"),
                func.row_number()
                .over(
                    partition_by=pair_partition,
                    order_by=(Measurement.updated_at.desc(), Measurement.id.desc()),
                )
                .label("latest_rank"),
            )
            .select_from(Measurement)
            .join(Sample, Sample.id == Measurement.sample_id)
            .join(Structure, Structure.id == Sample.structure_id)
            .join(Setup, Setup.id == Measurement.setup_id)
            .join(Experiment, Experiment.id == Setup.experiment_id)
        )
        if clauses:
            ranked = ranked.where(and_(*clauses))
        ranked_rows = ranked.subquery("ranked_measurement_pairs")
        pair_rows = (
            select(
                *(
                    ranked_rows.c[column_name]
                    for column_name in MeasurementPairSummary.model_fields
                )
            )
            .where(ranked_rows.c.latest_rank == 1)
            .subquery("measurement_pairs")
        )

        total = await db.scalar(select(func.count()).select_from(pair_rows))
        sort_field = request.sort[0] if request.sort else "latest_measurement_at"
        sort_direction = (
            request.sort[1].lower()
            if request.sort is not None and len(request.sort) > 1
            else "desc"
        )
        sort_column = pair_rows.c[sort_field]
        stmt = select(pair_rows).order_by(
            sort_column.desc() if sort_direction == "desc" else sort_column.asc(),
            pair_rows.c.structure_id.asc(),
            pair_rows.c.experiment_id.asc(),
        )
        if request.offset:
            stmt = stmt.offset(request.offset)
        if request.limit is not None:
            stmt = stmt.limit(request.limit)
        rows = (await db.execute(stmt)).mappings().all()
        return MeasurementPairListResponse(
            total=total or 0,
            items=[MeasurementPairSummary.model_validate(row) for row in rows],
        )

    @staticmethod
    def _definition_scope_clauses(
        request: MeasurementPairListRequest,
        user: UserData,
    ) -> list:
        clauses = []
        for model, scope in (
            (Structure, request.structure_scope),
            (Experiment, request.experiment_scope),
        ):
            if scope == "mine":
                clauses.append(model.user_id == user.id)
            elif scope == "public":
                clauses.append(model.user_id.is_(None))
            elif not is_admin_user(user):
                clauses.append(or_(model.user_id.is_(None), model.user_id == user.id))
        return clauses

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
            pair_clause = and_(
                Measurement.sample_id == sample.id,
                Measurement.setup_id == setup.id,
            )
            measurement = await db.scalar(
                select(Measurement).where(pair_clause).with_for_update()
            )
            replacing = measurement is not None
            if measurement is None:
                inserted = (
                    await db.execute(
                        insert(Measurement)
                        .values(
                            user_id=user.id,
                            sample_id=sample.id,
                            setup_id=setup.id,
                        )
                        .on_conflict_do_nothing(
                            constraint="uq_measurements_sample_id_setup_id"
                        )
                        .returning(Measurement.id, Measurement.user_id)
                    )
                ).one_or_none()
                if inserted is not None:
                    measurement_id = inserted.id
                    measurement_user_id = inserted.user_id
                else:
                    if not request.overwrite:
                        raise MeasurementOverwriteRequiredError(
                            MEASUREMENT_OVERWRITE_REQUIRED_MESSAGE
                        )
                    measurement = await db.scalar(
                        select(Measurement).where(pair_clause).with_for_update()
                    )
                    if measurement is None:
                        raise RuntimeError(
                            "동시에 저장된 Measurement를 다시 조회하지 못했습니다."
                        )
                    replacing = True
                    measurement_id = measurement.id
                    measurement_user_id = measurement.user_id
            else:
                measurement_id = measurement.id
                measurement_user_id = measurement.user_id

            if replacing and not request.overwrite:
                raise MeasurementOverwriteRequiredError(
                    MEASUREMENT_OVERWRITE_REQUIRED_MESSAGE
                )

            if replacing:
                await db.execute(
                    update(Measurement)
                    .where(Measurement.id == measurement_id)
                    .values(updated_at=func.now())
                )
                await db.execute(
                    delete(RecordedData).where(
                        RecordedData.measurement_id == measurement_id
                    )
                )

            db.add_all(
                [
                    RecordedData(
                        user_id=measurement_user_id,
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
