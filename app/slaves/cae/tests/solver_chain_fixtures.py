"""Small reusable fixtures, independent of pytest test modules."""

from typing import Any
import numpy as np


def scene() -> dict[str, Any]:
    root = {
        "id": "conductor-root",
        "materialRole": "body",
        "material": {"name": "Copper"},
        "node": {
            "kind": "primitive",
            "nodeId": "conductor-node",
            "primitive": "box",
            "parameters": {"size": [1.0, 0.2, 0.2]},
        },
    }
    return {
        "geometryHash": "integration-box-v1",
        "lengthUnit": "m",
        "roots": [root],
        "geometryGroups": [
            {
                "id": "geometry-conductor",
                "name": "conductor",
                "kind": "geometry",
                "memberIds": ["conductor-root"],
                "rootIds": ["conductor-root"],
                "missingMemberIds": [],
            }
        ],
        "surfaceGroups": [
            {
                "id": "surface-source",
                "name": "sourceTerminal",
                "kind": "surface",
                "memberIds": ["conductor-node/surface/0"],
                "selectors": [
                    {"rootId": "conductor-root", "sourceNodeId": "conductor-node", "surfaceIndex": 0}
                ],
                "missingMemberIds": [],
            },
            {
                "id": "surface-reference",
                "name": "referenceTerminal",
                "kind": "surface",
                "memberIds": ["conductor-node/surface/1"],
                "selectors": [
                    {"rootId": "conductor-root", "sourceNodeId": "conductor-node", "surfaceIndex": 1}
                ],
                "missingMemberIds": [],
            },
        ],
    }


def world() -> dict[str, Any]:
    materials = {
        "Copper": {"models": {
            "electrical": {"model": "electrical.ohmic-conduction@1", "parameters": {
                "sigma": {"dtype": "float64", "value": (np.eye(3) * 5.8e7).tolist(), "unit": "S.m-1"},
            }},
            "thermal": {"model": "heat.fourier-conduction@1", "parameters": {
                "k": {"dtype": "float64", "value": (np.eye(3) * 400).tolist(), "unit": "W.m-1.K-1"},
            }},
        }},
    }
    empty_task_scene = {
        "geometryHash": "empty-task",
        "lengthUnit": "m",
        "roots": [],
        "geometryGroups": [],
        "surfaceGroups": [],
    }
    return {
        "experiment": scene(),
        "task": empty_task_scene,
        "materialSelections": {
            "conductor": {"Copper": {"conduction": "electrical"}},
            "thermalDomain": {"Copper": {"conduction": "thermal"}},
        },
        "materials": {
            "experiment": materials,
            "task": {},
        },
    }


def parameter(value: Any) -> dict[str, Any]:
    return {"value": value}


def output_box(shape=(1, 1, 1)):
    return {"origin": [-0.5, -0.1, -0.1], "size": [1., 0.2, 0.2],
            "rotation": np.eye(3).tolist(), "lengthUnit": "m", "gridShape": list(shape),
            "source": "experiment", "rootId": "conductor-root"}
