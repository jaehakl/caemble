from __future__ import annotations

from collections.abc import Hashable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

StatePath = tuple[Hashable, ...]


def _state_path(path: Hashable | Sequence[Hashable]) -> StatePath:
    if isinstance(path, (str, bytes)):
        return (path,)
    if isinstance(path, Sequence):
        return tuple(path)
    return (path,)


@dataclass(frozen=True, slots=True)
class StatePut:
    path: StatePath
    value: Any


@dataclass(frozen=True, slots=True)
class StateDelete:
    path: StatePath


StateOperation = StatePut | StateDelete


@dataclass(frozen=True, slots=True)
class StatePatch:
    operations: tuple[StateOperation, ...] = ()

    def put(self, path: Hashable | Sequence[Hashable], value: Any) -> StatePatch:
        return StatePatch((*self.operations, StatePut(_state_path(path), value)))

    def delete(self, path: Hashable | Sequence[Hashable]) -> StatePatch:
        normalized = _state_path(path)
        if not normalized:
            raise ValueError("the state root cannot be deleted")
        return StatePatch((*self.operations, StateDelete(normalized)))

    def replace(self, value: Mapping[Any, Any]) -> StatePatch:
        return StatePatch((*self.operations, StatePut((), value)))

    @property
    def is_empty(self) -> bool:
        return not self.operations
