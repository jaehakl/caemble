from __future__ import annotations

import hashlib
import json

from fastapi import HTTPException
from sqlalchemy import delete, func, select

from simulation.services.batches import job_snapshot
from simulation.services.source_bundle import require_experiment_source_bundle
from optimization.db import Evaluation, EvaluationSubmission, StageSubmission, Optimization, Trial
from optimization.schemas import OptimizationCreateRequest
from calculation.db import Calculation, CalculationExperimentRecord, CalculationSource
from simulation.db import Experiment, ExperimentRecord
from gpstation.db import Job
from gpstation.service.batches import SERVER_ACTIVE_STATES, serialize_events
from gpstation.service.state import utcnow
from core.crud.common import is_admin_user


async def require_optimization(db, optimization_id: str, user, *, lock: bool = False) -> Optimization:
    query = select(Optimization).where(Optimization.id == optimization_id)
    if not is_admin_user(user):
        query = query.where(Optimization.user_id == user.id)
    optimization = await db.scalar(query.with_for_update() if lock else query)
    if optimization is None:
        raise HTTPException(404, "Optimization not found.")
    return optimization


async def create_optimization(db, request: OptimizationCreateRequest, user, catalog) -> Optimization:
    from optimization.algorithm import prepare_axes

    await serialize_events(db)
    payload = request.model_dump(mode="json")
    if payload.get("algorithm") is None:
        payload.pop("algorithm", None)  # Preserve create receipts predating strategy configuration.
    if payload.get("hybrid") is None:
        payload.pop("hybrid", None)  # Preserve existing Solver-only create receipts.
    elif payload["hybrid"].get("quality_requirements") is None:
        payload["hybrid"].pop("quality_requirements", None)  # Preserve Hybrid receipts made before quality limits.
    if payload.get("hybrid") and payload["hybrid"].get("verification_policy") is None:
        payload["hybrid"].pop("verification_policy", None)
    if payload.get("hybrid") and payload["hybrid"].get("model_update_policy") is None:
        payload["hybrid"].pop("model_update_policy", None)
    try:
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                                          allow_nan=False).encode("utf-8")).hexdigest()
    except ValueError as error:
        raise HTTPException(422, "Optimization inputs must contain finite numeric values.") from error
    existing = await db.scalar(select(Optimization).where(Optimization.user_id == user.id, Optimization.request_id == str(request.request_id)))
    if existing is not None:
        if existing.request_hash != digest:
            raise HTTPException(409, "This request_id was already used for a different Optimization.")
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
    if request.hybrid is not None:
        from optimization.evaluations import freeze_hybrid
        definition["hybrid"] = await freeze_hybrid(db, request.hybrid, user.id, experiment, frozen_calculations)
        if definition["hybrid"]["source_contracts"].get("varsSchema") != request.vars_schema:
            raise HTTPException(409, "Model Vars schema differs from the Optimization Vars schema.")
    definition["hash"] = hashlib.sha256(json.dumps(definition, sort_keys=True, separators=(",", ":"),
                                                   ensure_ascii=False, allow_nan=False).encode("utf-8")).hexdigest()
    settings = {"initial_vars": request.initial_vars, "axes": axes,
                "objective": {"direction": request.objective.direction},
                "constraints": [{"key": f"constraint:{index}", **item.model_dump(exclude={"calculation_id"}, exclude_none=True)}
                                for index, item in enumerate(request.constraints)],
                "max_trials": request.max_trials, "max_parallel": request.max_parallel,
                "initial_step": 0.25, "min_step": 0.001}
    from optimization.configuration import saved_algorithm, VerificationPolicy
    settings["algorithm"] = saved_algorithm(payload)
    if settings["algorithm"]["id"] == "coordinate":
        settings.update(settings["algorithm"]["config"])
    if request.hybrid is not None:
        settings["hybrid"] = {**payload["hybrid"], "verification_policy":
            (request.hybrid.verification_policy or VerificationPolicy()).model_dump()}
    optimization = Optimization(user_id=user.id, experiment_id=experiment.id,
                  name=request.name.strip() if request.name and request.name.strip() else f"{experiment.name} optimization",
                  request_id=str(request.request_id), request_hash=digest, state="running", definition=definition,
                  settings=settings, optimizer_state={})
    db.add(optimization)
    await db.flush()
    if request.hybrid is not None:
        from optimization.model_updates import model_state, save_state, sync_pins
        save_state(optimization, model_state(optimization))
        await sync_pins(db, optimization)
    await db.commit()
    return optimization


