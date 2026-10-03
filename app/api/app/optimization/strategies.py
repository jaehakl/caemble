"""Pure candidate strategies; numerical state never belongs to the coordinator."""
from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass
import math
from random import Random
from typing import Any, Literal

from optimization.algorithm import coordinate_candidates, trial_rank, variables_fingerprint


@dataclass(frozen=True)
class SearchProblem:
    initial_vars: dict[str, Any]
    axes: tuple[dict, ...]
    direction: Literal["minimize", "maximize"]
    constraints: tuple[dict, ...]
    config: dict
    mode: Literal["solver", "hybrid"]


@dataclass(frozen=True)
class Candidate:
    ordinal: int
    variables: dict[str, Any]
    fingerprint: str
    id: str | None = None


@dataclass(frozen=True)
class Observation:
    candidate: Candidate
    evaluation_id: str | None
    kind: Literal["prediction", "solver"]
    state: Literal["pending", "running", "succeeded", "failed", "cancelled"]
    result: dict | None
    definition_hash: str | None = None
    source_hash: str | None = None
    source: dict | None = None
    error: dict | None = None

    @property
    def ordinal(self):
        return self.candidate.ordinal


@dataclass(frozen=True)
class Proposal:
    state: dict
    candidates: tuple[Candidate, ...] = ()
    round_ordinals: tuple[int, ...] = ()
    complete: bool = False


@dataclass(frozen=True)
class SearchStrategy:
    initialize: Callable[[SearchProblem], dict]
    validate: Callable[[dict], None]
    propose: Callable[[SearchProblem, dict, tuple[Candidate, ...], tuple[Observation, ...], int], Proposal]
    observe: Callable[[SearchProblem, dict, tuple[Observation, ...], tuple[int, ...]], dict]
    state_version: int = 2


def initialize_coordinate(problem):
    return {"step": problem.config["initial_step"], "incumbent_ordinal": None, "center_unchanged": False}


def validate_coordinate(state):
    if not isinstance(state, dict) or set(state) != {"step", "incumbent_ordinal", "center_unchanged"}:
        raise ValueError("Invalid saved coordinate strategy state.")
    step, incumbent = state["step"], state["incumbent_ordinal"]
    if (type(step) not in (float, int) or not math.isfinite(step) or not 0 <= step <= 1
            or (incumbent is not None and (type(incumbent) is not int or incumbent < 1))
            or type(state["center_unchanged"]) is not bool):
        raise ValueError("Invalid saved coordinate strategy state.")


def observe_coordinate(problem, state, observations, round_ordinals):
    state = deepcopy(state)
    previous = state["incumbent_ordinal"]
    eligible = [item for item in observations if item.kind == "solver" and item.state == "succeeded"
                and (problem.mode == "hybrid" or item.ordinal in round_ordinals or item.ordinal == previous)]
    if not eligible:
        raise ValueError("Coordinate search requires successful Solver observations before advancing.")
    center = min(eligible, key=lambda item: trial_rank(item, problem.direction))
    state.update(incumbent_ordinal=center.ordinal, center_unchanged=previous == center.ordinal)
    return state


def propose_coordinate(problem, state, candidates, observations, remaining):
    state = deepcopy(state)
    if not candidates:
        variables = deepcopy(problem.initial_vars)
        return Proposal(state, (Candidate(1, variables, variables_fingerprint(variables)),), (1,))
    by_ordinal = {item.ordinal: item for item in candidates}
    center = by_ordinal.get(state["incumbent_ordinal"])
    if center is None:
        raise ValueError("Saved coordinate incumbent is missing from candidate history.")
    if problem.mode == "hybrid" and remaining <= 0:
        return Proposal(state, complete=True)
    if state["center_unchanged"]:
        state["step"] /= 2
    known = {item.fingerprint: item for item in candidates}
    verified = {item.ordinal: item for item in observations if item.kind == "solver" and item.state == "succeeded"}
    while remaining > 0 and state["step"] >= problem.config["min_step"]:
        generated, ordinals = [], []
        for variables, fingerprint in coordinate_candidates(center.variables, problem.axes, state["step"]):
            if fingerprint in known:
                if problem.mode == "solver":
                    ordinals.append(known[fingerprint].ordinal)
                continue
            ordinal = len(candidates) + len(generated) + 1
            generated.append(Candidate(ordinal, variables, fingerprint))
            ordinals.append(ordinal)
            if len(generated) == remaining:
                break
        if generated:
            return Proposal(state, tuple(generated), tuple(ordinals))
        if problem.mode == "solver" and ordinals:
            previous = min((verified[index] for index in [center.ordinal, *ordinals]),
                           key=lambda item: trial_rank(item, problem.direction))
            if previous.ordinal != center.ordinal:
                center = previous.candidate
                state["incumbent_ordinal"] = center.ordinal
                continue
        state["step"] /= 2
    return Proposal(state, complete=True)


def initialize_random(problem):
    saved = Random(problem.config["seed"]).getstate()
    return {"rng_state": [saved[0], list(saved[1]), saved[2]]}


def validate_random(state):
    if not isinstance(state, dict) or set(state) != {"rng_state"}:
        raise ValueError("Invalid saved random strategy state.")
    saved = state["rng_state"]
    try:
        if not isinstance(saved, list) or len(saved) != 3:
            raise ValueError("Invalid random state shape")
        Random(0).setstate((saved[0], tuple(saved[1]), saved[2]))
    except (TypeError, ValueError, IndexError) as error:
        raise ValueError("Invalid saved random strategy state; it cannot be reset on resume.") from error


def observe_random(problem, state, observations, round_ordinals):
    """Independent random proposals do not learn from objective values."""
    return deepcopy(state)


def propose_random(problem, state, candidates, observations, remaining):
    state = deepcopy(state)
    if not candidates:
        variables = deepcopy(problem.initial_vars)
        return Proposal(state, (Candidate(1, variables, variables_fingerprint(variables)),), (1,))
    count = min(problem.config["candidates_per_round"], remaining)
    axes = [axis for axis in problem.axes if not axis["fixed"] and axis["min"] != axis["max"]]
    if count <= 0 or not axes:
        return Proposal(state, complete=True)
    saved = state["rng_state"]
    rng = Random(0)
    rng.setstate((saved[0], tuple(saved[1]), saved[2]))
    known = {item.fingerprint for item in candidates}
    generated = []
    for _ in range(count * 100):
        variables = deepcopy(problem.initial_vars)
        for axis in axes:
            target = variables
            path = [axis["name"], *axis["indices"]]
            for index in path[:-1]:
                target = target[index]
            fraction = rng.random()
            value = (1 - fraction) * axis["min"] + fraction * axis["max"]
            target[path[-1]] = min(axis["max"], max(axis["min"], value))
        fingerprint = variables_fingerprint(variables)
        if fingerprint in known:
            continue
        known.add(fingerprint)
        generated.append(Candidate(len(candidates) + len(generated) + 1, variables, fingerprint))
        if len(generated) == count:
            break
    saved = rng.getstate()
    state["rng_state"] = [saved[0], list(saved[1]), saved[2]]
    return Proposal(state, tuple(generated), tuple(item.ordinal for item in generated), len(generated) < count)


SEARCH_STRATEGIES = {
    ("coordinate", 1): SearchStrategy(initialize_coordinate, validate_coordinate, propose_coordinate, observe_coordinate),
    ("random", 1): SearchStrategy(initialize_random, validate_random, propose_random, observe_random),
}
