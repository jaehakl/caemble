"""Attempt-scoped child Predictor jobs for server-owned evaluations."""
from __future__ import annotations

import hashlib
import secrets
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import undefer
from prediction_contracts import resource_requirements

from gpstation.db import Job, Launcher
from gpstation.models import JobAnswerWaitResult, JobCreateRequest
from gpstation.service.execution import requested_resources, sync_attempt
from gpstation.service.job_orchestrator import job_orchestrator
from gpstation.service.job_service import JOB_TERMINAL_STATES, job_to_data
from prediction.db import ModelLease, ModelRevision, PredictionModel, Replica, StorageAccess

def resources_fit_together(resources: dict, report: dict, *, available: bool = False) -> bool:
    """Reserve room for the parent and its child before starting either process."""
    cpu = sum(value.get("cpu_cores", 1) for value in resources.values())
    ram = sum(value.get("startup_ram_bytes", 1) for value in resources.values())
    cpu_budget = report.get("cpu_total", 0)
    ram_budget = report.get("ram_budget_bytes", 0)
    if available:
        if not report.get("admission_open", True):
            return False
        cpu_budget -= report.get("cpu_reserved", 0)
        ram_budget -= report.get("ram_used_bytes", 0) + report.get("ram_startup_reserved_bytes", 0)
    demands = sorted((value.get("gpu_memory_bytes", 0) for value in resources.values()
                      for _ in range(value.get("gpu_count", 0))), reverse=True)
    devices = sorted((item.get("free_bytes" if available else "total_bytes", 0)
                      for item in report.get("gpu_devices", []) if isinstance(item, dict)
                      and (not available or not item.get("instance_id") and not item.get("reserved", False))), reverse=True)
    return (cpu <= cpu_budget and ram <= ram_budget and len(demands) <= len(devices)
            and all(required <= capacity for required, capacity in zip(demands, devices)))


async def validate_hybrid_capacity(db, launcher_id, user_id, definition: dict) -> dict:
    launcher = await db.get(Launcher, launcher_id)
    if launcher is None or launcher.user_id != user_id:
        raise HTTPException(404, "Predictor Launcher not found.")
    modes = launcher.job_modes or {}
    if (not {"evaluation", "predictor"}.issubset(launcher.slave_app_ids or [])
            or modes.get("evaluation") != "websocket" or modes.get("predictor", "webrtc") != "webrtc"):
        raise HTTPException(422, "Hybrid requires Evaluation and Predictor on the selected Launcher.")
    report = launcher.resources or {}
    try:
        requirements = resource_requirements(definition, "inference")
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    resources = {
        "evaluation": requested_resources({"cpu_cores": 1, "gpu_count": 0}, report, "evaluation", "cae.evaluation.predict"),
        "predictor": requested_resources({"cpu_cores": 1, **requirements}, report, "predictor", "predictor.hello"),
    }
    if not resources_fit_together(resources, report):
        raise HTTPException(422, "Launcher CPU, RAM or GPU budget cannot hold Evaluation and Predictor together.")
    return resources


async def predictor_parent_available(db, launcher_id, resources: dict) -> bool:
    # The caller holds this row lock until parent creation commits, serializing
    # admissions from independent Optimizations sharing this Launcher.
    launcher = await db.scalar(select(Launcher).where(Launcher.id == launcher_id).with_for_update())
    if launcher is None:
        return False
    report = launcher.resources or {}
    if not resources_fit_together(resources, report, available=True):
        return False
    active = await db.scalar(select(Job.id).where(Job.target_launcher_id == launcher_id,
        Job.slave_app_id == "evaluation", Job.input["stage"].astext == "predict",
        (~Job.state.in_(JOB_TERMINAL_STATES)) | (Job.launcher_id.is_not(None) & Job.cleaned_at.is_(None))).limit(1))
    if active is not None:
        return False
    child = await db.scalar(select(Job.id).where(Job.target_launcher_id == launcher_id,
        Job.artifact_metadata.has_key("optimization_parent"),
        (~Job.state.in_(JOB_TERMINAL_STATES)) | (Job.launcher_id.is_not(None) & Job.cleaned_at.is_(None))).limit(1))
    return child is None


async def authorized_parent(db, parent_id, attempt_id, authorization, *, cleanup=False):
    token = authorization.removeprefix("Bearer ") if authorization.startswith("Bearer ") else ""
    parent = await db.scalar(select(Job).where(Job.id == parent_id).with_for_update().execution_options(populate_existing=True))
    if (not token or parent is None or parent.job_mode != "websocket" or parent.slave_app_id != "evaluation"
            or parent.attempt_id != attempt_id or not parent.input or parent.input.get("stage") != "predict"
            or not secrets.compare_digest(parent.worker_token_hash or "", hashlib.sha256(token.encode()).hexdigest())):
        raise HTTPException(403, "Credential does not cover this Evaluation attempt.")
    if not cleanup and (parent.state not in {"running", "assigned"} or parent.cancel_requested_at is not None):
        raise HTTPException(409, "Evaluation attempt is no longer active.")
    return parent


async def owned_child(db, parent, child_id):
    # GPStation wait-answer deliberately loads only signaling columns. Refresh
    # attribution explicitly rather than lazy-loading it from that identity map.
    child = await db.scalar(select(Job).where(Job.id == child_id)
        .options(undefer(Job.artifact_metadata)).execution_options(populate_existing=True))
    binding = (child.artifact_metadata or {}).get("optimization_parent") if child else None
    if (child is None or child.user_id != parent.user_id or binding != {
            "job_id": parent.id, "attempt_id": parent.attempt_id, "attempt_count": parent.attempt_count}):
        raise HTTPException(403, "Predictor job belongs to another Evaluation attempt.")
    return child


