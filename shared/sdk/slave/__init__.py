from sdk.protocol.messages import DataChannelAttachment, DataChannelMessage

from sdk.slave.app import MessageHandler, SlaveApp, SlaveContext

__all__ = ["DataChannelAttachment", "DataChannelMessage", "MessageHandler", "SlaveApp", "SlaveContext", "run_app"]


def __getattr__(name: str):
    if name == "run_app":
        from sdk.slave.runtime import run_app
        return run_app
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
