"""Durable, owner-scoped copy operations; file bytes never pass through the UI."""
from datetime import timedelta
import asyncio
import time

from fastapi import HTTPException
import jwt
from sqlalchemy import delete, select, update

from gpstation.db import Job
from gpstation.service.job_service import JOB_TERMINAL_STATES
from gpstation.service.state import utcnow
from prediction.common import connected_storage, digest, lock_identity, owned, require_dataset_idle
from prediction.db import (Dataset, DatasetObject, DatasetRevision, ModelLease, ModelRevision, Operation,
    OperationObject, PredictionModel, PredictionStorage, Replica, StorageAccess, DatasetGrant)
from prediction.replicas import managed_storage, put_replica, replica_view
from settings import settings
from storage.db import StorageObject
from storage.service import download_parts, finish_upload, prepare_upload, reference

GRANT_SECONDS = 900
RENEWAL_SECONDS = 24 * 60 * 60
RENEWAL_GRACE_SECONDS = 60
TERMINAL = {"completed", "cancelled"}


def operation_view(row):
    details = row.details
    return {"id": row.id, "request_id": row.request_id, "kind": row.kind, "state": row.state,
        "experiment_id": row.experiment_id,
        "stage": row.stage, "asset_kind": row.asset_kind, "asset_id": row.asset_id,
        "revision": row.revision, "source_replica_id": details.get("source_replica_id"),
        "target_storage_id": details.get("target_storage_id"), "target_launcher_id": details.get("target_launcher_id"),
        "include_dataset": details.get("include_dataset", False), "details": details,
        "error": row.error.get("message") if row.error else None, "created_at": row.created_at,
        "updated_at": row.updated_at, "completed_at": row.completed_at}


async def owned_operation(db, identity, user_id):
    # All mutations lock the asset before its operations, including child deletions.
    current = await db.scalar(select(Operation).where(Operation.id == str(identity), Operation.user_id == user_id))
    if current is None:
        raise HTTPException(404, "Prediction operation not found.")
    await owned(db, PredictionModel if current.asset_kind == "model" else Dataset,
        current.asset_id, user_id, active=False)
    row = await db.scalar(select(Operation).where(Operation.id == str(identity), Operation.user_id == user_id).with_for_update())
    if row is None:
        raise HTTPException(404, "Prediction operation not found.")
    return row


async def expire_operation(db, row):
    if row.state in {"pending", "running"} and row.expires_at is not None and row.expires_at <= utcnow():
        row.state, row.stage = "interrupted", "interrupted"
        row.error = {"message": "The transfer connection expired. Retry to inspect completed files and continue registration."}
        row.updated_at = utcnow()
        await db.commit()


async def list_operations(db, user_id, experiment_id=None):
    query = select(Operation).where(Operation.user_id == user_id)
    if experiment_id is not None:
        query = query.where(Operation.experiment_id == experiment_id)
    rows = (await db.scalars(query.order_by(Operation.created_at.desc()).limit(100))).all()
    for row in rows:
        if row.kind.startswith("delete_") and row.state != "completed":
            row = await owned_operation(db, row.id, user_id)
            await finish_deletion(db, row)
            await db.commit()
        await expire_operation(db, row)
    await db.commit()
    return {"items": [operation_view(row) for row in rows]}


async def selected_replica(db, identity, kind, asset_id, revision, *, readable=True):
    row = await db.get(Replica, str(identity)) if identity else None
    field = "model_id" if kind == "model" else "dataset_id"
    if row is None or getattr(row, field) != asset_id or (revision is not None and row.revision != revision):
        raise HTTPException(404, "The selected copy does not belong to this asset revision.")
    if readable and row.state not in {"present", "unverified"}:
        raise HTTPException(409, "The selected copy needs repair before it can be read.")
    return row


async def access_launcher(db, replica, requested, user_id):
    if requested:
        await connected_storage(db, replica.storage_id, requested, user_id)
        return str(requested)
    routes = (await db.scalars(select(StorageAccess).where(StorageAccess.storage_id == replica.storage_id))).all()
    for route in routes:
        try:
            await connected_storage(db, replica.storage_id, route.launcher_id, user_id)
            return route.launcher_id
        except HTTPException:
            continue
    raise HTTPException(409, "Connect a launcher that can access the selected copy.")