async def create_child(parent_id: str, attempt_id: str, body: JobCreateRequest,
                       authorization: str, db):
    parent = await authorized_parent(db, parent_id, attempt_id, authorization)
    if body.slave_app_id != "predictor" or body.handler_type != "predictor.hello":
        raise HTTPException(403, "Evaluation can create only its assigned Predictor session.")
    hybrid = parent.input["hybrid"]
    launcher_id = hybrid["launcher_id"]
    if parent.launcher_id != launcher_id or parent.target_launcher_id != launcher_id:
        raise HTTPException(409, "Evaluation is running outside its pinned Predictor Launcher.")
    resources = hybrid["resources"]
    binding = {"job_id": parent.id, "attempt_id": parent.attempt_id, "attempt_count": parent.attempt_count}
    previous = await db.scalar(select(Job).where(Job.artifact_metadata["optimization_parent"] == binding))
    if previous is not None:
        if previous.offer != body.offer:
            raise HTTPException(409, "This Evaluation attempt already owns a Predictor session.")
        child = previous
    else:
        # Lock the revision before creating the child and lease so deletion cannot
        # observe an unleased live child between the two writes.
        model = await db.scalar(select(PredictionModel).where(PredictionModel.id == hybrid["model_id"]).with_for_update())
        revision = await db.get(ModelRevision, (hybrid["model_id"], hybrid["revision"]))
        replica = await db.get(Replica, hybrid["replica_id"])
        if (model is None or model.user_id != parent.user_id or model.state != "active" or model.direction != "forward"
                or revision is None or revision.state != "ready" or replica is None or replica.state != "present"
                or replica.model_id != model.id or replica.revision != hybrid["revision"]
                or replica.storage_id != hybrid["storage_id"] or replica.manifest_sha256 != hybrid["checksum"]
                or not revision.artifact or revision.artifact.get("manifest_sha256") != hybrid["checksum"]
                or not await db.get(StorageAccess, (hybrid["storage_id"], launcher_id))):
            raise HTTPException(409, "The pinned model revision or verified copy is unavailable.")
        child = Job(id=str(uuid4()), user_id=parent.user_id, slave_app_id="predictor", handler_type="predictor.hello",
            job_mode="webrtc", target_launcher_id=launcher_id, offer=body.offer, state="queued", progress=[],
            resources=resources["predictor"], attempt_count=1, attempt_id=str(uuid4()),
            artifact_metadata={"optimization_parent": binding,
                               "optimization_id": (parent.artifact_metadata or {}).get("optimization_id")})
        db.add(child)
        await db.flush()
        db.add(ModelLease(model_id=model.id, revision=hybrid["revision"], job_id=child.id,
                          storage_id=hybrid["storage_id"], replica_id=replica.id))
        await sync_attempt(db, child)
    result = {"job": job_to_data(child),
        "answer_wait_url": f"/optimization/evaluation/{parent_id}/attempts/{attempt_id}/predictor-jobs/{child.id}/wait-answer"}
    await db.commit()
    job_orchestrator.wake_dispatcher()
    return result


async def wait_answer(parent_id: str, attempt_id: str, child_id: str,
                      wait_seconds: float, authorization: str, db):
    parent = await authorized_parent(db, parent_id, attempt_id, authorization)
    await owned_child(db, parent, child_id)
    user_id = parent.user_id
    await db.commit()
    child = await job_orchestrator.wait_for_answer(db, job_id=child_id, user_id=user_id, wait_seconds=wait_seconds)
    # Waiting never retains the parent lock, and a superseded attempt receives no SDP.
    parent = await authorized_parent(db, parent_id, attempt_id, authorization)
    await owned_child(db, parent, child_id)
    if child is None:
        raise HTTPException(404, "Predictor job no longer exists.")
    return JobAnswerWaitResult(job_id=child.id, launcher_id=child.launcher_id, boot_id=child.boot_id,
        instance_id=child.instance_id, attempt_id=child.attempt_id, reservation_id=child.reservation_id,
        attempt_count=child.attempt_count, state=child.state, answer=child.answer, last_error=child.last_error)


async def kill_child(parent_id: str, attempt_id: str, child_id: str,
                     authorization: str, db):
    parent = await authorized_parent(db, parent_id, attempt_id, authorization, cleanup=True)
    child = await owned_child(db, parent, child_id)
    await db.commit()
    await job_orchestrator.kill_job(db, job_id=child.id, user_id=child.user_id, reason="Evaluation Predictor cleanup")
    return {"ok": True}


async def reconcile_children(db) -> None:
    children = list((await db.scalars(select(Job).where(
        Job.artifact_metadata.has_key("optimization_parent"),
        (~Job.state.in_(JOB_TERMINAL_STATES)) | (Job.launcher_id.is_not(None) & Job.cleaned_at.is_(None))))).all())
    for child in children:
        binding = child.artifact_metadata["optimization_parent"]
        parent = await db.get(Job, binding["job_id"])
        if (parent is None or parent.attempt_id != binding["attempt_id"] or parent.state in JOB_TERMINAL_STATES
                or parent.cancel_requested_at is not None):
            await job_orchestrator.kill_job(db, job_id=child.id, user_id=child.user_id, reason="Evaluation parent ended or was replaced")
    # Resource and disk leases are released only after launcher process reaping.
    await db.execute(delete(ModelLease).where(ModelLease.job_id.in_(select(Job.id).where(
        Job.artifact_metadata.has_key("optimization_parent"), Job.state.in_(JOB_TERMINAL_STATES),
        Job.cleaned_at.is_not(None) | Job.launcher_id.is_(None)))))
    await db.commit()
