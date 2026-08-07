from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from sdk.protocol.messages import DataChannelMessage


@dataclass(frozen=True)
class SlaveContext:
    session_id: str
    ttl_seconds: int
    call_id: str | None = None
    _event_sender: Callable[[str, Any], Awaitable[None]] | None = field(default=None, repr=False, compare=False)

    async def emit_event(self, event_type: str, payload: Any = None) -> None:
        if self._event_sender is None:
            return
        await self._event_sender(event_type, payload)


@dataclass(frozen=True)
class MessageHandler:
    message_type: str
    handle: Callable[
        [DataChannelMessage, Any, SlaveContext],
        DataChannelMessage | Awaitable[DataChannelMessage | None] | None,
    ]


class SlaveApp:
    def __init__(self, memory: Any = None) -> None:
        self.memory = memory
        self.handlers: list[MessageHandler] = []
        self.initializer: Callable[[Any, SlaveContext], Awaitable[None] | None] | None = None

    def initialize(self, func: Callable[[Any, SlaveContext], Awaitable[None] | None]) -> Callable[[Any, SlaveContext], Awaitable[None] | None]:
        self.initializer = func
        return func

    def handler(
        self,
        message_type: str,
    ) -> Callable[
        [
            Callable[
                [DataChannelMessage, Any, SlaveContext],
                DataChannelMessage | Awaitable[DataChannelMessage | None] | None,
            ]
        ],
        Callable[
            [DataChannelMessage, Any, SlaveContext],
            DataChannelMessage | Awaitable[DataChannelMessage | None] | None,
        ],
    ]:
        def decorator(
            func: Callable[
                [DataChannelMessage, Any, SlaveContext],
                DataChannelMessage | Awaitable[DataChannelMessage | None] | None,
            ],
        ) -> Callable[
            [DataChannelMessage, Any, SlaveContext],
            DataChannelMessage | Awaitable[DataChannelMessage | None] | None,
        ]:
            self.handlers.append(MessageHandler(message_type=message_type, handle=func))
            return func

        return decorator

    async def run_initialize(self, context: SlaveContext) -> None:
        if self.initializer is None:
            return
        result = self.initializer(self.memory, context)
        if inspect.isawaitable(result):
            await result

    async def dispatch(self, message: DataChannelMessage, context: SlaveContext) -> DataChannelMessage | None:
        for handler in self.handlers:
            if handler.message_type != message.type:
                continue
            response = handler.handle(message, self.memory, context)
            if inspect.isawaitable(response):
                response = await response
            return response
        raise ValueError(f"unsupported data channel message: {message.type}")
