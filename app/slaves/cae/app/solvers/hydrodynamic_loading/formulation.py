"""Airy 파랑 → 물 입자 운동 → Morison 힘과 부가질량을 계산한다.

이 모델은 수면 z=0과 해저 z=-depth 사이의 고정 기준 부재를 사용한다.
파랑에 따라 젖는 길이, diffraction, slamming, radiation은 여기 포함되지 않는다.
움직이는 부재의 속도는 항력에 반영하며, 부가질량은 구조 solver가 질량행렬에
한 번 조립하도록 따로 반환한다. 외력에 -M_added*a_body를 중복해서 넣지 않는다.
"""

import math

import numpy as np
from scipy.optimize import brentq


def wave_numbers(periods, depth, gravity):
    """분산식 omega² = g*k*tanh(k*depth)를 풀어 유한 수심 파수를 얻는다."""
    if depth <= 0 or gravity <= 0 or np.any(np.asarray(periods) <= 0):
        raise ValueError("wave depth, gravity and periods must be positive")
    result = []
    for period in periods:
        omega = 2 * math.pi / float(period)
        upper = max(omega * omega / gravity, omega / math.sqrt(gravity * depth)) * 2
        while gravity * upper * math.tanh(upper * depth) < omega * omega:
            upper *= 2
        result.append(
            brentq(
                lambda k, omega=omega: gravity * k * math.tanh(k * depth) - omega * omega,
                0,
                upper,
                xtol=1e-14,
            )
        )
    return np.asarray(result)


def airy_kinematics(
    position,
    time,
    amplitudes,
    periods,
    directions,
    phases,
    depth,
    gravity=9.81,
    numbers=None,
):
    """선형 파랑 성분을 합쳐 (velocity[m/s], acceleration[m/s²])를 구한다.

    위상은 k*(x*cos heading+y*sin heading)-omega*t+phase 이다. 수평 운동과
    수직 운동은 90도 위상차가 있다. exp 비율을 사용해 깊은 물의 cosh overflow를
    피한다. amplitudes는 파고가 아니라 수면 진폭(파고/2)이다.
    """
    if numbers is None:
        numbers = wave_numbers(periods, depth, gravity)
    velocity, acceleration = np.zeros(3), np.zeros(3)
    z = float(position[2])
    if z < -depth - 1e-9 or z > 1e-9:
        raise ValueError(
            "Airy kinematics are defined between seabed and mean water level"
        )
    for amplitude, period, heading, phase, k in zip(
        amplitudes, periods, directions, phases, numbers, strict=True
    ):
        omega = 2 * math.pi / float(period)
        direction = np.array([math.cos(heading), math.sin(heading), 0.0])
        theta = k * float(np.asarray(position) @ direction) - omega * time + phase
        denominator = -math.expm1(-2 * k * depth)
        upper, lower = math.exp(k * z), math.exp(-k * (z + 2 * depth))
        horizontal, vertical = (
            (upper + lower) / denominator,
            (upper - lower) / denominator,
        )
        velocity += amplitude * omega * horizontal * math.cos(theta) * direction
        velocity[2] += amplitude * omega * vertical * math.sin(theta)
        acceleration += (
            amplitude * omega * omega * horizontal * math.sin(theta) * direction
        )
        acceleration[2] -= amplitude * omega * omega * vertical * math.cos(theta)
    return velocity, acceleration


