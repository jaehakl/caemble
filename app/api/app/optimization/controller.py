"""Durable Study transitions; the existing dispatcher owns actual execution."""

from __future__ import annotations

import asyncio
import logging
from contextlib import suppress

from fastapi import HTTPException
from sqlalchemy import select

from optimization.algorithm import next_round, trial_rank
from optimization.db import StageSubmission, Study, Trial
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


async def study_jobs(db, study_id):
    return list((await db.execute(select(StageSubmission, Job).join(Job, Job.id == StageSubmission.job_id)
                                  .join(Trial, Trial.id == StageSubmission.trial_id)
                                  .where(Trial.study_id == study_id).order_by(Job.id))).all())


async def cancel_study(db, study, reason="user"):
    """Caller holds the event/Study locks and commits before cancellation delivery."""
    if study.state == "completed":
        return
    study.state = "pausing"
    study.pause_reason = "Stopped by user." if reason == "user" else str(reason)
    trials = list((await db.scalars(select(Trial).where(Trial.study_id == study.id))).all())
    for trial in trials:
        trial.manual_retry_requested = False
    for submission, job in await study_jobs(db, study.id):
        if job.state not in SERVER_ACTIVE_STATES:
            continue
        job.artifact_metadata = {**(job.artifact_metadata or {}), "study_cancel_reason": "user"}
        job.cancel_requested_at = utcnow()
        await finish_job(db, job, "cancelled", study.pause_reason)
    study.updated_at = utcnow()


async def request_retry(db, study, trial, request_id):
    if trial.retry_request_id == request_id or request_id in (trial.retry_requests or []):
        return
    if study.state != "paused" or trial.state != "failed":
        raise HTTPException(409, "Pause the Study and select a failed Trial to retry.")
    jobs = await study_jobs(db, study.id)
    if any(job.state in SERVER_ACTIVE_STATES or (job.launcher_id and job.cleaned_at is None) for _, job in jobs):
        raise HTTPException(409, "Wait for the previous executions to finish cleanup before retrying.")
    trial.retry_request_id = request_id
    trial.retry_requests = [*(trial.retry_requests or []), request_id]
    trial.manual_retry_requested = True
    trial.state = "pending"
    trial.error = None
    trial.updated_at = utcnow()


async def pause_for_failure(db, study, trial, message):
    trial.state = "failed"
    trial.manual_retry_requested = False
    trial.error = {"message": message, "stage": trial.next_stage}
    study.state = "pausing"
    study.pause_reason = f"Trial {trial.ordinal} {trial.next_stage}: {message}"
    for retrying in (await db.scalars(select(Trial).where(
        Trial.study_id == study.id, Trial.manual_retry_requested,
    ))).all():
        retrying.manual_retry_requested = False
    # A queued sibling is already dispatchable; pausing only the controller
    # would not stop it. This shares finish_job's existing event lock.
    for _, other in await study_jobs(db, study.id):
        if other.state not in {"staged", "queued"}:
            continue
        other.artifact_metadata = {**(other.artifact_metadata or {}), "study_cancel_reason": "failure_pause"}
        other.cancel_requested_at = utcnow()
        await finish_job(db, other, "cancelled", "Study paused after an evaluation failure.")
    trial.updated_at = study.updated_at = utcnow()


async def on_job_finished(db, job, result=None):
    """Called in finish_job's transaction, under its existing event lock."""
    study_id = (job.artifact_metadata or {}).get("study_id")
    if not study_id:
        return
    study = await db.scalar(select(Study).where(Study.id == study_id).with_for_update())
    submission = await db.scalar(select(StageSubmission).where(StageSubmission.job_id == job.id))
    if study is None or submission is None or submission.state in TERMINAL_STATES:
        return
    trial = await db.get(Trial, submission.trial_id)
    submission.state = job.state
    submission.updated_at = utcnow()
    if job.state == "succeeded":
        if submission.result is None:
            submission.result = result or {}
        trial.next_stage = {"build": "solve", "solve": "calculate", "calculate": "complete"}[submission.stage]
        trial.state = "succeeded" if trial.next_stage == "complete" else "pending"
        if trial.state == "succeeded":
            trial.manual_retry_requested = False
            if trial.result and trial.result["feasible"]:
                best = await db.get(Trial, study.best_trial_id) if study.best_trial_id else None
                if best is None or trial_rank(trial, study.settings["objective"]["direction"]) < trial_rank(best, study.settings["objective"]["direction"]):
                    study.best_trial_id = trial.id
    elif job.state in {"cancelled", "killed"} and job.artifact_metadata.get("study_cancel_reason"):
        trial.state = "cancelled"
        trial.manual_retry_requested = False
        submission.error = {"message": job.last_error, "origin": job.artifact_metadata["study_cancel_reason"]}
    else:
        await pause_for_failure(db, study, trial, job.last_error or "Evaluation failed.")
        submission.error = trial.error
    trial.updated_at = study.updated_at = utcnow()


