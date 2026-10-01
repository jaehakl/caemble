"""Persisted coordinate rounds: predictions propose, actual Solver results move the center."""
from copy import deepcopy
from types import SimpleNamespace

from sqlalchemy import select

from gpstation.db import Job
from gpstation.service.batches import SERVER_ACTIVE_STATES, TERMINAL_STATES
from gpstation.service.state import utcnow
from optimization.algorithm import coordinate_candidates, trial_rank, variables_fingerprint
from optimization.db import Evaluation, EvaluationSubmission, Trial
from optimization.evaluations import ensure_evaluation, project_solver, solver_budget
from optimization.submissions import submit_predictions, submit_stage


def select_verifications(candidates, predictions, verified, axes, direction, remaining):
    """Best predicted candidate plus maximin exploration in normalized Vars space."""
    if not candidates or remaining <= 0:
        return []
    first = min(candidates, key=lambda trial: trial_rank(
        SimpleNamespace(result=predictions[trial.id].result, ordinal=trial.ordinal), direction))
    if remaining == 1 or len(candidates) == 1:
        return [first.id]

    def coordinates(trial):
        result = []
        for axis in axes:
            if axis["fixed"] or axis["min"] == axis["max"]:
                continue
            value = trial.variables[axis["name"]]
            for index in axis["indices"]:
                value = value[index]
            scale = max(abs(axis["min"]), abs(axis["max"]), 1)
            result.append((value / scale - axis["min"] / scale) / (axis["max"] / scale - axis["min"] / scale))
        return result

    references = [coordinates(trial) for trial in [*verified, first]]
    def distance(trial):
        position = coordinates(trial)
        return min(sum((x - y) ** 2 for x, y in zip(position, reference)) for reference in references)

    second = min((trial for trial in candidates if trial.id != first.id), key=lambda trial: (-distance(trial), trial.ordinal))
    return [first.id, second.id]


def advance_search(trials, evaluations, settings, state, budget):
    """Return state, candidate definitions, verification IDs, and termination reason."""
    state = deepcopy(state)
    state.setdefault("step", settings["initial_step"])
    state.setdefault("round_index", 0)
    if not trials:
        variables = deepcopy(settings["initial_vars"])
        state["round_ordinals"] = [1]
        return state, [{"ordinal": 1, "round_index": 0, "variables": variables,
                        "fingerprint": variables_fingerprint(variables)}], [], None
    predicted = {item.trial_id: item for item in evaluations if item.kind == "prediction" and item.state == "succeeded"}
    solved = {item.trial_id: item for item in evaluations if item.kind == "solver"}
    by_id = {trial.id: trial for trial in trials}
    if budget["remaining"] == 0:
        return state, [], [], "solver_budget_exhausted" if budget["used"] >= budget["limit"] else None
    if any(item.state in {"pending", "running", "cancelled"} for item in evaluations if item.kind == "solver"):
        return state, [], [], None
    current = [trial for trial in trials if trial.ordinal in state.get("round_ordinals", [1])]
    if any(trial.id not in predicted for trial in current):
        return state, [], [], None
    verified = [by_id[key] for key, value in solved.items() if value.state == "succeeded"]
    direction = settings["objective"]["direction"]
    if not state.get("selection"):
        pool = [trial for trial in current if trial.id not in solved]
        chosen = select_verifications(pool, predicted, verified, settings["axes"], direction, budget["remaining"])
        if chosen:
            state["selection"] = chosen
            state["selections"] = [*state.get("selections", []), {"round_index": state["round_index"], "trial_ids": chosen}]
            return state, [], chosen, None
    if not verified:
        return state, [], [], None
    center = min(verified, key=lambda trial: trial_rank(
        SimpleNamespace(result=solved[trial.id].result, ordinal=trial.ordinal), direction))
    previous_center = state.get("incumbent_ordinal")
    state["incumbent_ordinal"] = center.ordinal
    if len(trials) < settings["max_trials"] and not state.get("generation_complete"):
        if previous_center == center.ordinal:
            state["step"] /= 2
        known = {trial.fingerprint for trial in trials}
        while state["step"] >= settings["min_step"]:
            generated = []
            for variables, fingerprint in coordinate_candidates(center.variables, settings["axes"], state["step"]):
                if fingerprint in known:
                    continue
                generated.append({"ordinal": len(trials) + len(generated) + 1,
                    "round_index": state["round_index"] + 1, "variables": variables, "fingerprint": fingerprint})
                if len(generated) == settings["max_trials"] - len(trials):
                    break
            if generated:
                state.update(round_index=state["round_index"] + 1, selection=[],
                             round_ordinals=[trial["ordinal"] for trial in generated])
                return state, generated, [], None
            state["step"] /= 2
        state["generation_complete"] = True
    # Candidate generation has ended: spend remaining budget on saved predictions.
    pool = [trial for trial in trials if trial.id in predicted and trial.id not in solved]
    chosen = select_verifications(pool, predicted, verified, settings["axes"], direction, budget["remaining"])
    if chosen:
        state["selection"] = chosen
        state["selections"] = [*state.get("selections", []), {"round_index": state["round_index"], "trial_ids": chosen}]
        return state, [], chosen, None
    return state, [], [], "candidate_limit" if len(trials) >= settings["max_trials"] else "search_converged"


