from copy import deepcopy

import numpy as np
import pytest

from tests.ray_parallel_fixtures import continuous_ray_invocation, scattering_ray_invocation
from app.kernel.execution import SpawnSolverExecutor


@pytest.mark.asyncio
async def test_ray_parallel_matches_serial_paths_and_tallies(catalog_builds):
    invocation = continuous_ray_invocation(catalog_builds)
    results = []
    for budget in (1, 2):
        executor = SpawnSolverExecutor(cpu_budget=budget)
        if executor.cpu.budget < budget:
            pytest.skip("requires two CPUs")
        progress = []
        results.append(await executor.execute("app.solvers.ray_tracing.entry:implementation", deepcopy(invocation), progress=progress.append, timeout=120))
        trace = [event for event in progress if event.get("stage") == "trace"]
        assert trace[-1]["workers"] == budget
        assert trace[-1]["completed"] == trace[-1]["total"] >= 512
    first, second = results
    assert first.observations["recordedPaths"] == second.observations["recordedPaths"] == 17
    assert first.observations["detectedPower"] == pytest.approx(second.observations["detectedPower"], rel=1e-12)
    for name in first.artifacts:
        np.testing.assert_allclose(first.artifacts[name]["value"], second.artifacts[name]["value"], rtol=1e-12, atol=0)
    for name in first.visualizations["paths"].members:
        np.testing.assert_array_equal(first.visualizations["paths"].members[name]["value"],
                                      second.visualizations["paths"].members[name]["value"])


@pytest.mark.asyncio
async def test_parallel_thin_film_scattering_and_branch_paths():
    invocation = scattering_ray_invocation()
    results = []
    for budget in (1, 2):
        executor = SpawnSolverExecutor(cpu_budget=budget)
        if executor.cpu.budget < budget:
            pytest.skip("requires two CPUs")
        results.append(await executor.execute("app.solvers.ray_tracing.entry:implementation", deepcopy(invocation), timeout=60))
    first, second = results
    assert 0 < first.observations["detectedPower"] < 1
    assert first.observations["detectedPower"] == pytest.approx(second.observations["detectedPower"], rel=1e-12)
    events = set(first.visualizations["paths"].members["segmentEvent"]["value"])
    assert {0, 1, 3, 4, 5}.issubset(events)  # reflection, transmission, surface/bulk scattering, detection
    for name in first.visualizations["paths"].members:
        np.testing.assert_array_equal(first.visualizations["paths"].members[name]["value"],
                                      second.visualizations["paths"].members[name]["value"])