async def reconcile_study(db, study, catalog):
    trials = list((await db.scalars(select(Trial).where(Trial.study_id == study.id).order_by(Trial.ordinal))).all())
    jobs = await study_jobs(db, study.id)
    # Recovery covers a terminal Job committed before this process restarted.
    for submission, job in jobs:
        if job.state in TERMINAL_STATES and submission.state not in TERMINAL_STATES:
            await on_job_finished(db, job)
    active = [(submission, job) for submission, job in jobs if job.state in SERVER_ACTIVE_STATES]
    unclean = [(submission, job) for submission, job in jobs if job.launcher_id and job.cleaned_at is None]
    if study.state == "pausing":
        if not active and not unclean:
            study.state = "paused"
            study.updated_at = utcnow()
        return
    if study.state == "completed":
        return
    if study.state == "running" and any(trial.state == "failed" for trial in trials):
        study.state = "paused"
        study.pause_reason = "Retry failed Trials before resuming this Study."
        return
    if study.state == "running":
        state, candidates, completed = next_round(trials, study.settings, study.optimizer_state)
        study.optimizer_state = state
        for candidate in candidates:
            trial = Trial(study_id=study.id, **candidate, state="pending", next_stage="build", manual_retry_requested=False)
            db.add(trial)
            trials.append(trial)
        if candidates:
            await db.flush()
        if completed:
            # A terminal result can precede process teardown. Keep the Study
            # resumable/visible until its owned executions have all cleaned up.
            if not active and not unclean:
                study.state = "completed"
                study.finished_at = utcnow()
                study.updated_at = utcnow()
            return
    if study.definition["catalog_revision"] != catalog.meta()["catalogRevision"]:
        study.state = "paused"
        study.pause_reason = "Study Catalog revision is unavailable. Restore its Catalog to resume."
        return
    busy_trials = {submission.trial_id for submission, _ in [*active, *unclean]}
    slots = max(0, study.settings["max_parallel"] - len(busy_trials))
    for trial in trials:
        if slots == 0:
            break
        if trial.id in busy_trials or trial.state not in {"pending", "cancelled"}:
            continue
        if study.state != "running" and not trial.manual_retry_requested:
            continue
        try:
            async with db.begin_nested():
                await submit_stage(db, study, trial, catalog)
        except Exception as error:
            await db.refresh(trial)
            await pause_for_failure(db, study, trial, str(getattr(error, "detail", None) or error))
            return
        slots -= 1
        study.updated_at = utcnow()


async def reconcile_once(catalog):
    async with SessionLocal() as db:
        ids = list((await db.scalars(select(Study.id).where(Study.state != "completed").order_by(Study.created_at))).all())
    for study_id in ids:
        async with SessionLocal() as db:
            await serialize_events(db)
            study = await db.scalar(select(Study).where(Study.id == study_id).with_for_update())
            if study is None:
                continue
            try:
                await reconcile_study(db, study, catalog)
                await db.commit()
            except Exception as error:
                await db.rollback()
                logger.exception("Could not advance Study %s", study_id)
                # Submission errors (e.g. a saved contract mismatch) must be
                # visible and must not cause an infinite background retry loop.
                await serialize_events(db)
                study = await db.scalar(select(Study).where(Study.id == study_id).with_for_update())
                if study is not None:
                    study.state = "paused"
                    study.pause_reason = str(getattr(error, "detail", None) or error)
                    await db.commit()
    # Deliver persisted cancellations after their transaction commits. Repeating
    # the command is safe: launcher cancellation uses the complete attempt ID.
    async with SessionLocal() as db:
        cancelled = list((await db.scalars(select(Job).join(StageSubmission, StageSubmission.job_id == Job.id).where(
            Job.cancel_requested_at.is_not(None), Job.launcher_id.is_not(None), Job.cleaned_at.is_(None),
        ))).all())
    for job in cancelled:
        try:
            async with job_orchestrator.launcher_send_lock(job.launcher_id):
                await job_orchestrator.send_launcher_message(job.launcher_id,
                    {"type": "job.cancel", **execution_identity(job), "reason": job.last_error or "Study stopped."})
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
                logger.exception("Study reconciliation failed")
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
