"""Small reusable fixtures, independent of pytest test modules."""

import numpy as np


def box(name, size):
    return {"kind": "primitive", "nodeId": name, "primitive": "box", "parameters": {"size": size}}


def transformed(node, position=(0, 0, 0), rotation=None):
    matrix = np.eye(4)
    matrix[:3, 3] = position
    if rotation is not None:
        matrix[:3, :3] = rotation
    return {"kind": "transform", "nodeId": node["nodeId"] + "-transform", "matrix": matrix.ravel().tolist(), "child": node}


def boolean(name, operation, *children):
    return {"kind": "boolean", "nodeId": name, "operation": operation, "children": list(children)}


def scene(node, unit="m"):
    return {"geometryHash": repr(node), "lengthUnit": unit, "roots": [{"id": "body", "node": node}]}


def box_inertia(size, mass):
    squared = np.square(size)
    return mass * np.diag(squared.sum() - squared) / 12


def _box_node(node_id: str, size: float = 1.0) -> dict[str, object]:
    return {
        "kind": "primitive",
        "nodeId": node_id,
        "primitive": "box",
        "parameters": {"size": [size, size, size]},
    }


def _translated_box(
    root_id: str,
    translation_x: float,
    translation_y: float = 0.0,
    translation_z: float = 0.0,
) -> dict[str, object]:
    return {
        "id": root_id,
        "node": {
            "kind": "transform",
            "nodeId": f"{root_id}-transform",
            "matrix": [
                1, 0, 0, translation_x,
                0, 1, 0, translation_y,
                0, 0, 1, translation_z,
                0, 0, 0, 1,
            ],
            "child": _box_node(f"{root_id}-box"),
        },
    }


def _scene(geometry_hash: str, roots: list[dict[str, object]]) -> dict[str, object]:
    return {
        "geometryHash": geometry_hash,
        "lengthUnit": "m",
        "roots": roots,
        "geometryGroups": [],
        "surfaceGroups": [],
    }
