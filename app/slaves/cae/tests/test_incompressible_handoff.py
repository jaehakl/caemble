"""A CLI-built CFD traction survives its producer's checkpoint and child."""

import asyncio
import gc
import multiprocessing
import os
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

from app.kernel.api.errors import CaeError
from app.kernel.coordinator import SimulationApi
from app.kernel.coordinator.plan import RunPlan, TaskSpec, detached
from app.kernel.coordinator.run import CaeRun
from app.kernel.execution import MmapPayloadCodec, SpawnSolverExecutor
from app.kernel.transport import RecordPacket


class IsolatedConsumerPlan(RunPlan):
    def world(self, task):
        return {} if task.name == "consumer" else super().world(task)


@pytest.mark.asyncio
@pytest.mark.parametrize("attached", [False, True])
async def test_native_traction_without_producer_state_geometry_or_live_child(catalog_builds, tmp_path, monkeypatch, attached):
    child_temp = tmp_path / "children"
    child_temp.mkdir()
    for name in ("TMPDIR", "TEMP", "TMP"):
        monkeypatch.setenv(name, str(child_temp))
    run = CaeRun(measurement=catalog_builds["incompressible-boolean-channel"],
                 max_run_seconds=1200, job_id=f"traction-handoff-{attached}")
    flow = run.plan.task_specs["flow"]
    descriptor = detached(flow.descriptor)
    descriptor["observations"]["pid"] = {"type": "number"}
    producer = replace(flow, descriptor=descriptor, locator="tests.incompressible_handoff_fixtures:producer")
    export = producer.output_specs["obstacleTraction"]
    moment = next(item for item in producer.task["config"]["outputs"] if item["key"] == "obstacleMoment")
    origin = moment["parameters"]["momentOrigin"]["value"]
    time = next(item for item in producer.task["config"]["initializations"] if item["methodId"] == "flow.time")
    endpoint = min(time["parameters"]["windowSize"]["value"], time["parameters"]["duration"]["value"])
    consumer = TaskSpec("consumer", {"kernel": {"name": "traction-consumer", "version": "1.0.0"},
        "config": {"time": endpoint, "momentOrigin": origin}},
        {"inputPorts": {"traction": {"artifactTypes": [export["artifactType"]], "minimumOccurrences": 1,
            "maximumOccurrences": 1, "payloadKind": "field", "data": export["data"]}},
         "observations": {"pid": {"type": "number"}}},
        "tests.incompressible_handoff_fixtures:consumer", 3,
        {"answer": {"artifactType": "fixture/traction-wrench@1", "data": {"dtype": "float64", "axes": [{"length": 6}]}}}, {}, {})
    plan = run.plan
    run.plan = IsolatedConsumerPlan({"flow": producer, "consumer": consumer}, plan.scene, plan.material_snapshot,
                                    plan.schemas, plan.result_contracts, plan.visualization_contracts)
    sim = SimulationApi(run)
    run.simulation_api = sim
    sim._executor = SpawnSolverExecutor(codec=MmapPayloadCodec(sim._buffers, array_threshold=64 if attached else 2**30))
    baseline = sim._resources.stats().resource_count
    children = {child.pid for child in multiprocessing.active_children()}
    buffers, cache = sim._buffers.root, Path(sim._geometry_cache.name)
    pending = None
    try:
        produced = await sim.run(run.plan.tasks["flow"])
        saved = produced["state"]["incompressible_flow"]["flow"]
        assert saved["time"] == endpoint
        field = sim._artifacts.resolve(produced["artifacts"]["obstacleTraction"])
        assert len(field.domain.cells["tri3"]) > 0
        assert bool(sim._buffers.files()) is attached
        expected = np.concatenate([sim._artifacts.materialize(produced["artifacts"][key])["value"][0, 0, 0, -1, 0, 0]
                                   for key in ("obstacleForce", "obstacleMoment")])
        del field, saved
        sim.release(produced["state"])
        consumed = await sim.run(run.plan.tasks["consumer"], inputs={"traction": produced["artifacts"]["obstacleTraction"]})
        answer = sim._artifacts.materialize(consumed["artifacts"]["answer"])
        np.testing.assert_allclose(answer, expected, rtol=2e-12, atol=1e-15)
        del answer
        pids = [event["observations"]["pid"] for event in run.trace if "observations" in event]
        assert len(pids) == 2 and len(set(pids + [os.getpid()])) == 3
        assert {child.pid for child in multiprocessing.active_children()} == children
        sim.release(produced["artifacts"])
        with pytest.raises(CaeError, match="live artifact"):
            await sim.run(run.plan.tasks["consumer"], inputs={"traction": produced["artifacts"]["obstacleTraction"]})
        sim.release((consumed["state"], consumed["artifacts"]))
        pending = asyncio.create_task(sim._flush_visualizations())
        while True:
            packet = await asyncio.wait_for(run.queue.get(), timeout=30)
            if isinstance(packet, RecordPacket):
                break
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
