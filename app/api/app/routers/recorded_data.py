from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from db import RecordedData
from models import GetListResponseBase, RecordedDataBase, RecordedDataListRequest, UserData
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles
from utils.crud import CrudSpec, get_list_response


router = APIRouter(prefix="/recorded_data", tags=["recorded_data"])
CRUD_SPEC = CrudSpec(model=RecordedData, schema=RecordedDataBase)


@router.post("/list", response_model=GetListResponseBase)
async def list_recorded_data(
    request: RecordedDataListRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData | None = Depends(require_roles(["*"])),
):
    base_clause = None if request.include_system else ~RecordedData.name.like("@caemble/%")
    return await get_list_response(db, request, CRUD_SPEC, base_clause, user=user)
