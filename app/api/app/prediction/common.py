import hashlib
import json
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import func, select

from gpstation.db import Launcher
from prediction.db import PredictionStorage, StorageAccess

IDENTITY_NAMESPACE = UUID("897a2e86-43d2-4e7c-9923-73bb2da5a454")


def canonical_bytes(value) -> bytes:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise HTTPException(422, "Prediction metadata must contain finite JSON values.") from error


def digest(value) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


async def owned(db, model, identity, user_id, *, active=True):
    row = await db.scalar(select(model).where(model.id == str(identity), model.user_id == user_id).with_for_update())
    if row is None:
        raise HTTPException(404, "Prediction asset not found.")
    if active and row.state != "active":
        raise HTTPException(410, "Prediction asset was deleted. Its identity cannot be registered again.")
    return row


async def connected_storage(db, storage_id, launcher_id, user_id):
    storage = await db.get(PredictionStorage, str(storage_id))
    access = await db.get(StorageAccess, (str(storage_id), str(launcher_id)))
    launcher = await db.get(Launcher, str(launcher_id))
    if (storage is None or storage.user_id != user_id or storage.kind != "predictor_local" or access is None
            or launcher is None or launcher.user_id != user_id or launcher.disconnected_at is not None
            or launcher.status not in {"ready", "busy"}):
        raise HTTPException(409, "Connect the registered Prediction storage before this operation.")
    return storage


async def require_dataset_idle(db, dataset_id):
    from gpstation.service.state import utcnow
    from prediction.db import DatasetGrant
    from prediction.db import TrainingRun
    from gpstation.db import Job
    from gpstation.service.job_service import JOB_TERMINAL_STATES
    training = await db.scalar(select(TrainingRun.operation_id).join(Job, Job.id == TrainingRun.job_id).where(
        TrainingRun.dataset_id == dataset_id,
        (~Job.state.in_(JOB_TERMINAL_STATES)) | (Job.launcher_id.is_not(None) & Job.cleaned_at.is_(None))).limit(1))
    if training is not None:
        raise HTTPException(409, {"message": "Dataset is pinned by training. Wait for the training process to finish cleanup.",
            "operation_id": training})
    from prediction.training import release_finished_grants, retained_runs
    retained = await retained_runs(db, dataset_id)
    if retained:
        raise HTTPException(409, {"message": "Dataset is retained for model preparation or a retryable update. Finish or cancel it first.",
            "operation_id": retained[0][0].operation_id})
    await release_finished_grants(db, dataset_id)
    from datetime import timedelta
    from prediction.grants import RENEWAL_GRACE_SECONDS
    expiry = await db.scalar(select(DatasetGrant.expires_at).where(
        DatasetGrant.dataset_id == dataset_id, DatasetGrant.expires_at > utcnow() - timedelta(seconds=RENEWAL_GRACE_SECONDS))
        .order_by(DatasetGrant.expires_at.desc()).limit(1))
    if expiry is not None:
        raise HTTPException(409, {"message": "Dataset is being read. Finish or cancel preparation before changing it.",
            "lease_expires_at": expiry.isoformat()})


async def lock_identity(db, identity):
    await db.execute(select(func.pg_advisory_xact_lock(func.hashtext(identity))))
