from __future__ import annotations

import asyncio
import json
import unittest
from collections.abc import Callable
from typing import Any

from gpstation_master.binary import encode_binary_frame
from gpstation_master.errors import GpStationProtocolError
from gpstation_master.job_peer import GpStationJobPeer


class FakePeerConnection:
    signalingState = "stable"
    iceGatheringState = "complete"
    iceConnectionState = "connected"
    connectionState = "connected"

    async def close(self) -> None:
        self.signalingState = "closed"
        self.connectionState = "closed"


class FakeDataChannel:
    def __init__(self) -> None:
        self.readyState = "open"
        self.bufferedAmount = 0
        self.bufferedAmountLowThreshold = 0
        self.sent: list[str | bytes] = []
        self.handlers: dict[str, list[Callable[..., None]]] = {}

    def on(self, event: str) -> Callable[[Callable[..., None]], Callable[..., None]]:
        def register(callback: Callable[..., None]) -> Callable[..., None]:
            self.handlers.setdefault(event, []).append(callback)
            return callback

        return register

    def send(self, value: str | bytes) -> None:
        self.sent.append(value)

    def emit(self, event: str, value: Any = None) -> None:
        for callback in self.handlers.get(event, []):
            if value is None:
                callback()
            else:
                callback(value)

    def close(self) -> None:
        self.readyState = "closed"
        self.emit("close")


class JobPeerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.peer_connection = FakePeerConnection()
        self.channel = FakeDataChannel()
        self.diagnostics: list[Any] = []
        self.peer = GpStationJobPeer(
            self.peer_connection,
            self.channel,
            self.diagnostics.append,
        )

    async def asyncTearDown(self) -> None:
        await self.peer.close()

    async def test_inline_result_keeps_public_call_contract(self) -> None:
        call = asyncio.create_task(self.peer.call("call-1", "example", {}, 1))
        await asyncio.sleep(0)

        self.channel.emit(
            "message",
            json.dumps(
                {
                    "kind": "job.result",
                    "id": "call-1",
                    "type": "example.result",
                    "payload": {"ok": True},
                    "attachments": [],
                },
                separators=(",", ":"),
            ),
        )

        result = await call
        self.assertEqual(result.payload, {"ok": True})
        self.assertEqual(result.files, [])
        self.assertTrue(
            any(
                isinstance(item, str) and json.loads(item).get("kind") == "job.result.ack"
                for item in self.channel.sent
            )
        )

    async def test_payload_attachments_are_restored_and_hidden(self) -> None:
        payload = {"kind": "record", "values": list(range(200))}
        payload_bytes = json.dumps(payload, separators=(",", ":")).encode()
        payload_ids = ["payload-0", "payload-1"]
        split = len(payload_bytes) // 2
        chunks = [payload_bytes[:split], payload_bytes[split:]]
        user_data = b"field-bytes"
        call = asyncio.create_task(self.peer.call("call-2", "cae.simulation.next", {}, 1))
        await asyncio.sleep(0)

        control = json.dumps(
            {
                "kind": "job.result",
                "id": "call-2",
                "type": "cae.simulation.next.result",
                "payload": {
                    "kind": "gpstation.job-result.payload-attachments",
                    "storage": {
                        "kind": "attachments",
                        "ids": payload_ids,
                        "byteLength": len(payload_bytes),
                    },
                },
                "attachments": [
                    {"id": payload_ids[0], "size": len(chunks[0])},
                    {"id": payload_ids[1], "size": len(chunks[1])},
                    {"id": "field", "size": len(user_data), "mimeType": "application/octet-stream"},
                ],
            },
            separators=(",", ":"),
        )
        self.channel.emit("message", control)
        for attachment_id, data in [
            (payload_ids[0], chunks[0]),
            (payload_ids[1], chunks[1]),
            ("field", user_data),
        ]:
            self.channel.emit(
                "message",
                encode_binary_frame(
                    {
                        "kind": "attachment.chunk",
                        "callId": "call-2",
                        "attachmentId": attachment_id,
                        "index": 0,
                        "final": True,
                    },
                    data,
                ),
            )

        result = await call
        self.assertEqual(result.payload, payload)
        self.assertEqual([item.id for item in result.files], ["field"])
        self.assertEqual(result.files[0].data, user_data)
        diagnostic = next(item for item in self.diagnostics if item.stage == "job-result")
        self.assertEqual(diagnostic.attachment_count, 1)
        self.assertEqual(diagnostic.attachment_bytes, len(user_data))
        self.assertEqual(diagnostic.payload_attachment_bytes, len(payload_bytes))
        self.assertEqual(diagnostic.control_bytes, len(control.encode()))

    async def test_out_of_order_chunk_is_rejected_without_ack(self) -> None:
        call = asyncio.create_task(self.peer.call("call-3", "example", {}, 1))
        await asyncio.sleep(0)
        self.channel.emit(
            "message",
            json.dumps(
                {
                    "kind": "job.result",
                    "id": "call-3",
                    "payload": {},
                    "attachments": [{"id": "field", "size": 4}],
                },
                separators=(",", ":"),
            ),
        )
        self.channel.emit(
            "message",
            encode_binary_frame(
                {
                    "kind": "attachment.chunk",
                    "callId": "call-3",
                    "attachmentId": "field",
                    "index": 1,
                    "final": True,
                },
                b"data",
            ),
        )

        with self.assertRaisesRegex(GpStationProtocolError, "unexpected attachment chunk index"):
            await call
        self._assert_no_result_ack()

    async def test_incomplete_final_chunk_is_rejected_without_ack(self) -> None:
        call = asyncio.create_task(self.peer.call("call-4", "example", {}, 1))
        await asyncio.sleep(0)
        self.channel.emit(
            "message",
            json.dumps(
                {
                    "kind": "job.result",
                    "id": "call-4",
                    "payload": {},
                    "attachments": [{"id": "field", "size": 5}],
                },
                separators=(",", ":"),
            ),
        )
        self.channel.emit(
            "message",
            encode_binary_frame(
                {
                    "kind": "attachment.chunk",
                    "callId": "call-4",
                    "attachmentId": "field",
                    "index": 0,
                    "final": True,
                },
                b"data",
            ),
        )

        with self.assertRaisesRegex(GpStationProtocolError, "attachment size mismatch"):
            await call
        self._assert_no_result_ack()

    async def test_missing_payload_attachment_is_rejected_without_ack(self) -> None:
        call = asyncio.create_task(self.peer.call("call-5", "example", {}, 1))
        await asyncio.sleep(0)
        self.channel.emit(
            "message",
            json.dumps(
                {
                    "kind": "job.result",
                    "id": "call-5",
                    "payload": {
                        "kind": "gpstation.job-result.payload-attachments",
                        "storage": {
                            "kind": "attachments",
                            "ids": ["missing"],
                            "byteLength": 2,
                        },
                    },
                    "attachments": [],
                },
                separators=(",", ":"),
            ),
        )

        with self.assertRaisesRegex(GpStationProtocolError, "missing job result payload attachment"):
            await call
        self._assert_no_result_ack()

    def _assert_no_result_ack(self) -> None:
        self.assertFalse(
            any(
                isinstance(item, str) and json.loads(item).get("kind") == "job.result.ack"
                for item in self.channel.sent
            )
        )


if __name__ == "__main__":
    unittest.main()
