from __future__ import annotations

import asyncio
import copy
import dataclasses
import inspect
import multiprocessing
import threading
import time
from collections.abc import Mapping
from multiprocessing.connection import Connection
from multiprocessing.process import BaseProcess
from typing import Any, Awaitable, Callable, Generic, Protocol, TypeVar

from app.runtime_kernel.execution.child import child_main
from app.runtime_kernel.execution.errors import (
    RemoteSolverError,
    SolverExecutionCancelled,
    SolverExecutionStartupTimeout,
    SolverExecutionTimeout,
    SolverPayloadError,
    SolverProcessExitedError,
    SolverProtocolError,
)
from app.runtime_kernel.execution.messages import (
    ChildMessage,
    ChildMessageKind,
    RemoteError,
    SolverChildRequest,
)
from app.runtime_kernel.execution.serialization import PayloadCodec, PicklePayloadCodec
from sdk.slave.io import log

ProgressHandler = Callable[[Any], Awaitable[None] | None]
ResultT = TypeVar("ResultT")


class CancellationSignal(Protocol):
    def is_set(self) -> bool: ...


class _TransactionFinalizer:
    def __init__(
        self,
        commit: Callable[[], None] | None,
        rollback: Callable[[], None] | None,
    ) -> None:
        self.commit_callback = commit
        self.rollback_callback = rollback
        self.status = "provisional"
        self.lock = threading.Lock()

    def finish(self, target: str) -> bool:
        with self.lock:
            if self.status != "provisional":
                return False
            callback = self.commit_callback if target == "committed" else self.rollback_callback
            if callback is not None:
                callback()
            self.status = target
            return True


class SolverExecutionTransaction(Generic[ResultT]):
    """Provisional child result finalized after coordinator validation/commit."""

    def __init__(
        self,
        value: ResultT,
        *,
        commit: Callable[[], None] | None = None,
        rollback: Callable[[], None] | None = None,
        _finalizer: _TransactionFinalizer | None = None,
    ) -> None:
        self.value = value
        self._finalizer = _finalizer or _TransactionFinalizer(commit, rollback)

    @property
    def status(self) -> str:
        return self._finalizer.status

    @property
    def provisional(self) -> bool:
        return self.status == "provisional"

    def commit(self) -> bool:
        return self._finalizer.finish("committed")

    def rollback(self) -> bool:
        return self._finalizer.finish("rolled_back")

    def with_value(self, value: Any) -> SolverExecutionTransaction[Any]:
        return SolverExecutionTransaction(value, _finalizer=self._finalizer)

    def __enter__(self) -> SolverExecutionTransaction[ResultT]:
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        del exc_type, exc, traceback
        if self.provisional:
            self.rollback()

    async def __aenter__(self) -> SolverExecutionTransaction[ResultT]:
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        del exc_type, exc, traceback
        if self.provisional:
            self.rollback()


