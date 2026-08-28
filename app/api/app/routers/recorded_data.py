from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from models import RecordedDataListRequest, UserData
from service.recorded_data import list_recorded_data as list_recorded_data_rows
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles


router = APIRouter(prefix="/recorded_data", tags=["recorded_data"])


@router.post("/list")
async def list_recorded_data(
    request: RecordedDataListRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData | None = Depends(require_roles(["*"])),
):
    return await list_recorded_data_rows(db, request, user=user)
