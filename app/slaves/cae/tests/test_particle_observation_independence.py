"""Production descriptors keep display/Box observations out of physical state."""

from copy import deepcopy
from importlib import import_module

import numpy as np
import pytest

from app.kernel.api import SolverInvocation
from app.kernel.coordinator.plan import detached
from app.kernel.coordinator.run import CaeRun
from app.methods.geometry import GeometryService
from tests.test_particle_runtime import particle_measurement  # noqa: F401


@pytest.mark.asyncio
async def test_output_box_resolution_interval_and_display_are_passive(particle_measurement):
    run = CaeRun(measurement=particle_measurement, max_run_seconds=90, job_id="passive-particles")
    try:
        task = run.plan.task_specs["particles"]
        prefix = task.task["kernel"]["name"]
        implementation = import_module(f"app.solvers.{prefix}.entry").implementation
        config = detached(task.task["config"])
        descriptor = task.descriptor
        first = SolverInvocation(config, {}, {}, run.plan.world(task), GeometryService(), None,
                                 descriptor, task_name="particles")
        baseline = await implementation(first)
        changed = deepcopy(config)
        output_definitions = {item["methodId"]: item for item in descriptor["methods"]["outputs"]}
        for output in changed["outputs"]:
            output["boxGrid"]["origin"] = [100, 100, 100]
            if output_definitions[output["methodId"]]["data"]["boxGrid"]["sampling"] != "aggregate":
                output["boxGrid"]["gridShape"] = [2, 3, 4]
        for rule in changed["initializations"]:
            if rule["methodId"] == f"{prefix}.time":
                rule["parameters"]["outputInterval"]["value"] *= .731
        no_display = {**descriptor, "visualizations": {}}
        alternative = await implementation(SolverInvocation(
            changed, {}, {}, run.plan.world(task), GeometryService(), None, no_display,
            task_name="particles"))
        physical = baseline.state_patch.operations[-1].value
        other = alternative.state_patch.operations[-1].value
        assert physical["steps"] == other["steps"]
        assert physical["model"]["identity"] == other["model"]["identity"]
        np.testing.assert_array_equal(physical["state"].positions, other["state"].positions)
        np.testing.assert_array_equal(physical["state"].particle_ids, other["state"].particle_ids)
        for name, quantity in physical["state"].attributes.items():
            np.testing.assert_array_equal(quantity.values, other["state"].attributes[name].values)
        assert not alternative.visualizations
        for native in baseline.exports.values():
            assert native.identity == physical["state"].identity
    finally:
        await run.close()
