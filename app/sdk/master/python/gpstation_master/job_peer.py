from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Generic, TypeVar

from .binary import decode_binary_frame, encode_binary_frame
from .constants import (
    ATTACHMENT_CHUNK_SIZE,
    BUFFERED_AMOUNT_DRAIN_TIMEOUT_SECONDS,
    BUFFERED_AMOUNT_LOW_THRESHOLD,
    MAX_BUFFERED_AMOUNT,
    REQUEST_ATTACHMENT_MAX_BYTES,
    RESULT_ACK_BUFFER_TIMEOUT_SECONDS,
)
from .diagnostics import DiagnosticCallback, emit_diagnostic
from .errors import GpStationError, GpStationProtocolError
from .rtc import close_peer_connection
from .types import (
    AttachmentMetadata,
    CallResult,
    ConnectDiagnosticEvent,
    JobEvent,
    ReceivedFile,
    RequestAttachment,
)


TResult = TypeVar("TResult")
EventCallback = Callable[[JobEvent], None]


@dataclass(slots=True)
class _PendingCall(Generic[TResult]):
    id: str
    future: asyncio.Future[CallResult[TResult]]
    on_event: EventCallback | None


@dataclass(slots=True)
class _IncomingFile:
    metadata: AttachmentMetadata
    chunks: list[bytes] = field(default_factory=list)
    received_size: int = 0
    next_index: int = 0
    complete: bool = False


@dataclass(slots=True)
class _PendingResponse:
    id: str
    payload: Any
    attachments: list[AttachmentMetadata]
    files: dict[str, _IncomingFile]


