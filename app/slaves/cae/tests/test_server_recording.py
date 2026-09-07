from __future__ import annotations

import asyncio
from types import SimpleNamespace

import numpy as np
import pytest

from app.kernel.transport.tensor import decode_attachment_tensors, encode_recorded_data
from app.kernel.coordinator.simulation import SimulationApi
from app.kernel.transport import handlers
from sdk.protocol.packets import receive_packet, send_packet


@pytest.mark.asyncio
async def test_fdtd_tensor_and_axis_metadata_round_trip_through_server_packets() -> None:
    field = np.arange(91 * 4 * 4 * 2 * 3, dtype=np.float32).reshape(91, 4, 4, 2, 3)
    axes = [{"name": "time", "unit": "s", "ticks": np.linspace(0, 15e-15, 91)}]
    encoded, attachments, _ = encode_recorded_data(
        "field", {"dtype": "float32"}, {"value": field, "axes": axes}, 1,
    )
    frames = asyncio.Queue()
    await send_packet(frames.put, frames.put, {"type": "job.record", "value": encoded}, attachments)
    payload, received = await receive_packet(frames.get)
    result = decode_attachment_tensors({"dtype": "float32", "value": payload["value"]}, received)
    actual = result["value"]
    if isinstance(actual, dict):
        actual = actual["storage"]["value"]
    np.testing.assert_array_equal(actual, field)
    assert isinstance(payload["value"]["axes"][0]["ticks"], list)


@pytest.mark.asyncio
@pytest.mark.parametrize("acknowledged", [False, True])
async def test_record_ack_wait_starts_after_upload(monkeypatch, acknowledged) -> None:
    # Use a scalar producer to exercise recording without starting a solver.
    monkeypatch.setattr(SimulationApi, "record", lambda self, name, value: self._run.record(name, value))
    monkeypatch.setattr(handlers, "RECORD_ACK_TIMEOUT_SECONDS", 0.02)
    uploaded = False

    async def send(packet, attachments=()):
        nonlocal uploaded
        if packet["type"] == "job.record":
            await asyncio.sleep(0.06)
            assert packet["value"]["storage"] == {"kind": "inline", "value": 2.5}
            assert attachments == []
            uploaded = True

    async def receive():
        assert uploaded
        if not acknowledged:
            await asyncio.Future()
        return {"type": "job.record.ack", "sequence": 1}, []

    measurement = {
        "experiment": {
            "scene": {},
            "simulationProgram": {
                "tasks": {}, "recordedData": {"result": {"dtype": "float64"}},
                "pythonSource": "async def simulate(*, sim, tasks, vars):\n    await sim.record('result', 2.5)\n    return None\n",
            },
        },
        "materialParameters": {}, "materialWarnings": [],
    }
    result = handlers.run_measurement(
        {"measurement": measurement}, [], SimpleNamespace(job_id="slow-upload", send=send, receive=receive),
    )
    if acknowledged:
        assert await result == {"recordSequences": [1]}
    else:
        with pytest.raises(TimeoutError):
            await result
    assert uploaded
