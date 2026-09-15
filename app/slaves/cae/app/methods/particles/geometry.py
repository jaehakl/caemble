"""Resolve canonical particle Geometry targets without solver-name branches."""

import numpy as np

from app.kernel.api.units import convert_ucum_value
from app.kernel.api.world import geometry_parts


def selected_roots(world, rule):
    result = {}
    for target in rule["target"]:
        source, kind, group = target.split(".", 2)
        if kind != "geometry":
            raise ValueError(f"{rule['methodId']} requires Geometry targets")
        for root in geometry_parts(world[source], group):
            result[source, root["id"]] = root
    return result


def resolve_box(world, rule):
    """Return the SI origin and size of exactly one world-axis-aligned Box."""
    roots = selected_roots(world, rule)
    if len(roots) != 1:
        raise ValueError(f"{rule['methodId']} requires exactly one Box")
    (source, _), root = next(iter(roots.items()))
    node, transform = root["node"], np.eye(4)
    while node["kind"] in ("transform", "instance"):
        transform = transform @ np.asarray(node["matrix"], dtype=float).reshape(4, 4)
        node = node["child"]
    if node["kind"] != "primitive" or node["primitive"] != "box":
        raise ValueError(f"{rule['methodId']} requires a Box primitive, without Boolean approximation")
    edges = transform[:3, :3] * np.asarray(node["parameters"]["size"], dtype=float)
    lengths = np.linalg.norm(edges, axis=0)
    if np.any(lengths <= 0) or not np.all(np.isfinite(edges)):
        raise ValueError("particle calculation Box requires positive finite lengths")
    directions = edges / lengths
    axes = np.argmax(np.abs(directions), axis=0)
    aligned = np.zeros((3, 3))
    aligned[axes, np.arange(3)] = np.sign(directions[axes, np.arange(3)])
    if len(set(axes)) != 3 or not np.allclose(directions, aligned, rtol=0, atol=1e-10):
        raise ValueError("particle calculation Box must be world-axis-aligned and unsheared")
    scale = convert_ucum_value(1.0, world[source]["lengthUnit"], "m")
    size = np.empty(3)
    size[axes] = lengths * scale
    return transform[:3, 3] * scale - size / 2, size
