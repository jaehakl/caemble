"""입력·계산·출력만 조합하는 ABI 3 공개 진입점."""

from app.kernel.api import (
    SolverImplementation,
    SolverInvocation,
    SolverResult,
    StatePatch,
)

from .domain import prepare_control
from .formulation import control_response
from .outputs import build_outputs


async def run(invocation: SolverInvocation) -> SolverResult:
    settings, motion, previous = prepare_control(invocation)
    commands, state, observations = control_response(
        settings, motion, previous, invocation.cancellation
    )
    if invocation.progress is not None:
        await invocation.progress(
            {
                "stage": "control",
                "completed": len(motion["times"]),
                "total": len(motion["times"]),
            }
        )
    # StatePatch는 중간 경로를 자동 생성하지 않는다. 첫 실행에서만 package를 만든다.
    patch = StatePatch()
    if "wind_turbine_control" not in invocation.state:
        patch = patch.put(("wind_turbine_control",), {})
    patch = patch.put(("wind_turbine_control", invocation.task_name), state)
    return SolverResult(
        state_patch=patch,
        artifacts=build_outputs(invocation.config, commands),
        observations=observations,
    )


implementation = SolverImplementation(abi_version=3, run=run)
