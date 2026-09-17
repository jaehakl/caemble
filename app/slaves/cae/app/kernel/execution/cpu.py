"""Machine-local CPU policy and child-local native thread controls."""
from __future__ import annotations

import os

import psutil
from threadpoolctl import threadpool_limits

from app.kernel.api import CpuAllocation
from sdk.slave.io import log

CPU_BUDGET_ENV = "CAEMBLE_CAE_CPU_BUDGET"
THREAD_ENV = ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
              "BLIS_NUM_THREADS", "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS")


def cpu_allocation(requested: int | None = None) -> CpuAllocation:
    try:
        available = len(psutil.Process().cpu_affinity())
    except (AttributeError, NotImplementedError, psutil.Error):
        available = os.cpu_count() or 1
    available = max(1, available)
    if requested is None:
        raw = os.environ.get(CPU_BUDGET_ENV)
        if raw is not None:
            try:
                requested = int(raw)
            except ValueError as exc:
                raise ValueError(f"{CPU_BUDGET_ENV} must be a positive integer") from exc
    if requested is not None and (isinstance(requested, bool) or not isinstance(requested, int) or requested < 1):
        raise ValueError(f"{CPU_BUDGET_ENV} must be a positive integer")
    budget = max(1, available // 2) if requested is None else min(requested, available)
    log(f"solver CPU allocation available={available} requested={requested} budget={budget}")
    return CpuAllocation(available, budget)


class NativeThreads:
    def __init__(self, count: int):
        self.count = count
        self._torch_configured = False
        self.apply(count)

    def apply(self, count: int) -> None:
        self.count = count
        for name in THREAD_ENV:
            os.environ[name] = str(count)
        # Also handles libraries imported before the invocation was decoded.
        self._limits = threadpool_limits(limits=count)

    def configure_torch(self) -> None:
        import torch

        if not self._torch_configured:
            torch.set_num_interop_threads(1)
            self._torch_configured = True
        torch.set_num_threads(self.count)
        log(f"solver Torch threads intra={torch.get_num_threads()} interop={torch.get_num_interop_threads()}")
