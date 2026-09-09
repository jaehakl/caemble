import hashlib
import json
from unittest.mock import patch

import numpy as np
import pytest

from app.kernel.transport.object_storage import externalize_record, read_object, upload_object
from app.kernel.transport.tensor import encode_recorded_data


class Context:
    def __init__(self):
        self.messages = []
        self.manifests = {}
        self.parts = {}
        self.reply = None

    async def send(self, packet):
        self.messages.append(packet)
        operation = packet["type"].split(".")[-1]
        if operation == "prepare":
            manifest = packet["manifest"]
            identity = manifest["sha256"]
            self.manifests[identity] = manifest
        else:
            identity = packet.get("object_id") or packet["reference"]["id"]
            manifest = self.manifests[identity]
        reference = {"kind": "caemble.object", "version": 1, "id": identity,
                     **{key: value for key, value in manifest.items() if key != "chunks"}}
        self.reply = {"type": f"job.storage.{operation}.ack", "reference": reference,
                      "parts": [{**part, "url": f"{identity}/{index}"} for index, part in enumerate(manifest["chunks"])]}
        if operation == "complete":
            for index, part in enumerate(manifest["chunks"]):
                assert hashlib.sha256(self.parts[f"{identity}/{index}"]).hexdigest() == part["sha256"]

    async def receive(self):
        return self.reply, []

    def transfer(self, part, data=None):
        if data is None:
            return self.parts[part["url"]]
        self.parts[part["url"]] = data


@pytest.mark.asyncio
async def test_large_binary_record_and_axis_values_bypass_control_connection():
    context = Context()
    values = np.arange(20000, dtype=np.float64)
    schema = {"dtype": "float64"}
    encoded, attachments, _ = encode_recorded_data("field", schema,
        {"value": values, "axes": [{"ticks": values.tolist()}]}, 1)
    with patch("app.kernel.transport.object_storage.transfer_part", context.transfer):
        stored = await externalize_record(context, encoded, {item.id: item.data for item in attachments})
    assert stored["storage"]["kind"] == "base64"
    ref = stored["storage"]["data"]
    assert context.parts[f"{ref['id']}/0"] == values.astype("<f8").tobytes()
    assert ref["byteLength"] == values.nbytes
    assert isinstance(stored["axes"], list)
    assert stored["axes"][0]["ticks"]["kind"] == "caemble.object"
    assert all(len(json.dumps(packet)) < 65536 for packet in context.messages)
    assert len(json.dumps(stored)) < 65536


@pytest.mark.asyncio
async def test_input_is_hash_checked_after_direct_download():
    context = Context()
    value = {"measurement": {"experiment": {"scene": {"data": [1, 2, 3]}}}}
    raw = json.dumps(value).encode()
    with patch("app.kernel.transport.object_storage.transfer_part", context.transfer):
        ref = await upload_object(context, raw, "json")
        assert await read_object(context, ref) == value
        context.parts[f"{ref['id']}/0"] = b"corrupt"
        with pytest.raises(ValueError, match="hash"):
            await read_object(context, ref)