async def dataset_source(db, revision, body, user_id):
    dataset = await owned(db, Dataset, revision.dataset_id, user_id)
    item = await db.get(DatasetRevision, (dataset.id, revision.dataset_revision))
    if item is None or item.fingerprint != revision.dataset_fingerprint:
        raise HTTPException(409, "The exact training Dataset revision is unavailable.")
    if body.dataset_source_replica_id:
        source = await selected_replica(db, body.dataset_source_replica_id, "dataset", dataset.id, item.revision)
    else:
        copies = (await db.scalars(select(Replica).where(Replica.dataset_id == dataset.id,
            Replica.revision == item.revision, Replica.state.in_(["present", "unverified"])))).all()
        ranked = []
        for copy in copies:
            storage = await db.get(PredictionStorage, copy.storage_id)
            priority = {"object_backup": 0, "api_dataset": 1, "predictor_local": 2}[storage.kind]
            ranked.append((priority, copy.id, copy))
        source = sorted(ranked, key=lambda entry: entry[:2])[0][2] if ranked else None
    if source is None:
        raise HTTPException(409, "Model prediction can be backed up, but its exact training Dataset files are no longer retained.")
    storage = await db.get(PredictionStorage, source.storage_id)
    launcher_id = None
    if storage.kind == "predictor_local":
        launcher_id = await access_launcher(db, source, body.dataset_source_launcher_id, user_id)
    elif storage.kind == "api_dataset" and item.payload is None:
        raise HTTPException(409, "The exact server Dataset payload was retired. Choose another retained copy.")
    return {"kind": storage.kind, "replica_id": source.id, "storage_id": source.storage_id,
        "launcher_id": launcher_id, "dataset_id": dataset.id, "revision": item.revision,
        "fingerprint": item.fingerprint, "manifest_sha256": source.manifest_sha256,
        "payload_sha256": digest(item.payload) if storage.kind == "api_dataset" else None}


async def assert_copy_idle(db, replica, *, operation_id=None, execution_leases=True):
    if execution_leases and replica.model_id:
        lease = await db.scalar(select(ModelLease.job_id).join(Job, Job.id == ModelLease.job_id).where(
            ModelLease.model_id == replica.model_id, ModelLease.revision == replica.revision,
            (ModelLease.storage_id == replica.storage_id) | ModelLease.storage_id.is_(None),
            (~Job.state.in_(JOB_TERMINAL_STATES)) | Job.cleaned_at.is_(None)).limit(1))
        if lease:
            raise HTTPException(409, "Release instances using this copy and wait for Predictor cleanup before deleting it.")
    elif execution_leases:
        await require_dataset_idle(db, replica.dataset_id)
    pending = (await db.scalars(select(Operation).where(Operation.state.in_(["pending", "running", "interrupted"]),
        Operation.kind.in_(["backup", "restore"]), *([Operation.id != operation_id] if operation_id else [])))).all()
    for operation in pending:
        sources = [operation.details.get("source_replica_id"), (operation.details.get("dataset_source") or {}).get("replica_id")]
        if replica.id in sources:
            raise HTTPException(409, "Finish or cancel the transfer reading this copy before deletion.")


async def deletion_replicas(db, operation):
    ids = operation.details.get("replica_ids", [])
    return list((await db.scalars(select(Replica).where(Replica.id.in_(ids)))).all())


