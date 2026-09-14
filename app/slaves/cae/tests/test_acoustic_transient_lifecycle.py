"""Real CLI-built structure/acoustic children, checkpoint retries and resource leases."""

import asyncio
from copy import deepcopy

import numpy as np
import pytest

from app.kernel.coordinator import SimulationApi
from app.kernel.execution import MmapPayloadCodec, RemoteSolverError, SpawnSolverExecutor
from app.kernel.coordinator.run import CaeRun
from tests.test_catalog_examples import catalog_measurements


@pytest.mark.parametrize("key", ["transient-plate-driven-duct"])
@pytest.mark.asyncio
async def test_actual_surface_child_rejection_retry_and_checkpoint_branch(key, catalog_measurements):
    measurement = deepcopy(catalog_measurements[key])
    program = measurement["experiment"]["simulationProgram"]
    structure_name = next(name for name, task in program["tasks"].items()
                          if task["kernel"]["name"] == "structural-mechanics")
    sound_name = next(name for name, task in program["tasks"].items()
                      if task["kernel"]["name"] == "pressure-acoustics")
    structure_config = program["tasks"][structure_name]["config"]
    motion_key = next(item["key"] for item in structure_config["exports"]
                      if item["methodId"] == "fea.transient-surface-motion")
    pressure_key = program["tasks"][sound_name]["config"]["outputs"][0]["key"]
    program["tasks"]["wrongWindow"] = deepcopy(program["tasks"][sound_name])
    program["visualizationContracts"]["wrongWindow"] = deepcopy(program["visualizationContracts"].get(sound_name, {}))
    time_rule = next(item for item in program["tasks"]["wrongWindow"]["config"]["initializations"]
                     if item["methodId"] == "acoustics.time")
    time_rule["parameters"]["windowSteps"] = 1
    measurement["experiment"]["taskScenes"]["wrongWindow"] = deepcopy(measurement["experiment"]["taskScenes"][sound_name])
    for field in ("taskMaterialSnapshots", "materialSelections"):
        measurement[field]["wrongWindow"] = deepcopy(measurement[field][sound_name])
    run = CaeRun(measurement=measurement, max_run_seconds=180, job_id="transient-native-lifecycle")
    sim = SimulationApi(run)
    run.simulation_api = sim
    sim._executor = SpawnSolverExecutor(codec=MmapPayloadCodec(sim._buffers, array_threshold=1024))
    buffer_root = sim._buffers.root
    try:
        initial = await sim.run(run.tasks[structure_name])
        checkpoint = initial["state"]
        saved_initial = checkpoint.to_mutable(copy_arrays=True)
        initial_handle = initial["artifacts"][motion_key]
        initial_motion = sim._artifacts.resolve(initial_handle)
        assert initial_motion.metadata["frameKind"] == "initial"
        np.testing.assert_array_equal(initial_motion.members["times"]["value"], [0.])
        before = sim._resources.stats(), sim._states.revisions(), set(sim._buffers.files())
        with pytest.raises(RemoteSolverError, match="initial|solved-window|converged"):
            await sim.run(run.tasks[sound_name], state=checkpoint, inputs={"transientSurfaceMotion": initial_handle})
        assert (sim._resources.stats(), sim._states.revisions(), set(sim._buffers.files())) == before
        sim.release(initial["artifacts"])

        structure = await sim.run(run.tasks[structure_name], state=checkpoint)
        motion_handle = structure["artifacts"][motion_key]
        motion = sim._artifacts.resolve(motion_handle)
        velocity = motion.members["velocity"]
        times = np.asarray(motion.members["times"]["value"])
        assert motion.metadata["frameKind"] == "solved-window"
        assert motion.metadata["couplingConverged"] is True
        assert set(velocity.domain.cells) == {"tri3"}
        assert velocity.values.dtype == np.float64
        assert velocity.values.shape == (len(velocity.domain.points), len(times), 3)
        assert times[0] == 0. and np.all(np.diff(times) > 0)
        assert times[-1] == structure["observations"]["time"]
        before = sim._resources.stats(), sim._states.revisions(), set(sim._buffers.files())
        with pytest.raises(RemoteSolverError, match="interval|window|time"):
            await sim.run(run.tasks["wrongWindow"], state=structure["state"], inputs={"transientSurfaceMotion": motion_handle})
        assert (sim._resources.stats(), sim._states.revisions(), set(sim._buffers.files())) == before
        assert sim._artifacts.is_live(motion_handle) and sim._states.is_live(checkpoint)
        np.testing.assert_equal(checkpoint.to_mutable(copy_arrays=True), saved_initial)

        first = await sim.run(run.tasks[sound_name], state=structure["state"], inputs={"transientSurfaceMotion": motion_handle})
        saved_sound = first["state"].to_mutable(copy_arrays=True)
        pressure = sim._artifacts.resolve(first["artifacts"][pressure_key])
        assert pressure["value"].dtype == np.float64 and pressure["value"].ndim == 7
        np.testing.assert_array_equal(pressure["value"][:, :, :, 0], 0.)
        assert pressure["axes"][3]["ticks"][0] == 0.
        # Recompute from the same structural intermediate revision: both solver
        # states and the cumulative samples must be numerically identical.
        repeated = await sim.run(run.tasks[sound_name], state=structure["state"], inputs={"transientSurfaceMotion": motion_handle})
        np.testing.assert_equal(repeated["state"].to_mutable(copy_arrays=True), saved_sound)
        np.testing.assert_array_equal(sim._artifacts.resolve(repeated["artifacts"][pressure_key])["value"], pressure["value"])
        sim.release(repeated["artifacts"])
        sim.release(repeated["state"], keep=(checkpoint, first["state"]))

        before = sim._resources.stats(), sim._states.revisions(), set(sim._buffers.files())
        with pytest.raises(RemoteSolverError, match="interval|window|time"):
            await sim.run(run.tasks[sound_name], state=first["state"], inputs={"transientSurfaceMotion": motion_handle})
        assert (sim._resources.stats(), sim._states.revisions(), set(sim._buffers.files())) == before
        np.testing.assert_equal(first["state"].to_mutable(copy_arrays=True), saved_sound)
        sim.release(structure["artifacts"])
        sim.release(structure["state"], keep=(checkpoint, first["state"]))
        next_structure = await sim.run(run.tasks[structure_name], state=first["state"])
        next_sound = await sim.run(run.tasks[sound_name], state=next_structure["state"],
                                   inputs={"transientSurfaceMotion": next_structure["artifacts"][motion_key]})
        next_pressure = sim._artifacts.resolve(next_sound["artifacts"][pressure_key])
        next_times = np.asarray(next_pressure["axes"][3]["ticks"])
        assert next_times[-1] > pressure["axes"][3]["ticks"][-1]
        assert np.all(np.diff(next_times) > 0)
        assert np.count_nonzero(next_times == 0.) == 1
        np.testing.assert_equal(first["state"].to_mutable(copy_arrays=True), saved_sound)
        sim.release(next_structure["artifacts"])
        sim.release(next_structure["state"], keep=(checkpoint, next_sound["state"]))
        sim.release(first["artifacts"])
        sim.release(first["state"], keep=(checkpoint, next_sound["state"]))
        sim.release(next_sound["artifacts"])
        sim.release(next_sound["state"])
        sim.release(checkpoint)
        with pytest.raises(Exception, match="released|live|another Measurement run"):
            await sim.run(run.tasks[structure_name], state=checkpoint)
    finally:
        await run.close()
    assert not buffer_root.exists()
    assert sim._resources.stats().resource_count == 0


