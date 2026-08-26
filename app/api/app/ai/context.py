from __future__ import annotations

import json
from dataclasses import dataclass
from enum import IntEnum
from typing import Any


class ContextPriority(IntEnum):
    P0 = 0
    P1 = 1
    P2 = 2
    P3 = 3


@dataclass(frozen=True)
class ContextItem:
    key: str
    priority: ContextPriority
    role: str
    content: str
    newest_first: int = 0

@dataclass(frozen=True)
class AssembledContext:
    input_items: list[dict[str, Any]]
    estimated_tokens: int
    included_keys: tuple[str, ...]
    omitted_keys: tuple[str, ...]


class ContextAssembler:
    def assemble(self, items: list[ContextItem]) -> AssembledContext:
        ordered = sorted(items, key=lambda item: (item.priority, -item.newest_first))
        return AssembledContext(
            input_items=[
                {"type": "message", "role": item.role, "content": item.content}
                for item in sorted(ordered, key=lambda item: (item.priority, item.newest_first))
            ],
            estimated_tokens=0,
            included_keys=tuple(item.key for item in ordered),
            omitted_keys=(),
        )


def json_context_item(
    key: str,
    priority: ContextPriority,
    role: str,
    value: Any,
    *,
    newest_first: int = 0,
) -> ContextItem:
    return ContextItem(
        key=key,
        priority=priority,
        role=role,
        content=json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str),
        newest_first=newest_first,
    )