async def begin_deletion(db, operation, asset, body):
    field = Replica.model_id if body.asset_kind == "model" else Replica.dataset_id
    if body.kind == "delete_replica":
        copies = [await selected_replica(db, body.replica_id, body.asset_kind, asset.id, body.revision, readable=False)]
    else:
        if body.asset_kind == "model":
            preparing = (await db.scalars(select(ModelRevision).where(ModelRevision.model_id == asset.id,
                ModelRevision.state.in_(["reserved", "abandoned"])))).all()
            for revision in preparing:
                if revision.preparation.get("storage_id"):
                    existing = await db.scalar(select(Replica.id).where(Replica.model_id == asset.id,
                        Replica.revision == revision.revision, Replica.storage_id == revision.preparation["storage_id"]))
                    if existing is None:
                        await put_replica(db, "model", asset.id, revision.revision,
                            revision.preparation["storage_id"], state="unverified")
        copies = list((await db.scalars(select(Replica).where(field == asset.id, Replica.state != "deleted"))).all())
    # A compute instance may drain after deletion is queued. A transfer that
    # would publish a new copy must finish or be cancelled before a tombstone.
    dependencies = set()
    for copy in copies:
        if copy.state == "deleting" and copy.delete_id != operation.id:
            if body.kind != "delete_asset":
                raise HTTPException(409, {"message": "Continue the existing copy deletion.", "operation_id": copy.delete_id})
            dependencies.add(copy.delete_id)
        await assert_copy_idle(db, copy, operation_id=operation.id, execution_leases=False)
    operation.details = {**operation.details, "replica_ids": [copy.id for copy in copies],
        "waiting_operation_ids": sorted(dependencies)}
    if body.kind == "delete_asset":
        asset.state, asset.delete_id = "deleting", operation.id
    for copy in copies:
        if copy.state == "deleting" and copy.delete_id != operation.id:
            continue
        copy.delete_id = operation.id
        copy.state = "deleting"
    operation.state, operation.stage = "pending", "deleting"
    await finish_deletion(db, operation)


async def process_cloud_deletions(db, operation):
    """Acknowledge cloud deletion only after the bucket confirms every file."""
    from storage.service import bucket_client, part_key
    for copy in await deletion_replicas(db, operation):
        storage = await db.get(PredictionStorage, copy.storage_id)
        if copy.state != "deleting" or copy.delete_id != operation.id or storage.kind == "predictor_local":
            continue
        try:
            await assert_copy_idle(db, copy, operation_id=operation.id)
        except HTTPException as error:
            operation.error = {"message": str(error.detail)}
            await db.commit()
            continue
        if storage.kind == "api_dataset":
            await db.execute(delete(DatasetObject).where(DatasetObject.dataset_id == copy.dataset_id,
                DatasetObject.revision == copy.revision))
            item = await db.get(DatasetRevision, (copy.dataset_id, copy.revision))
            item.payload = None
            copy.state, copy.checked_at = "deleted", utcnow()
            await db.flush()
            continue
        stored = await db.get(StorageObject, copy.object_id) if copy.object_id else None
        if stored:
            other = await db.scalar(select(Replica.id).where(Replica.object_id == stored.id,
                Replica.id != copy.id, Replica.state != "deleted").limit(1))
            reading = await db.scalar(select(OperationObject.operation_id).where(OperationObject.object_id == stored.id).limit(1))
            if reading:
                operation.state, operation.error = "interrupted", {"message": "A transfer still holds this backup. Retry deletion after it finishes."}
                await db.commit()
                continue
            if not other:
                await db.commit()
                def remove():
                    client = bucket_client()
                    for index in range(len(stored.manifest["chunks"])):
                        client.delete_object(Bucket=settings.s3_bucket, Key=part_key(stored, index))
                try:
                    await asyncio.to_thread(remove)
                except Exception:
                    operation.state, operation.error = "interrupted", {"message": "Backup file deletion could not be confirmed. Retry when object storage is available."}
                    await db.commit()
                    continue
                copy.object_id = None
                await db.flush()
                await db.delete(stored)
        copy.object_id, copy.state, copy.checked_at = None, "deleted", utcnow()
        await db.flush()
    await finish_deletion(db, operation)
    await db.commit()


async def finish_deletion(db, operation):
    await db.flush()
    copies = await deletion_replicas(db, operation)
    if any(copy.state != "deleted" for copy in copies):
        return
    if operation.kind == "delete_asset":
        asset = await owned(db, PredictionModel if operation.asset_kind == "model" else Dataset,
            operation.asset_id, operation.user_id, active=False)
        asset.state = "deleted"
        if operation.asset_kind == "dataset":
            await db.execute(delete(DatasetObject).where(DatasetObject.dataset_id == asset.id))
            await db.execute(update(DatasetRevision).where(DatasetRevision.dataset_id == asset.id).values(payload=None))
    operation.state, operation.stage, operation.completed_at = "completed", "completed", utcnow()
    operation.error, operation.updated_at = None, utcnow()
    if operation.kind == "delete_replica":
        parents = (await db.scalars(select(Operation).where(Operation.asset_id == operation.asset_id,
            Operation.user_id == operation.user_id, Operation.kind == "delete_asset",
            Operation.state != "completed"))).all()
        for parent in parents:
            await finish_deletion(db, parent)


