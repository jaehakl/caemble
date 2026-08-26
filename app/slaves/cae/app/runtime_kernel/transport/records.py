from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Callable

from sdk.protocol.messages import DataChannelAttachment


@dataclass
class RecordResourceHold:
    """Idempotent ownership handoff for resources retained by a record packet."""

    finalizer: Callable[[], None]
    handed_off: bool = False
    released: bool = False

    def hand_off(self) -> None:
        if self.handed_off or self.released:
            raise RuntimeError("record resource hold has already been used")
        self.handed_off = True

    def release(self) -> None:
        if self.released:
            return
        self.released = True
        self.finalizer()


@dataclass
class RecordPacket:
    """Resident transport packet whose attachments remain live until ACK."""

    sequence: int
    name: str
    value: dict[str, Any]
    attachments: list[DataChannelAttachment]
    byte_length: int
    ack: asyncio.Future[None]
    ack_watchdog: asyncio.Task[None] | None = None
    resource_hold: RecordResourceHold | None = None

    def release_resources(self) -> None:
        self.attachments.clear()
        if self.resource_hold is not None:
            self.resource_hold.release()
