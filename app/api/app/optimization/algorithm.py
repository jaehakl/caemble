"""Shared Vars, ranking and metric contracts for Optimization strategies."""

from __future__ import annotations

from copy import deepcopy
import hashlib
import itertools
import json
import math


def variables_fingerprint(variables: dict) -> str:
    # Canonicalize numeric spelling: 1 and 1.0 are the same candidate.
    def normalize(value):
        if isinstance(value, dict):
            return {key: normalize(item) for key, item in value.items()}
        if isinstance(value, list):
            return [normalize(item) for item in value]
        return float(value) if value != 0 else 0.0

    raw = json.dumps(normalize(variables), sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def prepare_axes(schema: dict, initial_vars: dict, overrides: list[dict] | None = None) -> list[dict]:
    """All elements are included unless an explicit override fixes them."""
    if set(initial_vars) != set(schema):
        raise ValueError("Initial Vars must contain exactly the saved Experiment's variables.")
    configured = {}
    for axis in overrides or []:
        key = (axis["name"], tuple(axis.get("indices", [])))
        if key in configured:
            raise ValueError("A variable element was configured more than once.")
        configured[key] = axis
    axes = []
    for name in sorted(schema):
        entry = schema[name]
        shape = entry.get("shape", [])
        if len(shape) > 2 or any(type(size) is not int or size < 1 for size in shape):
            raise ValueError(f"{name} has an invalid Vars shape.")
        lower, upper = entry["min"], entry["max"]
        if any(type(bound) not in (int, float) or not math.isfinite(bound) for bound in (lower, upper)) or lower > upper:
            raise ValueError(f"{name} has an invalid Vars range.")

        def check_shape(value, remaining):
            if remaining:
                if not isinstance(value, list) or len(value) != remaining[0]:
                    raise ValueError(f"Initial {name} does not match its Vars shape.")
                for item in value:
                    check_shape(item, remaining[1:])
            elif type(value) not in (int, float) or not math.isfinite(value) or not lower <= value <= upper:
                raise ValueError(f"Initial {name} must be finite and inside its Vars range.")

        check_shape(initial_vars[name], shape)
        for indices in itertools.product(*(range(size) for size in shape)):
            setting = configured.pop((name, indices), {})
            minimum, maximum = setting.get("min", lower), setting.get("max", upper)
            if any(type(bound) not in (int, float) or not math.isfinite(bound) for bound in (minimum, maximum)) or not lower <= minimum <= maximum <= upper:
                raise ValueError(f"Search bounds for {name}{list(indices)} must lie inside its Vars range.")
            value = initial_vars[name]
            for index in indices:
                value = value[index]
            fixed = setting.get("fixed", False) or minimum == maximum
            if not minimum <= value <= maximum:
                raise ValueError(f"Initial {name}{list(indices)} is outside its search range.")
            axes.append({"name": name, "indices": list(indices), "min": minimum, "max": maximum, "fixed": fixed})
    if configured:
        raise ValueError("A search axis refers to an unknown Vars element.")
    return axes


def coordinate_candidates(variables: dict, axes: list[dict], step: float):
    seen = {variables_fingerprint(variables)}
    for axis in axes:
        if axis["fixed"] or axis["min"] == axis["max"]:
            continue
        value = variables[axis["name"]]
        for index in axis["indices"]:
            value = value[index]
        # Scale the endpoints before subtracting: a finite range can have an
        # overflowing width, even though its quarter-step remains finite.
        offset = step * axis["max"] - step * axis["min"]
        for direction in (1, -1):
            candidate = deepcopy(variables)
            target = candidate
            path = [axis["name"], *axis["indices"]]
            for index in path[:-1]:
                target = target[index]
            target[path[-1]] = min(axis["max"], max(axis["min"], value + direction * offset))
            fingerprint = variables_fingerprint(candidate)
            if fingerprint not in seen:
                seen.add(fingerprint)
                yield candidate, fingerprint


def evaluate_metrics(calculations: list[dict], settings: dict) -> dict:
    values = {item["key"]: item["value"] for item in calculations}
    expected = {"objective", *(constraint["key"] for constraint in settings["constraints"])}
    if set(values) != expected or len(values) != len(calculations):
        raise ValueError("Evaluation metrics differ from the frozen Optimization definition.")
    if any(type(value) not in (int, float) or not math.isfinite(value) for value in values.values()):
        raise ValueError("An evaluation metric must be a finite scalar.")
    constraints, violation = [], 0.0
    for constraint in settings["constraints"]:
        value = values[constraint["key"]]
        minimum, maximum = constraint.get("minimum"), constraint.get("maximum")
        bounds = [bound for bound in (minimum, maximum) if bound is not None]
        scale = max(1, *(abs(bound) for bound in bounds))
        # Normalize before subtraction so opposite finite extremes do not
        # overflow before their distance is divided by the constraint scale.
        violation += max(0, minimum / scale - value / scale if minimum is not None else 0,
                         value / scale - maximum / scale if maximum is not None else 0)
        if not math.isfinite(violation):
            raise ValueError("Aggregate constraint violation must be finite.")
        satisfied = (minimum is None or minimum <= value) and (maximum is None or value <= maximum)
        constraints.append({**constraint, "value": value, "satisfied": satisfied})
    return {"objective": values["objective"], "feasible": all(item["satisfied"] for item in constraints),
            "violation": violation, "constraints": constraints}


def trial_rank(trial, direction: str) -> tuple:
    result = trial.result
    if result["feasible"]:
        objective = result["objective"] * (-1 if direction == "maximize" else 1)
        return (0, objective, trial.ordinal)
    return (1, result["violation"], trial.ordinal)


def next_round(trials: list, settings: dict, state: dict) -> tuple[dict, list[dict], bool]:
    """Compatibility entry point for the pure Solver-only search coordinator."""
    from optimization.search import advance_solver_search
    state, candidates, _, reason = advance_solver_search(trials, settings, state)
    return state, candidates, reason is not None