async def optimization_summaries(db, optimizations: list[Optimization]) -> list[dict]:
    from optimization.algorithm import trial_rank
    from optimization.evaluations import solver_budget
    from types import SimpleNamespace
    from optimization.model_updates import model_state, round_source, update_jobs
    from prediction.common import digest
    ids = [optimization.id for optimization in optimizations]
    if not ids:
        return []
    counts = (await db.execute(select(Trial.optimization_id, Trial.state, func.count(), func.count().filter(Trial.manual_retry_requested),
                                     func.sum(func.jsonb_array_length(Trial.retry_requests)))
                              .where(Trial.optimization_id.in_(ids)).group_by(Trial.optimization_id, Trial.state))).all()
    by_optimization = {optimization.id: {} for optimization in optimizations}
    manual_retries = {optimization.id: False for optimization in optimizations}
    retry_counts = {optimization.id: 0 for optimization in optimizations}
    for optimization_id, state, count, active_retries, retry_count in counts:
        by_optimization[optimization_id][state] = count
        manual_retries[optimization_id] = manual_retries[optimization_id] or bool(active_retries)
        retry_counts[optimization_id] += retry_count
    executions = (await db.execute(select(Trial.optimization_id,
        func.count().filter(Job.state.in_(SERVER_ACTIVE_STATES)),
        func.bool_or(Job.launcher_id.is_not(None) & Job.cleaned_at.is_(None)))
        .join(StageSubmission, StageSubmission.trial_id == Trial.id).join(Job, Job.id == StageSubmission.job_id)
        .where(Trial.optimization_id.in_(ids)).group_by(Trial.optimization_id))).all()
    execution_status = {optimization_id: (active, bool(cleanup)) for optimization_id, active, cleanup in executions}
    best_ids = [optimization.best_trial_id for optimization in optimizations if optimization.best_trial_id]
    best = {trial.id: trial for trial in (await db.scalars(select(Trial).where(Trial.id.in_(best_ids)))).all()} if best_ids else {}
    result = []
    for optimization in optimizations:
        totals, winner = by_optimization[optimization.id], best.get(optimization.best_trial_id)
        result.append({"id": optimization.id, "name": optimization.name, "experiment_id": optimization.experiment_id,
                       "state": optimization.state, "pause_reason": optimization.pause_reason,
                       "created_at": optimization.created_at, "updated_at": optimization.updated_at, "finished_at": optimization.finished_at,
                       "max_trials": optimization.settings["max_trials"], "max_parallel": optimization.settings["max_parallel"],
                       "trial_count": sum(totals.values()), "succeeded": totals.get("succeeded", 0),
                       "retry_count": retry_counts[optimization.id],
                       "failed": totals.get("failed", 0), "cancelled": totals.get("cancelled", 0),
                       "active": sum(value for state, value in totals.items() if state not in {"succeeded", "failed", "cancelled"}),
                       "executions_active": execution_status.get(optimization.id, (0, False))[0],
                       "cleanup_pending": execution_status.get(optimization.id, (0, False))[1],
                       "manual_retry_pending": manual_retries[optimization.id],
                       "best_trial": {"id": winner.id, "ordinal": winner.ordinal, "variables": winner.variables,
                                      "result": winner.result, "measurement_id": winner.measurement_id} if winner else None})
        summary = result[-1]
        evaluated = (await db.execute(select(Evaluation, Trial).join(Trial, Trial.id == Evaluation.trial_id)
            .where(Evaluation.optimization_id == optimization.id))).all()
        best_by_kind = {}
        model_update = model_state(optimization)
        current_source = digest(model_update["active_model"]) if model_update else None
        for kind in ("solver", "prediction"):
            eligible = [(evaluation, trial) for evaluation, trial in evaluated if evaluation.kind == kind
                        and evaluation.state == "succeeded" and evaluation.result and evaluation.result["feasible"]
                        and (kind != "prediction" or evaluation.source_hash == current_source)]
            if eligible:
                evaluation, trial = min(eligible, key=lambda pair: trial_rank(
                    SimpleNamespace(result=pair[0].result, ordinal=pair[1].ordinal), optimization.settings["objective"]["direction"]))
                best_by_kind[kind] = {"id": trial.id, "ordinal": trial.ordinal, "variables": trial.variables,
                    "result": evaluation.result, "measurement_id": evaluation.measurement_id,
                    "evaluation_id": evaluation.id, "source": evaluation.source}
        summary.update(best_verified_trial=best_by_kind.get("solver", summary["best_trial"]),
                       best_predicted_trial=best_by_kind.get("prediction"), solver_budget=await solver_budget(db, optimization),
                       termination_reason=optimization.optimizer_state.get("termination_reason"))
        summary["best_trial"] = summary["best_verified_trial"]
        if evaluated:
            summary["retry_count"] = sum(len(item.retry_requests or []) for item, _ in evaluated)
            summary["manual_retry_pending"] = any(item.manual_retry_requested for item, _ in evaluated)
        if optimization.settings.get("hybrid"):
            summary["model_update"] = model_update
            states = {}
            for evaluation, trial in evaluated:
                if (evaluation.kind == "prediction" and evaluation.source_hash != digest(round_source(optimization))
                        and not evaluation.manual_retry_requested):
                    continue
                states.setdefault(trial.id, []).append(evaluation.state)
            summary.update(succeeded=sum(all(state == "succeeded" for state in values) for values in states.values()),
                failed=sum("failed" in values for values in states.values()),
                cancelled=sum("cancelled" in values for values in states.values()),
                active=sum(any(state in {"pending", "running"} for state in values) for values in states.values()))
        children = list((await db.scalars(select(Job).where(
            Job.artifact_metadata["optimization_id"].astext == optimization.id,
            Job.artifact_metadata.has_key("optimization_parent")))).all())
        summary["executions_active"] += sum(job.state in SERVER_ACTIVE_STATES for job in children)
        summary["cleanup_pending"] |= any(job.launcher_id is not None and job.cleaned_at is None for job in children)
        training_jobs = await update_jobs(db, optimization)
        summary["executions_active"] += sum(job.state in SERVER_ACTIVE_STATES for job in training_jobs)
        summary["cleanup_pending"] |= any(job.launcher_id is not None and job.cleaned_at is None for job in training_jobs)
    return result


