from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from simulation.schemas import ExperimentRecordListRequest, ExperimentRecordListResponse
from user_auth.schemas import UserData
from simulation.services.experiments import list_experiment_records as list_experiment_record_rows
from db import get_db
from user_auth.utils.auth_wrapper import require_roles


router = APIRouter(prefix="/experiment_record", tags=["experiment_record"])


@router.post("/list", response_model=ExperimentRecordListResponse)
async def list_experiment_records(
    request: ExperimentRecordListRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData | None = Depends(require_roles(["*"])),
):
    return await list_experiment_record_rows(db, request, user=user)
