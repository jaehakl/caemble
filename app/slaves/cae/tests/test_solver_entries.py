from __future__ import annotations

from tests.scalar_fixtures import _dc_invocation, _heat_invocation, _world

import asyncio
import sys
from dataclasses import replace

from app.kernel.api import BundleValue
import pytest

from app.kernel.api import SolverInvocation, SolverResult
from app.kernel.execution import SpawnSolverExecutor
from app.kernel.resources import StateStore
from tests.solver_fixtures import CubeGeometry
from app.kernel.catalog import SolverCatalog

_DC_ENTRY = "app.solvers.dc_current_density.entry"
_HEAT_ENTRY = "app.solvers.heat_transfer.entry"
_RAY_ENTRY = "app.solvers.ray_tracing.entry"


@pytest.mark.asyncio
async def test_solver_entries_run_only_in_spawn_children() -> None:
    for module_name in (_DC_ENTRY, _HEAT_ENTRY, _RAY_ENTRY):
        assert module_name not in sys.modules

    executor = SpawnSolverExecutor()
    dc, heat, ray = await asyncio.gather(
        executor.execute(f"{_DC_ENTRY}:implementation", _dc_invocation()),
        executor.execute(f"{_HEAT_ENTRY}:implementation", _heat_invocation()),
        executor.execute(f"{_RAY_ENTRY}:implementation", replace(_ray_invocation(), state={"upstream": {"kept": 7}})),
    )

    assert isinstance(dc, SolverResult)
    assert dc.state_patch.is_empty
    assert dc.artifacts["totalCurrent"]["value"] >= 0
    assert dc.observations["relativeResidual"] < 1e-8

    assert isinstance(heat, SolverResult)
    assert heat.state_patch.is_empty
    assert 300 <= heat.artifacts["maximumTemperature"]["value"] <= 400
    assert heat.observations["relativeResidual"] < 1e-8

    assert isinstance(ray, SolverResult)
    assert not ray.state_patch.is_empty
    assert isinstance(ray.visualizations["paths"], BundleValue)
    assert ray.observations["recordedPaths"] == 0
    states = StateStore()
    try:
        base = states.replace(None, {"upstream": {"kept": 7}})
        updated = states.commit(base, ray.state_patch)
        assert updated["upstream"]["kept"] == 7
        assert "rayPaths" in updated
        assert ray.state_patch.operations[0].path == ("rayPaths",)
    finally:
        states.close()

    for module_name in (_DC_ENTRY, _HEAT_ENTRY, _RAY_ENTRY):
        assert module_name not in sys.modules


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
        descriptor=SolverCatalog.discover().descriptor("ray-tracing", "4.0.0"),
    )
