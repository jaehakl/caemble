"""Attempt-scoped persistence for the launcher evaluation application."""

from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import select

from optimization.algorithm import evaluate_metrics
from optimization.db import StageSubmission, Optimization, Trial
from optimization.evaluations import ensure_evaluation, project_solver, submission_evaluations
from simulation.services.uploads import validate_artifact_item
from gpstation.db import JobRecord
from simulation.services.material_snapshot import material_vars_hash
from storage.service import bind_objects, download_parts, finish_upload, object_refs, owned_object, prepare_upload


async def failed_job(db, job, packet):
    """Record retryable admission failure in the transport's terminal transaction."""
    if job.input.get("stage") == "predict" and packet.get("code") == "prediction-resource-wait":
        job.artifact_metadata = {**(job.artifact_metadata or {}), "optimization_resource_wait": True}


async def stage_record(db, job, packet, attachments):
    stage = job.input["stage"]
    if attachments or packet.get("sequence") != 1 or packet.get("name") != stage:
        raise ValueError("Evaluation must record exactly its assigned stage result.")
    previous = await db.get(JobRecord, (job.id, job.attempt_count, 1))
    if previous:
        if previous.payload != packet["value"]:
            raise ValueError("A repeated evaluation result has different contents.")
        return
    optimization = await db.get(Optimization, job.artifact_metadata["optimization_id"])
    await bind_objects(db, packet["value"], user_id=job.user_id, experiment_id=optimization.experiment_id,
                       job_id=job.id, attempt=job.attempt_count, bind=False)
    db.add(JobRecord(job_id=job.id, attempt_count=job.attempt_count, sequence=1, name=stage, payload=packet["value"]))


async def complete_job(db, job, packet):
    submission = await db.scalar(select(StageSubmission).where(StageSubmission.job_id == job.id).with_for_update())
    trial = await db.get(Trial, submission.trial_id)
    optimization = await db.scalar(select(Optimization).where(Optimization.id == trial.optimization_id).with_for_update())
    if packet.get("recordSequences") != [1] or packet.get("definition_hash") != optimization.definition["hash"]:
        raise ValueError("Terminal evaluation differs from its frozen definition.")
    runtime_id = packet.get("runtime_id")
    if not runtime_id or (optimization.optimizer_state.get("runtime_id") and optimization.optimizer_state["runtime_id"] != runtime_id):
        raise ValueError("Evaluation runtime differs from the Optimization's first build.")
    record = await db.get(JobRecord, (job.id, job.attempt_count, 1))
    if record is None:
        raise ValueError("Evaluation result was not recorded.")
    value = record.payload
    evaluations = await submission_evaluations(db, submission)
    if not evaluations:
        evaluations = [await ensure_evaluation(db, optimization, trial)]
    if submission.stage == "build":
        item = validate_artifact_item(value.get("projection") or value["input"], optimization.definition["source_hash"])
        measurement = item["measurement"]
        if measurement["experiment"]["varsSchema"] != optimization.definition["vars_schema"]:
            raise ValueError("Optimization Vars schema differs from the saved source. Reload the Experiment before starting a new Optimization.")
        if measurement["varsHash"] != material_vars_hash(trial.variables):
            raise ValueError("Built candidate Vars differ from the assigned Trial.")
    elif submission.stage == "predict":
        expected = {(item.trial_id, item.id): item for item in evaluations}
        candidates = value.get("candidates", [])
        if len(candidates) != len(expected) or {(item["candidate_id"], item["evaluation_id"]) for item in candidates} != set(expected):
            raise ValueError("Prediction results differ from the assigned candidates.")
        for item in candidates:
            artifact = item.get("artifact")
            if not isinstance(artifact, dict) or artifact.get("kind") != "caemble.object":
                raise ValueError("Predicted BoxGrids must be retained as storage artifacts.")
            expected[(item["candidate_id"], item["evaluation_id"])].artifact = artifact
        provenance = value.get("provenance", {})
        hybrid = evaluations[0].source
        if any(item.source != hybrid for item in evaluations):
            raise ValueError("Prediction batch contains different frozen model sources.")
        if (provenance.get("model_id") != hybrid["model_id"] or provenance.get("revision") != hybrid["model_revision"]
                or provenance.get("checksum") != hybrid["checksum"]):
            raise ValueError("Prediction used another model revision or checksum.")
    else:
        evaluation = evaluations[0]
        if evaluation.kind == "prediction" and (value.get("evaluation_id") != evaluation.id or value.get("candidate_id") != trial.id):
            raise ValueError("Prediction Calculation used another candidate or evaluation.")
        if evaluation.kind == "solver" and value.get("measurement_id") != evaluation.measurement_id:
            raise ValueError("Calculation used another Measurement.")
        expected = {item["key"]: item["source_hash"] for item in optimization.definition["calculations"]}
        if {item["key"]: item["source_hash"] for item in value["calculations"]} != expected:
            raise ValueError("Calculation sources differ from the frozen Optimization definition.")
        evaluation.result = evaluate_metrics(value["calculations"], optimization.settings)
        project_solver(trial, evaluation)
    await bind_objects(db, value, user_id=job.user_id, experiment_id=optimization.experiment_id,
                       job_id=job.id, attempt=job.attempt_count)
    optimization.optimizer_state = {**optimization.optimizer_state, "runtime_id": runtime_id}
    submission.result = value
    return {"optimization_id": optimization.id, "trial_id": trial.id, "stage": submission.stage}


async def storage_packet(db, job, packet):
    operation = packet["type"].removeprefix("job.storage.")
    optimization = await db.get(Optimization, job.artifact_metadata["optimization_id"])
    if operation == "prepare":
        result = await prepare_upload(db, packet["manifest"], user_id=job.user_id, experiment_id=optimization.experiment_id,
                                      purpose="evaluation", job_id=job.id, attempt=job.attempt_count)
    elif operation == "complete":
        row = await owned_object(db, packet["object_id"], job.user_id)
        if row.job_id != job.id or row.attempt != job.attempt_count or row.purpose != "evaluation":
            raise HTTPException(403, "Object belongs to another evaluation attempt.")
        result = await finish_upload(db, row)
    elif operation == "read":
        if packet["reference"] not in list(object_refs(job.input)):
            raise HTTPException(403, "Object is not an assigned input.")
        result = await download_parts(db, packet["reference"])
    else:
        raise ValueError("Unknown storage operation.")
    return {"type": f"job.storage.{operation}.ack", **result}
