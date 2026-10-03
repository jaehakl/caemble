"""Server-owned model training; browser sessions only submit and observe."""
from __future__ import annotations

import hashlib
from copy import deepcopy
import secrets
import time
from datetime import timedelta
from uuid import uuid4

from fastapi import HTTPException
import jwt
from sqlalchemy import delete, select

from gpstation.db import Job, Launcher
from gpstation.service.batches import finish_job, serialize_events
from gpstation.service.execution import requested_resources, sync_attempt
from gpstation.service.job_service import JOB_TERMINAL_STATES
from gpstation.service.state import utcnow
from prediction.common import connected_storage, owned
from prediction.db import Dataset, DatasetGrant, DatasetRevision, ModelLease, ModelRevision, Operation, PredictionModel, Replica, TrainingRun
from prediction.schemas import ModelComplete
from prediction_contracts import validate_new_training
from prediction.resources import resolve_resources
from settings import settings

HANDLER = "prediction.train"
APP_ID = "predictor-training"
PREFLIGHT_SECONDS = 900


def cleanup_pending(job):
    return job is not None and (job.state not in JOB_TERMINAL_STATES or (job.launcher_id is not None and job.cleaned_at is None))


async def retained_runs(db, dataset_id=None):
    """Updates retain their frozen inputs across retryable failures and restarts."""
    rows = (await db.execute(select(TrainingRun, Operation, ModelRevision, Job)
        .join(Operation, Operation.id == TrainingRun.operation_id)
        .join(ModelRevision, (ModelRevision.model_id == Operation.asset_id) & (ModelRevision.revision == Operation.revision))
        .outerjoin(Job, Job.id == TrainingRun.job_id)
        .where(*([TrainingRun.dataset_id == dataset_id] if dataset_id else [])))).all()
    now = utcnow()
    return [(run, operation) for run, operation, revision, job in rows if cleanup_pending(job)
        or (revision.state == "reserved" and operation.state not in {"completed", "cancelled"}
            and (operation.details.get("update") is not None
                or (run.preflight_expires_at is not None and run.preflight_expires_at > now)))]


async def retained_snapshots(db, dataset_id=None):
    return {(run.dataset_id, run.dataset_revision) for run, _ in await retained_runs(db, dataset_id)
        if run.source_kind == "api"}


async def assert_model_update_available(db, model_id, user_id, *, operation_id=None, online_origin=None):
    rows = (await db.execute(select(Operation, TrainingRun, Job).join(TrainingRun, TrainingRun.operation_id == Operation.id)
        .outerjoin(Job, Job.id == TrainingRun.job_id).where(Operation.asset_id == str(model_id),
            Operation.user_id == user_id, Operation.kind == "prepare",
            *([Operation.id != str(operation_id)] if operation_id else [])))).all()
    for operation, run, job in rows:
        if cleanup_pending(job) or (operation.state in {"pending", "queued", "running"}
                and (online_origin is not None or operation.details.get("online_origin") is not None)):
            raise HTTPException(409, {"message": "This model already has a protected training operation. Finish or cancel it first.",
                "operation_id": operation.id})


async def require_unmanaged_job(db, job_id, user_id=None):
    query = select(Job).where(Job.id == job_id, Job.handler_type == HANDLER)
    if user_id is not None:
        query = query.where(Job.user_id == user_id)
    if await db.scalar(query) is not None:
        raise HTTPException(409, "Control this training execution from its Prediction operation.")


async def create_run(db, operation, revision, local_copy):
    launcher = await db.get(Launcher, operation.details["target_launcher_id"])
    run = TrainingRun(operation_id=operation.id, dataset_id=revision.dataset_id,
        dataset_revision=revision.dataset_revision, source_kind="local" if local_copy is not None else "api",
        source_replica_id=local_copy.id if local_copy is not None else None, pin_id=str(uuid4()),
        resources={"cpu_cores": 1, "startup_ram_bytes": 1024 ** 3,
                   **resolve_resources(revision.definition, "training", launcher.resources or {})},
        retry_requests={}, preflight_expires_at=utcnow() + timedelta(seconds=PREFLIGHT_SECONDS))
    operation.details = {**operation.details, "resources_frozen": True}
    db.add(run)
    return run


