from __future__ import annotations

from collections.abc import Mapping

from app.runtime_kernel.api import SolverInvocation, SolverResult, StatePatch

from .formulation_impl import Ray
from .formulation_impl import run as _run


async def run(invocation: SolverInvocation) -> SolverResult:
    result = await _run(invocation)
    state = result.get("state")
    if not isinstance(state, Mapping) or "rayPaths" not in state:
        raise TypeError("ray solver result must contain state.rayPaths")
    return SolverResult(
        state_patch=StatePatch().put("rayPaths", state["rayPaths"]),
        artifacts=result.get("artifacts", {}),
        observations=result.get("observations", {}),
    )


__all__ = ["Ray", "run"]
