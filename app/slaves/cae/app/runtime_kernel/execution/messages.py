from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any


class ChildMessageKind(str, Enum):
    BOOTSTRAPPED = "bootstrapped"
    STARTED = "started"
    PROGRESS = "progress"
    RESULT = "result"
    ERROR = "error"


@dataclass(frozen=True, slots=True)
class RemoteError:
    module: str
    name: str
    message: str
    traceback: str


@dataclass(frozen=True, slots=True)
class ChildMessage:
    kind: ChildMessageKind
    payload: Any = None


@dataclass(frozen=True, slots=True)
class SolverChildRequest:
    """Invocation data sent only after the spawned interpreter is alive."""

    locator: str
    expected_abi_version: int | None
    encoded_context: Any
    codec: Any