async def create_operation(db, body, user_id):
    identity = str(body.request_id)
    await lock_identity(db, f"{user_id}/{identity}")
    previous = await db.get(Operation, identity)
    request_hash = digest(body.model_dump(mode="json"))
    if previous is not None:
        if previous.user_id != user_id or previous.request_hash != request_hash:
            raise HTTPException(409, "Operation ID was used with another request.")
        return await operation_response(db, previous)
    asset = await owned(db, PredictionModel if body.asset_kind == "model" else Dataset,
        body.asset_id, user_id, active=body.kind != "delete_asset")
    if body.kind == "delete_asset" and asset.delete_id:
        existing = await owned_operation(db, asset.delete_id, user_id)
        return await operation_response(db, existing)
    details = body.model_dump(mode="json", exclude={"request_id", "kind", "asset_kind", "asset_id", "revision"})
    operation = Operation(id=identity, user_id=user_id, request_id=identity, request_hash=request_hash,
        kind=body.kind, asset_kind=body.asset_kind, asset_id=asset.id, revision=body.revision,
        experiment_id=asset.experiment_id, state="pending", stage="pending", details=details,
        expires_at=utcnow() + timedelta(seconds=GRANT_SECONDS))
    if body.kind == "restore" and body.asset_kind == "dataset":
        revision = await db.get(DatasetRevision, (asset.id, body.revision)) if body.revision else None
        source = await selected_replica(db, body.source_replica_id, "dataset", asset.id, body.revision)
        source_storage = await db.get(PredictionStorage, source.storage_id)
        if revision is None or source_storage.kind != "object_backup" or not source.object_id:
            raise HTTPException(409, "Select the exact backed-up Dataset revision to restore.")
        if not body.target_storage_id or not body.target_launcher_id:
            raise HTTPException(422, "Restore requires a target storage and launcher.")
        await connected_storage(db, body.target_storage_id, body.target_launcher_id, user_id)
        details.update(dataset_id=asset.id, dataset_revision=revision.revision, dataset_fingerprint=revision.fingerprint,
            source_storage_id=source.storage_id, include_dataset=True,
            dataset_source={"kind": "object_backup", "replica_id": source.id, "storage_id": source.storage_id,
                "launcher_id": None, "dataset_id": asset.id, "revision": revision.revision, "fingerprint": revision.fingerprint})
        operation.details = details
    elif body.kind in {"backup", "restore"}:
        if body.asset_kind != "model" or body.revision is None:
            raise HTTPException(422, "Backups and restores start from an explicit model revision.")
        revision = await db.get(ModelRevision, (asset.id, body.revision))
        if revision is None or revision.state != "ready":
            raise HTTPException(409, "A completed model revision is required.")
        source = await selected_replica(db, body.source_replica_id, "model", asset.id, body.revision)
        source_storage = await db.get(PredictionStorage, source.storage_id)
        details.update(dataset_id=revision.dataset_id, dataset_revision=revision.dataset_revision,
            dataset_fingerprint=revision.dataset_fingerprint, model_artifact=revision.artifact,
            source_storage_id=source.storage_id)
        if body.kind == "backup":
            if source_storage.kind != "predictor_local":
                raise HTTPException(409, "This revision already has a backup. Select a local copy to verify and back up its files.")
            details["source_launcher_id"] = await access_launcher(db, source, body.source_launcher_id, user_id)
            target = await managed_storage(db, user_id, "object_backup")
            if body.target_storage_id and str(body.target_storage_id) != target.storage_id:
                raise HTTPException(422, "Only the configured object backup storage is supported.")
            details["target_storage_id"] = target.storage_id
        else:
            if source_storage.kind != "object_backup" or not source.object_id:
                raise HTTPException(409, "Select a verified object backup to restore.")
            if not body.target_storage_id or not body.target_launcher_id:
                raise HTTPException(422, "Restore requires a target storage and launcher.")
            await connected_storage(db, body.target_storage_id, body.target_launcher_id, user_id)
        if body.include_dataset:
            details["dataset_source"] = await dataset_source(db, revision, body, user_id)
            if body.kind == "restore" and details["dataset_source"]["kind"] != "object_backup":
                raise HTTPException(409, "Training data restore requires its backed-up Dataset archive.")
        operation.details = details
    elif body.kind == "verify":
        source = await selected_replica(db, body.replica_id or body.source_replica_id, body.asset_kind,
            asset.id, body.revision, readable=False)
        if source.state in {"deleting", "deleted"}:
            raise HTTPException(410, "Deleted copies must be explicitly restored before verification.")
        details.update(replica_ids=[source.id], target_storage_id=source.storage_id,
            target_launcher_id=await access_launcher(db, source, body.target_launcher_id, user_id))
        operation.revision, operation.details = source.revision, details
    if body.kind.startswith("delete_"):
        await begin_deletion(db, operation, asset, body)
    db.add(operation)
    await db.flush()
    await db.commit()
    if body.kind.startswith("delete_"):
        await process_cloud_deletions(db, operation)
    return await operation_response(db, operation)


