from __future__ import annotations

from typing import Any

import numpy as np

from app.runtime_kernel.api.units import convert_ucum_value


def experiment_scene(world: dict[str, Any]) -> dict[str, Any]:
    return world["experiment"]


def task_scene(world: dict[str, Any]) -> dict[str, Any]:
    return world["task"]


def single_method(config: dict[str, Any], category: str, method: str) -> dict[str, Any]:
    return next(item for item in config[category] if item["methodId"] == method)


def target_group(rule: dict[str, Any], kind: str, source: str = "experiment") -> str:
    prefix = f"{source}.{kind}."
    return rule["target"][0][len(prefix) :]


def geometry_part(scene: dict[str, Any], group_name: str) -> dict[str, Any]:
    return geometry_parts(scene, group_name)[0]


def geometry_parts(scene: dict[str, Any], group_name: str) -> list[dict[str, Any]]:
    group = next(group for group in scene["geometryGroups"] if group["name"] == group_name)
    parts_by_id = {part["id"]: part for part in scene["roots"]}
    return [parts_by_id[part_id] for part_id in group["rootIds"]]


def surface(
    scene: dict[str, Any],
    group_name: str,
    expected_part_id: str,
) -> dict[str, Any]:
    del expected_part_id
    group = next(group for group in scene["surfaceGroups"] if group["name"] == group_name)
    return group["selectors"][0]


def grid_shape(rule: dict[str, Any]) -> tuple[int, int, int]:
    value = rule["parameters"]["gridShape"]
    value = value.get("value") if isinstance(value, dict) else value
    if isinstance(value, np.ndarray):
        value = value.tolist()
    return int(value[0]), int(value[1]), int(value[2])


def scalar_parameter(value: Any) -> float:
    if isinstance(value, dict):
        value = value["value"]
    return float(value)


def material_scalar(
    world: dict[str, Any],
    part: dict[str, Any],
    solver_descriptor: dict[str, Any],
    property_name: str,
    source: str = "experiment",
) -> float:
    material_name = part["material"]["name"]
    descriptor = world["materials"][source]["parameters"]["materials"][material_name][
        property_name
    ]["value"]
    expected = next(
        role["properties"][property_name]["data"]
        for role in solver_descriptor["materials"]
        if property_name in role["properties"]
    )
    path = f"material {material_name!r}.{property_name}.value"
    offset = convert_ucum_value(0, descriptor["unit"], expected["unit"], path)
    scale = convert_ucum_value(1, descriptor["unit"], expected["unit"], path) - offset
    array = np.asarray(descriptor["value"], dtype=np.float64).reshape((3, 3)) * scale + offset
    return float(np.trace(array) / 3)
