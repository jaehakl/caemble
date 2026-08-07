from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace
from typing import Any

from .types import ConnectDiagnosticEvent


DiagnosticCallback = Callable[[ConnectDiagnosticEvent], None]


def emit_diagnostic(
    peer_connection: Any,
    data_channel: Any,
    callback: DiagnosticCallback | None,
    event: ConnectDiagnosticEvent,
) -> None:
    if callback is None:
        return
    callback(
        replace(
            event,
            signaling_state=getattr(peer_connection, "signalingState", None),
            ice_gathering_state=getattr(peer_connection, "iceGatheringState", None),
            ice_connection_state=getattr(peer_connection, "iceConnectionState", None),
            connection_state=getattr(peer_connection, "connectionState", None),
            data_channel_state=getattr(data_channel, "readyState", None),
        )
    )


def register_connection_diagnostics(
    peer_connection: Any,
    data_channel: Any,
    callback: DiagnosticCallback | None,
) -> None:
    if callback is None:
        return

    @peer_connection.on("signalingstatechange")
    def on_signaling_state_change() -> None:
        emit_diagnostic(
            peer_connection,
            data_channel,
            callback,
            ConnectDiagnosticEvent(
                stage="signaling-state",
                message=f"signaling state: {peer_connection.signalingState}",
            ),
        )

    @peer_connection.on("icegatheringstatechange")
    def on_ice_gathering_state_change() -> None:
        emit_diagnostic(
            peer_connection,
            data_channel,
            callback,
            ConnectDiagnosticEvent(
                stage="ice-gathering-state",
                message=f"ICE gathering state: {peer_connection.iceGatheringState}",
            ),
        )

    @peer_connection.on("iceconnectionstatechange")
    def on_ice_connection_state_change() -> None:
        emit_diagnostic(
            peer_connection,
            data_channel,
            callback,
            ConnectDiagnosticEvent(
                stage="ice-connection-state",
                message=f"ICE connection state: {peer_connection.iceConnectionState}",
            ),
        )

    @peer_connection.on("connectionstatechange")
    def on_connection_state_change() -> None:
        emit_diagnostic(
            peer_connection,
            data_channel,
            callback,
            ConnectDiagnosticEvent(
                stage="connection-state",
                message=f"peer connection state: {peer_connection.connectionState}",
            ),
        )

    @data_channel.on("open")
    def on_data_channel_open() -> None:
        emit_diagnostic(
            peer_connection,
            data_channel,
            callback,
            ConnectDiagnosticEvent(stage="data-channel-state", message="data channel state: open"),
        )

    @data_channel.on("close")
    def on_data_channel_close() -> None:
        emit_diagnostic(
            peer_connection,
            data_channel,
            callback,
            ConnectDiagnosticEvent(stage="data-channel-state", message="data channel state: closed"),
        )

    @data_channel.on("error")
    def on_data_channel_error(*_: object) -> None:
        emit_diagnostic(
            peer_connection,
            data_channel,
            callback,
            ConnectDiagnosticEvent(stage="data-channel-state", message="data channel state: error"),
        )


def register_prepared_connection_diagnostics(
    prepared: Any,
    callback: DiagnosticCallback | None,
) -> None:
    if prepared.diagnostics_registered:
        return
    register_connection_diagnostics(prepared.peer_connection, prepared.data_channel, callback)
    prepared.diagnostics_registered = True
