"""CLI-built DEM, SPH and MPM through child transactions and ACK-owned records."""

import asyncio
import gc
import json
import multiprocessing
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

from app.kernel.api import ContentKey, ParticleSetValue, QuantityArrayValue
from app.kernel.api.errors import CaeError
from app.kernel.coordinator import SimulationApi
from app.kernel.coordinator.invocation import execute_solver
from app.kernel.coordinator.plan import detached
from app.kernel.coordinator.run import CaeRun
from app.kernel.execution import MmapPayloadCodec, RemoteSolverError, SpawnSolverExecutor
from app.kernel.transport import RecordPacket
from sdk.protocol.packets import receive_packet, send_packet
from tests.test_catalog_examples import decode_tensor_tree


@pytest.fixture(scope="module", params=["dem-floor-contact", "sph-hydrostatic-column", "mpm-affine-compression"])
def particle_measurement(request, catalog_builds):
    example, grid_shape = (request.param, None) if isinstance(request.param, str) else request.param
    measurement = catalog_builds[example]
    if grid_shape is not None:
        # Only the observation density changes; the Catalog physical model is intact.
        for output in measurement["experiment"]["simulationProgram"]["tasks"]["particles"]["config"]["outputs"]:
            if output["methodId"] in ("sph.pressure", "sph.mass-density"):
                output["parameters"]["gridShape"] = list(grid_shape)
                output["boxGrid"]["gridShape"] = list(grid_shape)
    return measurement


