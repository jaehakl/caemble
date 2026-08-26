from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from enum import StrEnum
from typing import Any


class FieldLocation(StrEnum):
    NODE = "node"
    EDGE = "edge"
    FACE = "face"
    CELL = "cell"
    PARTICLE = "particle"
    RAY = "ray"


@dataclass(frozen=True, slots=True)
class Field:
    name: str
    values: Any
    location: FieldLocation = FieldLocation.CELL
    domain: Any = None
    quantity_kind: str | None = None
    unit: str | None = None
    components: tuple[str, ...] = ()
    basis: Any = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    @property
    def domain_ref(self) -> Any:
        return self.domain

    def with_values(self, values: Any) -> Field:
        return replace(self, values=values)
