from __future__ import annotations

import math
from typing import Any

import numpy as np

from app.errors import CaeError
from app.solver_framework.units import convert_ucum_tensor


def normalize_task_config(
    descriptor: dict[str, Any],
    config: Any,
    task_name: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    path = f"task {task_name}"
    if not isinstance(config, dict) or set(config) != {
        "parameters",
        "initializations",
        "boundaryConditions",
        "outputs",
    }:
        raise CaeError(
            "invalid_task",
            f"{path} must contain parameters, initializations, boundaryConditions, and outputs",
        )
    normalized_parameters = _normalize_parameter_values(
        config["parameters"],
        descriptor.get("parameters"),
        f"{path}.parameters",
    )
    methods = descriptor.get("methods")
    if not isinstance(methods, dict):
        raise CaeError("descriptor_mismatch", f"{path} manifest methods are invalid")
    normalized_calls: dict[str, list[dict[str, Any]]] = {}
    resolved_outputs: dict[str, Any] = {}
    for category in ("initializations", "boundaryConditions", "outputs"):
        calls = config[category]
        declared = methods.get(category)
        if not isinstance(calls, list) or not isinstance(declared, list):
            raise CaeError("invalid_task", f"{path}.{category} must be an array")
        by_id = {
            method.get("methodId"): method
            for method in declared
            if isinstance(method, dict) and isinstance(method.get("methodId"), str)
        }
        for method_id, method in by_id.items():
            count = sum(
                isinstance(call, dict) and call.get("methodId") == method_id
                for call in calls
            )
            minimum = method.get("minimumOccurrences")
            maximum = method.get("maximumOccurrences")
            if (
                not isinstance(minimum, int)
                or not isinstance(maximum, int)
                or not minimum <= count <= maximum
            ):
                raise CaeError(
                    "invalid_task",
                    f"{path}.{category} method {method_id!r} occurs {count} times; expected {minimum}..{maximum}",
                )
        normalized_category: list[dict[str, Any]] = []
        for index, call in enumerate(calls):
            call_path = f"{path}.{category}[{index}]"
            expected_keys = {"methodId", "target", "parameters"}
            if category == "outputs":
                expected_keys.add("key")
            if not isinstance(call, dict) or set(call) != expected_keys:
                raise CaeError(
                    "invalid_task",
                    f"{call_path} must contain exactly {', '.join(sorted(expected_keys))}",
                )
            method_id = call.get("methodId")
            method = by_id.get(method_id)
            if method is None:
                raise CaeError(
                    "invalid_task",
                    f"{call_path}.methodId {method_id!r} is not declared by the solver manifest",
                )
            target = call.get("target")
            target_spec = method.get("target")
            if not isinstance(target, list) or not isinstance(target_spec, dict):
                raise CaeError("invalid_task", f"{call_path}.target is invalid")
            minimum_targets = target_spec.get("minimumTargets")
            maximum_targets = target_spec.get("maximumTargets")
            if (
                not isinstance(minimum_targets, int)
                or not isinstance(maximum_targets, int)
                or not minimum_targets <= len(target) <= maximum_targets
                or len(set(target)) != len(target)
            ):
                raise CaeError(
                    "invalid_task",
                    f"{call_path}.target count must be {minimum_targets}..{maximum_targets} with no duplicates",
                )
            prefix = f"{target_spec.get('source')}.{target_spec.get('kind')}."
            invalid_target = next(
                (
                    item
                    for item in target
                    if not isinstance(item, str)
                    or not item.startswith(prefix)
                    or item == prefix
                ),
                None,
            )
            if invalid_target is not None:
                raise CaeError(
                    "invalid_task",
                    f"{call_path}.target entry {invalid_target!r} must match {prefix}<group>",
                )
            normalized = {
                "methodId": method_id,
                "target": list(target),
                "parameters": _normalize_parameter_values(
                    call.get("parameters"),
                    method.get("parameters"),
                    f"{call_path}.parameters",
                ),
            }
            if category == "outputs":
                key = call.get("key")
                if not isinstance(key, str) or not key.strip() or key in resolved_outputs:
                    raise CaeError(
                        "invalid_task",
                        f"{call_path}.key must be unique and non-empty",
                    )
                normalized["key"] = key
                resolved_outputs[key] = {
                    "artifactType": method.get("artifactType"),
                    "data": method.get("data"),
                }
            normalized_category.append(normalized)
        normalized_calls[category] = normalized_category
    minimum_outputs = descriptor.get("minimumOutputs", 0)
    if not isinstance(minimum_outputs, int) or len(config["outputs"]) < minimum_outputs:
        raise CaeError(
            "invalid_task",
            f"{path}.outputs must contain at least {minimum_outputs} entries",
        )
    return (
        {
            "parameters": normalized_parameters,
            "initializations": normalized_calls["initializations"],
            "boundaryConditions": normalized_calls["boundaryConditions"],
            "outputs": normalized_calls["outputs"],
        },
        resolved_outputs,
    )


def validate_normalized_task_config(
    descriptor: dict[str, Any],
    config: Any,
    task_name: str,
) -> dict[str, Any]:
    return normalize_task_config(descriptor, config, task_name)[1]


def _normalize_parameter_values(
    values: Any,
    specs: Any,
    path: str,
) -> dict[str, Any]:
    if not isinstance(values, dict) or not isinstance(specs, dict):
        raise CaeError("invalid_task", f"{path} must be an object")
    undeclared = next((name for name in values if name not in specs), None)
    if undeclared is not None:
        raise CaeError(
            "invalid_task",
            f"{path}.{undeclared} is not declared by the solver manifest",
        )
    normalized: dict[str, Any] = {}
    for name, parameter in specs.items():
        if not isinstance(parameter, dict) or not isinstance(parameter.get("data"), dict):
            raise CaeError("descriptor_mismatch", f"{path}.{name} manifest is invalid")
        if name not in values:
            if parameter.get("required", True):
                raise CaeError("invalid_task", f"{path}.{name} is required")
            continue
        normalized[name] = normalize_parameter_value(
            values[name],
            parameter["data"],
            f"{path}.{name}",
        )
    return normalized


def normalize_parameter_value(
    value: Any,
    spec: dict[str, Any],
    path: str = "parameter",
) -> Any:
    dtype_name = spec.get("dtype")
    if not isinstance(dtype_name, str):
        raise CaeError("descriptor_mismatch", f"{path} manifest dtype is invalid")
    descriptor = value if isinstance(value, dict) else None
    if (dtype_name.startswith("float") or spec.get("axes") is not None) and descriptor is None:
        raise CaeError(
            "invalid_task",
            f"{path} must be a dtype descriptor with a value",
        )
    if descriptor is not None:
        if descriptor.get("dtype") != dtype_name or "value" not in descriptor:
            raise CaeError(
                "invalid_task",
                f"{path}.dtype {descriptor.get('dtype')!r} does not match manifest dtype {dtype_name!r}",
            )
        raw = descriptor["value"]
        if dtype_name.startswith("float"):
            expected_quantity = spec.get("quantityKind")
            actual_quantity = descriptor.get("quantityKind")
            if actual_quantity != expected_quantity:
                raise CaeError(
                    "invalid_task",
                    f"{path}.quantityKind {actual_quantity!r} does not match manifest quantityKind {expected_quantity!r}",
                )
            expected_basis = spec.get("basis")
            if descriptor.get("basis") != expected_basis:
                raise CaeError(
                    "invalid_task",
                    f"{path}.basis must match the manifest global basis",
                )
            raw = convert_ucum_tensor(
                raw,
                descriptor.get("unit"),
                spec.get("unit"),
                f"{path}.value",
            )
        elif any(name in descriptor for name in ("unit", "quantityKind", "basis")):
            raise CaeError(
                "invalid_task",
                f"{path} non-float data must not contain unit, quantityKind, or basis",
            )
    else:
        raw = value

    normalized_axes, outer_shape = _normalize_axes(
        descriptor.get("axes") if descriptor is not None else None,
        spec.get("axes"),
        path,
    )
    component_order = spec.get("tensorOrder", 0)
    if (
        not isinstance(component_order, int)
        or isinstance(component_order, bool)
        or component_order < 0
    ):
        raise CaeError("descriptor_mismatch", f"{path} manifest tensorOrder is invalid")
    expected_shape = [*outer_shape, *([3] * component_order)]
    leaves: list[Any] = []

    def visit(item: Any, depth: int) -> None:
        if depth == len(expected_shape):
            if isinstance(item, list):
                raise CaeError("invalid_task", f"{path}.value must have shape {expected_shape}")
            leaves.append(item)
            return
        if not isinstance(item, list) or len(item) != expected_shape[depth]:
            raise CaeError("invalid_task", f"{path}.value must have shape {expected_shape}")
        for child in item:
            visit(child, depth + 1)

    visit(raw, 0)
    for item in leaves:
        comparable = _validate_parameter_element(item, dtype_name, path)
        if dtype_name == "string":
            minimum_length = spec.get("minimumLength")
            if isinstance(minimum_length, int) and len(item) < minimum_length:
                raise CaeError(
                    "invalid_task",
                    f"{path}.value must contain strings of at least {minimum_length} characters",
                )
            allowed = spec.get("values")
            if isinstance(allowed, list) and item not in allowed:
                raise CaeError(
                    "invalid_task",
                    f"{path}.value must contain only {', '.join(allowed)}",
                )
            continue
        if dtype_name == "bool":
            continue
        minimum = spec.get("minimum")
        maximum = spec.get("maximum")
        if isinstance(minimum, (int, float)) and (
            comparable <= minimum
            if spec.get("exclusiveMinimum")
            else comparable < minimum
        ):
            relation = "greater than" if spec.get("exclusiveMinimum") else "at least"
            raise CaeError("invalid_task", f"{path}.value must be {relation} {minimum}")
        if isinstance(maximum, (int, float)) and (
            comparable >= maximum
            if spec.get("exclusiveMaximum")
            else comparable > maximum
        ):
            relation = "less than" if spec.get("exclusiveMaximum") else "at most"
            raise CaeError("invalid_task", f"{path}.value must be {relation} {maximum}")

    if descriptor is None:
        return raw
    normalized = {"dtype": dtype_name, "value": raw}
    if dtype_name.startswith("float"):
        normalized.update(
            {
                "unit": spec["unit"],
                "quantityKind": spec["quantityKind"],
            }
        )
        if spec.get("basis") is not None:
            normalized["basis"] = spec["basis"]
    if normalized_axes is not None:
        normalized["axes"] = normalized_axes
    return normalized


def validate_normalized_parameter_value(
    value: Any,
    spec: dict[str, Any],
    path: str = "parameter",
) -> None:
    normalize_parameter_value(value, spec, path)


def _normalize_axes(
    actual_axes: Any,
    spec_axes: Any,
    path: str,
) -> tuple[list[dict[str, Any]] | None, list[int]]:
    if spec_axes is None:
        if actual_axes is not None:
            raise CaeError("invalid_task", f"{path}.axes must be omitted")
        return None, []
    if (
        not isinstance(spec_axes, list)
        or not isinstance(actual_axes, list)
        or len(actual_axes) != len(spec_axes)
    ):
        raise CaeError(
            "invalid_task",
            f"{path}.axes must contain {len(spec_axes) if isinstance(spec_axes, list) else 0} entries",
        )
    normalized_axes: list[dict[str, Any]] = []
    outer_shape: list[int] = []
    for index, (expected, actual) in enumerate(zip(spec_axes, actual_axes)):
        axis_path = f"{path}.axes[{index}]"
        if not isinstance(expected, dict) or not isinstance(actual, dict):
            raise CaeError("invalid_task", f"{axis_path} is invalid")
        length = expected.get("length")
        if not isinstance(length, int):
            raise CaeError("descriptor_mismatch", f"{axis_path}.length manifest is invalid")
        if actual.get("length") != length:
            raise CaeError(
                "invalid_task",
                f"{axis_path}.length must be {length}, received {actual.get('length')!r}",
            )
        normalized: dict[str, Any] = {"length": length}
        expected_name = expected.get("name")
        if expected_name is not None:
            if actual.get("name") != expected_name:
                raise CaeError(
                    "invalid_task",
                    f"{axis_path}.name must be {expected_name!r}",
                )
            normalized["name"] = expected_name
        expected_unit = expected.get("unit")
        expected_quantity = expected.get("quantityKind")
        if expected_unit is not None or expected_quantity is not None:
            if actual.get("quantityKind") != expected_quantity:
                raise CaeError(
                    "invalid_task",
                    f"{axis_path}.quantityKind {actual.get('quantityKind')!r} does not match manifest quantityKind {expected_quantity!r}",
                )
            normalized["unit"] = expected_unit
            normalized["quantityKind"] = expected_quantity
            if "ticks" in actual:
                ticks = convert_ucum_tensor(
                    actual["ticks"],
                    actual.get("unit"),
                    expected_unit,
                    f"{axis_path}.ticks",
                )
                if not isinstance(ticks, list) or len(ticks) != length:
                    raise CaeError(
                        "invalid_task",
                        f"{axis_path}.ticks must contain {length} values",
                    )
                normalized["ticks"] = ticks
            elif expected.get("ticks") is not None:
                raise CaeError("invalid_task", f"{axis_path}.ticks is required")
        elif any(name in actual for name in ("unit", "quantityKind", "ticks")):
            raise CaeError(
                "invalid_task",
                f"{axis_path} must not contain quantity metadata",
            )
        expected_ticks = expected.get("ticks")
        if expected_ticks is not None and normalized.get("ticks") != expected_ticks:
            raise CaeError(
                "invalid_task",
                f"{axis_path}.ticks do not match the solver manifest",
            )
        normalized_axes.append(normalized)
        outer_shape.append(length)
    return normalized_axes, outer_shape


def _validate_parameter_element(
    value: Any,
    dtype_name: str,
    path: str,
) -> int | float | str | bool:
    if dtype_name == "bool":
        if not isinstance(value, bool):
            raise CaeError("invalid_task", f"{path}.value must contain bool values")
        return value
    if dtype_name == "string":
        if not isinstance(value, str):
            raise CaeError("invalid_task", f"{path}.value must contain string values")
        return value
    try:
        finite = (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(value)
        )
    except OverflowError:
        finite = False
    if not finite:
        raise CaeError("invalid_task", f"{path}.value must contain finite numeric values")
    if dtype_name.startswith("int") or dtype_name.startswith("uint"):
        if not isinstance(value, int) and value != math.trunc(value):
            raise CaeError("invalid_task", f"{path}.value must contain integer values")
        bits = int(dtype_name.removeprefix("uint").removeprefix("int"))
        minimum = 0 if dtype_name.startswith("uint") else -(1 << (bits - 1))
        maximum = (
            (1 << bits) - 1
            if dtype_name.startswith("uint")
            else (1 << (bits - 1)) - 1
        )
        minimum = max(minimum, -((1 << 53) - 1))
        maximum = min(maximum, (1 << 53) - 1)
        if value < minimum or value > maximum:
            raise CaeError("invalid_task", f"{path}.value exceeds {dtype_name} safe range")
    elif dtype_name == "float16" and abs(value) > 65504:
        raise CaeError("invalid_task", f"{path}.value exceeds float16 range")
    elif dtype_name == "float32" and not math.isfinite(float(np.float32(value))):
        raise CaeError("invalid_task", f"{path}.value exceeds float32 range")
    elif dtype_name != "float64":
        raise CaeError("descriptor_mismatch", f"{path} uses unsupported dtype {dtype_name}")
    return value
