"""Attempt-scoped persistence for the launcher evaluation application."""

from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import select

from optimization.algorithm import evaluate_metrics
from optimization.db import StageSubmission, Study, Trial
from simulation.services.uploads import validate_artifact_item
from gpstation.db import JobRecord
from simulation.services.material_snapshot import material_vars_hash
from storage.service import bind_objects, download_parts, finish_upload, object_refs, owned_object, prepare_upload


async def stage_record(db, job, packet, attachments):
    stage = job.input["stage"]
    if attachments or packet.get("sequence") != 1 or packet.get("name") != stage:
        raise ValueError("Evaluation must record exactly its assigned stage result.")
    previous = await db.get(JobRecord, (job.id, job.attempt_count, 1))
    if previous:
        if previous.payload != packet["value"]:
            raise ValueError("A repeated evaluation result has different contents.")
        return
    study = await db.get(Study, job.artifact_metadata["study_id"])
    await bind_objects(db, packet["value"], user_id=job.user_id, experiment_id=study.experiment_id,
                       job_id=job.id, attempt=job.attempt_count, bind=False)
    db.add(JobRecord(job_id=job.id, attempt_count=job.attempt_count, sequence=1, name=stage, payload=packet["value"]))


async def complete_job(db, job, packet):
    submission = await db.scalar(select(StageSubmission).where(StageSubmission.job_id == job.id).with_for_update())
    trial = await db.get(Trial, submission.trial_id)
    study = await db.scalar(select(Study).where(Study.id == trial.study_id).with_for_update())
    if packet.get("recordSequences") != [1] or packet.get("definition_hash") != study.definition["hash"]:
        raise ValueError("Terminal evaluation differs from its frozen definition.")
    runtime_id = packet.get("runtime_id")
    if not runtime_id or (study.optimizer_state.get("runtime_id") and study.optimizer_state["runtime_id"] != runtime_id):
        raise ValueError("Evaluation runtime differs from the Study's first build.")
    record = await db.get(JobRecord, (job.id, job.attempt_count, 1))
    if record is None:
        raise ValueError("Evaluation result was not recorded.")
    value = record.payload
    if submission.stage == "build":
        item = validate_artifact_item(value.get("projection") or value["input"], study.definition["source_hash"])
        measurement = item["measurement"]
        if measurement["experiment"]["varsSchema"] != study.definition["vars_schema"]:
            raise ValueError("Study Vars schema differs from the saved source. Reload the Experiment before starting a new Study.")
        if measurement["varsHash"] != material_vars_hash(trial.variables):
            raise ValueError("Built candidate Vars differ from the assigned Trial.")
    else:
        if value.get("measurement_id") != trial.measurement_id:
            raise ValueError("Calculation used another Measurement.")
        expected = {item["key"]: item["source_hash"] for item in study.definition["calculations"]}
        if {item["key"]: item["source_hash"] for item in value["calculations"]} != expected:
            raise ValueError("Calculation sources differ from the frozen Study definition.")
        trial.result = evaluate_metrics(value["calculations"], study.settings)
    await bind_objects(db, value, user_id=job.user_id, experiment_id=study.experiment_id,
                       job_id=job.id, attempt=job.attempt_count)
    study.optimizer_state = {**study.optimizer_state, "runtime_id": runtime_id}
    submission.result = value
    return {"study_id": study.id, "trial_id": trial.id, "stage": submission.stage}


async def storage_packet(db, job, packet):
    operation = packet["type"].removeprefix("job.storage.")
    study = await db.get(Study, job.artifact_metadata["study_id"])
    if operation == "prepare":
        result = await prepare_upload(db, packet["manifest"], user_id=job.user_id, experiment_id=study.experiment_id,
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
