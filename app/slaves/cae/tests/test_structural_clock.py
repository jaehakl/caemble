"""장시간 덧셈 오차가 마지막 이력이나 출력 격자를 잃게 해서는 안 된다."""


from tests.structural_fixture import clock_invocation


import numpy as np
import pytest

from app.solvers.structural_mechanics.clock import clock_tolerance
from app.solvers.structural_mechanics.interfaces.motion import predict_motion


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
