from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass
from typing import Any, Hashable

from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection

from .constants import DATA_CHANNEL_LABEL, DEFAULT_RTC_ICE_SERVERS, PEER_CLOSE_TIMEOUT_SECONDS
from .types import CandidateSummary


@dataclass(slots=True)
class PreparedJobConnection:
    peer_connection: RTCPeerConnection
    data_channel: Any
    key: Hashable
    slave_app_id: str
    rtc_configuration: RTCConfiguration
    local_sdp: str
    offer_gathering_ms: int
    diagnostics_registered: bool = False


def parse_rtc_ice_servers_json(value: str) -> list[RTCIceServer]:
    return [
        RTCIceServer(
            urls=item["urls"],
            username=item.get("username"),
            credential=item.get("credential"),
            credentialType=item.get("credentialType", "password"),
        )
        for item in json.loads(value)
    ]


def summarize_sdp_candidates(sdp: str) -> CandidateSummary:
    summary = CandidateSummary()
    for line in sdp.splitlines():
        if not line.startswith("a=candidate:"):
            continue
        summary.total += 1
        match = re.search(r"\btyp\s+(\S+)", line)
        candidate_type = match.group(1) if match else "unknown"
        if candidate_type in {"host", "srflx", "relay", "prflx"}:
            setattr(summary, candidate_type, getattr(summary, candidate_type) + 1)
        else:
            summary.unknown += 1
    return summary


def rtc_configuration_with_defaults(configuration: RTCConfiguration | None) -> RTCConfiguration:
    if configuration is None:
        return RTCConfiguration(iceServers=list(DEFAULT_RTC_ICE_SERVERS))
    return RTCConfiguration(
        iceServers=(
            list(DEFAULT_RTC_ICE_SERVERS)
            if configuration.iceServers is None
            else list(configuration.iceServers)
        ),
        bundlePolicy=configuration.bundlePolicy,
    )


def job_connection_key(slave_app_id: str, configuration: RTCConfiguration) -> Hashable:
    servers = tuple(
        (
            tuple(server.urls) if isinstance(server.urls, list) else server.urls,
            server.username,
            server.credential,
            server.credentialType,
        )
        for server in configuration.iceServers or []
    )
    bundle_policy = getattr(configuration.bundlePolicy, "value", str(configuration.bundlePolicy))
    return slave_app_id, bundle_policy, servers


async def create_prepared_job_connection(
    slave_app_id: str,
    configuration: RTCConfiguration,
    timeout_seconds: float,
) -> PreparedJobConnection:
    key = job_connection_key(slave_app_id, configuration)
    peer_connection = RTCPeerConnection(configuration)
    data_channel = peer_connection.createDataChannel(DATA_CHANNEL_LABEL, ordered=True)
    started_at = time.perf_counter()
    try:
        async with asyncio.timeout(timeout_seconds):
            offer = await peer_connection.createOffer()
            await peer_connection.setLocalDescription(offer)
        return PreparedJobConnection(
            peer_connection=peer_connection,
            data_channel=data_channel,
            key=key,
            slave_app_id=slave_app_id,
            rtc_configuration=configuration,
            local_sdp=peer_connection.localDescription.sdp,
            offer_gathering_ms=round((time.perf_counter() - started_at) * 1000),
        )
    except asyncio.CancelledError:
        await close_peer_connection(peer_connection, data_channel)
        raise
    except Exception:
        await close_peer_connection(peer_connection, data_channel)
        raise


async def close_peer_connection(peer_connection: RTCPeerConnection, data_channel: Any) -> None:
    if getattr(data_channel, "readyState", "closed") != "closed":
        data_channel.close()
        deadline = asyncio.get_running_loop().time() + 1.0
        while (
            getattr(data_channel, "readyState", "closed") != "closed"
            and asyncio.get_running_loop().time() < deadline
        ):
            await asyncio.sleep(0.01)
    try:
        async with asyncio.timeout(PEER_CLOSE_TIMEOUT_SECONDS):
            await peer_connection.close()
    except TimeoutError:
        # aiortc marks signalingState closed before waiting for transport shutdown.
        pass
