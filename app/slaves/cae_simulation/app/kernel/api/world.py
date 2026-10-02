from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import numpy as np

def experiment_scene(world: Mapping[str, Any]) -> dict[str, Any]:
    return world["experiment"]


def task_scene(world: dict[str, Any]) -> dict[str, Any]:
    return world["task"]


def single_method(config: Mapping[str, Any], category: str, method: str) -> dict[str, Any]:
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
    return material_model_by_name(world, part["material"]["name"], role, group, source)


def material_model_by_name(world, material_name, role, group, source="experiment"):
    """Resolve a frozen Material directly, without manufacturing a Geometry part."""
    instance = world["materialSelections"].get(role, {}).get(material_name, {}).get(group)
    return None if instance is None else world["materials"][source][material_name]["models"][instance]


def interaction_model(world, first_part, second_part, role, group):
    """Read a selected pair model; None means the descriptor's default behavior."""
    return interaction_model_by_name(world, first_part["material"]["name"], second_part["material"]["name"], role, group)


def interaction_model_by_name(world, first_name, second_name, role, group):
    """Resolve selected pair coefficients, or the Catalog's explicit default model."""
    endpoints = [first_name, second_name]
    pair = sorted(endpoints)
    for binding in world.get("interactionSelections", {}).get(role, []):
        if sorted(binding["between"]) == pair:
            instance = binding["models"].get(group)
            if instance is None:
                return world.get("interactionDefaults", {}).get(role, {}).get(group)
            interaction = world["interactions"][binding["interaction"]]
            model = interaction["models"][instance]
            if world.get("interactionSubjects", {}).get(model["model"], {}).get("exchange") == "ordered" and list(interaction["between"]) != endpoints:
                raise ValueError("An ordered Interaction model must be queried in its declared endpoint order")
            return model
    return None
