from __future__ import annotations

import asyncio
from collections import defaultdict
from collections.abc import Callable
from typing import Any


class FakeEmitter:
    def __init__(self) -> None:
        self.handlers: dict[str, list[Callable[..., Any]]] = defaultdict(list)

    def on(self, event: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        def register(callback: Callable[..., Any]) -> Callable[..., Any]:
            self.handlers[event].append(callback)
            return callback

        return register

    def emit(self, event: str, *args: Any) -> None:
        for callback in list(self.handlers[event]):
            callback(*args)


class FakePeerConnection(FakeEmitter):
    def __init__(self) -> None:
        super().__init__()
        self.signalingState = "stable"
        self.iceGatheringState = "complete"
        self.iceConnectionState = "connected"
        self.connectionState = "connected"

    async def close(self) -> None:
        self.signalingState = "closed"
        self.iceConnectionState = "closed"
        self.connectionState = "closed"


class FakeDataChannel(FakeEmitter):
    def __init__(self) -> None:
        super().__init__()
        self.readyState = "open"
        self.bufferedAmount = 0
        self.bufferedAmountLowThreshold = 0
        self.sent: list[str | bytes] = []

    def send(self, data: str | bytes) -> None:
        if self.readyState != "open":
            raise RuntimeError("data channel is closed")
        self.sent.append(data)

    def close(self) -> None:
        if self.readyState == "closed":
            return
        self.readyState = "closed"
        self.emit("close")

    def dispatch_message(self, data: str | bytes) -> None:
        self.emit("message", data)


async def wait_for_sent(channel: FakeDataChannel, count: int) -> None:
    for _ in range(100):
        if len(channel.sent) >= count:
            return
        await asyncio.sleep(0)
    raise AssertionError(f"expected at least {count} sent messages")