def hydrodynamic_response(
    settings, members, model, motion, previous=None, cancellation=None
):
    """분포 힘을 보의 두 절점에 shape-function 적분으로 전달한다.

    질량도 같은 적분점에서 N_i*mass_per_length를 누적해 양의 lumped 질량을 얻는다.
    이것은 회전 부가관성을 포함하는 일반적인 6×6 행렬이 아닌 병진 3×3 tensor다.
    기준 중심선은 변하지 않으므로 반환 질량은 전체 시간 구간에서 일정하다.
    """
    previous = previous or {}
    times = np.asarray(motion["times"], dtype=float)
    if len(times) == 0 or np.any(np.diff(times) <= 0):
        raise ValueError("hydrodynamic sample times must increase")
    if previous and (
        previous["modelIdentity"] != model["modelIdentity"]
        or not np.isclose(previous["time"], times[0], rtol=0, atol=1e-10)
    ):
        raise ValueError("hydrodynamic checkpoint must start this model's time window")
    points = np.asarray(model["referencePositions"], dtype=float)
    forces = np.zeros((len(times), len(points), 3))
    added_mass = np.zeros((len(points), 3, 3))
    depth, gravity, density = (
        float(settings["waterDepth"]),
        float(settings["gravity"]),
        float(settings["waterDensity"]),
    )
    current = np.asarray(settings["currentVelocity"], dtype=float)
    if density <= 0:
        raise ValueError("water density must be positive")
    numbers = wave_numbers(settings["wavePeriods"], depth, gravity)
    gauss_points, gauss_weights = np.polynomial.legendre.leggauss(3)
    for member, nodes in enumerate(members["indices"]):
        if cancellation is not None:
            cancellation.raise_if_cancelled()
        start, end = points[nodes]
        difference = end - start
        length = float(np.linalg.norm(difference))
        diameter = float(members["diameters"][member])
        ca, cp, cd = (
            float(members[key][member])
            for key in (
                "addedMassCoefficients",
                "pressureCoefficients",
                "dragCoefficients",
            )
        )
        if length <= 0 or diameter <= 0 or min(ca, cp, cd) < 0:
            raise ValueError(
                "Morison members need positive length/diameter and nonnegative coefficients"
            )
        tangent = difference / length
        normal_projector = np.eye(3) - np.outer(tangent, tangent)
        area = math.pi * diameter * diameter / 4
        # s∈[0,1] 중 실제로 기준 수면과 해저 사이에 있는 부분만 적분한다.
        if abs(difference[2]) <= 1e-14:
            if not -depth <= start[2] <= 0:
                continue
            lower, upper = 0.0, 1.0
        else:
            water_intersections = sorted(
                ((-depth - start[2]) / difference[2], -start[2] / difference[2])
            )
            lower, upper = (
                max(0.0, water_intersections[0]),
                min(1.0, water_intersections[1]),
            )
            if upper <= lower:
                continue
        for point, weight in zip(gauss_points, gauss_weights, strict=True):
            s = lower + (point + 1) * (upper - lower) / 2
            shape = np.array([1 - s, s])
            integration_length = weight * length * (upper - lower) / 2
            position = start + s * difference
            for local, node in enumerate(nodes):
                added_mass[node] += (
                    shape[local]
                    * integration_length
                    * density
                    * ca
                    * area
                    * normal_projector
                )
            for sample, time in enumerate(times):
                if cancellation is not None:
                    cancellation.raise_if_cancelled()
                velocity, acceleration = airy_kinematics(
                    position,
                    time,
                    settings["waveAmplitudes"],
                    settings["wavePeriods"],
                    settings["waveDirections"],
                    settings["wavePhases"],
                    depth,
                    gravity,
                    numbers,
                )
                body_velocity = shape @ np.asarray(motion["velocities"])[sample, nodes]
                relative = normal_projector @ (velocity + current - body_velocity)
                drag = (
                    0.5 * density * cd * diameter * np.linalg.norm(relative) * relative
                )
                inertia = density * (cp + ca) * area * (normal_projector @ acceleration)
                buoyancy = np.array(
                    [
                        0.0,
                        0.0,
                        density * gravity * float(members["buoyancyAreas"][member]),
                    ]
                )
                line_force = drag + inertia + buoyancy
                for local, node in enumerate(nodes):
                    forces[sample, node] += (
                        shape[local] * integration_length * line_force
                    )
    loads = {
        "modelIdentity": model["modelIdentity"],
        "nodeIds": np.asarray(model["nodeIds"], dtype=np.int32),
        "times": times,
        "forces": forces,
        "moments": np.zeros_like(forces),
        "addedMass": added_mass,
        "couplingIteration": np.asarray(
            motion.get("couplingIteration", 0), dtype=np.int32
        ),
    }
    state = {"modelIdentity": model["modelIdentity"], "time": float(times[-1])}
    return (
        loads,
        state,
        {
            "maximumForce": float(np.max(np.linalg.norm(forces, axis=2))),
            "time": float(times[-1]),
        },
    )
