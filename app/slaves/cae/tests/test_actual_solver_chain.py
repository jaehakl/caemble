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


def output_box(shape=(1, 1, 1)):
    return {"origin": [-0.5, -0.1, -0.1], "size": [1., 0.2, 0.2],
            "rotation": np.eye(3).tolist(), "lengthUnit": "m", "gridShape": list(shape),
            "source": "experiment", "rootId": "conductor-root"}


@pytest.mark.asyncio
@pytest.mark.parametrize("use_cache", [True, False])
async def test_dc_to_heat_runs_in_distinct_children(tmp_path: Path, use_cache: bool) -> None:
    dc_version, heat_version = "3.0.0", "1.0.0"
    catalog = SolverCatalog.discover()
    executor = SpawnSolverExecutor()
    progress: list[Any] = []
    resources = SolverResourceServices(geometry_cache_path=str(tmp_path) if use_cache else None)

    async def report(value: Any) -> None:
        progress.append(value)

    dc_task = {
        "kernel": {"name": "dc-current-density", "version": dc_version},
        "config": {
            "parameters": {"relativeTolerance": parameter(1e-9)},
            "initializations": [
                {
                    "methodId": "dc.mesh",
                    "target": ["experiment.geometry.conductor"],
                    "parameters": {"maxElementSize": {"value": 0.15, "unit": "m"}},
                },
                {"methodId": "dc.conductor", "target": ["experiment.geometry.conductor"], "parameters": {}}
            ],
            "boundaryConditions": [
                {
                    "methodId": "dc.potential",
                    "target": ["experiment.surface.sourceTerminal"],
                    "parameters": {"name": "source", "voltage": parameter(1.0)},
                },
                {
                    "methodId": "dc.potential",
                    "target": ["experiment.surface.referenceTerminal"],
                    "parameters": {"name": "reference", "voltage": parameter(0.0)},
                },
            ],
            "exports": [{"methodId": "dc.joule-heating", "key": "jouleHeating", "target": [], "parameters": {}}],
            "outputs": [
                {
                    "methodId": "dc.total-current",
                    "key": "totalCurrent", "boxGrid": output_box(),
                    "target": [],
                    "parameters": {"gridShape": parameter([1, 1, 1]), "terminal": "source"},
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
    joule = electric.exports["jouleHeating"]
    assert isinstance(joule, FieldValue)
    assert joule.values.shape == (len(joule.domain.cells["tet4"]),)
    assert electric.artifacts["totalCurrent"]["value"] > 0
    np.testing.assert_allclose(electric.artifacts["totalCurrent"]["value"], 5.8e7 * .2 * .2, rtol=1e-9)

    heat_task = {
        "kernel": {"name": "heat-transfer", "version": heat_version},
        "config": {
            "parameters": {"relativeTolerance": parameter(1e-9)},
            "initializations": [
                {
                    "methodId": "heat.mesh",
                    "target": ["experiment.geometry.conductor"],
                    "parameters": {"maxElementSize": {"value": 0.15, "unit": "m"}},
                },
                {"methodId": "heat.body", "target": ["experiment.geometry.conductor"], "parameters": {}}
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
                {"methodId": "heat.temperature", "key": "temperature", "target": [], "boxGrid": output_box((6, 4, 4)), "parameters": {"gridShape": parameter([6, 4, 4])}},
                {
                    "methodId": "heat.maximum-temperature",
                    "key": "maximumTemperature", "boxGrid": output_box(),
                    "target": [],
                    "parameters": {"gridShape": parameter([1, 1, 1])},
                },
            ],
        },
    }
    source = InputArtifact(
        "joule",
        "caemble.dc/joule-heating@2",
        "electric",
        "dc-current-density",
        dc_version,
        "jouleHeating",
        0,
        None,
        joule,
    )
    heat_spec = TaskSpec(
        "thermal", heat_task, catalog.descriptor("heat-transfer", heat_version),
        catalog.locator("heat-transfer", heat_version), 3, {}, {}, {},
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
    temperature = np.asarray(thermal.artifacts["temperature"]["value"])
    assert temperature.shape == (6, 4, 4, 1, 1, 1, 1)
    assert thermal.artifacts["maximumTemperature"]["value"] >= 300.0
    assert electric.state_patch.is_empty and thermal.state_patch.is_empty
    # Canonical surface and shared volume, reused by the thermal child.
    assert len(FileResourceCache(tmp_path).entry_paths()) == (2 if use_cache else 0)
    assert thermal.observations["sourcePower"] == pytest.approx(electric.observations["inputPower"], rel=1e-6)
    assert thermal.observations["outwardPower"] == pytest.approx(electric.observations["inputPower"], rel=1e-6)
    assert any(value.get("stage") == "heat-fem" for value in progress if isinstance(value, dict))
