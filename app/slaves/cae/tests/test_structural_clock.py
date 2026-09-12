"""장시간 덧셈 오차가 마지막 이력이나 출력 격자를 잃게 해서는 안 된다."""

from dataclasses import replace
from tests.test_box_grid_outputs import grid

import numpy as np
import pytest

from app.kernel.api import SolverInvocation
from app.kernel.catalog import solver_catalog
from app.solvers.structural_mechanics.analysis import initial_solution
from app.solvers.structural_mechanics.coupling import clock_tolerance, predict_motion
from tests.structural_fixture import build_model
from app.solvers.structural_mechanics.entry import run
from app.solvers.structural_mechanics.outputs import configure_history
from app.solvers.structural_mechanics.state import append_history, encode_state


def accumulated_time(duration, dt=.005, window=.05):
    # 해석식이 u=v=a=0인 질량은 어떤 시각에도 같은 물리 상태다. 예열 비용
    # 없이 실제 반복 덧셈의 시각 꼬리만 만들어 마지막 구간의 entry를 검증한다.
    time = 0.
    for _ in range(round(duration / window)):
        target = time + window
        while time < target - 1e-12:
            end = min(time + dt, target)
            time += end - time
    return time


def clock_invocation(duration, time, dt=.005, window=.05):
    settings = {"dt": dt, "windowSize": window, "duration": duration, "outputInterval": .005 if dt >= .0025 else dt,
                "dampingMass": 0., "dampingStiffness": 0., "couplingTolerance": 1e-4, "maxCouplingIterations": 12, "relaxation": .5}
    config = {
        "parameters": {"analysis": "transient", "relativeTolerance": 1e-10, "maxIterations": 10, "geometricNonlinear": False},
        "initializations": [
            {"methodId": "fea.nodes", "parameters": {"nodeIds": [1], "positions": [[0., 0., 0.]]}},
            {"methodId": "fea.mass", "parameters": {"nodeId": 1, "mass": 1., "inertia": np.zeros((3, 3))}},
            {"methodId": "fea.time", "parameters": settings},
        ],
        "boundaryConditions": [],
        "outputs": [{"methodId": "fea.pitch-history", "key": "history", "boxGrid": grid(shape=(1,1,1), origin=(-.5,-.5,-.5)).geometry, "parameters": {"scope": "cumulative"}}],
        "exports": [{"methodId": "fea.motion", "key": "motion", "parameters": {}}],
    }
    invocation = SolverInvocation(config, {}, {}, {}, None, None, solver_catalog.descriptor("structural-mechanics", "5.0.0"), task_name="structure")
    model = build_model(invocation)
    model.boundary_regions["experiment.surface.clock"] = {
        "faces": np.empty((0, 3), dtype=int), "nodes": np.array([0]),
        "weights": np.array([1.]), "area": 1., "rootId": "clock",
        "referencePoint": np.zeros(3),
    }
    model.result_requests["history"] = {"regions": ["experiment.surface.clock"]}
    configure_history(model, config["outputs"])
    solution = initial_solution(model)
    append_history(model, solution)
    solution.time = time
    if time > 0:
        append_history(model, solution)
    saved = encode_state(model, solution)
    return replace(invocation, state={"structural_mechanics": {"structure": saved}}), model, solution, settings


@pytest.mark.parametrize("duration", [.1, 8., 300.])
@pytest.mark.asyncio
async def test_final_history_is_nonempty_and_no_tiny_next_window_is_predicted(duration, monkeypatch):
    start = accumulated_time(duration - .05)
    invocation, model, _, settings = clock_invocation(duration, start)
    async def prepared_model(_invocation):
        return model
    monkeypatch.setattr("app.solvers.structural_mechanics.entry.build_geometry_model", prepared_model)
    result = await run(invocation)
    actual_time = result.observations["time"]
    assert abs(actual_time - duration) <= clock_tolerance(settings)
    # 결과에 계산된 실제 시각을 보존한다. 단지 종료 여부만 올바르게 판정한다.
    np.testing.assert_array_equal(result.exports["motion"].members["times"], [actual_time])
    history_times = result.artifacts["history"]["axes"][3]["ticks"]
    assert len(history_times) >= 2 and history_times[-1] == actual_time
    saved = result.state_patch.operations[-1].value
    assert saved["time"] == actual_time
    assert invocation.state["structural_mechanics"]["structure"]["time"] == start
    with pytest.raises(ValueError, match="already reached its configured duration"):
        await run(replace(invocation, state={"structural_mechanics": {"structure": saved}}))


@pytest.mark.asyncio
async def test_refined_dt_after_long_negative_tail_keeps_the_original_output_grid(monkeypatch):
    start = accumulated_time(240.)
    invocation, model, _, settings = clock_invocation(240.05, start, dt=.0025)
    async def prepared_model(_invocation):
        return model
    monkeypatch.setattr("app.solvers.structural_mechanics.entry.build_geometry_model", prepared_model)
    result = await run(invocation)
    times = np.asarray(result.artifacts["history"]["axes"][3]["ticks"])[2:]
    # dt=.0025 표본 중 outputInterval=.005에 해당하는 표본만 골라야 한다.
    # 음의 시각 꼬리를 floor가 이전 출력 칸으로 분류하면 .0025 위상으로 밀린다.
    expected = 240. + np.arange(1, 11) * .005
    assert len(times) == len(expected)
    np.testing.assert_allclose(times, expected, atol=clock_tolerance(settings), rtol=0.)
    assert np.max(abs(times - (expected - .0025))) > .0024
    assert times[-1] == result.observations["time"]


def test_clock_allowance_cannot_hide_a_real_very_small_time_interval():
    duration, dt = 1e-12, 1e-15
    _, model, solution, settings = clock_invocation(duration, duration - dt, dt, 2 * dt)
    allowance = clock_tolerance(settings)
    assert 0 < allowance <= 1e-6 * dt
    before = solution.time
    times = predict_motion(model, solution, settings).members["times"]
    assert len(times) >= 2 and np.all(np.diff(times) > 0)
    assert times[0] == before and solution.time == before
    # 반대로 한 ulp만 남았을 때는 실제 시각을 그대로 담은 한 점만 반환한다.
    solution.time = np.nextafter(duration, 0.)
    np.testing.assert_array_equal(predict_motion(model, solution, settings).members["times"], [solution.time])


@pytest.mark.parametrize("duration,dt", [(8., .005), (300., .005), (1e-12, 1e-15)])
def test_clock_allowance_is_negligible_compared_with_a_physical_step(duration, dt):
    settings = {"duration": duration, "dt": dt, "windowSize": 10 * dt}
    assert clock_tolerance(settings) <= dt * 1e-6
