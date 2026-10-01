"""Saved models outlive execution instances and retain their training provenance."""
from uuid import uuid5
from fastapi import HTTPException
from sqlalchemy import func, select, update
from gpstation.db import Job
from gpstation.service.job_service import JOB_ACTIVE_STATES

from prediction.common import IDENTITY_NAMESPACE, connected_storage, digest, lock_identity, owned
from prediction.datasets import source_contracts
from prediction.db import Dataset, DatasetRevision, ModelLease, ModelRevision, PredictionModel


async def model_view(db, row):
    revisions = (await db.scalars(select(ModelRevision).where(ModelRevision.model_id == row.id)
        .order_by(ModelRevision.revision.desc()))).all()
    return {"id": row.id, "name": row.name, "experiment_id": row.experiment_id, "direction": row.direction,
        "algorithm": "knn", "state": row.state, "current_revision": row.current_revision,
        "storage_id": row.storage_id, "launcher_id": row.launcher_id, "delete_id": row.delete_id,
        "revisions": [{"revision": item.revision, "operation_id": item.request_id, "state": item.state,
            "dataset_id": item.dataset_id, "dataset_revision": item.dataset_revision,
            "dataset_fingerprint": item.dataset_fingerprint, "definition": item.definition,
            "source_contracts": item.source_contracts, "artifact": item.artifact,
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
        if (body.expected_revision != row.current_revision or row.direction != body.direction
                or row.storage_id != str(body.storage_id) or row.launcher_id != str(body.launcher_id)):
            raise HTTPException(409, "Model changed or targets another direction or storage. Reload before updating.")
    elif body.model_id:
        raise HTTPException(404, "Model not found.")
    await connected_storage(db, body.storage_id, body.launcher_id, user_id)
    dataset = await owned(db, Dataset, body.dataset_id, user_id)
    dataset_revision = await db.get(DatasetRevision, (dataset.id, body.dataset_revision))
    if (dataset_revision is None or dataset_revision.payload is None
            or dataset.current_revision != body.dataset_revision):
        raise HTTPException(409, "Only the current Dataset payload can prepare a new model.")
    if dataset.source_kind == "local" and (dataset.storage_id != str(body.storage_id) or dataset.launcher_id != str(body.launcher_id)):
        raise HTTPException(409, "Local Dataset and Model must use the same registered storage.")
    definition = body.definition
    algorithm = definition.get("algorithm", {})
    if (not isinstance(algorithm, dict) or algorithm.get("kind") != "knn"
            or definition.get("direction", body.direction) != body.direction):
        raise HTTPException(422, "Model definition must identify kNN and its requested direction.")
    if definition.get("snapshotFingerprint", dataset_revision.fingerprint) != dataset_revision.fingerprint:
        raise HTTPException(409, "Model definition targets another Dataset fingerprint.")
    if row is None:
        row = PredictionModel(id=identity, user_id=user_id, experiment_id=dataset.experiment_id,
            name=body.name.strip(), direction=body.direction, state="active", current_revision=0,
            storage_id=str(body.storage_id), launcher_id=str(body.launcher_id))
        db.add(row)
        await db.flush()
    elif row.experiment_id != dataset.experiment_id:
        raise HTTPException(409, "Model cannot move to another Experiment.")
    number = (await db.scalar(select(func.max(ModelRevision.revision)).where(ModelRevision.model_id == identity)) or 0) + 1
    await db.execute(update(ModelRevision).where(ModelRevision.model_id == identity,
        ModelRevision.state == "reserved").values(state="abandoned"))
    contracts = (dataset_revision.payload["sourceContracts"] if dataset.source_kind == "local"
        else source_contracts(dataset_revision.payload))
    db.add(ModelRevision(model_id=identity, revision=number, request_id=str(body.request_id),
        request_hash=request_hash, state="reserved", dataset_id=dataset.id, dataset_revision=body.dataset_revision,
        dataset_fingerprint=dataset_revision.fingerprint, definition=definition, source_contracts=contracts))
    row.name = body.name.strip()
    await db.commit()
    return {**await model_view(db, row), "reserved_revision": number, "operation_id": str(body.request_id)}


async def complete_model(db, model_id, revision, body, user_id):
    row = await owned(db, PredictionModel, model_id, user_id)
    item = await db.get(ModelRevision, (row.id, revision))
    if item is None or item.request_id != str(body.request_id):
        raise HTTPException(404, "Reserved model revision not found.")
    artifact = body.model_dump(mode="json", exclude={"request_id"})
    if len({entry["name"] for entry in artifact["files"]}) != len(artifact["files"]):
        raise HTTPException(422, "Artifact file names must be unique.")
    if item.state == "ready":
        if item.artifact != artifact:
            raise HTTPException(409, "Saved model revision is immutable.")
        return await model_view(db, row)
    if item.state != "reserved":
        raise HTTPException(410, "Model preparation was superseded by a newer request.")
    await connected_storage(db, row.storage_id, row.launcher_id, user_id)
    item.artifact, item.state = artifact, "ready"
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
            or job.launcher_id != row.launcher_id or job.state not in JOB_ACTIVE_STATES
            or job.cancel_requested_at is not None or revision is None or revision.state not in {"reserved", "ready"}):
        raise HTTPException(409, "Model use requires its live Predictor execution and a usable revision.")
    if lease is None:
        db.add(ModelLease(model_id=row.id, revision=body.revision, job_id=str(body.job_id)))
    await db.commit()
    return {"leased": True}