@pytest.mark.parametrize("key", ["transient-matched-impedance-duct"])
@pytest.mark.asyncio
async def test_acoustic_child_cancellation_preserves_live_restart(key, catalog_measurements, monkeypatch):
    measurement = deepcopy(catalog_measurements[key])
    run = CaeRun(measurement=measurement, max_run_seconds=90, job_id="acoustic-cancel")
    sim = SimulationApi(run)
    run.simulation_api = sim
    sim._executor = SpawnSolverExecutor(codec=MmapPayloadCodec(sim._buffers, array_threshold=1024), cancellation_grace=.1)
    buffer_root = sim._buffers.root
    pending = None
    try:
        task_name = next(name for name, task in measurement["experiment"]["simulationProgram"]["tasks"].items()
                         if task["kernel"]["name"] == "pressure-acoustics")
        initial = await sim.run(run.tasks[task_name])
        checkpoint = initial["state"]
        saved = checkpoint.to_mutable(copy_arrays=True)
        sim.release(initial["artifacts"])
        before = sim._resources.stats(), sim._states.revisions(), set(sim._buffers.files())
        started = asyncio.Event()
        from app.kernel.execution import executor as executor_module
        original_log = executor_module.log

        def observe_child_start(message, *args, **kwargs):
            original_log(message, *args, **kwargs)
            if "solver child started" in str(message):
                started.set()

        monkeypatch.setattr(executor_module, "log", observe_child_start)
        pending = asyncio.create_task(sim.run(run.tasks[task_name], state=checkpoint))
        await asyncio.wait_for(started.wait(), timeout=20)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
        assert sim._states.is_live(checkpoint)
        np.testing.assert_equal(checkpoint.to_mutable(copy_arrays=True), saved)
        assert (sim._resources.stats(), sim._states.revisions(), set(sim._buffers.files())) == before
        resumed = await sim.run(run.tasks[task_name], state=checkpoint)
        assert resumed["observations"]["time"] > initial["observations"]["time"]
        sim.release(resumed["artifacts"])
        sim.release(resumed["state"])
        sim.release(checkpoint)
    finally:
        if pending is not None and not pending.done():
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        await run.close()
    assert not buffer_root.exists()
    assert sim._resources.stats().resource_count == 0
