"""Two fresh optical executions with display-only settings changed."""

from copy import deepcopy

import numpy as np
import pytest

from app.kernel.api import SolverInvocation
from app.kernel.coordinator.plan import RunPlan, detached
from app.methods.geometry import GeometryService
import importlib
import sys


@pytest.mark.asyncio
async def test_continuous_catalog_optics_is_mesh_free_and_bitwise_invariant(
    catalog_builds, monkeypatch
):
    measurement = catalog_builds["continuous-ray-optics"]
    program = measurement["experiment"]["simulationProgram"]
    plan = RunPlan.prepare(measurement, program["tasks"], program["recordedData"])
    spec = plan.task_specs["trace"]
    world = plan.world(spec)
    changed = deepcopy(world)
    pending = [root["node"] for root in changed["experiment"]["roots"]]
    while pending:
        node = pending.pop()
        for key in node.get("tessellation", {}):
            node["tessellation"][key] = node["tessellation"][key] * 2 + 1
        if node["kind"] == "primitive":
            for key in ("segments", "azimuthalSegments", "verticalSegments"):
                if key in node["parameters"]:
                    node["parameters"][key] *= 2
        pending.extend(node.get("children", ()))
        if "child" in node:
            pending.append(node["child"])
    changed["experiment"]["meshHash"] += "-different-display"

    def forbidden(*args, **kwargs):
        pytest.fail("Ray solver requested display tessellation")

    monkeypatch.setattr(GeometryService, "triangular_mesh", forbidden)
    from app.methods.geometry import service

    monkeypatch.setattr(service, "tessellate_fiber", forbidden)
    monkeypatch.setattr(service, "tessellate_primitive", forbidden)

    async def progress(value):
        pass

    module_name = "app.solvers.ray_tracing.entry"
    was_imported = module_name in sys.modules
    implementation = importlib.import_module(module_name).implementation
    results = []
    try:
        for scene in (world, changed):
            results.append(
                await implementation.run(
                    SolverInvocation(
                        config=detached(spec.task["config"]),
                        state={},
                        inputs={},
                        world=scene,
                        geometry=GeometryService(),
                        progress=progress,
                        descriptor=detached(spec.descriptor),
                    )
                )
            )
    finally:
        if not was_imported:
            sys.modules.pop(module_name, None)
    first, second = results
    assert first.observations["launchedRays"] == 96
    assert 2 < first.observations["detectedPower"] <= 3
    assert first.observations == second.observations
    for name in first.artifacts:
        np.testing.assert_array_equal(
            first.artifacts[name]["value"], second.artifacts[name]["value"]
        )
        assert np.max(np.abs(first.artifacts[name]["value"])) > 0
    for member in first.visualizations["paths"].members:
        np.testing.assert_array_equal(
            first.visualizations["paths"].members[member]["value"],
            second.visualizations["paths"].members[member]["value"],
        )
