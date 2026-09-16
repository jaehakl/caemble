"""Standalone native particle Fields cross real children and transactional owners."""

import gc
import multiprocessing
import os
from dataclasses import replace
from types import SimpleNamespace

import numpy as np
import pytest

from app.kernel.api.errors import CaeError
from app.kernel.coordinator.plan import RunPlan, TaskSpec, detached
from app.kernel.coordinator.simulation import SimulationApi
from app.kernel.resources import ResourceValidationError


def field_plan(count):
    data = {"quantityKind": "kinematics.Velocity", "unit": "m.s-1", "dtype": "float64",
            "axes": [{"name": "particle"}], "tensorOrder": 1, "basis": np.eye(3).tolist()}
    export = {"velocity": {"artifactType": "fixture/particle-velocity@1", "payloadKind": "field",
                           "category": "exports", "data": data}}
    port = {"velocity": {"artifactTypes": ["fixture/particle-velocity@1"], "minimumOccurrences": 1,
                         "maximumOccurrences": 1, "data": data, "payloadKind": "field"}}
    specs = {}
    for name, inputs, outputs in (
        ("producer", {}, export),
        ("consumer", port, {"answer": {"artifactType": "fixture/answer@1", "data": {"dtype": "float64"}}}),
    ):
        specs[name] = TaskSpec(
            name, {"kernel": {"name": f"fixture-{name}", "version": "1.0.0"}, "config": {"count": count}},
            {"inputPorts": inputs, "observations": {"pid": {"type": "number"}}},
            f"tests.coordinator_value_fixtures:particle_field_{name}", 3, outputs, {}, {},
        )
    return RunPlan(specs, {}, {}, {})


async def progress(value):
    pass


@pytest.mark.asyncio
@pytest.mark.parametrize("count", [4, 50000])
async def test_native_particle_field_outlives_state_and_preserves_reordered_identity(count):
    plan = field_plan(count)
    trace = []
    sim = SimulationApi(SimpleNamespace(plan=plan, run_id=f"particle-field-{count}",
                                        max_run_seconds=30, trace=trace, progress=progress))
    children = {child.pid for child in multiprocessing.active_children()}
    root = sim._buffers.root
    baseline = sim._resources.stats().resource_count
    try:
        produced = await sim.run(plan.tasks["producer"])
        field = sim._artifacts.resolve(produced["artifacts"]["velocity"])
        particles = produced["state"]["particles"]
        if count == 50000:
            # Read-only Field and writable child workspace use separate mappings
            # of the same file; NumPy addresses do not identify mmap backing.
            assert field.values.filename == particles.attributes["velocity"].values.filename
            assert field.values.offset == particles.attributes["velocity"].values.offset
            assert field.domain.positions.filename == particles.positions.filename
            assert field.domain.positions.offset == particles.positions.offset
            assert len(sim._buffers.files()) == 2
        else:
            assert np.shares_memory(field.values, particles.attributes["velocity"].values)
            assert np.shares_memory(field.domain.positions, particles.positions)
        assert bool(sim._buffers.files()) == (count == 50000)
        del field, particles
        sim.release(produced["state"])
        consumed = await sim.run(plan.tasks["consumer"], inputs=produced["artifacts"])
        assert sim._artifacts.materialize(consumed["artifacts"]["answer"]) == count * (count + 1) / 2
        pids = [event["observations"]["pid"] for event in trace if "observations" in event]
        assert len(pids) == 2 and len(set(pids + [os.getpid()])) == 3
        sim.release(produced["artifacts"])
        with pytest.raises(CaeError, match="live artifact"):
            await sim.run(plan.tasks["consumer"], inputs=produced["artifacts"])
        sim.release((consumed["state"], consumed["artifacts"]))
        gc.collect()
        assert sim._resources.stats().resource_count == baseline
        assert sim._buffers.files() == ()
        assert {child.pid for child in multiprocessing.active_children()} == children
    finally:
        sim.close()
    assert not root.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("mismatch", [{"unit": "cm.s-1"}, {"quantityKind": "kinematics.Acceleration"}])
async def test_particle_field_consumer_rejects_incompatible_contract_without_leaking_input_lease(mismatch):
    plan = field_plan(4)
    consumer = plan.task_specs["consumer"]
    descriptor = detached(consumer.descriptor)
    descriptor["inputPorts"]["velocity"]["data"].update(mismatch)
    plan = RunPlan({**plan.task_specs, "consumer": replace(consumer, descriptor=descriptor)}, {}, {}, {})
    sim = SimulationApi(SimpleNamespace(plan=plan, run_id="particle-field-input", max_run_seconds=30,
                                        trace=[], progress=progress))
    try:
        produced = await sim.run(plan.tasks["producer"])
        baseline = sim._resources.stats(), sim._buffers.files()
        with pytest.raises(CaeError, match="quantity or unit"):
            await sim.run(plan.tasks["consumer"], inputs=produced["artifacts"])
        assert (sim._resources.stats(), sim._buffers.files()) == baseline
        sim.release((produced["state"], produced["artifacts"]))
    finally:
        sim.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("fault,match", [
    ("quantity", "quantity or unit"), ("unit", "quantity or unit"),
    ("basis", "orthonormal"), ("components", "trailing dimension"),
    ("length", "entity dimensions"), ("particle-node", "cannot reference"),
    ("mesh-particle", "cannot reference"),
])
async def test_invalid_particle_field_rolls_back_child_results(fault, match):
    plan = field_plan(50000)
    producer = plan.task_specs["producer"]
    changed = replace(producer, task={**producer.task, "config": {"count": 50000, "fault": fault}})
    plan = RunPlan({**plan.task_specs, "producer": changed}, {}, {}, {})
    sim = SimulationApi(SimpleNamespace(plan=plan, run_id=f"invalid-field-{fault}",
                                        max_run_seconds=30, trace=[], progress=progress))
    try:
        baseline = sim._resources.stats(), sim._states.revisions(), sim._buffers.files()
        with pytest.raises((CaeError, ResourceValidationError), match=match):
            await sim.run(plan.tasks["producer"])
        gc.collect()
        assert (sim._resources.stats(), sim._states.revisions(), sim._buffers.files()) == baseline
    finally:
        sim.close()
