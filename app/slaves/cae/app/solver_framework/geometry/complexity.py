from __future__ import annotations

from typing import Any

from app.errors import CaeError

MAX_TRIANGLES = 2_000_000
MAX_BOOLEAN_OPERANDS = 128
MAX_BOOLEAN_WORK = 100_000_000


def enforce_triangle_limit(node: dict[str, Any], label: str) -> None:
    count = estimated_triangle_count(node)
    if count > MAX_TRIANGLES:
        raise CaeError(
            "resource_limit",
            f"{label} requires {count} derived triangles; the limit is {MAX_TRIANGLES}",
        )


def enforce_boolean_work_limit(node: dict[str, Any], label: str) -> int:
    work = estimated_boolean_work(node, label)
    if work > MAX_BOOLEAN_WORK:
        raise CaeError(
            "resource_limit",
            f"{label} exceeds the estimated Boolean work limit of {MAX_BOOLEAN_WORK}",
        )
    return work


def estimated_triangle_count(node: dict[str, Any]) -> int:
    kind = node["kind"]
    if kind == "primitive":
        parameters = node["parameters"]
        primitive = node["primitive"]
        if primitive == "box":
            return 12
        if primitive == "cylinder":
            return 4 * parameters["segments"]
        if primitive == "sphere":
            return 2 * parameters["segments"] * parameters["segments"]
        if primitive == "curvedEdgeCylinder":
            return 2 * parameters["azimuthalSegments"] * (parameters["verticalSegments"] + 1)
        return 2 * parameters["azimuthalSegments"] * (parameters["polarSegments"] - 1)
    if kind == "fiber":
        return 2 * node["radialSegments"] * len(node["points"])
    if kind in {"transform", "instance"}:
        return estimated_triangle_count(node["child"])
    if kind == "boolean":
        return sum(estimated_triangle_count(child) for child in node["children"])
    return 2 * estimated_triangle_count(node["child"])


def estimated_boolean_work(node: dict[str, Any], label: str = "geometry node") -> int:
    kind = node["kind"]
    if kind in {"primitive", "fiber"}:
        return 0
    if kind in {"transform", "instance", "shell"}:
        return estimated_boolean_work(node["child"], f"{label}.child")

    children = node["children"]
    if len(children) > MAX_BOOLEAN_OPERANDS:
        raise CaeError(
            "resource_limit",
            f"{label} contains {len(children)} Boolean operands; the limit is {MAX_BOOLEAN_OPERANDS}",
        )
    work = 0
    prior_triangles = 0
    for index, child in enumerate(children):
        work = min(
            MAX_BOOLEAN_WORK + 1,
            work + estimated_boolean_work(child, f"{label}.children[{index}]"),
        )
        child_triangles = estimated_triangle_count(child)
        work = min(MAX_BOOLEAN_WORK + 1, work + prior_triangles * child_triangles)
        prior_triangles += child_triangles
    return work
