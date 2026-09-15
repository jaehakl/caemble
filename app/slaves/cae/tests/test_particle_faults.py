"""A crashed child cannot consume or change a real particle checkpoint."""

import gc
import multiprocessing
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

from app.kernel.api import ContentKey, ParticleSetValue
from app.kernel.coordinator import SimulationApi
from app.kernel.coordinator.invocation import execute_solver
from app.kernel.coordinator.run import CaeRun
from app.kernel.execution import MmapPayloadCodec, SolverProcessExitedError, SpawnSolverExecutor
from tests.test_particle_runtime import particle_measurement


@pytest.mark.asyncio
async def test_particle_checkpoint_survives_child_crash_and_resumes(particle_measurement, tmp_path, monkeypatch):
    child_temp = tmp_path / "child-temp"
    child_temp.mkdir()
    for name in ("TMPDIR", "TEMP", "TMP"):
        monkeypatch.setenv(name, str(child_temp))
    run = CaeRun(measurement=particle_measurement, max_run_seconds=90, job_id="particle-crash-rollback")
    sim = SimulationApi(run)
    run.simulation_api = sim
    sim._executor = SpawnSolverExecutor(codec=MmapPayloadCodec(sim._buffers, array_threshold=64))
    task = run.plan.task_specs["particles"]
    prefix = task.task["kernel"]["name"]
    children = {child.pid for child in multiprocessing.active_children()}
    buffers, cache = sim._buffers.root, Path(sim._geometry_cache.name)
    try:
        first = await sim.run(run.tasks["particles"])
        checkpoint = first["state"]
        original = checkpoint.to_mutable(copy_arrays=True)
        fingerprint = ContentKey.from_parts("checkpoint", original)
        crash_state = checkpoint.to_mutable(copy_arrays=False)
        particles = crash_state[prefix]["particles"]["state"]
        assert isinstance(particles, ParticleSetValue)
        arrays = [particles.positions, *(quantity.values for quantity in particles.attributes.values())]
        assert any(array.nbytes >= 64 and sim._buffers.descriptor_for(array) is not None for array in arrays)
        before = sim._resources.stats(), sim._states.revisions(), sim._buffers.files()
        assert before[2] and not sim._buffers._transactions

        # This registered fixture exits only after the child has decoded the
        # complete invocation, including the real solver's mmap checkpoint.
        crashed = replace(task, locator="tests.spawn_executor_fixtures:crashes_process")
        with pytest.raises(SolverProcessExitedError) as raised:
            await execute_solver(crashed, crash_state, {}, run.plan.world(task), run.progress,
                                 executor=sim._executor, timeout=30)
        assert raised.value.exit_code == 23
        await sim._executor.wait_for_cleanup()
        gc.collect()
        assert (sim._resources.stats(), sim._states.revisions(), sim._buffers.files()) == before
        assert not sim._buffers._transactions
        assert ContentKey.from_parts("checkpoint", checkpoint.to_mutable(copy_arrays=True)) == fingerprint
        assert {child.pid for child in multiprocessing.active_children()} == children

        resumed = await sim.run(run.tasks["particles"], state=checkpoint)
        following = resumed["state"].to_mutable(copy_arrays=True)[prefix]["particles"]
        previous = original[prefix]["particles"]
        assert following["time"] > previous["time"]
        assert following["steps"] > previous["steps"]
        np.testing.assert_array_equal(following["state"].particle_ids, previous["state"].particle_ids)
        np.testing.assert_array_equal(following["state"].material_indices, previous["state"].material_indices)
        assert following["state"].materials == previous["state"].materials
        assert ContentKey.from_parts("checkpoint", checkpoint.to_mutable(copy_arrays=True)) == fingerprint
        for result in (first, resumed):
            sim.release((result["artifacts"], result["state"]))
        del crash_state, particles, arrays
    finally:
        await run.close()
    assert sim._resources.stats().resource_count == sim._resources.stats().lease_count == 0
    assert not buffers.exists() and not cache.exists() and not list(child_temp.iterdir())
    assert {child.pid for child in multiprocessing.active_children()} == children
