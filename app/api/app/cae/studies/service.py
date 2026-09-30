from __future__ import annotations

import hashlib
import json

from fastapi import HTTPException
from sqlalchemy import delete, func, select

from cae.batches import job_snapshot
from cae.source_bundle import require_experiment_source_bundle
from cae.studies.db import StageSubmission, Study, Trial
from cae.studies.models import StudyCreateRequest
from db import Calculation, CalculationExperimentRecord, CalculationSource, Experiment, ExperimentRecord
from gpstation.db import Job
from gpstation.service.batches import SERVER_ACTIVE_STATES, serialize_events
from gpstation.service.state import utcnow
from utils.crud.common import is_admin_user


async def require_study(db, study_id: str, user, *, lock: bool = False) -> Study:
    query = select(Study).where(Study.id == study_id)
    if not is_admin_user(user):
        query = query.where(Study.user_id == user.id)
    study = await db.scalar(query.with_for_update() if lock else query)
    if study is None:
        raise HTTPException(404, "Study not found.")
    return study


async def create_study(db, request: StudyCreateRequest, user, catalog) -> Study:
    from cae.studies.algorithm import prepare_axes

    await serialize_events(db)
    payload = request.model_dump(mode="json")
    try:
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                                          allow_nan=False).encode("utf-8")).hexdigest()
    except ValueError as error:
        raise HTTPException(422, "Study inputs must contain finite numeric values.") from error
    existing = await db.scalar(select(Study).where(Study.user_id == user.id, Study.request_id == str(request.request_id)))
    if existing is not None:
        if existing.request_hash != digest:
            raise HTTPException(409, "This request_id was already used for a different Study.")
        await db.commit()
        return existing
    experiment = await db.scalar(select(Experiment).where(Experiment.id == request.experiment_id).with_for_update())
    if experiment is None or (not is_admin_user(user) and experiment.user_id != user.id):
        raise HTTPException(404, "Saved Experiment not found.")
    if experiment.source_hash != request.source_hash:
        raise HTTPException(409, "Save the current Experiment version before starting optimization.")
    require_experiment_source_bundle(experiment.source_bundle)
    try:
        axes = prepare_axes(request.vars_schema, request.initial_vars,
                            [axis.model_dump(exclude_none=True) for axis in request.axes] if request.axes is not None else None)
    except (ValueError, TypeError, KeyError) as error:
        raise HTTPException(422, str(error)) from error
    requested = [("objective", request.objective.calculation_id)] + [
        (f"constraint:{index}", item.calculation_id) for index, item in enumerate(request.constraints)
    ]
    ids = sorted({calculation_id for _, calculation_id in requested})
    source_ids = (await db.scalars(select(Calculation.source_id).where(Calculation.id.in_(ids)))).all()
    await db.scalars(select(CalculationSource).where(CalculationSource.id.in_(source_ids)).order_by(CalculationSource.id).with_for_update())
    calculations = list((await db.scalars(select(Calculation).where(Calculation.id.in_(ids))
                                         .order_by(Calculation.id).with_for_update())).all())
    by_id = {item.id: item for item in calculations}
    if set(by_id) != set(ids) or any(item.experiment_id != experiment.id for item in calculations):
        raise HTTPException(422, "Objective and constraints must be saved Calculations in this Experiment.")
    bindings = (await db.execute(select(CalculationExperimentRecord.calculation_id, ExperimentRecord)
                                .join(ExperimentRecord, ExperimentRecord.id == CalculationExperimentRecord.experiment_record_id)
                                .where(CalculationExperimentRecord.calculation_id.in_(ids)))).all()
    records = {calculation_id: [] for calculation_id in ids}
    for calculation_id, record in bindings:
        records[calculation_id].append({"id": record.id, "name": record.name, "data_schema": record.data_schema})
    frozen_calculations = [{"key": key, "calculation_id": item.id, "source": item.source.source_code,
                            "source_hash": item.source.source_hash, "source_revision": item.source.revision,
                            "output_layout": item.output_layout, "records": records[item.id]}
                           for key, calculation_id in requested for item in [by_id[calculation_id]]]
    runtime_catalog = catalog.runtime_slice(
        solvers=[(item["name"], item["version"]) for item in catalog.list_solvers()],
        quantity_kinds=[item["name"] for item in catalog.list_quantity_kinds(limit=-1)[0]],
        material_models=[item["key"] for item in catalog.material_models()],
    )
    definition = {"source_bundle": experiment.source_bundle, "source_hash": experiment.source_hash,
                  "result_contracts": experiment.result_contracts, "catalog_revision": catalog.meta()["catalogRevision"],
                  "catalog": runtime_catalog, "vars_schema": request.vars_schema, "calculations": frozen_calculations}
    definition["hash"] = hashlib.sha256(json.dumps(definition, sort_keys=True, separators=(",", ":"),
                                                   ensure_ascii=False, allow_nan=False).encode("utf-8")).hexdigest()
    settings = {"initial_vars": request.initial_vars, "axes": axes,
                "objective": {"direction": request.objective.direction},
                "constraints": [{"key": f"constraint:{index}", **item.model_dump(exclude={"calculation_id"}, exclude_none=True)}
                                for index, item in enumerate(request.constraints)],
                "max_trials": request.max_trials, "max_parallel": request.max_parallel,
                "initial_step": 0.25, "min_step": 0.001}
    study = Study(user_id=user.id, experiment_id=experiment.id,
                  name=request.name.strip() if request.name and request.name.strip() else f"{experiment.name} optimization",
                  request_id=str(request.request_id), request_hash=digest, state="running", definition=definition,
                  settings=settings, optimizer_state={})
    db.add(study)
    await db.commit()
    return study


