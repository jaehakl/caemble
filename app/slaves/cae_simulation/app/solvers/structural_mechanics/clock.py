"""Floating-point tolerance for accepted time boundaries."""

import numpy as np


def clock_tolerance(settings):
    """시각 덧셈 오차를 구간/출력 경계에서만 허용하는 작은 범위다.

    duration까지 예상하는 덧셈 횟수로 부동소수점 오차를 추산한다. 동시에
    가장 작은 시간 간격의 백만분의 일보다 작게 제한하여, 아주 작은 dt의
    실제 구간을 고정된 절대 허용오차로 지우지 않는다. 물리 시각과 적분식,
    Newton/연성 허용오차는 이 함수로 변경하지 않는다.
    """
    interval = min(settings["dt"], settings["windowSize"])
    count = np.ceil(abs(settings["duration"]) / interval)
    return min(32 * np.finfo(float).eps * abs(settings["duration"]) * count, 1e-6 * interval)
