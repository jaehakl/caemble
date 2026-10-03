"""Saved models outlive execution instances and retain their training provenance."""
from uuid import uuid5
from copy import deepcopy
from datetime import timedelta
from fastapi import HTTPException
from sqlalchemy import func, select, update
from gpstation.db import Job
from gpstation.service.job_service import JOB_ACTIVE_STATES
from gpstation.service.state import utcnow

from prediction.common import IDENTITY_NAMESPACE, connected_storage, digest, lock_identity, owned
from prediction.datasets import dataset_change_set, source_contracts
from prediction.db import Dataset, DatasetRevision, ModelLease, ModelRevision, PredictionModel, Replica, Operation


async def model_view(db, row):
    from prediction.replicas import revision_replicas
    from prediction_contracts import validate_definition
    revisions = (await db.scalars(select(ModelRevision).where(ModelRevision.model_id == row.id)
        .order_by(ModelRevision.revision.desc()))).all()
    current = next((item for item in revisions if item.revision == row.current_revision), revisions[0] if revisions else None)
    definition = current.definition if current is not None else {}
    algorithm = definition.get("algorithm")
    support_by_revision = {}
    for revision in revisions:
        support = "retired" if row.direction != "forward" else "supported"
        if support == "supported":
            try:
                validate_definition(revision.definition)
            except ValueError:
                support = "unsupported"
        support_by_revision[revision.revision] = support
    return {"id": row.id, "name": row.name, "experiment_id": row.experiment_id, "direction": row.direction,
        "origin_optimization_id": (current.preparation.get("online_origin") or {}).get("optimization_id") if current else None,
        "algorithm": algorithm.get("kind", "unknown") if isinstance(algorithm, dict) else "unknown",
        "support_status": support_by_revision.get(current.revision, "unsupported") if current else "unsupported",
        "state": row.state, "current_revision": row.current_revision,
        "delete_id": row.delete_id,
        "revisions": [{"revision": item.revision, "operation_id": item.request_id, "state": item.state,
            "support_status": support_by_revision[item.revision],
            "dataset_id": item.dataset_id, "dataset_revision": item.dataset_revision,
            "dataset_fingerprint": item.dataset_fingerprint, "definition": item.definition,
            "source_contracts": item.source_contracts, "artifact": item.artifact,
            "training_update": item.preparation.get("training_update"),
            "online_origin": item.preparation.get("online_origin"),
            "version_name": item.preparation.get("version_name"),
            "origin_optimization_id": (item.preparation.get("online_origin") or {}).get("optimization_id"),
            "replicas": await revision_replicas(db, "model", row.id, item.revision),
            "created_at": item.created_at} for item in revisions]}


async def list_models(db, user_id, experiment_id=None):
    query = select(PredictionModel).where(PredictionModel.user_id == user_id, PredictionModel.state != "deleted")
    if experiment_id is not None:
        query = query.where(PredictionModel.experiment_id == experiment_id)
    rows = (await db.scalars(query.order_by(PredictionModel.created_at.desc()))).all()
    return {"items": [await model_view(db, row) for row in rows]}


async def validate_update_references(db, update, definition, model_id, target_ref, user_id, storage_id, launcher_id):
    from prediction_contracts import validate_quality_update, validate_training_update
    try:
        mode = validate_training_update(update, definition)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    if update["targetSnapshot"] != target_ref:
        raise HTTPException(409, "Model update targets another frozen Dataset snapshot.")
    base = update.get("baseModel")
    if base is None:
        raise HTTPException(422, "A model update requires its completed base model.")
    if base["modelId"] != str(model_id):
        raise HTTPException(409, "A model update must publish a new revision of its base model.")
    await owned(db, PredictionModel, base["modelId"], user_id)
    baseline = await db.get(ModelRevision, (base["modelId"], base["revision"]))
    replica = await db.get(Replica, base["replicaId"])
    if (baseline is None or baseline.state != "ready" or baseline.artifact is None
            or baseline.artifact.get("manifest_sha256") != base["checksum"]
            or replica is None or replica.model_id != base["modelId"] or replica.revision != base["revision"]
            or replica.storage_id != base["storageId"] or replica.manifest_sha256 != base["checksum"]
            or replica.state not in {"present", "unverified"}):
        raise HTTPException(409, "The exact base model copy is unavailable or changed.")
    if base["storageId"] != str(storage_id):
        raise HTTPException(409, "Restore the base model to the training storage before updating it.")
    await connected_storage(db, base["storageId"], launcher_id, user_id)
    base_ref = {"datasetId": baseline.dataset_id, "revision": baseline.dataset_revision,
        "fingerprint": baseline.dataset_fingerprint}
    expected_changes = await dataset_change_set(db, base_ref, target_ref, user_id)
    if update["changeSet"] != expected_changes:
        raise HTTPException(409, "Model update changes differ from the frozen snapshot inventory.")
    target = await db.get(DatasetRevision, (target_ref["datasetId"], target_ref["revision"]))
    if ((mode != "rebuild" or definition.get("qualityValidation") is not None
            or baseline.definition.get("qualityValidation") is not None)
            and target.summary.get("source_contracts") != baseline.source_contracts):
        raise HTTPException(409, "Continued training requires unchanged source and preprocessing contracts.")
    try:
        validate_quality_update(update, definition, baseline.definition, baseline.artifact.get("quality_report"))
    except ValueError as error:
        raise HTTPException(409, str(error)) from error


