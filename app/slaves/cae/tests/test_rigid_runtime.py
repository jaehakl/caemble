"""CLI-built rigid bodies across real child transactions, ACKs and cancellation."""

import asyncio
import gc
import multiprocessing
from copy import deepcopy
from pathlib import Path

import numpy as np
import pytest

from app.kernel.api.errors import CaeError
from app.kernel.coordinator import SimulationApi
from app.kernel.coordinator.run import CaeRun
from app.kernel.execution import MmapPayloadCodec, RemoteSolverError, SpawnSolverExecutor
from app.kernel.transport import RecordPacket
from tests.test_catalog_examples import catalog_measurements, decode_tensor_tree


pytestmark = pytest.mark.asyncio


@pytest.fixture(scope="module")
def rigid_measurement(catalog_builds):
    """Use the same run-local build as the official-example checks."""
    return catalog_builds["asymmetric-rigid-bodies"]


def short_measurement(measurement, *, segments=32, subdivisions=2, duration=.06, window=.02):
    measurement = deepcopy(measurement)
    task = measurement["experiment"]["simulationProgram"]["tasks"]["motion"]
    task["config"]["parameters"].update(massAngularSegments=segments, subcellSamplesPerAxis=subdivisions)
    settings = next(rule["parameters"] for rule in task["config"]["initializations"] if rule["methodId"] == "rigid.time")
    for name, value in {"dt": .01, "duration": duration, "windowSize": window, "outputInterval": .01}.items():
        settings[name]["value"] = value
    return measurement


def runtime(measurement, tmp_path, monkeypatch):
    child_temp = tmp_path / "child-temp"
    child_temp.mkdir()
    for name in ("TMPDIR", "TEMP", "TMP"):
        monkeypatch.setenv(name, str(child_temp))
    run = CaeRun(measurement=measurement, max_run_seconds=90, job_id="rigid-lifecycle")
    sim = SimulationApi(run)
    run.simulation_api = sim
    sim._executor = SpawnSolverExecutor(codec=MmapPayloadCodec(sim._buffers, array_threshold=128),
                                        cancellation_grace=3)
    return run, sim, child_temp


async def acknowledge_visualization(run, sim):
    pending = asyncio.create_task(sim._flush_visualizations())
    packet = await asyncio.wait_for(run.queue.get(), timeout=20)
    assert isinstance(packet, RecordPacket) and packet.kind == "visualization"
    assert packet.resource_hold is not None and not packet.ack.done()
    run.pending = packet
    run.acknowledge(packet.sequence)
    await pending
    assert packet.ack.done() and packet.attachments == []


@pytest.mark.parametrize("key", ["sliding-contact"])
async def test_contact_history_survives_real_child_checkpoint_branches_and_release(
    key, catalog_measurements, tmp_path, monkeypatch,
):
    run, sim, child_temp = runtime(catalog_measurements[key], tmp_path, monkeypatch)
    baseline = sim._resources.stats().resource_count
    buffers = sim._buffers.root
    try:
        first = await sim.run(run.tasks["motion"])
        checkpoint = first["state"]
        original = checkpoint.to_mutable(copy_arrays=True)
        saved_first = original["rigid_body"]["motion"]
        assert saved_first["contactHistory"] and saved_first["frictionDissipation"] > 0
        second = await sim.run(run.tasks["motion"], state=checkpoint)
        branch = await sim.run(run.tasks["motion"], state=checkpoint)
        saved_second = second["state"].to_mutable(copy_arrays=True)
        np.testing.assert_equal(branch["state"].to_mutable(copy_arrays=True), saved_second)
        np.testing.assert_equal(checkpoint.to_mutable(copy_arrays=True), original)
        final = saved_second["rigid_body"]["motion"]
        block = next(index for index, name in enumerate(final["model"]["bodyIds"]) if "block" in name)
        np.testing.assert_allclose(final["velocity"][block], [1.2152, 0.0, 0.0], atol=1e-7, rtol=0)
        assert final["frictionDissipation"] > saved_first["frictionDissipation"]
        for result in (first, second, branch):
            sim.release(result["artifacts"])
            sim.release(result["state"])
        await acknowledge_visualization(run, sim)
        gc.collect()
        assert sim._resources.stats().resource_count == baseline
        assert sim._buffers.files() == ()
    finally:
        await run.close()
    assert not buffers.exists() and list(child_temp.iterdir()) == []


