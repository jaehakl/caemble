"""Small reusable fixtures, independent of pytest test modules."""

from app.kernel.api import SolverInvocation
from app.kernel.catalog import SolverCatalog
from app.methods.geometry import GeometryService
from tests.box_grid_fixtures import grid
from typing import Any
import numpy as np


def layered_scene():
    roots = []
    for name, thickness, height in (("base", .1, 0), ("metal", .001, .0505)):
        roots.append({"id": name, "node": {"kind": "transform", "nodeId": name + "-move",
            "matrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, height, 0, 0, 0, 1],
            "child": {"kind": "primitive", "nodeId": name + "-box", "primitive": "box", "parameters": {"size": [1, .2, thickness]}}}})
    return {"geometryHash": "scalar-layers", "lengthUnit": "m", "roots": roots, "geometryGroups": [], "surfaceGroups": []}


def _dc_invocation() -> SolverInvocation:
    return SolverInvocation(
        config={
            "parameters": {
                "relativeTolerance": {"value": 1e-8},
            },
            "initializations": [
                {
                    "methodId": "dc.mesh",
                    "target": ["experiment.geometry.domain"],
                    "parameters": {"maxElementSize": {"value": 0.15, "unit": "m"}},
                },
                {"methodId": "dc.conductor", "target": ["experiment.geometry.domain"], "parameters": {}}
            ],
            "boundaryConditions": [
                {
                    "methodId": "dc.potential",
                    "target": ["experiment.surface.source"],
                    "parameters": {"name": "source", "voltage": {"value": 1.0}},
                },
                {
                    "methodId": "dc.potential",
                    "target": ["experiment.surface.reference"],
                    "parameters": {"name": "reference", "voltage": {"value": 0.0}},
                },
            ],
            "outputs": [
                {
                    "methodId": "dc.total-current",
                    "key": "totalCurrent", "boxGrid": grid(shape=(1,1,1), origin=(-.5,-.5,-.5)).geometry,
                    "parameters": {"terminal": "source"},
                }
            ],
        },
        state={},
        inputs={},
        world=_world(),
        geometry=GeometryService(),
        progress=None,
        descriptor=SolverCatalog.discover().descriptor("dc-current-density", "3.1.0"),
    )


def _heat_invocation() -> SolverInvocation:
    return SolverInvocation(
        config={
            "parameters": {
                "relativeTolerance": {"value": 1e-8},
            },
            "initializations": [
                {
                    "methodId": "heat.mesh",
                    "target": ["experiment.geometry.domain"],
                    "parameters": {"maxElementSize": {"value": 0.15, "unit": "m"}},
                },
                {"methodId": "heat.body", "target": ["experiment.geometry.domain"], "parameters": {}}
            ],
            "boundaryConditions": [
                {
                    "methodId": "heat.fixed-temperature",
                    "target": ["experiment.surface.source"],
                    "parameters": {"temperature": {"value": 400.0}},
                },
                {
                    "methodId": "heat.fixed-temperature",
                    "target": ["experiment.surface.reference"],
                    "parameters": {"temperature": {"value": 300.0}},
                },
            ],
            "outputs": [
                {"methodId": "heat.maximum-temperature", "key": "maximumTemperature", "boxGrid": grid(shape=(1,1,1), origin=(-.5,-.5,-.5)).geometry}
            ],
        },
        state={},
        inputs={},
        world=_world(),
        geometry=GeometryService(),
        progress=None,
        descriptor=SolverCatalog.discover().descriptor("heat-transfer", "2.0.0"),
    )


def _world() -> dict[str, Any]:
    scene = {
        "geometryHash": "abi3-cube",
        "lengthUnit": "m",
        "roots": [{
            "id": "solid", "material": {"name": "test-material"},
            "node": {
                "kind": "primitive", "nodeId": "cube", "primitive": "box",
                "parameters": {"size": [1.0, 1.0, 1.0]},
            },
        }],
        "geometryGroups": [{"name": "domain", "rootIds": ["solid"]}],
        "surfaceGroups": [
            {
                "name": "source",
                "selectors": [
                    {"rootId": "solid", "sourceNodeId": "cube", "surfaceIndex": 0}
                ],
            },
            {
                "name": "reference",
                "selectors": [
                    {"rootId": "solid", "sourceNodeId": "cube", "surfaceIndex": 1}
                ],
            },
        ],
    }
    tensor = np.eye(3).tolist()
    return {
        "experiment": scene,
        "task": {
            "geometryHash": "empty-task",
            "lengthUnit": "m",
            "roots": [],
            "geometryGroups": [],
            "surfaceGroups": [],
        },
        "materials": {
            "experiment": {"test-material": {"models": {
                "electrical": {"model": "electrical.ohmic-conduction@1", "parameters": {
                    "sigma": {"value": tensor, "unit": "S.m-1"},
                }},
                "thermal": {"model": "heat.fourier-conduction@1", "parameters": {
                    "k": {"value": tensor, "unit": "W.m-1.K-1"},
                }},
            }}},
            "task": {},
        },
        "materialSelections": {
            "conductor": {"test-material": {"conduction": "electrical"}},
            "thermalDomain": {"test-material": {"conduction": "thermal"}},
        },
    }
