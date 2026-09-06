from __future__ import annotations

import os
from types import SimpleNamespace

import numpy as np
import pytest

from app.runtime_kernel.coordinator import SimulationApi
from app.runtime_kernel.coordinator.plan import RunPlan, TaskSpec, detached


def test_task_snapshot_and_each_invocation_isolate_nested_numpy_arrays():
    class ParameterArray(np.ndarray):
        pass

    source = np.arange(12, dtype=np.int32).reshape(3, 4).view(ParameterArray)
    spec = TaskSpec(
        "fixture", {"kernel": {"name": "fixture", "version": "1.0.0"}, "config": {"nested": [source]}},
        {"inputPorts": {}}, "unused:fixture", 2, {}, {}, {},
    )
    snapshot = spec.task["config"]["nested"][0]
    source[0, 0] = -1
    assert snapshot[0, 0] == 0
    assert not snapshot.flags.writeable
    assert not np.shares_memory(source, snapshot)
    first = detached(spec.task)["config"]["nested"][0]
    first[0, 0] = -2
    second = detached(spec.task)["config"]["nested"][0]
    for array in (snapshot, first, second):
        assert type(array) is ParameterArray
        assert array.dtype == np.dtype("int32")
        assert array.shape == (3, 4)
    assert first.flags.writeable and second.flags.writeable
    assert not np.shares_memory(first, snapshot)
    assert not np.shares_memory(first, second)
    assert snapshot[0, 0] == second[0, 0] == 0


@pytest.mark.asyncio
async def test_mesh_particle_bundle_cross_actual_children_and_coordinator_contracts():
    field_data = {"dtype": "float64", "axes": [{"name": "node"}], "quantityKind": "TestTemperature", "unit": "K"}
    sample_data = {"resourceKind": "structuredBundle", "members": {
        "temperature": {"dtype": "float64", "axes": [{"name": "particle"}], "quantityKind": "TestTemperature", "unit": "K"},
    }}
    outputs = {
        "field": {"artifactType": "test/mesh-field@1", "payloadKind": "field", "data": field_data},
        "samples": {"artifactType": "test/samples@1", "payloadKind": "structuredBundle", "data": sample_data},
    }
    specs = {
        "producer": TaskSpec(
            "producer", {"kernel": {"name": "test-producer", "version": "1.0.0"}, "config": {}},
            {"inputPorts": {}, "observations": {"pid": {"type": "number"}}},
            "tests.coordinator_value_fixtures:producer", 2, outputs, {}, {},
        ),
        "consumer": TaskSpec(
            "consumer", {"kernel": {"name": "test-consumer", "version": "1.0.0"}, "config": {}},
            {"inputPorts": {name: {
                "artifactTypes": [output["artifactType"]], "minimumOccurrences": 1, "maximumOccurrences": 1,
                "data": output["data"], "payloadKind": output["payloadKind"],
            } for name, output in outputs.items()}, "observations": {"pid": {"type": "number"}}},
            "tests.coordinator_value_fixtures:consumer", 2,
            {"answer": {"artifactType": "test/answer@1", "data": {"dtype": "float64"}}}, {}, {},
        ),
    }
    plan = RunPlan(specs, {}, {}, (), {})
    progress = []

    async def report(value):
        progress.append(value)

    host = SimpleNamespace(plan=plan, run_id="value-chain", max_run_seconds=30, trace=[], progress=report)
    sim = SimulationApi(host)
    try:
        produced = await sim.run(plan.tasks["producer"])
        consumed = await sim.run(plan.tasks["consumer"], state=produced["state"], inputs=produced["artifacts"])
        assert consumed["state"] is produced["state"]
        assert sim._artifacts.materialize(consumed["artifacts"]["answer"]) == 1836.0
        assert produced["observations"]["pid"] != consumed["observations"]["pid"]
        assert produced["observations"]["pid"] != os.getpid()
        assert consumed["observations"]["pid"] != os.getpid()
        field = sim._artifacts.resolve(produced["artifacts"]["field"])
        assert np.shares_memory(produced["state"]["field"].values, field.values)
        assert [entry["status"] for entry in host.trace] == ["succeeded", "succeeded"]
        sim.release(produced["state"])
        assert sim._artifacts.is_live(produced["artifacts"]["field"])
        sim.release(produced["artifacts"])
        sim.release(consumed["artifacts"])
    finally:
        sim.close()