async def test_rigid_real_children_branch_failure_record_rejection_and_release(
    rigid_measurement, tmp_path, monkeypatch,
):
    measurement = short_measurement(rigid_measurement)
    run, sim, child_temp = runtime(measurement, tmp_path, monkeypatch)
    buffers, cache = sim._buffers.root, Path(sim._geometry_cache.name)
    baseline_resources = sim._resources.stats().resource_count
    children = {child.pid for child in multiprocessing.active_children()}
    try:
        first = await sim.run(run.tasks["motion"])
        checkpoint = first["state"]
        original = checkpoint.to_mutable(copy_arrays=True)
        assert len(sim._buffers.files()) > 0
        assert sim._states.is_live(checkpoint)
        with pytest.raises(CaeError, match="Native exports are not numerical RecordedData"):
            await sim.record("massDensity", first["artifacts"]["snapshot"])
        assert sim._artifacts.is_live(first["artifacts"]["snapshot"])

        second = await sim.run(run.tasks["motion"], state=checkpoint)
        second_saved = second["state"].to_mutable(copy_arrays=True)
        fork = await sim.run(run.tasks["motion"], state=checkpoint)
        assert fork["state"].revision != second["state"].revision
        np.testing.assert_equal(fork["state"].to_mutable(copy_arrays=True), second_saved)
        np.testing.assert_equal(checkpoint.to_mutable(copy_arrays=True), original)
        np.testing.assert_array_equal(
            sim._artifacts.resolve(fork["artifacts"]["velocity"])["value"],
            sim._artifacts.resolve(second["artifacts"]["velocity"])["value"],
        )
        final = await sim.run(run.tasks["motion"], state=second["state"])
        saved_final = final["state"].to_mutable(copy_arrays=True)
        latest_visual = dict(sim._visualizations["motion"])
        before = sim._resources.stats(), sim._states.revisions(), set(sim._buffers.files())
        with pytest.raises(RemoteSolverError, match="already reached"):
            await sim.run(run.tasks["motion"], state=final["state"])
        assert (sim._resources.stats(), sim._states.revisions(), set(sim._buffers.files())) == before
        assert sim._visualizations["motion"] == latest_visual
        np.testing.assert_equal(final["state"].to_mutable(copy_arrays=True), saved_final)
        np.testing.assert_equal(checkpoint.to_mutable(copy_arrays=True), original)
        assert run.trace[-1]["status"] == "failed"

        for result in (first, second, fork, final):
            sim.release(result["artifacts"])
            sim.release(result["state"])
        with pytest.raises(CaeError, match="released|live|another Measurement run"):
            await sim.run(run.tasks["motion"], state=checkpoint)
        await acknowledge_visualization(run, sim)
        gc.collect()
        assert sim._resources.stats().resource_count == baseline_resources
        assert sim._buffers.files() == ()
    finally:
        await run.close()
    assert not buffers.exists() and not cache.exists()
    assert sim._resources.stats().resource_count == 0
    assert list(child_temp.iterdir()) == []
    assert {child.pid for child in multiprocessing.active_children()} == children


async def test_rigid_native_and_numeric_inline_binary_transport_hold_until_ack(
    rigid_measurement, tmp_path, monkeypatch,
):
    measurement = short_measurement(rigid_measurement, segments=1024, subdivisions=1, duration=.01, window=.01)
    run, sim, child_temp = runtime(measurement, tmp_path, monkeypatch)
    buffers = sim._buffers.root
    baseline_resources = sim._resources.stats().resource_count
    pending = None
    try:
        result = await sim.run(run.tasks["motion"])
        body_ids = result["state"].to_mutable(copy_arrays=True)["rigid_body"]["motion"]["model"]["bodyIds"]
        numerical = result["artifacts"]["velocity"]
        numerical_ref = numerical.resource_ref
        pending = asyncio.create_task(sim.record("velocity", numerical))
        packet = await asyncio.wait_for(run.queue.get(), timeout=20)
        assert isinstance(packet, RecordPacket) and packet.kind == "record"
        assert packet.value["storage"]["kind"] == "attachments"
        assert sum(len(item.data) for item in packet.attachments) > 64 * 1024
        numerical_values = decode_tensor_tree(run.schemas["velocity"], packet.value,
                                               {item.id: item.data for item in packet.attachments})[""]
        assert numerical_values.shape == (24, 16, 20, 2, 1, 1, 3)
        sim.release(result["artifacts"])
        sim.release(result["state"])
        assert sim._resources.contains(numerical_ref)
        assert not sim._artifacts.is_live(numerical)
        run.pending = packet
        run.acknowledge(packet.sequence)
        await pending
        assert not sim._resources.contains(numerical_ref)

        pending = asyncio.create_task(sim._flush_visualizations())
        packet = await asyncio.wait_for(run.queue.get(), timeout=20)
        assert isinstance(packet, RecordPacket) and packet.kind == "visualization"
        entry = packet.value["motion"]
        data = entry["data"]
        assert data["bodyIds"]["storage"]["kind"] == "inline"
        assert data["positions"]["storage"]["kind"] == "inline"
        assert data["triangles"]["storage"]["kind"] == "attachments"
        native = decode_tensor_tree(entry["schema"], data, {item.id: item.data for item in packet.attachments})
        assert tuple(native["bodyIds"]) == tuple(body_ids)
        np.testing.assert_array_equal(native["times"], [0, .01])
        assert native["positions"].shape == (2, 3, 3)
        assert native["orientations"].shape == (2, 3, 4)
        np.testing.assert_allclose(np.linalg.norm(native["orientations"], axis=-1), 1)
        assert native["vertexOffsets"][-1] == len(native["vertices"])
        assert native["triangleOffsets"][-1] == len(native["triangles"])
        assert packet.resource_hold is not None and not packet.ack.done()
        run.pending = packet
        run.acknowledge(packet.sequence)
        await pending
        assert packet.attachments == [] and packet.ack.done()
        gc.collect()
        assert sim._resources.stats().resource_count == baseline_resources
        assert sim._buffers.files() == ()
    finally:
        if pending is not None and not pending.done():
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        await run.close()
    assert not buffers.exists() and list(child_temp.iterdir()) == []


