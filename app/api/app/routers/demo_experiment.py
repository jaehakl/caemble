from fastapi import APIRouter, Depends
from gpstation.utils.csrf import require_web_csrf
from sqlalchemy.ext.asyncio import AsyncSession

from models import DemoExperimentUpdateRequest, UserData
from service.demo_experiment import available_experiments, demo_experiment_candidates, replace_demo_experiments
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles


router = APIRouter(tags=["demo-experiments"])


@router.get("/experiment/available")
async def get_available_experiments(
    db: AsyncSession = Depends(get_db),
    user: UserData | None = Depends(require_roles(["*"])),
):
    return await available_experiments(db, user=user)


@router.put(
    "/admin/demo-experiments",
    dependencies=[Depends(require_web_csrf)],
)
async def put_demo_experiments(
    request: DemoExperimentUpdateRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin"])),
):
    return await replace_demo_experiments(db, request, user=user)


@router.get("/admin/demo-experiments/candidates")
async def get_demo_experiment_candidates(
    db: AsyncSession = Depends(get_db),
    _: UserData = Depends(require_roles(["admin"])),
):
    return await demo_experiment_candidates(db)
