"""Pure round coordination shared by Solver-only and Hybrid execution.

Strategies generate candidates; verification policies select Solver work. Callers
persist each decision and its candidates atomically through existing Trial/Job services.
"""
from copy import deepcopy
from types import SimpleNamespace

from optimization.algorithm import trial_rank, variables_fingerprint
from optimization.configuration import saved_algorithm, VerificationPolicy
from optimization.strategies import SEARCH_STRATEGIES, generate_coordinate_round
from optimization.verification import VERIFICATION_POLICIES, select_verifications


def prepare_search(settings, state, has_trials):
    settings, state = deepcopy(settings), deepcopy(state)
    algorithm = saved_algorithm(settings)
    settings["algorithm"] = algorithm
    if type(state.get("search_version", 1)) is not int or state.get("search_version", 1) != 1:
        raise ValueError("Unsupported Optimization search state version. Restore a compatible server to resume.")
    state["search_version"] = 1
    strategy = SEARCH_STRATEGIES[(algorithm["id"], algorithm["version"])]
    identity = {"id": algorithm["id"], "version": algorithm["version"], "state_version": strategy.state_version}
    if "algorithm_state" not in state:
        state["algorithm_state"] = identity.copy()
    saved = state["algorithm_state"]
    if not isinstance(saved, dict) or any(type(saved.get(key)) is not type(value) or saved.get(key) != value for key, value in identity.items()):
        raise ValueError("Unsupported Optimization algorithm state or implementation version.")
    strategy.prepare_state(settings, state, has_trials)
    state.setdefault("round_index", 0)
    policy = VerificationPolicy.model_validate((settings.get("hybrid") or {}).get("verification_policy") or {}).model_dump()
    return settings, state, strategy, VERIFICATION_POLICIES[(policy["id"], policy["version"])]


def advance_candidates(trials, center, settings, state, strategy, *, solver_only):
    """Apply one completed round once, including when only saved candidates remain."""
    if state.get("completed_round_index", -1) >= state["round_index"]:
        return state, []
    state["completed_round_index"] = state["round_index"]
    return strategy.generate_round(trials, center, settings, state, solver_only=solver_only)


def advance_solver_search(trials, settings, state):
    settings, state, strategy, _ = prepare_search(settings, state, bool(trials))
    if state.get("termination_reason"):
        return state, [], [], state["termination_reason"]
    if not trials:
        variables = deepcopy(settings["initial_vars"])
        state["round_ordinals"] = [1]
        return state, [{"ordinal": 1, "round_index": 0, "variables": variables,
                        "fingerprint": variables_fingerprint(variables)}], [], None
    by_ordinal = {trial.ordinal: trial for trial in trials}
    current = [by_ordinal[ordinal] for ordinal in state.get("round_ordinals", [1])]
    if any(trial.state != "succeeded" for trial in current):
        return state, [], [], None
    incumbent = by_ordinal.get(state.get("incumbent_ordinal"))
    center = min([*current, *([incumbent] if incumbent is not None else [])],
                 key=lambda trial: trial_rank(trial, settings["objective"]["direction"]))
    state, generated = advance_candidates(trials, center, settings, state, strategy, solver_only=True)
    if generated:
        return state, generated, [], None
    reason = "candidate_limit" if len(trials) >= settings["max_trials"] else "search_converged"
    state["termination_reason"] = reason
    return state, [], [], reason


def advance_search(trials, evaluations, settings, state, budget):
    """Return state, candidate definitions, verification IDs, and termination reason.

    Inputs are read-only snapshots exposing Trial/Evaluation attributes; neither
    policy imports their database types. The caller persists this decision in
    its existing transaction and owns Solver budget reservations and Job state.
    """
    settings, state, strategy, select_policy = prepare_search(settings, state, bool(trials))
    if state.get("termination_reason"):
        return state, [], [], state["termination_reason"]
    if not trials:
        variables = deepcopy(settings["initial_vars"])
        state["round_ordinals"] = [1]
        return state, [{"ordinal": 1, "round_index": 0, "variables": variables,
                        "fingerprint": variables_fingerprint(variables)}], [], None
    source_hash = state.get("round_source_hash")
    predicted = {item.trial_id: item for item in evaluations if item.kind == "prediction" and item.state == "succeeded"
                 and (source_hash is None or item.source_hash == source_hash)}
    solved = {item.trial_id: item for item in evaluations if item.kind == "solver"}
    by_id = {trial.id: trial for trial in trials}
    if budget["remaining"] == 0:
        reason = "solver_budget_exhausted" if budget["used"] >= budget["limit"] else None
        if reason:
            state["termination_reason"] = reason
        return state, [], [], reason
    if any(item.state in {"pending", "running", "cancelled"} for item in evaluations if item.kind == "solver"):
        return state, [], [], None
    current = [trial for trial in trials if trial.ordinal in state.get("round_ordinals", [1])]
    if any(trial.id not in predicted for trial in current):
        return state, [], [], None
    verified = [by_id[key] for key, value in solved.items() if value.state == "succeeded"]
    direction = settings["objective"]["direction"]
    if not state.get("selection"):
        pool = [trial for trial in current if trial.id not in solved]
        chosen = select_policy(pool, predicted, verified, settings["axes"], direction, budget["remaining"])
        if chosen:
            state["selection"] = chosen
            state["selections"] = [*state.get("selections", []), {"round_index": state["round_index"], "trial_ids": chosen}]
            return state, [], chosen, None
    if not verified:
        return state, [], [], None
    center = min(verified, key=lambda trial: trial_rank(
        SimpleNamespace(result=solved[trial.id].result, ordinal=trial.ordinal), direction))
    state, generated = advance_candidates(trials, center, settings, state, strategy, solver_only=False)
    if generated:
        return state, generated, [], None
    # Candidate generation has ended: spend remaining budget on saved predictions.
    pool = sorted((trial for trial in trials if trial.id not in solved), key=lambda trial: trial.ordinal)
    if pool and state.get("round_source_hash") is not None and state.get("selection"):
        # Comparing saved candidates is another decision round. The controller
        # binds its model and ensures every member has that model's Evaluation.
        state.update(round_index=state["round_index"] + 1, selection=[],
                     round_ordinals=[trial.ordinal for trial in pool], generation_complete=True)
        return state, [], [], None
    pool = [trial for trial in pool if trial.id in predicted]
    chosen = select_policy(pool, predicted, verified, settings["axes"], direction, budget["remaining"])
    if chosen:
        state["selection"] = chosen
        state["selections"] = [*state.get("selections", []), {"round_index": state["round_index"], "trial_ids": chosen}]
        return state, [], chosen, None
    reason = "candidate_limit" if len(trials) >= settings["max_trials"] else "search_converged"
    state["termination_reason"] = reason
    return state, [], [], reason