async def operation_response(db, row):
    result = operation_view(row)
    if row.state not in TERMINAL:
        result["grant"] = await issue_grant(db, row)
        source = row.details.get("dataset_source") or {}
        if source.get("kind") == "api_dataset" and "dataset" not in row.details.get("archives", {}):
            from prediction.grants import create_grant
            previous = row.details.get("dataset_grant_id")
            if previous:
                await db.execute(delete(DatasetGrant).where(DatasetGrant.id == previous))
            result["dataset_grant"] = await create_grant(db, source["dataset_id"], source["revision"], row.user_id)
            row.details = {**row.details, "dataset_grant_id": result["dataset_grant"]["grant_id"]}
            await db.commit()
    return result


async def issue_grant(db, row, *, retry=False):
    if row.state in TERMINAL:
        raise HTTPException(409, "This operation is already complete or cancelled.")
    if row.kind == "prepare":
        model = await db.get(PredictionModel, row.asset_id)
        if model is None or model.direction != "forward":
            raise HTTPException(409, "Inverse Prediction preparation is retired. Existing files are retained.")
    if not settings.JWT_SECRET:
        raise HTTPException(503, "Prediction transfer signing is not configured.")
    if retry:
        row.state, row.stage, row.error = "pending", "pending", None
    now = int(time.time())
    renewal_deadline = row.details.get("grant_deadline")
    if retry or renewal_deadline is None:
        renewal_deadline = now + RENEWAL_SECONDS
        row.details = {**row.details, "grant_deadline": renewal_deadline}
    if renewal_deadline <= now:
        raise HTTPException(401, "Prediction transfer renewal window expired. Retry the operation with an authenticated request.")
    row.expires_at, row.updated_at = utcnow() + timedelta(seconds=min(GRANT_SECONDS, renewal_deadline - now)), utcnow()
    claims = {"typ": "prediction_operation", "sub": row.user_id, "operation": row.id,
        "generation": row.details.get("grant_generation", 0), "iat": now,
        "renewal_exp": renewal_deadline, "exp": min(now + GRANT_SECONDS, renewal_deadline)}
    token = jwt.encode(claims, settings.JWT_SECRET, algorithm=settings.JWT_ALG)
    base = f"{settings.public_api_base_url}/prediction/operations/{row.id}"
    await db.commit()
    return {"operation_id": row.id, "token": token, "expires_at": claims["exp"],
        "manifest_url": base + "/transfer", "prepare_url": base + "/archives/{slot}/uploads",
        "complete_url": base + "/archives/{slot}/complete", "register_url": base + "/complete",
        "refresh_url": base + "/grant/renew"}


async def granted_operation(db, identity, authorization, *, renew=False):
    token = authorization[7:] if authorization.startswith("Bearer ") else ""
    try:
        claims = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALG],
            options={"verify_exp": not renew, "require": ["typ", "sub", "operation", "generation", "iat", "exp", "renewal_exp"]})
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Prediction operation grant is invalid or expired.") from None
    if claims["typ"] != "prediction_operation" or claims["operation"] != str(identity):
        raise HTTPException(403, "Prediction operation grant does not cover this operation.")
    if (any(type(claims[key]) is not int for key in ("iat", "exp", "renewal_exp"))
            or claims["exp"] > claims["renewal_exp"] or claims["renewal_exp"] <= time.time()
            or (renew and claims["exp"] + RENEWAL_GRACE_SECONDS <= time.time())):
        raise HTTPException(401, "Prediction transfer renewal window expired.")
    row = await owned_operation(db, identity, claims["sub"])
    if row.state == "cancelled" or row.details.get("grant_generation", 0) != claims["generation"]:
        raise HTTPException(410, "Prediction operation was cancelled or its grant was replaced.")
    return row


