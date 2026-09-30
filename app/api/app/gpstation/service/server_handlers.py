"""Application handlers registered by the API composition root."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ServerHandler:
    implementation: Any
    event_context: Callable[..., Awaitable[dict]] | None = None
    on_finished: Callable[..., Awaitable[None]] | None = None

    def __getattr__(self, name: str) -> Any:
        return getattr(self.implementation, name)

# A handler module owns stage_record(db, job, packet, attachments) and
# complete_job(db, job, packet). The GPStation transport owns neither its input
# schema nor its persistence projection.
server_handlers: dict[str, Any] = {}


def register_server_handler(
    name: str,
    implementation: Any,
    *,
    event_context: Callable[..., Awaitable[dict]] | None = None,
    on_finished: Callable[..., Awaitable[None]] | None = None,
) -> None:
    """Register packet handling and optional callbacks in the caller's transaction."""
    server_handlers[name] = ServerHandler(implementation, event_context, on_finished)
