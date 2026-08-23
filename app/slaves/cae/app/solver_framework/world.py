from __future__ import annotations

import math
from typing import Any

import numpy as np

from app.errors import CaeError
from app.solver_framework.units import convert_ucum_value

MAXIMUM_VOXEL_COUNT = 250_000

def experiment_scene(world: dict[str, Any]) -> dict[str, Any]:
    scene = world.get("experiment")
    if not isinstance(scene, dict):
        raise CaeError("invalid_input", "BuiltMeasurement Experiment scene is missing")
    return scene


def task_scene(world: dict[str, Any]) -> dict[str, Any]:
    scene = world.get("task")
    if not isinstance(scene, dict):
        raise CaeError("invalid_input", "BuiltMeasurement Task scene is missing")
    return scene


def single_method(config: dict[str, Any], category: str, method: str) -> dict[str, Any]:
    matches = [
        item
        for item in config.get(category, [])
        if isinstance(item, dict) and item.get("methodId") == method
    ]
    if len(matches) != 1:
        raise CaeError("invalid_task", f"{method} must occur exactly once")
    return matches[0]


def target_group(rule: dict[str, Any], kind: str, source: str = "experiment") -> str:
    target = rule.get("target")
    prefix = f"{source}.{kind}."
    if not isinstance(target, list) or len(target) != 1 or not isinstance(target[0], str) or not target[0].startswith(prefix):
        raise CaeError("invalid_task", f"target must match {prefix}<group>")
    return target[0][len(prefix) :]


def geometry_part(scene: dict[str, Any], group_name: str) -> dict[str, Any]:
    parts = geometry_parts(scene, group_name)
    if len(parts) != 1:
        raise CaeError("invalid_task", f"geometry group {group_name!r} must resolve to one part")
    return parts[0]


def geometry_parts(scene: dict[str, Any], group_name: str) -> list[dict[str, Any]]:
    groups = [
        group
        for group in scene.get("geometryGroups", [])
        if isinstance(group, dict) and group.get("name") == group_name
    ]
    ids = groups[0].get("geometryIds") if len(groups) == 1 else None
    if not isinstance(ids, list) or not ids:
        raise CaeError("invalid_task", f"geometry group {group_name!r} must resolve to at least one part")
    parts_by_id = {
        part.get("id"): part
        for part in scene.get("parts", [])
        if isinstance(part, dict) and isinstance(part.get("id"), str)
    }
    missing = next((part_id for part_id in ids if part_id not in parts_by_id), None)
    if missing is not None:
        raise CaeError("invalid_input", f"geometry part {missing!r} is missing")
    return [parts_by_id[part_id] for part_id in ids]


def surface(
    scene: dict[str, Any],
    group_name: str,
    expected_part_id: str,
) -> dict[str, Any]:
    groups = [
        group
        for group in scene.get("surfaceGroups", [])
        if isinstance(group, dict) and group.get("name") == group_name
    ]
    ids = groups[0].get("surfaceIds") if len(groups) == 1 else None
    if not isinstance(ids, list) or len(ids) != 1:
        raise CaeError("invalid_task", f"surface group {group_name!r} must resolve to one surface")
    for part in scene.get("parts", []):
        for surface in part.get("surfaces", []) if isinstance(part, dict) else []:
            if isinstance(surface, dict) and surface.get("id") == ids[0]:
                if part.get("id") != expected_part_id:
                    raise CaeError("invalid_task", "terminal surface must belong to the kernel geometry")
                return surface
    raise CaeError("invalid_input", f"surface {ids[0]!r} is missing")


def grid_shape(rule: dict[str, Any]) -> tuple[int, int, int]:
    parameters = rule.get("parameters")
    value = parameters.get("gridShape") if isinstance(parameters, dict) else None
    value = value.get("value") if isinstance(value, dict) else value
    if isinstance(value, np.ndarray):
        value = value.tolist()
    if (
        not isinstance(value, list)
        or len(value) != 3
        or any(not isinstance(item, int) or isinstance(item, bool) or item < 3 for item in value)
    ):
        raise CaeError("invalid_task", "voxel gridShape must contain three integers >= 3")
    if math.prod(value) > MAXIMUM_VOXEL_COUNT:
        raise CaeError("resource_limit", "voxel grid may contain at most 250000 cells")
    return value[0], value[1], value[2]


def scalar_parameter(value: Any) -> float:
    if isinstance(value, dict):
        value = value.get("value")
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise CaeError("invalid_task", "kernel parameter must be a finite scalar")
    return float(value)


def material_scalar(
    world: dict[str, Any],
    part: dict[str, Any],
    solver_descriptor: dict[str, Any],
    property_name: str,
    source: str = "experiment",
) -> float:
    material = part.get("material")
    material_name = material.get("name") if isinstance(material, dict) else None
    materials_by_target = world.get("materials")
    source_materials = materials_by_target.get(source) if isinstance(materials_by_target, dict) else None
    frozen = source_materials.get("parameters") if isinstance(source_materials, dict) else None
    materials = frozen.get("materials") if isinstance(frozen, dict) else None
    entry = materials.get(material_name, {}).get(property_name) if isinstance(materials, dict) else None
    descriptor = entry.get("value") if isinstance(entry, dict) else None
    if not isinstance(descriptor, dict) or set(descriptor) != {"dtype", "value", "unit"}:
        raise CaeError(
            "invalid_material",
            f"material {material_name!r}.{property_name} must come from the validated material snapshot",
        )
    expected = None
    for role in solver_descriptor.get("materials", []):
        properties = role.get("properties") if isinstance(role, dict) else None
        candidate = properties.get(property_name) if isinstance(properties, dict) else None
        if isinstance(candidate, dict) and isinstance(candidate.get("data"), dict):
            expected = candidate["data"]
            break
    if expected is None:
        raise CaeError("descriptor_mismatch", f"{property_name} is not declared by the solver manifest")
    if descriptor.get("dtype") != expected["dtype"]:
        raise CaeError(
            "invalid_material",
            f"material {material_name!r}.{property_name}.dtype {descriptor.get('dtype')!r} does not match manifest dtype {expected['dtype']!r}",
        )
    value = descriptor["value"]
    path = f"material {material_name!r}.{property_name}.value"
    source_unit = descriptor.get("unit")
    target_unit = expected.get("unit")
    try:
        offset = convert_ucum_value(0, source_unit, target_unit, path)
        scale = convert_ucum_value(1, source_unit, target_unit, path) - offset
    except CaeError as exc:
        raise CaeError("invalid_material", str(exc)) from exc
    array = np.asarray(value, dtype=np.float64) * scale + offset
    if array.shape != (3, 3):
        raise CaeError("invalid_material", f"{property_name} must have component shape [3,3]")
    scale = float(np.max(np.abs(array)))
    if scale <= 0 or not np.allclose(array, np.eye(3) * array[0, 0], rtol=1e-12, atol=1e-12):
        raise CaeError("invalid_material", f"{property_name} must be positive and isotropic")
    scalar = float(np.trace(array) / 3)
    if not math.isfinite(scalar) or scalar <= 0:
        raise CaeError("invalid_material", f"{property_name} must be positive and finite")
    return scalar
