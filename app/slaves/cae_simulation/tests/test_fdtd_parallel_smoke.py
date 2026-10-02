import numpy as np
import pytest

from app.kernel.execution import SpawnSolverExecutor
from tests.fdtd_fixtures import small_fdtd_invocation


@pytest.mark.asyncio
async def test_fdtd_one_and_two_cpu_threads_preserve_fields():
    results = []
    for budget in (1, 2):
        executor = SpawnSolverExecutor(cpu_budget=budget)
        if executor.cpu.budget < budget:
            pytest.skip("requires two CPUs")
        results.append(await executor.execute("app.solvers.fdtd.entry:implementation",
                                               small_fdtd_invocation(), timeout=60))
    first, second = results
    assert first.observations == second.observations
    assert first.observations["device"] == "cpu"
    for name in first.artifacts:
        np.testing.assert_allclose(first.artifacts[name]["value"], second.artifacts[name]["value"], rtol=1e-6, atol=0)
        assert np.any(first.artifacts[name]["value"] != 0)
