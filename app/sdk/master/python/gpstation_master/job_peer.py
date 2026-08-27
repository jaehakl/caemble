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
    BUFFERED_AMOUNT_HIGH_WATER_MARK,
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
JOB_RESULT_PAYLOAD_ATTACHMENTS = "gpstation.job-result.payload-attachments"


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
        self._finish_job_id: str | None = None
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
        self._finish_job_id = job_id
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
            if self._data_channel.bufferedAmount > BUFFERED_AMOUNT_HIGH_WATER_MARK:
                await self._wait_for_send_buffer()

    async def _wait_for_send_buffer(
        self,
        threshold: int = BUFFERED_AMOUNT_LOW_THRESHOLD,
        phase: str = "while sending attachment",
    ) -> None:
        self._data_channel.bufferedAmountLowThreshold = threshold
        try:
            async with asyncio.timeout(BUFFERED_AMOUNT_DRAIN_TIMEOUT_SECONDS):
                while self._data_channel.bufferedAmount > threshold:
                    self._ensure_open(phase)
                    await asyncio.sleep(0.01)
        except TimeoutError as exc:
            raise TimeoutError(f"data channel buffer did not drain {phase}") from exc

    async def _consume_messages(self) -> None:
        try:
            while True:
                raw_message = await self._messages.get()
                try:
                    if isinstance(raw_message, str):
                        message = json.loads(raw_message)
                        await self._handle_control_message(
                            message, len(raw_message.encode("utf-8"))
                        )
                    else:
                        await self._handle_binary_message(raw_message)
                except Exception as exc:
                    error = exc if isinstance(exc, Exception) else GpStationError(str(exc))
                    self._reject_pending_call(error)
        except asyncio.CancelledError:
            return

    async def _handle_control_message(
        self,
        message: dict[str, Any],
        control_bytes: int | None = None,
    ) -> None:
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
            job_id = message.get("id") if isinstance(message.get("id"), str) else self._finish_job_id
            if job_id is None:
                self._resolve_finish()
                return
            try:
                self._ensure_open("acknowledge job finish")
                self._data_channel.send(self._encode_control({"kind": "job.finished.ack", "id": job_id}))
                await self._wait_for_send_buffer(0, "after job finished ack")
                emit_diagnostic(
                    self._peer_connection,
                    self._data_channel,
                    self._diagnostic,
                    ConnectDiagnosticEvent(stage="job-finished-ack", message="sent job finished ack"),
                )
                self._resolve_finish("received and acknowledged job finished")
            except Exception:
                self._resolve_finish("received job finished before acknowledgement completed")
            return
        if kind != "job.result":
            return
        call_id = message.get("id")
        if self._pending_call is None or self._pending_call.id != call_id:
            raise GpStationProtocolError(f"unexpected job result: {call_id or 'missing id'}")
        raw_attachments = message.get("attachments") or []
        attachments: list[AttachmentMetadata] = []
        files: dict[str, _IncomingFile] = {}
        for raw_attachment in raw_attachments:
            metadata = self._parse_attachment_metadata(raw_attachment)
            if metadata.id in files:
                raise GpStationProtocolError(
                    f"duplicate job result attachment id: {metadata.id}"
                )
            attachments.append(metadata)
            files[metadata.id] = _IncomingFile(metadata=metadata)
        payload_attachment_ids = set(
            self._result_payload_attachment_ids(message.get("payload"), validate=False)
        )
        user_attachments = [
            attachment
            for attachment in attachments
            if attachment.id not in payload_attachment_ids
        ]
        emit_diagnostic(
            self._peer_connection,
            self._data_channel,
            self._diagnostic,
            ConnectDiagnosticEvent(
                stage="job-result",
                message="received job result",
                call_id=call_id,
                attachment_count=len(user_attachments),
                attachment_bytes=sum(attachment.size for attachment in user_attachments),
                control_bytes=control_bytes,
                payload_attachment_bytes=sum(
                    attachment.size
                    for attachment in attachments
                    if attachment.id in payload_attachment_ids
                ),
            ),
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
        if self._pending_call is None or self._pending_call.id != call_id:
            raise GpStationProtocolError(f"unexpected attachment chunk call id: {call_id}")
        attachment_id = header.get("attachmentId")
        if not isinstance(attachment_id, str) or attachment_id not in self._response.files:
            raise GpStationProtocolError(
                f"unknown job result attachment id: {attachment_id}"
            )
        incoming_file = self._response.files[attachment_id]
        if incoming_file.complete:
            raise GpStationProtocolError(
                f"attachment chunk received after final chunk: {attachment_id}"
            )
        index = header.get("index")
        if not isinstance(index, int) or isinstance(index, bool) or index != incoming_file.next_index:
            raise GpStationProtocolError(
                f"unexpected attachment chunk index for {attachment_id}: "
                f"{index}; expected {incoming_file.next_index}"
            )
        final = header.get("final")
        if not isinstance(final, bool):
            raise GpStationProtocolError(f"invalid attachment final flag: {attachment_id}")
        received_size = incoming_file.received_size + len(body)
        if received_size > incoming_file.metadata.size or (
            final and received_size != incoming_file.metadata.size
        ):
            raise GpStationProtocolError(
                f"attachment size mismatch for {attachment_id}: "
                f"received {received_size}; expected {incoming_file.metadata.size}"
            )
        if not final and received_size == incoming_file.metadata.size:
            raise GpStationProtocolError(f"attachment final chunk missing for {attachment_id}")
        incoming_file.chunks.append(body)
        incoming_file.received_size = received_size
        incoming_file.next_index += 1
        incoming_file.complete = final
        if all(item.complete for item in self._response.files.values()):
            await self._resolve_pending_call()

    async def _resolve_pending_call(self) -> None:
        if self._pending_call is None or self._response is None:
            return
        pending = self._pending_call
        response = self._response
        payload_attachment_ids = set(
            self._result_payload_attachment_ids(response.payload, validate=True)
        )
        payload = response.payload
        if payload_attachment_ids:
            storage = response.payload["storage"]
            raw_payload = b"".join(
                chunk
                for attachment_id in storage["ids"]
                for chunk in response.files[attachment_id].chunks
            )
            if len(raw_payload) != storage["byteLength"]:
                raise GpStationProtocolError(
                    f"job result payload size mismatch: received {len(raw_payload)}; "
                    f"expected {storage['byteLength']}"
                )
            try:
                payload = json.loads(raw_payload.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise GpStationProtocolError("invalid job result payload attachment JSON") from exc
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
            if metadata.id not in payload_attachment_ids
        ]
        self._clear_pending_call()
        if not pending.future.done():
            pending.future.set_result(CallResult(payload=payload, files=files))

    def _result_payload_attachment_ids(
        self,
        payload: Any,
        *,
        validate: bool,
    ) -> list[str]:
        if not isinstance(payload, dict) or payload.get("kind") != JOB_RESULT_PAYLOAD_ATTACHMENTS:
            return []
        storage = payload.get("storage")
        valid = (
            isinstance(storage, dict)
            and storage.get("kind") == "attachments"
            and isinstance(storage.get("ids"), list)
            and bool(storage["ids"])
            and all(isinstance(item, str) for item in storage["ids"])
            and isinstance(storage.get("byteLength"), int)
            and not isinstance(storage.get("byteLength"), bool)
            and storage["byteLength"] >= 0
        )
        if not valid:
            if validate:
                raise GpStationProtocolError("invalid job result payload attachment storage")
            return []
        ids = storage["ids"]
        if validate and len(set(ids)) != len(ids):
            raise GpStationProtocolError("duplicate job result payload attachment id")
        if validate:
            for attachment_id in ids:
                if self._response is None or attachment_id not in self._response.files:
                    raise GpStationProtocolError(
                        f"missing job result payload attachment: {attachment_id}"
                    )
        return ids

    async def _acknowledge_result(self, call_id: str) -> None:
        self._ensure_open("acknowledge job result")
        self._data_channel.send(self._encode_control({"kind": "job.result.ack", "id": call_id}))
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
        self._finish_job_id = None
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
    def _parse_attachment_metadata(value: Any) -> AttachmentMetadata:
        if not isinstance(value, dict):
            raise GpStationProtocolError("invalid job result attachment metadata")
        attachment_id = value.get("id")
        size = value.get("size")
        if (
            not isinstance(attachment_id, str)
            or not isinstance(size, int)
            or isinstance(size, bool)
            or size < 0
        ):
            raise GpStationProtocolError("invalid job result attachment metadata")
        return AttachmentMetadata(
            id=attachment_id,
            name=value.get("name"),
            mime_type=value.get("mimeType"),
            size=size,
        )

    @staticmethod
    def _encode_control(value: dict[str, Any]) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
