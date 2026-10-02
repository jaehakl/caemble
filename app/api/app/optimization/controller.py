"""Durable Optimization transitions; the existing dispatcher owns actual execution."""

from __future__ import annotations

import asyncio
import logging
from contextlib import suppress

from fastapi import HTTPException
from sqlalchemy import Text, select

from optimization.algorithm import next_round, trial_rank
from optimization.db import Evaluation, StageSubmission, Optimization, Trial
from optimization.evaluations import ensure_evaluation, project_solver, solver_budget, submission_evaluations
from optimization.submissions import submit_stage
from db import SessionLocal
from gpstation.db import Job
from gpstation.service.batches import SERVER_ACTIVE_STATES, TERMINAL_STATES, finish_job, serialize_events
from gpstation.service.execution import execution_identity
from gpstation.service.job_orchestrator import job_orchestrator
from gpstation.service.state import utcnow

logger = logging.getLogger(__name__)
_wake: asyncio.Event | None = None
_task: asyncio.Task | None = None


def wake_controller():
    if _wake is not None:
        _wake.set()


async def optimization_jobs(db, optimization_id):
    return list((await db.execute(select(StageSubmission, Job).join(Job, Job.id == StageSubmission.job_id)
                                  .join(Trial, Trial.id == StageSubmission.trial_id)
                                  .where(Trial.optimization_id == optimization_id).order_by(Job.id))).all())


async def cancel_optimization(db, optimization, reason="user"):
    """Caller holds the event/Optimization locks and commits before cancellation delivery."""
    if optimization.state == "completed":
        return
    optimization.state = "pausing"
    optimization.pause_reason = "Stopped by user." if reason == "user" else str(reason)
    from optimization.model_updates import cancel_updates
    await cancel_updates(db, optimization)
    trials = list((await db.scalars(select(Trial).where(Trial.optimization_id == optimization.id))).all())
    for trial in trials:
        trial.manual_retry_requested = False
    for evaluation in (await db.scalars(select(Evaluation).where(Evaluation.optimization_id == optimization.id))).all():
        evaluation.manual_retry_requested = False
    for submission, job in await optimization_jobs(db, optimization.id):
        if job.state not in SERVER_ACTIVE_STATES:
            continue
        job.artifact_metadata = {**(job.artifact_metadata or {}), "optimization_cancel_reason": "user"}
        job.cancel_requested_at = utcnow()
        await finish_job(db, job, "cancelled", optimization.pause_reason)
    optimization.updated_at = utcnow()


async def request_retry(db, optimization, trial, request_id):
    evaluation = await ensure_evaluation(db, optimization, trial)
    if trial.retry_request_id == request_id or request_id in (trial.retry_requests or []):
        return
    if optimization.state != "paused" or trial.state != "failed":
        raise HTTPException(409, "Pause the Optimization and select a failed Trial to retry.")
    jobs = await optimization_jobs(db, optimization.id)
    if any(job.state in SERVER_ACTIVE_STATES or (job.launcher_id and job.cleaned_at is None) for _, job in jobs):
        raise HTTPException(409, "Wait for the previous executions to finish cleanup before retrying.")
    trial.retry_request_id = request_id
    trial.retry_requests = [*(trial.retry_requests or []), request_id]
    trial.manual_retry_requested = True
    trial.state = "pending"
    trial.error = None
    trial.updated_at = utcnow()
    for key in ("retry_request_id", "retry_requests", "manual_retry_requested", "state", "error", "updated_at"):
        setattr(evaluation, key, getattr(trial, key))


async def pause_for_failure(db, optimization, trial, message, evaluation=None):
    evaluation = evaluation or await ensure_evaluation(db, optimization, trial)
    evaluation.state = "failed"
    evaluation.manual_retry_requested = False
    evaluation.error = {"message": message, "stage": evaluation.next_stage}
    evaluation.updated_at = utcnow()
    project_solver(trial, evaluation)
    budget = await solver_budget(db, optimization)
    if budget and budget["used"] >= budget["limit"] and evaluation.next_stage == "solve":
        optimization.optimizer_state = {**optimization.optimizer_state, "termination_reason": "solver_budget_exhausted"}
        return
    optimization.state = "pausing"
    optimization.pause_reason = f"Trial {trial.ordinal} {evaluation.next_stage}: {message}"
    for retrying in (await db.scalars(select(Trial).where(
        Trial.optimization_id == optimization.id, Trial.manual_retry_requested,
    ))).all():
        retrying.manual_retry_requested = False
    for retrying in (await db.scalars(select(Evaluation).where(
        Evaluation.optimization_id == optimization.id, Evaluation.manual_retry_requested,
    ))).all():
        retrying.manual_retry_requested = False
    # A queued sibling is already dispatchable; pausing only the controller
    # would not stop it. This shares finish_job's existing event lock.
    for _, other in await optimization_jobs(db, optimization.id):
        if other.state not in {"staged", "queued"}:
            continue
        other.artifact_metadata = {**(other.artifact_metadata or {}), "optimization_cancel_reason": "failure_pause"}
        other.cancel_requested_at = utcnow()
        await finish_job(db, other, "cancelled", "Optimization paused after an evaluation failure.")
    trial.updated_at = optimization.updated_at = utcnow()


