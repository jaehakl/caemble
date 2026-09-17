"""Explicit product entry checks, excluded from low-cost collection."""
from tests.structural_fixture import tetrahedron_motion
import numpy as np
import pytest
from app.kernel.api import SolverInvocation
from app.kernel.catalog import solver_catalog
from app.solvers.structural_mechanics.entry import run
from tests.box_grid_fixtures import grid


@pytest.mark.asyncio
async def test_harmonic_entry_uses_reference_linear_problem_with_either_geometric_flag(monkeypatch):
    model, _ = tetrahedron_motion()
    model.fixed = (6 * np.arange(3)[:, None] + np.arange(3)).ravel()
    model.force[3, 2] = 1.

    async def prepared_model(_invocation):
        return model

    monkeypatch.setattr("app.solvers.structural_mechanics.entry.build_geometry_model", prepared_model)
    config = {
        "parameters": {"analysis": "harmonic", "geometricNonlinear": False},
        "initializations": [{"methodId": "fea.spectrum", "parameters": {"modeCount": 2, "frequencies": [25., 50.]}}],
        "boundaryConditions": [], "exports": [],
        "outputs": [{"methodId": "fea.harmonic-displacement", "key": "displacement", "parameters": {},
                     "boxGrid": grid(shape=(1, 1, 1), origin=(.15, .15, .15), size=(.1, .1, .1)).geometry}],
    }
    invocation = SolverInvocation(config, {}, {}, {}, None, None, solver_catalog.descriptor("structural-mechanics", "8.0.0"), task_name="structure")
    linear = await run(invocation)
    config["parameters"]["geometricNonlinear"] = True
    geometric_flag = await run(invocation)
    np.testing.assert_array_equal(linear.artifacts["displacement"]["value"], geometric_flag.artifacts["displacement"]["value"])
    for name in ("harmonicDisplacement", "harmonicStress"):
        np.testing.assert_array_equal(linear.visualizations[name].members["field"].values, geometric_flag.visualizations[name].members["field"].values)
    assert linear.observations == geometric_flag.observations
    assert "time" not in geometric_flag.observations and not geometric_flag.state_patch.operations
