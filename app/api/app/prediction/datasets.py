"""Freeze native server data without hydrating tensors in the browser."""
from copy import deepcopy
from uuid import uuid5

from fastapi import HTTPException
from sqlalchemy import delete, func, select, update

from prediction.common import IDENTITY_NAMESPACE, connected_storage, digest, lock_identity, owned, require_dataset_idle
from prediction.db import Dataset, DatasetObject, DatasetRequest, DatasetRevision, Replica
from simulation.db import Experiment, ExperimentRecord, Measurement, RecordedData
from storage.service import object_refs, reference
from storage.db import StorageObject


def content_identity(value):
    """Storage relocation never changes the identity of the contained bytes."""
    if isinstance(value, dict):
        if value.get("kind") == "caemble.object":
            return {key: content_identity(member) for key, member in value.items() if key != "id"}
        return {key: content_identity(member) for key, member in value.items()}
    if isinstance(value, list):
        return [content_identity(member) for member in value]
    return value


async def source_experiment(db, experiment_id, source_hash, user_id):
    experiment = await db.scalar(select(Experiment).where(
        Experiment.id == experiment_id, Experiment.user_id == user_id).with_for_update(read=True))
    if experiment is None:
        raise HTTPException(404, "Owned source Experiment not found.")
    if experiment.source_hash != source_hash:
        raise HTTPException(409, "Experiment source changed. Reload it before freezing training data.")
    return experiment


async def capture(db, selection, user_id):
    experiment = await source_experiment(db, selection.experiment_id, selection.source_hash, user_id)
    if experiment.result_contracts is not None and experiment.result_contracts != selection.result_contracts:
        raise HTTPException(409, "Prediction result contracts differ from the saved Experiment.")
    records = list((await db.scalars(select(ExperimentRecord).where(
        ExperimentRecord.experiment_id == experiment.id, ExperimentRecord.id.in_(selection.record_ids)
    ).order_by(ExperimentRecord.id).with_for_update(read=True))).all())
    if {row.id for row in records} != set(selection.record_ids):
        raise HTTPException(422, "Selected Records do not belong to this Experiment.")
    measurements = list((await db.scalars(select(Measurement).where(
        Measurement.experiment_id == experiment.id, Measurement.user_id == user_id,
        Measurement.recorded_at.is_not(None)
    ).order_by(Measurement.id).with_for_update(read=True))).all())
    measurement_ids = [row.id for row in measurements]
    recorded = list((await db.scalars(select(RecordedData).where(
        RecordedData.measurement_id.in_(measurement_ids), RecordedData.experiment_record_id.in_(selection.record_ids),
        RecordedData.user_id == user_id
    ).order_by(RecordedData.measurement_id, RecordedData.experiment_record_id).with_for_update(read=True))).all())
    record_map = {row.id: row for row in records}
    if any(row.data is None for row in recorded):
        raise HTTPException(422, "Prediction requires native RecordedData, not external data URLs.")
    payload = {
        "kind": "caemble.prediction.dataset", "version": 1, "experimentId": experiment.id,
        "sourceHash": experiment.source_hash, "representationVersion": "prediction-raw-input-v1",
        "varsSchema": selection.vars_schema, "rules": selection.rules, "resultContracts": selection.result_contracts,
        "measurements": [{"id": row.id, "experiment_id": row.experiment_id, "vars": row.vars} for row in measurements],
        "records": [{"id": row.id, "experiment_id": row.experiment_id, "name": row.name,
            "quantity_kind": row.quantity_kind, "tensor_order": row.tensor_order, "dtype": row.dtype,
            "data_schema": row.data_schema, "contract_hash": row.contract_hash} for row in records],
        "recorded": [{"id": row.id, "measurement_id": row.measurement_id,
            "experiment_record_id": row.experiment_record_id, "data": row.data,
            "name": record_map[row.experiment_record_id].name,
            "dtype": record_map[row.experiment_record_id].dtype,
            "quantity_kind": record_map[row.experiment_record_id].quantity_kind,
            "tensor_order": record_map[row.experiment_record_id].tensor_order,
            "data_schema": record_map[row.experiment_record_id].data_schema} for row in recorded],
        "calculations": [], "calculationData": [],
    }
    # Check every dependency before publishing. Retention pins are committed in the
    # same transaction, so source deletion cannot race the object cleanup sweep.
    for ref in sorted({ref["id"]: ref for ref in object_refs(payload)}.values(), key=lambda value: value["id"]):
        stored = await db.scalar(select(StorageObject).where(StorageObject.id == ref["id"]).with_for_update())
        if (stored is None or stored.user_id != user_id or not stored.ready or stored.deleting
                or stored.experiment_id != experiment.id or reference(stored) != ref):
            raise HTTPException(409, "A Dataset source object is missing, changed, or being removed.")
    return deepcopy(payload)