def pin_grant(row, run):
    if not settings.JWT_SECRET:
        raise HTTPException(503, "Prediction signing is not configured.")
    now = int(time.time())
    token = jwt.encode({"typ": "prediction_training", "sub": row.user_id, "operation": row.id,
        "pin": run.pin_id, "iat": now, "exp": now + PREFLIGHT_SECONDS}, settings.JWT_SECRET, algorithm=settings.JWT_ALG)
    return {"operation_id": row.id, "token": token,
        "manifest_url": f"{settings.public_api_base_url}/prediction/operations/{row.id}/training"}


async def operation_view(db, row):
    from prediction.operations import operation_view as asset_view
    result = asset_view(row)
    run = await db.get(TrainingRun, row.id)
    if run is None:
        return result
    job = await db.get(Job, run.job_id) if run.job_id else None
    if job is not None and row.state not in {"pending", "completed", "cancelled"}:
        result["state"] = "queued" if job.state == "queued" else "running" if job.state not in JOB_TERMINAL_STATES else row.state
        result["stage"] = job.waiting_reason or (job.progress[-1].get("progress", {}).get("stage") if job.progress else None) or result["state"]
    result["training"] = {"pinId": run.pin_id, "sourceKind": run.source_kind, "resources": run.resources,
        "jobId": run.job_id, "cleanupPending": job is not None and job.state in JOB_TERMINAL_STATES and cleanup_pending(job),
        "grant": pin_grant(row, run)}
    if job is not None and job.progress and row.state != "pending":
        result["training"]["progress"] = job.progress[-1].get("progress")
    return result


async def authority(db, identity, authorization):
    token = authorization.removeprefix("Bearer ") if authorization.startswith("Bearer ") else ""
    try:
        claims = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALG],
            options={"verify_exp": False, "require": ["typ", "sub", "operation", "pin", "iat", "exp"]})
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Training grant is invalid.") from None
    if claims["typ"] != "prediction_training" or claims["operation"] != str(identity):
        raise HTTPException(403, "Training grant does not cover this operation.")
    from prediction.operations import owned_operation
    await serialize_events(db)
    row = await owned_operation(db, identity, claims["sub"])
    run = await db.get(TrainingRun, row.id)
    if run is None:
        raise HTTPException(410, "This training operation is unavailable.")
    old_pin = claims["pin"] != run.pin_id
    revision = await db.get(ModelRevision, (row.asset_id, row.revision))
    job = await db.get(Job, run.job_id) if run.job_id else None
    active = cleanup_pending(job)
    preflight = run.preflight_expires_at is not None and run.preflight_expires_at > utcnow()
    can_pin = (row.state not in {"completed", "cancelled"} and revision.state == "reserved"
        and (active or preflight) and type(claims["exp"]) is int and claims["exp"] > time.time())
    model = await db.get(PredictionModel, row.asset_id)
    result = {"operationId": row.id, "pinId": claims["pin"], "storageId": row.details["target_storage_id"],
        "launcherId": row.details["target_launcher_id"], "sourceKind": run.source_kind,
        "model": {"modelId": row.asset_id, "revision": row.revision, "operationId": row.id, "name": row.details["name"]},
        "definition": revision.definition, "dataset": {"datasetId": run.dataset_id,
            "revision": run.dataset_revision, "fingerprint": revision.dataset_fingerprint},
        "state": row.state, "canPin": not old_pin and can_pin and model.state == "active",
        # A pin rotates only after its process is reaped. Old signed grants may
        # release that exact old disk pin even if a new preflight is abandoned.
        "canRelease": old_pin or (not active and (row.state in {"completed", "cancelled"} or not preflight)),
        "resources": run.resources}
    if row.details.get("update") is not None:
        result["update"] = row.details["update"]
    return row, run, result


async def acknowledge_pin(db, identity, authorization, pin_id, artifact_saved=False):
    row, run, scope = await authority(db, identity, authorization)
    if not scope["canPin"] or str(pin_id) != run.pin_id:
        raise HTTPException(409, "This training preflight is no longer active.")
    row.details = {**row.details, "confirmed_pin": run.pin_id, "artifact_saved": bool(artifact_saved)}
    await db.commit()
    return {"operationId": row.id, "pinId": run.pin_id}


