"""제어 계수와 구조 solver의 실제 발전기 속도 파형을 준비한다."""

from collections.abc import Mapping

from app.kernel.api import BundleValue, SolverInvocation


def prepare_control(invocation: SolverInvocation):
    settings = {
        key: value["value"]
        if isinstance(value, Mapping) and "value" in value
        else value
        for key, value in invocation.config["parameters"].items()
    }
    motion = invocation.inputs["motion"].value
    if not isinstance(motion, BundleValue):
        raise TypeError("wind turbine control requires a mechanics motion bundle")
    previous = invocation.state.get("wind_turbine_control", {}).get(
        invocation.task_name, {}
    )
    return settings, motion.members, previous
