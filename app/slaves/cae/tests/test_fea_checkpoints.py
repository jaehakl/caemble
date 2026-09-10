"""실제 네 Solver로 저장/복원을 확인하고 시간 설정 외의 분기 변경을 거절한다."""

import asyncio
import json
import subprocess
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from caemble_catalog import open_catalog

from app.kernel.coordinator import simulation
from app.kernel.coordinator.run import CaeRun
from app.kernel.transport import RecordPacket
from tests.fea_operating_benchmark import InProcessExecutor
from tests.fea_reference.checkpoint import (
    CheckpointSimulation,
    fingerprint,
    load_checkpoint,
    observe_run,
    prepare_branch,
    time_parameters,
)


@pytest.fixture(scope="module")
def operating_measurement(tmp_path_factory):
    repo = Path(__file__).resolve().parents[4]
    artifact = tmp_path_factory.mktemp("checkpoint-built") / "operating"
    with open_catalog() as catalog:
        examples, _ = catalog.list_experiments(limit=100)
    coordinate = next(example["coordinate"] for example in examples if example["key"] == "nrel5mw-oc3-operating")
    subprocess.run(["node", str(repo / "app/ui/dist-cli/caemble.cjs"), "--repo", str(repo), "experiment", "build", "--example", coordinate, "--vars-mode", "nominal", "--out", str(artifact)], cwd=repo, check=True, capture_output=True, text=True, encoding="utf-8")
    manifest = json.loads((artifact / "manifest.json").read_text(encoding="utf-8"))
    measurement = json.loads((artifact / manifest["items"][0]["file"]).read_text(encoding="utf-8"))["measurement"]
    time_parameters(measurement)["duration"]["value"] = .2
    measurement["experiment"]["variables"]["duration"] = .2
    return measurement


async def execute(measurement, directory, times, resume=None):
    run = observe_run(CaeRun(measurement=measurement, max_run_seconds=600, job_id="checkpoint-regression"), directory, times, resume)
    run.start()
    try:
        while True:
            packet = await asyncio.wait_for(run.queue.get(), timeout=610)
            if isinstance(packet, RecordPacket):
                run.pending = packet
                run.acknowledge(packet.sequence)
            elif packet["kind"] in ("complete", "failed"):
                assert packet["kind"] == "complete", packet
                break
        await run.task
        return deepcopy(run.trace)
    finally:
        await run.close()


@pytest.fixture(scope="module")
def uninterrupted(tmp_path_factory, operating_measurement):
    directory = tmp_path_factory.mktemp("checkpoint-baseline")
    original = simulation.SpawnSolverExecutor
    simulation.SpawnSolverExecutor = InProcessExecutor
    try:
        trace = asyncio.run(execute(operating_measurement, directory, [.1, .2]))
    finally:
        simulation.SpawnSolverExecutor = original
    return directory, trace


@pytest.mark.asyncio
async def test_same_grid_checkpoint_branch_matches_uninterrupted_full_task_state(uninterrupted, operating_measurement, tmp_path, monkeypatch):
    directory, trace = uninterrupted
    start = min(directory.glob("*.pkl"))
    expected, _ = load_checkpoint(sorted(directory.glob("*.pkl"))[1])
    monkeypatch.setattr(simulation, "SpawnSolverExecutor", InProcessExecutor)
    resumed_trace = await execute(operating_measurement, tmp_path, [.2], start)
    actual, manifest = load_checkpoint(next(tmp_path.glob("*.pkl")))
    assert fingerprint(actual["state"]) == fingerprint(expected["state"])
    assert resumed_trace[0]["status"] == "diagnostic-checkpoint-bootstrap"
    assert resumed_trace[0]["physicalSteps"] == 0
    np.testing.assert_allclose(manifest["bootstrap"]["time"], .1, atol=1e-14)
    # 실제 원래 파형 반복에는 거절된 trial이 있지만 파일은 수렴 경계 두 개뿐이다.
    assert any(row.get("observations", {}).get("couplingConverged") is False for row in trace)
    assert len(list(directory.glob("*.pkl"))) == 2
    for name in ("structural_mechanics", "wind_turbine_control", "aerodynamic_loading", "hydrodynamic_loading"):
        assert name in actual["state"]


