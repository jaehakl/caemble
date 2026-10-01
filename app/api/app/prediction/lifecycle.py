from fastapi import HTTPException
from sqlalchemy import delete, select, update

from gpstation.db import Job, Launcher
from gpstation.service.job_service import JOB_TERMINAL_STATES
from gpstation.service.state import utcnow
from prediction.common import connected_storage, lock_identity, owned, require_dataset_idle
from prediction.datasets import dataset_view
from prediction.db import Dataset, DatasetObject, DatasetRevision, ModelLease, PredictionModel, PredictionStorage
from prediction.models import model_view


async def register_storage(db, body, user_id):
    await lock_identity(db, str(body.storage_id))
    launcher = await db.get(Launcher, str(body.launcher_id))
    if (launcher is None or launcher.user_id != user_id or launcher.disconnected_at is not None
            or launcher.status not in {"ready", "busy"}):
        raise HTTPException(409, "Connect the owned launcher before registering its storage.")
    row = await db.scalar(select(PredictionStorage).where(
        PredictionStorage.storage_id == str(body.storage_id)).with_for_update())
    if row is not None and (row.user_id != user_id or row.launcher_id != str(body.launcher_id)):
        raise HTTPException(409, "Storage identity belongs to another installation or owner.")
    if row is None:
        row = PredictionStorage(storage_id=str(body.storage_id), user_id=user_id,
            launcher_id=str(body.launcher_id), name=body.name)
        db.add(row)
    row.name, row.checked_at = body.name, utcnow()
    await db.commit()
    return {"storage_id": row.storage_id, "launcher_id": row.launcher_id, "name": row.name, "checked_at": row.checked_at}


async def list_storages(db, user_id):
    rows = (await db.execute(select(PredictionStorage, Launcher).outerjoin(
        Launcher, Launcher.id == PredictionStorage.launcher_id).where(PredictionStorage.user_id == user_id))).all()
    return {"items": [{"storage_id": row.storage_id, "launcher_id": row.launcher_id, "name": row.name,
        "checked_at": row.checked_at, "connected": launcher is not None and launcher.disconnected_at is None
            and launcher.status in {"ready", "busy"}} for row, launcher in rows]}


async def delete_asset(db, kind, identity, body, user_id, *, complete=False):
    model = Dataset if kind == "dataset" else PredictionModel
    row = await owned(db, model, identity, user_id, active=False)
    if row.state == "deleted":
        return {"id": row.id, "state": row.state, "delete_id": row.delete_id}
    if complete:
        if (row.state != "deleting" or row.delete_id != str(body.request_id)
                or row.storage_id != (str(body.storage_id) if body.storage_id else None)
                or row.launcher_id != (str(body.launcher_id) if body.launcher_id else None)):
            raise HTTPException(409, "Deletion acknowledgement differs from the requested storage or operation.")
        row.state = "deleted"
    elif row.state == "active":
        if kind == "dataset":
            await require_dataset_idle(db, row.id)
        else:
            active = await db.scalar(select(ModelLease.job_id).join(Job, Job.id == ModelLease.job_id).where(
                ModelLease.model_id == row.id, (~Job.state.in_(JOB_TERMINAL_STATES)) | Job.cleaned_at.is_(None)).limit(1))
            if active is not None:
                raise HTTPException(409, "Release active model instances and wait for Predictor cleanup before deletion.")
        if row.storage_id is not None:
            if str(body.storage_id) != row.storage_id or str(body.launcher_id) != row.launcher_id:
                raise HTTPException(409, "Connect the asset's registered storage before deleting it.")
            await connected_storage(db, row.storage_id, row.launcher_id, user_id)
        row.delete_id = str(body.request_id)
        row.state = "deleting" if row.storage_id else "deleted"
    elif row.delete_id != str(body.request_id):
        # Reopen interrupted deletion using its original operation, never create
        # a replacement identity or undo the durable tombstone.
        raise HTTPException(409, {"message": "Resume the pending deletion.", "delete_id": row.delete_id})
    if kind == "dataset":
        await db.execute(delete(DatasetObject).where(DatasetObject.dataset_id == row.id))
        await db.execute(update(DatasetRevision).where(DatasetRevision.dataset_id == row.id).values(payload=None))
    await db.commit()
    return await (dataset_view(db, row) if kind == "dataset" else model_view(db, row))
