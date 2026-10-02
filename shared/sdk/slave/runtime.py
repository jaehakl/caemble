from __future__ import annotations

import asyncio

from sdk.slave.app import MessageHandler, SlaveApp, SlaveContext
from sdk.slave.channel import (
    BUFFERED_AMOUNT_DRAIN_TIMEOUT_SECONDS,
    BUFFERED_AMOUNT_LOW_THRESHOLD,
    CHUNK_SIZE,
    BUFFERED_AMOUNT_HIGH_WATER_MARK,
    attachment_metadata,
    decode_binary_frame,
    encode_binary_frame,
    send_attachment,
    send_job_result,
)
from sdk.slave.config import (
    DEFAULT_RTC_ICE_SERVERS,
    DEFAULT_STUN_ICE_GATHER_TIMEOUT_SECONDS,
    DEFAULT_TURN_ICE_GATHER_TIMEOUT_SECONDS,
    RTC_ICE_GATHER_TIMEOUT_ENV,
    RTC_ICE_SERVERS_ENV,
    RTC_MEMORY_CACHE_ENABLED_ENV,
    build_rtc_configuration,
    configure_aioice_gather_timeout,
    ice_server_kwargs,
    iter_rtc_ice_server_urls,
    load_rtc_ice_gather_timeout_seconds,
    load_rtc_ice_servers,
    load_rtc_memory_cache_enabled,
)
from sdk.slave.io import emit, log, parse_args, read_stdin_line
from sdk.slave.rtc import (
    PreparedWorkerPeer,
    elapsed_ms,
    format_candidate_summary,
    maybe_await,
    prepare_worker_peer,
    summarize_pc_local_candidates,
    summarize_sdp_candidates,
)
from sdk.slave.worker import (
    JOB_RESULT_ACK_TIMEOUT_SECONDS,
    WorkerJobPeerState,
    _run_worker_stdio,
    attach_worker_job_peer_handlers,
    build_worker_job_answer,
    create_worker_job_peer,
    drain_worker_job_task,
    parse_job_ready_message,
    receive_job_call,
    receive_request_attachment_chunk,
    run_worker_job,
    wait_for_job_result_ack,
)


def run_app(app: SlaveApp) -> None:
    args = parse_args()
    if not args.worker:
        raise SystemExit("--worker is required")
    asyncio.run(_run_worker_stdio(app=app))


__all__ = [
    "BUFFERED_AMOUNT_LOW_THRESHOLD",
    "BUFFERED_AMOUNT_DRAIN_TIMEOUT_SECONDS",
    "CHUNK_SIZE",
    "DEFAULT_RTC_ICE_SERVERS",
    "DEFAULT_STUN_ICE_GATHER_TIMEOUT_SECONDS",
    "DEFAULT_TURN_ICE_GATHER_TIMEOUT_SECONDS",
    "JOB_RESULT_ACK_TIMEOUT_SECONDS",
    "MessageHandler",
    "BUFFERED_AMOUNT_HIGH_WATER_MARK",
    "PreparedWorkerPeer",
    "RTC_ICE_GATHER_TIMEOUT_ENV",
    "RTC_ICE_SERVERS_ENV",
    "RTC_MEMORY_CACHE_ENABLED_ENV",
    "SlaveApp",
    "SlaveContext",
    "WorkerJobPeerState",
    "_run_worker_stdio",
    "attach_worker_job_peer_handlers",
    "attachment_metadata",
    "build_rtc_configuration",
    "build_worker_job_answer",
    "configure_aioice_gather_timeout",
    "create_worker_job_peer",
    "drain_worker_job_task",
    "decode_binary_frame",
    "elapsed_ms",
    "emit",
    "encode_binary_frame",
    "format_candidate_summary",
    "ice_server_kwargs",
    "iter_rtc_ice_server_urls",
    "load_rtc_ice_gather_timeout_seconds",
    "load_rtc_ice_servers",
    "load_rtc_memory_cache_enabled",
    "log",
    "maybe_await",
    "parse_args",
    "parse_job_ready_message",
    "receive_job_call",
    "receive_request_attachment_chunk",
    "prepare_worker_peer",
    "read_stdin_line",
    "run_app",
    "run_worker_job",
    "send_attachment",
    "send_job_result",
    "summarize_pc_local_candidates",
    "summarize_sdp_candidates",
    "wait_for_job_result_ack",
]