async def transfer_manifest(db, row):
    details = row.details
    operation = {"id": row.id, "kind": row.kind, "asset_kind": row.asset_kind, "asset_id": row.asset_id,
        "model_id": row.asset_id if row.asset_kind == "model" else None, "model_revision": row.revision,
        "target_storage_id": details.get("target_storage_id"), "include_dataset": details.get("include_dataset", False),
        "source_storage_id": details.get("source_storage_id"),
        "dataset_source_storage_id": (details.get("dataset_source") or {}).get("storage_id"),
        "dataset_id": details.get("dataset_id"), "dataset_revision": details.get("dataset_revision"),
        "dataset_fingerprint": details.get("dataset_fingerprint")}
    result = {"operation": operation}
    for slot, replica_id in (("model", details.get("source_replica_id") if row.asset_kind == "model" else None),
            ("dataset", (details.get("dataset_source") or {}).get("replica_id"))):
        copy = await db.get(Replica, replica_id) if replica_id else None
        if copy and copy.object_id and copy.state == "present":
            stored = await db.get(StorageObject, copy.object_id)
            if stored:
                result[slot] = {**await download_parts(db, reference(stored)), "artifact": copy.artifact}
    if row.kind in {"verify", "delete_replica", "delete_asset"}:
        operation["replicas"] = []
        for copy in await deletion_replicas(db, row):
            if row.kind.startswith("delete_") and copy.delete_id != row.id:
                continue
            entry = {**replica_view(copy), "revision": copy.revision, "blocked": False}
            if row.kind.startswith("delete_"):
                try:
                    await assert_copy_idle(db, copy, operation_id=row.id)
                except HTTPException as error:
                    entry.update(blocked=True, error=str(error.detail))
            operation["replicas"].append(entry)
    return result


def validate_archive_artifact(row, slot, artifact):
    from prediction.schemas import ArtifactFile
    from pydantic import ValidationError
    try:
        checksum = artifact["manifest_sha256"]
        files = [ArtifactFile.model_validate(file).model_dump() for file in artifact["files"]]
        if len(checksum) != 64 or any(char not in "0123456789abcdef" for char in checksum) or not files:
            raise ValueError()
        if len({file["name"] for file in files}) != len(files) or artifact.get("format_version", 1) != 1:
            raise ValueError()
    except (KeyError, TypeError, ValueError, ValidationError):
        raise HTTPException(422, "Invalid checked archive artifact metadata.") from None
    if slot == "model":
        expected = row.details["model_artifact"]
        if checksum != expected["manifest_sha256"] or files != expected["files"]:
            raise HTTPException(409, "Backup model differs from its immutable revision.")
        return expected
    payload_sha = (row.details.get("dataset_source") or {}).get("payload_sha256")
    source_checksum = (row.details.get("dataset_source") or {}).get("manifest_sha256")
    if not payload_sha and source_checksum and checksum != source_checksum:
        raise HTTPException(409, "Backup Dataset differs from its selected immutable copy.")
    if payload_sha and not any(file["name"] == "dataset.json" and file["sha256"] == payload_sha for file in files):
        raise HTTPException(409, "Backup Dataset differs from its pinned server payload.")
    return {"manifest_sha256": checksum, "files": files, "format_version": 1,
        "fingerprint": row.details["dataset_fingerprint"]}