async def preflight(db, identity, request_id, user_id):
    from prediction.operations import owned_operation
    await serialize_events(db)
    row = await owned_operation(db, identity, user_id)
    run = await db.get(TrainingRun, row.id)
    if run is None:
        raise HTTPException(409, "Create a new model revision to use server training.")
    request_id = str(request_id)
    if request_id in run.retry_requests or run.preflight_request_id == request_id:
        return await operation_view(db, row)
    from optimization.guards import require_training_continuation
    await require_training_continuation(db, row.details.get("online_origin"))
    job = await db.get(Job, run.job_id) if run.job_id else None
    if row.state not in {"failed", "interrupted", "pending", "cancelled"} or cleanup_pending(job):
        raise HTTPException(409, "Wait for failed training cleanup before preparing a retry.")
    model = await owned(db, PredictionModel, row.asset_id, user_id)
    revision = await db.get(ModelRevision, (model.id, row.revision))
    if revision.state != "reserved":
        raise HTTPException(410, "This model preparation was superseded.")
    try:
        validate_new_training(revision.definition, row.details.get("update"))
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    await assert_model_update_available(db, model.id, user_id, operation_id=row.id,
        online_origin=row.details.get("online_origin"))
    origin = row.details.get("online_origin")
    latest = await db.scalar(select(ModelRevision.revision).where(ModelRevision.model_id == model.id,
        *([ModelRevision.preparation["online_origin"]["optimization_id"].astext == str(origin["optimization_id"])] if origin else []))
        .order_by(ModelRevision.revision.desc()).limit(1))
    if latest != revision.revision:
        raise HTTPException(410, "A later model revision superseded this retry.")
    run.pin_id, run.preflight_request_id = str(uuid4()), request_id
    run.preflight_expires_at = utcnow() + timedelta(seconds=PREFLIGHT_SECONDS)
    row.state, row.stage, row.error, row.completed_at = "pending", "preparing", None, None
    row.updated_at = utcnow()
    row.details = {key: value for key, value in row.details.items() if key not in {"confirmed_pin", "artifact_saved"}}
    await db.commit()
    return await operation_view(db, row)


