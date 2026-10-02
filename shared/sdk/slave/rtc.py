from __future__ import annotations

import asyncio
import inspect
import time
from dataclasses import dataclass
from typing import Any

from sdk.slave.io import log


@dataclass
class PreparedWorkerPeer:
    pc: Any
    created_at: float


async def prepare_worker_peer(rtc_peer_connection_cls: Any, rtc_configuration: Any, *, label: str) -> PreparedWorkerPeer:
    started_at = time.perf_counter()
    pc = rtc_peer_connection_cls(rtc_configuration)
    try:
        create_sctp_transport = getattr(pc, "_RTCPeerConnection__createSctpTransport", None)
        if create_sctp_transport is None:
            raise RuntimeError("aiortc SCTP prewarm hook is unavailable")
        create_sctp_transport()
        ice_transports = list(getattr(pc, "_RTCPeerConnection__iceTransports", ()))
        if not ice_transports:
            raise RuntimeError("aiortc created no ICE transports for memory cache")
        await asyncio.gather(*(transport.iceGatherer.gather() for transport in ice_transports))
        log(
            f"{label} ICE memory cache prepared duration_ms={elapsed_ms(started_at)} "
            f"candidates: {format_candidate_summary(summarize_pc_local_candidates(pc))}"
        )
        return PreparedWorkerPeer(pc=pc, created_at=time.perf_counter())
    except Exception:
        await maybe_await(pc.close())
        raise


async def maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def summarize_sdp_candidates(sdp: str) -> dict[str, int]:
    summary = {"host": 0, "srflx": 0, "relay": 0, "prflx": 0, "unknown": 0, "total": 0}
    for line in sdp.splitlines():
        if not line.startswith("a=candidate:"):
            continue
        summary["total"] += 1
        parts = line.split()
        candidate_type = parts[parts.index("typ") + 1] if "typ" in parts and parts.index("typ") + 1 < len(parts) else "unknown"
        if candidate_type in {"host", "srflx", "relay", "prflx"}:
            summary[candidate_type] += 1
        else:
            summary["unknown"] += 1
    return summary


def summarize_pc_local_candidates(pc: Any) -> dict[str, int]:
    summary = {"host": 0, "srflx": 0, "relay": 0, "prflx": 0, "unknown": 0, "total": 0}
    for ice_transport in getattr(pc, "_RTCPeerConnection__iceTransports", ()):
        for candidate in ice_transport.iceGatherer.getLocalCandidates():
            summary["total"] += 1
            candidate_type = getattr(candidate, "type", "unknown")
            if candidate_type in {"host", "srflx", "relay", "prflx"}:
                summary[candidate_type] += 1
            else:
                summary["unknown"] += 1
    return summary


def format_candidate_summary(summary: dict[str, int]) -> str:
    return (
        f"total={summary['total']} host={summary['host']} srflx={summary['srflx']} "
        f"relay={summary['relay']} prflx={summary['prflx']} unknown={summary['unknown']}"
    )


def elapsed_ms(started_at: float) -> int:
    return round((time.perf_counter() - started_at) * 1000)
