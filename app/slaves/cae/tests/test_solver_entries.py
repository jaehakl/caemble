from __future__ import annotations

import asyncio
import sys
from dataclasses import replace
from typing import Any

import numpy as np
from app.kernel.api import BundleValue, FieldValue, StructuredGridValue
import pytest

from app.methods.structured import VoxelDomain, structured_grid_value
from app.kernel.api import InputArtifact, SolverInvocation, SolverResult
from app.kernel.execution import SpawnSolverExecutor
from app.kernel.resources import StateStore
from tests.solver_fixtures import CubeGeometry
from app.kernel.catalog import SolverCatalog
from tests.test_box_grid_outputs import grid

_DC_ENTRY = "app.solvers.dc_current_density.entry"
_HEAT_ENTRY = "app.solvers.steady_state_heat.entry"
_RAY_ENTRY = "app.solvers.ray_tracing.entry"


@pytest.mark.asyncio
async def test_solver_entries_run_only_in_spawn_children() -> None:
    for module_name in (_DC_ENTRY, _HEAT_ENTRY, _RAY_ENTRY):
        assert module_name not in sys.modules

    executor = SpawnSolverExecutor()
    dc, heat, ray = await asyncio.gather(
        executor.execute(f"{_DC_ENTRY}:implementation", _dc_invocation()),
        executor.execute(f"{_HEAT_ENTRY}:implementation", _heat_invocation()),
        executor.execute(f"{_RAY_ENTRY}:implementation", _ray_invocation()),
    )

    assert isinstance(dc, SolverResult)
    assert dc.state_patch.is_empty
    assert dc.artifacts["totalCurrent"]["value"] >= 0
    assert dc.observations["iterations"] >= 0

    assert isinstance(heat, SolverResult)
    assert heat.state_patch.is_empty
    assert 300 <= heat.artifacts["maximumTemperature"]["value"] <= 400
    assert heat.observations["iterations"] >= 0

    assert isinstance(ray, SolverResult)
    assert not ray.state_patch.is_empty
    assert isinstance(ray.visualizations["paths"], BundleValue)
    assert ray.observations["recordedPaths"] == 0

    for module_name in (_DC_ENTRY, _HEAT_ENTRY, _RAY_ENTRY):
        assert module_name not in sys.modules


@pytest.mark.asyncio
async def test_ray_abi3_patches_ray_paths_without_replacing_upstream_state() -> None:
    invocation = replace(_ray_invocation(), state={"upstream": {"kept": 7}})
    result = await SpawnSolverExecutor().execute(
        f"{_RAY_ENTRY}:implementation",
        invocation,
    )
    states = StateStore()
    try:
        base = states.replace(None, invocation.state)
        updated = states.commit(base, result.state_patch)

        assert updated["upstream"]["kept"] == 7
        assert "rayPaths" in updated
        assert result.state_patch.operations[0].path == ("rayPaths",)
    finally:
        states.close()


def _dc_invocation() -> SolverInvocation:
    return SolverInvocation(
        config={
            "parameters": {
                "relativeTolerance": {"value": 1e-8},
                "maxIterations": {"value": 100},
            },
            "initializations": [
                {
                    "methodId": "dc.voxel-grid",
                    "target": ["experiment.geometry.domain"],
                    "parameters": {"gridShape": {"value": [3, 2, 2]}},
                }
            ],
            "boundaryConditions": [
                {
                    "methodId": "dc.source-potential",
                    "target": ["experiment.surface.source"],
                    "parameters": {"voltage": {"value": 1.0}},
                },
                {
                    "methodId": "dc.reference-potential",
                    "target": ["experiment.surface.reference"],
                    "parameters": {"voltage": {"value": 0.0}},
                },
            ],
            "outputs": [
                {
                    "methodId": "dc.total-current",
                    "key": "totalCurrent", "boxGrid": grid(shape=(1,1,1), origin=(-.5,-.5,-.5)).geometry,
                    "parameters": {"crossSectionPosition": {"value": 0.5}},
                }
            ],
        },
        state={},
        inputs={},
        world=_world(),
        geometry=CubeGeometry(),
        progress=None,
        descriptor=SolverCatalog.discover().descriptor("dc-current-density", "2.0.0"),
    )


def _heat_invocation() -> SolverInvocation:
    domain = VoxelDomain(
        shape=(3, 2, 2),
        axis=np.asarray([1.0, 0.0, 0.0]),
        length=1.0,
        minimum_u=-0.5,
        minimum_v=-0.5,
        axial_spacing=1 / 3,
        u_spacing=0.5,
        v_spacing=0.5,
        occupancy=np.ones(12, dtype=np.uint8),
        occupied_count=12,
    )
    domain_ref = structured_grid_value(
        domain,
        geometry_hashes=["abi3-cube"],
        root_ids=["solid"],
        reference_length_unit="m",
    )
    source = InputArtifact(
        artifact_id="joule",
        artifact_type="caemble.dc/joule-heating@1",
        producer_task="electric",
        solver_name="dc-current-density",
        solver_version="0.3.0",
        output_name="jouleHeating",
        state_revision=1,
        data=None,
        value=FieldValue(domain=domain_ref, location="cell", values=np.zeros((3, 2, 2), dtype=np.float64), quantity_kind="PowerDensity", unit="W.m-3"),
    )
    return SolverInvocation(
        config={
            "parameters": {
                "relativeTolerance": {"value": 1e-8},
                "maxIterations": {"value": 100},
            },
            "initializations": [
                {
                    "methodId": "heat.voxel-grid",
                    "target": ["experiment.geometry.domain"],
                    "parameters": {"gridShape": {"value": [3, 2, 2]}},
                }
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
        inputs={"heatSource": source},
        world=_world(),
        geometry=CubeGeometry(),
        progress=None,
        descriptor=SolverCatalog.discover().descriptor("steady-state-heat", "2.0.0"),
    )


def _ray_invocation() -> SolverInvocation:
    return SolverInvocation(
        config={
            "parameters": {
                "seed": {"value": 1},
                "maxInteractions": {"value": 4},
                "maxPaths": {"value": 10},
                "minPowerFraction": {"value": 1e-6},
            },
            "initializations": [
                {
                    "methodId": "ray.domain",
                    "target": ["experiment.geometry.domain"],
                    "parameters": {},
                }
            ],
            "boundaryConditions": [],
            "outputs": [],
        },
        state={},
        inputs={},
        world=_world(),
        geometry=CubeGeometry(),
        progress=None,
        descriptor=SolverCatalog.discover().descriptor("ray-tracing", "2.0.0"),
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