async def submit(db, identity, user_id, *, pin_id=None, retry_request_id=None, commit=True):
    from prediction.operations import owned_operation
    await serialize_events(db)
    row = await owned_operation(db, identity, user_id)
    run = await db.get(TrainingRun, row.id)
    if run is None:
        raise HTTPException(409, "Create a new model revision to use server training.")
    nonce = str(retry_request_id) if retry_request_id else None
    if (nonce is not None and nonce in run.retry_requests) or (nonce is None and run.job_id):
        return await operation_view(db, row)
    from optimization.guards import require_training_continuation
    await require_training_continuation(db, row.details.get("online_origin"))
    previous = await db.get(Job, run.job_id) if run.job_id else None
    if cleanup_pending(previous):
        raise HTTPException(409, "Wait for the previous training process to finish cleanup.")
    if row.state in {"completed", "cancelled"} or (nonce and run.preflight_request_id != nonce):
        raise HTTPException(409, "Prepare this retry before submitting it.")
    if run.preflight_expires_at is None or run.preflight_expires_at <= utcnow():
        raise HTTPException(409, "Training preflight expired. Prepare the request again.")
    if run.source_kind == "local" and (str(pin_id) != run.pin_id or row.details.get("confirmed_pin") != run.pin_id):
        raise HTTPException(409, "Pin the exact local Dataset before submitting training.")
    model = await owned(db, PredictionModel, row.asset_id, user_id)
    revision = await db.get(ModelRevision, (model.id, row.revision))
    if revision.state != "reserved":
        raise HTTPException(410, "This model preparation was superseded.")
    await assert_model_update_available(db, model.id, user_id, operation_id=row.id,
        online_origin=row.details.get("online_origin"))
    try:
        validate_new_training(revision.definition, row.details.get("update"))
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    await connected_storage(db, row.details["target_storage_id"], row.details["target_launcher_id"], user_id)
    launcher = await db.get(Launcher, row.details["target_launcher_id"])
    if APP_ID not in (launcher.slave_app_ids or []) or (launcher.job_modes or {}).get(APP_ID) != "websocket":
        raise HTTPException(422, "The selected Launcher must support server-owned Predictor training.")
    # A complete saved receipt is recoverable without retaining its training source.
    if not row.details.get("artifact_saved"):
        dataset = await owned(db, Dataset, run.dataset_id, user_id)
        source = await db.get(DatasetRevision, (run.dataset_id, run.dataset_revision))
        if source is None or source.fingerprint != revision.dataset_fingerprint:
            raise HTTPException(409, "The exact training Dataset revision is unavailable.")
        if run.source_kind == "api" and source.payload is None:
            raise HTTPException(409, "The exact server Dataset payload is no longer retained.")
        if run.source_kind == "local":
            copy = await db.get(Replica, run.source_replica_id)
            if copy is None or copy.state not in {"present", "unverified"}:
                raise HTTPException(409, "The pinned Dataset copy is unavailable.")
    if not row.details.get("resources_frozen"):
        # Older operations stored only algorithm requirements. Preserve an already
        # submitted attempt, or resolve the remaining defaults once before submit.
        run.resources = {"cpu_cores": 1, "startup_ram_bytes": 1024 ** 3, "gpu_count": 0,
            **(deepcopy(previous.resources) if previous is not None and previous.resources else requested_resources(
                run.resources, launcher.resources or {}, APP_ID, HANDLER))}
        row.details = {**row.details, "resources_frozen": True}
    resources = deepcopy(run.resources)
    job = Job(id=str(uuid4()), user_id=user_id, slave_app_id=APP_ID, handler_type=HANDLER,
        job_mode="websocket", target_launcher_id=launcher.id, state="queued", progress=[], resources=resources,
        attempt_count=1, attempt_id=str(uuid4()), execution_phase="queued",
        artifact_metadata={"prediction_operation_id": row.id, "resources_resolved": True,
            **({"optimization_id": row.details["online_origin"]["optimization_id"]}
                if row.details.get("online_origin") is not None else {})},
        input={"operationId": row.id, "pinId": run.pin_id, "storageId": row.details["target_storage_id"],
            "launcherId": launcher.id, "sourceKind": run.source_kind,
            "model": {"modelId": model.id, "revision": row.revision, "operationId": row.id, "name": row.details["name"]},
            "definition": revision.definition, "dataset": {"datasetId": run.dataset_id,
                "revision": run.dataset_revision, "fingerprint": revision.dataset_fingerprint}, "resources": resources})
    job.input = {**job.input, "datasetAccessUrl": f"{settings.public_api_base_url}/prediction/training/jobs/{job.id}/attempts/{job.attempt_id}/dataset"}
    update = row.details.get("update")
    if update is not None:
        from prediction.models import validate_update_references
        await validate_update_references(db, update, revision.definition, model.id,
            {"datasetId": run.dataset_id, "revision": run.dataset_revision, "fingerprint": revision.dataset_fingerprint},
            user_id, row.details["target_storage_id"], row.details["target_launcher_id"])
        job.input = {**job.input, "update": update}
    db.add(job)
    await db.flush()
    run.job_id, run.preflight_expires_at = job.id, None
    if nonce:
        run.retry_requests = {**run.retry_requests, nonce: job.id}
    row.state = row.stage = "queued"
    row.error, row.expires_at, row.completed_at = None, None, None
    row.updated_at = utcnow()
    db.add(ModelLease(model_id=model.id, revision=row.revision, job_id=job.id, storage_id=row.details["target_storage_id"]))
    if update is not None and update.get("baseModel") is not None:
        base = update["baseModel"]
        db.add(ModelLease(model_id=base["modelId"], revision=base["revision"], job_id=job.id,
            storage_id=base["storageId"], replica_id=base["replicaId"]))
    await sync_attempt(db, job)
    if commit:
        await db.commit()
        from gpstation.service.job_orchestrator import job_orchestrator
        job_orchestrator.wake_dispatcher()
    else:
        await db.flush()
    return await operation_view(db, row)


