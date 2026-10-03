"""Shared manual/automatic Hybrid training and adoption at round boundaries."""
from copy import deepcopy
from uuid import UUID, uuid5

from fastapi import HTTPException
from sqlalchemy import delete, select

from gpstation.db import Job
from gpstation.service.state import utcnow
from optimization.db import OptimizationModelPin
from optimization.automatic_updates import record_requested_snapshot, reconcile_automatic_attempt, refresh_automatic_state
from prediction.common import digest
from prediction.db import Dataset, ModelRevision, Operation, PredictionModel, Replica, TrainingRun


def model_state(optimization):
    initial = optimization.definition.get("hybrid")
    if initial is None:
        return None
    return deepcopy(optimization.optimizer_state.get("model_update") or {
        "initial_model": initial, "active_model": initial, "round_model": initial,
        "pending_model": None, "updates": [], "waiting": False,
    })


def round_source(optimization):
    state = model_state(optimization)
    return state["round_model"] or state["active_model"] if state else None


def save_state(optimization, state):
    optimization.optimizer_state = {**optimization.optimizer_state, "model_update": state}
    optimization.updated_at = utcnow()


async def sync_pins(db, optimization):
    state = model_state(optimization)
    if state is None:
        return
    for slot in ("active", "round", "pending"):
        source = state.get(slot + "_model") if optimization.state != "completed" else None
        pin = await db.get(OptimizationModelPin, (optimization.id, slot))
        if source is None:
            if pin is not None:
                await db.delete(pin)
            continue
        if pin is None:
            pin = OptimizationModelPin(optimization_id=optimization.id, slot=slot)
            db.add(pin)
        pin.model_id, pin.revision = source["model_id"], source["model_revision"]
        pin.replica_id, pin.storage_id = source["replica_id"], source["storage_id"]
    await db.flush()


