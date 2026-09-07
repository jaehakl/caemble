"""Resident slave runtime for jobs whose master is the GPStation server."""
from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from sdk.protocol.packets import Attachment, receive_packet, send_packet
from sdk.slave.io import emit, log, parse_args, read_stdin_line

INPUT_IDLE_TIMEOUT_SECONDS = 60


class ServerJobCancelled(Exception):
    """The server explicitly stopped this attempt."""


class ServerJobContext:
    def __init__(self, websocket: Any, job_id: str, attempt_count: int) -> None:
        self.websocket = websocket
        self.job_id = job_id
        self.attempt_count = attempt_count
        self.send_lock = asyncio.Lock()
        self.incoming: asyncio.Queue[tuple[dict[str, Any], list[Attachment]]] = asyncio.Queue(maxsize=1)
        self.incoming_changed = asyncio.Event()
        self.receive_error: Exception | None = None

    async def send(self, payload: dict[str, Any], attachments: Sequence[Attachment] = ()) -> None:
        async with self.send_lock:
            await send_packet(self.websocket.send, self.websocket.send, payload, attachments)

    async def receive(self) -> tuple[dict[str, Any], list[Attachment]]:
        while self.incoming.empty():
            if self.receive_error is not None:
                raise self.receive_error
            await self.incoming_changed.wait()
            self.incoming_changed.clear()
        return self.incoming.get_nowait()

    async def read_messages(self) -> None:
        try:
            while True:
                message = await receive_packet(self.websocket.recv)
                if message[0].get("type") == "job.cancel":
                    raise ServerJobCancelled(message[0].get("reason") or "cancelled by server")
                self.incoming.put_nowait(message)
                self.incoming_changed.set()
        except Exception as error:
            self.receive_error = error
            self.incoming_changed.set()

    async def heartbeats(self) -> None:
        while True:
            await asyncio.sleep(5)
            await self.send({"type": "job.progress", "progress": {"kind": "heartbeat"}})


class ServerSlaveApp:
    def __init__(
        self,
        handler: Callable[[dict[str, Any], list[Attachment], ServerJobContext], Awaitable[dict[str, Any]]],
    ) -> None:
        self.handler = handler


async def stop_execution(task: asyncio.Task[Any]) -> None:
    if not task.done() and not task.cancelling():
        task.cancel()
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            continue
        except Exception:
            break
    if not task.cancelled():
        task.exception()


async def run_server_job(app: ServerSlaveApp, assignment: dict[str, Any]) -> None:
    import websockets

    job_id = str(assignment["job_id"])
    attempt_count = int(assignment["attempt_count"])
    context: ServerJobContext | None = None
    reader: asyncio.Task[None] | None = None
    execution: asyncio.Task[dict[str, Any]] | None = None
    heartbeat: asyncio.Task[None] | None = None
    try:
        headers = {"Authorization": f"Bearer {assignment['token']}"}
        # This import is deliberately local; the WebRTC runtime keeps its own dependencies.
        connect = websockets.connect
        keyword = "additional_headers" if int(websockets.__version__.split(".")[0]) >= 14 else "extra_headers"
        async with connect(assignment["websocket_url"], **{keyword: headers}, max_size=None) as websocket:
            context = ServerJobContext(websocket, job_id, attempt_count)
            await context.send({"type": "job.ready", "job_id": job_id, "attempt_count": attempt_count})

            payload, attachments = await receive_packet(
                lambda: asyncio.wait_for(websocket.recv(), timeout=INPUT_IDLE_TIMEOUT_SECONDS)
            )
            if payload.get("type") != "job.input":
                raise ValueError("Expected job.input")
            reader = asyncio.create_task(context.read_messages())
            heartbeat = asyncio.create_task(context.heartbeats())
            execution = asyncio.create_task(app.handler(payload, attachments, context))
            try:
                done, _ = await asyncio.wait((execution, reader), return_when=asyncio.FIRST_COMPLETED)
                if reader in done:
                    await reader
                    if isinstance(context.receive_error, ServerJobCancelled):
                        raise asyncio.CancelledError(str(context.receive_error))
                    raise context.receive_error or ConnectionError("Server job connection closed")
                result = await execution
                heartbeat.cancel()
                await asyncio.gather(heartbeat, return_exceptions=True)
                await context.send({"type": "job.complete", **result})
                message, _ = await asyncio.wait_for(context.receive(), timeout=30)
                if message.get("type") != "job.complete.ack":
                    raise ValueError("Expected job.complete.ack")
            except BaseException as error:
                if execution is not None:
                    await stop_execution(execution)
                with contextlib.suppress(Exception):
                    await context.send(
                        {"type": "job.cancelled", "detail": "cancelled"}
                        if isinstance(error, asyncio.CancelledError)
                        else {"type": "job.failed", "code": str(vars(error).get("code", "job_error")), "detail": str(error)}
                    )
                    message, _ = await asyncio.wait_for(context.receive(), timeout=30)
                    if message.get("type") != "job.complete.ack":
                        raise ValueError("Expected terminal acknowledgement")
                raise
            finally:
                if heartbeat is not None:
                    heartbeat.cancel()
                    await asyncio.gather(heartbeat, return_exceptions=True)
                if reader is not None:
                    reader.cancel()
                    await asyncio.gather(reader, return_exceptions=True)
    except asyncio.CancelledError:
        log(f"server job cancelled: id={job_id} attempt={attempt_count}")
    except Exception as error:
        log(f"server job failed: id={job_id} attempt={attempt_count} error={error}")
        emit({"type": "job.error", "job_id": job_id, "attempt_count": attempt_count, "code": "job_error", "detail": str(error)})
    finally:
        if execution is not None:
            await stop_execution(execution)
        emit({"type": "job.cleaned", "job_id": job_id, "attempt_count": attempt_count})


async def run_server_worker(app: ServerSlaveApp) -> None:
    emit({"type": "worker.ready"})
    current: asyncio.Task[None] | None = None
    job_id: str | None = None
    line_task = asyncio.create_task(asyncio.to_thread(read_stdin_line))
    try:
        while True:
            waiting = (line_task, current) if current is not None else (line_task,)
            done, _ = await asyncio.wait(waiting, return_when=asyncio.FIRST_COMPLETED)
            if current is not None and current in done:
                await current
                current = None
                job_id = None
            if line_task not in done:
                continue
            line = line_task.result()
            if not line:
                break
            message = json.loads(line)
            if message.get("type") == "stop":
                break
            if message.get("type") == "job.cancel" and current is not None and message.get("job_id") == job_id:
                current.cancel()
                await current
                current = None
                job_id = None
            elif message.get("type") == "job.start":
                if current is not None:
                    raise RuntimeError("Server worker received a job while busy")
                if message.get("job_mode") != "websocket":
                    raise ValueError("Server worker requires websocket jobs")
                job_id = str(message["job_id"])
                current = asyncio.create_task(run_server_job(app, message))
            line_task = asyncio.create_task(asyncio.to_thread(read_stdin_line))
    finally:
        line_task.cancel()
        if current is not None:
            current.cancel()
            await current


def run_server_app(app: ServerSlaveApp) -> None:
    if not parse_args().worker:
        raise SystemExit("--worker is required")
    asyncio.run(run_server_worker(app))