async def dataset_access(db, job_id, attempt_id, authorization):
    token = authorization.removeprefix("Bearer ") if authorization.startswith("Bearer ") else ""
    await serialize_events(db)
    job = await db.scalar(select(Job).where(Job.id == str(job_id)).with_for_update())
    if (not token or job is None or job.handler_type != HANDLER or job.attempt_id != str(attempt_id)
            or job.state not in {"running", "assigned"} or job.cancel_requested_at is not None
            or not secrets.compare_digest(job.worker_token_hash or "", hashlib.sha256(token.encode()).hexdigest())):
        raise HTTPException(403, "Credential does not cover this active training attempt.")
    run = await db.get(TrainingRun, job.artifact_metadata["prediction_operation_id"])
    if run is None or run.job_id != job.id:
        raise HTTPException(410, "Training attempt was replaced.")
    if run.source_kind == "local":
        return job.input["dataset"]
    from prediction.grants import create_grant
    grant = await create_grant(db, run.dataset_id, run.dataset_revision, job.user_id, pinned=True, commit=False)
    job.artifact_metadata = {**job.artifact_metadata,
        "dataset_grants": [*job.artifact_metadata.get("dataset_grants", []), grant["grant_id"]]}
    await db.commit()
    result = {"grant": grant}
    if job.input.get("update") is not None:
        result["trainingGrant"] = pin_grant(await db.get(Operation, run.operation_id), run)
    return result


async def cancel(db, row):
    """Caller holds serialize_events and the asset/operation locks; do not commit."""
    run = await db.get(TrainingRun, row.id)
    if row.state == "completed":
        return
    row.state, row.stage, row.completed_at = "cancelled", "cancelled", utcnow()
    row.updated_at = utcnow()
    row.error = {"message": "Training cancelled. Completed models are retained."}
    if run is not None:
        run.preflight_expires_at = None
        job = await db.get(Job, run.job_id) if run.job_id else None
        if job is not None and job.state not in JOB_TERMINAL_STATES:
            job.cancel_requested_at = utcnow()
            await finish_job(db, job, "cancelled", "Training cancelled.")


async def notify_cancel(db, row):
    run = await db.get(TrainingRun, row.id)
    job = await db.get(Job, run.job_id) if run is not None and run.job_id else None
    if job is not None:
        from gpstation.service.job_orchestrator import job_orchestrator
        await job_orchestrator.kill_job(db, job_id=job.id, user_id=job.user_id, reason="Training cancelled")


async def cancel_operation(db, identity, user_id):
    from prediction.operations import owned_operation, stop_operation
    await serialize_events(db)
    row = await owned_operation(db, identity, user_id)
    if row.kind != "prepare":
        return await stop_operation(db, row, cancel=True)
    await cancel(db, row)
    await db.commit()
    await notify_cancel(db, row)
    return await operation_view(db, row)


async def stage_record(db, job, packet, attachments):
    raise ValueError("Training publishes one verified model artifact at completion.")


async def require_external_control(db, job):
    raise HTTPException(409, "Control this training execution from its Prediction operation.")


