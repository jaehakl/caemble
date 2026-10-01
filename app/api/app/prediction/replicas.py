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
    result = []
    for row in rows:
        view = replica_view(row)
        if row.state == "deleting" and row.delete_id:
            from prediction.operations import assert_copy_idle
            from prediction.db import Operation, StorageAccess
            from gpstation.db import Launcher
            operation = await db.get(Operation, row.delete_id)
            reason, message = "awaiting_confirmation", "파일 삭제 확인을 기다리고 있습니다."
            storage = await db.get(PredictionStorage, row.storage_id)
            try:
                await assert_copy_idle(db, row, operation_id=row.delete_id)
            except HTTPException as error:
                reason = "transfer" if "transfer" in str(error.detail).lower() else "in_use"
                message = ("전송 작업이 이 복사본을 사용 중입니다." if reason == "transfer"
                    else "예측 세션이 이 복사본을 사용 중입니다. 사용 해제 후 삭제를 계속하세요.")
            else:
                if operation and operation.state == "interrupted":
                    reason, message = "interrupted", (operation.error or {}).get("message") or "삭제 확인이 중단되었습니다."
                if storage and storage.kind == "predictor_local":
                    connected = await db.scalar(select(Launcher.id).join(StorageAccess,
                        StorageAccess.launcher_id == Launcher.id).where(StorageAccess.storage_id == row.storage_id,
                        Launcher.user_id == storage.user_id, Launcher.disconnected_at.is_(None),
                        Launcher.status.in_(["ready", "busy"])).limit(1))
                    if not connected:
                        reason, message = "offline", "장비가 오프라인입니다. 연결 후 삭제를 계속하세요."
            view["deletion"] = {"operation_id": row.delete_id, "reason": reason, "message": message}
        result.append(view)
    return result


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
