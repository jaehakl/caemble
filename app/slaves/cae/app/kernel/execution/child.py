from __future__ import annotations

import asyncio
import dataclasses
import importlib
import os
import tempfile
import traceback
from multiprocessing.connection import Connection
from typing import Any

from app.kernel.api import SolverImplementation, SolverInvocation, SolverResult
from app.kernel.execution.messages import (
    ChildMessage,
    ChildMessageKind,
    RemoteError,
    SolverChildRequest,
)


class ProcessCancellationToken:
    """Cooperative cancellation view backed by the parent's process event."""

    def __init__(self, event: Any) -> None:
        self._event = event

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def is_set(self) -> bool:
        return self._event.is_set()

    def raise_if_cancelled(self) -> None:
        if self._event.is_set():
            raise asyncio.CancelledError("solver invocation was cancelled")


def child_main(
    request_connection: Connection,
    result_connection: Connection,
    cancellation_event: Any,
) -> None:
    """Spawn target. Solver import and invocation happen only in this process."""

    try:
        result_connection.send(
            ChildMessage(ChildMessageKind.BOOTSTRAPPED, os.getpid())
        )
        request = request_connection.recv()
        if not isinstance(request, SolverChildRequest):
            raise TypeError("parent sent an invalid solver child request")
        context = request.codec.decode(request.encoded_context)
        result_connection.send(ChildMessage(ChildMessageKind.STARTED, os.getpid()))

        async def progress(value: Any) -> None:
            result_connection.send(
                ChildMessage(
                    ChildMessageKind.PROGRESS,
                    request.codec.encode(value),
                )
            )

        from app.methods.geometry import GeometryService
        from app.kernel.resources import FileResourceCache

        if not isinstance(context, SolverInvocation):
            raise TypeError("solver input must be a SolverInvocation")
        resources = context.resources
        cache = (
            FileResourceCache(resources.geometry_cache_path)
            if resources.geometry_cache_path is not None
            else None
        )
        with tempfile.TemporaryDirectory(prefix="caemble-cae-solver-workspace-") as workspace:
            resources = dataclasses.replace(resources, workspace_path=workspace)
            context = dataclasses.replace(
                context,
                progress=progress,
                cancellation=ProcessCancellationToken(cancellation_event),
                geometry=GeometryService(cache=cache),
                resources=resources,
            )
            result = asyncio.run(
                _invoke(
                    request.locator,
                    context,
                    request.expected_abi_version,
                )
            )
        result_connection.send(
            ChildMessage(ChildMessageKind.RESULT, request.codec.encode(result))
        )
    except BaseException as exc:
        remote = RemoteError(
            type(exc).__module__,
            type(exc).__qualname__,
            str(exc),
            "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
        )
        try:
            result_connection.send(ChildMessage(ChildMessageKind.ERROR, remote))
        except (BrokenPipeError, EOFError, OSError):
            pass
    finally:
        request_connection.close()
        result_connection.close()


async def _invoke(
    locator: str, invocation: SolverInvocation, expected_abi_version: int,
) -> SolverResult:
    if expected_abi_version != 3:
        raise TypeError(f"unsupported Catalog solver ABI version {expected_abi_version!r}; expected 3")
    module_name, separator, attribute = locator.partition(":")
    if not separator or not module_name or not attribute:
        raise ValueError(f"invalid solver locator {locator!r}; expected 'module.path:attribute'")
    implementation = getattr(importlib.import_module(module_name), attribute)
    if not isinstance(implementation, SolverImplementation):
        raise TypeError(f"solver {locator} must export an ABI 3 SolverImplementation")
    if implementation.abi_version != expected_abi_version:
        raise TypeError(f"solver {locator} implementation ABI does not match Catalog ABI {expected_abi_version}")
    result = await implementation.run(invocation)
    if not isinstance(result, SolverResult):
        raise TypeError(f"solver {locator} must return SolverResult")
    return result
