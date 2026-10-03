"""Candidate strategies share Vars contracts, but own their numerical search state."""
from copy import deepcopy
from collections.abc import Callable
from dataclasses import dataclass
import math
from random import Random

from optimization.algorithm import coordinate_candidates, trial_rank, variables_fingerprint


@dataclass(frozen=True)
class SearchStrategy:
    prepare_state: Callable
    generate_round: Callable
    state_version: int = 1


def prepare_coordinate_state(settings, state, has_trials):
    # Legacy coordinate fields remain readable; explicit config is authoritative.
    settings.update(settings["algorithm"]["config"])
    step = state.setdefault("step", settings["initial_step"])
    if type(step) not in (float, int) or not math.isfinite(step) or step < 0:
        raise ValueError("Invalid saved coordinate search step; it cannot be reset on resume.")


def prepare_random_state(settings, state, has_trials):
    saved = state["algorithm_state"]
    if "rng_state" not in saved:
        if has_trials:
            raise ValueError("Random search state is missing; restarting its random stream would duplicate candidates.")
        rng_state = Random(settings["algorithm"]["config"]["seed"]).getstate()
        saved["rng_state"] = [rng_state[0], list(rng_state[1]), rng_state[2]]
    rng_state = saved["rng_state"]
    try:
        Random(0).setstate((rng_state[0], tuple(rng_state[1]), rng_state[2]))
    except (TypeError, ValueError, IndexError) as error:
        raise ValueError("Invalid saved random search state; it cannot be reset on resume.") from error


def generate_coordinate_round(trials, center, settings, state, *, solver_only=False):
    """Preserve coordinate ordering and each mode's historical reuse of old Trials."""
    state = deepcopy(state)
    previous_center = state.get("incumbent_ordinal")
    state["incumbent_ordinal"] = center.ordinal
    if state.get("generation_complete"):
        return state, []
    if not solver_only and len(trials) >= settings["max_trials"]:
        state["generation_complete"] = True
        return state, []
    if previous_center == center.ordinal:
        state["step"] /= 2
    budget = settings["max_trials"] - len(trials)
    known = {trial.fingerprint: trial for trial in trials}
    by_ordinal = {trial.ordinal: trial for trial in trials}
    while budget > 0 and state["step"] >= settings.get("min_step", 0.001):
        generated, ordinals = [], []
        for variables, fingerprint in coordinate_candidates(center.variables, settings["axes"], state["step"]):
            if fingerprint in known:
                if solver_only:
                    ordinals.append(known[fingerprint].ordinal)
                continue
            ordinal = len(trials) + len(generated) + 1
            generated.append({"ordinal": ordinal, "round_index": state["round_index"] + 1,
                              "variables": variables, "fingerprint": fingerprint})
            ordinals.append(ordinal)
            if len(generated) == budget:
                break
        if generated:
            state.update(round_index=state["round_index"] + 1, selection=[], round_ordinals=ordinals)
            return state, generated
        if solver_only and ordinals:
            previous = min([center, *(by_ordinal[index] for index in ordinals)],
                           key=lambda trial: trial_rank(trial, settings["objective"]["direction"]))
            if previous.id != center.id:
                center = previous
                state["incumbent_ordinal"] = center.ordinal
                continue
        state["step"] /= 2
    state["generation_complete"] = True
    return state, []


def generate_random_round(trials, center, settings, state, *, solver_only=False):
    """Uniform independent axes with a bounded, durable random stream."""
    state = deepcopy(state)
    state["incumbent_ordinal"] = center.ordinal
    if state.get("generation_complete"):
        return state, []
    config = settings["algorithm"]["config"]
    count = min(config["candidates_per_round"], settings["max_trials"] - len(trials))
    axes = [axis for axis in settings["axes"] if not axis["fixed"] and axis["min"] != axis["max"]]
    if count <= 0 or not axes:
        state["generation_complete"] = True
        return state, []
    saved = state["algorithm_state"]["rng_state"]
    rng = Random(0)
    rng.setstate((saved[0], tuple(saved[1]), saved[2]))
    known = {trial.fingerprint for trial in trials}
    generated = []
    for _ in range(count * 100):
        variables = deepcopy(settings["initial_vars"])
        for axis in axes:
            target = variables
            path = [axis["name"], *axis["indices"]]
            for index in path[:-1]:
                target = target[index]
            fraction = rng.random()
            # Interpolate endpoints without overflowing their finite difference.
            value = (1 - fraction) * axis["min"] + fraction * axis["max"]
            target[path[-1]] = min(axis["max"], max(axis["min"], value))
        fingerprint = variables_fingerprint(variables)
        if fingerprint in known:
            continue
        known.add(fingerprint)
        generated.append({"ordinal": len(trials) + len(generated) + 1,
            "round_index": state["round_index"] + 1, "variables": variables, "fingerprint": fingerprint})
        if len(generated) == count:
            break
    saved = rng.getstate()
    state["algorithm_state"]["rng_state"] = [saved[0], list(saved[1]), saved[2]]
    if len(generated) < count:
        state["generation_complete"] = True
    if generated:
        state.update(round_index=state["round_index"] + 1, selection=[],
                     round_ordinals=[item["ordinal"] for item in generated])
    return state, generated


SEARCH_STRATEGIES = {
    ("coordinate", 1): SearchStrategy(prepare_coordinate_state, generate_coordinate_round),
    ("random", 1): SearchStrategy(prepare_random_state, generate_random_round),
}