@pytest.mark.asyncio
async def test_particle_children_branch_reject_changed_clock_and_release(particle_measurement, tmp_path, monkeypatch):
    child_temp = tmp_path / "child-temp"
    child_temp.mkdir()
    for name in ("TMPDIR", "TEMP", "TMP"):
        monkeypatch.setenv(name, str(child_temp))
    run = CaeRun(measurement=particle_measurement, max_run_seconds=90, job_id="particle-lifecycle")
    sim = SimulationApi(run)
    run.simulation_api = sim
    sim._executor = SpawnSolverExecutor(codec=MmapPayloadCodec(sim._buffers, array_threshold=64))
    task = run.plan.task_specs["particles"]
    prefix = task.task["kernel"]["name"]
    children = {child.pid for child in multiprocessing.active_children()}
    buffers, cache = sim._buffers.root, Path(sim._geometry_cache.name)
    baseline = sim._resources.stats().resource_count
    pending = None
    try:
        first = await sim.run(run.tasks["particles"])
        checkpoint = first["state"]
        original = checkpoint.to_mutable(copy_arrays=True)
        original_key = ContentKey.from_parts("checkpoint", original)
        saved = original[prefix]["particles"]
        assert isinstance(saved["state"], ParticleSetValue)
        assert all(isinstance(value, QuantityArrayValue) for value in saved["state"].attributes.values())
        native = sim._artifacts.materialize(first["artifacts"]["particles"])
        assert isinstance(native, ParticleSetValue)
        np.testing.assert_array_equal(native.particle_ids, saved["state"].particle_ids)
        assert native.materials[0]["definition"] == saved["state"].materials[0]["definition"]
        with pytest.raises(CaeError, match="Native exports are not numerical RecordedData"):
            await sim.record("density", first["artifacts"]["particles"])

        changed_task = detached(task.task)
        clock = next(item["parameters"] for item in changed_task["config"]["initializations"] if item["methodId"] == f"{prefix}.time")
        clock["dt"]["value"] *= 2
        altered = replace(task, task=changed_task)
        before = sim._resources.stats(), sim._states.revisions(), sim._buffers.files()
        with pytest.raises(RemoteSolverError, match="checkpoint|continuation|physical time|integration step"):
            await execute_solver(altered, checkpoint.to_mutable(copy_arrays=False), {}, run.plan.world(task),
                                 run.progress, executor=sim._executor, timeout=30)
        assert (sim._resources.stats(), sim._states.revisions(), sim._buffers.files()) == before

        trial_task = detached(task.task)
        trial_clock = next(item["parameters"] for item in trial_task["config"]["initializations"] if item["methodId"] == f"{prefix}.time")
        for name, value in {"dt": 1e-6, "duration": 10., "windowSize": 10., "outputInterval": 1.}.items():
            trial_clock[name]["value"] = value
        reached_motion = asyncio.Event()

        async def trial_progress(value):
            if value.get("stage") == "particle-motion":
                reached_motion.set()

        pending = asyncio.create_task(execute_solver(replace(task, name="trial", task=trial_task),
            checkpoint.to_mutable(copy_arrays=False), {}, run.plan.world(task), trial_progress,
            executor=sim._executor, timeout=30))
        await asyncio.wait_for(reached_motion.wait(), timeout=30)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
        await sim._executor.wait_for_cleanup()
        gc.collect()
        assert (sim._resources.stats(), sim._states.revisions(), sim._buffers.files()) == before
        assert {child.pid for child in multiprocessing.active_children()} == children

        second = await sim.run(run.tasks["particles"], state=checkpoint)
        branch = await sim.run(run.tasks["particles"], state=checkpoint)
        assert ContentKey.from_parts("checkpoint", checkpoint.to_mutable(copy_arrays=True)) == original_key
        assert ContentKey.from_parts("branch", second["state"].to_mutable(copy_arrays=True)) == ContentKey.from_parts("branch", branch["state"].to_mutable(copy_arrays=True))
        final_native = sim._artifacts.materialize(second["artifacts"]["particles"])
        np.testing.assert_array_equal(final_native.particle_ids, native.particle_ids)
        for attribute in ("mass", "velocity"):
            assert final_native.attributes[attribute].quantity_kind == native.attributes[attribute].quantity_kind
        before = sim._resources.stats(), sim._states.revisions(), sim._buffers.files()
        with pytest.raises(RemoteSolverError, match="already reached"):
            await sim.run(run.tasks["particles"], state=second["state"])
        assert (sim._resources.stats(), sim._states.revisions(), sim._buffers.files()) == before

        for result in (first, second, branch):
            sim.release((result["artifacts"], result["state"]))
        del native, final_native
        pending = asyncio.create_task(sim._flush_visualizations())
        packet = await asyncio.wait_for(run.queue.get(), timeout=20)
        assert isinstance(packet, RecordPacket) and packet.kind == "visualization"
        assert packet.resource_hold is not None and not packet.ack.done()
        run.pending = packet
        run.acknowledge(packet.sequence)
        await pending
        gc.collect()
        assert sim._resources.stats().resource_count == baseline
        assert sim._buffers.files() == ()
    finally:
        if pending is not None and not pending.done():
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        await run.close()
    assert not buffers.exists() and not cache.exists() and not list(child_temp.iterdir())
    assert {child.pid for child in multiprocessing.active_children()} == children


