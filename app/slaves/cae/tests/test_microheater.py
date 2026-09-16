"""Official steady electrothermal example: convergence, design and lifecycle."""

import asyncio
from copy import deepcopy
import json
from pathlib import Path

import numpy as np
import pytest

from app.kernel.coordinator.run import CaeRun
from app.kernel.transport import RecordPacket
from tests.test_catalog_examples import decode_tensor_tree


async def run_microheater(measurement, label):
    run = CaeRun(measurement=measurement, max_run_seconds=180, job_id=label)
    run.start()
    records = {}
    try:
        while True:
            packet = await asyncio.wait_for(run.queue.get(), 190)
            if isinstance(packet, RecordPacket):
                assert packet.kind == "record" and packet.resource_hold is not None
                assert not packet.ack.done()
                records[packet.name] = decode_tensor_tree(run.schemas[packet.name], packet.value,
                    {part.id: part.data for part in packet.attachments})[""]
                assert records[packet.name].ndim == 7
                run.pending = packet
                run.acknowledge(packet.sequence)
                assert packet.ack.done() and packet.attachments == []
            else:
                assert packet["kind"] == "complete", packet
                break
        await run.task
        assert len(run.completed_sequences) == 10 and not run._record_packets
        electric, thermal = [event["observations"] for event in run.trace]
        power = records["power"].item()
        assert power > 0
        np.testing.assert_allclose([electric["dissipatedPower"], thermal["sourcePower"], thermal["outwardPower"]], power, rtol=1e-6)
        assert abs(electric["currentImbalance"]) < 1e-6 * records["current"].item()
        assert max(electric["relativeResidual"], thermal["relativeResidual"]) < 1e-8
        mask = records["validDomain"]
        assert set(np.unique(mask)) == {0., 1.}
        assert np.all(records["temperature"][mask == 0] == 0)
        assert np.all(records["temperature"][mask == 1] >= 293.15 - 1e-7)
        return {name: records[name].item() for name in ("current", "power", "meanTemperature", "maximumTemperature", "outwardPower")}
    finally:
        cache = Path(run.simulation_api._geometry_cache.name) if run.simulation_api else None
        await run.close()
        await asyncio.gather(run.task, return_exceptions=True)
        assert not run._record_packets
        if cache is not None:
            assert not cache.exists()


@pytest.mark.asyncio
async def test_microheater_voltage_linewidth_and_refinement(catalog_builds, tmp_path):
    nominal = catalog_builds["steady-microheater"]
    baseline = await run_microheater(nominal, "microheater-nominal")
    variables = nominal["experiment"]["variables"]
    voltage = await run_microheater(catalog_builds.measurement("steady-microheater", {**variables, "voltage": .12}), "microheater-voltage")
    assert voltage["current"] == pytest.approx(baseline["current"] * 1.5, rel=1e-7)
    assert voltage["power"] == pytest.approx(baseline["power"] * 2.25, rel=1e-7)
    assert voltage["meanTemperature"] - 293.15 == pytest.approx((baseline["meanTemperature"] - 293.15) * 2.25, rel=1e-6)
    wider = await run_microheater(catalog_builds.measurement("steady-microheater", {**variables, "lineWidth": 6.}), "microheater-linewidth")
    assert wider["current"] > baseline["current"] and wider["power"] > baseline["power"]
    assert abs(wider["meanTemperature"] - baseline["meanTemperature"]) > .1
    refinements = [baseline]
    # Keep physical metal/membrane thickness fixed. Refine space and thickness
    # separately before checking the combined next refinement.
    for size, layers in ((3., 2), (3., 4), (2., 4)):
        refined = deepcopy(nominal)
        for task in refined["experiment"]["simulationProgram"]["tasks"].values():
            for rule in task["config"]["initializations"]:
                if rule["methodId"].endswith(".mesh"):
                    rule["parameters"]["maxElementSize"]["value"] = size * 2
                elif rule["methodId"].endswith(".region-mesh"):
                    rule["parameters"]["maxElementSize"]["value"] = size
                    rule["parameters"]["layerSubdivisions"] = layers
        refinements.append(await run_microheater(refined, f"microheater-h{size}-z{layers}"))
    report = {"nominal": baseline, "voltage_0.12": voltage, "linewidth_6um": wider, "refinement": refinements}
    (tmp_path / "microheater-results.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))
    for previous, current in zip(refinements, refinements[1:]):
        assert abs(current["power"] / previous["power"] - 1) <= .02
        assert abs((current["meanTemperature"] - 293.15) / (previous["meanTemperature"] - 293.15) - 1) <= .02


@pytest.mark.parametrize("mode", ["cancel-record", "failed-heat"])
@pytest.mark.asyncio
async def test_microheater_cancel_and_failure_release_resources(mode, catalog_builds):
    measurement = catalog_builds["steady-microheater"]
    if mode == "failed-heat":
        measurement["experiment"]["simulationProgram"]["tasks"]["thermal"]["config"]["boundaryConditions"] = []
    run = CaeRun(measurement=measurement, max_run_seconds=120, job_id=mode)
    run.start()
    try:
        packet = await asyncio.wait_for(run.queue.get(), 130)
        if mode == "cancel-record":
            assert isinstance(packet, RecordPacket) and not packet.ack.done()
            assert packet.resource_hold is not None
        else:
            assert packet["kind"] == "failed" and "connected diffusion" in str(packet)
            assert len(run.trace) == 2 and run.trace[-1]["status"] == "failed"
        cache = Path(run.simulation_api._geometry_cache.name)
    finally:
        await run.close()
        await asyncio.gather(run.task, return_exceptions=True)
    assert not cache.exists() and not run._record_packets
    if isinstance(packet, RecordPacket):
        assert packet.ack.done() and packet.attachments == []


@pytest.mark.parametrize("bound", ["min", "max"])
@pytest.mark.asyncio
async def test_microheater_vars_extremes_preserve_terminal_connectivity(catalog_builds, bound):
    schema = catalog_builds["steady-microheater"]["experiment"]["varsSchema"]
    variables = {name: definition[bound] for name, definition in schema.items()}
    measurement = catalog_builds.measurement("steady-microheater", variables)
    result = await run_microheater(measurement, "microheater-vars-" + bound)
    assert result["current"] > 0 and result["meanTemperature"] > 293.15


@pytest.mark.asyncio
async def test_microheater_cancellation_during_real_child_mesh(catalog_builds):
    started = asyncio.Event()

    async def progress(value):
        if value.get("stage") == "volume-mesh" and value.get("completed") == 0:
            started.set()

    run = CaeRun(measurement=catalog_builds["steady-microheater"], max_run_seconds=120,
                 job_id="microheater-cancel-child", on_progress=progress)
    run.start()
    try:
        await asyncio.wait_for(started.wait(), 20)
        assert not run.task.done()
        sim = run.simulation_api
        cache, buffers = Path(sim._geometry_cache.name), sim._buffers.root
    finally:
        await run.close()
        await asyncio.gather(run.task, return_exceptions=True)
    assert not cache.exists() and not buffers.exists()
    assert sim._resources.stats().resource_count == 0 and not run._record_packets