async def study_summaries(db, studies: list[Study]) -> list[dict]:
    ids = [study.id for study in studies]
    if not ids:
        return []
    counts = (await db.execute(select(Trial.study_id, Trial.state, func.count(), func.count().filter(Trial.manual_retry_requested),
                                     func.sum(func.jsonb_array_length(Trial.retry_requests)))
                              .where(Trial.study_id.in_(ids)).group_by(Trial.study_id, Trial.state))).all()
    by_study = {study.id: {} for study in studies}
    manual_retries = {study.id: False for study in studies}
    retry_counts = {study.id: 0 for study in studies}
    for study_id, state, count, active_retries, retry_count in counts:
        by_study[study_id][state] = count
        manual_retries[study_id] = manual_retries[study_id] or bool(active_retries)
        retry_counts[study_id] += retry_count
    executions = (await db.execute(select(Trial.study_id,
        func.count().filter(Job.state.in_(SERVER_ACTIVE_STATES)),
        func.bool_or(Job.launcher_id.is_not(None) & Job.cleaned_at.is_(None)))
        .join(StageSubmission, StageSubmission.trial_id == Trial.id).join(Job, Job.id == StageSubmission.job_id)
        .where(Trial.study_id.in_(ids)).group_by(Trial.study_id))).all()
    execution_status = {study_id: (active, bool(cleanup)) for study_id, active, cleanup in executions}
    best_ids = [study.best_trial_id for study in studies if study.best_trial_id]
    best = {trial.id: trial for trial in (await db.scalars(select(Trial).where(Trial.id.in_(best_ids)))).all()} if best_ids else {}
    result = []
    for study in studies:
        totals, winner = by_study[study.id], best.get(study.best_trial_id)
        result.append({"id": study.id, "name": study.name, "experiment_id": study.experiment_id,
                       "state": study.state, "pause_reason": study.pause_reason,
                       "created_at": study.created_at, "updated_at": study.updated_at, "finished_at": study.finished_at,
                       "max_trials": study.settings["max_trials"], "max_parallel": study.settings["max_parallel"],
                       "trial_count": sum(totals.values()), "succeeded": totals.get("succeeded", 0),
                       "retry_count": retry_counts[study.id],
                       "failed": totals.get("failed", 0), "cancelled": totals.get("cancelled", 0),
                       "active": sum(value for state, value in totals.items() if state not in {"succeeded", "failed", "cancelled"}),
                       "executions_active": execution_status.get(study.id, (0, False))[0],
                       "cleanup_pending": execution_status.get(study.id, (0, False))[1],
                       "manual_retry_pending": manual_retries[study.id],
                       "best_trial": {"id": winner.id, "ordinal": winner.ordinal, "variables": winner.variables,
                                      "result": winner.result, "measurement_id": winner.measurement_id} if winner else None})
    return result


async def study_detail(db, study: Study) -> dict:
    summary = (await study_summaries(db, [study]))[0]
    return {**summary, "definition": study.definition, "settings": study.settings, "optimizer_state": study.optimizer_state}


async def list_studies(db, user, *, experiment_id: int | None, limit: int, offset: int) -> dict:
    query = select(Study)
    if not is_admin_user(user):
        query = query.where(Study.user_id == user.id)
    if experiment_id is not None:
        query = query.where(Study.experiment_id == experiment_id)
    total = await db.scalar(select(func.count()).select_from(query.subquery()))
    studies = list((await db.scalars(query.order_by(Study.created_at.desc(), Study.id).limit(limit).offset(offset))).all())
    return {"total": total, "items": await study_summaries(db, studies)}


