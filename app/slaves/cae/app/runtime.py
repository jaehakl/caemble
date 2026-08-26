"""Compatibility facade for the resident CAE runtime kernel."""

from app.runtime_kernel.coordinator.run import (
    CaeRun,
    DEFAULT_MAX_RUN_SECONDS,
    FIRST_NEXT_TIMEOUT_SECONDS,
    HEARTBEAT_SECONDS,
    LIVENESS_SECONDS,
    RECORD_ACK_TIMEOUT_SECONDS,
    SimulationApi,
    create_run,
    started_payload,
)

__all__ = [
    "CaeRun",
    "DEFAULT_MAX_RUN_SECONDS",
    "FIRST_NEXT_TIMEOUT_SECONDS",
    "HEARTBEAT_SECONDS",
    "LIVENESS_SECONDS",
    "RECORD_ACK_TIMEOUT_SECONDS",
    "SimulationApi",
    "create_run",
    "started_payload",
]
