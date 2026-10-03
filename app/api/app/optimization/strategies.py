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


def initialize_de(problem):
    return {**initialize_random(problem), "population": [], "generation": 0, "pending": []}


def validate_de(state):
    if not isinstance(state, dict) or set(state) != {"rng_state", "population", "generation", "pending"}:
        raise ValueError("Invalid saved DE strategy state.")
    validate_random({"rng_state": state["rng_state"]})
    population, generation, pending = state["population"], state["generation"], state["pending"]
    if (not isinstance(population, list) or len(population) > 32
            or any(type(ordinal) is not int or ordinal < 1 for ordinal in population)
            or len(set(population)) != len(population)
            or type(generation) is not int or generation < 0 or not isinstance(pending, list)
            or (generation > 0 and len(population) < 4)
            or (generation == 0 and population != list(range(1, len(population) + 1)))):
        raise ValueError("Invalid saved DE population or generation state.")
    slots, children = set(), set()
    for challenge in pending:
        if (not isinstance(challenge, dict) or set(challenge) != {"slot", "target_ordinal", "child_ordinal"}
                or any(type(value) is not int for value in challenge.values())):
            raise ValueError("Invalid saved DE pending challenge state.")
        slot, target, child = challenge["slot"], challenge["target_ordinal"], challenge["child_ordinal"]
        if (not 0 <= slot < len(population) or population[slot] != target or child <= max(population)
                or child in population or child in children or slot in slots or generation == 0):
            raise ValueError("Invalid saved DE pending challenge state.")
        slots.add(slot)
        children.add(child)


def de_coordinates(variables, axes):
    positions = []
    for axis in axes:
        value = variables[axis["name"]]
        for index in axis["indices"]:
            value = value[index]
        lower, upper = axis["min"], axis["max"]
        width = upper - lower
        # A range may overflow even though both endpoints and every sample are finite.
        fraction = ((value - lower) / width if math.isfinite(width)
                    else (value / 2 - lower / 2) / (upper / 2 - lower / 2))
        positions.append(min(1.0, max(0.0, fraction)))
    return positions


def de_variables(base, axes, positions):
    variables = deepcopy(base)
    for axis, fraction in zip(axes, positions):
        if fraction is None:
            continue  # An uncrossed element must retain its exact original value.
        target = variables
        path = [axis["name"], *axis["indices"]]
        for index in path[:-1]:
            target = target[index]
        value = (1 - fraction) * axis["min"] + fraction * axis["max"]
        target[path[-1]] = min(axis["max"], max(axis["min"], value))
    return variables


def observe_de(problem, state, observations, round_ordinals):
    state = deepcopy(state)
    if len(state["population"]) > problem.config["population_size"]:
        raise ValueError("Saved DE population exceeds its configured size.")
    if not state["population"] and round_ordinals:
        raise ValueError("Saved DE population is missing from a completed round.")
    verified = {item.ordinal: item for item in observations
                if item.kind == "solver" and item.state == "succeeded" and item.result is not None}
    for challenge in state["pending"]:
        slot, target, child = challenge["slot"], challenge["target_ordinal"], challenge["child_ordinal"]
        if state["population"][slot] != target or child not in round_ordinals:
            raise ValueError("Saved DE challenge does not match the completed generation.")
        actual = verified.get(child)
        if actual is None:
            if problem.mode == "solver":
                raise ValueError("DE requires successful Solver observations before advancing.")
            continue
        incumbent = verified.get(target)
        if incumbent is None and problem.mode == "solver":
            raise ValueError("DE requires successful Solver observations for its parents.")
        # Unknown initial members supply geometry, never an invented fitness score.
        if incumbent is None or trial_rank(actual, problem.direction) < trial_rank(incumbent, problem.direction):
            state["population"][slot] = child
    # Unverified children lose their challenge here. Later verification can improve
    # the reported best result, but must not replay a replacement from an old generation.
    state["pending"] = []
    return state


def propose_de(problem, state, candidates, observations, remaining):
    state = deepcopy(state)
    if len(state["population"]) > problem.config["population_size"]:
        raise ValueError("Saved DE population exceeds its configured size.")
    if state["pending"]:
        raise ValueError("DE cannot propose before its pending generation is observed.")
    axes = [axis for axis in problem.axes if not axis["fixed"] and axis["min"] != axis["max"]]
    saved = state["rng_state"]
    rng = Random(0)
    rng.setstate((saved[0], tuple(saved[1]), saved[2]))
    known = {item.fingerprint for item in candidates}
    generated = []
    if not candidates:
        if state["population"] or state["generation"]:
            raise ValueError("Saved DE population is missing from candidate history.")
        count = min(problem.config["population_size"] if axes else 1, remaining)
        if count > 0:
            variables = deepcopy(problem.initial_vars)
            first = Candidate(1, variables, variables_fingerprint(variables))
            generated.append(first)
            known.add(first.fingerprint)
        for _ in range(count * 100):
            if len(generated) >= count:
                break
            variables = de_variables(problem.initial_vars, axes, [rng.random() for _ in axes])
            fingerprint = variables_fingerprint(variables)
            if fingerprint not in known:
                known.add(fingerprint)
                generated.append(Candidate(len(generated) + 1, variables, fingerprint))
        state["population"] = [item.ordinal for item in generated]
        complete = len(generated) < 4 or len(generated) >= remaining
    else:
        by_ordinal = {item.ordinal: item for item in candidates}
        if not state["population"] or any(ordinal not in by_ordinal for ordinal in state["population"]):
            raise ValueError("Saved DE population is missing from candidate history.")
        if remaining <= 0 or len(state["population"]) < 4 or not axes:
            return Proposal(state, complete=True)
        population = [by_ordinal[ordinal] for ordinal in state["population"]]
        positions = [de_coordinates(item.variables, axes) for item in population]
        for slot, target in enumerate(population):
            if len(generated) >= remaining:
                break
            donors = [index for index in range(len(population)) if index != slot]
            for _ in range(100):
                a, b, c = rng.sample(donors, 3)
                forced = rng.randrange(len(axes))
                child = [None] * len(axes)
                for index in range(len(axes)):
                    if rng.random() < problem.config["crossover_rate"] or index == forced:
                        mutant = positions[a][index] + problem.config["mutation_factor"] * (positions[b][index] - positions[c][index])
                        child[index] = min(1.0, max(0.0, mutant))
                variables = de_variables(target.variables, axes, child)
                fingerprint = variables_fingerprint(variables)
                if fingerprint in known:
                    continue
                known.add(fingerprint)
                ordinal = len(candidates) + len(generated) + 1
                generated.append(Candidate(ordinal, variables, fingerprint))
                state["pending"].append({"slot": slot, "target_ordinal": target.ordinal, "child_ordinal": ordinal})
                break
        if generated:
            state["generation"] += 1
        complete = not generated or len(generated) >= remaining
    saved = rng.getstate()
    state["rng_state"] = [saved[0], list(saved[1]), saved[2]]
    return Proposal(state, tuple(generated), tuple(item.ordinal for item in generated), complete)


SEARCH_STRATEGIES = {
    ("coordinate", 1): SearchStrategy(initialize_coordinate, validate_coordinate, propose_coordinate, observe_coordinate),
    ("random", 1): SearchStrategy(initialize_random, validate_random, propose_random, observe_random),
    ("de", 1): SearchStrategy(initialize_de, validate_de, propose_de, observe_de),
}