async def list_trials(db, study: Study, *, limit: int, offset: int) -> dict:
    total = await db.scalar(select(func.count()).select_from(Trial).where(Trial.study_id == study.id))
    trials = list((await db.scalars(select(Trial).where(Trial.study_id == study.id)
                                  .order_by(Trial.ordinal).limit(limit).offset(offset))).all())
    stages = (await db.execute(select(StageSubmission, Job).outerjoin(Job, Job.id == StageSubmission.job_id)
                              .where(StageSubmission.trial_id.in_([trial.id for trial in trials]))
                              .order_by(StageSubmission.created_at, StageSubmission.generation))).all()
    grouped = {trial.id: [] for trial in trials}
    measurements = {trial.id: trial.measurement_id for trial in trials}
    for stage, job in stages:
        grouped[stage.trial_id].append({"id": stage.id, "stage": stage.stage, "generation": stage.generation,
                                       "batch_id": stage.batch_id, "job_id": stage.job_id, "state": job.state if job else stage.state,
                                       "result": stage.result, "error": stage.error,
                                       "job": job_snapshot(job, measurements[stage.trial_id]) if job else None})
    return {"total": total, "items": [{**{key: getattr(trial, key) for key in (
        "id", "study_id", "ordinal", "round_index", "variables", "fingerprint", "state", "next_stage",
        "measurement_id", "result", "error", "manual_retry_requested", "created_at", "updated_at")},
        "retry_count": len(trial.retry_requests or []), "stages": grouped[trial.id]} for trial in trials]}


async def resume_study(db, study: Study) -> None:
    if study.state == "running":
        return
    if study.state != "paused":
        raise HTTPException(409, "Wait for the Study to pause before resuming.")
    unresolved = await db.scalar(select(Trial.id).where(Trial.study_id == study.id,
                                                       (Trial.state == "failed") | Trial.manual_retry_requested).limit(1))
    if unresolved is not None:
        raise HTTPException(409, "Retry failed Trials and wait for their completion before resuming.")
    active = await db.scalar(select(Job.id).join(StageSubmission, StageSubmission.job_id == Job.id)
                            .join(Trial, Trial.id == StageSubmission.trial_id).where(Trial.study_id == study.id,
                                Job.state.in_(SERVER_ACTIVE_STATES) | (Job.launcher_id.is_not(None) & Job.cleaned_at.is_(None))).limit(1))
    if active is not None:
        raise HTTPException(409, "Wait for Study executions and worker cleanup before resuming.")
    study.state, study.pause_reason, study.finished_at, study.updated_at = "running", None, None, utcnow()


async def delete_study(db, study: Study) -> None:
    if study.state not in {"paused", "completed"}:
        raise HTTPException(409, "Stop the Study before deleting its history.")
    if await db.scalar(select(Trial.id).where(Trial.study_id == study.id, Trial.manual_retry_requested).limit(1)) is not None:
        raise HTTPException(409, "Stop the manual retry before deleting its Study.")
    active = await db.scalar(select(Job.id).join(StageSubmission, StageSubmission.job_id == Job.id)
                            .join(Trial, Trial.id == StageSubmission.trial_id).where(Trial.study_id == study.id,
                                Job.state.in_(SERVER_ACTIVE_STATES) | (Job.launcher_id.is_not(None) & Job.cleaned_at.is_(None))).limit(1))
    if active is not None:
        raise HTTPException(409, "Wait for all Study workers to finish cleanup before deleting its history.")
    await db.execute(delete(Study).where(Study.id == study.id))


async def require_unreferenced_experiments(db, experiment_ids: list[int]) -> None:
    if await db.scalar(select(Study.id).where(Study.experiment_id.in_(experiment_ids)).limit(1)) is not None:
        raise HTTPException(409, "Delete retained Studies before changing or deleting their Experiment source. Use Save As for a new version.")


async def require_unreferenced_measurements(db, measurement_ids: list[int]) -> None:
    if await db.scalar(select(Trial.id).where(Trial.measurement_id.in_(measurement_ids)).limit(1)) is not None:
        raise HTTPException(409, "Delete the referencing Study before deleting its Measurements.")


async def require_unmanaged_execution(db, *, job_id: str | None = None, batch_id: str | None = None,
                                      user_id: str | None = None) -> None:
    query = select(Study.id).join(Trial, Trial.study_id == Study.id).join(StageSubmission, StageSubmission.trial_id == Trial.id)
    query = query.where(StageSubmission.job_id == job_id) if job_id is not None else query.where(StageSubmission.batch_id == batch_id)
    if user_id is not None:
        query = query.where(Study.user_id == user_id)
    study_id = await db.scalar(query.limit(1))
    if study_id is not None:
        raise HTTPException(409, {"code": "study_execution_managed", "message": "Control this execution from its Study.", "study_id": study_id})
