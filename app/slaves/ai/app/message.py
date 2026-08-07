from __future__ import annotations

from sdk.slave import DataChannelMessage


def reject_request_attachments(message: DataChannelMessage) -> None:
    if message.attachments:
        raise ValueError(f"{message.type} does not support request attachments")
