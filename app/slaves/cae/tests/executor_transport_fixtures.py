from __future__ import annotations

import os
import pickle
import time
from dataclasses import dataclass
from multiprocessing.connection import Connection
from typing import Any

from app.runtime_kernel.execution.messages import ChildMessage, ChildMessageKind


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
        if isinstance(value, dict) and "payload" in value:
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
