"""Small numerical fixtures shared by function and entry checks."""


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
