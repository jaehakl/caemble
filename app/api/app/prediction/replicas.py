"""Revision copies and independently verified launcher access paths."""
from uuid import uuid5

from fastapi import HTTPException
from sqlalchemy import select

from gpstation.service.state import utcnow
from prediction.common import IDENTITY_NAMESPACE, connected_storage, lock_identity, owned
from prediction.db import Dataset, DatasetRevision, ModelRevision, PredictionModel, PredictionStorage, Replica


async def managed_storage(db, user_id, kind):
    identity = str(uuid5(IDENTITY_NAMESPACE, f"{user_id}/storage/{kind}"))
    await lock_identity(db, identity)
    storage = await db.scalar(select(PredictionStorage).where(PredictionStorage.user_id == user_id,
        PredictionStorage.kind == kind))
    if storage is None:
        storage = PredictionStorage(storage_id=identity, user_id=user_id, kind=kind,
            name="백업 저장소" if kind == "object_backup" else "서버 학습 데이터")
        db.add(storage)
        await db.flush()
    return storage


def replica_view(row):
    return {"id": row.id, "storage_id": row.storage_id, "state": row.state,
        "manifest_sha256": row.manifest_sha256, "artifact": row.artifact,
        "checked_at": row.checked_at, "verified_at": row.verified_at, "delete_id": row.delete_id}


async def revision_replicas(db, kind, identity, revision):
    field = Replica.model_id if kind == "model" else Replica.dataset_id
    rows = (await db.scalars(select(Replica).where(field == identity, Replica.revision == revision,
        Replica.state != "deleted").order_by(Replica.storage_id))).all()
    return [replica_view(row) for row in rows]


async def put_replica(db, kind, identity, revision, storage_id, *, artifact=None, state="present", object_id=None,
        recreate_deleted=False):
    key = str(uuid5(IDENTITY_NAMESPACE, f"{kind}/{identity}/{revision}/{storage_id}"))
    field = Replica.model_id if kind == "model" else Replica.dataset_id
    row = await db.scalar(select(Replica).where(field == identity, Replica.revision == revision,
        Replica.storage_id == storage_id).with_for_update())
    checksum = (artifact or {}).get("manifest_sha256")
    if row is None:
        row = Replica(id=key, model_id=identity if kind == "model" else None,
            dataset_id=identity if kind == "dataset" else None, revision=revision,
            storage_id=storage_id, state=state)
        db.add(row)
    elif row.state == "deleting":
        raise HTTPException(409, "This copy is being deleted. Complete its deletion before restoring it.")
    elif row.state == "deleted" and not recreate_deleted:
        raise HTTPException(410, "This copy was deleted. Restore it explicitly before registering it again.")
    elif row.manifest_sha256 and checksum and row.manifest_sha256 != checksum:
        raise HTTPException(409, "The same revision already contains different bytes on this storage.")
    if state != "unverified" or row.state != "present":
        row.state = state
    if state != "unverified":
        row.checked_at = utcnow()
    if artifact is not None:
        row.artifact = {**(row.artifact or {}), **artifact}
        row.manifest_sha256 = checksum or row.manifest_sha256
    if object_id is not None:
        row.object_id = object_id
    if state == "present":
        row.verified_at = utcnow()
    row.delete_id = None
    await db.flush()
    return row


async def check_replica(db, body, user_id):
    asset = await owned(db, PredictionModel if body.asset_kind == "model" else Dataset, body.asset_id, user_id)
    await connected_storage(db, body.storage_id, body.launcher_id, user_id)
    revision = await db.get(ModelRevision if body.asset_kind == "model" else DatasetRevision, (asset.id, body.revision))
    if revision is None:
        raise HTTPException(404, "Revision not found.")
    if body.asset_kind == "dataset":
        existing = await db.scalar(select(Replica.id).where(Replica.dataset_id == asset.id,
            Replica.revision == body.revision, Replica.storage_id == str(body.storage_id)))
        if existing is None:
            raise HTTPException(409, "Complete the Dataset restore before checking it on another storage.")
    artifact = body.artifact or {}
    checksum = body.manifest_sha256 or artifact.get("manifest_sha256") or artifact.get("manifestChecksum")
    if body.state == "present" and not checksum:
        raise HTTPException(422, "Verified copies require a manifest checksum.")
    if body.asset_kind == "model" and body.state == "present":
        if revision.state != "ready" or checksum != (revision.artifact or {}).get("manifest_sha256"):
            raise HTTPException(409, "Verified model differs from its immutable revision.")
        artifact = revision.artifact
    elif checksum:
        artifact = {**artifact, "manifest_sha256": checksum}
    row = await put_replica(db, body.asset_kind, asset.id, body.revision, str(body.storage_id),
        artifact=(artifact or None) if body.state == "present" else None, state=body.state)
    await db.commit()
    return replica_view(row)
