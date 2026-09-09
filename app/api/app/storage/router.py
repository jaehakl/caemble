from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from cae.batches import require_batch
from cae.db import CaeBatch
from db import Calculation, Measurement
from gpstation.db import Job
from gpstation.utils.csrf import require_web_csrf
from models import UserData
from service.experiment_access import require_experiment_read, require_experiment_write
from storage.db import StorageObject
from storage.service import download_parts, finish_upload, owned_object, prepare_upload, reference
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles

router = APIRouter(prefix="/storage", tags=["storage"], dependencies=[Depends(require_web_csrf)])


@router.post("/uploads")
async def prepare(body: dict = Body(), db: AsyncSession = Depends(get_db),
                  user: UserData = Depends(require_roles(["admin", "user"]))):
    scope = body.get("scope", {})
    if not isinstance(scope, dict):
        raise HTTPException(422, "Invalid upload scope.")
    purpose = scope.get("purpose")
    experiment_id = scope.get("experiment_id")
    for key in ("experiment_id", "measurement_id", "calculation_id"):
        if scope.get(key) is not None and (type(scope[key]) is not int or scope[key] < 1):
            raise HTTPException(422, "Upload scope IDs must be positive integers.")
    if scope.get("job_id") is not None:
        try:
            UUID(scope["job_id"])
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(422, "Invalid upload job UUID.") from None
    if purpose == "calculation" and experiment_id is None:
        target = await db.get(Measurement, scope.get("measurement_id"))
        if target is None:
            raise HTTPException(404, "Measurement not found.")
        experiment_id = target.experiment_id
    if experiment_id is None:
        raise HTTPException(422, "Upload scope requires an Experiment.")
    await require_experiment_write(db, experiment_id, user)
    job_id, measurement_id, calculation_id = scope.get("job_id"), scope.get("measurement_id"), scope.get("calculation_id")
    if purpose == "input":
        job = await db.get(Job, job_id) if job_id else None
        if job is None or job.user_id != user.id or job.state != "staged":
            raise HTTPException(404, "Staged input job not found.")
        batch = await require_batch(db, job.batch_id, user.id, lock=True)
        cae = await db.get(CaeBatch, batch.id)
        if batch.state != "uploading" or cae.experiment_id != experiment_id:
            raise HTTPException(409, "Batch is not accepting input uploads.")
        measurement_id = calculation_id = None
    elif purpose == "calculation":
        measurement = await db.get(Measurement, measurement_id) if measurement_id else None
        calculation = await db.get(Calculation, calculation_id) if calculation_id else None
        if (measurement is None or measurement.user_id != user.id or measurement.experiment_id != experiment_id
                or measurement.recorded_at is None or calculation is None or calculation.experiment_id != experiment_id):
            raise HTTPException(404, "Calculation target not found.")
        job_id = None
    elif purpose in {"measurement", "layout"}:
        try:
            UUID(scope["request_id"])
        except (ValueError, KeyError, TypeError):
            raise HTTPException(422, "Measurement/layout uploads require a request UUID.") from None
        job_id = measurement_id = calculation_id = None
    else:
        raise HTTPException(422, "Invalid upload purpose.")
    result = await prepare_upload(db, body.get("manifest", {}), user_id=user.id, experiment_id=experiment_id,
                                  purpose=purpose, job_id=job_id, measurement_id=measurement_id, calculation_id=calculation_id,
                                  request_id=scope.get("request_id") if purpose in {"measurement", "layout"} else None)
    await db.commit()
    return result


@router.post("/uploads/{object_id}/complete")
async def complete(object_id: UUID, db: AsyncSession = Depends(get_db),
                   user: UserData = Depends(require_roles(["admin", "user"]))):
    row = await owned_object(db, str(object_id), user.id)
    result = await finish_upload(db, row)
    await db.commit()
    return result


@router.get("/objects/{object_id}")
async def read(object_id: UUID, db: AsyncSession = Depends(get_db),
               user: UserData | None = Depends(require_roles(["*"]))):
    row = await db.get(StorageObject, str(object_id))
    if row is None or row.experiment_id is None:
        raise HTTPException(404, "Object not found.")
    if row.bound and ((row.purpose in {"measurement", "record", "calculation"} and row.measurement_id is None)
                      or (row.purpose == "layout" and row.calculation_id is None)
                      or (row.purpose == "calculation" and row.calculation_data_id is None)):
        raise HTTPException(404, "Object owner has been deleted.")
    owner = user is not None and user.id == row.user_id
    if not owner and (not row.bound or (row.measurement_id is None and row.purpose != "layout")):
        raise HTTPException(404, "Object not found.")
    await require_experiment_read(db, row.experiment_id, user)
    return await download_parts(db, reference(row))
