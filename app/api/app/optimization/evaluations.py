"""Evaluation identity, compatibility projections and strict physical Solver budgets."""
from fastapi import HTTPException
from sqlalchemy import func, select
from prediction_contracts import validate_definition

from gpstation.db import Job
from gpstation.service.batches import SERVER_ACTIVE_STATES
from optimization.db import Evaluation, EvaluationSubmission, StageSubmission
from prediction.common import digest


async def ensure_evaluation(db, optimization, trial, kind="solver"):
    source = (optimization.definition["hybrid"] if kind == "prediction" else {
        "source_hash": optimization.definition["source_hash"],
        "catalog_revision": optimization.definition.get("catalog_revision"),
    })
    source_hash = digest(source) if kind == "prediction" else source["source_hash"]
    evaluation = await db.scalar(select(Evaluation).where(
        Evaluation.optimization_id == optimization.id, Evaluation.fingerprint == trial.fingerprint,
        Evaluation.kind == kind, Evaluation.definition_hash == optimization.definition["hash"],
        Evaluation.source_hash == source_hash,
    ))
    if evaluation is None:
        legacy = kind == "solver" and not optimization.settings.get("hybrid")
        evaluation = Evaluation(optimization_id=optimization.id, trial_id=trial.id,
            fingerprint=trial.fingerprint, kind=kind, definition_hash=optimization.definition["hash"],
            source_hash=source_hash, source=source, state=trial.state if legacy else "pending",
            next_stage=trial.next_stage if legacy else ("predict" if kind == "prediction" else "build"),
            measurement_id=trial.measurement_id if legacy else None, result=trial.result if legacy else None,
            error=trial.error if legacy else None, manual_retry_requested=trial.manual_retry_requested if legacy else False,
            retry_request_id=trial.retry_request_id if legacy else None, retry_requests=list(trial.retry_requests or []) if legacy else [])
        db.add(evaluation)
        await db.flush()
        if legacy:
            for submission in (await db.scalars(select(StageSubmission).where(StageSubmission.trial_id == trial.id))).all():
                db.add(EvaluationSubmission(evaluation_id=evaluation.id, submission_id=submission.id))
    return evaluation


def project_solver(trial, evaluation):
    from gpstation.service.state import utcnow
    if evaluation.kind != "solver":
        return
    for key in ("state", "next_stage", "measurement_id", "result", "error", "manual_retry_requested",
                "retry_request_id", "retry_requests"):
        setattr(trial, key, getattr(evaluation, key))
    trial.updated_at = utcnow()


async def submission_evaluations(db, submission):
    return list((await db.scalars(select(Evaluation).join(EvaluationSubmission,
        EvaluationSubmission.evaluation_id == Evaluation.id).where(
        EvaluationSubmission.submission_id == submission.id))).all())


async def solver_budget(db, optimization):
    hybrid = optimization.settings.get("hybrid")
    if hybrid is None:
        return None
    used, reserved = (await db.execute(select(
        func.count().filter(Job.started_at.is_not(None)),
        func.count().filter(Job.started_at.is_(None) & Job.state.in_(SERVER_ACTIVE_STATES)),
    ).join(StageSubmission, StageSubmission.job_id == Job.id)
      .join(EvaluationSubmission, EvaluationSubmission.submission_id == StageSubmission.id)
      .join(Evaluation, Evaluation.id == EvaluationSubmission.evaluation_id)
      .where(Evaluation.optimization_id == optimization.id, StageSubmission.stage == "solve"))).one()
    limit = hybrid["max_solver_runs"]
    return {"limit": limit, "used": used, "reserved": reserved, "remaining": max(0, limit - used - reserved)}


async def require_solver_budget(db, optimization):
    budget = await solver_budget(db, optimization)
    if budget is not None and budget["remaining"] == 0:
        raise HTTPException(409, "The strict Solver execution budget is exhausted.")


async def freeze_hybrid(db, request, user_id, experiment, calculations):
    from prediction.common import connected_storage
    from prediction.db import ModelRevision, PredictionModel, Replica
    from optimization.predictor_jobs import validate_hybrid_capacity

    model = await db.scalar(select(PredictionModel).where(PredictionModel.id == str(request.model_id)).with_for_update())
    revision = await db.get(ModelRevision, (str(request.model_id), request.model_revision))
    replica = await db.get(Replica, str(request.replica_id))
    if model is None or model.user_id != user_id or model.experiment_id != experiment.id:
        raise HTTPException(404, "Owned model for this Experiment not found.")
    if model.state != "active" or model.direction != "forward" or revision is None or revision.state != "ready":
        raise HTTPException(409, "Hybrid requires the exact saved, ready Forward revision.")
    try:
        validate_definition(revision.definition)
    except ValueError as error:
        raise HTTPException(409, "The saved Forward model implementation is not supported.") from error
    checksum = (revision.artifact or {}).get("manifest_sha256")
    if (not checksum or replica is None or replica.model_id != model.id or replica.revision != request.model_revision
            or replica.state != "present" or replica.manifest_sha256 != checksum):
        raise HTTPException(409, "Verify the selected replica of the exact model revision before starting Hybrid.")
    await connected_storage(db, replica.storage_id, str(request.launcher_id), user_id)
    contracts = revision.source_contracts
    if (contracts.get("sourceHash") != experiment.source_hash or contracts.get("resultContracts") != experiment.result_contracts):
        raise HTTPException(409, "Model source or result contracts differ from the saved Experiment.")
    records = {item["name"]: item for item in contracts.get("records", [])}
    for calculation in calculations:
        for record in calculation["records"]:
            predicted = records.get(record["name"])
            if predicted is None or predicted.get("data_schema") != record["data_schema"]:
                raise HTTPException(422, "The model must predict compatible Records for every objective and constraint.")
    resources = await validate_hybrid_capacity(db, str(request.launcher_id), user_id, revision.definition)
    return {**request.model_dump(mode="json"), "storage_id": replica.storage_id, "checksum": checksum,
        "dataset_id": revision.dataset_id, "dataset_revision": revision.dataset_revision,
        "dataset_fingerprint": revision.dataset_fingerprint, "model_definition": revision.definition,
        "source_contracts": contracts, "resources": resources}
