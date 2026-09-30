from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from simulation.schemas import RecordedDataListRequest
from user_auth.schemas import UserData
from simulation.services.results import list_recorded_data as list_recorded_data_rows
from db import get_db
from user_auth.utils.auth_wrapper import require_roles


router = APIRouter(prefix="/recorded_data", tags=["recorded_data"])


@router.post("/list")
async def list_recorded_data(
    request: RecordedDataListRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData | None = Depends(require_roles(["*"])),
):
    return await list_recorded_data_rows(db, request, user=user)
