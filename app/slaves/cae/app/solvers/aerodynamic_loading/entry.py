"""ABI 3 연결: 입력 준비 → 순수 공력 계산 → 자기 task 상태와 하중 반환."""

from app.kernel.api import (
    SolverImplementation,
    SolverInvocation,
    SolverResult,
    StatePatch,
)

from .domain import prepare_aerodynamics
from .formulation import aerodynamic_response
from .outputs import build_outputs


async def run(invocation: SolverInvocation) -> SolverResult:
    settings, sections, model, motion, previous = prepare_aerodynamics(invocation)
    loads, state, observations = aerodynamic_response(
        settings, sections, model, motion, previous, invocation.cancellation
    )
    if invocation.progress is not None:
        await invocation.progress(
            {
                "stage": "aerodynamics",
                "completed": len(motion["times"]),
                "total": len(motion["times"]),
            }
        )
    # StatePatch는 중간 경로를 자동 생성하지 않는다. 첫 실행에서만 package를 만든다.
    patch = StatePatch()
    if "aerodynamic_loading" not in invocation.state:
        patch = patch.put(("aerodynamic_loading",), {})
    patch = patch.put(("aerodynamic_loading", invocation.task_name), state)
    return SolverResult(
        state_patch=patch,
        artifacts=build_outputs(invocation.config, loads),
        observations=observations,
    )


implementation = SolverImplementation(abi_version=3, run=run)
