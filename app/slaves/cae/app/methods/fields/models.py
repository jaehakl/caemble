from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from typing import Any

from app.runtime_kernel.api.values import FieldLocation


@dataclass(frozen=True, slots=True)
class WorkingField:
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

    def with_values(self, values: Any) -> WorkingField:
        return replace(self, values=values)


Field = WorkingField
