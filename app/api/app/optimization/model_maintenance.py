"""Server-owned removal of superseded Optimization-generated model copies."""
import hashlib
import secrets
from datetime import timedelta
from uuid import UUID, uuid4, uuid5

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import select

from db import get_db
from gpstation.db import Job, Launcher
from gpstation.service.batches import serialize_events
from gpstation.service.execution import requested_resources, sync_attempt
from gpstation.service.state import utcnow
from prediction import operations, training
from prediction.common import owned
from prediction.db import ModelRevision, Operation, PredictionModel, Replica
from prediction.schemas import OperationCreate
from settings import settings

HANDLER = "prediction.prune"
RETRY_SECONDS = 5
MAX_RETRY_SECONDS = 300
router = APIRouter(prefix="/cae/optimization-maintenance", tags=["cae-optimizations"])


async def reconcile_pruning(db):
    await serialize_events(db)
    revisions = list((await db.scalars(select(ModelRevision).where(ModelRevision.state == "ready",
        ModelRevision.preparation.has_key("online_origin")).order_by(ModelRevision.model_id, ModelRevision.revision.desc()))).all())
    latest = set()
    for revision in revisions:
        origin = revision.preparation["online_origin"]["optimization_id"]
        group = (revision.model_id, origin)
        if group not in latest:
            latest.add(group)
            continue
        owner = await db.scalar(select(PredictionModel).where(PredictionModel.id == revision.model_id).with_for_update())
        if owner is None or owner.state != "active":
            continue
        created = await db.get(Operation, revision.request_id)
        replica_id = (created.details.get("result_replicas") or {}).get("model") if created else None
        replica = await db.get(Replica, replica_id) if replica_id else None
        if replica is None or replica.storage_id != revision.preparation["storage_id"]:
            continue
        identity = str(uuid5(UUID(replica.id), "optimization-generated-copy-prune"))
        operation = await db.get(Operation, identity)
        # A user's later restore of this copy is intentional. Its completed prune
        # receipt prevents the automatic policy from removing it a second time.
        if operation and operation.state in {"completed", "cancelled"}:
            continue
        if operation and operation.details.get("replica_id") != replica.id:
            operation.details = {**operation.details, "replica_id": replica.id}
        previous = await db.get(Job, operation.details.get("prune_job_id")) if operation and operation.details.get("prune_job_id") else None
        if training.cleanup_pending(previous):
            continue
        if operation and operation.details.get("prune_retry_at", 0) > utcnow().timestamp():
            continue
        if (operation and operation.details.get("prune_manual_retry")
                and operation.expires_at is not None
                and operation.expires_at + timedelta(seconds=operations.RENEWAL_GRACE_SECONDS) > utcnow()):
            continue
        if replica.state != "present" and not (replica.state == "deleting" and replica.delete_id == identity):
            continue
        try:
            await operations.assert_copy_idle(db, replica, operation_id=identity)
        except HTTPException:
            continue
        if operation is None:
            operation = Operation(id=identity, request_id=identity,
                request_hash=hashlib.sha256(f"{replica.id}/{replica.revision}/{replica.manifest_sha256}".encode()).hexdigest(),
                user_id=owner.user_id, kind="delete_replica", asset_kind="model", asset_id=owner.id,
                revision=revision.revision, experiment_id=owner.experiment_id, state="pending", stage="waiting-launcher",
                details={"origin_optimization_id": origin, "automatic_prune": True,
                    "replica_id": replica.id, "replica_ids": [replica.id]})
            db.add(operation)
            await db.flush()
        launcher = await db.get(Launcher, revision.preparation["launcher_id"])
        if (launcher is None or launcher.disconnected_at is not None or launcher.status not in {"ready", "busy"}
                or training.APP_ID not in (launcher.slave_app_ids or [])
                or (launcher.job_modes or {}).get(training.APP_ID) != "websocket"):
            continue
        try:
            resources = requested_resources({"cpu_cores": 1, "gpu_count": 0}, launcher.resources or {}, training.APP_ID, HANDLER)
        except (HTTPException, ValueError) as error:
            operation.stage, operation.error = "waiting-resources", {"message": str(error)}
            continue
        job = Job(id=str(uuid4()), user_id=owner.user_id, slave_app_id=training.APP_ID, handler_type=HANDLER,
            job_mode="websocket", target_launcher_id=launcher.id, state="queued", progress=[], resources=resources,
            attempt_count=1, attempt_id=str(uuid4()), execution_phase="queued",
            artifact_metadata={"prediction_operation_id": identity, "optimization_prune_origin": origin},
            input={"action": "prune", "operationId": identity, "replicaId": replica.id, "modelId": owner.id,
                "revision": revision.revision, "storageId": replica.storage_id, "launcherId": launcher.id})
        job.input = {**job.input, "accessUrl": f"{settings.public_api_base_url}/cae/optimization-maintenance/jobs/{job.id}/attempts/{job.attempt_id}/access"}
        db.add(job)
        # Failed workers and expired manual transfers cannot reuse grants from an
        # earlier attempt. Access signs this new generation only after rechecking
        # every retained reference and installing the deletion tombstone.
        operation.details = {**operation.details, "prune_job_id": job.id, "prune_manual_retry": False,
            "grant_generation": operation.details.get("grant_generation", 0) + 1}
        operation.details.pop("grant_deadline", None)
        operation.expires_at = None
        operation.state, operation.stage, operation.error = "pending", "queued", None
        operation.updated_at = utcnow()
        await db.flush()
        await sync_attempt(db, job)
    await db.commit()


