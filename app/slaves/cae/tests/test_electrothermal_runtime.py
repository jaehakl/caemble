"""Actual accepted pulse branches, cumulative numerical records and playback ACKs."""

import asyncio
from pathlib import Path

import numpy as np
import pytest

from app.kernel.coordinator.run import CaeRun
from app.kernel.transport import RecordPacket
from tests.test_catalog_examples import decode_tensor_tree


@pytest.mark.parametrize("axis", [0, 3])
def test_accepted_history_coalescing_preserves_values_and_uses_mmap(axis):
    from app.kernel.execution import MmapPayloadCodec
    from app.kernel.resources.buffers import BufferStore
    from app.methods.fields.history import append_history_chunk

    shape = (1, 8192, 3) if axis == 0 else (1, 1, 1, 1, 8192, 1, 3)
    previous = tuple(np.full(shape, index, dtype=float) for index in range(32))
    for chunk in previous:
        chunk.flags.writeable = False
    sample = np.full(shape, 32.)
    chunks = append_history_chunk(previous, sample, axis=axis)
    expected = np.concatenate((*previous, sample), axis=axis)
    sample.fill(-1)
    np.testing.assert_array_equal(np.concatenate(chunks, axis=axis), expected)
    for index, chunk in enumerate(previous):
        assert not chunk.flags.writeable and np.all(chunk == index)
    resumed = append_history_chunk(chunks, np.full(shape, 33.), axis=axis)
    assert resumed[0] is chunks[0]
    store = BufferStore()
    codec = MmapPayloadCodec(store).begin_invocation()
    try:
        unpacked_size = len(codec.encode(previous))
        payload = codec.encode(chunks)
        assert len(payload) < 1024 * 1024 and len(payload) < unpacked_size / 4
        decoded = codec.decode(payload)
        assert any(isinstance(chunk, np.memmap) for chunk in decoded)
        np.testing.assert_array_equal(np.concatenate(decoded, axis=axis), expected)
    finally:
        codec.rollback()
        store.close()
    assert not store.root.exists()


def pulse_fixture(catalog_builds):
    measurement = catalog_builds["pulsed-microheater"]
    program = measurement["experiment"]["simulationProgram"]
    # A one-cycle integration fixture checks every branch quickly. The official
    # compact example and its time refinements are executed separately.
    for task in program["tasks"].values():
        if task["kernel"]["name"] == "structural-mechanics":
            task["config"]["parameters"]["spatialResolution"]["value"] = .2
        for rule in task["config"]["initializations"]:
            if rule["methodId"] in ("dc.mesh", "heat.mesh"):
                rule["parameters"]["maxElementSize"]["value"] = .2
            elif rule["methodId"].endswith(".region-mesh"):
                rule["parameters"]["maxElementSize"]["value"] = .1
                rule["parameters"]["layerSubdivisions"] = 4
    for rule in program["tasks"]["thermal"]["config"]["initializations"]:
        if rule["methodId"] == "heat.time-grid":
            rule["parameters"]["times"]["value"] = [0., .005, .01]
            rule["parameters"]["times"]["unit"] = "s"
            rule["parameters"]["times"]["axes"] = [{"length": 3}]
        if rule["methodId"] == "heat.coupling":
            rule["parameters"]["relaxation"]["value"] = 1.
    for rule in program["tasks"]["electric"]["config"]["boundaryConditions"]:
        if rule["methodId"] == "dc.pulsed-potential":
            for name in ("onTime", "offTime"):
                rule["parameters"][name] = {**rule["parameters"][name], "value": .005, "unit": "s"}
    source = program["pythonSource"]
    start = source.index('    seed = await sim.run(tasks["thermal"], state=thermal["state"])')
    source = 'async def simulate(*, sim, tasks, vars):\n' + source[start:]
    source = source.replace('seed = await sim.run(tasks["thermal"], state=thermal["state"])',
                            'seed = await sim.run(tasks["thermal"])')
    source = source.replace('    sim.release(thermal["state"], keep=seed["state"])\n', '')
    program["pythonSource"] = source
    return measurement


