from __future__ import annotations

from collections.abc import AsyncGenerator, Awaitable, Callable, Iterable, Mapping, Sequence
from typing import Any, Protocol


class ExecutionService(Protocol):
    """Child-bound computation services; batch results live until the next yield."""

    def configure_torch(self) -> None: ...

    def batch_workers(self, requested: int, private_bytes: int) -> int: ...

    def map_batches(self, initializer: str, function: str, prepared: Any,
                    batches: Iterable[Any], workers: int) -> AsyncGenerator[Any, None]: ...


class GeometryService(Protocol):
    """Canonical geometry operations used by the current solver packages."""

    async def continuous_solid(
        self,
        scene: Mapping[str, Any],
        root_id: str,
        reference_length_unit: str,
        progress: Callable[[Any], Awaitable[None]] | None = None,
    ) -> Any: ...

    async def triangular_mesh(
        self,
        scene: Mapping[str, Any],
        root_id: str,
        reference_length_unit: str,
        progress: Callable[[Any], Awaitable[None]] | None = None,
    ) -> Any: ...

    async def volume_mesh(
        self,
        scene: Mapping[str, Any],
        root_ids: Sequence[str],
        reference_length_unit: str,
        profile: Any,
        progress: Callable[[Any], Awaitable[None]] | None = None,
    ) -> Any: ...

    async def solid_components(
        self,
        scene: Mapping[str, Any],
        root_id: str,
        reference_length_unit: str,
        profile: Any = ...,
        progress: Callable[[Any], Awaitable[None]] | None = None,
    ) -> Any: ...