@pytest.mark.asyncio
@pytest.mark.parametrize("particle_measurement", [
    "dem-floor-contact", "sph-hydrostatic-column", "mpm-affine-compression",
    pytest.param(("sph-hydrostatic-column", (12, 12, 12)), id="sph-pressure-attachments"),
], indirect=True)
async def test_particle_records_and_visualizations_survive_wire_storage_and_requery(particle_measurement, tmp_path):
    run = CaeRun(measurement=particle_measurement, max_run_seconds=90, job_id="particle-recording")
    run.start()
    records, displays, sequences, record_geometry = {}, {}, [], {}
    try:
        while True:
            packet = await asyncio.wait_for(run.queue.get(), timeout=100)
            if not isinstance(packet, RecordPacket):
                if packet["kind"] in {"complete", "failed"}:
                    assert packet["kind"] == "complete", packet
                    break
                continue
            frames = asyncio.Queue()
            await send_packet(frames.put, frames.put, {"kind": packet.kind, "name": packet.name, "data": packet.value}, packet.attachments)
            payload, received = await receive_packet(frames.get)
            stored = tmp_path / f"{packet.sequence}.json"
            stored.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            queried = json.loads(stored.read_text(encoding="utf-8"))
            attachment_map = {attachment.id: attachment.data for attachment in received}
            sequences.append(packet.sequence)
            if packet.kind == "record":
                records[packet.name] = decode_tensor_tree(run.schemas[packet.name], queried["data"], attachment_map)[""]
                record_geometry[packet.name] = queried["data"]["boxGrid"]
                if packet.name == "pressure" and record_geometry[packet.name]["gridShape"] == [12, 12, 12]:
                    assert queried["data"]["storage"]["kind"] == "attachments" and attachment_map
            else:
                for name, entry in queried["data"].items():
                    displays[name] = decode_tensor_tree(entry["schema"], entry["data"], attachment_map)
                    assert run.plan.visualization_contracts[packet.name][name]["visualization"]["kind"] == "particle-set"
            assert not packet.ack.done() and packet.resource_hold is not None
            run.pending = packet
            run.acknowledge(packet.sequence)
            assert packet.ack.done()
        expected_records = {"density", "velocity", "momentum"}
        if run.plan.task_specs["particles"].task["kernel"]["name"] == "mpm":
            expected_records.update({"displacement", "stress", "volumeRatio", "referenceStress", "energy"})
        elif run.plan.task_specs["particles"].task["kernel"]["name"] == "sph":
            expected_records.add("pressure")
        assert set(records) == expected_records
        assert all(values.ndim == 7 for values in records.values())
        assert len(displays) == 1
        native = next(iter(displays.values()))
        assert native["positions"].shape[:2] == native["velocity"].shape[:2]
        assert native["positions"].shape[0] == len(native["times"])
        assert native["positions"].shape[1] == len(native["particleIds"])
        assert len(np.unique(native["particleIds"])) == len(native["particleIds"])
        assert np.all(np.diff(native["times"]) > 0)
        config = run.plan.task_specs["particles"].task["config"]
        clock = next(item["parameters"] for item in config["initializations"] if item["methodId"].endswith(".time"))
        assert native["times"][-1] == pytest.approx(clock["duration"]["value"])
        assert len(native["materialIndices"]) == len(native["particleIds"])
        assert sequences == sorted(set(sequences))
        if "pressure" in records:
            grid = record_geometry["pressure"]
            assert grid["configuration"] == "current" and grid["weighting"] == "material-volume"
            assert run.schemas["pressure"]["unit"] == "Pa"
            for key in ("origin", "size", "rotation", "gridShape", "lengthUnit", "source", "rootId"):
                assert grid[key] == record_geometry["density"][key]
            edges = [np.linspace(0, size, count + 1) for size, count in zip(grid["size"], grid["gridShape"])]
            cell_volume = np.prod(np.asarray(grid["size"]) / grid["gridShape"])
            expected = []
            for index, positions in enumerate(native["positions"]):
                local = (positions - grid["origin"]) @ np.asarray(grid["rotation"])
                volume = native["mass"][index] / native["density"][index]
                denominator = np.histogramdd(local, bins=edges, weights=volume)[0]
                numerator = np.histogramdd(local, bins=edges, weights=volume * native["pressure"][index])[0]
                expected.append(np.divide(numerator, denominator, out=np.zeros_like(numerator), where=denominator > 0))
                mass = np.histogramdd(local, bins=edges, weights=native["mass"][index])[0]
                np.testing.assert_allclose(records["density"][:, :, :, index, 0, 0, 0], mass / cell_volume, rtol=1e-13)
            np.testing.assert_allclose(records["pressure"][:, :, :, :, 0, 0, 0], np.stack(expected, axis=3), rtol=1e-13)
            assert np.all(records["pressure"][records["density"] == 0] == 0)
            assert np.any((records["density"] > 0) & (records["pressure"] == 0))
    finally:
        await run.close()
