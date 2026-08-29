from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from db import ExperimentRecord, Measurement, RecordedData
from models import RecordedDataBase, RecordedDataListRequest, UserData
from utils.crud import CrudSpec, get_list_response


RECORDED_DATA_CRUD_SPEC = CrudSpec(model=RecordedData, schema=RecordedDataBase)


async def list_recorded_data(
    db: AsyncSession,
    request: RecordedDataListRequest,
    *,
    user: UserData | None,
) -> dict[str, Any]:
    clauses = []
    if not request.include_system:
        clauses.append(
            and_(
                RecordedData.experiment_record.has(~ExperimentRecord.name.like("@caemble/%")),
                RecordedData.experiment_record.has(~ExperimentRecord.name.like("rayPaths.%")),
            )
        )
    if request.experiment_id is not None:
        if request.experiment_id <= 0:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="experiment_id must be positive.")
        clauses.append(RecordedData.measurement.has(Measurement.experiment_id == request.experiment_id))
    if request.experiment_record_ids is not None:
        record_ids = request.experiment_record_ids
        if not record_ids or any(record_id <= 0 for record_id in record_ids) or len(record_ids) != len(set(record_ids)):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="experiment_record_ids must contain unique positive IDs.",
            )
        clauses.append(RecordedData.experiment_record_id.in_(record_ids))
    base_clause = and_(*clauses) if clauses else None
    response = await get_list_response(
        db,
        request,
        RECORDED_DATA_CRUD_SPEC,
        base_clause,
        user=user,
    )
    if not response["items"]:
        return response
    record_ids = [item.experiment_record_id for item in response["items"]]
    records = {
        record.id: record
        for record in (
            await db.scalars(
                select(ExperimentRecord).where(ExperimentRecord.id.in_(record_ids))
            )
        ).all()
    }
    return {
        "total": response["total"],
        "items": [
            {
                **item.model_dump(mode="json"),
                "name": records[item.experiment_record_id].name,
                "quantity_kind": records[item.experiment_record_id].quantity_kind,
                "tensor_order": records[item.experiment_record_id].tensor_order,
                "dtype": records[item.experiment_record_id].dtype,
                "data_schema": records[item.experiment_record_id].data_schema,
            }
            for item in response["items"]
            if item.experiment_record_id in records
        ],
    }
