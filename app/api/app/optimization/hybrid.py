"""Persist and execute Hybrid search decisions through existing Evaluation jobs."""
from sqlalchemy import select

from gpstation.db import Job
from gpstation.service.batches import SERVER_ACTIVE_STATES, TERMINAL_STATES
from gpstation.service.state import utcnow
from optimization.db import Evaluation, EvaluationSubmission, Trial
from optimization.evaluations import ensure_evaluation, project_solver, solver_budget
from optimization.search import advance_search
from optimization.automatic_updates import request_automatic_update
from optimization.submissions import submit_predictions, submit_stage
from optimization.model_updates import bind_round, finish_updates, model_state, reconcile_updates, round_source, save_state
from prediction.common import digest


async def reconcile_hybrid(db, optimization, catalog):
    from optimization.controller import on_job_finished, optimization_jobs, pause_for_failure

    training_busy = await reconcile_updates(db, optimization)
    if optimization.state == "completed":
        # An explicitly retried Training Operation may finish after the search.
        # Its saved revision remains an asset without reopening any round.
        await finish_updates(db, optimization)
        return
    if "round_source_hash" not in optimization.optimizer_state:
        await bind_round(db, optimization, optimization.optimizer_state.get("round_index", 0))
    trials = list((await db.scalars(select(Trial).where(Trial.optimization_id == optimization.id).order_by(Trial.ordinal))).all())
    jobs = await optimization_jobs(db, optimization.id)
    for submission, job in jobs:
        if job.state in TERMINAL_STATES and submission.state not in TERMINAL_STATES:
            await on_job_finished(db, job)
    evaluations = list((await db.scalars(select(Evaluation).where(Evaluation.optimization_id == optimization.id))).all())
    active = [(submission, job) for submission, job in jobs if job.state in SERVER_ACTIVE_STATES or (job.launcher_id and job.cleaned_at is None)]
    children = list((await db.scalars(select(Job).where(
        Job.artifact_metadata["optimization_id"].astext == optimization.id,
        Job.artifact_metadata.has_key("optimization_parent"),
        Job.state.in_(SERVER_ACTIVE_STATES) | (Job.launcher_id.is_not(None) & Job.cleaned_at.is_(None)),
    ))).all())
    if optimization.state == "pausing":
        if not active and not children and not training_busy:
            optimization.state = "paused"
        return
    if optimization.definition["catalog_revision"] != catalog.meta()["catalogRevision"]:
        optimization.state, optimization.pause_reason = "paused", "Optimization Catalog revision is unavailable. Restore its Catalog to resume."
        return
    budget = await solver_budget(db, optimization)
    exhausted = budget["used"] >= budget["limit"]
    draining = exhausted and optimization.pause_reason != "Stopped by user."
    if optimization.state == "running" or draining:
        state, candidates, selected, reason = advance_search(trials, evaluations, optimization.settings, optimization.optimizer_state, budget)
        boundary = state.get("round_index", 0) != optimization.optimizer_state.get("round_index", 0) or not trials
        if boundary and trials and not reason and not exhausted:
            requested = await request_automatic_update(db, optimization, next_round=True, training_busy=training_busy)
            if requested:
                training_busy = await reconcile_updates(db, optimization)
            # Admission/accounting changed only model state. Keep the proposed
            # search decision, including its RNG, uncommitted while training waits.
            state["model_update"] = model_state(optimization)
        if boundary and training_busy:
            pending = model_state(optimization)
            pending["waiting"] = True
            save_state(optimization, pending)
            candidates, selected, reason = [], [], None
        else:
            optimization.optimizer_state = state
            if boundary:
                await bind_round(db, optimization, state.get("round_index", 0))
        for candidate in candidates:
            trial = Trial(optimization_id=optimization.id, **candidate, state="pending", next_stage="build", manual_retry_requested=False)
            db.add(trial)
            await db.flush()
            trials.append(trial)
            evaluations.append(await ensure_evaluation(db, optimization, trial, "prediction", prediction_source=round_source(optimization)))
        if not (boundary and training_busy):
            for trial in trials:
                if trial.ordinal in optimization.optimizer_state.get("round_ordinals", []):
                    item = await ensure_evaluation(db, optimization, trial, "prediction", prediction_source=round_source(optimization))
                    if all(existing.id != item.id for existing in evaluations):
                        evaluations.append(item)
        for trial in trials:
            if trial.id in selected:
                evaluations.append(await ensure_evaluation(db, optimization, trial, "solver"))
        if reason:
            optimization.optimizer_state = {**optimization.optimizer_state, "termination_reason": reason}
            # A failed final Solver is retained. Completed output still gets its
            # free Calculation stage, and all parent/child cleanup must finish.
            postprocessing = any(item.next_stage == "calculate" and item.state != "succeeded" for item in evaluations)
            if not active and not children and not postprocessing and not training_busy:
                for evaluation in evaluations:
                    if evaluation.state in {"pending", "cancelled"}:
                        evaluation.state = "cancelled"
                        evaluation.manual_retry_requested = False
                        evaluation.error = {"message": "Solver budget exhausted.", "stage": evaluation.next_stage}
                        project_solver(next(trial for trial in trials if trial.id == evaluation.trial_id), evaluation)
                optimization.state, optimization.finished_at = "completed", utcnow()
                await finish_updates(db, optimization)
                return
    busy = set((await db.scalars(select(EvaluationSubmission.evaluation_id).where(
        EvaluationSubmission.submission_id.in_([submission.id for submission, _ in active])))).all())
    by_trial = {trial.id: trial for trial in trials}
    busy_trials = {item.trial_id for item in evaluations if item.id in busy}
    slots = max(0, optimization.settings["max_parallel"] - len(busy_trials))
    predict = []
    for evaluation in evaluations:
        if (evaluation.kind == "prediction" and evaluation.source_hash != digest(round_source(optimization))
                and not evaluation.manual_retry_requested):
            continue
        if evaluation.id in busy or evaluation.state not in {"pending", "cancelled"} or slots == 0:
            continue
        if optimization.state != "running" and not evaluation.manual_retry_requested and not (draining and evaluation.next_stage == "calculate"):
            continue
        if exhausted and evaluation.next_stage != "calculate":
            if evaluation.state in {"pending", "cancelled"}:
                evaluation.state = "cancelled"
                evaluation.error = {"message": "Solver budget exhausted.", "stage": evaluation.next_stage}
            continue
        trial = by_trial[evaluation.trial_id]
        if trial.id in busy_trials:
            continue
        if evaluation.next_stage == "solve" and (await solver_budget(db, optimization))["remaining"] == 0:
            # Another reservation may still be returned before execution starts.
            if budget["used"] >= budget["limit"]:
                evaluation.state = "cancelled"
                evaluation.error = {"message": "Solver budget exhausted before submission.", "stage": "solve"}
            continue
        if evaluation.next_stage == "predict":
            if predict and predict[0][1].source_hash != evaluation.source_hash:
                continue
            predict.append((trial, evaluation))
        else:
            try:
                async with db.begin_nested():
                    await submit_stage(db, optimization, trial, catalog, evaluation)
            except Exception as error:
                await db.refresh(evaluation)
                await pause_for_failure(db, optimization, trial, str(getattr(error, "detail", None) or error), evaluation)
                return
        busy_trials.add(trial.id)
        slots -= 1
    if predict:
        try:
            async with db.begin_nested():
                await submit_predictions(db, optimization, predict[:32])
        except Exception as error:
            trial, evaluation = predict[0]
            await db.refresh(evaluation)
            await pause_for_failure(db, optimization, trial, str(getattr(error, "detail", None) or error), evaluation)
    optimization.updated_at = utcnow()