@router.get("/jobs/{job_id}/attempts/{attempt_id}/access")
async def access(job_id: UUID, attempt_id: UUID, authorization: str = Header(default=""), db=Depends(get_db)):
    await serialize_events(db)
    job = await db.scalar(select(Job).where(Job.id == str(job_id)).with_for_update())
    token = authorization.removeprefix("Bearer ") if authorization.startswith("Bearer ") else ""
    if (not token or job is None or job.handler_type != HANDLER or job.attempt_id != str(attempt_id)
            or job.state not in {"assigned", "running"} or job.cancel_requested_at is not None
            or not secrets.compare_digest(job.worker_token_hash or "", hashlib.sha256(token.encode()).hexdigest())):
        raise HTTPException(403, "Credential does not cover this active model cleanup attempt.")
    operation = await db.get(Operation, job.input["operationId"])
    if operation is None or operation.details.get("prune_job_id") != job.id or operation.user_id != job.user_id:
        raise HTTPException(409, "This model cleanup attempt was replaced.")
    if operation.state in {"completed", "cancelled"}:
        # The worker can recover its already acknowledged removal from its local
        # receipt; issue_grant intentionally rejects a completed operation.
        raise HTTPException(409, "Model cleanup is already complete.")
    owner = await owned(db, PredictionModel, job.input["modelId"], job.user_id)
    replica = await db.get(Replica, job.input["replicaId"])
    if replica is None or replica.model_id != job.input["modelId"] or replica.revision != job.input["revision"]:
        raise HTTPException(409, "Model cleanup targets another or unavailable copy.")
    await operations.assert_copy_idle(db, replica, operation_id=operation.id)
    await operations.begin_deletion(db, operation, owner, OperationCreate(request_id=operation.id,
        kind="delete_replica", asset_kind="model", asset_id=owner.id, revision=replica.revision, replica_id=replica.id))
    return {"grant": await operations.issue_grant(db, operation)}


async def stage_record(db, job, packet, attachments):
    raise ValueError("Model cleanup publishes one removal receipt at completion.")


async def complete_job(db, job, packet):
    operation = await db.get(Operation, job.input["operationId"])
    replica = await db.get(Replica, job.input["replicaId"])
    if (operation is None or operation.details.get("prune_job_id") != job.id
            or packet.get("operationId") != operation.id or packet.get("replicaId") != job.input["replicaId"]
            or packet.get("removed") is not True or operation.state != "completed" or replica is None or replica.state != "deleted"
            or job.cancel_requested_at is not None):
        raise ValueError("Model cleanup has no acknowledged exact-copy removal receipt.")
    return {"operation_id": operation.id, "replica_id": replica.id}


async def on_finished(db, job, result=None):
    operation = await db.get(Operation, job.input["operationId"])
    if (operation and operation.details.get("prune_job_id") == job.id
            and operation.state not in {"completed", "cancelled"} and job.state != "succeeded"):
        operation.state, operation.stage = "interrupted", "deleting"
        if operation.details.get("prune_failed_job_id") != job.id:
            failures = operation.details.get("prune_retry_count", 0) + 1
            delay = min(RETRY_SECONDS * 2 ** min(failures - 1, 6), MAX_RETRY_SECONDS)
            operation.details = {**operation.details, "prune_failed_job_id": job.id, "prune_retry_count": failures,
                "prune_retry_at": int(utcnow().timestamp()) + delay,
                "grant_generation": operation.details.get("grant_generation", 0) + 1}
        operation.error = {"message": job.last_error or "Model cleanup stopped. The server will retry after process cleanup."}
        operation.updated_at = utcnow()


async def require_external_control(db, job):
    raise HTTPException(409, "Control model cleanup through its Prediction operation.")
