from __future__ import annotations

import asyncio
import struct
import os
import pickle
import time
from dataclasses import dataclass
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Any

from app.kernel.api import SolverImplementation, SolverInvocation, SolverResult
from app.kernel.execution.messages import ChildMessage, ChildMessageKind


@dataclass(frozen=True)
class SlowChildCleanup:
    marker: str
    owner_pid: int
    delay: float = 1.5

    def __del__(self) -> None:
        if os.getpid() != self.owner_pid:
            Path(self.marker).write_text("started", encoding="utf-8")
            time.sleep(self.delay)
            Path(self.marker).write_text("released", encoding="utf-8")


@dataclass(frozen=True, slots=True)
class SlowPicklePayloadCodec:
    delay: float = 0.2

    def encode(self, value: Any) -> bytes:
        time.sleep(self.delay)
        return pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)

    def decode(self, payload: bytes) -> Any:
        time.sleep(self.delay)
        return pickle.loads(payload)


@dataclass(frozen=True, slots=True)
class SlowInvocationDecodeCodec:
    delay: float = 0.2

    def encode(self, value: Any) -> bytes:
        return pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)

    def decode(self, payload: bytes) -> Any:
        value = pickle.loads(payload)
        if isinstance(value, SolverInvocation) and "payload" in value.config:
            time.sleep(self.delay)
        return value


def exits_before_bootstrap(
    request_connection: Connection,
    result_connection: Connection,
    cancellation_event: Any,
) -> None:
    del request_connection, result_connection, cancellation_event
    os._exit(29)


def closes_request_after_bootstrap(
    request_connection: Connection,
    result_connection: Connection,
    cancellation_event: Any,
) -> None:
    del cancellation_event
    result_connection.send(ChildMessage(ChildMessageKind.BOOTSTRAPPED, os.getpid()))
    request_connection.close()
    result_connection.close()


def never_starts(
    request_connection: Connection,
    result_connection: Connection,
    cancellation_event: Any,
) -> None:
    result_connection.send(ChildMessage(ChildMessageKind.BOOTSTRAPPED, os.getpid()))
    while not cancellation_event.wait(0.01):
        pass
    request_connection.close()
    result_connection.close()


async def _flooding(context):
    workspace = Path(context.resources.workspace_path)
    (workspace / "numerical-scratch").write_bytes(b"temporary")
    await context.progress({"stage": "ready", "workspace": str(workspace)})
    try:
        # The parent deliberately pauses its progress callback while this frame
        # exceeds the pipe buffer. Cancellation must continue consuming frames.
        await context.progress({"stage": "bulk", "payload": b"x" * (4 * 1024 * 1024)})
        context.cancellation.raise_if_cancelled()
    except asyncio.CancelledError:
        Path(context.config["observed"]).write_text("cooperative cancellation", encoding="utf-8")
        raise
    return SolverResult()


async def _forced_exit(context):
    workspace = Path(context.resources.workspace_path)
    (workspace / "numerical-scratch").write_bytes(b"temporary")
    await context.progress({"stage": "ready", "workspace": str(workspace)})
    time.sleep(30)
    return SolverResult()


async def _crashes(context):
    import os
    workspace = Path(context.resources.workspace_path)
    (workspace / "numerical-scratch").write_bytes(b"temporary")
    await context.progress({"stage": "ready", "workspace": str(workspace)})
    os._exit(17)


flooding = SolverImplementation(3, _flooding)


forced_exit = SolverImplementation(3, _forced_exit)


crashes = SolverImplementation(3, _crashes)


def _partial_frame(connection, ready):
    # Socket-based Connection uses this framing on every platform, including
    # Windows. The advertised payload never finishes until the child exits.
    connection._send(struct.pack("!i", 4096) + b"partial")
    ready.set()
    time.sleep(30)
