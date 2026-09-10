"""ABI 3 진입점. Hydro는 구조 solver의 내부 모델이나 상태를 읽지 않는다."""

from app.kernel.api import (
    SolverImplementation,
    SolverInvocation,
    SolverResult,
    StatePatch,
)

from .domain import prepare_hydrodynamics
from .formulation import hydrodynamic_response
from .outputs import build_outputs


async def run(invocation: SolverInvocation) -> SolverResult:
    settings, members, model, motion, previous = prepare_hydrodynamics(invocation)
    loads, state, observations = hydrodynamic_response(
        settings, members, model, motion, previous, invocation.cancellation
    )
    if invocation.progress is not None:
        await invocation.progress(
            {
                "stage": "hydrodynamics",
                "completed": len(motion["times"]),
                "total": len(motion["times"]),
            }
        )
    # StatePatch는 중간 경로를 자동 생성하지 않는다. 첫 실행에서만 package를 만든다.
    patch = StatePatch()
    if "hydrodynamic_loading" not in invocation.state:
        patch = patch.put(("hydrodynamic_loading",), {})
    patch = patch.put(("hydrodynamic_loading", invocation.task_name), state)
    return SolverResult(
        state_patch=patch,
        artifacts=build_outputs(invocation.config, loads),
        observations=observations,
    )


implementation = SolverImplementation(abi_version=3, run=run)