@pytest.mark.parametrize("change", ["wind", "elasticity", "tolerance", "history-nodes", "damping"])
def test_branch_rejects_every_non_time_physical_or_output_change(change, uninterrupted, operating_measurement):
    saved, manifest = load_checkpoint(min(uninterrupted[0].glob("*.pkl")))
    run = CaeRun(measurement=operating_measurement, max_run_seconds=600, job_id="checkpoint-guard")
    measurement = deepcopy(run.measurement)
    tasks = measurement["experiment"]["simulationProgram"]["tasks"]
    if change == "wind":
        tasks["aerodynamics"]["config"]["parameters"]["windVelocities"]["value"][0][0] += 1.
    elif change == "elasticity":
        measurement["materialSnapshot"]["materials"]["Steel"]["models"]["solid"]["parameters"]["E"]["value"] += 1.
    elif change == "tolerance":
        tasks["structure"]["config"]["parameters"]["relativeTolerance"]["value"] *= 2.
    elif change == "history-nodes":
        rule = next(item for item in tasks["structure"]["config"]["outputs"] if item["methodId"] == "fea.history")
        rule["parameters"]["nodeIds"]["value"].reverse()
    else:
        time_parameters(measurement)["dampingMass"]["value"] += .001
    # 이 검사는 CaeRun 정규화보다 뒤의 whitelist 자체를 직접 검증한다.
    with pytest.raises(ValueError, match="outside the time-setting whitelist"):
        prepare_branch(SimpleNamespace(measurement=measurement, plan=run.plan), saved, manifest)


def test_checkpoint_rebinding_has_no_aliases_and_requires_identical_solver_sources(uninterrupted, operating_measurement):
    saved, manifest = load_checkpoint(min(uninterrupted[0].glob("*.pkl")))
    run = CaeRun(measurement=operating_measurement, max_run_seconds=600, job_id="checkpoint-copy")
    before = fingerprint(saved["state"])
    state, _, _, _ = prepare_branch(run, saved, manifest)
    state["structural_mechanics"]["structure"]["displacement"][0, 0] += 10.
    assert fingerprint(saved["state"]) == before
    manifest["solverSourceSha256"][next(iter(manifest["solverSourceSha256"]))] = "changed"
    with pytest.raises(ValueError, match="source hashes differ"):
        prepare_branch(run, saved, manifest)


@pytest.mark.asyncio
async def test_rejected_trial_never_overwrites_an_existing_checkpoint(uninterrupted, operating_measurement):
    directory = uninterrupted[0]
    before = {path.name: path.read_bytes() for path in directory.iterdir()}

    class RejectedSimulation:
        _run = SimpleNamespace(plan=SimpleNamespace(resolve=lambda task: SimpleNamespace(name="structure")), measurement=operating_measurement)

        async def run(self, *args, **kwargs):
            return {"observations": {"time": .1, "couplingConverged": False}}

    observer = CheckpointSimulation(RejectedSimulation(), directory, [.1])
    for _ in range(3):
        await observer.run({})
    assert observer.pending == {.1}
    assert {path.name: path.read_bytes() for path in directory.iterdir()} == before


@pytest.mark.parametrize("target,actual", [(240., 239.9999999998349), (300., 299.99999999978036)])
@pytest.mark.asyncio
async def test_long_time_roundoff_selects_the_boundary_without_changing_physical_time(target, actual, tmp_path, operating_measurement):
    measurement = deepcopy(operating_measurement)
    time_parameters(measurement)["duration"]["value"] = target

    class AcceptedSimulation:
        _run = SimpleNamespace(plan=SimpleNamespace(resolve=lambda task: SimpleNamespace(name="structure")), measurement=measurement)

        async def run(self, *args, **kwargs):
            return {"observations": {"time": actual, "couplingConverged": True}}

    observer = CheckpointSimulation(AcceptedSimulation(), tmp_path, [target])
    captured = []
    observer.save = lambda result, inputs: captured.append(result["observations"]["time"])
    await observer.run({})
    assert captured == [actual]
    assert not observer.pending


@pytest.mark.parametrize("parameter_name,new_value", [("dt", .0025), ("windowSize", .025)])
@pytest.mark.asyncio
async def test_refined_time_grids_start_from_the_identical_physical_checkpoint(parameter_name, new_value, uninterrupted, operating_measurement, tmp_path, monkeypatch):
    start = min(uninterrupted[0].glob("*.pkl"))
    saved, saved_manifest = load_checkpoint(start)
    measurement = deepcopy(operating_measurement)
    time_parameters(measurement)[parameter_name]["value"] = new_value
    measurement["experiment"]["variables"][parameter_name] = new_value
    monkeypatch.setattr(simulation, "SpawnSolverExecutor", InProcessExecutor)
    trace = await execute(measurement, tmp_path, [.2], start)
    actual, manifest = load_checkpoint(next(tmp_path.glob("*.pkl")))
    assert trace[0]["unchangedPhysicalStateSha256"] == saved_manifest["stateSha256"]
    assert manifest["bootstrap"]["checkpointPayloadSha256"] == saved_manifest["payloadSha256"]
    assert manifest["bootstrap"]["branchModelIdentity"] != saved_manifest["modelIdentity"]
    state = actual["state"]["structural_mechanics"]["structure"]
    times = np.concatenate(state["history"]["times"])
    assert np.all(np.diff(times) > 0)
    np.testing.assert_allclose([times[0], times[-1]], [0., .2], atol=1e-12)
    assert fingerprint(saved["state"]) == saved_manifest["stateSha256"]
