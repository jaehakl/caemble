from __future__ import annotations

import pytest
from aiortc import RTCConfiguration

from gpstation_master.binary import decode_binary_frame, encode_binary_frame
from gpstation_master.rtc import (
    parse_rtc_ice_servers_json,
    rtc_configuration_with_defaults,
    summarize_sdp_candidates,
)


def test_binary_frame_round_trips_utf8_header() -> None:
    header = {
        "kind": "attachment.chunk",
        "callId": "작업-1",
        "attachmentId": "이미지",
        "index": 0,
        "final": True,
    }

    decoded_header, body = decode_binary_frame(encode_binary_frame(header, b"\x00\x01"))

    assert decoded_header == header
    assert body == b"\x00\x01"


@pytest.mark.parametrize("frame", [b"", b"\x00\x00\x00\x00", b"\x00\x00\x00\x10{}"])
def test_binary_frame_rejects_invalid_header_length(frame: bytes) -> None:
    with pytest.raises(Exception, match="binary frame"):
        decode_binary_frame(frame)


def test_parse_rtc_ice_servers_json() -> None:
    servers = parse_rtc_ice_servers_json(
        '[{"urls":["stun:example.test:3478"],"username":"user","credential":"secret"}]'
    )

    assert servers[0].urls == ["stun:example.test:3478"]
    assert servers[0].username == "user"
    assert servers[0].credential == "secret"


def test_rtc_configuration_defaults_only_when_servers_are_unspecified() -> None:
    assert rtc_configuration_with_defaults(None).iceServers
    assert rtc_configuration_with_defaults(RTCConfiguration(iceServers=[])).iceServers == []


def test_summarize_sdp_candidates() -> None:
    summary = summarize_sdp_candidates(
        "\r\n".join(
            [
                "a=candidate:1 1 udp 1 10.0.0.1 10000 typ host",
                "a=candidate:2 1 udp 1 198.51.100.1 20000 typ srflx",
                "a=candidate:3 1 udp 1 203.0.113.1 30000 typ relay",
                "a=candidate:4 1 udp 1 203.0.113.2 40000 typ mystery",
            ]
        )
    )

    assert summary.host == 1
    assert summary.srflx == 1
    assert summary.relay == 1
    assert summary.unknown == 1
    assert summary.total == 4