async def prepare_archive(db, row, slot, body):
    if row.kind != "backup" or row.state in TERMINAL or slot not in {"model", "dataset"}:
        raise HTTPException(409, "This operation is not accepting archive uploads.")
    if slot == "dataset" and not row.details.get("include_dataset"):
        raise HTTPException(403, "This operation does not include training data.")
    if body.manifest.get("encoding") != "base64":
        raise HTTPException(422, "Prediction archive uploads require binary object encoding.")
    artifact = validate_archive_artifact(row, slot, body.artifact)
    if body.dataset is not None:
        expected = {"dataset_id": row.details["dataset_id"], "revision": row.details["dataset_revision"],
            "fingerprint": row.details["dataset_fingerprint"]}
        if any(body.dataset.get(key) != value for key, value in expected.items()):
            raise HTTPException(409, "Backup Dataset identity differs from the requested revision.")
    existing = (row.details.get("archives") or {}).get(slot)
    if existing and existing["artifact"] != artifact:
        raise HTTPException(409, "This operation already prepared different archive content.")
    result = await prepare_upload(db, body.manifest, user_id=row.user_id, experiment_id=row.experiment_id,
        purpose="prediction_backup", request_id=f"{row.id}/{slot}")
    pin = await db.get(OperationObject, (row.id, slot))
    if pin and pin.object_id != result["reference"]["id"]:
        raise HTTPException(409, "This operation already prepared a different archive.")
    if pin is None:
        db.add(OperationObject(operation_id=row.id, slot=slot, object_id=result["reference"]["id"]))
    row.details = {**row.details, "archives": {**row.details.get("archives", {}),
        slot: {"object_id": result["reference"]["id"], "artifact": artifact}}}
    row.state, row.stage, row.updated_at = "running", "transferring", utcnow()
    if slot == "dataset" and row.details.get("dataset_grant_id"):
        await db.execute(delete(DatasetGrant).where(DatasetGrant.id == row.details["dataset_grant_id"]))
    await db.commit()
    return result


async def complete_archive(db, row, slot):
    if row.kind != "backup" or row.state == "cancelled":
        raise HTTPException(409, "This operation is not accepting archive completion.")
    pin = await db.get(OperationObject, (row.id, slot))
    if pin is None:
        archive = row.details.get("archives", {}).get(slot)
        if row.state == "completed" and archive:
            stored = await db.get(StorageObject, archive["object_id"])
            return {"ready": True, "reference": reference(stored)}
        raise HTTPException(404, "Prepared archive not found.")
    stored = await db.get(StorageObject, pin.object_id)
    # Release all DB locks before storage HEAD requests. Recheck cancellation and
    # object identity in a short transaction before publishing verification.
    await db.commit()
    result = await finish_upload(db, stored)
    await db.refresh(row, with_for_update=True)
    if row.state == "cancelled":
        await db.rollback()
        raise HTTPException(410, "Prediction operation was cancelled.")
    row.stage, row.updated_at = "verified", utcnow()
    await db.commit()
    return result


