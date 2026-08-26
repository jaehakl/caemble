from __future__ import annotations

from typing import Any

from app.solver_framework.units import convert_ucum_tensor


def normalize_task_config(
    descriptor: dict[str, Any],
    config: dict[str, Any],
    task_name: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    del task_name
    parameter_specs = descriptor.get("parameters", {})
    parameters = {
        name: normalize_parameter_value(value, parameter_specs.get(name, {}).get("data", {}))
        for name, value in config.get("parameters", {}).items()
    }
    methods = descriptor.get("methods", {})
    normalized: dict[str, Any] = {"parameters": parameters}
    outputs: dict[str, Any] = {}
    for category in ("initializations", "boundaryConditions", "outputs"):
        declared = {
            method["methodId"]: method
            for method in methods.get(category, [])
        }
        calls = []
        for call in config.get(category, []):
            method = declared[call["methodId"]]
            specs = method.get("parameters", {})
            normalized_call = {
                "methodId": call["methodId"],
                "target": list(call.get("target", [])),
                "parameters": {
                    name: normalize_parameter_value(value, specs.get(name, {}).get("data", {}))
                    for name, value in call.get("parameters", {}).items()
                },
            }
            if category == "outputs":
                key = call["key"]
                normalized_call["key"] = key
                outputs[key] = {
                    "artifactType": method.get("artifactType"),
                    "data": method.get("data"),
                }
            calls.append(normalized_call)
        normalized[category] = calls
    return normalized, outputs


def normalize_parameter_value(value: Any, spec: dict[str, Any]) -> Any:
    if not isinstance(value, dict) or "value" not in value:
        return value
    dtype = spec.get("dtype", value.get("dtype"))
    raw = value["value"]
    if isinstance(dtype, str) and dtype.startswith("float"):
        raw = convert_ucum_tensor(raw, value.get("unit"), spec.get("unit"), "parameter.value")
    normalized = {"dtype": dtype, "value": raw}
    if isinstance(dtype, str) and dtype.startswith("float"):
        normalized["unit"] = spec.get("unit")
        normalized["quantityKind"] = spec.get("quantityKind")
        if spec.get("basis") is not None:
            normalized["basis"] = spec["basis"]
    if "axes" in value:
        axes = []
        for index, axis in enumerate(value["axes"]):
            expected = (spec.get("axes") or [{}])[index]
            item = dict(axis)
            if "ticks" in item and expected.get("unit") is not None:
                item["ticks"] = convert_ucum_tensor(
                    item["ticks"], item.get("unit"), expected.get("unit"), "parameter.axis.ticks"
                )
                item["unit"] = expected.get("unit")
                item["quantityKind"] = expected.get("quantityKind")
            axes.append(item)
        normalized["axes"] = axes
    return normalized
