from __future__ import annotations

from typing import Any

import numpy as np

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
) -> dict[str, Any]:
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


def material_model(
    world: dict[str, Any],
    part: dict[str, Any],
    role: str,
    group: str,
    source: str = "experiment",
) -> dict[str, Any] | None:
    """Read the explicitly selected model instance for a Material role/group."""
    material_name = part["material"]["name"]
    instance = world["materialSelections"].get(role, {}).get(material_name, {}).get(group)
    return None if instance is None else world["materials"][source][material_name]["models"][instance]