async def on_job_finished(db, job, result=None):
    """Called in finish_job's transaction, under its existing event lock."""
    optimization_id = (job.artifact_metadata or {}).get("optimization_id")
    if not optimization_id:
        return
    optimization = await db.scalar(select(Optimization).where(Optimization.id == optimization_id).with_for_update())
    submission = await db.scalar(select(StageSubmission).where(StageSubmission.job_id == job.id))
    if optimization is None or submission is None or submission.state in TERMINAL_STATES:
        return
    trial = await db.get(Trial, submission.trial_id)
    evaluations = await submission_evaluations(db, submission)
    if not evaluations:
        evaluations = [await ensure_evaluation(db, optimization, trial)]
    submission.state = job.state
    submission.updated_at = utcnow()
    for evaluation in evaluations:
        trial = await db.get(Trial, evaluation.trial_id)
        if job.state == "succeeded":
            if submission.result is None:
                submission.result = result or {}
            evaluation.next_stage = {"build": "solve", "solve": "calculate", "predict": "calculate", "calculate": "complete"}[submission.stage]
            evaluation.state = "succeeded" if evaluation.next_stage == "complete" else "pending"
            if evaluation.state == "succeeded":
                evaluation.manual_retry_requested = False
        elif (job.artifact_metadata or {}).get("optimization_resource_wait"):
            evaluation.state = "pending"
            evaluation.error = None
            submission.error = {"message": job.last_error, "code": "prediction-resource-wait"}
        elif job.state in {"cancelled", "killed"} and job.artifact_metadata.get("optimization_cancel_reason"):
            evaluation.state = "cancelled"
            evaluation.manual_retry_requested = False
            submission.error = {"message": job.last_error, "origin": job.artifact_metadata["optimization_cancel_reason"]}
        else:
            await pause_for_failure(db, optimization, trial, job.last_error or "Evaluation failed.", evaluation)
            submission.error = evaluation.error
        evaluation.updated_at = optimization.updated_at = utcnow()
        project_solver(trial, evaluation)
        if evaluation.kind == "solver" and evaluation.state == "succeeded" and evaluation.result and evaluation.result["feasible"]:
            best = await db.get(Trial, optimization.best_trial_id) if optimization.best_trial_id else None
            if best is None or trial_rank(trial, optimization.settings["objective"]["direction"]) < trial_rank(best, optimization.settings["objective"]["direction"]):
                optimization.best_trial_id = trial.id


async def reconcile_optimization(db, optimization, catalog):
    if optimization.settings.get("hybrid"):
        from optimization.hybrid import reconcile_hybrid
        return await reconcile_hybrid(db, optimization, catalog)
    trials = list((await db.scalars(select(Trial).where(Trial.optimization_id == optimization.id).order_by(Trial.ordinal))).all())
    jobs = await optimization_jobs(db, optimization.id)
    # Recovery covers a terminal Job committed before this process restarted.
    for submission, job in jobs:
        if job.state in TERMINAL_STATES and submission.state not in TERMINAL_STATES:
            await on_job_finished(db, job)
    active = [(submission, job) for submission, job in jobs if job.state in SERVER_ACTIVE_STATES]
    unclean = [(submission, job) for submission, job in jobs if job.launcher_id and job.cleaned_at is None]
    if optimization.state == "pausing":
        if not active and not unclean:
            optimization.state = "paused"
            optimization.updated_at = utcnow()
        return
    if optimization.state == "completed":
        return
    if optimization.state == "running" and any(trial.state == "failed" for trial in trials):
        optimization.state = "paused"
        optimization.pause_reason = "Retry failed Trials before resuming this Optimization."
        return
    if optimization.state == "running":
        state, candidates, completed = next_round(trials, optimization.settings, optimization.optimizer_state)
        optimization.optimizer_state = state
        for candidate in candidates:
            trial = Trial(optimization_id=optimization.id, **candidate, state="pending", next_stage="build", manual_retry_requested=False)
            db.add(trial)
            trials.append(trial)
        if candidates:
            await db.flush()
        if completed:
            # A terminal result can precede process teardown. Keep the Optimization
            # resumable/visible until its owned executions have all cleaned up.
            if not active and not unclean:
                optimization.state = "completed"
                optimization.finished_at = utcnow()
                optimization.updated_at = utcnow()
            return
    if optimization.definition["catalog_revision"] != catalog.meta()["catalogRevision"]:
        optimization.state = "paused"
        optimization.pause_reason = "Optimization Catalog revision is unavailable. Restore its Catalog to resume."
        return
    busy_trials = {submission.trial_id for submission, _ in [*active, *unclean]}
    slots = max(0, optimization.settings["max_parallel"] - len(busy_trials))
    for trial in trials:
        if slots == 0:
            break
        if trial.id in busy_trials or trial.state not in {"pending", "cancelled"}:
            continue
        if optimization.state != "running" and not trial.manual_retry_requested:
            continue
        try:
            async with db.begin_nested():
                await submit_stage(db, optimization, trial, catalog)
        except Exception as error:
            await db.refresh(trial)
            await pause_for_failure(db, optimization, trial, str(getattr(error, "detail", None) or error))
            return
        slots -= 1
        optimization.updated_at = utcnow()