class SpawnSolverExecutor:
    """Runs one solver invocation in one fresh ``spawn`` child process."""

    CHILD_STARTUP_TIMEOUT_SECONDS = 30.0

    def __init__(
        self,
        *,
        codec: PayloadCodec | None = None,
        poll_interval: float = 0.01,
        cancellation_grace: float = 0.5,
        exit_grace: float = 1.0,
    ) -> None:
        if poll_interval <= 0:
            raise ValueError("poll_interval must be positive")
        if cancellation_grace < 0 or exit_grace < 0:
            raise ValueError("process grace periods cannot be negative")
        self._codec = codec or PicklePayloadCodec()
        self._poll_interval = poll_interval
        self._cancellation_grace = cancellation_grace
        self._exit_grace = exit_grace
        self._multiprocessing = multiprocessing.get_context("spawn")
        self._child_target = child_main
        self._late_cleanup_tasks: set[asyncio.Task[None]] = set()

    async def execute(
        self,
        locator: str,
        context: Any,
        *,
        progress: ProgressHandler | None = None,
        cancellation: CancellationSignal | None = None,
        timeout: float | None = None,
        abi_version: int | None = None,
    ) -> Any:
        transaction = await self.execute_transaction(
            locator,
            context,
            progress=progress,
            cancellation=cancellation,
            timeout=timeout,
            abi_version=abi_version,
        )
        try:
            transaction.commit()
        except BaseException as exc:
            try:
                transaction.rollback()
            except Exception as cleanup_error:
                exc.add_note(f"solver mmap rollback also failed: {cleanup_error}")
            raise
        return transaction.value

    async def execute_transaction(
        self,
        locator: str,
        context: Any,
        *,
        progress: ProgressHandler | None = None,
        cancellation: CancellationSignal | None = None,
        timeout: float | None = None,
        abi_version: int | None = None,
    ) -> SolverExecutionTransaction[Any]:
        if timeout is not None and timeout <= 0:
            raise ValueError("timeout must be positive")

        begin_invocation = getattr(self._codec, "begin_invocation", None)
        codec = begin_invocation() if callable(begin_invocation) else self._codec
        try:
            result = await self._execute(
                locator,
                context,
                codec,
                progress=progress,
                cancellation=cancellation,
                timeout=timeout,
                abi_version=abi_version,
            )
        except BaseException as exc:
            rollback = getattr(codec, "rollback", None)
            if callable(rollback):
                try:
                    rollback()
                except Exception as cleanup_error:
                    exc.add_note(f"solver mmap rollback also failed: {cleanup_error}")
            raise
        commit = getattr(codec, "commit", None)
        rollback = getattr(codec, "rollback", None)
        return SolverExecutionTransaction(
            result,
            commit=commit if callable(commit) else None,
            rollback=rollback if callable(rollback) else None,
        )

    async def _execute(
        self,
        locator: str,
        context: Any,
        codec: PayloadCodec,
        *,
        progress: ProgressHandler | None,
        cancellation: CancellationSignal | None,
        timeout: float | None,
        abi_version: int | None,
    ) -> Any:
        try:
            encoded_context = await asyncio.to_thread(
                codec.encode,
                _strip_runtime_services(context),
            )
        except Exception as exc:
            raise SolverPayloadError(
                f"could not serialize context for solver {locator}: {exc}"
            ) from exc

        request_receive, request_send = self._multiprocessing.Pipe(duplex=False)
        result_receive, result_send = self._multiprocessing.Pipe(duplex=False)
        cancellation_event = self._multiprocessing.Event()
        process = self._multiprocessing.Process(
            target=self._child_target,
            args=(request_receive, result_send, cancellation_event),
            name=f"caemble-solver:{locator}",
        )
        request = SolverChildRequest(locator, abi_version, encoded_context, codec)
        request_bytes = (
            len(encoded_context)
            if isinstance(encoded_context, (bytes, bytearray, memoryview))
            else -1
        )
        startup_started_at = time.monotonic()
        startup_deadline = (
            startup_started_at + self.CHILD_STARTUP_TIMEOUT_SECONDS
        )
        start_task = asyncio.create_task(
            asyncio.to_thread(_start_process, process)
        )
        request_send_task: asyncio.Task[None] | None = None
        process_started = False
        cleanup_deferred = False
        log(
            "solver child bootstrap begin "
            f"locator={locator} request_bytes={request_bytes}"
        )

        try:
            try:
                while not start_task.done():
                    if cancellation is not None and cancellation.is_set():
                        raise SolverExecutionCancelled(locator)
                    if time.monotonic() >= startup_deadline:
                        raise SolverExecutionStartupTimeout(
                            locator,
                            self.CHILD_STARTUP_TIMEOUT_SECONDS,
                        )
                    await asyncio.sleep(self._poll_interval)
                await start_task
                process_started = True
            except (asyncio.CancelledError, SolverExecutionStartupTimeout):
                cancellation_event.set()
                cleanup_deferred = True
                self._defer_late_start_cleanup(
                    locator,
                    start_task,
                    process,
                    (request_receive, request_send, result_receive, result_send),
                )
                raise
            except Exception as exc:
                raise SolverPayloadError(
                    f"could not start child process for solver {locator}: {exc}"
                ) from exc

            request_receive.close()
            result_send.close()
            child_pid = await self._await_bootstrap(
                locator,
                process,
                result_receive,
                cancellation,
                startup_deadline,
                startup_started_at,
            )

            request_sent_at = time.monotonic()
            request_send_task = asyncio.create_task(
                asyncio.to_thread(request_send.send, request)
            )
            while not request_send_task.done():
                if cancellation is not None and cancellation.is_set():
                    raise SolverExecutionCancelled(locator)
                if time.monotonic() >= startup_deadline:
                    raise SolverExecutionStartupTimeout(
                        locator,
                        self.CHILD_STARTUP_TIMEOUT_SECONDS,
                    )
                if not process.is_alive():
                    await _join_process(process, 0)
                    raise SolverProcessExitedError(
                        locator,
                        process.exitcode,
                        child_pid,
                    )
                await asyncio.sleep(self._poll_interval)
            try:
                await request_send_task
            except Exception as exc:
                raise SolverPayloadError(
                    f"could not send invocation to solver {locator}: {exc}"
                ) from exc
            request_send.close()
            log(
                "solver child request sent "
                f"locator={locator} pid={child_pid} request_bytes={request_bytes} "
                f"duration_ms={round((time.monotonic() - request_sent_at) * 1000)}"
            )

            return await self._monitor(
                locator,
                process,
                result_receive,
                progress,
                cancellation,
                timeout,
                codec,
                child_pid,
                startup_deadline,
                request_sent_at,
            )
        except (
            asyncio.CancelledError,
            SolverExecutionStartupTimeout,
            SolverExecutionTimeout,
        ):
            if cleanup_deferred:
                raise
            cancellation_event.set()
            await asyncio.shield(self._stop_process(process, self._cancellation_grace))
            raise
        except BaseException:
            if process_started:
                await self._stop_process(process, 0)
            raise
        finally:
            if not cleanup_deferred:
                if request_send_task is not None and not request_send_task.done():
                    try:
                        await asyncio.wait_for(
                            asyncio.shield(request_send_task),
                            self._exit_grace,
                        )
                    except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
                        pass
                for connection in (
                    request_receive,
                    request_send,
                    result_receive,
                    result_send,
                ):
                    connection.close()
                if process_started:
                    if process.is_alive():
                        process.terminate()
                    await _join_process(process, self._exit_grace)
                    if process.is_alive():
                        process.kill()
                        await _join_process(process, None)
                    child_pid = process.pid
                    exit_code = process.exitcode
                    process.close()
                    log(
                        "solver child cleanup complete "
                        f"locator={locator} pid={child_pid} exit_code={exit_code}"
                    )

    async def _await_bootstrap(
        self,
        locator: str,
        process: BaseProcess,
        connection: Connection,
        cancellation: CancellationSignal | None,
        startup_deadline: float,
        startup_started_at: float,
    ) -> int:
        while True:
            if cancellation is not None and cancellation.is_set():
                raise SolverExecutionCancelled(locator)
            if time.monotonic() >= startup_deadline:
                raise SolverExecutionStartupTimeout(
                    locator,
                    self.CHILD_STARTUP_TIMEOUT_SECONDS,
                )
            try:
                has_message = connection.poll()
            except (EOFError, OSError):
                has_message = False
            if has_message:
                try:
                    message = await asyncio.to_thread(connection.recv)
                except EOFError:
                    message = None
                if not isinstance(message, ChildMessage):
                    raise SolverProtocolError(
                        f"solver {locator} child sent an invalid bootstrap message"
                    )
                if message.kind is not ChildMessageKind.BOOTSTRAPPED or not isinstance(
                    message.payload,
                    int,
                ):
                    raise SolverProtocolError(
                        f"solver {locator} child did not bootstrap before invocation"
                    )
                log(
                    "solver child bootstrapped "
                    f"locator={locator} pid={message.payload} "
                    f"duration_ms={round((time.monotonic() - startup_started_at) * 1000)}"
                )
                return message.payload
            if not process.is_alive():
                await _join_process(process, 0)
                try:
                    message_pending = connection.poll()
                except (BrokenPipeError, EOFError, OSError):
                    message_pending = False
                if message_pending:
                    continue
                raise SolverProcessExitedError(locator, process.exitcode, process.pid)
            await asyncio.sleep(self._poll_interval)

    async def _monitor(
        self,
        locator: str,
        process: BaseProcess,
        connection: Connection,
        progress: ProgressHandler | None,
        cancellation: CancellationSignal | None,
        timeout: float | None,
        codec: PayloadCodec,
        child_pid: int,
        startup_deadline: float,
        request_sent_at: float,
    ) -> Any:
        started_at: float | None = None

        while True:
            if cancellation is not None and cancellation.is_set():
                raise SolverExecutionCancelled(locator)
            now = time.monotonic()
            if started_at is None and now >= startup_deadline:
                raise SolverExecutionStartupTimeout(
                    locator,
                    self.CHILD_STARTUP_TIMEOUT_SECONDS,
                )
            if started_at is not None and timeout is not None and now - started_at >= timeout:
                raise SolverExecutionTimeout(locator, timeout)

            try:
                has_message = connection.poll()
            except (EOFError, OSError):
                has_message = False

            if has_message:
                try:
                    message = await asyncio.to_thread(connection.recv)
                except EOFError:
                    message = None
                if message is not None:
                    if not isinstance(message, ChildMessage):
                        raise SolverProtocolError(
                            f"solver {locator} child sent an invalid message"
                        )
                    if message.kind is ChildMessageKind.BOOTSTRAPPED:
                        raise SolverProtocolError(
                            f"solver {locator} child sent duplicate bootstrap message"
                        )
                    if message.kind is ChildMessageKind.STARTED:
                        if started_at is not None or message.payload != child_pid:
                            raise SolverProtocolError(
                                f"solver {locator} child sent an invalid started message"
                            )
                        started_at = time.monotonic()
                        log(
                            "solver child started "
                            f"locator={locator} pid={child_pid} "
                            f"decode_duration_ms="
                            f"{round((started_at - request_sent_at) * 1000)}"
                        )
                    elif message.kind is ChildMessageKind.PROGRESS:
                        if started_at is None:
                            raise SolverProtocolError(
                                f"solver {locator} child sent progress before starting"
                            )
                        try:
                            value = await asyncio.to_thread(codec.decode, message.payload)
                        except Exception as exc:
                            raise SolverPayloadError(
                                f"could not deserialize progress from solver {locator}: {exc}"
                            ) from exc
                        if progress is not None:
                            callback_result = progress(value)
                            if inspect.isawaitable(callback_result):
                                await callback_result
                    elif message.kind is ChildMessageKind.RESULT:
                        if started_at is None:
                            raise SolverProtocolError(
                                f"solver {locator} child sent a result before starting"
                            )
                        try:
                            result = await asyncio.to_thread(codec.decode, message.payload)
                        except Exception as exc:
                            raise SolverPayloadError(
                                f"could not deserialize result from solver {locator}: {exc}"
                            ) from exc
                        await self._require_clean_exit(locator, process)
                        return result
                    elif message.kind is ChildMessageKind.ERROR:
                        if not isinstance(message.payload, RemoteError):
                            raise SolverProtocolError(
                                f"solver {locator} child sent an invalid error"
                            )
                        await self._require_clean_exit(locator, process)
                        raise RemoteSolverError(locator, message.payload)
                    else:
                        raise SolverProtocolError(
                            f"solver {locator} child sent unknown message kind {message.kind!r}"
                        )

            if not process.is_alive():
                await _join_process(process, 0)
                # Pipe messages can become visible just after the exit-code update.
                try:
                    message_pending = connection.poll()
                except (BrokenPipeError, EOFError, OSError):
                    message_pending = False
                if message_pending:
                    continue
                raise SolverProcessExitedError(locator, process.exitcode, child_pid)

            await asyncio.sleep(self._poll_interval)

    async def _require_clean_exit(self, locator: str, process: BaseProcess) -> None:
        deadline = time.monotonic() + self._exit_grace
        while process.is_alive() and time.monotonic() < deadline:
            await asyncio.sleep(self._poll_interval)
        if process.is_alive():
            process.terminate()
            await _join_process(process, self._exit_grace)
            raise SolverProtocolError(
                f"solver {locator} sent a terminal message but did not exit"
            )
        await _join_process(process, 0)
        if process.exitcode != 0:
            raise SolverProcessExitedError(locator, process.exitcode, process.pid)

    async def _stop_process(self, process: BaseProcess, grace: float) -> None:
        deadline = time.monotonic() + grace
        while process.is_alive() and time.monotonic() < deadline:
            await asyncio.sleep(self._poll_interval)
        if process.is_alive():
            process.terminate()
            await _join_process(process, self._exit_grace)

    def _defer_late_start_cleanup(
        self,
        locator: str,
        start_task: asyncio.Task[None],
        process: BaseProcess,
        connections: tuple[Connection, Connection, Connection, Connection],
    ) -> None:
        async def cleanup() -> None:
            try:
                await asyncio.shield(start_task)
            except BaseException:
                pass
            try:
                if process.pid is not None:
                    await self._stop_process(process, self._cancellation_grace)
                    if process.is_alive():
                        process.kill()
                        await _join_process(process, None)
            finally:
                for connection in connections:
                    connection.close()
                try:
                    child_pid = process.pid
                    exit_code = process.exitcode
                    process.close()
                except (AttributeError, ValueError):
                    child_pid = None
                    exit_code = None
                log(
                    "solver child late-start cleanup complete "
                    f"locator={locator} pid={child_pid} exit_code={exit_code}"
                )

        task = asyncio.create_task(cleanup())
        self._late_cleanup_tasks.add(task)
        task.add_done_callback(self._late_cleanup_tasks.discard)