@pytest.mark.parametrize("phase", ["geometry", "motion", "output"])
async def test_rigid_child_cancellation_preserves_accepted_checkpoint_and_cleans_workspace(
    phase, rigid_measurement, tmp_path, monkeypatch,
):
    measurement = short_measurement(rigid_measurement, subdivisions=1)
    program = measurement["experiment"]["simulationProgram"]
    program["tasks"]["trial"] = deepcopy(program["tasks"]["motion"])
    program["visualizationContracts"]["trial"] = deepcopy(program["visualizationContracts"]["motion"])
    measurement["experiment"]["taskScenes"]["trial"] = deepcopy(measurement["experiment"]["taskScenes"]["motion"])
    for field in ("taskMaterialSnapshots", "materialSelections", "interactionSelections"):
        measurement[field]["trial"] = deepcopy(measurement[field]["motion"])
    config = program["tasks"]["trial"]["config"]
    settings = next(rule["parameters"] for rule in config["initializations"] if rule["methodId"] == "rigid.time")
    if phase == "geometry":
        config["parameters"]["massAngularSegments"] = 8192
    elif phase == "motion":
        for name, value in {"dt": .00001, "duration": 10., "windowSize": 10., "outputInterval": 10.}.items():
            settings[name]["value"] = value
    else:
        for name in ("duration", "windowSize", "outputInterval"):
            settings[name]["value"] = .01
        config["parameters"]["subcellSamplesPerAxis"] = 64
    run, sim, child_temp = runtime(measurement, tmp_path, monkeypatch)
    buffers, cache = sim._buffers.root, Path(sim._geometry_cache.name)
    children = {child.pid for child in multiprocessing.active_children()}
    pending = None
    logs = []
    from app.kernel.execution import executor as executor_module
    original_log = executor_module.log

    def logged(message, *args, **kwargs):
        logs.append(str(message))
        original_log(message, *args, **kwargs)

    monkeypatch.setattr(executor_module, "log", logged)
    try:
        first = await sim.run(run.tasks["motion"])
        checkpoint = first["state"]
        original = checkpoint.to_mutable(copy_arrays=True)
        visual = dict(sim._visualizations["motion"])
        before = sim._resources.stats(), sim._states.revisions(), set(sim._buffers.files())
        reached = asyncio.Event()
        geometry_starts = 0

        async def progress(value):
            nonlocal geometry_starts
            if value.get("task") != "trial":
                return
            if value.get("stage") == "solid-geometry" and value.get("completed") == 0:
                geometry_starts += 1
                if phase == "geometry" and geometry_starts == 2:
                    reached.set()
            elif value.get("stage") == "rigid-motion":
                if phase == "motion" or (phase == "output" and value.get("completed") == .01):
                    reached.set()

        monkeypatch.setattr(run, "progress", progress)
        pending = asyncio.create_task(sim.run(run.tasks["trial"], state=checkpoint))
        await asyncio.wait_for(reached.wait(), timeout=30)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
        await sim._executor.wait_for_cleanup()
        gc.collect()
        assert sim._states.is_live(checkpoint)
        np.testing.assert_equal(checkpoint.to_mutable(copy_arrays=True), original)
        assert (sim._resources.stats(), sim._states.revisions(), set(sim._buffers.files())) == before
        assert sim._visualizations == {"motion": visual}
        cleanup = [message for message in logs if "solver child cleanup complete" in message]
        assert len(cleanup) == 2 and all("exit_code=0" in message for message in cleanup)
        assert list(child_temp.iterdir()) == []
        assert {child.pid for child in multiprocessing.active_children()} == children
        resumed = await sim.run(run.tasks["motion"], state=checkpoint)
        assert resumed["observations"]["time"] == .04
        np.testing.assert_equal(checkpoint.to_mutable(copy_arrays=True), original)
        sim.release(resumed["artifacts"])
        sim.release(resumed["state"])
        sim.release(first["artifacts"])
        sim.release(checkpoint)
    finally:
        if pending is not None and not pending.done():
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        await run.close()
    assert not buffers.exists() and not cache.exists()
    assert sim._resources.stats().resource_count == 0
    assert list(child_temp.iterdir()) == []