async def reserve_model(db, body, user_id, *, commit=True, online_origin=None, force_api_source=False):
    from gpstation.service.batches import serialize_events
    from prediction_contracts import validate_new_training
    from prediction import training
    await serialize_events(db)
    if body.direction != "forward":
        raise HTTPException(422, "Inverse Prediction is retired. Use Optimization for Inverse Design.")
    identity = str(body.model_id) if body.model_id else str(uuid5(IDENTITY_NAMESPACE, f"{user_id}/model/{body.request_id}"))
    await lock_identity(db, identity)
    row = await db.get(PredictionModel, identity)
    request_payload = body.model_dump(mode="json")
    if body.dataset_source == "auto":
        request_payload.pop("dataset_source")  # Preserve receipts from before explicit API-source selection.
    request_hash = digest(request_payload)
    if row is not None:
        row = await owned(db, PredictionModel, identity, user_id)
        if row.direction != "forward":
            raise HTTPException(409, "Inverse Prediction models are retained for management only.")
        previous = await db.scalar(select(ModelRevision).where(
            ModelRevision.model_id == identity, ModelRevision.request_id == str(body.request_id)))
        if previous is not None:
            if previous.request_hash != request_hash:
                raise HTTPException(409, "Model operation ID was used with another definition.")
            operation = await db.get(Operation, previous.request_id)
            view = await training.operation_view(db, operation) if operation is not None else {}
            return {**await model_view(db, row), "reserved_revision": previous.revision, "operation_id": previous.request_id,
                **({"training": view["training"]} if "training" in view else {})}
        if body.expected_revision != row.current_revision or row.direction != body.direction:
            raise HTTPException(409, "Model changed or targets another direction. Reload before updating.")
        if row.current_revision and body.training_update is None and body.definition.get("qualityValidation") is not None:
            raise HTTPException(409, "Create a new model for a fresh quality lineage, or update the exact completed base model.")
        await training.assert_model_update_available(db, identity, user_id, online_origin=online_origin)
    elif body.model_id:
        raise HTTPException(404, "Model not found.")
    from optimization.guards import require_training_continuation
    await require_training_continuation(db, online_origin)
    await connected_storage(db, body.storage_id, body.launcher_id, user_id)
    dataset = await owned(db, Dataset, body.dataset_id, user_id)
    dataset_revision = await db.get(DatasetRevision, (dataset.id, body.dataset_revision))
    local_copy = await db.scalar(select(Replica).where(Replica.dataset_id == dataset.id,
        Replica.revision == body.dataset_revision, Replica.storage_id == str(body.storage_id),
        Replica.state.in_(["present", "unverified"])))
    server_payload = dataset_revision is not None and dataset.source_kind == "server" and dataset_revision.payload is not None
    if force_api_source or body.dataset_source == "api":
        if not server_payload:
            raise HTTPException(409, "API-source training requires the exact retained server Dataset snapshot.")
        local_copy = None
    if dataset_revision is None or (not server_payload and local_copy is None):
        raise HTTPException(409, "Restore the exact Dataset revision to the selected storage before preparing a model.")
    definition = body.definition
    try:
        validate_new_training(definition, body.training_update)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    if definition.get("direction", body.direction) != body.direction:
        raise HTTPException(422, "Model definition must identify its requested direction.")
    if definition.get("snapshotFingerprint", dataset_revision.fingerprint) != dataset_revision.fingerprint:
        raise HTTPException(409, "Model definition targets another Dataset fingerprint.")
    training_update = deepcopy(body.training_update)
    if training_update is not None:
        await validate_update_references(db, training_update, definition, identity,
            {"datasetId": dataset.id, "revision": body.dataset_revision, "fingerprint": dataset_revision.fingerprint},
            user_id, str(body.storage_id), str(body.launcher_id))
    if row is None:
        row = PredictionModel(id=identity, user_id=user_id, experiment_id=dataset.experiment_id,
            name=body.name.strip(), direction=body.direction, state="active", current_revision=0)
        db.add(row)
        await db.flush()
    elif row.experiment_id != dataset.experiment_id:
        raise HTTPException(409, "Model cannot move to another Experiment.")
    number = (await db.scalar(select(func.max(ModelRevision.revision)).where(ModelRevision.model_id == identity)) or 0) + 1
    version_name = f"{row.name} · r{number} · {online_origin['optimization_name']}" if online_origin else body.name.strip()
    previous_operations = list((await db.scalars(select(Operation).where(Operation.asset_id == identity,
        Operation.kind == "prepare", Operation.state.not_in(["completed", "cancelled"])))).all())
    previous_operations = [operation for operation in previous_operations
        if (operation.details.get("online_origin") or {}).get("optimization_id")
        == (online_origin or {}).get("optimization_id")]
    if previous_operations:
        await db.execute(update(ModelRevision).where(ModelRevision.model_id == identity,
            ModelRevision.state == "reserved", ModelRevision.request_id.in_([operation.id for operation in previous_operations]))
            .values(state="abandoned"))
    for previous_operation in previous_operations:
        await training.cancel(db, previous_operation)
        previous_operation.stage = "superseded"
    contracts = dataset_revision.summary.get("source_contracts")
    if contracts is None:
        contracts = source_contracts(dataset_revision.payload)
    revision = ModelRevision(model_id=identity, revision=number, request_id=str(body.request_id),
        request_hash=request_hash, state="reserved", dataset_id=dataset.id, dataset_revision=body.dataset_revision,
        dataset_fingerprint=dataset_revision.fingerprint, definition=definition, source_contracts=contracts,
        preparation={"storage_id": str(body.storage_id), "launcher_id": str(body.launcher_id),
            "version_name": version_name,
            **({"training_update": training_update} if training_update is not None else {}),
            **({"online_origin": deepcopy(online_origin)} if online_origin is not None else {})})
    db.add(revision)
    operation = Operation(id=str(body.request_id), request_id=str(body.request_id), request_hash=request_hash,
        user_id=user_id, kind="prepare", asset_kind="model", asset_id=identity, revision=number,
        experiment_id=dataset.experiment_id, state="pending", stage="preparing",
        expires_at=utcnow() + timedelta(minutes=15),
        details={"target_storage_id": str(body.storage_id), "target_launcher_id": str(body.launcher_id),
            "dataset_id": dataset.id, "dataset_revision": body.dataset_revision, "definition": definition,
            "direction": body.direction, "name": version_name,
            **({"update": training_update} if training_update is not None else {}),
            **({"online_origin": deepcopy(online_origin)} if online_origin is not None else {})})
    db.add(operation)
    await db.flush()
    await training.create_run(db, operation, revision, local_copy)
    if online_origin is None:
        row.name = body.name.strip()
    if commit:
        await db.commit()
        for previous_operation in previous_operations:
            await training.notify_cancel(db, previous_operation)
    else:
        await db.flush()
    return {**await model_view(db, row), "reserved_revision": number, "operation_id": str(body.request_id),
        "training": (await training.operation_view(db, operation))["training"]}


