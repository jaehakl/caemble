from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select

from cae.studies import service
from cae.studies.db import Trial
from cae.studies.models import StudyCreateRequest, StudyRetryRequest
from gpstation.service.batches import serialize_events
from gpstation.utils.csrf import require_web_csrf
from models import UserData
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles

router = APIRouter(prefix="/cae/studies", tags=["cae-studies"], dependencies=[Depends(require_web_csrf)])
authenticated = require_roles(["admin", "user"])


@router.post("")
async def create(body: StudyCreateRequest, request: Request, db=Depends(get_db), user: UserData = Depends(authenticated)):
    from cae.studies.controller import wake_controller
    study = await service.create_study(db, body, user, request.app.state.catalog)
    wake_controller()
    return await service.study_detail(db, study)


@router.get("")
async def listing(experiment_id: int | None = None, limit: int = Query(50, ge=1, le=200),
                  offset: int = Query(0, ge=0), db=Depends(get_db), user: UserData = Depends(authenticated)):
    return await service.list_studies(db, user, experiment_id=experiment_id, limit=limit, offset=offset)


@router.get("/{study_id}")
async def detail(study_id: UUID, db=Depends(get_db), user: UserData = Depends(authenticated)):
    study = await service.require_study(db, str(study_id), user)
    return await service.study_detail(db, study)


@router.get("/{study_id}/trials")
async def trials(study_id: UUID, limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
                 db=Depends(get_db), user: UserData = Depends(authenticated)):
    study = await service.require_study(db, str(study_id), user)
    return await service.list_trials(db, study, limit=limit, offset=offset)


@router.post("/{study_id}/stop")
async def stop(study_id: UUID, db=Depends(get_db), user: UserData = Depends(authenticated)):
    from cae.studies.controller import cancel_study, wake_controller
    await serialize_events(db)
    study = await service.require_study(db, str(study_id), user, lock=True)
    await cancel_study(db, study, "user")
    await db.commit()
    wake_controller()
    return await service.study_detail(db, study)


@router.post("/{study_id}/resume")
async def resume(study_id: UUID, db=Depends(get_db), user: UserData = Depends(authenticated)):
    from cae.studies.controller import wake_controller
    await serialize_events(db)
    study = await service.require_study(db, str(study_id), user, lock=True)
    await service.resume_study(db, study)
    await db.commit()
    wake_controller()
    return await service.study_detail(db, study)


@router.post("/{study_id}/trials/{trial_id}/retry")
async def retry(study_id: UUID, trial_id: UUID, body: StudyRetryRequest, db=Depends(get_db),
                user: UserData = Depends(authenticated)):
    from cae.studies.controller import request_retry, wake_controller
    await serialize_events(db)
    study = await service.require_study(db, str(study_id), user, lock=True)
    trial = await db.scalar(select(Trial).where(Trial.study_id == study.id, Trial.id == str(trial_id)).with_for_update())
    if trial is None:
        raise HTTPException(404, "Trial not found.")
    await request_retry(db, study, trial, str(body.request_id))
    await db.commit()
    wake_controller()
    return await service.study_detail(db, study)


@router.delete("/{study_id}")
async def remove(study_id: UUID, db=Depends(get_db), user: UserData = Depends(authenticated)):
    await serialize_events(db)
    study = await service.require_study(db, str(study_id), user, lock=True)
    await service.delete_study(db, study)
    await db.commit()
    return {"ok": True}
