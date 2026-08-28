from typing import Any

from sqlalchemy import and_
from sqlalchemy.ext.asyncio import AsyncSession

from db import RecordedData
from models import RecordedDataBase, RecordedDataListRequest, UserData
from utils.crud import CrudSpec, get_list_response


RECORDED_DATA_CRUD_SPEC = CrudSpec(model=RecordedData, schema=RecordedDataBase)


async def list_recorded_data(
    db: AsyncSession,
    request: RecordedDataListRequest,
    *,
    user: UserData | None,
) -> dict[str, Any]:
    base_clause = (
        None
        if request.include_system
        else and_(
            ~RecordedData.name.like("@caemble/%"),
            ~RecordedData.name.like("rayPaths.%"),
        )
    )
    return await get_list_response(
        db,
        request,
        RECORDED_DATA_CRUD_SPEC,
        base_clause,
        user=user,
    )
