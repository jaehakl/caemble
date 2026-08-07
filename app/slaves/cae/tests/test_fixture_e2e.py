import json
from pathlib import Path

import numpy as np
import pytest
from sdk.protocol.messages import DataChannelAttachment, DataChannelMessage
from sdk.slave import SlaveContext

from app.handlers import cae_simulation_next, cae_simulation_start


FIXTURE_DIRECTORY = Path(__file__).parent / "fixtures" / "dc-uniform-bar"


def load_json(name: str):
    return json.loads((FIXTURE_DIRECTORY / name).read_text(encoding="utf-8"))


def load_request():
    request = load_json("request.json")
    assert request["formatVersion"] == 1
    attachments = []
    for metadata in request["attachments"]:
        file_path = (FIXTURE_DIRECTORY / metadata["file"]).resolve()
        assert file_path.is_relative_to(FIXTURE_DIRECTORY.resolve())
        data = file_path.read_bytes()
        assert len(data) == metadata["byteLength"]
        attachments.append(
            DataChannelAttachment(
                id=metadata["id"],
                name=metadata["name"],
                mimeType=metadata["mimeType"],
                data=data,
            )
        )
    return request["payload"], attachments


def materialize_record(response: DataChannelMessage, expected: dict):
    tensor = response.payload["tensor"]
    assert tensor["shape"] == expected["shape"]
    storage = tensor["storage"]
    if storage["kind"] == "inline":
        assert response.attachments == []
        return storage["value"]

    attachments = {attachment.id: attachment for attachment in response.attachments}
    assert list(attachments) == storage["ids"]
    raw = b"".join(attachments[attachment_id].data for attachment_id in storage["ids"])
    assert len(raw) == storage["byteLength"]
    if expected["dtype"] == "string":
        return json.loads(raw.decode("utf-8"))
    return np.frombuffer(raw, dtype=np.dtype(expected["dtype"]).newbyteorder("<")).reshape(expected["shape"])


@pytest.mark.asyncio
async def test_dc_uniform_bar_ui_fixture_runs_through_cae_handlers():
    payload, attachments = load_request()
    expected = load_json("expected.json")
    assert expected["formatVersion"] == 1
    expected_records = expected["records"]
    recorded_schemas = payload["setup"]["experiment"]["simulationProgram"]["recordedData"]
    events = []

    async def send_event(event_type, event_payload):
        events.append((event_type, event_payload))

    memory = {"runs": {}}
    start = await cae_simulation_start(
        DataChannelMessage(
            id="start",
            type="cae.simulation.start",
            payload=payload,
            attachments=attachments,
        ),
        memory,
        SlaveContext(session_id="fixture-job", ttl_seconds=30, call_id="start", _event_sender=send_event),
    )
    assert start.payload["kind"] == "started"
    assert start.attachments == []

    run_id = start.payload["runId"]
    ack_sequence = None
    actual_sequences = []
    for index, expected_record in enumerate(expected_records, start=1):
        response = await cae_simulation_next(
            DataChannelMessage(
                id=f"next-{index}",
                type="cae.simulation.next",
                payload={"runId": run_id, "ackSequence": ack_sequence},
            ),
            memory,
            SlaveContext(
                session_id="fixture-job",
                ttl_seconds=30,
                call_id=f"next-{index}",
                _event_sender=send_event,
            ),
        )
        assert response.payload["kind"] == "record"
        assert response.payload["name"] == expected_record["name"]
        assert recorded_schemas[expected_record["name"]]["dtype"] == expected_record["dtype"]
        value = materialize_record(response, expected_record)
        np.testing.assert_allclose(
            value,
            expected_record["value"],
            rtol=0,
            atol=expected_record["absoluteTolerance"],
        )
        ack_sequence = response.payload["sequence"]
        actual_sequences.append(ack_sequence)

    terminal = await cae_simulation_next(
        DataChannelMessage(
            id="next-terminal",
            type="cae.simulation.next",
            payload={"runId": run_id, "ackSequence": ack_sequence},
        ),
        memory,
        SlaveContext(
            session_id="fixture-job",
            ttl_seconds=30,
            call_id="next-terminal",
            _event_sender=send_event,
        ),
    )
    assert terminal.payload == expected["terminal"]
    assert terminal.payload["recordSequences"] == actual_sequences
    assert terminal.attachments == []
    assert memory["runs"] == {}
    assert any(event_type == "progress" for event_type, _ in events)