async def reconcile_hybrid(db, optimization, catalog):
    from optimization.controller import on_job_finished, optimization_jobs, pause_for_failure

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
        if not active and not children:
            optimization.state = "paused"
        return
    if optimization.state == "completed":
        return
    if optimization.definition["catalog_revision"] != catalog.meta()["catalogRevision"]:
        optimization.state, optimization.pause_reason = "paused", "Optimization Catalog revision is unavailable. Restore its Catalog to resume."
        return
    budget = await solver_budget(db, optimization)
    exhausted = budget["used"] >= budget["limit"]
    draining = exhausted and optimization.pause_reason != "Stopped by user."
    if optimization.state == "running" or draining:
        state, candidates, selected, reason = advance_search(trials, evaluations, optimization.settings, optimization.optimizer_state, budget)
        optimization.optimizer_state = state
        for candidate in candidates:
            trial = Trial(optimization_id=optimization.id, **candidate, state="pending", next_stage="build", manual_retry_requested=False)
            db.add(trial)
            await db.flush()
            trials.append(trial)
            evaluations.append(await ensure_evaluation(db, optimization, trial, "prediction"))
        for trial in trials:
            if trial.id in selected:
                evaluations.append(await ensure_evaluation(db, optimization, trial, "solver"))
        if reason:
            optimization.optimizer_state = {**optimization.optimizer_state, "termination_reason": reason}
            # A failed final Solver is retained. Completed output still gets its
            # free Calculation stage, and all parent/child cleanup must finish.
            postprocessing = any(item.next_stage == "calculate" and item.state != "succeeded" for item in evaluations)
            if not active and not children and not postprocessing:
                for evaluation in evaluations:
                    if evaluation.state in {"pending", "cancelled"}:
                        evaluation.state = "cancelled"
                        evaluation.manual_retry_requested = False
                        evaluation.error = {"message": "Solver budget exhausted.", "stage": evaluation.next_stage}
                        project_solver(next(trial for trial in trials if trial.id == evaluation.trial_id), evaluation)
                optimization.state, optimization.finished_at = "completed", utcnow()
                return
    busy = set((await db.scalars(select(EvaluationSubmission.evaluation_id).where(
        EvaluationSubmission.submission_id.in_([submission.id for submission, _ in active])))).all())
    by_trial = {trial.id: trial for trial in trials}
    busy_trials = {item.trial_id for item in evaluations if item.id in busy}
    slots = max(0, optimization.settings["max_parallel"] - len(busy_trials))
    predict = []
    for evaluation in evaluations:
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