@pytest.mark.asyncio
async def test_pulse_accepted_histories_and_child_resource_lifecycle(catalog_builds):
    measurement = pulse_fixture(catalog_builds)
    run = CaeRun(measurement=measurement, max_run_seconds=600, job_id="pulse-history")
    run.start()
    records, playback = {}, None
    try:
        while True:
            packet = await asyncio.wait_for(run.queue.get(), 610)
            if not isinstance(packet, RecordPacket):
                assert packet["kind"] == "complete", packet
                break
            assert packet.resource_hold is not None and not packet.ack.done()
            attachments = {part.id: part.data for part in packet.attachments}
            if packet.kind == "record":
                assert packet.value["boxGrid"] == measurement["experiment"]["simulationProgram"]["boxGrids"][packet.name]
                records[packet.name] = decode_tensor_tree(run.schemas[packet.name], packet.value, attachments)[""]
                assert records[packet.name].ndim == 7
            else:
                assert packet.name == "structural"
                assert "displacementHistory" in packet.value
                item = packet.value["displacementHistory"]
                playback = decode_tensor_tree(item["schema"], item["data"], attachments)
            run.pending = packet
            run.acknowledge(packet.sequence)
            assert packet.ack.done() and not packet.attachments
        await run.task
        assert len(run.completed_sequences) == 23 and len(run.visualization_sequences) == 1
        assert records["power"].shape[3] == 2
        assert records["meanTemperature"].shape[3] == 3
        assert records["displacement"].shape[3] == 3
        assert records["power"].ravel()[0] > 0 and records["power"].ravel()[1] == 0
        temperature = records["meanTemperature"].ravel()
        assert temperature[1] > temperature[0] and temperature[2] < temperature[1]
        np.testing.assert_allclose(records["sourcePower"].ravel()[1:], records["power"].ravel(), rtol=1e-6)
        source = records["sourcePower"].ravel()[1:]
        loss = records["outwardPower"].ravel()[1:]
        energy = records["storedEnergy"].ravel()
        np.testing.assert_allclose(source * .005, np.diff(energy) + loss * .005, atol=source.max() * .005 * 1e-6)
        assert playback is not None
        final = run.simulation_api._states.handle(run.trace[-1]["outputStateRevision"])
        assert len(final["heat_transfer"]["thermal"]["history"]["times"]) == 3
        assert len(final["dc_current_density"]["electric"]["times"]) == 2
        assert len(final["structural_thermal"]["structural"]["times"]) == 3
        # Only the empty root and the returned accepted history retain leases.
        assert run.simulation_api._resources.stats().lease_count == 2
        run.simulation_api.release(final)
        assert run.simulation_api._resources.stats().resource_count == 1
        assert run.simulation_api._buffers.files() == ()
    finally:
        cache = Path(run.simulation_api._geometry_cache.name) if run.simulation_api else None
        await run.close()
        await asyncio.gather(run.task, return_exceptions=True)
        assert not run._record_packets
        if cache is not None:
            assert not cache.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["failed-trial", "cancel-child", "cancel-record"])
async def test_pulse_trial_failure_and_cancellation_cleanup(catalog_builds, mode):
    measurement = pulse_fixture(catalog_builds)
    if mode == "failed-trial":
        for rule in measurement["experiment"]["simulationProgram"]["tasks"]["thermal"]["config"]["initializations"]:
            if rule["methodId"] == "heat.coupling":
                rule["parameters"]["maxIterations"] = 2
                rule["parameters"]["relaxation"]["value"] = .5
    started = asyncio.Event()

    async def progress(value):
        if value.get("task") == "electric" and value.get("stage") == "dc-fem":
            started.set()

    run = CaeRun(measurement=measurement, max_run_seconds=600, job_id=mode, on_progress=progress)
    run.start()
    packet = None
    try:
        if mode == "cancel-child":
            await asyncio.wait_for(started.wait(), 120)
        else:
            packet = await asyncio.wait_for(run.queue.get(), 610)
            if mode == "failed-trial":
                assert packet["kind"] == "failed" and "did not converge" in str(packet)
                assert sum(event["task"] == "structural" for event in run.trace) == 1
                # The failed trial never commits an advancing Heat state.
                accepted = [event for event in run.trace if event["task"] == "thermal" and event["status"] == "succeeded"]
                assert all(event["observations"]["initialized"] or not event["observations"]["couplingConverged"] for event in accepted)
            else:
                assert isinstance(packet, RecordPacket) and not packet.ack.done()
        sim = run.simulation_api
        cache, buffers = Path(sim._geometry_cache.name), sim._buffers.root
    finally:
        await run.close()
        await asyncio.gather(run.task, return_exceptions=True)
    assert not cache.exists() and not buffers.exists() and not run._record_packets
    assert sim._resources.stats().resource_count == 0
    if isinstance(packet, RecordPacket):
        assert packet.ack.done() and packet.attachments == []
