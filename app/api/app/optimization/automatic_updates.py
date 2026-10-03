"""Persist automatic policy inputs and reuse the existing model-update executor."""
from datetime import datetime, timedelta
import logging
from uuid import UUID, uuid5

from fastapi import HTTPException
from sqlalchemy import distinct, func, select

from gpstation.db import Job
from gpstation.service.state import utcnow
from optimization.configuration import ModelUpdatePolicy
from optimization.model_update_policy import decide_update
from prediction.db import DatasetRevision
from simulation.db import Measurement, RecordedData

logger = logging.getLogger(__name__)


def automatic_state(optimization, state):
    policy = (optimization.settings.get("hybrid") or {}).get("model_update_policy")
    if policy is None:
        return None
    ModelUpdatePolicy.model_validate(policy)
    if "automatic" not in state:
        initial = state["initial_model"]
        state["automatic"] = {"version": 1, "baseline_snapshot": {
            "datasetId": initial["dataset_id"], "revision": initial["dataset_revision"],
            "fingerprint": initial["dataset_fingerprint"]}, "new_measurements": 0,
            "attempts": 0, "elapsed_seconds": 0, "last_request_round": None,
            "reason": "awaiting_round", "error": None}
    automatic = state["automatic"]
    if type(automatic.get("version")) is not int or automatic["version"] != 1:
        raise ValueError("Unsupported automatic model-update state version; it cannot be reset on resume.")
    return automatic


async def refresh_automatic_state(db, optimization, state):
    """Read metadata only: tensors stay in the existing snapshot/training path."""
    automatic = automatic_state(optimization, state)
    if automatic is None:
        return
    attempts = [item["automatic_attempt"] for item in state["updates"] if item.get("automatic_attempt")]
    now = utcnow()
    automatic["attempts"] = len(attempts)
    automatic["elapsed_seconds"] = sum(attempt.get("elapsed_seconds", max(0,
        (now - datetime.fromisoformat(attempt["started_at"])).total_seconds())) for attempt in attempts)
    if optimization.state == "completed":
        return
    if optimization.state != "running":
        automatic["reason"] = "not_running"
    elif automatic["reason"] == "not_running":
        automatic["reason"] = "awaiting_round"
    baseline = automatic["baseline_snapshot"]
    revision = await db.get(DatasetRevision, (baseline["datasetId"], baseline["revision"]))
    if revision is None or revision.fingerprint != baseline["fingerprint"]:
        automatic.update(new_measurements=0, reason="source_unavailable",
            error={"message": "The automatic model-update baseline snapshot is unavailable."})
        return
    inventory = revision.summary.get("sample_fingerprints")
    if inventory is None:
        from prediction.datasets import sample_fingerprints
        if revision.payload is None:
            automatic.update(new_measurements=0, reason="source_unavailable",
                error={"message": "The automatic model-update baseline has no sample inventory."})
            return
        inventory = sample_fingerprints(revision.payload)
    records = [item["id"] for item in state["initial_model"]["source_contracts"]["records"]]
    complete = (select(Measurement.id).join(RecordedData, RecordedData.measurement_id == Measurement.id)
        .where(Measurement.user_id == optimization.user_id, Measurement.experiment_id == optimization.experiment_id,
            Measurement.recorded_at.is_not(None), RecordedData.user_id == optimization.user_id,
            RecordedData.experiment_record_id.in_(records), func.jsonb_typeof(RecordedData.data) == "object",
            Measurement.id.not_in([int(identity) for identity in inventory]))
        .group_by(Measurement.id).having(func.count(distinct(RecordedData.experiment_record_id)) == len(records)))
    automatic["new_measurements"] = await db.scalar(select(func.count()).select_from(complete.subquery()))
    if automatic["reason"] == "source_unavailable":
        automatic.update(reason="awaiting_round", error=None)


