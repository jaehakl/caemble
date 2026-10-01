from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from optimization import service
from optimization.schemas import OptimizationCreateRequest, OptimizationRetryRequest
from gpstation.utils.csrf import require_web_csrf
from user_auth.schemas import UserData
from db import get_db
from user_auth.utils.auth_wrapper import require_roles

router = APIRouter(prefix="/cae/optimizations", tags=["cae-optimizations"], dependencies=[Depends(require_web_csrf)])
authenticated = require_roles(["admin", "user"])


@router.post("")
async def create(body: OptimizationCreateRequest, request: Request, db=Depends(get_db), user: UserData = Depends(authenticated)):
    from optimization.controller import wake_controller
    optimization = await service.create_optimization(db, body, user, request.app.state.catalog)
    wake_controller()
    return await service.optimization_detail(db, optimization)


@router.get("")
async def listing(experiment_id: int | None = None, limit: int = Query(50, ge=1, le=200),
                  offset: int = Query(0, ge=0), db=Depends(get_db), user: UserData = Depends(authenticated)):
    return await service.list_optimizations(db, user, experiment_id=experiment_id, limit=limit, offset=offset)


@router.get("/{optimization_id}")
async def detail(optimization_id: UUID, db=Depends(get_db), user: UserData = Depends(authenticated)):
    optimization = await service.require_optimization(db, str(optimization_id), user)
    return await service.optimization_detail(db, optimization)


@router.get("/{optimization_id}/trials")
async def trials(optimization_id: UUID, limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
                 db=Depends(get_db), user: UserData = Depends(authenticated)):
    optimization = await service.require_optimization(db, str(optimization_id), user)
    return await service.list_trials(db, optimization, limit=limit, offset=offset)


@router.post("/{optimization_id}/stop")
async def stop(optimization_id: UUID, db=Depends(get_db), user: UserData = Depends(authenticated)):
    return await service.stop_optimization(db, str(optimization_id), user)


@router.post("/{optimization_id}/resume")
async def resume(optimization_id: UUID, db=Depends(get_db), user: UserData = Depends(authenticated)):
    return await service.resume_owned_optimization(db, str(optimization_id), user)


@router.post("/{optimization_id}/trials/{trial_id}/retry")
async def retry(optimization_id: UUID, trial_id: UUID, body: OptimizationRetryRequest, db=Depends(get_db),
                user: UserData = Depends(authenticated)):
    return await service.retry_trial(db, str(optimization_id), str(trial_id), str(body.request_id), user)


@router.delete("/{optimization_id}")
async def remove(optimization_id: UUID, db=Depends(get_db), user: UserData = Depends(authenticated)):
    await service.remove_optimization(db, str(optimization_id), user)
    return {"ok": True}


@router.post("/{optimization_id}/evaluations/{evaluation_id}/retry")
async def retry_evaluation(optimization_id: UUID, evaluation_id: UUID, body: OptimizationRetryRequest,
                           request: Request, db=Depends(get_db), user: UserData = Depends(authenticated)):
    return await service.retry_evaluation(db, str(optimization_id), str(evaluation_id), str(body.request_id), user,
                                          request.app.state.catalog)
