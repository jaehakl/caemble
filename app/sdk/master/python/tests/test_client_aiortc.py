from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription

from gpstation_master import GpStationClient


class RtcJobTransport(httpx.AsyncBaseTransport):
    def __init__(self) -> None:
        self.answer_sdp: str | None = None
        self.peer_connections: list[RTCPeerConnection] = []
        self.calls: list[dict[str, Any]] = []
        self.ack_ids: list[str] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path == "/v1/jobs":
            body = json.loads(request.content)
            peer_connection = RTCPeerConnection(RTCConfiguration(iceServers=[]))
            self.peer_connections.append(peer_connection)

            @peer_connection.on("datachannel")
            def on_data_channel(channel: Any) -> None:
                @channel.on("message")
                def on_message(raw_message: Any) -> None:
                    if not isinstance(raw_message, str):
                        return
                    message = json.loads(raw_message)
                    if message.get("kind") == "job.call":
                        self.calls.append(message)
                        channel.send(
                            json.dumps(
                                {
                                    "kind": "job.event",
                                    "id": message["id"],
                                    "type": "ai.chat.delta",
                                    "payload": {"delta": "안녕"},
                                },
                                ensure_ascii=False,
                            )
                        )
                        channel.send(
                            json.dumps(
                                {
                                    "kind": "job.result",
                                    "id": message["id"],
                                    "payload": {"echo": message.get("payload")},
                                },
                                ensure_ascii=False,
                            )
                        )
                    elif message.get("kind") == "job.result.ack":
                        self.ack_ids.append(message["id"])
                    elif message.get("kind") == "job.finish":
                        channel.send(json.dumps({"kind": "job.finished", "id": message["id"]}))

            offer = body["offer"]
            await peer_connection.setRemoteDescription(
                RTCSessionDescription(type="offer", sdp=offer["sdp"])
            )
            await peer_connection.setLocalDescription(await peer_connection.createAnswer())
            assert peer_connection.localDescription is not None
            self.answer_sdp = peer_connection.localDescription.sdp
            return httpx.Response(
                200,
                json={
                    "job": {
                        "id": "job-1",
                        "user_id": "user-1",
                        "handler_type": body["handler_type"],
                        "slave_app_id": body["slave_app_id"],
                        "offer": offer,
                        "answer": None,
                        "progress": [],
                        "state": "answer_ready",
                    },
                    "answer_wait_url": "https://api.example.test/v1/jobs/job-1/wait-answer",
                },
            )
        if request.method == "GET" and request.url.path == "/v1/jobs/job-1/wait-answer":
            return httpx.Response(
                200,
                json={
                    "job_id": "job-1",
                    "state": "answer_ready",
                    "answer": {"type": "answer", "sdp": self.answer_sdp},
                    "last_error": None,
                },
            )
        return httpx.Response(404, json={"detail": "not found"})

    async def aclose(self) -> None:
        if self.peer_connections:
            await asyncio.gather(
                *(peer_connection.close() for peer_connection in self.peer_connections),
                return_exceptions=True,
            )


async def install_rtc_transport(client: GpStationClient, transport: RtcJobTransport) -> None:
    await client._http_client.aclose()
    client._http_client = httpx.AsyncClient(transport=transport, timeout=5)


async def wait_for_prewarm(client: GpStationClient) -> None:
    for _ in range(200):
        if client._prewarmed_connections:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("automatic prewarm did not complete")


async def test_cold_run_job_uses_real_aiortc_and_refills_prewarm() -> None:
    transport = RtcJobTransport()
    client = GpStationClient("https://api.example.test", "token-1")
    await install_rtc_transport(client, transport)
    statuses: list[str] = []
    diagnostics = []
    events = []
    try:
        result = await client.run_job(
            "ai.chat",
            {"prompt": "hello"},
            rtc_configuration=RTCConfiguration(iceServers=[]),
            on_status=statuses.append,
            on_diagnostic=diagnostics.append,
            on_event=events.append,
        )
        await wait_for_prewarm(client)
    finally:
        await client.close()

    assert result.payload == {"echo": {"prompt": "hello"}}
    assert events[0].payload == {"delta": "안녕"}
    assert transport.ack_ids == ["job-1"]
    assert "finishing job" in statuses
    assert any(event.stage == "job-prewarm" and event.prewarm_hit is False for event in diagnostics)


async def test_prewarm_hit_supports_multiple_session_calls() -> None:
    transport = RtcJobTransport()
    client = GpStationClient("https://api.example.test", "token-1")
    await install_rtc_transport(client, transport)
    diagnostics = []
    configuration = RTCConfiguration(iceServers=[])
    try:
        await client.prewarm_job_connection(rtc_configuration=configuration)
        first = await client.run_job(
            "ai.chat",
            {"prompt": "first"},
            rtc_configuration=configuration,
            auto_finish=False,
            on_diagnostic=diagnostics.append,
        )
        second = await first.session.call("ai.chat", {"prompt": "second"})
        await first.session.finish()
    finally:
        await client.close()

    assert first.payload == {"echo": {"prompt": "first"}}
    assert second.payload == {"echo": {"prompt": "second"}}
    assert [call["id"] for call in transport.calls] == ["job-1", "job-1:2"]
    assert transport.ack_ids == ["job-1", "job-1:2"]
    assert any(event.stage == "job-prewarm" and event.prewarm_hit is True for event in diagnostics)