async def optimization_detail(db, optimization: Optimization) -> dict:
    summary = (await optimization_summaries(db, [optimization]))[0]
    return {**summary, "definition": optimization.definition, "settings": optimization.settings, "optimizer_state": optimization.optimizer_state}


async def list_optimizations(db, user, *, experiment_id: int | None, limit: int, offset: int) -> dict:
    query = select(Optimization)
    if not is_admin_user(user):
        query = query.where(Optimization.user_id == user.id)
    if experiment_id is not None:
        query = query.where(Optimization.experiment_id == experiment_id)
    total = await db.scalar(select(func.count()).select_from(query.subquery()))
    optimizations = list((await db.scalars(query.order_by(Optimization.created_at.desc(), Optimization.id).limit(limit).offset(offset))).all())
    return {"total": total, "items": await optimization_summaries(db, optimizations)}


async def list_trials(db, optimization: Optimization, *, limit: int, offset: int) -> dict:
    total = await db.scalar(select(func.count()).select_from(Trial).where(Trial.optimization_id == optimization.id))
    trials = list((await db.scalars(select(Trial).where(Trial.optimization_id == optimization.id)
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
    history = {"total": total, "items": [{**{key: getattr(trial, key) for key in (
        "id", "optimization_id", "ordinal", "round_index", "variables", "fingerprint", "state", "next_stage",
        "measurement_id", "result", "error", "manual_retry_requested", "created_at", "updated_at")},
        "retry_count": len(trial.retry_requests or []), "stages": grouped[trial.id]} for trial in trials]}
    evaluations = list((await db.scalars(select(Evaluation).where(
        Evaluation.trial_id.in_([trial.id for trial in trials])).order_by(Evaluation.created_at, Evaluation.id))).all())
    linked = (await db.execute(select(EvaluationSubmission.evaluation_id, StageSubmission, Job)
        .join(StageSubmission, StageSubmission.id == EvaluationSubmission.submission_id)
        .join(Job, Job.id == StageSubmission.job_id)
        .where(EvaluationSubmission.evaluation_id.in_([item.id for item in evaluations]))
        .order_by(StageSubmission.created_at, StageSubmission.generation))).all()
    by_evaluation = {item.id: [] for item in evaluations}
    for evaluation_id, stage, job in linked:
        by_evaluation[evaluation_id].append({"id": stage.id, "stage": stage.stage, "generation": stage.generation,
            "batch_id": stage.batch_id, "job_id": stage.job_id, "state": job.state,
            "result": stage.result, "error": stage.error, "job": job_snapshot(job,
                next(item.measurement_id for item in evaluations if item.id == evaluation_id))})
    for item in history["items"]:
        item["evaluations"] = [{**{key: getattr(evaluation, key) for key in (
            "id", "kind", "definition_hash", "source_hash", "source", "state", "next_stage", "measurement_id",
            "artifact", "result", "error", "manual_retry_requested", "created_at", "updated_at")},
            "retry_count": len(evaluation.retry_requests or []), "stages": by_evaluation[evaluation.id]}
            for evaluation in evaluations if evaluation.trial_id == item["id"]]
        if optimization.settings.get("hybrid") and item["evaluations"]:
            from optimization.model_updates import round_source
            from prediction.common import digest
            source_hash = digest(round_source(optimization))
            states = [evaluation["state"] for evaluation in item["evaluations"]
                if evaluation["kind"] == "solver" or evaluation["source_hash"] == source_hash or evaluation["manual_retry_requested"]]
            item["state"] = next((state for state in ("failed", "running", "pending", "cancelled") if state in states),
                "succeeded" if any(evaluation["kind"] == "solver" and evaluation["state"] == "succeeded"
                                   for evaluation in item["evaluations"]) else "predicted")
    return history


async def resume_optimization(db, optimization: Optimization) -> None:
    from optimization.model_updates import round_source, update_jobs
    from prediction.common import digest
    from prediction.training import cleanup_pending
    if optimization.state == "running":
        return
    if optimization.state != "paused":
        raise HTTPException(409, "Wait for the Optimization to pause before resuming.")
    source = round_source(optimization)
    if await db.scalar(select(Evaluation.id).where(Evaluation.optimization_id == optimization.id,
        ((Evaluation.state == "failed") & ((Evaluation.kind == "solver") | (Evaluation.source_hash == digest(source))))
        | Evaluation.manual_retry_requested).limit(1)) is not None:
        raise HTTPException(409, "Retry failed Evaluations and wait for completion before resuming.")
    unresolved = await db.scalar(select(Trial.id).where(Trial.optimization_id == optimization.id,
                                                       (Trial.state == "failed") | Trial.manual_retry_requested).limit(1))
    if unresolved is not None:
        raise HTTPException(409, "Retry failed Trials and wait for their completion before resuming.")
    active = await db.scalar(select(Job.id).join(StageSubmission, StageSubmission.job_id == Job.id)
                            .join(Trial, Trial.id == StageSubmission.trial_id).where(Trial.optimization_id == optimization.id,
                                Job.state.in_(SERVER_ACTIVE_STATES) | (Job.launcher_id.is_not(None) & Job.cleaned_at.is_(None))).limit(1))
    if active is not None:
        raise HTTPException(409, "Wait for Optimization executions and worker cleanup before resuming.")
    if any(cleanup_pending(job) for job in await update_jobs(db, optimization)):
        raise HTTPException(409, "Wait for Optimization training and worker cleanup before resuming.")
    if await db.scalar(select(Job.id).where(Job.artifact_metadata["optimization_id"].astext == optimization.id,
        Job.artifact_metadata.has_key("optimization_parent"),
        Job.state.in_(SERVER_ACTIVE_STATES) | (Job.launcher_id.is_not(None) & Job.cleaned_at.is_(None))).limit(1)):
        raise HTTPException(409, "Wait for Predictor cleanup before resuming.")
    optimization.state, optimization.pause_reason, optimization.finished_at, optimization.updated_at = "running", None, None, utcnow()


async def delete_optimization(db, optimization: Optimization) -> None:
    from optimization.model_updates import cancel_updates, update_jobs
    from prediction.training import cleanup_pending
    if optimization.state not in {"paused", "completed"}:
        raise HTTPException(409, "Stop the Optimization before deleting its history.")
    if any(cleanup_pending(job) for job in await update_jobs(db, optimization)):
        raise HTTPException(409, "Wait for Optimization training cleanup before deleting its history.")
    if await db.scalar(select(Evaluation.id).where(Evaluation.optimization_id == optimization.id,
                                                  Evaluation.manual_retry_requested).limit(1)):
        raise HTTPException(409, "Stop the manual Evaluation retry before deleting its Optimization.")
    if await db.scalar(select(Job.id).where(Job.artifact_metadata["optimization_id"].astext == optimization.id,
        Job.artifact_metadata.has_key("optimization_parent"),
        Job.state.in_(SERVER_ACTIVE_STATES) | (Job.launcher_id.is_not(None) & Job.cleaned_at.is_(None))).limit(1)):
        raise HTTPException(409, "Wait for Predictor cleanup before deleting its Optimization.")
    if await db.scalar(select(Trial.id).where(Trial.optimization_id == optimization.id, Trial.manual_retry_requested).limit(1)) is not None:
        raise HTTPException(409, "Stop the manual retry before deleting its Optimization.")
    active = await db.scalar(select(Job.id).join(StageSubmission, StageSubmission.job_id == Job.id)
                            .join(Trial, Trial.id == StageSubmission.trial_id).where(Trial.optimization_id == optimization.id,
                                Job.state.in_(SERVER_ACTIVE_STATES) | (Job.launcher_id.is_not(None) & Job.cleaned_at.is_(None))).limit(1))
    if active is not None:
        raise HTTPException(409, "Wait for all Optimization workers to finish cleanup before deleting its history.")
    await cancel_updates(db, optimization)
    await db.execute(delete(Optimization).where(Optimization.id == optimization.id))


async def stop_optimization(db, optimization_id: str, user) -> dict:
    from optimization.controller import cancel_optimization, wake_controller

    await serialize_events(db)
    optimization = await require_optimization(db, optimization_id, user, lock=True)
    await cancel_optimization(db, optimization, "user")
    await db.commit()
    wake_controller()
    return await optimization_detail(db, optimization)


async def resume_owned_optimization(db, optimization_id: str, user) -> dict:
    from optimization.controller import wake_controller

    await serialize_events(db)
    optimization = await require_optimization(db, optimization_id, user, lock=True)
    await resume_optimization(db, optimization)
    await db.commit()
    wake_controller()
    return await optimization_detail(db, optimization)


async def retry_trial(db, optimization_id: str, trial_id: str, request_id: str, user) -> dict:
    from optimization.controller import request_retry, wake_controller

    await serialize_events(db)
    optimization = await require_optimization(db, optimization_id, user, lock=True)
    trial = await db.scalar(select(Trial).where(Trial.optimization_id == optimization.id, Trial.id == trial_id).with_for_update())
    if trial is None:
        raise HTTPException(404, "Trial not found.")
    if optimization.settings.get("hybrid"):
        raise HTTPException(409, "Retry the specific Hybrid Evaluation instead of its candidate Trial.")
    await request_retry(db, optimization, trial, request_id)
    await db.commit()
    wake_controller()
    return await optimization_detail(db, optimization)


async def retry_evaluation(db, optimization_id, evaluation_id, request_id, user, catalog):
    from optimization.controller import optimization_jobs, wake_controller
    from optimization.evaluations import project_solver, require_solver_budget
    from optimization.submissions import submit_stage

    await serialize_events(db)
    optimization = await require_optimization(db, optimization_id, user, lock=True)
    evaluation = await db.scalar(select(Evaluation).where(Evaluation.id == evaluation_id,
        Evaluation.optimization_id == optimization.id).with_for_update())
    if evaluation is None:
        raise HTTPException(404, "Evaluation not found.")
    if request_id in (evaluation.retry_requests or []):
        await db.commit()
        return await optimization_detail(db, optimization)
    if optimization.state not in {"paused", "completed"} or evaluation.state != "failed":
        raise HTTPException(409, "Pause the Optimization and select a failed Evaluation to retry.")
    jobs = [job for _, job in await optimization_jobs(db, optimization.id)]
    jobs.extend((await db.scalars(select(Job).where(Job.artifact_metadata["optimization_id"].astext == optimization.id,
        Job.artifact_metadata.has_key("optimization_parent")))).all())
    if any(job.state in SERVER_ACTIVE_STATES or (job.launcher_id and job.cleaned_at is None) for job in jobs):
        raise HTTPException(409, "Wait for previous executions and Predictor cleanup before retrying.")
    if evaluation.next_stage == "solve":
        await require_solver_budget(db, optimization)
    evaluation.retry_request_id = request_id
    evaluation.retry_requests = [*(evaluation.retry_requests or []), request_id]
    evaluation.manual_retry_requested = True
    evaluation.state, evaluation.error = "pending", None
    evaluation.updated_at = utcnow()
    optimization.state, optimization.finished_at = "paused", None
    trial = await db.get(Trial, evaluation.trial_id)
    project_solver(trial, evaluation)
    # Solver retry admission and the new physical Job/reservation are one locked
    # transaction. A repeated request returns the receipt without spending twice.
    if evaluation.next_stage == "solve":
        await submit_stage(db, optimization, trial, catalog, evaluation)
    await db.commit()
    wake_controller()
    return await optimization_detail(db, optimization)


async def remove_optimization(db, optimization_id: str, user) -> None:
    await serialize_events(db)
    optimization = await require_optimization(db, optimization_id, user, lock=True)
    await delete_optimization(db, optimization)
    await db.commit()
