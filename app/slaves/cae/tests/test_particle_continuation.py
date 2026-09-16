"""Full particle physics agrees across aligned windows and child checkpoints."""

from copy import deepcopy

import numpy as np
import pytest

from app.kernel.api import ContentKey, ParticleSetValue
from app.kernel.coordinator import SimulationApi
from app.kernel.coordinator.run import CaeRun
from tests.test_particle_runtime import particle_measurement


def assert_scaled_absolute_difference(actual, reference, name):
    """Acceptance is fixed at 1e-12 times the reference array's global scale."""
    reference = np.asarray(reference)
    tolerance = 1e-12 * max(1.0, float(np.max(np.abs(reference), initial=0.0)))
    np.testing.assert_allclose(actual, reference, rtol=0, atol=tolerance, err_msg=name)


@pytest.mark.asyncio
@pytest.mark.parametrize("particle_measurement", [
    "dem-incline-rolling", "sph-hydrostatic-column", "mpm-affine-compression",
], indirect=True)
async def test_all_physical_state_matches_two_windows_and_one_window(particle_measurement):
    # Keep every Catalog timestep and duration. Only the independent comparison
    # run's window size changes from half the duration to the full duration.
    continuous_measurement = deepcopy(particle_measurement)
    clock = next(rule["parameters"] for rule in
                 continuous_measurement["experiment"]["simulationProgram"]["tasks"]["particles"]["config"]["initializations"]
                 if rule["methodId"].endswith(".time"))
    duration, window, dt = (clock[name]["value"] for name in ("duration", "windowSize", "dt"))
    assert duration == 2 * window
    assert window / dt == pytest.approx(round(window / dt), abs=1e-12, rel=0)
    clock["windowSize"]["value"] = duration
    split_run = CaeRun(measurement=particle_measurement, max_run_seconds=90, job_id="particle-split")
    whole_run = CaeRun(measurement=continuous_measurement, max_run_seconds=90, job_id="particle-whole")
    split, whole = SimulationApi(split_run), SimulationApi(whole_run)
    split_run.simulation_api, whole_run.simulation_api = split, whole
    prefix = split_run.plan.task_specs["particles"].task["kernel"]["name"]
    try:
        first = await split.run(split_run.tasks["particles"])
        checkpoint = first["state"].to_mutable(copy_arrays=True)
        fingerprint = ContentKey.from_parts("checkpoint", checkpoint)
        middle = checkpoint[prefix]["particles"]
        assert middle["time"] == window
        if prefix == "dem":
            assert middle["contactHistory"]
            assert any(np.linalg.norm(memory["displacement"]) > 0 for memory in middle["contactHistory"].values())
        second = await split.run(split_run.tasks["particles"], state=first["state"])
        single = await whole.run(whole_run.tasks["particles"])
        actual = second["state"].to_mutable(copy_arrays=True)[prefix]["particles"]
        reference = single["state"].to_mutable(copy_arrays=True)[prefix]["particles"]
        assert ContentKey.from_parts("checkpoint", first["state"].to_mutable(copy_arrays=True)) == fingerprint
        assert actual["time"] == reference["time"] == duration
        assert actual["steps"] == reference["steps"]
        particles, expected = actual["state"], reference["state"]
        assert isinstance(particles, ParticleSetValue) and isinstance(expected, ParticleSetValue)
        assert particles.unit == expected.unit
        assert particles.coordinate_frame == expected.coordinate_frame
        assert particles.identity == expected.identity
        np.testing.assert_array_equal(particles.particle_ids, expected.particle_ids)
        np.testing.assert_array_equal(particles.material_indices, expected.material_indices)
        assert particles.materials == expected.materials
        assert particles.metadata == expected.metadata
        assert particles.attributes.keys() == expected.attributes.keys()
        assert_scaled_absolute_difference(particles.positions, expected.positions, "positions")
        for name, quantity in particles.attributes.items():
            target = expected.attributes[name]
            assert (quantity.quantity_kind, quantity.unit, quantity.components) == (
                target.quantity_kind, target.unit, target.components)
            assert quantity.metadata == target.metadata
            assert_scaled_absolute_difference(quantity.values, target.values, name)
            if target.basis is None:
                assert quantity.basis is None
            else:
                assert_scaled_absolute_difference(quantity.basis, target.basis, f"{name}.basis")
        if prefix == "sph":
            for name in ("pressure", "density"):
                output = split._artifacts.materialize(second["artifacts"][name])
                expected_output = whole._artifacts.materialize(single["artifacts"][name])
                assert_scaled_absolute_difference(output["value"], expected_output["value"], name)
                np.testing.assert_array_equal(output["axes"][3]["ticks"], expected_output["axes"][3]["ticks"])
        if prefix == "dem":
            assert actual["contactHistory"].keys() == reference["contactHistory"].keys()
            assert reference["contactHistory"]
            for key, memory in actual["contactHistory"].items():
                assert memory.keys() == reference["contactHistory"][key].keys()
                for name, value in memory.items():
                    assert_scaled_absolute_difference(value, reference["contactHistory"][key][name], f"{key}.{name}")
            assert_scaled_absolute_difference(actual["frictionDissipation"], reference["frictionDissipation"], "frictionDissipation")
        for result in (first, second):
            split.release((result["artifacts"], result["state"]))
        whole.release((single["artifacts"], single["state"]))
    finally:
        await split_run.close()
        await whole_run.close()
