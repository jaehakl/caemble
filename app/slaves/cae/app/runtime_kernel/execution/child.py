from __future__ import annotations

import asyncio
import copy
import dataclasses
import importlib
import inspect
import os
import tempfile
import traceback
from collections.abc import Mapping
from multiprocessing.connection import Connection
from typing import Any

from app.runtime_kernel.execution.messages import (
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
        from app.runtime_kernel.api import SolverResourceServices
        from app.runtime_kernel.resources import FileResourceCache

        resources = getattr(context, "resources", None)
        if not isinstance(resources, SolverResourceServices):
            resources = SolverResourceServices()
        cache = (
            FileResourceCache(resources.geometry_cache_path)
            if resources.geometry_cache_path is not None
            else None
        )
        with tempfile.TemporaryDirectory(prefix="caemble-cae-solver-workspace-") as workspace:
            resources = dataclasses.replace(resources, workspace_path=workspace)
            context = _bind_runtime_services(
                context,
                progress,
                ProcessCancellationToken(cancellation_event),
                GeometryService(cache=cache),
                resources,
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


async def _invoke(locator: str, context: Any, expected_abi_version: int | None) -> Any:
    module_name, separator, attribute = locator.partition(":")
    if not separator or not module_name or not attribute:
        raise ValueError(
            f"invalid solver locator {locator!r}; expected 'module.path:attribute'"
        )

    target = getattr(importlib.import_module(module_name), attribute)
    abi_version = getattr(target, "abi_version", None)
    if expected_abi_version not in {None, 1, 2}:
        raise TypeError(f"unsupported Catalog solver ABI version {expected_abi_version!r}")
    if expected_abi_version == 2 and abi_version != 2:
        raise TypeError(f"Catalog declares ABI 2 but solver {locator} does not implement it")
    if expected_abi_version == 1 and abi_version is not None:
        raise TypeError(
            f"Catalog declares legacy ABI 1 but solver {locator} advertises ABI {abi_version!r}"
        )
    if abi_version == 2:
        runner = getattr(target, "run", None)
        if runner is None and callable(target):
            runner = target
        if not callable(runner):
            raise TypeError(f"ABI-v2 solver {locator} has no callable run member")
    elif abi_version is not None and not callable(target):
        raise TypeError(f"unsupported solver ABI version {abi_version!r} for {locator}")
    elif callable(target):
        from app.runtime_kernel.api import LegacySolverAdapter, SolverInvocation
        from app.solver_framework.models import SolverContext

        if isinstance(context, SolverInvocation):
            def legacy_context(invocation: SolverInvocation) -> SolverContext:
                return SolverContext(
                    dict(invocation.config),
                    invocation.state,
                    _legacy_inputs(invocation.inputs),
                    dict(invocation.world),
                    invocation.geometry,
                    invocation.progress,
                    dict(invocation.descriptor),
                )

            runner = LegacySolverAdapter(target, context_factory=legacy_context).run
        else:
            runner = target
    else:
        raise TypeError(f"legacy solver entry {locator} is not callable")

    result = runner(context)
    return await result if inspect.isawaitable(result) else result


def _bind_runtime_services(
    context: Any,
    progress: Any,
    cancellation: Any,
    geometry: Any,
    resources: Any,
) -> Any:
    if dataclasses.is_dataclass(context) and not isinstance(context, type):
        field_names = {field.name for field in dataclasses.fields(context)}
        changes: dict[str, Any] = {}
        if "progress" in field_names:
            changes["progress"] = progress
        if "cancellation" in field_names:
            changes["cancellation"] = cancellation
        if "geometry" in field_names and getattr(context, "geometry", None) is None:
            changes["geometry"] = geometry
        if "resources" in field_names:
            changes["resources"] = resources
        return dataclasses.replace(context, **changes) if changes else context

    if isinstance(context, Mapping):
        bound = dict(context)
        bound["progress"] = progress
        bound["cancellation"] = cancellation
        if bound.get("geometry") is None:
            bound["geometry"] = geometry
        bound["resources"] = resources
        return bound

    bound = copy.copy(context)
    if hasattr(bound, "progress"):
        setattr(bound, "progress", progress)
    if hasattr(bound, "cancellation"):
        setattr(bound, "cancellation", cancellation)
    if hasattr(bound, "geometry") and getattr(bound, "geometry") is None:
        setattr(bound, "geometry", geometry)
    if hasattr(bound, "resources"):
        setattr(bound, "resources", resources)
    return bound


def _legacy_inputs(inputs: Mapping[str, Any]) -> dict[str, Any]:
    from app.runtime_kernel.api import InputArtifact

    def unwrap(value: Any) -> Any:
        if isinstance(value, InputArtifact):
            return value.value
        if isinstance(value, tuple):
            return [unwrap(item) for item in value]
        return value

    return {name: unwrap(value) for name, value in inputs.items()}
