"""Reusable small CPU FDTD invocation, shared by direct and spawn checks."""
from typing import Any
from unittest.mock import AsyncMock
import numpy as np
from app.kernel.api import SolverInvocation
from app.kernel.catalog import SolverCatalog
from app.methods.geometry import GeometryService
from tests.box_grid_fixtures import grid

def _box_root(
    root_id: str,
    size: tuple[float, float, float],
    *,
    center: tuple[float, float, float] = (0.0, 0.0, 0.0),
    material: str | None = None,
) -> dict[str, Any]:
    primitive: dict[str, Any] = {
        "kind": "primitive",
        "nodeId": f"{root_id}-box",
        "primitive": "box",
        "parameters": {"size": list(size)},
    }
    node = primitive
    if center != (0.0, 0.0, 0.0):
        node = {
            "kind": "transform",
            "nodeId": f"{root_id}-transform",
            "matrix": [
                1.0,
                0.0,
                0.0,
                center[0],
                0.0,
                1.0,
                0.0,
                center[1],
                0.0,
                0.0,
                1.0,
                center[2],
                0.0,
                0.0,
                0.0,
                1.0,
            ],
            "child": primitive,
        }
    root: dict[str, Any] = {"id": root_id, "node": node}
    if material is not None:
        root.update(materialRole="body", material={"name": material})
    return root


def _material_value(value: float | list[float], unit: str) -> dict[str, Any]:
    return {"dtype": "float64", "value": value, "unit": unit}


def small_fdtd_invocation(drude_method="RC", plasma_frequency=5e7):
    descriptor = SolverCatalog.discover().descriptor("fdtd", "5.0.0")
    main_size = (4.0, 4.0, 4.0)
    task_roots = [
        _box_root("buffer", (12.0, 12.0, 12.0), material="Buffer Background"),
        _box_root("main", main_size, material="Main Background"),
        _box_root("source", (2.0, 2.0, 2.0), center=(-1.0, 0.0, 0.0)),
        _box_root("detector", (2.0, 4.0, 4.0), center=(1.0, 0.0, 0.0)),
    ]
    experiment_roots = [
        _box_root("drude", (2.0, 4.0, 4.0), material="Drude Medium"),
        _box_root(
            "later-dielectric",
            (1.0, 1.0, 1.0),
            center=(0.5, 0.5, 0.5),
            material="Later Dielectric",
        ),
    ]
    task_scene = {
        "version": 2, "geometryHash": "fdtd-task-integration-v1",
        "lengthUnit": "m",
        "roots": task_roots,
        "geometryGroups": [
            {"name": "main", "rootIds": ["main"]},
            {"name": "buffer", "rootIds": ["buffer"]},
            {"name": "source", "rootIds": ["source"]},
            {"name": "detector", "rootIds": ["detector"]},
        ],
        "surfaceGroups": [],
    }
    experiment_scene = {
        "version": 2, "geometryHash": "fdtd-experiment-integration-v1",
        "lengthUnit": "m",
        "roots": experiment_roots,
        "geometryGroups": [{"name": "materials", "rootIds": ["drude", "later-dielectric"]}],
        "surfaceGroups": [],
    }
    identity = np.eye(3).tolist()
    world = {
        "experiment": experiment_scene,
        "task": task_scene,
        "materials": {
            "task": {
                "Main Background": {"models": {"electric": {
                    "model": "em.nondispersive-isotropic@1",
                    "parameters": {"epsilon": _material_value(identity, "{fraction}")},
                }}},
                "Buffer Background": {"models": {"electric": {
                    "model": "em.nondispersive-isotropic@1",
                    "parameters": {"epsilon": _material_value((np.eye(3) * 2).tolist(), "{fraction}")},
                }}},
            },
            "experiment": {
                "Drude Medium": {"models": {"electric": {
                    "model": "em.drude-isotropic@1",
                    "parameters": {
                        "epsilonInfinity": _material_value(identity, "{fraction}"),
                        "plasmaFrequency": _material_value(plasma_frequency, "Hz"),
                        "dampingFrequency": _material_value(1e7, "Hz"),
                    },
                }}},
                "Later Dielectric": {"models": {"electric": {
                    "model": "em.nondispersive-isotropic@1",
                    "parameters": {"epsilon": _material_value((np.eye(3) * 4).tolist(), "{fraction}")},
                }}},
            },
        },
        "materialSelections": {
            "mainBackground": {"Main Background": {"electricResponse": "electric"}},
            "bufferBackground": {"Buffer Background": {"electricResponse": "electric"}},
            "geometryOverlay": {
                "Drude Medium": {"electricResponse": "electric"},
                "Later Dielectric": {"electricResponse": "electric"},
            },
        },
    }
    config = {
        "parameters": {
            "periodicX": False,
            "periodicY": False,
            "periodicZ": False,
            "simulationTime": {"value": 4e-8},
            "pmlType": "cpml",
            "pmlThickness": {"value": 1.0},
            "pmlCellSize": {"value": 1.0},
            "pmlCenterWavelength": {"value": 10.0},
        },
        "initializations": [
            {
                "methodId": "fdtd.main-region",
                "target": ["task.geometry.main"],
                "parameters": {
                    "cellSizeX": {"value": 1.0},
                    "cellSizeY": {"value": 1.0},
                    "cellSizeZ": {"value": 1.0},
                    "drudeMethod": drude_method,
                },
            },
            {
                "methodId": "fdtd.buffer-region",
                "target": ["task.geometry.buffer"],
                "parameters": {"cellSize": {"value": 2.0}, "drudeMethod": "none"},
            },
        ],
        "boundaryConditions": [
            {
                "methodId": "fdtd.soft-electric-source",
                "target": ["task.geometry.source"],
                "parameters": {
                    "waveform": "gaussian",
                    "amplitude": {"value": [0.0, 0.0, 1.0]},
                    "frequency": {"value": 5e7},
                    "bandwidth": {"value": 2e8},
                    "startTime": {"value": 0.0},
                    "endTime": {"value": 4e-8},
                },
            }
        ],
        "outputs": [
            {
                "methodId": "fdtd.time-electric-field",
                "key": "timeElectric", "boxGrid": grid(origin=(0,-2,-2),size=(2,4,4)).geometry,
                "target": ["task.geometry.detector"],
                "parameters": {"strideX": 1, "strideY": 2, "strideZ": 2, "timeStride": 2},
            },
            {
                "methodId": "fdtd.spectral-magnetic-field",
                "key": "spectralMagnetic", "boxGrid": grid(origin=(0,-2,-2),size=(2,4,4)).geometry,
                "target": ["task.geometry.detector"],
                "parameters": {
                    "strideX": 1,
                    "strideY": 2,
                    "strideZ": 2,
                    "frequencies": {"value": [5e7]},
                },
            },
        ],
    }
    progress = AsyncMock()
    invocation = SolverInvocation(
        config=config,
        state={},
        inputs={},
        world=world,
        geometry=GeometryService(),
        progress=progress,
        descriptor=descriptor,
        task_name="fdtd-integration",
    )

    return invocation