async def reconcile_automatic_attempt(db, item, operation, run):
    """Deadlines belong to the original pin, never to an explicit manual retry."""
    attempt = item.get("automatic_attempt")
    if attempt is None:
        return False
    from prediction import training

    now = utcnow()
    same_attempt = run is not None and run.pin_id == attempt["pin_id"]
    job = await db.get(Job, attempt["job_id"]) if attempt.get("job_id") else None
    terminal = operation is None or operation.state in {"completed", "failed", "interrupted", "cancelled"}
    ended_at = ((operation.completed_at or operation.updated_at) if operation and terminal and same_attempt
                else job.finished_at if job is not None else None)
    deadline = datetime.fromisoformat(attempt["deadline_at"])
    if "finished_at" not in attempt:
        if same_attempt and (ended_at or now) >= deadline:
            attempt["timed_out"] = True
            if not terminal:
                await training.cancel(db, operation)
                ended_at = operation.completed_at
        if terminal or not same_attempt or ended_at is not None:
            ended_at = ended_at or now
            attempt["finished_at"] = ended_at.isoformat()
            attempt["elapsed_seconds"] = max(0,
                (ended_at - datetime.fromisoformat(attempt["started_at"])).total_seconds())
    if same_attempt and attempt.get("timed_out"):
        item.update(state="timed_out", error={"code": "automatic-update-timeout",
            "message": "Automatic training exceeded its waiting and training time budget. The active model is retained."})
        return True
    return False


async def request_automatic_update(db, optimization, *, next_round, training_busy):
    """Called under the controller's event/Optimization locks at a round boundary."""
    from optimization.model_updates import model_state, request_update, save_state
    from optimization.schemas import OptimizationModelUpdateRequest

    state = model_state(optimization)
    automatic = automatic_state(optimization, state)
    if automatic is None:
        return False
    if automatic["reason"] == "source_unavailable":
        return False
    policy = ModelUpdatePolicy.model_validate(optimization.settings["hybrid"]["model_update_policy"])
    round_index = optimization.optimizer_state.get("round_index", 0)
    decision = decide_update(policy.config, running=optimization.state == "running", next_round=next_round,
        round_index=round_index, last_request_round=automatic["last_request_round"], busy=training_busy,
        pending_model=state["pending_model"] is not None, new_measurements=automatic["new_measurements"],
        attempts=automatic["attempts"], elapsed_seconds=automatic["elapsed_seconds"])
    automatic.update(reason=decision.reason, error=None)
    save_state(optimization, state)
    if decision.reason != "request":
        return False
    request_id = uuid5(UUID(optimization.id), f"automatic-model-update/v1/{round_index}")
    try:
        async with db.begin_nested():
            return await request_update(db, optimization,
                OptimizationModelUpdateRequest(request_id=request_id, update_mode="rebuild"),
                automatic_request={"round_index": round_index, "timeout_seconds": decision.timeout_seconds})
    except Exception as error:
        # Conflicting model owners and unavailable sources are admission failures,
        # not failed search evaluations. Roll back the entire snapshot/reservation.
        await db.refresh(optimization)
        state = model_state(optimization)
        if not isinstance(error, HTTPException):
            logger.exception("Could not reserve automatic training for Optimization %s", optimization.id)
        state["automatic"].update(reason="admission_deferred", error={"message": str(getattr(error, "detail", None) or error)})
        save_state(optimization, state)
        return False


def record_requested_snapshot(optimization, state, target, item, run, automatic_request):
    automatic = automatic_state(optimization, state)
    if automatic is None:
        return
    automatic.update(baseline_snapshot=target, new_measurements=0)
    if automatic_request is not None:
        started = utcnow()
        item.update(origin="automatic", requested_round=automatic_request["round_index"], automatic_attempt={
            "pin_id": run.pin_id, "job_id": None, "started_at": started.isoformat(),
            "deadline_at": (started + timedelta(seconds=automatic_request["timeout_seconds"])).isoformat()})
        automatic.update(attempts=automatic["attempts"] + 1,
            last_request_round=automatic_request["round_index"], reason="training_busy", error=None)
