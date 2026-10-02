from fastapi import HTTPException
from sqlalchemy import select

from gpstation.db import Job, Launcher
from gpstation.service.state import utcnow
from prediction.common import lock_identity, owned
from prediction.db import Dataset, PredictionModel, PredictionStorage, StorageAccess


async def register_storage(db, body, user_id):
    await lock_identity(db, str(body.storage_id))
    launcher = await db.get(Launcher, str(body.launcher_id))
    if (launcher is None or launcher.user_id != user_id or launcher.disconnected_at is not None
            or launcher.status not in {"ready", "busy"}):
        raise HTTPException(409, "Connect the owned launcher before registering its storage.")
    if body.job_id:
        job = await db.get(Job, str(body.job_id))
        if job is None or job.user_id != user_id or job.launcher_id != launcher.id or job.slave_app_id != "predictor":
            raise HTTPException(409, "Storage inspection requires this launcher's owned Predictor execution.")
    row = await db.get(PredictionStorage, str(body.storage_id))
    if row is not None and (row.user_id != user_id or row.kind != "predictor_local"):
        raise HTTPException(409, "Storage identity belongs to another owner or storage kind.")
    if row is None:
        row = PredictionStorage(storage_id=str(body.storage_id), user_id=user_id, kind="predictor_local", name=body.name)
        db.add(row)
        await db.flush()
    access = await db.get(StorageAccess, (row.storage_id, launcher.id))
    if access is None:
        access = StorageAccess(storage_id=row.storage_id, launcher_id=launcher.id)
        db.add(access)
    access.checked_at = row.checked_at = utcnow()
    row.name = body.name.strip()
    await db.commit()
    return {"storage_id": row.storage_id, "launcher_id": launcher.id, "name": row.name,
        "kind": row.kind, "checked_at": row.checked_at}


async def list_storages(db, user_id):
    from prediction.replicas import managed_storage
    from settings import settings
    await managed_storage(db, user_id, "object_backup")
    await db.commit()
    rows = (await db.scalars(select(PredictionStorage).where(PredictionStorage.user_id == user_id))).all()
    items = []
    for row in rows:
        routes = (await db.execute(select(StorageAccess, Launcher).outerjoin(Launcher,
            Launcher.id == StorageAccess.launcher_id).where(StorageAccess.storage_id == row.storage_id))).all()
        items.append({"storage_id": row.storage_id, "name": row.name, "kind": row.kind,
            "checked_at": row.checked_at, "configured": row.kind != "object_backup" or bool(settings.s3_bucket),
            "accesses": [{"launcher_id": access.launcher_id, "checked_at": access.checked_at,
                "connected": launcher is not None and launcher.user_id == user_id and launcher.disconnected_at is None
                    and launcher.status in {"ready", "busy"}} for access, launcher in routes]})
    return {"items": items}


async def rename_asset(db, kind, identity, name, user_id):
    row = await owned(db, Dataset if kind == "dataset" else PredictionModel, identity, user_id)
    row.name = name.strip()
    if not row.name:
        raise HTTPException(422, "Asset name must not be blank.")
    await db.commit()
    from prediction.datasets import dataset_view
    from prediction.models import model_view
    return await (dataset_view(db, row) if kind == "dataset" else model_view(db, row))


async def delete_asset(db, kind, identity, body, user_id, *, complete=False):
    """Retain the HTTP facade while deletion is tracked per copy."""
    from prediction import operations
    from prediction.schemas import OperationComplete, OperationCreate
    row = await owned(db, Dataset if kind == "dataset" else PredictionModel, identity, user_id, active=False)
    if complete:
        operation = await operations.owned_operation(db, str(body.request_id), user_id)
        for replica in await operations.deletion_replicas(db, operation):
            if body.storage_id and replica.storage_id == str(body.storage_id):
                await operations.complete_operation(db, operation, OperationComplete(replica_id=replica.id))
    elif row.state != "deleted":
        # The retired facade preserves its immediate busy error. The management
        # operation API records pending deletion and lets existing readers finish.
        if row.state == "active":
            from prediction.common import require_dataset_idle
            from prediction.db import ModelLease
            from gpstation.service.job_service import JOB_TERMINAL_STATES
            if kind == "dataset":
                await require_dataset_idle(db, row.id)
            else:
                await operations.assert_model_pins_idle(db, row.id)
                active = await db.scalar(select(ModelLease.job_id).join(Job, Job.id == ModelLease.job_id).where(
                    ModelLease.model_id == row.id,
                    (~Job.state.in_(JOB_TERMINAL_STATES)) | Job.cleaned_at.is_(None)).limit(1))
                if active:
                    raise HTTPException(409, "Release model instances and wait for Predictor cleanup before deletion.")
        await operations.create_operation(db, OperationCreate(request_id=body.request_id, kind="delete_asset",
            asset_kind=kind, asset_id=identity), user_id)
    from prediction.datasets import dataset_view
    from prediction.models import model_view
    return await (dataset_view(db, row) if kind == "dataset" else model_view(db, row))
