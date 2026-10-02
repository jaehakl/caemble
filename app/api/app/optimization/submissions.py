"""Submit one immutable existing Batch/Job for one Optimization evaluation stage."""

from __future__ import annotations

import hashlib
import json
import uuid

from fastapi import HTTPException
from sqlalchemy import func, select

from simulation.db import CaeBatch
from optimization.db import StageSubmission, EvaluationSubmission
from optimization.evaluations import ensure_evaluation, project_solver, require_solver_budget
from simulation.services.uploads import validate_measurement_registration
from simulation.db import Measurement
from gpstation.db import Job, JobBatch
from gpstation.service.batches import add_event
from simulation.services.measurements import recorded_data_for_measurement


async def submit_stage(db, optimization, trial, catalog, evaluation=None):
    evaluation = evaluation or await ensure_evaluation(db, optimization, trial)
    stage = evaluation.next_stage
    definition = optimization.definition
    if definition["catalog_revision"] != catalog.meta()["catalogRevision"]:
        raise HTTPException(409, "Optimization Catalog revision is unavailable. Restore its Catalog to resume.")
    payload = {"stage": stage, "definition_hash": definition["hash"], "storage_version": 1}
    runtime_id = optimization.optimizer_state.get("runtime_id")
    if runtime_id:
        payload["runtime_id"] = runtime_id
    materials = None
    artifact = None
    if stage == "build":
        payload["build"] = {"source_bundle": definition["source_bundle"], "source_hash": definition["source_hash"],
                            "catalog": definition["catalog"], "mode": "candidate", "vars": trial.variables}
    elif stage == "solve":
        await require_solver_budget(db, optimization)
        built = await db.scalar(select(StageSubmission).where(
            StageSubmission.trial_id == trial.id, StageSubmission.stage == "build", StageSubmission.state == "succeeded",
        ).order_by(StageSubmission.generation.desc()))
        if built is None or built.result is None:
            raise ValueError("A solve stage requires its completed build.")
        artifact = built.result["input"]
        item = built.result.get("projection") or artifact
        payload = {"measurement": item["measurement"], "storage_version": 1}
        if artifact.get("kind") == "caemble.object":
            payload["artifact"] = artifact
        materials = validate_measurement_registration(
            item["measurement"], source_bundle=definition["source_bundle"], result_contracts=definition["result_contracts"],
            source_hash=definition["source_hash"], catalog=catalog,
        )
    elif stage == "calculate" and evaluation.kind == "prediction":
        if evaluation.artifact is None:
            raise ValueError("Prediction Calculation requires its saved BoxGrid artifact.")
        payload.update(prediction=evaluation.artifact, evaluation_id=evaluation.id, candidate_id=trial.id,
                       calculations=definition["calculations"])
    elif stage == "calculate":
        if evaluation.measurement_id is None:
            raise ValueError("Calculation requires a recorded Measurement.")
        measurement = await db.get(Measurement, evaluation.measurement_id)
        if measurement is None or measurement.user_id != optimization.user_id or measurement.experiment_id != optimization.experiment_id:
            raise ValueError("Calculation requires the Measurement owned by this Optimization.")
        # Creation already authorized the frozen Experiment. The controller has
        # no interactive user session (including an administrator's role set).
        recorded = await recorded_data_for_measurement(db, measurement)
        payload.update(measurement_id=evaluation.measurement_id, recorded_data=recorded.model_dump()["recorded_data"],
                       calculations=definition["calculations"])
    else:
        raise ValueError(f"Unknown evaluation stage: {stage}")
    generation = 1 + (await db.scalar(select(func.coalesce(func.max(StageSubmission.generation), 0)).where(
        StageSubmission.trial_id == trial.id, StageSubmission.stage == stage,
    )))
    request_id = str(uuid.uuid5(uuid.UUID(trial.id), f"{stage}:{generation}"))
    batch = JobBatch(user_id=optimization.user_id, request_id=request_id,
                     request_hash=hashlib.sha256(request_id.encode()).hexdigest(), total=1, created_count=1,
                     uploaded_count=1, succeeded=0, failed=0, cancelled=0, state="queued", generation_stopped=True,
                     last_event_id=0, read_event_id=0)
    db.add(batch)
    await db.flush()
    handler = "cae.simulation" if stage == "solve" else f"cae.evaluation.{stage}"
    metadata = {"optimization_id": optimization.id, "trial_id": trial.id, "evaluation_id": evaluation.id,
                "stage": stage, "generation": generation}
    if evaluation.manual_retry_requested:
        metadata["retry_request_id"] = evaluation.retry_request_id
    if stage == "solve":
        raw = json.dumps(artifact, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()
        metadata.update(input_hash=artifact.get("sha256", hashlib.sha256(raw).hexdigest()),
                        byte_length=artifact.get("byteLength", len(raw)), index=1)
        if "presentation" in artifact:
            metadata["presentation"] = artifact["presentation"]
    job = Job(user_id=optimization.user_id, batch_id=batch.id, item_index=1, handler_type=handler,
              slave_app_id="cae" if stage == "solve" else "evaluation", job_mode="websocket",
              state="queued", attempt_count=1, attempt_id=str(uuid.uuid4()), offer={}, progress=[], input=payload,
              resources={} if stage == "solve" else {"cpu_cores": 1, "gpu_count": 0}, artifact_metadata=metadata)
    db.add(job)
    await db.flush()
    if stage == "solve":
        db.add(CaeBatch(batch_id=batch.id, experiment_id=optimization.experiment_id, spec={
            "mode": "candidate", "source_hash": definition["source_hash"], "catalog_revision": definition["catalog_revision"],
            "builder_version": "2", "storage_version": 1, "committed": True, "optimization_id": optimization.id,
        }))
        measurement = await db.get(Measurement, evaluation.measurement_id) if evaluation.measurement_id else None
        if measurement is None:
            measurement = Measurement(user_id=optimization.user_id, experiment_id=optimization.experiment_id,
                                      vars=trial.variables, material_snapshot=materials, job_id=job.id)
            db.add(measurement)
            await db.flush()
            evaluation.measurement_id = measurement.id
        else:
            if measurement.recorded_at is not None:
                raise ValueError("Completed Solver results must be reused instead of resubmitted.")
            # The controller waits for the prior attempt cleanup before rebinding
            # this unrecorded Measurement to a fresh immutable submission.
            measurement.job_id = job.id
        job.artifact_metadata = {**metadata, "measurement_id": measurement.id}
    submission = StageSubmission(trial_id=trial.id, stage=stage, generation=generation,
                                 batch_id=batch.id, job_id=job.id, state="queued")
    db.add(submission)
    await db.flush()
    db.add(EvaluationSubmission(evaluation_id=evaluation.id, submission_id=submission.id))
    evaluation.state = "running"
    evaluation.error = None
    project_solver(trial, evaluation)
    await add_event(db, batch, "batch.created", job=job)
    await add_event(db, batch, "job.queued", job=job,
                    payload={"measurement_id": trial.measurement_id} if trial.measurement_id else None)
    return submission


async def submit_predictions(db, optimization, candidates):
    """One physical Job owns up to 32 candidate evaluations and one model session."""
    from optimization.predictor_jobs import predictor_parent_available, resources_from_frozen_hybrid

    hybrid = candidates[0][1].source
    if any(evaluation.source != hybrid for _, evaluation in candidates):
        raise ValueError("A prediction batch must use one frozen model source.")
    hybrid = {**hybrid, "resources": resources_from_frozen_hybrid(hybrid["resources"])}
    if not await predictor_parent_available(db, hybrid["launcher_id"], hybrid["resources"]):
        return None
    definition = optimization.definition
    first_trial, _ = candidates[0]
    generation = 1 + (await db.scalar(select(func.coalesce(func.max(StageSubmission.generation), 0)).where(
        StageSubmission.trial_id == first_trial.id, StageSubmission.stage == "predict")))
    request_id = str(uuid.uuid5(uuid.UUID(first_trial.id), f"predict:{generation}"))
    batch = JobBatch(user_id=optimization.user_id, request_id=request_id,
        request_hash=hashlib.sha256(request_id.encode()).hexdigest(), total=1, created_count=1,
        uploaded_count=1, succeeded=0, failed=0, cancelled=0, state="queued", generation_stopped=True,
        last_event_id=0, read_event_id=0)
    db.add(batch)
    await db.flush()
    payload = {"stage": "predict", "definition_hash": definition["hash"], "storage_version": 1,
        "hybrid": {**hybrid, "revision": hybrid["model_revision"]}, "model_definition": hybrid["model_definition"],
        "record_names": [record["name"] for record in hybrid["source_contracts"]["records"]],
        "candidates": [{"candidate_id": trial.id, "evaluation_id": evaluation.id, "build": {
            "source_bundle": definition["source_bundle"], "source_hash": definition["source_hash"],
            "catalog": definition["catalog"], "mode": "candidate", "vars": trial.variables,
        }} for trial, evaluation in candidates]}
    if optimization.optimizer_state.get("runtime_id"):
        payload["runtime_id"] = optimization.optimizer_state["runtime_id"]
    job = Job(user_id=optimization.user_id, batch_id=batch.id, item_index=1,
        handler_type="cae.evaluation.predict", slave_app_id="evaluation", job_mode="websocket",
        target_launcher_id=hybrid["launcher_id"], state="queued", attempt_count=1, attempt_id=str(uuid.uuid4()),
        offer={}, progress=[], input=payload, resources=hybrid["resources"]["evaluation"],
        artifact_metadata={"optimization_id": optimization.id, "trial_id": first_trial.id,
                           "stage": "predict", "generation": generation})
    db.add(job)
    await db.flush()
    submission = StageSubmission(trial_id=first_trial.id, stage="predict", generation=generation,
        batch_id=batch.id, job_id=job.id, state="queued")
    db.add(submission)
    await db.flush()
    for _, evaluation in candidates:
        db.add(EvaluationSubmission(evaluation_id=evaluation.id, submission_id=submission.id))
        evaluation.state, evaluation.error = "running", None
    await add_event(db, batch, "batch.created", job=job)
    await add_event(db, batch, "job.queued", job=job)
    return submission
