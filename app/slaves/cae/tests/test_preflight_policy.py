from copy import deepcopy
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.kernel.api import SolverImplementation, SolverInvocation, SolverResult
from app.kernel.execution.child import _invoke
from app.solvers.fdtd.entry import prepare_brief as fdtd_brief
from app.solvers.ray_tracing.entry import prepare_brief as ray_brief
from app.solvers.structural_mechanics.entry import prepare_brief as fea_brief


def invocation(config, mode="brief"):
    return SolverInvocation(config=config, state={}, inputs={}, world={}, geometry=None,
                            progress=None, descriptor={}, execution_mode=mode)


def test_presets_preserve_originals_and_required_outputs():
    output = [{"key": "field", "parameters": {"frequencies": [1, 2]}}]
    config = {"parameters": {"pmlCellSize": {"value": 2}}, "outputs": output,
              "initializations": [{"methodId": "fdtd.main-region", "parameters": {
                  "cellSizeX": {"value": 1, "unit": "m"}, "cellSizeY": 2, "cellSizeZ": 3,
              }}, {"methodId": "fdtd.buffer-region", "parameters": {"cellSize": 4}}]}
    original = deepcopy(config)
    for _ in range(2):
        brief = fdtd_brief(invocation(config))
        assert brief["initializations"][0]["parameters"] == {
            "cellSizeX": {"value": 4, "unit": "m"}, "cellSizeY": 8, "cellSizeZ": 12}
        assert brief["initializations"][1]["parameters"]["cellSize"] == 16
        assert brief["parameters"]["pmlCellSize"]["value"] == 8
        assert brief["outputs"] == output
        assert config == original
    rays = {"initializations": [{"parameters": {"rayCount": {"value": 10000}}}, {"parameters": {"rayCount": 3}}]}
    brief = ray_brief(invocation(rays))
    assert [r["parameters"]["rayCount"] for r in brief["initializations"]] == [{"value": 100}, 1]
    assert rays["initializations"][0]["parameters"]["rayCount"]["value"] == 10000


def test_fea_retains_mesh_full_duration_and_coupling_windows():
    config = {"parameters": {"analysis": "transient"}, "outputs": [{"key": "displacement"}],
              "initializations": [{"methodId": "fea.time", "parameters": {
                  "dt": {"value": 0.001}, "duration": 10., "windowSize": 1., "outputInterval": 0.01,
              }}, {"methodId": "fea.mesh", "parameters": {"size": 0.1}}]}
    original = deepcopy(config)
    brief = fea_brief(invocation(config))
    assert brief["initializations"][0]["parameters"] == {
        "dt": {"value": 0.1}, "duration": 10., "windowSize": 1., "outputInterval": 0.01}
    assert brief["initializations"][1] == config["initializations"][1]
    assert brief["outputs"] == config["outputs"]
    assert config == original
    config["parameters"]["analysis"] = "static"
    assert fea_brief(invocation(config)) == config


@pytest.mark.asyncio
async def test_child_applies_hook_once_and_never_retries(monkeypatch):
    calls = []
    def prepare(value):
        calls.append(value.config)
        return {"parameters": {"cell": value.config["parameters"]["cell"] * 4}}
    runner = AsyncMock(return_value=SolverResult())
    module = SimpleNamespace(implementation=SolverImplementation(3, runner, prepare))
    monkeypatch.setattr("app.kernel.execution.child.importlib.import_module", lambda _: module)
    original = invocation({"parameters": {"cell": 1}})
    result = await _invoke("fixture:implementation", original, 3)
    assert len(calls) == runner.await_count == 1
    assert result.execution_metadata["config"]["parameters"]["cell"] == 4
    assert original.config["parameters"]["cell"] == 1
    await _invoke("fixture:implementation", replace(original, execution_mode="full"), 3)
    assert len(calls) == 1
    assert runner.await_args.args[0].config["parameters"]["cell"] == 1
    runner.side_effect = ValueError("invalid coarse grid")
    with pytest.raises(ValueError, match="invalid coarse grid"):
        await _invoke("fixture:implementation", original, 3)
    assert len(calls) == 2 and runner.await_count == 3
    module.implementation = SolverImplementation(3, AsyncMock(return_value=SolverResult()))
    result = await _invoke("fixture:implementation", original, 3)
    assert result.execution_metadata["policyVersion"] is None
