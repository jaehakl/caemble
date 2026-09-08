from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pytest

from app.kernel.coordinator.invocation import execute_solver
from app.kernel.coordinator.plan import TaskSpec
from app.kernel.catalog import SolverCatalog
from app.kernel.execution import SpawnSolverExecutor
from app.kernel.api import FieldValue, InputArtifact, SolverResourceServices
from app.kernel.resources import FileResourceCache


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


@pytest.mark.asyncio
async def test_dc_to_heat_runs_in_distinct_children(tmp_path: Path) -> None:
    dc_version, heat_version = "0.5.0", "0.4.0"
    catalog = SolverCatalog.discover()
    executor = SpawnSolverExecutor()
    progress: list[Any] = []
    resources = SolverResourceServices(geometry_cache_path=str(tmp_path))

    async def report(value: Any) -> None:
        progress.append(value)

    dc_task = {
        "kernel": {"name": "dc-current-density", "version": dc_version},
        "config": {
            "parameters": {"relativeTolerance": parameter(1e-9), "maxIterations": 500},
            "initializations": [
                {
                    "methodId": "dc.voxel-grid",
                    "target": ["experiment.geometry.conductor"],
                    "parameters": {"gridShape": parameter([6, 4, 4])},
                }
            ],
            "boundaryConditions": [
                {
                    "methodId": "dc.source-potential",
                    "target": ["experiment.surface.sourceTerminal"],
                    "parameters": {"voltage": parameter(1.0)},
                },
                {
                    "methodId": "dc.reference-potential",
                    "target": ["experiment.surface.referenceTerminal"],
                    "parameters": {"voltage": parameter(0.0)},
                },
            ],
            "outputs": [
                {"methodId": "dc.joule-heating", "key": "jouleHeating", "target": [], "parameters": {}},
                {
                    "methodId": "dc.total-current",
                    "key": "totalCurrent",
                    "target": [],
                    "parameters": {"crossSectionPosition": parameter(0.5)},
                },
            ],
        },
    }
    dc_spec = TaskSpec(
        "electric", dc_task, catalog.descriptor("dc-current-density", dc_version),
        catalog.locator("dc-current-density", dc_version), 3, {}, {}, {},
    )
    electric_transaction = await execute_solver(
        dc_spec,
        {},
        {},
        world(),
        report,
        executor=executor,
        timeout=30,
        resources=resources,
    )
    electric = electric_transaction.value
    electric_transaction.commit()
    joule = electric.artifacts["jouleHeating"]
    assert isinstance(joule, FieldValue)
    assert joule.domain.shape == (6, 4, 4)
    assert electric.artifacts["totalCurrent"]["value"] > 0

    heat_task = {
        "kernel": {"name": "steady-state-heat", "version": heat_version},
        "config": {
            "parameters": {"relativeTolerance": parameter(1e-9), "maxIterations": 500},
            "initializations": [
                {
                    "methodId": "heat.voxel-grid",
                    "target": ["experiment.geometry.conductor"],
                    "parameters": {"gridShape": parameter([6, 4, 4])},
                }
            ],
            "boundaryConditions": [
                {
                    "methodId": "heat.fixed-temperature",
                    "target": ["experiment.surface.sourceTerminal"],
                    "parameters": {"temperature": parameter(300.0)},
                },
                {
                    "methodId": "heat.fixed-temperature",
                    "target": ["experiment.surface.referenceTerminal"],
                    "parameters": {"temperature": parameter(300.0)},
                },
            ],
            "outputs": [
                {"methodId": "heat.temperature", "key": "temperature", "target": [], "parameters": {}},
                {
                    "methodId": "heat.maximum-temperature",
                    "key": "maximumTemperature",
                    "target": [],
                    "parameters": {},
                },
            ],
        },
    }
    source = InputArtifact(
        "joule",
        "caemble.dc/joule-heating@1",
        "electric",
        "dc-current-density",
        dc_version,
        "jouleHeating",
        0,
        None,
        joule,
    )
    heat_spec = TaskSpec(
        "thermal", heat_task, catalog.descriptor("steady-state-heat", heat_version),
        catalog.locator("steady-state-heat", heat_version), 3, {}, {}, {},
    )
    thermal_transaction = await execute_solver(
        heat_spec,
        {},
        {"heatSource": source},
        world(),
        report,
        executor=executor,
        timeout=30,
        resources=resources,
    )
    thermal = thermal_transaction.value
    thermal_transaction.commit()
    temperature = np.asarray(thermal.artifacts["temperature"].values)
    assert temperature.shape == (6, 4, 4)
    assert thermal.artifacts["maximumTemperature"]["value"] >= 300.0
    assert electric.state_patch.is_empty and thermal.state_patch.is_empty
    assert len(FileResourceCache(tmp_path).entry_paths()) == 1
    assert any(value.get("stage") == "output" for value in progress if isinstance(value, dict))
