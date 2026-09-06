from __future__ import annotations

import inspect
from collections.abc import Callable, Mapping
from typing import Any

from app.runtime_kernel.api.cache import ContentKey
from app.runtime_kernel.api.models import SolverInvocation, SolverResult
from app.runtime_kernel.api.state import StatePatch


def adapt_legacy_result(
    result: Mapping[str, Any] | SolverResult,
    input_state: Any,
    *,
    input_state_key: ContentKey | None = None,
) -> SolverResult:
    if isinstance(result, SolverResult):
        return result
    if not isinstance(result, Mapping):
        raise TypeError("legacy solver must return a mapping")

    if "state_patch" in result:
        state_patch = result["state_patch"]
        if not isinstance(state_patch, StatePatch):
            raise TypeError("legacy state_patch must be a StatePatch")
    elif "state" not in result:
        state_patch = StatePatch()
    else:
        state = result["state"]
        if state is None:
            state = {}
        if not isinstance(state, Mapping):
            raise TypeError("legacy solver state must be a mapping")
        unchanged = state is input_state
        if input_state_key is not None:
            unchanged = ContentKey.from_parts("legacy-state", state) == input_state_key
        state_patch = StatePatch() if unchanged else StatePatch().replace(state)

    artifacts = result.get("artifacts", result.get("outputs", {}))
    observations = result.get("observations", {})
    if not isinstance(artifacts, Mapping) or not isinstance(observations, Mapping):
        raise TypeError("legacy solver artifacts and observations must be mappings")
    return SolverResult(state_patch, artifacts, observations)


class LegacySolverAdapter:
    abi_version = 2

    def __init__(
        self,
        runner: Callable[[Any], Any],
        *,
        context_factory: Callable[[SolverInvocation], Any] | None = None,
    ) -> None:
        self._runner = runner
        self._context_factory = context_factory

    async def run(self, invocation: SolverInvocation) -> SolverResult:
        state_key = ContentKey.from_parts("legacy-state", invocation.state)
        context = (
            self._context_factory(invocation)
            if self._context_factory is not None
            else invocation
        )
        result = self._runner(context)
        if inspect.isawaitable(result):
            result = await result
        return adapt_legacy_result(
            result,
            invocation.state,
            input_state_key=state_key,
        )

    async def __call__(self, invocation: SolverInvocation) -> SolverResult:
        return await self.run(invocation)
