from typing import Any

from app.kernel.api import SolverInvocation


def invocation(config: dict[str, Any] | None = None) -> SolverInvocation:
    """Build a minimal ABI 2 invocation for process and transport tests."""
    return SolverInvocation(
        config=config or {}, state={}, inputs={}, world={},
        geometry=None, progress=None, descriptor={},
    )