async def complete_operation(db, row, body):
    if row.state == "completed":
        return operation_view(row)
    if row.state == "cancelled":
        raise HTTPException(410, "Prediction operation was cancelled.")
    receipt = body.receipt or {}
    if isinstance(receipt.get("receipt"), dict):
        receipt = receipt["receipt"]
    if receipt.get("operationId", row.id) != row.id:
        raise HTTPException(409, "Receipt belongs to another operation.")
    if row.kind in {"delete_replica", "delete_asset"}:
        replica_id = str(body.replica_id or receipt.get("replica_id") or receipt.get("replicaId") or receipt.get("removedReplicaId") or "")
        if replica_id not in row.details.get("replica_ids", []):
            raise HTTPException(409, "Deletion acknowledgement targets another copy.")
        copy = await db.get(Replica, replica_id)
        if copy.delete_id != row.id:
            raise HTTPException(409, "Deletion acknowledgement belongs to another operation.")
        storage = await db.get(PredictionStorage, copy.storage_id)
        if storage.kind != "predictor_local":
            raise HTTPException(409, "Managed storage deletion must be confirmed by the API storage service.")
        await assert_copy_idle(db, copy, operation_id=row.id)
        copy.state, copy.object_id, copy.checked_at = "deleted", None, utcnow()
        await finish_deletion(db, row)
    elif row.kind == "verify":
        await owned(db, PredictionModel if row.asset_kind == "model" else Dataset, row.asset_id, row.user_id)
        copy = await db.get(Replica, row.details["replica_ids"][0])
        if copy.state in {"deleting", "deleted"}:
            raise HTTPException(410, "This copy was deleted while verification was running.")
        artifact = body.model if row.asset_kind == "model" else body.dataset
        artifact = artifact or receipt.get("artifact") or receipt
        checksum = artifact.get("manifest_sha256") or artifact.get("manifestChecksum")
        state = receipt.get("state", "present")
        if state not in {"present", "missing", "corrupt"}:
            raise HTTPException(422, "Invalid copy verification state.")
        if state == "present" and (not checksum or (copy.manifest_sha256 and checksum != copy.manifest_sha256)):
            raise HTTPException(409, "Verified copy differs from its registered manifest.")
        copy.state, copy.checked_at = state, utcnow()
        if state == "present":
            copy.verified_at, copy.manifest_sha256 = utcnow(), checksum
        row.state, row.stage, row.completed_at = "completed", "completed", utcnow()
    elif row.kind == "prepare":
        raise HTTPException(409, "Reconcile the saved model artifact through model completion before completing preparation.")
    else:
        await owned(db, PredictionModel if row.asset_kind == "model" else Dataset, row.asset_id, row.user_id)
        expected = (["dataset"] if row.asset_kind == "dataset" else
            (["model", "dataset"] if row.details.get("include_dataset") else ["model"]))
        results = {}
        for slot in expected:
            if slot == "dataset":
                await owned(db, Dataset, row.details["dataset_id"], row.user_id)
            if row.kind == "backup":
                entry = row.details.get("archives", {}).get(slot)
                if entry is None and slot == "dataset":
                    source = await db.get(Replica, (row.details.get("dataset_source") or {}).get("replica_id"))
                    if source is not None and source.object_id and source.state == "present":
                        entry = {"object_id": source.object_id, "artifact": source.artifact}
                stored = await db.get(StorageObject, entry["object_id"]) if entry else None
                if stored is None or not stored.ready or stored.deleting:
                    row.stage = "transferring"
                    await db.commit()
                    return operation_view(row)
                results[slot] = (entry["artifact"], stored.id)
            else:
                artifact = ((body.model if slot == "model" else body.dataset) or receipt.get(slot)
                    or (receipt.get("artifacts") or {}).get(slot))
                if artifact is None:
                    raise HTTPException(422, "Restoration requires every requested verified artifact receipt.")
                artifact = validate_archive_artifact(row, slot, artifact)
                source_id = row.details["source_replica_id"] if slot == "model" else row.details["dataset_source"]["replica_id"]
                source = await db.get(Replica, source_id)
                if source.manifest_sha256 != artifact["manifest_sha256"]:
                    raise HTTPException(409, "Restored archive differs from its selected backup.")
                results[slot] = (artifact, None)
        if row.kind == "restore":
            await connected_storage(db, row.details["target_storage_id"], row.details["target_launcher_id"], row.user_id)
        copies = {}
        for slot, (artifact, object_id) in results.items():
            identity = row.asset_id if slot == "model" else row.details["dataset_id"]
            revision = row.revision if slot == "model" else row.details["dataset_revision"]
            if row.kind == "restore" and slot == "dataset":
                artifact = {**artifact, "retained": True}
            copy = await put_replica(db, slot, identity, revision, row.details["target_storage_id"],
                artifact=artifact, object_id=object_id, recreate_deleted=True)
            copies[slot] = copy.id
        row.details = {**row.details, "result_replicas": copies}
        row.state, row.stage, row.completed_at = "completed", "completed", utcnow()
        await db.execute(delete(OperationObject).where(OperationObject.operation_id == row.id))
    row.error, row.updated_at = None, utcnow()
    await db.commit()
    return operation_view(row)


async def stop_operation(db, row, *, cancel=False, error=None):
    if row.state in TERMINAL:
        return operation_view(row)
    if cancel and row.kind in {"delete_replica", "delete_asset"}:
        raise HTTPException(409, "Deletion is already requested. Retry pending copy deletion instead of undoing its tombstone.")
    row.state = row.stage = "cancelled" if cancel else "interrupted"
    row.error = {"message": error or ("Transfer cancelled." if cancel else "Connection interrupted. Retry this operation.")}
    row.details = {**row.details, "grant_generation": row.details.get("grant_generation", 0) + 1}
    row.updated_at = utcnow()
    if cancel:
        row.completed_at = utcnow()
        await db.execute(delete(OperationObject).where(OperationObject.operation_id == row.id))
    if row.details.get("dataset_grant_id"):
        await db.execute(delete(DatasetGrant).where(DatasetGrant.id == row.details["dataset_grant_id"]))
    await db.commit()
    return operation_view(row)