class GpStationJobPeer:
    def __init__(
        self,
        peer_connection: Any,
        data_channel: Any,
        diagnostic: DiagnosticCallback | None = None,
    ) -> None:
        self._peer_connection = peer_connection
        self._data_channel = data_channel
        self._diagnostic = diagnostic
        self._pending_call: _PendingCall[Any] | None = None
        self._response: _PendingResponse | None = None
        self._finish_future: asyncio.Future[None] | None = None
        self._finish_sent = False
        self._is_closed = False
        self._close_lock = asyncio.Lock()
        self._messages: asyncio.Queue[str | bytes] = asyncio.Queue()
        self._message_task = asyncio.create_task(self._consume_messages())

        @data_channel.on("message")
        def on_message(raw_message: Any) -> None:
            if isinstance(raw_message, str):
                self._messages.put_nowait(raw_message)
            elif isinstance(raw_message, (bytes, bytearray, memoryview)):
                self._messages.put_nowait(bytes(raw_message))
            else:
                self._reject_pending_call(
                    GpStationProtocolError(f"unsupported data channel message type: {type(raw_message).__name__}")
                )

        @data_channel.on("close")
        def on_close() -> None:
            self._reject_open_work(GpStationError("data channel closed"))

        @data_channel.on("error")
        def on_error(error: Exception | None = None) -> None:
            self._reject_open_work(GpStationError(f"data channel error{f': {error}' if error else ''}"))

    @property
    def closed(self) -> bool:
        return (
            self._is_closed
            or getattr(self._peer_connection, "signalingState", "closed") == "closed"
            or getattr(self._data_channel, "readyState", "closed") == "closed"
        )

    async def wait_until_open(self, timeout_seconds: float) -> None:
        try:
            async with asyncio.timeout(timeout_seconds):
                while self._data_channel.readyState != "open":
                    if self.closed:
                        raise GpStationError(
                            f"data channel closed before opening ({self._connection_state_summary()})"
                        )
                    await asyncio.sleep(0.01)
        except TimeoutError as exc:
            raise TimeoutError(
                f"data channel open timeout ({self._connection_state_summary()})"
            ) from exc

    def send_ready(self, job_id: str) -> None:
        self._ensure_open("send job ready")
        self._data_channel.send(self._encode_control({"kind": "job.ready", "id": job_id}))
        emit_diagnostic(
            self._peer_connection,
            self._data_channel,
            self._diagnostic,
            ConnectDiagnosticEvent(stage="job-ready", message="sent job ready"),
        )

    async def call(
        self,
        call_id: str,
        handler_type: str,
        payload: Any,
        timeout_seconds: float,
        on_event: EventCallback | None = None,
        attachments: Sequence[RequestAttachment] = (),
    ) -> CallResult[Any]:
        self._ensure_open("send job call")
        if self._pending_call is not None:
            raise GpStationError(f"job call already in progress: {self._pending_call.id}")
        self._validate_request_attachments(attachments)
        future: asyncio.Future[CallResult[Any]] = asyncio.get_running_loop().create_future()
        self._pending_call = _PendingCall(id=call_id, future=future, on_event=on_event)
        self._response = None
        try:
            await self._send_job_call(call_id, handler_type, payload, attachments)
        except asyncio.CancelledError:
            self._clear_pending_call()
            future.cancel()
            await self.close()
            raise
        except Exception:
            self._clear_pending_call()
            future.cancel()
            raise
        try:
            async with asyncio.timeout(timeout_seconds):
                return await asyncio.shield(future)
        except asyncio.CancelledError:
            if self._pending_call is not None and self._pending_call.id == call_id:
                self._clear_pending_call()
                future.cancel()
            await self.close()
            raise
        except TimeoutError as exc:
            if self._pending_call is not None and self._pending_call.id == call_id:
                self._clear_pending_call()
                future.cancel()
            raise TimeoutError(f"job result timeout: {call_id}") from exc

    async def finish(self, job_id: str, timeout_seconds: float) -> None:
        self._ensure_open("finish job")
        if self._pending_call is not None:
            raise GpStationError(f"cannot finish while job call is in progress: {self._pending_call.id}")
        if self._finish_future is not None:
            raise GpStationError("job finish already in progress")
        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._finish_future = future
        try:
            self._data_channel.send(self._encode_control({"kind": "job.finish", "id": job_id}))
            self._finish_sent = True
        except Exception:
            self._clear_finish()
            raise
        emit_diagnostic(
            self._peer_connection,
            self._data_channel,
            self._diagnostic,
            ConnectDiagnosticEvent(stage="job-finish", message="sent job finish"),
        )
        try:
            async with asyncio.timeout(timeout_seconds):
                await asyncio.shield(future)
        except asyncio.CancelledError:
            if self._finish_future is future:
                self._clear_finish()
                future.cancel()
            await self.close()
            raise
        except TimeoutError as exc:
            if self._finish_future is future:
                self._clear_finish()
                future.cancel()
            raise TimeoutError(f"job finish timeout: {job_id}") from exc
        await self.close()

    async def close(self) -> None:
        async with self._close_lock:
            if self._is_closed:
                return
            self._is_closed = True
            self._reject_pending_call(GpStationError("job session closed"))
            self._reject_finish(GpStationError("job session closed"))
            if self._message_task is not asyncio.current_task():
                self._message_task.cancel()
                await asyncio.gather(self._message_task, return_exceptions=True)
            await close_peer_connection(self._peer_connection, self._data_channel)

    async def _send_job_call(
        self,
        call_id: str,
        handler_type: str,
        payload: Any,
        attachments: Sequence[RequestAttachment],
    ) -> None:
        frame: dict[str, Any] = {
            "kind": "job.call",
            "id": call_id,
            "type": handler_type,
            "payload": payload,
        }
        if attachments:
            metadata: list[dict[str, Any]] = []
            for attachment in attachments:
                item: dict[str, Any] = {"id": attachment.id, "size": len(attachment.data)}
                if attachment.name is not None:
                    item["name"] = attachment.name
                if attachment.mime_type is not None:
                    item["mimeType"] = attachment.mime_type
                metadata.append(item)
            frame["attachments"] = metadata
        self._data_channel.send(self._encode_control(frame))
        for attachment in attachments:
            await self._send_request_attachment(call_id, attachment)
        emit_diagnostic(
            self._peer_connection,
            self._data_channel,
            self._diagnostic,
            ConnectDiagnosticEvent(stage="job-call", message=f"sent job call: {handler_type}"),
        )

    async def _send_request_attachment(self, call_id: str, attachment: RequestAttachment) -> None:
        data = bytes(attachment.data)
        if not data:
            self._data_channel.send(
                encode_binary_frame(
                    {
                        "kind": "attachment.chunk",
                        "callId": call_id,
                        "attachmentId": attachment.id,
                        "index": 0,
                        "final": True,
                    },
                    b"",
                )
            )
            return
        for index, offset in enumerate(range(0, len(data), ATTACHMENT_CHUNK_SIZE)):
            end = min(offset + ATTACHMENT_CHUNK_SIZE, len(data))
            self._ensure_open("send job attachment")
            self._data_channel.send(
                encode_binary_frame(
                    {
                        "kind": "attachment.chunk",
                        "callId": call_id,
                        "attachmentId": attachment.id,
                        "index": index,
                        "final": end == len(data),
                    },
                    data[offset:end],
                )
            )
            if self._data_channel.bufferedAmount > MAX_BUFFERED_AMOUNT:
                await self._wait_for_send_buffer()

    async def _wait_for_send_buffer(self) -> None:
        self._data_channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD
        try:
            async with asyncio.timeout(BUFFERED_AMOUNT_DRAIN_TIMEOUT_SECONDS):
                while self._data_channel.bufferedAmount > BUFFERED_AMOUNT_LOW_THRESHOLD:
                    self._ensure_open("send job attachment")
                    await asyncio.sleep(0.01)
        except TimeoutError as exc:
            raise TimeoutError("data channel buffer did not drain while sending attachment") from exc

    async def _consume_messages(self) -> None:
        try:
            while True:
                raw_message = await self._messages.get()
                try:
                    if isinstance(raw_message, str):
                        message = json.loads(raw_message)
                        if not isinstance(message, dict):
                            raise GpStationProtocolError("job control frame must be an object")
                        await self._handle_control_message(message)
                    else:
                        await self._handle_binary_message(raw_message)
                except Exception as exc:
                    error = exc if isinstance(exc, Exception) else GpStationError(str(exc))
                    self._reject_pending_call(error)
        except asyncio.CancelledError:
            return

    async def _handle_control_message(self, message: dict[str, Any]) -> None:
        kind = message.get("kind")
        if kind == "job.error":
            detail = message.get("detail") if isinstance(message.get("detail"), str) else "job error"
            error = GpStationError(detail)
            if isinstance(message.get("id"), str) and self._pending_call and self._pending_call.id == message["id"]:
                self._reject_pending_call(error)
            else:
                self._reject_open_work(error)
            return
        if kind == "job.event":
            if self._pending_call is not None and self._pending_call.on_event is not None:
                self._pending_call.on_event(
                    JobEvent(
                        id=message.get("id") if isinstance(message.get("id"), str) else None,
                        type=message.get("type") if isinstance(message.get("type"), str) else None,
                        payload=message.get("payload"),
                    )
                )
            return
        if kind == "job.finished":
            self._resolve_finish()
            return
        if kind != "job.result":
            return
        call_id = message.get("id")
        if not isinstance(call_id, str) or self._pending_call is None or self._pending_call.id != call_id:
            raise GpStationProtocolError(f"unexpected job result: {call_id or 'missing id'}")
        raw_attachments = message.get("attachments") or []
        if not isinstance(raw_attachments, list):
            raise GpStationProtocolError("job result attachments must be a list")
        attachments: list[AttachmentMetadata] = []
        files: dict[str, _IncomingFile] = {}
        for raw_attachment in raw_attachments:
            metadata = self._parse_attachment_metadata(raw_attachment)
            if metadata.id in files:
                raise GpStationProtocolError(f"duplicate result attachment id: {metadata.id}")
            attachments.append(metadata)
            files[metadata.id] = _IncomingFile(metadata=metadata)
        emit_diagnostic(
            self._peer_connection,
            self._data_channel,
            self._diagnostic,
            ConnectDiagnosticEvent(stage="job-result", message="received job result"),
        )
        self._response = _PendingResponse(
            id=call_id,
            payload=message.get("payload"),
            attachments=attachments,
            files=files,
        )
        if not files:
            await self._resolve_pending_call()

    async def _handle_binary_message(self, frame: bytes) -> None:
        header, body = decode_binary_frame(frame)
        if header.get("kind") != "attachment.chunk" or self._response is None:
            return
        call_id = header.get("callId")
        if not isinstance(call_id, str) or self._pending_call is None or self._pending_call.id != call_id:
            raise GpStationProtocolError(f"unexpected attachment chunk call id: {call_id}")
        attachment_id = header.get("attachmentId")
        if not isinstance(attachment_id, str) or attachment_id not in self._response.files:
            raise GpStationProtocolError(f"unknown attachment chunk: {attachment_id}")
        incoming_file = self._response.files[attachment_id]
        index = header.get("index")
        if isinstance(index, bool) or not isinstance(index, int) or index != incoming_file.next_index:
            raise GpStationProtocolError(f"out-of-order attachment chunk: {attachment_id}")
        final = header.get("final")
        if not isinstance(final, bool):
            raise GpStationProtocolError(f"attachment final flag is invalid: {attachment_id}")
        if incoming_file.complete:
            raise GpStationProtocolError(f"attachment already complete: {attachment_id}")
        next_size = incoming_file.received_size + len(body)
        if next_size > incoming_file.metadata.size:
            raise GpStationProtocolError(f"attachment exceeds declared size: {attachment_id}")
        incoming_file.chunks.append(body)
        incoming_file.received_size = next_size
        incoming_file.next_index += 1
        incoming_file.complete = final
        if final and next_size != incoming_file.metadata.size:
            raise GpStationProtocolError(f"attachment size mismatch: {attachment_id}")
        if all(item.complete for item in self._response.files.values()):
            await self._resolve_pending_call()

    async def _resolve_pending_call(self) -> None:
        if self._pending_call is None or self._response is None:
            return
        pending = self._pending_call
        response = self._response
        await self._acknowledge_result(pending.id)
        files = [
            ReceivedFile(
                id=metadata.id,
                name=metadata.name,
                mime_type=metadata.mime_type,
                size=metadata.size,
                data=b"".join(response.files[metadata.id].chunks),
            )
            for metadata in response.attachments
        ]
        self._clear_pending_call()
        if not pending.future.done():
            pending.future.set_result(CallResult(payload=response.payload, files=files))

    async def _acknowledge_result(self, call_id: str) -> None:
        self._ensure_open("acknowledge job result")
        self._data_channel.send(self._encode_control({"kind": "job.result.ack", "id": call_id}))
        self._data_channel.bufferedAmountLowThreshold = 0
        try:
            async with asyncio.timeout(RESULT_ACK_BUFFER_TIMEOUT_SECONDS):
                while self._data_channel.bufferedAmount > 0:
                    self._ensure_open("acknowledge job result")
                    await asyncio.sleep(0.01)
        except TimeoutError as exc:
            raise TimeoutError("job result ack buffered amount timeout") from exc
        emit_diagnostic(
            self._peer_connection,
            self._data_channel,
            self._diagnostic,
            ConnectDiagnosticEvent(stage="job-result-ack", message="sent job result ack"),
        )

    def _resolve_finish(self, message: str = "received job finished") -> None:
        if self._finish_future is None:
            return
        future = self._finish_future
        self._clear_finish()
        emit_diagnostic(
            self._peer_connection,
            self._data_channel,
            self._diagnostic,
            ConnectDiagnosticEvent(stage="job-finished", message=message),
        )
        if not future.done():
            future.set_result(None)

    def _reject_open_work(self, error: Exception) -> None:
        self._reject_pending_call(error)
        if self._finish_future is not None and self._finish_sent:
            self._resolve_finish("job finish completed after data channel closed")
        else:
            self._reject_finish(error)

    def _reject_pending_call(self, error: Exception) -> None:
        if self._pending_call is None:
            return
        future = self._pending_call.future
        self._clear_pending_call()
        if not future.done():
            future.set_exception(error)

    def _reject_finish(self, error: Exception) -> None:
        if self._finish_future is None:
            return
        future = self._finish_future
        self._clear_finish()
        if not future.done():
            future.set_exception(error)

    def _clear_pending_call(self) -> None:
        self._pending_call = None
        self._response = None

    def _clear_finish(self) -> None:
        self._finish_future = None
        self._finish_sent = False

    def _ensure_open(self, action: str) -> None:
        if self.closed or self._data_channel.readyState != "open":
            raise GpStationError(f"cannot {action}; data channel is {self._data_channel.readyState}")

    def _connection_state_summary(self) -> str:
        return ", ".join(
            [
                f"signaling={getattr(self._peer_connection, 'signalingState', 'unknown')}",
                f"iceGathering={getattr(self._peer_connection, 'iceGatheringState', 'unknown')}",
                f"iceConnection={getattr(self._peer_connection, 'iceConnectionState', 'unknown')}",
                f"connection={getattr(self._peer_connection, 'connectionState', 'unknown')}",
                f"dataChannel={getattr(self._data_channel, 'readyState', 'unknown')}",
            ]
        )

    @staticmethod
    def _validate_request_attachments(attachments: Sequence[RequestAttachment]) -> None:
        ids: set[str] = set()
        for attachment in attachments:
            if not attachment.id:
                raise ValueError("request attachment id is required")
            if attachment.id in ids:
                raise ValueError(f"duplicate request attachment id: {attachment.id}")
            if not isinstance(attachment.data, (bytes, bytearray, memoryview)):
                raise TypeError(f"request attachment data must be bytes: {attachment.id}")
            if len(attachment.data) > REQUEST_ATTACHMENT_MAX_BYTES:
                raise ValueError(
                    f"request attachment exceeds {REQUEST_ATTACHMENT_MAX_BYTES} bytes: {attachment.id}"
                )
            ids.add(attachment.id)

    @staticmethod
    def _parse_attachment_metadata(value: Any) -> AttachmentMetadata:
        if not isinstance(value, dict):
            raise GpStationProtocolError("result attachment metadata must be an object")
        attachment_id = value.get("id")
        size = value.get("size")
        name = value.get("name")
        mime_type = value.get("mimeType")
        if not isinstance(attachment_id, str) or not attachment_id:
            raise GpStationProtocolError("result attachment id is required")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise GpStationProtocolError(f"result attachment size is invalid: {attachment_id}")
        if name is not None and not isinstance(name, str):
            raise GpStationProtocolError(f"result attachment name is invalid: {attachment_id}")
        if mime_type is not None and not isinstance(mime_type, str):
            raise GpStationProtocolError(f"result attachment mimeType is invalid: {attachment_id}")
        return AttachmentMetadata(id=attachment_id, name=name, mime_type=mime_type, size=size)

    @staticmethod
    def _encode_control(value: dict[str, Any]) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
