"""NREL baseline 제어의 알고리즘을 명시적인 계수로 계산한다.

흐름은 속도 low-pass → region별 토크 → 토크 변화율 제한 → gain-scheduled
PI pitch → 적분/피치/피치속도 제한이다. 물리적인 축의 운동은 구조 solver가
계산한다. 여기서는 rotor inertia를 더하거나 rotor speed를 다시 적분하지 않는다.
참고: NREL/TP-500-38060, baseline DISCON (OpenFAST r-test, Apache-2.0).
계수 자체는 Catalog/Experiment 입력이며 이 모듈에 turbine별 상수를 숨기지 않는다.
"""

import math

import numpy as np


def generator_torque(speed, pitch, settings):
    """발전기 고속축 속도[rad/s]에서 목표 토크[N·m]를 구한다.

    Region 1은 기동, 1.5는 진입 ramp, 2는 최적 tip-speed ratio의 K*omega²,
    2.5는 정격 연결, 3은 일정한 기계적 출력 P/omega 영역이다.
    """
    cut_in, region2, region3 = (
        float(settings[key])
        for key in (
            "cutInGeneratorSpeed",
            "region2GeneratorSpeed",
            "region3GeneratorSpeed",
        )
    )
    gain, power = (
        float(settings["region2TorqueConstant"]),
        float(settings["ratedMechanicalPower"]),
    )
    slip = float(settings["slipFraction"])
    if not 0 <= cut_in < region2 < region3 or gain <= 0 or power <= 0 or slip <= 0:
        raise ValueError(
            "generator torque region speeds, gain, power and slip are invalid"
        )
    synchronous = region3 / (1 + slip)
    slope25 = (power / region3) / (region3 - synchronous)
    discriminant = slope25 * slope25 - 4 * gain * slope25 * synchronous
    if not 0 <= cut_in < region2 < region3 or gain <= 0 or discriminant < 0:
        raise ValueError(
            "generator torque regions do not form a valid baseline characteristic"
        )
    # 작은 두 근 중 하나를 선택한다. 아래 형태는 큰 값의 뺄셈 손실을 피한다.
    transition = 2 * slope25 * synchronous / (slope25 + math.sqrt(discriminant))
    if transition < region2:
        raise ValueError("region 2.5 transition must not be below the region 2 start")
    if speed > 0 and (
        speed >= region3 or pitch >= float(settings["region3PitchThreshold"])
    ):
        torque = power / speed
    elif speed <= cut_in:
        torque = 0.0
    elif speed < region2:
        torque = gain * region2 * region2 * (speed - cut_in) / (region2 - cut_in)
    elif speed < transition:
        torque = gain * speed * speed
    else:
        torque = slope25 * (speed - synchronous)
    return float(np.clip(torque, 0, float(settings["maximumTorque"])))


def control_response(settings, motion, previous=None, cancellation=None):
    """실제 시간 좌표에서 제어 파형과 재시작 상태를 만든다.

    동일한 checkpoint를 여러 번 평가해도 입력 mapping은 바뀌지 않는다. 구간의
    첫 표본은 이미 채택된 시각이므로 적분하지 않고 현재 명령을 그대로 출력한다.
    나머지 표본 간격이 제어기의 sample interval이며 구조 적분 간격과 분리 가능하다.
    """
    previous = previous or {}
    times = np.asarray(motion["times"], dtype=float)
    speeds = np.asarray(motion["generatorSpeed"], dtype=float)
    if times.shape != speeds.shape or len(times) == 0 or np.any(np.diff(times) <= 0):
        raise ValueError(
            "control requires increasing time samples and matching generator speeds"
        )
    if np.any(speeds < 0):
        raise ValueError("baseline control supports nonnegative generator speeds")
    identity = motion["modelIdentity"]
    if previous and (
        previous["modelIdentity"] != identity
        or not np.isclose(previous["time"], times[0], rtol=0, atol=1e-10)
    ):
        raise ValueError("controller checkpoint must start this model's time window")
    minimum, maximum = float(settings["minimumPitch"]), float(settings["maximumPitch"])
    kp, ki, kk = (float(settings[key]) for key in ("pitchKp", "pitchKi", "pitchKk"))
    frequency = float(settings["speedFilterFrequency"])
    pitch_rate, torque_rate = (
        float(settings["maximumPitchRate"]),
        float(settings["maximumTorqueRate"]),
    )
    if (
        frequency <= 0
        or kk <= 0
        or ki <= 0
        or kp < 0
        or pitch_rate <= 0
        or torque_rate <= 0
        or maximum <= minimum
    ):
        raise ValueError("controller gains, rates and pitch bounds are invalid")
    filtered = float(previous.get("filteredGeneratorSpeed", speeds[0]))
    pitch = float(previous.get("pitch", settings["initialPitch"]))
    torque = float(previous.get("generatorTorque", settings["initialGeneratorTorque"]))
    initial_gain = 1 / (1 + pitch / kk)
    integral = float(previous.get("integralSpeedError", pitch / (initial_gain * ki)))
    pitch_history, torque_history = np.empty(len(times)), np.empty(len(times))
    for sample, time in enumerate(times):
        if cancellation is not None:
            cancellation.raise_if_cancelled()
        if sample:
            dt = float(time - times[sample - 1])
            decay = math.exp(-frequency * dt)
            filtered = decay * filtered + (1 - decay) * speeds[sample]
            target_torque = generator_torque(filtered, pitch, settings)
            torque += float(
                np.clip(target_torque - torque, -torque_rate * dt, torque_rate * dt)
            )
            torque = float(np.clip(torque, 0, float(settings["maximumTorque"])))
            gain = 1 / (1 + pitch / kk)
            error = filtered - float(settings["ratedGeneratorSpeed"])
            # 적분기에도 한계를 주어 포화 상태에서 오차가 끝없이 쌓이지 않게 한다.
            integral = float(
                np.clip(
                    integral + error * dt, minimum / (gain * ki), maximum / (gain * ki)
                )
            )
            command = float(
                np.clip(gain * (kp * error + ki * integral), minimum, maximum)
            )
            pitch += float(np.clip(command - pitch, -pitch_rate * dt, pitch_rate * dt))
            pitch = float(np.clip(pitch, minimum, maximum))
        pitch_history[sample], torque_history[sample] = pitch, torque
    state = {
        "modelIdentity": identity,
        "time": float(times[-1]),
        "filteredGeneratorSpeed": filtered,
        "integralSpeedError": integral,
        "pitch": pitch,
        "generatorTorque": torque,
    }
    commands = {
        "modelIdentity": identity,
        "times": times,
        "generatorTorque": torque_history,
        "pitch": pitch_history,
        "couplingIteration": np.asarray(
            motion.get("couplingIteration", 0), dtype=np.int32
        ),
    }
    return (
        commands,
        state,
        {"generatorTorque": torque, "pitch": pitch, "time": float(times[-1])},
    )