async def request_update(db, optimization, body, *, automatic_request=None):
    """Caller holds the event/Optimization locks. All admission writes are atomic."""
    from prediction import training
    from prediction.datasets import dataset_change_set, freeze_dataset
    from prediction.models import reserve_model
    from prediction.schemas import DatasetSelection, ModelReserve

    state = model_state(optimization)
    if state is None:
        raise HTTPException(409, "Model updates require a Hybrid Optimization.")
    request_id = str(body.request_id)
    previous = next((item for item in state["updates"] if item["request_id"] == request_id
                     or request_id in item.get("request_ids", [])), None)
    if previous is not None:
        if previous["update_mode"] != body.update_mode:
            raise HTTPException(409, "This model update request ID has another mode.")
        return False
    if optimization.state not in {"running", "paused"}:
        raise HTTPException(409, "Model updates require a running or paused Hybrid Optimization.")
    base = state["active_model"]
    model = await db.scalar(select(PredictionModel).where(PredictionModel.id == base["model_id"]).with_for_update())
    if model is None or model.user_id != optimization.user_id or model.state != "active":
        raise HTTPException(409, "The Optimization model is unavailable.")
    # Failed requests retain their input until a new request replaces them.
    # Busy requests are never implicitly cancelled by a newer request.
    busy = False
    for item in state["updates"]:
        operation = await db.get(Operation, item["operation_id"])
        run = await db.get(TrainingRun, item["operation_id"])
        job = await db.get(Job, run.job_id) if run and run.job_id else None
        busy |= training.cleanup_pending(job) or bool(operation and operation.state in {"pending", "queued", "running"})
    dataset = await db.get(Dataset, base["dataset_id"])
    if dataset is None or dataset.source_kind != "server" or dataset.state != "active":
        raise HTTPException(409, "Hybrid updates require the original server-owned Dataset.")
    contracts = state["initial_model"]["source_contracts"]
    selection = DatasetSelection(request_id=uuid5(UUID(request_id), "snapshot"), name=dataset.name,
        experiment_id=optimization.experiment_id, source_hash=contracts["sourceHash"],
        vars_schema=contracts["varsSchema"], record_ids=[item["id"] for item in contracts["records"]],
        rules=contracts.get("rules", []), result_contracts=contracts.get("resultContracts", {}),
        expected_revision=dataset.current_revision)
    frozen = await freeze_dataset(db, selection, optimization.user_id, dataset.id, commit=False, online=True)
    target_revision = next(item for item in frozen["revisions"] if item["revision"] == frozen["current_revision"])
    target = {"datasetId": dataset.id, "revision": target_revision["revision"], "fingerprint": target_revision["fingerprint"]}
    baseline = {"datasetId": base["dataset_id"], "revision": base["dataset_revision"], "fingerprint": base["dataset_fingerprint"]}
    changes = await dataset_change_set(db, baseline, target, optimization.user_id)
    definition = deepcopy(base["model_definition"])
    definition.pop("fingerprint", None)
    definition["snapshotFingerprint"] = target["fingerprint"]
    definition["fingerprint"] = "sha256:" + digest(definition)
    recipe = {key: value for key, value in definition.items() if key not in {"fingerprint", "snapshotFingerprint"}}
    update = {"mode": body.update_mode, "baseModel": {"modelId": model.id, "revision": base["model_revision"],
        "checksum": base["checksum"], "storageId": base["storage_id"], "replicaId": base["replica_id"]},
        "targetSnapshot": target, "changeSet": changes, "recipe": recipe}
    identity = digest(update)
    same = next((item for item in state["updates"] if item.get("identity") == identity), None)
    if same is not None:
        same["request_ids"] = [*same.get("request_ids", []), request_id]
        save_state(optimization, state)
        return False
    if busy or state.get("pending_model") is not None:
        raise HTTPException(409, "Wait for this Optimization's existing model update before requesting another.")
    await training.assert_model_update_available(db, model.id, optimization.user_id,
        online_origin={"optimization_id": optimization.id})
    for item in state["updates"]:
        operation = await db.get(Operation, item["operation_id"])
        if operation and operation.state in {"failed", "interrupted"}:
            await training.cancel(db, operation)
            item["state"] = "superseded"
    request = ModelReserve(request_id=body.request_id, model_id=model.id, expected_revision=model.current_revision,
        name=model.name, dataset_id=dataset.id, dataset_revision=target["revision"], definition=definition,
        storage_id=base["storage_id"], launcher_id=base["launcher_id"], training_update=update)
    result = await reserve_model(db, request, optimization.user_id, commit=False, force_api_source=True,
        online_origin={"optimization_id": optimization.id, "optimization_name": optimization.name})
    revision = await db.get(ModelRevision, (model.id, result["reserved_revision"]))
    item = {"request_id": request_id, "request_ids": [], "identity": identity,
        "operation_id": result["operation_id"], "model_id": model.id, "revision": revision.revision,
        "version_name": revision.preparation.get("version_name", f"{model.name} · r{revision.revision} · {optimization.name}"),
        "update_mode": body.update_mode, "origin": "manual", "target_snapshot": target,
        "state": "pending", "error": None, "created_at": utcnow().isoformat()}
    state["updates"].append(item)
    run = await db.get(TrainingRun, result["operation_id"])
    record_requested_snapshot(optimization, state, target, item, run, automatic_request)
    save_state(optimization, state)
    await sync_pins(db, optimization)
    return True


