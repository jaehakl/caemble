"""Pure Hybrid search decisions; execution and persistence belong to the controller.

Candidate generation and Solver verification selection are independent policies.
Their state stays in the existing JSON optimizer_state so saved searches resume
without converting their history or discarding execution metadata.
"""
from copy import deepcopy
from types import SimpleNamespace

from optimization.algorithm import coordinate_candidates, trial_rank, variables_fingerprint


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


def generate_coordinate_round(trials, center, settings, state):
    """Return copied state and unseen candidates around a Solver-verified center."""
    state = deepcopy(state)
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
                return state, generated
            state["step"] /= 2
        state["generation_complete"] = True
    return state, []


def advance_search(trials, evaluations, settings, state, budget):
    """Return state, candidate definitions, verification IDs, and termination reason.

    Inputs are read-only snapshots exposing Trial/Evaluation attributes; neither
    policy imports their database types. The caller persists this decision in
    its existing transaction and owns Solver budget reservations and Job state.
    """
    state = deepcopy(state)
    state.setdefault("step", settings["initial_step"])
    state.setdefault("round_index", 0)
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
    state, generated = generate_coordinate_round(trials, center, settings, state)
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
    chosen = select_verifications(pool, predicted, verified, settings["axes"], direction, budget["remaining"])
    if chosen:
        state["selection"] = chosen
        state["selections"] = [*state.get("selections", []), {"round_index": state["round_index"], "trial_ids": chosen}]
        return state, [], chosen, None
    return state, [], [], "candidate_limit" if len(trials) >= settings["max_trials"] else "search_converged"
