"""Saved models outlive execution instances and retain their training provenance."""
from uuid import uuid5
from datetime import timedelta
from fastapi import HTTPException
from sqlalchemy import func, select, update
from gpstation.db import Job
from gpstation.service.job_service import JOB_ACTIVE_STATES
from gpstation.service.state import utcnow

from prediction.common import IDENTITY_NAMESPACE, connected_storage, digest, lock_identity, owned
from prediction.datasets import source_contracts
from prediction.db import Dataset, DatasetRevision, ModelLease, ModelRevision, PredictionModel, Replica, Operation


async def model_view(db, row):
    from prediction.replicas import revision_replicas
    revisions = (await db.scalars(select(ModelRevision).where(ModelRevision.model_id == row.id)
        .order_by(ModelRevision.revision.desc()))).all()
    return {"id": row.id, "name": row.name, "experiment_id": row.experiment_id, "direction": row.direction,
        "algorithm": "knn", "state": row.state, "current_revision": row.current_revision,
        "delete_id": row.delete_id,
        "revisions": [{"revision": item.revision, "operation_id": item.request_id, "state": item.state,
            "dataset_id": item.dataset_id, "dataset_revision": item.dataset_revision,
            "dataset_fingerprint": item.dataset_fingerprint, "definition": item.definition,
            "source_contracts": item.source_contracts, "artifact": item.artifact,
            "replicas": await revision_replicas(db, "model", row.id, item.revision),
            "created_at": item.created_at} for item in revisions]}


async def list_models(db, user_id, experiment_id=None):
    query = select(PredictionModel).where(PredictionModel.user_id == user_id, PredictionModel.state != "deleted")
    if experiment_id is not None:
        query = query.where(PredictionModel.experiment_id == experiment_id)
    rows = (await db.scalars(query.order_by(PredictionModel.created_at.desc()))).all()
    return {"items": [await model_view(db, row) for row in rows]}


async def reserve_model(db, body, user_id):
    identity = str(body.model_id) if body.model_id else str(uuid5(IDENTITY_NAMESPACE, f"{user_id}/model/{body.request_id}"))
    await lock_identity(db, identity)
    row = await db.get(PredictionModel, identity)
    request_hash = digest(body.model_dump(mode="json"))
    if row is not None:
        row = await owned(db, PredictionModel, identity, user_id)
        previous = await db.scalar(select(ModelRevision).where(
            ModelRevision.model_id == identity, ModelRevision.request_id == str(body.request_id)))
        if previous is not None:
            if previous.request_hash != request_hash:
                raise HTTPException(409, "Model operation ID was used with another definition.")
            return {**await model_view(db, row), "reserved_revision": previous.revision, "operation_id": previous.request_id}
        if body.expected_revision != row.current_revision or row.direction != body.direction:
            raise HTTPException(409, "Model changed or targets another direction. Reload before updating.")
    elif body.model_id:
        raise HTTPException(404, "Model not found.")
    await connected_storage(db, body.storage_id, body.launcher_id, user_id)
    dataset = await owned(db, Dataset, body.dataset_id, user_id)
    dataset_revision = await db.get(DatasetRevision, (dataset.id, body.dataset_revision))
    local_copy = await db.scalar(select(Replica).where(Replica.dataset_id == dataset.id,
        Replica.revision == body.dataset_revision, Replica.storage_id == str(body.storage_id),
        Replica.state.in_(["present", "unverified"])))
    server_payload = dataset_revision is not None and dataset.source_kind == "server" and dataset_revision.payload is not None
    if dataset_revision is None or (not server_payload and local_copy is None):
        raise HTTPException(409, "Restore the exact Dataset revision to the selected storage before preparing a model.")
    definition = body.definition
    algorithm = definition.get("algorithm", {})
    if (not isinstance(algorithm, dict) or algorithm.get("kind") != "knn"
            or definition.get("direction", body.direction) != body.direction):
        raise HTTPException(422, "Model definition must identify kNN and its requested direction.")
    if definition.get("snapshotFingerprint", dataset_revision.fingerprint) != dataset_revision.fingerprint:
        raise HTTPException(409, "Model definition targets another Dataset fingerprint.")
    if row is None:
        row = PredictionModel(id=identity, user_id=user_id, experiment_id=dataset.experiment_id,
            name=body.name.strip(), direction=body.direction, state="active", current_revision=0)
        db.add(row)
        await db.flush()
    elif row.experiment_id != dataset.experiment_id:
        raise HTTPException(409, "Model cannot move to another Experiment.")
    number = (await db.scalar(select(func.max(ModelRevision.revision)).where(ModelRevision.model_id == identity)) or 0) + 1
    await db.execute(update(ModelRevision).where(ModelRevision.model_id == identity,
        ModelRevision.state == "reserved").values(state="abandoned"))
    await db.execute(update(Operation).where(Operation.asset_id == identity, Operation.kind == "prepare",
        Operation.state.in_(["pending", "running", "interrupted"])).values(state="cancelled", stage="superseded",
            error={"message": "A newer model preparation superseded this request."}, completed_at=utcnow()))
    contracts = dataset_revision.summary.get("source_contracts")
    if contracts is None:
        contracts = source_contracts(dataset_revision.payload)
    db.add(ModelRevision(model_id=identity, revision=number, request_id=str(body.request_id),
        request_hash=request_hash, state="reserved", dataset_id=dataset.id, dataset_revision=body.dataset_revision,
        dataset_fingerprint=dataset_revision.fingerprint, definition=definition, source_contracts=contracts,
        preparation={"storage_id": str(body.storage_id), "launcher_id": str(body.launcher_id)}))
    db.add(Operation(id=str(body.request_id), request_id=str(body.request_id), request_hash=request_hash,
        user_id=user_id, kind="prepare", asset_kind="model", asset_id=identity, revision=number,
        experiment_id=dataset.experiment_id, state="pending", stage="preparing",
        expires_at=utcnow() + timedelta(minutes=15),
        details={"target_storage_id": str(body.storage_id), "target_launcher_id": str(body.launcher_id),
            "dataset_id": dataset.id, "dataset_revision": body.dataset_revision, "definition": definition,
            "direction": body.direction, "name": body.name.strip()}))
    row.name = body.name.strip()
    await db.commit()
    return {**await model_view(db, row), "reserved_revision": number, "operation_id": str(body.request_id)}