async def reconcile_updates(db, optimization):
    """Observe existing TrainingRuns, submit once and retain validated successors."""
    from prediction import training
    from optimization.evaluations import freeze_quality, require_quality
    state = model_state(optimization)
    if state is None:
        return False
    busy = False
    for item in state["updates"]:
        operation = await db.get(Operation, item["operation_id"])
        run = await db.get(TrainingRun, item["operation_id"])
        timed_out = await reconcile_automatic_attempt(db, item, operation, run)
        if operation is None or run is None:
            item.update(state="failed", error="The training operation is unavailable.")
            continue
        job = await db.get(Job, run.job_id) if run.job_id else None
        if operation.state == "pending" and run.job_id is None and not timed_out:
            try:
                async with db.begin_nested():
                    await training.submit(db, operation.id, optimization.user_id, commit=False)
                job = await db.get(Job, run.job_id)
                if item.get("automatic_attempt") and run.pin_id == item["automatic_attempt"]["pin_id"]:
                    item["automatic_attempt"]["job_id"] = run.job_id
            except Exception as error:
                await db.refresh(operation)
                await db.refresh(run)
                operation.state = operation.stage = "failed"
                operation.error = {"message": str(getattr(error, "detail", None) or error)}
                operation.updated_at = utcnow()
            timed_out = await reconcile_automatic_attempt(db, item, operation, run)
        active = training.cleanup_pending(job)
        busy |= active or operation.state in {"pending", "queued", "running"}
        if timed_out or item["state"] in {"adopted", "completed_unadopted", "superseded"}:
            continue
        item["error"] = operation.error
        item["state"] = operation.state
        if operation.state in {"queued", "running"} and job and job.state not in training.JOB_TERMINAL_STATES:
            item["state"] = "queued" if job.state == "queued" else "running"
        if operation.state == "completed":
            revision = await db.get(ModelRevision, (item["model_id"], item["revision"]))
            artifact = (revision.artifact or {}) if revision is not None else {}
            validation = artifact.get("validation") or {}
            if (revision is None or revision.state != "ready" or validation.get("manifestChecksum") != artifact.get("manifest_sha256")
                    or validation.get("loadPassed") is not True or validation.get("predictPassed") is not True):
                item.update(state="failed", error="The saved model has no valid load and prediction receipt.")
                continue
            replica_id = operation.details.get("result_replicas", {}).get("model")
            replica = await db.get(Replica, replica_id) if replica_id else None
            if replica is None or replica.state != "present" or replica.manifest_sha256 != artifact["manifest_sha256"]:
                item.update(state="failed", error="The saved model copy is unavailable or unverified.")
                continue
            initial = state["initial_model"]
            if revision.source_contracts != initial["source_contracts"]:
                item.update(state="failed", error="The updated model source contracts changed.")
                continue
            try:
                quality = freeze_quality(revision, initial.get("quality_requirements"))
                item["quality_assessment"] = quality["quality_assessment"]
                require_quality(quality["quality_assessment"])
            except HTTPException as error:
                item.update(state="failed", error={"message": str(error.detail)})
                continue
            state["pending_model"] = {**initial, **quality, "model_revision": revision.revision,
                "replica_id": replica.id, "checksum": artifact["manifest_sha256"],
                "dataset_id": revision.dataset_id, "dataset_revision": revision.dataset_revision,
                "dataset_fingerprint": revision.dataset_fingerprint, "model_definition": revision.definition,
                "source_contracts": revision.source_contracts, "version_name": item["version_name"]}
            item["state"] = "ready"
    await refresh_automatic_state(db, optimization, state)
    save_state(optimization, state)
    await sync_pins(db, optimization)
    return busy


async def bind_round(db, optimization, round_index):
    state = model_state(optimization)
    if state["pending_model"] is not None:
        state["active_model"] = state["pending_model"]
        state["pending_model"] = None
        for item in state["updates"]:
            if item["revision"] == state["active_model"]["model_revision"] and item["state"] == "ready":
                item.update(state="adopted", adopted_round=round_index)
    state["round_model"] = deepcopy(state["active_model"])
    state["waiting"] = False
    automatic = state.get("automatic")
    if automatic and automatic["reason"] in {"training_busy", "awaiting_adoption", "round_already_requested"}:
        automatic["reason"] = "awaiting_round"
    save_state(optimization, state)
    source_hash = digest(state["round_model"])
    optimization.optimizer_state = {**optimization.optimizer_state, "round_source_hash": source_hash,
        "round_sources": {**optimization.optimizer_state.get("round_sources", {}), str(round_index): state["round_model"]}}
    await sync_pins(db, optimization)


async def cancel_updates(db, optimization):
    from prediction import training
    state = model_state(optimization)
    if state is None:
        return
    for item in state["updates"]:
        operation = await db.get(Operation, item["operation_id"])
        if operation and operation.state != "completed":
            await training.cancel(db, operation)
            item["state"] = "cancelled"
    state["waiting"] = False
    if state.get("automatic"):
        state["automatic"]["reason"] = "not_running"
    save_state(optimization, state)


async def update_jobs(db, optimization):
    ids = [item["operation_id"] for item in (model_state(optimization) or {}).get("updates", [])]
    return list((await db.scalars(select(Job).join(TrainingRun, TrainingRun.job_id == Job.id)
        .where(TrainingRun.operation_id.in_(ids)))).all()) if ids else []


async def finish_updates(db, optimization):
    state = model_state(optimization)
    if state is not None:
        for item in state["updates"]:
            if item["state"] == "ready":
                item["state"] = "completed_unadopted"
        state["pending_model"], state["waiting"] = None, False
        if state.get("automatic"):
            state["automatic"]["reason"] = "search_finished"
        save_state(optimization, state)
        await db.execute(delete(OptimizationModelPin).where(OptimizationModelPin.optimization_id == optimization.id))