def source_contracts(payload):
    contracts = deepcopy({key: payload[key] for key in ("experimentId", "sourceHash", "varsSchema", "records", "rules", "resultContracts")})
    contracts["calculations"] = []
    for source in payload.get("calculations", []):
        calculation = {key: source[key] for key in ("id", "name", "source_hash", "source_revision", "revision", "contract_status", "experiment_record_ids")}
        layout = source.get("output_layout")
        if layout:
            calculation["output_layout"] = {"dtype": layout["dtype"], "shape": layout["shape"], "axes": [
                {"name": axis["name"], "unit": axis.get("unit"),
                    "length": axis["ticks"].get("length") if isinstance(axis["ticks"], dict) else len(axis["ticks"])}
                for axis in layout["axes"]]}
        contracts["calculations"].append(calculation)
    return contracts


async def dataset_view(db, row):
    from prediction.replicas import revision_replicas
    revisions = list((await db.scalars(select(DatasetRevision).where(
        DatasetRevision.dataset_id == row.id).order_by(DatasetRevision.revision.desc()))).all())
    return {"id": row.id, "name": row.name, "experiment_id": row.experiment_id, "source_kind": row.source_kind,
        "state": row.state, "current_revision": row.current_revision, "delete_id": row.delete_id,
        "revisions": [{"revision": item.revision, "fingerprint": item.fingerprint,
            **{key: value for key, value in item.summary.items() if key != "sample_fingerprints"},
            "payload_available": row.state == "active" and (item.payload is not None or bool(await db.scalar(
                select(Replica.id).where(Replica.dataset_id == row.id, Replica.revision == item.revision, Replica.state == "present").limit(1)))),
            "api_payload_available": row.state == "active" and row.source_kind == "server" and item.payload is not None,
            "replicas": await revision_replicas(db, "dataset", row.id, item.revision),
            "created_at": item.created_at} for item in revisions]}


async def list_datasets(db, user_id, experiment_id=None):
    query = select(Dataset).where(Dataset.user_id == user_id, Dataset.state != "deleted")
    if experiment_id is not None:
        query = query.where(Dataset.experiment_id == experiment_id)
    rows = (await db.scalars(query.order_by(Dataset.created_at.desc()))).all()
    return {"items": [await dataset_view(db, row) for row in rows]}