async def complete_model(db, model_id, revision, body, user_id):
    row = await owned(db, PredictionModel, model_id, user_id)
    item = await db.get(ModelRevision, (row.id, revision))
    if item is None or item.request_id != str(body.request_id):
        raise HTTPException(404, "Reserved model revision not found.")
    artifact = body.model_dump(mode="json", exclude={"request_id", "verified"})
    if len({entry["name"] for entry in artifact["files"]}) != len(artifact["files"]):
        raise HTTPException(422, "Artifact file names must be unique.")
    if item.state == "ready":
        if item.artifact != artifact:
            raise HTTPException(409, "Saved model revision is immutable.")
        return await model_view(db, row)
    if item.state != "reserved":
        raise HTTPException(410, "Model preparation was superseded by a newer request.")
    operation = await db.get(Operation, item.request_id)
    if operation is not None and operation.state == "cancelled":
        raise HTTPException(410, "Model preparation was cancelled.")
    await connected_storage(db, item.preparation["storage_id"], item.preparation["launcher_id"], user_id)
    item.artifact, item.state = artifact, "ready"
    from prediction.replicas import put_replica
    replica = await put_replica(db, "model", row.id, revision, item.preparation["storage_id"],
        artifact=artifact, state="present" if body.verified else "unverified")
    if operation is not None:
        operation.state = operation.stage = "completed"
        operation.completed_at = operation.updated_at = utcnow()
        operation.details = {**operation.details, "result_replicas": {"model": replica.id}}
    row.current_revision = revision
    await db.commit()
    return await model_view(db, row)


async def lease_model(db, model_id, body, user_id, *, release=False):
    row = await owned(db, PredictionModel, model_id, user_id, active=not release)
    key = (row.id, body.revision, str(body.job_id))
    lease = await db.get(ModelLease, key)
    if release:
        if lease is not None:
            await db.delete(lease)
            await db.commit()
        return {"released": True}
    job = await db.get(Job, str(body.job_id))
    revision = await db.get(ModelRevision, (row.id, body.revision))
    if (job is None or job.user_id != user_id or job.slave_app_id != "predictor" or job.job_mode != "webrtc"
            or job.state not in JOB_ACTIVE_STATES
            or job.cancel_requested_at is not None or revision is None or revision.state not in {"reserved", "ready"}):
        raise HTTPException(409, "Model use requires its live Predictor execution and a usable revision.")
    replica = await db.get(Replica, str(body.replica_id)) if body.replica_id else None
    if body.replica_id and replica is None:
        raise HTTPException(404, "Selected model copy not found.")
    storage_id = str(body.storage_id) if body.storage_id else None
    if replica is None and revision.state == "ready":
        copies = (await db.scalars(select(Replica).where(Replica.model_id == row.id,
            Replica.revision == body.revision, Replica.state.in_(["present", "unverified"]),
            *([Replica.storage_id == storage_id] if storage_id else [])))).all()
        from prediction.db import StorageAccess
        candidates = [copy for copy in copies if await db.get(StorageAccess, (copy.storage_id, job.launcher_id))]
        if len(candidates) == 1:
            replica = candidates[0]
    if replica is not None:
        if (replica.model_id != row.id or replica.revision != body.revision
                or replica.state not in {"present", "unverified"} or (storage_id and storage_id != replica.storage_id)):
            raise HTTPException(409, "Model lease targets another or unavailable copy.")
        storage_id = replica.storage_id
    elif revision.state == "reserved":
        storage_id = storage_id or revision.preparation.get("storage_id")
        if storage_id != revision.preparation.get("storage_id"):
            raise HTTPException(409, "Preparation lease targets another storage.")
    else:
        raise HTTPException(409, "Select an available model copy before using it.")
    await connected_storage(db, storage_id, job.launcher_id, user_id)
    if lease is None:
        db.add(ModelLease(model_id=row.id, revision=body.revision, job_id=str(body.job_id),
            storage_id=storage_id, replica_id=replica.id if replica else None))
    elif lease.storage_id != storage_id or (lease.replica_id is not None and replica is not None and lease.replica_id != replica.id):
        raise HTTPException(409, "Release the existing model lease before switching its storage copy.")
    elif replica is not None and lease.replica_id is None:
        # Preparation leases acquire the newly registered copy on their same disk.
        lease.replica_id = replica.id
    await db.commit()
    return {"leased": True}
