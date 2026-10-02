"""Process-scoped execution identity and allocation, independent of transport."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any

from sdk.protocol.execution import ExecutionIdentity, ResourceAllocation

EXECUTION_ENV = "CAEMBLE_EXECUTION_JSON"
NATIVE_THREAD_ENV = (
    "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "BLIS_NUM_THREADS",
    "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "RAYON_NUM_THREADS",
)


@dataclass(frozen=True)
class ExecutionContext:
    identity: ExecutionIdentity
    allocation: ResourceAllocation

    def envelope(self, payload: dict[str, Any]) -> dict[str, Any]:
        return {**payload, **self.identity.model_dump()}

    def require_identity(self, payload: dict[str, Any]) -> None:
        if any(payload.get(key) != value for key, value in self.identity.model_dump().items()):
            raise ValueError("Message does not belong to this execution attempt")


def execution_context() -> ExecutionContext | None:
    raw = os.environ.get(EXECUTION_ENV)
    if raw is None:
        return None
    value = json.loads(raw)
    return ExecutionContext(
        ExecutionIdentity.model_validate(value["identity"]),
        ResourceAllocation.model_validate(value["allocation"]),
    )


def execution_frame(payload: dict[str, Any]) -> dict[str, Any]:
    context = execution_context()
    if context is None:
        return payload
    return context.envelope(payload)


def cpu_threads(requested: int | None = None) -> int | None:
    context = execution_context()
    if context is None:
        return requested
    budget = context.allocation.cpu_cores
    return min(requested, budget) if requested is not None and requested > 0 else budget


def configure_torch(torch: Any) -> None:
    """Configure a freshly imported Torch once in this attempt's process."""
    budget = cpu_threads()
    if budget is not None and not getattr(torch, "_caemble_execution_configured", False):
        torch.set_num_interop_threads(1)
        torch.set_num_threads(budget)
        torch._caemble_execution_configured = True


def configure_process(context: ExecutionContext) -> None:
    import psutil

    allocation = context.allocation
    process = psutil.Process()
    process.cpu_affinity(allocation.cpu_ids)
    if set(process.cpu_affinity()) != set(allocation.cpu_ids):
        raise RuntimeError("Could not apply execution CPU affinity")
    for name in NATIVE_THREAD_ENV:
        os.environ[name] = str(allocation.cpu_cores)
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ["CAEMBLE_CAE_CPU_BUDGET"] = str(allocation.cpu_cores)
    os.environ["CUDA_VISIBLE_DEVICES"] = ",".join(allocation.gpu_devices)


class ExecutionChannel:
    """Stamp control frames while keeping attachment bytes and channel behavior."""

    def __init__(self, channel: Any, context: ExecutionContext) -> None:
        object.__setattr__(self, "_channel", channel)
        object.__setattr__(self, "_context", context)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._channel, name)

    def __setattr__(self, name: str, value: Any) -> None:
        setattr(self._channel, name, value)

    def send(self, value: str | bytes) -> Any:
        if isinstance(value, str):
            value = json.dumps(self._context.envelope(json.loads(value)), ensure_ascii=False, separators=(",", ":"))
        return self._channel.send(value)