async def freeze_dataset(db, selection, user_id, dataset_id=None):
    identity = str(dataset_id) if dataset_id else str(uuid5(IDENTITY_NAMESPACE, f"{user_id}/dataset/{selection.request_id}"))
    await lock_identity(db, identity)
    row = await db.get(Dataset, identity)
    if row is not None:
        row = await owned(db, Dataset, identity, user_id)
    request_hash = digest(selection.model_dump(mode="json"))
    if row is not None:
        previous = await db.get(DatasetRequest, (row.id, str(selection.request_id)))
        if previous is not None:
            if previous.request_hash != request_hash:
                raise HTTPException(409, "Dataset request ID was already used for another selection.")
            return await dataset_view(db, row)
        if row.source_kind != "server" or row.experiment_id != selection.experiment_id:
            raise HTTPException(409, "Dataset source cannot be replaced by another Experiment or storage.")
        if selection.expected_revision != row.current_revision:
            raise HTTPException(409, "Dataset changed. Reload before synchronizing.")
        await require_dataset_idle(db, identity)
    elif dataset_id:
        raise HTTPException(404, "Dataset not found.")
    payload = await capture(db, selection, user_id)
    fingerprint = "sha256:" + digest(content_identity(payload))
    if row is None:
        row = Dataset(id=identity, user_id=user_id, experiment_id=selection.experiment_id,
            name=selection.name.strip(), state="active", source_kind="server", selection={}, current_revision=0)
        db.add(row)
        await db.flush()
    elif row.current_revision:
        current = await db.get(DatasetRevision, (identity, row.current_revision))
        if current.fingerprint == fingerprint:
            db.add(DatasetRequest(dataset_id=identity, request_id=str(selection.request_id),
                request_hash=request_hash, revision=row.current_revision))
            await db.commit()
            return await dataset_view(db, row)
    revision = row.current_revision + 1
    payload.update(datasetId=identity, revision=revision, fingerprint=fingerprint)
    summary = {"sample_count": len(payload["measurements"]), "record_count": len(payload["recorded"]),
        "calculation_data_count": len(payload["calculationData"]), "source_hash": selection.source_hash,
        "source_contracts": source_contracts(payload), "sample_fingerprints": sample_fingerprints(payload)}
    db.add(DatasetRevision(dataset_id=identity, revision=revision, request_id=str(selection.request_id),
        request_hash=request_hash, fingerprint=fingerprint, summary=summary, payload=payload))
    db.add(DatasetRequest(dataset_id=identity, request_id=str(selection.request_id), request_hash=request_hash, revision=revision))
    await db.flush()
    from prediction.replicas import managed_storage, put_replica
    server_storage = await managed_storage(db, user_id, "api_dataset")
    await put_replica(db, "dataset", identity, revision, server_storage.storage_id,
        artifact={"manifest_sha256": digest(payload), "fingerprint": fingerprint})
    for object_id in {ref["id"] for ref in object_refs(payload)}:
        db.add(DatasetObject(dataset_id=identity, revision=revision, object_id=object_id))
    await db.flush()
    # Only the latest Dataset retains payload. Old model artifacts contain their
    # own samples and never need these retired Dataset payloads to reload.
    await db.execute(delete(DatasetObject).where(DatasetObject.dataset_id == identity, DatasetObject.revision != revision))
    await db.execute(update(DatasetRevision).where(DatasetRevision.dataset_id == identity,
        DatasetRevision.revision != revision).values(payload=None))
    await db.execute(update(Replica).where(Replica.dataset_id == identity, Replica.revision != revision,
        Replica.storage_id == server_storage.storage_id).values(state="deleted"))
    row.name, row.current_revision = selection.name.strip(), revision
    row.selection = selection.model_dump(mode="json", exclude={"request_id", "expected_revision", "name"})
    await db.commit()
    return await dataset_view(db, row)


