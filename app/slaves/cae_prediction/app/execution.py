"""Per-call model execution inputs, owned by the Predictor runtime."""
from __future__ import annotations

from dataclasses import dataclass
import threading
from typing import Callable

from sdk.protocol.execution import ResourceAllocation


@dataclass(frozen=True)
class ModelExecutionContext:
    """Borrowed for one call; never retained by a model or written to its artifact.

    RAM is the additional host memory available after resident models are counted.
    Prepare/load budget new persistent storage plus scratch; prediction budgets
    only additional scratch. GPU budgets remain in the launcher's allocation.
    Managed workers always supply an allocation; standalone fixtures may omit it.
    """

    allocation: ResourceAllocation | None
    available_ram_bytes: int
    cancel: threading.Event | None = None
    progress: Callable[[str | dict], None] | None = None