async def complete_model(db, model_id, revision, body, user_id, *, commit=True, publish=True):
    row = await owned(db, PredictionModel, model_id, user_id)
    item = await db.get(ModelRevision, (row.id, revision))
    if item is None or item.request_id != str(body.request_id):
        raise HTTPException(404, "Reserved model revision not found.")
    artifact = body.model_dump(mode="json", exclude={"request_id", "verified"}, exclude_none=True)
    if len({entry["name"] for entry in artifact["files"]}) != len(artifact["files"]):
        raise HTTPException(422, "Artifact file names must be unique.")
    if item.state == "ready":
        # Attempt timing can change when a lost completion is recovered. Keep the
        # first successful execution report; model bytes and training evidence stay immutable.
        if ({key: value for key, value in item.artifact.items() if key != "execution_metrics"}
                != {key: value for key, value in artifact.items() if key != "execution_metrics"}):
            raise HTTPException(409, "Saved model revision is immutable.")
        return await model_view(db, row)
    if not publish:
        raise HTTPException(410, "Model revisions are published only by their server-owned training job.")
    if row.direction != "forward":
        raise HTTPException(409, "Inverse Prediction preparation is retired. Existing saved files are retained.")
    if item.state != "reserved":
        raise HTTPException(410, "Model preparation was superseded by a newer request.")
    from prediction_contracts import validate_quality_lineage, validate_quality_report
    try:
        validate_quality_report(body.quality_report, item.definition, {
            "datasetId": item.dataset_id, "revision": item.dataset_revision, "fingerprint": item.dataset_fingerprint})
        frozen_update = item.preparation.get("training_update")
        parent = None
        if frozen_update is not None:
            base = frozen_update["baseModel"]
            parent = await db.get(ModelRevision, (base["modelId"], base["revision"]))
            if (parent is None or parent.state != "ready" or not parent.artifact
                    or parent.artifact.get("manifest_sha256") != base["checksum"]):
                raise ValueError("The immutable base model is unavailable for lineage validation.")
        validate_quality_lineage(body.quality_report, item.definition, update=frozen_update,
            base_definition=parent.definition if parent else None,
            base_report=parent.artifact.get("quality_report") if parent else None)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
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
    row.current_revision = max(row.current_revision, revision)
    if commit:
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
    if row.direction != "forward":
        raise HTTPException(409, "Inverse Prediction is retired. This model is available for management only.")
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
