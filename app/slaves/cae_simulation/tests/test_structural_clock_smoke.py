"""Explicit product entry checks, excluded from low-cost collection."""
from tests.structural_fixture import clock_invocation
from dataclasses import replace
import numpy as np
import pytest
from app.solvers.structural_mechanics.clock import clock_tolerance
from app.solvers.structural_mechanics.entry import run
from tests.structural_clock_fixtures import accumulated_time


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
