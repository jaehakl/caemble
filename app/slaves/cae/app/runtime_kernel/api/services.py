from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Any, Protocol


class GeometryService(Protocol):
    """Canonical geometry operations used by the current solver packages."""

    async def triangular_mesh(
        self,
        scene: Mapping[str, Any],
        root_id: str,
        reference_length_unit: str,
        progress: Callable[[Any], Awaitable[None]] | None = None,
    ) -> Any: ...

    async def shell_layer(
        self,
        scene: Mapping[str, Any],
        root_id: str,
        reference_length_unit: str,
        progress: Callable[[Any], Awaitable[None]] | None = None,
    ) -> Any: ...
