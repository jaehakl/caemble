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

    @property
    def estimated_tokens(self) -> int:
        # Providers do not expose a preflight tokenizer in v1. One token per
        # UTF-8 byte is a conservative upper bound for the hard-cap decision.
        return max(1, len(self.content.encode("utf-8"))) + 8


@dataclass(frozen=True)
class AssembledContext:
    input_items: list[dict[str, Any]]
    estimated_tokens: int
    included_keys: tuple[str, ...]
    omitted_keys: tuple[str, ...]


class ContextBudgetExceeded(ValueError):
    pass


class ContextAssembler:
    def __init__(self, token_budget: int = 128_000, hard_token_cap: int = 220_000):
        if token_budget < 1 or hard_token_cap < token_budget:
            raise ValueError("Context token budgets are invalid")
        self.token_budget = token_budget
        self.hard_token_cap = hard_token_cap

    def assemble(self, items: list[ContextItem]) -> AssembledContext:
        selected: list[ContextItem] = []
        omitted: list[str] = []
        used = 0
        ordered = sorted(items, key=lambda item: (item.priority, -item.newest_first))
        for item in ordered:
            item_tokens = item.estimated_tokens
            required = item.priority in {ContextPriority.P0, ContextPriority.P1}
            if required and used + item_tokens > self.hard_token_cap:
                raise ContextBudgetExceeded(f"Required context {item.key!r} exceeds the hard token cap")
            if not required and used + item_tokens > self.token_budget:
                omitted.append(item.key)
                continue
            selected.append(item)
            used += item_tokens

        return AssembledContext(
            input_items=[
                {"type": "message", "role": item.role, "content": item.content}
                for item in sorted(selected, key=lambda item: (item.priority, item.newest_first))
            ],
            estimated_tokens=used,
            included_keys=tuple(item.key for item in selected),
            omitted_keys=tuple(omitted),
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