async def reconcile_once(catalog):
    from optimization.predictor_jobs import reconcile_children
    async with SessionLocal() as db:
        await reconcile_children(db)
        await db.commit()
    from optimization.model_maintenance import reconcile_pruning
    async with SessionLocal() as db:
        await reconcile_pruning(db)
    async with SessionLocal() as db:
        from prediction.db import Operation, TrainingRun
        changed_update = select(Operation.id).join(TrainingRun, TrainingRun.operation_id == Operation.id).outerjoin(
            Job, Job.id == TrainingRun.job_id).where(
            Operation.kind == "prepare",
            Operation.details["online_origin"]["optimization_id"].astext == Optimization.id.cast(Text),
            (Operation.updated_at > Optimization.updated_at) | Job.state.in_(SERVER_ACTIVE_STATES)
            | (Job.launcher_id.is_not(None) & Job.cleaned_at.is_(None)),
        ).exists()
        ids = list((await db.scalars(select(Optimization.id).where(
            (Optimization.state != "completed") | changed_update).order_by(Optimization.created_at))).all())
    for optimization_id in ids:
        async with SessionLocal() as db:
            await serialize_events(db)
            optimization = await db.scalar(select(Optimization).where(Optimization.id == optimization_id).with_for_update())
            if optimization is None:
                continue
            try:
                await reconcile_optimization(db, optimization, catalog)
                await db.commit()
            except Exception as error:
                await db.rollback()
                logger.exception("Could not advance Optimization %s", optimization_id)
                # Submission errors (e.g. a saved contract mismatch) must be
                # visible and must not cause an infinite background retry loop.
                await serialize_events(db)
                optimization = await db.scalar(select(Optimization).where(Optimization.id == optimization_id).with_for_update())
                if optimization is not None:
                    optimization.state = "paused"
                    optimization.pause_reason = str(getattr(error, "detail", None) or error)
                    await db.commit()
    # Deliver persisted cancellations after their transaction commits. Repeating
    # the command is safe: launcher cancellation uses the complete attempt ID.
    async with SessionLocal() as db:
        cancelled = list((await db.scalars(select(Job).outerjoin(StageSubmission, StageSubmission.job_id == Job.id).where(
            StageSubmission.id.is_not(None) | ((Job.handler_type == "prediction.train") & Job.artifact_metadata.has_key("optimization_id")),
            Job.cancel_requested_at.is_not(None), Job.launcher_id.is_not(None), Job.cleaned_at.is_(None),
        ))).all())
    for job in cancelled:
        try:
            async with job_orchestrator.launcher_send_lock(job.launcher_id):
                await job_orchestrator.send_launcher_message(job.launcher_id,
                    {"type": "job.cancel", **execution_identity(job), "reason": job.last_error or "Optimization stopped."})
        except Exception:
            pass  # Existing launcher reconciliation also replays fenced cancels.
    job_orchestrator.wake_dispatcher()


async def start_controller(catalog):
    global _wake, _task
    if _task is not None and not _task.done():
        return
    _wake = asyncio.Event()

    async def run():
        while True:
            _wake.clear()
            try:
                await reconcile_once(catalog)
            except Exception:
                logger.exception("Optimization reconciliation failed")
            with suppress(asyncio.TimeoutError):
                await asyncio.wait_for(_wake.wait(), timeout=1)

    _task = asyncio.create_task(run(), name="optimization-controller")


async def stop_controller():
    global _wake, _task
    if _task is not None:
        _task.cancel()
        with suppress(asyncio.CancelledError):
            await _task
    _task = _wake = None