async def register_local_dataset(db, body, user_id):
    await connected_storage(db, body.storage_id, body.launcher_id, user_id)
    identity = str(body.dataset_id)
    await lock_identity(db, identity)
    row = await db.get(Dataset, identity)
    # Reconciliation can issue a new HTTP request while reporting the same
    # immutable local revision. Its location/content, not a retry nonce, wins.
    request_hash = digest(body.model_dump(mode="json", exclude={"request_id", "expected_revision", "storage_id", "launcher_id", "verified", "payload_available"}))
    if row is not None:
        row = await owned(db, Dataset, identity, user_id)
        old = await db.get(DatasetRevision, (identity, body.revision))
        if old is not None:
            replica = await db.scalar(select(Replica).where(Replica.dataset_id == identity,
                Replica.revision == body.revision, Replica.storage_id == str(body.storage_id)))
            if replica is None:
                raise HTTPException(409, "Complete the Dataset restore before registering it on another storage.")
            checksum = replica.manifest_sha256 or old.summary.get("manifest_sha256")
            if old.fingerprint != body.fingerprint or checksum != body.manifest_sha256:
                raise HTTPException(409, "Local Dataset revision cannot be replaced.")
            from prediction.replicas import put_replica
            await put_replica(db, "dataset", identity, body.revision, str(body.storage_id),
                artifact={"manifest_sha256": body.manifest_sha256, "fingerprint": body.fingerprint},
                state=("present" if body.verified else "unverified") if body.payload_available else "missing")
            await db.commit()
            return await dataset_view(db, row)
        if (row.source_kind != "local"
                or row.experiment_id != body.experiment_id or body.expected_revision != row.current_revision
                or body.revision != row.current_revision + 1):
            raise HTTPException(409, "Local Dataset changed. Reload before synchronizing.")
        source = await db.scalar(select(Replica).where(Replica.dataset_id == identity,
            Replica.revision == row.current_revision, Replica.storage_id == str(body.storage_id),
            Replica.state.not_in(["deleting", "deleted"])))
        if source is None:
            raise HTTPException(409, "Restore the current Dataset revision to this storage before synchronizing it.")
    else:
        if body.revision != 1 or body.expected_revision is not None:
            raise HTTPException(409, "A new local Dataset starts at revision 1.")
        row = Dataset(id=identity, user_id=user_id, experiment_id=body.experiment_id,
            name=body.name, state="active", source_kind="local", selection={}, current_revision=0)
        db.add(row)
        await db.flush()
    await source_experiment(db, body.experiment_id, body.source_hash, user_id)
    contracts = body.source_contracts
    if contracts.get("experimentId") != body.experiment_id or contracts.get("sourceHash") != body.source_hash:
        raise HTTPException(422, "Local Dataset contracts must identify their native Experiment and source hash.")
    # Legacy Calculation metadata remains part of the immutable Dataset, but
    # Forward registration depends only on the native output Records.
    records = contracts.get("records", [])
    if not isinstance(records, list) or any(not isinstance(record, dict) or type(record.get("id")) is not int for record in records):
        raise HTTPException(422, "Local Dataset source contracts must contain native integer IDs.")
    record_ids = {record["id"] for record in records}
    found = set((await db.scalars(select(ExperimentRecord.id).where(
        ExperimentRecord.id.in_(record_ids), ExperimentRecord.experiment_id == body.experiment_id))).all())
    if record_ids != found:
        raise HTTPException(422, "Local Dataset source contracts belong to another Experiment or were removed.")
    summary = {"sample_count": body.sample_count, "source_hash": body.source_hash,
        "manifest_sha256": body.manifest_sha256, "source_contracts": body.source_contracts}
    db.add(DatasetRevision(dataset_id=identity, revision=body.revision, request_id=str(body.request_id),
        request_hash=request_hash, fingerprint=body.fingerprint, summary=summary,
        payload={"sourceContracts": body.source_contracts} if body.payload_available else None))
    await db.flush()
    from prediction.replicas import put_replica
    await put_replica(db, "dataset", identity, body.revision, str(body.storage_id),
        artifact={"manifest_sha256": body.manifest_sha256, "fingerprint": body.fingerprint},
        state=("present" if body.verified else "unverified") if body.payload_available else "missing")
    await db.execute(update(DatasetRevision).where(DatasetRevision.dataset_id == identity,
        DatasetRevision.revision != body.revision).values(payload=None))
    await db.execute(update(Replica).where(Replica.dataset_id == identity,
        Replica.revision != body.revision, Replica.storage_id == str(body.storage_id),
        Replica.state.in_(["present", "unverified"]),
        ~func.coalesce(Replica.artifact["retained"].as_boolean(), False)).values(state="missing"))
    row.current_revision, row.name = body.revision, body.name
    await db.commit()
    return await dataset_view(db, row)


def sample_fingerprints(payload):
    samples = {row["id"]: {"measurement": row, "recorded": [], "calculationData": []}
        for row in payload.get("measurements", [])}
    for member in ("recorded", "calculationData"):
        for item in payload.get(member, []):
            if item["measurement_id"] in samples:
                samples[item["measurement_id"]][member].append(item)
    return {str(identity): digest(content_identity(sample)) for identity, sample in samples.items()}


async def preview_source(db, identity, selection, user_id):
    row = await owned(db, Dataset, identity, user_id)
    if row.source_kind != "server" or row.experiment_id != selection.experiment_id:
        raise HTTPException(409, "Source preview requires this Dataset's server Experiment.")
    baseline = await db.get(DatasetRevision, (identity, selection.expected_revision or row.current_revision))
    if baseline is None:
        raise HTTPException(404, "Dataset revision not found.")
    before = baseline.summary.get("sample_fingerprints")
    if before is None and baseline.payload is not None:
        before = sample_fingerprints(baseline.payload)
    if before is None:
        raise HTTPException(409, "This retired revision has no source comparison inventory. Its model remains usable.")
    after = sample_fingerprints(await capture(db, selection, user_id))
    return {"added": len(after.keys() - before.keys()), "removed": len(before.keys() - after.keys()),
        "changed": sum(before[key] != after[key] for key in before.keys() & after.keys())}