async def complete_job(db, job, packet):
    from prediction.models import complete_model
    identity = (job.artifact_metadata or {}).get("prediction_operation_id")
    row = await db.get(Operation, identity)
    run = await db.get(TrainingRun, identity)
    if (row is None or run is None or run.job_id != job.id or row.state == "cancelled"
            or job.cancel_requested_at is not None or job.input["pinId"] != run.pin_id):
        raise ValueError("Training completion belongs to an inactive attempt.")
    artifact = packet.get("artifact")
    if not isinstance(artifact, dict):
        raise ValueError("Training did not return a complete artifact receipt.")
    revision = await db.get(ModelRevision, (row.asset_id, row.revision))
    expected = {"modelId": row.asset_id, "revision": row.revision, "operationId": row.id,
        "datasetId": run.dataset_id, "datasetRevision": run.dataset_revision,
        "datasetFingerprint": revision.dataset_fingerprint, "definition": revision.definition,
        "storageId": row.details["target_storage_id"], "launcherId": job.launcher_id, "direction": "forward",
        "algorithm": revision.definition["algorithm"]["kind"]}
    update = row.details.get("update")
    if update is not None:
        expected["update"] = update
        expected["name"] = row.details["name"]
    if any(artifact.get(key) != value for key, value in expected.items()):
        raise ValueError("Training artifact differs from the frozen operation.")
    validation = artifact.get("validation")
    if validation is not None:
        measurement_id = validation.get("measurementId") if isinstance(validation, dict) else None
        if (not isinstance(validation, dict) or type(validation.get("version")) is not int or validation["version"] != 1
                or validation.get("manifestChecksum") != artifact.get("manifestChecksum")
                or validation.get("loadPassed") is not True or validation.get("predictPassed") is not True
                or "measurementId" not in validation
                or (measurement_id is not None and (type(measurement_id) is not int or measurement_id <= 0))):
            raise ValueError("Model execution validation must certify this saved artifact.")
    if update is not None:
        source = await db.get(DatasetRevision, (run.dataset_id, run.dataset_revision))
        measurement_id = validation.get("measurementId") if isinstance(validation, dict) else None
        if (not isinstance(validation, dict) or validation.get("version") != 1
                or validation.get("manifestChecksum") != artifact.get("manifestChecksum")
                or validation.get("loadPassed") is not True or validation.get("predictPassed") is not True
                or type(measurement_id) is not int or source is None
                or str(measurement_id) not in source.summary.get("sample_fingerprints", {})):
            raise ValueError("Updated models require validation against their frozen training snapshot.")
    body = ModelComplete(request_id=row.id, manifest_sha256=artifact.get("manifestChecksum"),
        files=artifact.get("files"), profile=artifact.get("profile"), input_layouts=artifact.get("inputLayouts"),
        output_layouts=artifact.get("outputLayouts"), format_version=artifact.get("formatVersion"), verified=True,
        update=update, validation=validation, quality_report=artifact.get("qualityReport"),
        training_metrics=artifact.get("trainingMetrics"), execution_metrics=artifact.get("executionMetrics"))
    await complete_model(db, row.asset_id, row.revision, body, row.user_id, commit=False)
    return {"operation_id": row.id, "model_id": row.asset_id, "revision": row.revision}


async def on_finished(db, job, result=None):
    row = await db.get(Operation, (job.artifact_metadata or {}).get("prediction_operation_id"))
    run = await db.get(TrainingRun, row.id) if row else None
    if row is None or run is None or run.job_id != job.id:
        return
    if job.state != "succeeded" and row.state not in {"completed", "cancelled"}:
        row.state = row.stage = "cancelled" if job.state in {"cancelled", "killed"} else "failed"
        row.error = {"message": job.last_error or "Training stopped. Retry after process cleanup."}
        row.completed_at = utcnow()
    row.updated_at = utcnow()


async def release_finished_grants(db, dataset_id=None):
    jobs = list((await db.scalars(select(Job).where(Job.handler_type == HANDLER,
        Job.state.in_(JOB_TERMINAL_STATES), Job.cleaned_at.is_not(None) | Job.launcher_id.is_(None),
        Job.artifact_metadata.has_key("dataset_grants"),
        *([Job.input["dataset"]["datasetId"].astext == dataset_id] if dataset_id else [])))).all())
    for job in jobs:
        await db.execute(delete(DatasetGrant).where(DatasetGrant.id.in_(job.artifact_metadata["dataset_grants"])))
        job.artifact_metadata = {key: value for key, value in job.artifact_metadata.items() if key != "dataset_grants"}


async def reconcile(db):
    await serialize_events(db)
    await release_finished_grants(db)
    await db.execute(delete(ModelLease).where(ModelLease.job_id.in_(select(Job.id).where(
        Job.handler_type == HANDLER, Job.state.in_(JOB_TERMINAL_STATES),
        Job.cleaned_at.is_not(None) | Job.launcher_id.is_(None)))))
    from prediction.datasets import retire_server_payloads
    await retire_server_payloads(db)
    await db.commit()