def _strip_runtime_services(context: Any) -> Any:
    if dataclasses.is_dataclass(context) and not isinstance(context, type):
        field_names = {field.name for field in dataclasses.fields(context)}
        changes = {
            name: None
            for name in ("progress", "cancellation")
            if name in field_names
        }
        return dataclasses.replace(context, **changes) if changes else context

    if isinstance(context, Mapping):
        stripped = dict(context)
        if "progress" in stripped:
            stripped["progress"] = None
        if "cancellation" in stripped:
            stripped["cancellation"] = None
        return stripped

    stripped = copy.copy(context)
    if hasattr(stripped, "progress"):
        setattr(stripped, "progress", None)
    if hasattr(stripped, "cancellation"):
        setattr(stripped, "cancellation", None)
    return stripped


async def _join_process(process: BaseProcess, timeout: float | None) -> None:
    await asyncio.to_thread(process.join, timeout)


def _start_process(process: BaseProcess) -> None:
    """Start a Windows child without sharing the resident control stdin pipe."""

    import sys

    if sys.platform != "win32":
        process.start()
        return

    import _winapi
    import ctypes
    import msvcrt
    import os

    with _WINDOWS_PROCESS_START_LOCK:
        null_fd = os.open(os.devnull, os.O_RDONLY)
        null_handle = msvcrt.get_osfhandle(null_fd)
        previous_handle = _winapi.GetStdHandle(_winapi.STD_INPUT_HANDLE)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.SetStdHandle.argtypes = (ctypes.c_ulong, ctypes.c_void_p)
        kernel32.SetStdHandle.restype = ctypes.c_int
        if not kernel32.SetStdHandle(
            _winapi.STD_INPUT_HANDLE,
            ctypes.c_void_p(null_handle),
        ):
            os.close(null_fd)
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            process.start()
        finally:
            restored = kernel32.SetStdHandle(
                _winapi.STD_INPUT_HANDLE,
                ctypes.c_void_p(previous_handle or 0),
            )
            os.close(null_fd)
            if not restored:
                raise ctypes.WinError(ctypes.get_last_error())


_WINDOWS_PROCESS_START_LOCK = threading.Lock()
